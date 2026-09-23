# Payments

Stripe, PayPal, and Klarna ship in core. More are meant to follow — the whole
shape of `src/lib/payments/` exists so that adding one costs a file and a line.

> **Status.** The protocol logic, the security controls, and the whole
> webhook → capture → order-state chain are implemented and tested. The
> *security-critical* parts are tested adversarially and offline (see
> [Testing](#testing)). What is **not** verified is a round trip against the
> providers' live sandboxes, which needs real credentials. **Run each provider
> in its sandbox before taking real money.** Treat this as "correct by
> construction and heavily tested", not "battle-proven in production".

---

## What this design refuses to do

Most of the code here is shaped by things it deliberately will not do.

**It never touches card data.** Every provider uses hosted checkout: we create a
session server-side and redirect the buyer to the provider's own page. No PAN,
CVV, or IBAN enters this process, which is what keeps a self-hosted AstroBaaS
out of PCI-DSS scope. A provider that wants raw card fields does not belong in
`src/lib/payments/`.

**It never reads credentials from the database.** Provider secrets come from
environment variables only. The settings table is a schemaless bucket with a
public read path, so a secret stored there is one mistake away from being
world-readable — a mistake this codebase has already made once and fixed.

**It never lets the client name the price.** A session is built from a stored
order whose total was computed server-side at checkout.

**It never trusts a webhook body.** Anyone can POST "payment succeeded" to a
public URL. Verification is mandatory and there is **no bypass flag** — a
"skip verification in development" switch is precisely the switch that ends up
enabled in production.

**It never assumes a valid signature means a relevant message.** A verified
event still has to match the order's currency and total before it can mark
anything paid. Signature validity proves *who sent it*, not *what it is about*.
Without that second check, a genuine 1-cent event captures a 500-euro order.

---

## Configure

```bash
PAYMENTS_ENABLED=stripe,paypal,klarna     # nothing is on by default

# Stripe
STRIPE_SECRET_KEY=sk_live_…
STRIPE_WEBHOOK_SECRET=whsec_…             # shown when you add the endpoint

# PayPal
PAYPAL_CLIENT_ID=…
PAYPAL_CLIENT_SECRET=…
PAYPAL_WEBHOOK_ID=…
PAYPAL_ENV=sandbox                        # or 'live'

# Klarna
KLARNA_USERNAME=…
KLARNA_PASSWORD=…
KLARNA_REGION=eu                          # eu | na | oc
KLARNA_ENV=playground                     # or 'live'
KLARNA_COUNTRY=DE
KLARNA_LOCALE=en-DE
```

A provider is offered to buyers only when **all three** hold: it is listed in
`PAYMENTS_ENABLED`, every one of its `requiredEnv` variables is present and
non-empty, and its optional `validateEnv()` finds nothing wrong with the values
that ARE set. Half-configured is the dangerous state — a provider that appears
at checkout and fails mid-flow has already taken the buyer's attention and
reserved stock — so it is reported as `misconfigured` under
**Admin → Settings → Payment providers**. Missing variables and faulty ones are
reported separately, because "go and set this" and "what you set is wrong" send
an admin to different places. Names only, never values: that report is rendered
in the admin and would otherwise be a neat way to exfiltrate a secret through a
screenshot.

Point each provider's webhook at:

```
https://your-site.example/api/payments/webhook/<provider>
```

Manual methods (`bank-transfer`, `cod`) are always available and need no setup.

---

## The buyer's path

1. `POST /api/orders` — checkout. Prices computed server-side, stock reserved
   atomically, order created `pending` / `unpaid`.
2. `POST /api/payments/start` with `order_number`, `email`, `provider` → returns
   `redirect_url`. Order becomes `pending` payment.
3. Buyer pays on the provider's page.
4. Provider calls the webhook. It is verified, then the amount is checked, then
   the order becomes `paid` + `processing`.

Step 4 is what moves the order — **not** the buyer landing back on
`/checkout/success`. A redirect proves nothing; anyone can visit that URL.

### PayPal: approve, then capture

PayPal orders are created with `intent=CAPTURE`. In that flow the buyer's
approval moves **no money**: the shop has to capture the approved order. The
flow is:

1. PayPal sends `CHECKOUT.ORDER.APPROVED`. It is verified and read back, and
   the order reads as `APPROVED`: an **approval**, not a payment.
2. The approved amount is checked against the order. A mismatch is rejected as
   suspicious, and **nothing is captured**.
3. The order must still be able to ship:
   - `payment_status` already `paid` or `refunded`: ignored, nothing captured;
   - open (`pending`, `on-hold`, …): capture;
   - `cancelled` by the payment hold or the abandonment sweep: take the stock
     back first (reopen to `pending`). Only if that works, capture;
   - `cancelled` by **staff**, or cancelled with its stock sold to someone
     else: **not captured**. The approval lapses at PayPal, no money is taken,
     and `payment.approval_not_captured` records why;
   - **`refunded`** — the order *status*, not just the payment one — is **not
     captured** either. Reopening is only ever attempted from `cancelled`, so
     any stock-releasing status that is not `cancelled` ends the same way, with
     `payment.approval_not_captured`. `cancelled` and `refunded` are the two
     (`STOCK_RELEASED_STATUSES`).

   What tells the two cancellations apart is `cancelled_reason`. It is
   written in the same step as the status move, and a move into or out of
   `cancelled`/`refunded` replaces it. A sweep's cancel carries its reason;
   any other cancel, or a reopen, removes it. A reason can therefore never
   outlive the cancellation it describes, and an order the hold cancelled,
   staff reopened and staff cancelled again reads as staff's. Putting an order
   back after a failed capture restores the reason it had, so PayPal's
   redelivery can still be captured.
4. While the capture runs, `payment_capture_started_at` keeps the hold sweep
   off the order (5-minute lease).
5. `POST /v2/checkout/orders/{id}/capture` is sent with body `{}` and
   `PayPal-Request-Id: astrobaas-capture-<our id>-<PayPal id>`. Two
   deliveries of one approval, or a retry after a timeout, capture once.
6. The **capture response** decides. `COMPLETED` with the captured amount is
   applied as a normal payment, including the exact-amount check.
   `ORDER_ALREADY_CAPTURED` is answered by reading the order again. Any other
   refusal (`INSTRUMENT_DECLINED`, …) is a counted declined attempt. A PayPal
   outage (5xx, network) answers the webhook `500`, so PayPal redelivers it.
7. If nothing was captured, an order reopened in step 3 is cancelled again and
   its stock returned. `payment.capture_failed` is audited.

A capture PayPal holds as `PENDING` (eCheck, review) is not money yet. The hold
may release that order meanwhile; when PayPal later completes the capture, it
arrives as a late payment and the order is reopened, or flagged `needs_refund`.

Before this change nothing captured PayPal approvals. An approved order read
back as "ignored", was never paid, and was then cancelled by the payment hold.

### Why `payment_status` is separate from `status`

`status` answers *are we working on it*. `payment_status` answers *did the money
arrive*. Conflating them is how orders get shipped unpaid, so they are two
fields and both show on every row in the admin.

A confirmed payment moves an order to `processing`, never straight to
`completed` — fulfilment stays a human decision.

### Authorisation on `/api/payments/start`

Order numbers are sequential. Number alone would let anyone walk the sequence
and open payment links for other people's orders, which leaks basket contents
and totals through the provider's checkout page. So the endpoint requires the
number **and** the email the order was placed with, and answers a generic 404
for either failure so it cannot be used to enumerate valid numbers.

---

## Verification styles

| Provider | Style | Why |
| --- | --- | --- |
| Stripe | Signed payload | HMAC-SHA256 over `t.rawBody`, constant-time compare, 5-minute replay window |
| PayPal | Verify API **+ fetch-back**, then **capture** | Verified via PayPal's own endpoint, then the order is re-read from the API — money is taken from *that* answer, not the notification. An approved order is captured, and the capture response is the final word (see "PayPal: approve, then capture") |
| Klarna | **Fetch-back only** | Klarna's push is historically unsigned and varies by product; the push is treated as a hint and the authoritative order is fetched with our credentials |

**Fetch-back is the safer default.** It cannot be forged by anyone who does not
already hold our API credentials, and it does not depend on reconstructing a
signing string correctly. When a provider's signing scheme is anything less than
unambiguous, use fetch-back. **Never invent a signature scheme** — a
verification you guessed at is a verification that always passes.

Two details that matter for signed payloads:

- The webhook route reads `request.text()` and passes the bytes through
  untouched. Re-serialising parsed JSON changes them and every signature fails.
- PayPal's `paypal-cert-url` header is pinned to `*.paypal.com` before use. An
  attacker-supplied cert URL is a classic SSRF and spoofing vector.

**Forged posts are throttled before they cost anything.** Verification failures
are counted per provider and client address. After 20 in 10 minutes, the
address gets `429` with `Retry-After`, **before** anything is verified, so a
flood of forged PayPal or Klarna posts stops causing outbound calls. Only
failures count; a delivery that verifies is never throttled. Loopback, private
and unknown addresses are **never** throttled. Behind a proxy that is not
trusted, every provider looks like one of those, and throttling would let 20
forged posts shut out the real provider. Set `TRUST_PROXY=1`. Failures are
audited in aggregate: the first per window, and the moment the address is
throttled, with counts. A misconfigured webhook secret makes real deliveries
fail as well, and they are throttled the same way. Once the secret is fixed,
the provider's retries get through after the window.

**PayPal OAuth tokens are reused** until a minute before their `expires_in`.
They used to be fetched for every operation, including every inbound webhook.
The cache is keyed by environment and a hash of the credentials, and a token
PayPal refuses (401) is dropped.

## Session expiry and the payment hold

An unpaid order paid through a provider is cancelled when the shop's payment
hold runs out (`orders_payment_hold_minutes`, default 120; see COMMERCE.md).
The provider page should close at the same time:

| Provider | Expiry |
| --- | --- |
| Stripe | `expires_at` is set to the end of the hold, clamped to Stripe's 30 min – 24 h window, and stored on the order (`payment_expires_at`). The hold sweep waits for it, plus 5 minutes. `checkout.session.expired` then cancels the order as a failure. |
| PayPal | Orders v2 orders stay payable for 3 h by default, and PayPal alone can extend that. There is no expiry parameter to send. |
| Klarna HPP | The payment session lives 48 h and the hosted page closes 1 h before that. There is no expiry parameter. |

A payment that arrives after the hold is handled as the table above describes.
Once the hold is over, `POST /api/payments/start` refuses to open a new session
(`409 payment.window_closed`).

**Return URLs** (`success_url`, `cancel_url`, PayPal `return_url`, Klarna
`merchant_urls`) are built from the configured Site URL, then `SITE_URL`. The
request's own origin is used only when neither is set, so a forged `Host`
header can no longer set where a real provider page sends the buyer.

The CMS serves no `/checkout/success` or `/checkout/cancelled` page; the
storefront does. **Set Site URL to the storefront's address.** When an online
provider is enabled, `/api/health/deep` reports a `payment_return_urls`
**warning** (never a failure), and it is shown under the Site URL field in
Settings and as an "Unfinished" card on the dashboard, if:
- Site URL is empty;
- or buyers would be sent to the CMS's own address: `public_site_url`, or the
  host the CMS answered the check on.

---

## Idempotency and out-of-order delivery

Providers deliver **at least once** and retry on any non-2xx. Every applied
event id is recorded on the order (bounded to the last 50) and a repeat is a
no-op.

The event is **claimed atomically** (`Storage.claimPaymentEvent`): its id is
appended and the payment status written in one step, only if the id is not
already on the order AND the payment status is still the one the decision was
taken on. Two deliveries of one event arriving together apply it once. A
failure decided on a stale read can no longer write `failed` over a `paid` that
landed in between: it finds the status changed, decides again, and ignores
itself. On the relational driver the claim is one conditional `UPDATE`, so it
also holds across processes.

Delivery order is not guaranteed either, so the decision table in
`capture.ts` is deliberately conservative:

| Situation | Outcome |
| --- | --- |
| Success, amount matches | capture → `paid` + `processing` |
| Success, amount or currency differs | **reject**, audit-logged as suspicious |
| Success on an already-paid order | ignore |
| Success arriving after a refund | ignore |
| Success on an order that was already **cancelled** (payment hold, abandonment, staff) | capture, then reopen and re-take the stock. If the stock is gone, the order **stays cancelled**, is marked `needs_refund`, audited `payment.needs_refund`, and the owner is emailed |
| Failure on an unpaid order (the session expired or failed) | `failed` + `cancelled` (returns stock) |
| **One declined card** (Stripe `payment_intent.payment_failed`) | **decline**: counted on the order (`payment_declines`), nothing else changes, and the buyer can retry on the same page. Five declines flag the order `card_testing` |
| **Failure arriving after a success** | **ignore** — never cancel a paid order |
| Refund of a paid order | `refunded` (returns stock) |
| Refund of an order never paid | **reject**, audit-logged as suspicious |
| Anything unrecognised | ignore |

Ignoring a real event costs a support ticket. Acting on a misread one costs
shipped goods or lost money — so anything ambiguous does nothing.

A verified-but-rejected event is logged to the audit trail as
`payment.rejected`. That is either a serious misconfiguration or an attack, and
it must never be silent.

---

## Adding a provider

The contract is the same whichever route you take:

1. Implement `PaymentProvider`: `createSession(order, ctx)` and
   `verifyWebhook(rawBody, headers, ctx)`. `verifyWebhook` **must throw**
   `WebhookVerificationError` on any failure — returning `'ignored'` is for
   events that verified fine but are irrelevant.
2. Declare `requiredEnv`, and optionally `validateEnv(env)` for faults in values
   that are set. Enablement, the admin report, and the checkout method gate are
   all driven from those two.
3. Use `ctx.fetch` and `ctx.now()` rather than the globals, so your provider
   stays testable without network or clock access.

**From a plugin — no fork required.** Return your provider from the
`payment_providers` filter; the plugin bootstrap collects what every active
plugin offers and calls `setPluginProviders()` once. Nothing else changes: the
API, the admin, the webhook route and the payment hold all read
`allProviders()`, so a plugin gateway is offered, reported and held exactly like
a built-in one. An id that already exists is **refused** with an error and the
original stands — a provider silently replacing `stripe` would reroute live
payments, which has to fail loudly rather than be resolved by array order. A
method that takes no credentials and calls no API is not a provider; use
`manual_methods` for that.

**In core — one file and one line.** Add `src/lib/payments/<id>.ts` and append
it to `BUILT_IN_PROVIDERS` in `registry.ts`. `ALL_PROVIDERS` is still exported
but is `@deprecated`: it is a constant, so it cannot see plugin providers. Read
`allProviders()`.

---

## Testing

`tests/payments.test.mjs` (109 assertions) attacks the pure logic offline:
forged signatures, wrong secrets, tampered bodies, replayed and future-dated
timestamps, non-integer timestamps, secret rotation, underpayment and
overpayment, wrong currency, duplicate delivery, refunds of unpaid orders, and
half-configured providers.

The smoke suite runs the **whole chain live** on all three storage drivers.
Stripe's verification is a local HMAC with no network call, so the smoke server
enables Stripe with a test secret and then proves, against a real order:

- unsigned, wrong-secret, tampered, and stale-timestamp webhooks are all `401`
  and move nothing;
- a correctly signed event for the *wrong amount* is rejected, not captured;
- a correctly signed, correctly priced event captures the payment and moves the
  order to `processing`;
- re-delivering the same event id is a no-op;
- a late failure does not cancel the now-paid order.

What that leaves untested is session *creation*, which needs the providers' live
APIs. Hence the status note at the top.

---

### Refunds

Admin-only, from the order detail view or the API:

```
GET  /api/orders/{id}/refund     # what is refundable, and what has been refunded
POST /api/orders/{id}/refund     # { "amount_cents": 1250 }  — omit for the full remainder
```

`amount_cents` is optional: omit it to refund everything still outstanding.
Partial refunds are supported, and a partial refund cannot quietly become a full
one — a second call is required to refund the remainder. Refunding is
deliberately admin-only and separate from order editing, because moving money is
a financial control and does not belong to the same role by default.

Refunds reported by the provider's webhook are still recognised independently,
so a refund issued from the provider's dashboard reconciles correctly too.

A refund is **appended atomically** (`Storage.appendRefund`), and the payment
status is computed from the refunds stored on the order. Before, two partial
refunds sent at once each wrote their own copy of the list and the second
erased the first. A double-clicked refund, which the provider answers with the
same refund twice, is now recorded and audited once. Two DIFFERENT partial
refunds planned at the same instant can still both reach the provider; its own
check against the captured amount refuses any excess.

A full refund of an order flagged `needs_refund` clears the flag. The order
stays `cancelled`.

## Known limits

- **No partial capture.** An authorised amount that does not match the order
  exactly is rejected.
- **Settlement currency is not reconciled.** An order is priced in the shop's
  `shop_currency`, or in an enabled presentment currency at the operator-entered
  rate, and that code is frozen onto the order. Every provider session is
  created in `order.currency` — Stripe's `price_data[currency]`, PayPal's
  `currency_code`, Klarna's `purchase_currency` — and a webhook whose currency
  differs from the order's is rejected rather than captured. What the acquirer
  actually converts and settles at is its own rate, which this system never
  sees: `base_total_cents` is an indicative accounting figure, not a settlement.
  See COMMERCE.md.
- **Stripe events outside the mapped set are ignored**, including
  dispute/chargeback notifications. Watch those in Stripe.
- **Klarna's tax fields are sent as zero.** The order's tax IS computed (see
  COMMERCE.md), but it is not itemised into the Klarna session:
  `total_tax_amount` and `tax_rate` go out as `0` because Klarna requires the
  fields to be present. The amount charged is the order's own total.
