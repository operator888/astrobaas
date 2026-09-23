# AstroBaaS Commerce

First-class ecommerce: products, brands, product categories, orders, customers —
across all storage drivers, with plugin hooks for everything beyond the basics.

## Local dev — full shop in 4 commands

```bash
# 1. Backend (this repo)
npm install
npm run import:woo -- data/import.example --apply   # synthetic demo catalogue (idempotent)
node scripts/mint-storefront-key.mjs "../my-storefront/.env.local"
npm run dev                                         # → http://localhost:4321

# 2. Storefront (your own app — new terminal)
npm install && npm run dev                          # → http://localhost:3000 (or next free port)
```

The order of those two scripts matters, and so does `--apply`:

- **`--apply` is not optional.** Without it the importer rehearses: it prints
  the plan and the records it would skip, and writes **nothing**.
- **The import is what creates the database.** `mint-storefront-key.mjs` reads
  `db.json` directly and fails if it is not there; the import (like any first
  run) creates it, along with the bootstrap administrator below. On a libSQL or
  relational install there is no `db.json` at all — the script refuses rather
  than writing one nothing reads, and you mint the key from **Admin → API keys**
  instead.
- **The shop is OFF on a fresh install.** `commerce_enabled` is absent, which
  means off, so `/api/products` and `/api/orders` answer **404** to anonymous
  callers — deliberately, with the same body and headers as a genuinely unknown
  path, so an install that does not sell does not advertise that it could.
  Importing products or orders turns the shop on and says so; without an
  import, switch it on at **Admin → Settings → Shop → Selling**. Staff screens
  work either way, so a catalogue can be stocked before opening.
- **The mint script writes `ASTROBAAS_URL` + `ASTROBAAS_KEY`** into whatever
  env file you point it at, and prints the key once. Read those two variables
  from your storefront's own configuration.

## Admin

- URL: `http://localhost:4321/admin`
- Bootstrap login: **admin@local / admin** — change it immediately
  (Admin → Users), then enable 2FA (TOTP) on your account.
- Screens: Dashboard · Posts (blog) · Products · Orders · Customers ·
  Media · Users · Messages · Plugins · API keys · Webhooks · Audit log.

## API surface

See `/llms.txt` and `/openapi.json` on a running instance. Highlights:

- `GET /api/products` (public; `?category= ?brand= ?search= ?on_sale=` + pagination)
- `POST /api/orders` — checkout; anonymous same-origin (CSRF) or bearer key;
  prices/totals computed server-side, stock decremented, customer auto-created
- Staff-only (PII): `GET /api/orders`, `GET /api/customers`
- API-key scopes: `posts|content|media|products|orders|customers|messages : read|write|*`
  (`SCOPED_RESOURCES` in `src/lib/api-key-scopes.ts`; a key with no scopes is
  governed by its role alone)

## Extension points (plugins)

Filters/actions in `PLUGIN_HOOKS`: `before/after_product_save`,
`after_product_delete`, `product_price` (sale rules, member pricing),
`before_order_save`, `after_order_create` (emails, ERP sync),
`after_order_status_change`. Webhook events: `product.*`, `order.*`,
`customer.created`.

## Money

Integer cents everywhere. No floats in commerce code — house rule.

## Production notes

- Set `DATABASE_URL=file:./data/astrobaas.db` (libSQL) or
  `DATABASE_DRIVER=relational` for multi-writer (see STORAGE.md).
- `CORS_ORIGINS` must include the storefront origin.
- Product images are published against a **media base**, which is resolved
  from the `public_site_url` / `site_url` settings, then `SITE_URL`, then the
  request's own origin (`src/lib/media-base.ts`). There is no `MEDIA_BASE`
  environment variable. When nothing usable is configured the API publishes the
  relative path only, rather than inventing an origin.
- To bring a dump's images in, pass **`--media <dir>`** to the importer (the
  extracted `wp-content/uploads`). Each file goes through the same ingest
  pipeline an upload uses — sniffing, EXIF strip, derivatives — and the products
  are re-pointed at the stored copies. Storage is content-addressed, so
  re-running it is harmless.

## Inventory guarantees

Checkout reserves stock **atomically**. The availability check and the decrement
are a single step — one mutex hold on the lowdb driver, a conditional
`UPDATE … WHERE stock >= ?` on the relational driver — so two concurrent
checkouts for the last unit cannot both succeed. (Checking stock and then
decrementing as separate awaits is a TOCTOU race: it oversells, and it did.)

- If a later line in a multi-item order fails, **earlier reservations are rolled
  back**, so a failed checkout never strands inventory.
- `stock: null` means **untracked** — always purchasable, never decremented.
- Moving an order **into** `cancelled`/`refunded` returns its stock; moving it
  **out** re-takes it, and the reopen is refused with 409 if the stock is gone.
  The move is claimed atomically from the status it was decided on
  (`transitionOrderStatus`), and only the request that wins the claim moves
  stock — so re-cancelling can't credit twice even when the two cancels arrive
  at the same moment (a double-click, an admin cancel meeting a refund
  webhook). The loser answers what a second request in sequence would: 200
  with the order for a repeat, the state machine's 409 for a contradiction.

The smoke suite asserts all of this against **all three storage drivers**,
including firing six concurrent orders at a stock-of-one product and requiring
exactly one to win.

## Order limits

Checkout is a **public, anonymous** endpoint, so "how much can one request ask
for" is an abuse control, not a UX preference: uncapped, a single request can
drain a product's inventory or inflate an order to an absurd size. Two limits
apply, both editable at **Admin → Settings → Order limits** (no redeploy):

| Setting | Key | Default | Range |
| --- | --- | --- | --- |
| Max units of one product per order | `order_max_qty_per_product` | **3** | 1–1000 |
| Max distinct lines per order | `order_max_items_per_order` | 50 | 1–200 |

Defaults are deliberately conservative — a shop that wants bulk orders opts in,
rather than every shop being exposed by default. Resolution is pure and clamped
([`src/lib/commerce-settings.ts`](src/lib/commerce-settings.ts)), so a corrupt or
hostile settings row can never widen a limit past its ceiling or disable it: `0`
clamps to `1`, junk falls back to the default. Exceeding a limit is a `400` and
rolls back any stock already reserved for earlier lines.

**Storefronts should read the live values rather than hard-coding `3`:**

```jsonc
// GET /api/products
{ "data": [ /* … */ ],
  "meta": { "max_qty_per_product": 3, "max_items_per_order": 50 } }
```

## Error statuses

Checkout distinguishes the two failure kinds, because they need different client
behaviour:

- **`400`** — the request is wrong (bad payload, unavailable product, limit
  exceeded). Retrying unchanged will fail again.
- **`409 CONFLICT`** — the request was fine but the world changed: another buyer
  took the units first. Refresh availability and retry with less.
  `reason: "checkout.promotion_unavailable"` means an automatic cart rule the
  quote applied has been used up meanwhile — re-quote and show the new total.
- **`429`** with `reason: "checkout.too_many_unpaid"` — this buyer (email, or
  for an anonymous shopper also the network address) already has the maximum
  number of unpaid orders waiting. Pay or cancel one first. `Retry-After` is
  set. See [Unpaid orders](#unpaid-orders-the-payment-hold-and-the-per-buyer-cap).
- **`403`** with `reason: "checkout.captcha_failed"` — the operator switched on
  proof-of-work for checkout and the request carried no valid `pow_token`.

The specific reason is always in `error.reason` (with `error.params`);
`error.code` stays the HTTP-derived code (`BAD_REQUEST`, `CONFLICT`,
`RATE_LIMITED`, …) it has always been.

## Money: VAT, shipping and discounts

### What AstroBaaS is NOT

**It is not a fiscal device.** The shop issues its receipts and τιμολόγια
(invoices) from its own certified fiscal device (ΦΗΜ), which numbers, signs and
reports them. AstroBaaS does not emulate that, does not transmit to myDATA, and
does not number anything as a legal document — `/receipt` says so in its own
words and is deliberately not called an invoice.

What it owes instead is two things: **the correct ΦΠΑ (VAT) on every line**, and
the counterparty's **ΑΦΜ (Greek tax id) recorded beside the order**
(`Address.tax_id`), so whoever operates the fiscal equipment has both without
retyping them. That field is capture, not compliance — it is never
checksum-validated and never checked against VIES, because a refusal there would
block an order over a number this system does not act on.

### Tax by destination

The rate is chosen by tax class **and** by where the goods are going, once the
engine is switched on. `resolveTaxTreatment` decides one treatment for the whole
basket and every line — including the shipping line, because transport ancillary
to a supply of goods follows the goods — is priced under it
(`src/lib/commerce/tax.ts`, called from `pricing-service.ts` and `totals.ts`):

| Treatment | When | Rate |
| --- | --- | --- |
| `domestic` | destination is the shop's own country, or there is no destination yet, or the engine is off | the shop's own ladder, by tax class |
| `destination` | EU B2C into another member state (OSS) | that country's rate for the class |
| `reverse-charge` | EU B2B, customer supplied a VAT id from a different member state | **0%** |
| `export` | outside the EU VAT territory | **0%** |
| `not-configured` | a rate is owed and none is on file | checkout refuses — see below |

It stays OFF until **both** `shop_country` and `tax_destination_mode: "oss"` are
set. The whole engine is a comparison against where the shop is, so turning it
on without an origin would make every sale look cross-border, and defaulting the
origin would invent a tax position. `tax_reverse_charge_enabled` switches the
B2B case on; `tax_eu_countries` seeds the membership list and is editable, so a
country moving in or out does not need a release.

A VAT id is checked by **shape only** — two letters then 2–12 alphanumerics.
Core does not call VIES, does not keep the evidence an audit asks for years
later, and does not pretend to: zero-rating on shape alone is a policy an
operator turns on deliberately.

**The real gap is the rate tables, not the engine.** Core ships **zero** foreign
rates. A member state's numbers change continuously and getting one wrong is the
merchant's liability, so maintained tables are a rate pack's job and what core
owns is the resolution. A destination with no rate for a class on file is
`not-configured`, and checkout answers **409**
`reason: "checkout.tax_not_configured"`, naming the country and the classes to
add. It never falls back: 0% under-charges the buyer's own tax authority and the
origin rate charges a German buyer Greek VAT, and both look entirely plausible
on the invoice.

### How a total is actually computed

An order total is not the sum of its lines, and on the default install it is
**not** `subtotal − discount + shipping + tax` either — that formula counts the
tax twice. It is computed server-side in one place
(`calculateTotals`, `src/lib/commerce/totals.ts`) and every part is stored on
the order, so an invoice is reproducible years later.

The order of operations is: line amounts from stored prices → discount,
allocated across lines to the cent → tax, on the **discounted** amounts →
shipping, then tax on shipping → total. Tax after discount is the step that
matters legally: VAT is due on what the customer actually pays.

What reconciles then depends on the pricing convention. Per line
`net + tax === gross` exactly under both, because one side is computed and the
other subtracted:

| `prices_include_tax` | `total_cents` is | `tax_cents` is |
| --- | --- | --- |
| `true` (the default) | `subtotal − discount + shipping` | how much of that charge is VAT, **extracted** from it |
| `false` | `subtotal − discount + shipping + tax` | VAT **added** on top |

Worked, at 24% with a €10.00 discount on a €124.00 line and €5.00 shipping —
the same basket through both conventions, in cents:

| | inclusive (default) | exclusive |
| --- | --- | --- |
| `subtotal_cents` | 12400 | 12400 |
| `discount_cents` | 1000 | 1000 |
| line `net` + `tax` = `total` | 9194 + 2206 = 11400 | 11400 + 2736 = 14136 |
| shipping (`shipping_cents` / its tax / `shipping_total_cents`) | 500 / 97 / 500 | 500 / 120 / 620 |
| `tax_cents` | 2303 | 2856 |
| **`total_cents`** | **11900** | **14756** |

In the inclusive column the €5.00 shipping charge is €5.00, with €0.97 of VAT
already inside it. Adding `tax_cents` to that column gives 14203 — €23.03 more
than the shop charges, which is what the old formula in this file described.
`totalsReconcile()` asserts the parts against the whole and is exported so both
the tests and the runtime can call it.

**One calculation, two callers.** `POST /api/orders/quote` and `placeOrder()`
both call `priceBasket()`. Nothing else computes a total. A cart page that ran
its own arithmetic would eventually disagree with the charge, so there is no
second implementation to drift from — the smoke suite asserts the two agree.

### VAT

Rates are **data**, in settings, per tax class. There is no Tax screen in the
admin yet — these are settings rows, written through `POST /api/settings/update`:

```jsonc
{ "tax_enabled": true,                     // off unless switched on
  "tax_prices_include_tax": true,          // EU retail: prices shown incl. VAT
  "tax_default_class": "standard",
  "tax_shipping_class": "standard",

  // The seeded ladder. `country` absent means the shop's own country.
  "tax_rates": [
    { "class": "standard",      "label": "Standard",      "rate_bp": 2400 },
    { "class": "reduced",       "label": "Reduced",       "rate_bp": 1300 },
    { "class": "super-reduced", "label": "Super-reduced", "rate_bp": 600 },
    { "class": "zero",          "label": "Zero-rated",    "rate_bp": 0 },

    // A foreign row. Core ships none of these; you or a rate pack add them.
    { "class": "standard", "label": "DE standard", "rate_bp": 1900, "country": "DE" },

    // A special territory, in the SAME postcode grammar shipping zones use and
    // matched by the same function. A postcode row beats a country-wide one.
    { "class": "standard", "label": "Special territory", "rate_bp": 0,
      "postcodes": ["630*"] }
  ],

  // Destination resolution. Off unless the first two are BOTH set.
  "shop_country": "GR",
  "tax_destination_mode": "oss",
  "tax_reverse_charge_enabled": true,
  "tax_eu_countries": ["AT", "BE", "…"] }
```

`rate_bp` is **basis points** (2400 = 24%), so the rate is an integer like the
money it multiplies. The seeded values are a starting point, **not** an
assertion about current law — rates change, and which optical goods qualify for
a reduced rate is a question for your accountant.

- **`prices_include_tax: true`** (the default) EXTRACTS the tax already inside
  the price. This is the normal EU retail case. `false` adds it instead.
  Getting this backwards is a ~19% error on every order.
- **`net + tax === gross`, exactly.** One side is computed and the other
  subtracted, so an invoice always reconciles to the charge.
- **Tax is charged on the DISCOUNTED amount.** VAT is due on what the customer
  actually pays; taxing the list price over-collects on every discounted order.
- Per-product `tax_class` and `tax_status` are honoured, including
  WooCommerce's `'shipping'` — "shipping only", meaning the goods are untaxed
  but the delivery charge is not.
- An **unknown** tax class falls back to the default rate, never to zero: a typo
  must not silently stop charging VAT. That fallback is **domestic only** — a
  `destination` with no row for the class is the `not-configured` case above and
  must not borrow the origin's number.

### Shipping

Methods live in `shippingMethods`, with three rate models:

| Rate | Shape |
| --- | --- |
| flat | `{kind:'flat', amount_cents}` |
| per weight | `{kind:'weight', base_cents, per_kg_cents}` — billed per **started** kilogram, like a courier |
| free over | `{kind:'free_over', threshold_cents, otherwise_cents}` |

Zones match on country **and** optional postcode patterns — `"84600"` exact,
`"846*"` prefix, `"84000-84999"` inclusive numeric range. That is not
over-engineering: Greece is one country whose island postcodes carry a
surcharge, and a country-only model forces you to overcharge Athens or
undercharge Rhodes. **The most specific matching zone wins**, so an island
address is never offered the cheaper mainland rate.

`requires_shipping: false` (and `virtual: true`) products are excluded from
weight and, if the whole basket is virtual, skip shipping entirely.

**The client sends a method id, never a price.** The cost is re-derived from the
stored method and the actual basket, and a method that does not serve the
destination is refused rather than falling back to free.

### Coupons

Percentage or fixed, with optional minimum subtotal, validity window, total and
per-customer usage limits, product/category restriction, and free shipping.

Rejections carry a **reason** — but only staff see the specific one.
`expired`, `disabled`, `not-started`, `usage-limit-reached` and
`customer-limit-reached` all say the code EXISTS, so an anonymous quote endpoint
answering them told a script which of the codes it tried were real. Anyone who
is not staff — an anonymous cart page, and an API key, which is a storefront
that repeats what it is told — gets `reason: "invalid"` with the sentence a
missing code gets. The one exception is **`minimum-not-met`**, which is kept with
its `shortfall_cents` because "spend 3 € more" is something a buyer can act on.
Staff previewing a basket from an admin session still see the real reason.

The same rule applies to a refused coupon at checkout: `POST /api/orders`
answers `400` with `reason: "checkout.coupon_invalid"`, a generic message, and
`params.shortfall_cents` only for a minimum-spend refusal.

**Usage limits are claimed atomically.** A use is counted
(`Storage.claimCouponUse`, a conditional increment that only lands while
`used_count < usage_limit`) before the order is written, and handed back if the
order is not placed. Two checkouts with a one-use code can no longer both get
it.

A discount is allocated across lines to the cent (largest-remainder), because
tax is computed per line and the parts must still sum to the whole.

### Quoting

`POST /api/orders/quote` takes the same body as checkout and creates
**nothing** — no order, no customer, and no stock reservation. A cart page calls
it on every change, and a quote that held stock would let anyone empty the
catalogue by holding refresh.

## Variants

A product with `variants` is bought THROUGH one; a product without them is
bought directly. Eyewear forced this: every frame ships in several colours and
often several sizes, and modelling those as separate products breaks inventory
(each colour has its own count), search (five near-identical rows) and the
product page (no colour picker).

```jsonc
{ "name": "Aviator", "price_cents": 12000,
  "attributes": [{ "name": "Colour", "values": ["Black", "Tortoise"] }],
  "variants": [
    { "options": { "Colour": "Black",     "Size": "52" }, "stock": 4 },
    { "options": { "Colour": "Tortoise",  "Size": "52" }, "stock": 2,
      "price_cents": 13900, "sku": "AV-TORT" }
  ] }
```

- **A variant overrides only what it sets.** Price, SKU, barcode, weight and
  image fall back to the parent, so a shop varying only colour states the price
  once. **Stock never inherits** — "how many black ones are left" is the entire
  question a variant exists to answer.
- **Checkout requires a choice.** `POST /api/orders` and `/quote` take
  `{product_id, variant_id, qty}`; a variable product without a valid
  `variant_id` is refused rather than defaulted to the first colour.
- **Stock is reserved atomically per variant** on all three drivers — a mutex
  hold on lowdb, a compare-and-set with retry on SQL. Verified live: six
  concurrent buyers against a variant with stock 2 produce exactly two orders,
  and the other variant is untouched.
- **Order lines freeze the chosen options.** Renaming "Black" to "Matte Black"
  next year must not change what a customer ordered, and deleting a variant must
  not make an old order unreadable.
- Variant ids are **preserved across edits** when the option combination is
  unchanged, because every historical order line references them.

`type` is derived (`variable` when variants exist) and never accepted from a
client — a product claiming to be variable with no variants would be unbuyable.

## Abandoned orders

Reserving stock at checkout is what stops two buyers taking the last unit. The
cost is that an order which is never paid holds its reservation — and with
`bank-transfer`, where nobody clicks anything, it holds it forever, so a shop
slowly runs out of stock it physically has.

An unpaid order is therefore **cancelled after 3 days** (configurable), which
returns its stock through the same path a manual cancel uses. The sweep runs on
the scheduler alongside scheduled posts.

| Setting | Default |
| --- | --- |
| `orders_abandon_enabled` | `true` |
| `orders_abandon_after_days` | `3` (clamped 1–90) |

The rules are deliberately conservative, because cancelling the wrong order
takes goods back from someone who paid: a **paid** order is never touched
whatever its age, nor is one a human has moved out of `pending`, nor one already
closed, nor one whose date will not parse. Those rules are applied again to the
order as it is at the moment of cancelling, with its payment status pinned in
the write — the sweep's list is read earlier, and a payment or a staff cancel
can land in between. Cancelled orders record
`cancelled_reason: "abandoned"` and `abandoned_at`, so an operator can tell an
abandonment from a customer changing their mind.

## Unpaid orders: the payment hold and the per-buyer cap

Checkout is public and anonymous, and every order it accepts takes stock off the
shelf until it is paid or cancelled. Three days is right for a bank transfer and
absurd for a card, so a script could empty a catalogue for days. Two controls,
both in **Admin → Settings → Unpaid orders**:

| Setting | Key | Default | Meaning |
| --- | --- | --- | --- |
| Payment hold | `orders_payment_hold_minutes` | **120** | Unpaid ONLINE-payment orders are cancelled after this, and their stock returned. `0` = off. Otherwise clamped 30–1440. |
| Unpaid orders per buyer | `orders_max_unpaid_per_buyer` | **5** | Open unpaid orders one buyer may hold. `0` = off. |

**The hold** applies to orders whose payment method is an online provider —
every id in the payment registry, so a plugin gateway is included. Bank
transfer and cash on delivery keep the day-based sweep above. A separate
scheduler sweep cancels them through the same `setOrderStatus` path (the
decision re-checked on the order at the moment of the write, the payment status
pinned), records `cancelled_reason: "hold-expired"` and `hold_expired_at`, and
audits `order.hold_expired`.

The clock starts when the order is placed. Re-opening the payment page does not
restart it. An order placed with a manual method and then sent to a provider is
different: its clock starts at its first payment start (`payment_started_at`).
Once the hold is over, `POST /api/payments/start` answers **409**
`reason: "payment.window_closed"` rather than open a page for an order about to
be cancelled.

**The hold matches the provider session:**

| Provider | How its page closes |
| --- | --- |
| Stripe | The Checkout Session is created with `expires_at` = hold end, clamped to Stripe's 30 min – 24 h window. That is why the hold is clamped to the same range. The accepted expiry is stored as `payment_expires_at`, and the sweep waits for it plus 5 minutes for the last webhook. |
| PayPal | An Orders v2 order stays payable for **3 hours** (PayPal's default; only PayPal can extend it, up to 72 h). The create call has no expiry parameter, so a hold under 3 h can be outlived by the PayPal page. PayPal's approval moves no money. AstroBaaS **captures** it, and only after taking back the stock of an order the hold already cancelled. It never captures when that stock is gone, or when staff cancelled the order (PAYMENTS.md, "PayPal: approve, then capture"). |
| Klarna (HPP) | The payment session lasts 48 h and the hosted page closes 1 h before that. No expiry parameter either. |

**A payment that arrives after the order was cancelled** is not dropped. The
order is reopened, and its stock taken again, when the stock is still there.
Otherwise the order **stays cancelled**. It records `payment_status: "paid"` and
`needs_refund: true`, writes a `payment.needs_refund` audit entry, and the owner
gets an email (the sale-notification recipients, else `admin_email`). The
admin order list shows a "Needs refund" badge, and the dashboard shows a
"Needs fixing" card that cannot be dismissed. A full refund clears the flag.
Nothing ships without stock behind it.

**The cap** counts open unpaid orders (`pending`, or risk-held) twice:

- by the normalised email, over the abandonment window;
- separately, by the hashed client address order-risk already stores, over a
  **shorter** window: the payment hold (at least an hour; two hours when the
  hold is off). Many real buyers share one address — an office, and above all
  a mobile carrier's NAT — so the per-address count only catches bursts.

The next checkout is **429** `checkout.too_many_unpaid`.

The per-address count is **skipped** when the address is loopback, private or
unknown. On a proxy that is not trusted (`TRUST_PROXY` unset), or a container
bridge, that is what every shopper looks like, and counting it would refuse the
whole shop after five open orders. **Set `TRUST_PROXY=1` behind a reverse
proxy.** Behind a CDN, also restore the real client IP (deploy/README.md);
otherwise the count is per CDN edge address.

The cap applies to:

- anonymous shoppers: by email and by address;
- API-key callers (a storefront's server): by email only, because every shopper
  behind the server shares its address;
- staff sessions (phone orders): not at all.

The check runs before any stock is reserved. It reads one indexed, bounded
window of recent orders (`Storage.getRecentOrders`), and risk scoring reuses the
same read.

### Declined cards

A declined card on Stripe Checkout (`payment_intent.payment_failed`) is an
**attempt**. The buyer can try another card on the same page, so it no longer
cancels the order or releases its stock. Before this change, card testing
cycled the shop's stock. Each decline is counted (`payment_declines`,
`payment_declined_at`). At five, the order is flagged with the risk signal
`card_testing`. The session expiring (`checkout.session.expired`), and
`checkout.session.async_payment_failed`, still fail and cancel the order.

### Risk hold (opt-in)

Risk scoring flags orders and never refuses them (see
`src/lib/commerce/order-risk.ts` for why). With
`orders_risk_hold_enabled` (default **off**), an order scoring at least
`orders_risk_hold_score` (default 5, the flag threshold) is placed as
**`on-hold`** with `risk_held: true` and its reasons stored. No buyer is refused
and its stock is held. The buyer can still pay, but **a payment does not move
it to `processing`**, so a person looks first. Unpaid, it expires like any
unpaid order, so a flagged hoarder cannot keep the stock.

### Idempotency-Key

`POST /api/orders` accepts an `Idempotency-Key` header: 1–255 printable ASCII
characters **with no spaces** (`\x21`–`\x7e`, which is what every client library
generates). A space, a tab or an empty value is a **400**
`IDEMPOTENCY_KEY_INVALID`. Keys are scoped to the caller and the route, and
stored only as a hash. The first request claims it durably, on all
three drivers. A retry while that request runs gets **409**
`IDEMPOTENCY_IN_PROGRESS`. A retry after it succeeded gets the **same 201 body**
with `Idempotent-Replayed: true`, for 24 h. A refused request (out of stock,
bad coupon, …) releases the key, so fixing the cause and retrying works. The
same key with a different body is **422** `IDEMPOTENCY_KEY_REUSED`. See
INTEGRATION.md.

## The order confirmation email

The buyer gets one, and it is **on by default** (`order_confirmation_enabled`;
only an explicit `false` turns it off, for a storefront that sends its own).
This is not the staff sale notification — that one mails the shop and stays off
until an admin sets recipients. The buyer's version leads with the order number
and what happens next, because that is the question they actually have.

- **Bank-transfer details come from the payment method's own `instructions`**,
  not from a setting belonging to this email, so the checkout page and the email
  cannot disagree about the IBAN. For the built-in manual methods those are the
  `payment_instructions_bank_transfer` / `payment_instructions_cod` settings; a
  plugin-declared method supplies its own. With nothing configured the email
  says a human will follow up rather than promising details it does not have.
- **At most five confirmations per recipient per hour.** Checkout is public and
  anonymous, so without a budget it is a way to flood somebody else's inbox.
  The counter is keyed on a **hash** of the normalised address — the shared
  rate-limit store should not double as a list of customer emails — and the log
  line records the order number, not the address. Like every counter here it
  fails open: a store outage sends the email.
- **A mail failure never fails a checkout.** The order is already stored and the
  customer has already paid or committed to pay. Losing the confirmation is bad;
  losing the order is worse. Every failure is caught and logged.

The subject is templatable (`order_confirmation`); the body is not. CR/LF is
stripped from anything that reaches a header, because the order number and the
operator-authored shop title both land in the subject.

Code: `src/lib/commerce/order-confirmation.ts`, wired in
`src/lib/commerce-service.ts`.

## Invoicing and AADE / myDATA

**AstroBaaS does not transmit to myDATA, and deliberately so.** Greek e-invoicing
is a legal obligation, and an integration nobody has round-tripped against
AADE's own sandbox has no business claiming compliance.

The supported path is the one most small retailers already use: issue the
receipt or invoice on your POS, whose certified fiscal mechanism is what
transmits to AADE. Record its document number against the order in
`external_receipt_no` so the webshop and the till reconcile.

If you later want automated transmission, do it through an accredited
e-invoicing provider (πάροχος) rather than hand-rolling the AADE API.

## Known limits (not yet solved)
- **Multi-currency is presentation, not settlement.** The shop has a base
  currency and may quote additional ones at operator-entered rates; the rate is
  frozen onto each order so a later change never rewrites what was charged. What
  the acquirer actually converts at is its own rate, which this system never
  sees — `base_total_cents` is an indicative accounting figure, not a
  settlement.
- **No cart.** By design: a cart is per-visitor UI state and belongs in the
  storefront (localStorage/context). Send `{product_id, qty}[]` to
  `/api/orders/quote` for totals and to `/api/orders` at checkout.
- **No foreign VAT rate tables.** The destination engine itself ships and is
  wired into checkout — OSS for EU B2C, 0% reverse charge for an EU business
  with a VAT id, 0% export (see [Tax by destination](#tax-by-destination)).
  What core does **not** ship is a rate table for anywhere but your own country,
  because keeping twenty-seven member states' ladders current is a standing
  obligation rather than a constant. A destination with no rate on file stops
  checkout with `409 checkout.tax_not_configured` instead of guessing, so the
  failure is loud and names what to add.
- **No lens configurator, and no prescription enforcement in core.** Variants
  cover frame colour/size. Core stores the flags and the Rx and can render one,
  but the clinical rules that decide whether a prescription is fillable are not
  in core, and priced lens options are not modelled at all —
  see [Paid vertical modules](#paid-vertical-modules).
- **Coupon usage limits are atomic; per-customer limits are not.** `used_count`
  is claimed atomically before the order is written. If the process dies
  between the claim and the order write, one use is counted without an order,
  which errs against the shop. `usage_limit_per_customer` is still judged from
  the customer's prior orders. Two checkouts by the same customer at the same
  instant both see the same count, so that limit can be exceeded by concurrent
  orders.
- **The unpaid cap reads a bounded window.** It counts at most the newest 5000
  orders in the abandonment window and fails open beyond that. A buyer who
  rotates both email and network address is not stopped by it; the hold is what
  bounds how long their orders keep the stock.
- **The hold cannot close a PayPal or Klarna page early.** A Klarna payment
  that arrives after the hold reopens the order, or flags it for a refund (see
  above). A late PayPal approval is captured only if the order can be reopened
  first; otherwise nothing is taken.
- **A PayPal capture that PayPal holds as `PENDING`** (eCheck, review) is not
  money yet, and the hold may release the order before it completes. It is then
  handled as a late payment.
- **`replace: true` import is not transactional** — a failure mid-import can
  leave the catalogue partially wiped. Take a backup first.
- **Payments** are documented separately in [PAYMENTS.md](PAYMENTS.md). Stripe,
  PayPal, and Klarna ship in core; `bank-transfer` and `cod` remain available
  with no configuration. All three providers use **hosted checkout**, so card
  data never reaches this server and a self-hosted install stays outside PCI
  scope. Session creation has not been round-tripped against the providers' live
  sandboxes — run yours there before taking real money.
- Refunds **can** be initiated from the admin (`POST /api/orders/{id}/refund`,
  admin-only, partial amounts supported) as well as recognised from a provider
  webhook. See PAYMENTS.md.

## Paid vertical modules

A general-purpose CMS cannot express a lens prescription, and an eyewear shop
cannot trade without one. Core's answer is a **seam**, not an implementation:
the optical module is a paid plugin and **is not in this repository**, and an
install without it behaves like one that never had it.

### What core does

- **Stores the flags.** `requires_prescription: true` with
  `prescription_type: 'spectacles' | 'contacts'` on a product, from the product
  editor or the API.
- **Stores the prescription and can render one.** The `Prescription` type and
  `summarisePrescription()` live in `src/core/models.ts` deliberately: the admin
  must still display an Rx that a past order carries on an install where the
  module has been removed. That formats data; it decides nothing clinical.
  Values are integers for the same reason money is — powers in hundredths
  (`SPH -2.25` is `-225`, so a grid check is `value % 25 === 0` rather than a
  float comparison that is wrong about `0.1 + 0.2`), PD in tenths of a
  millimetre (`630` = 63.0 mm).
- **Offers two filters.** `order_line_extras` runs per line at checkout,
  **before** any stock is reserved, and a module returning `ok: false` refuses
  the line with its own code and message — so a refusal never holds a lens out
  of stock for an order that was never going to ship. `commerce_schema` is what
  publishes a form's rules.
- **Serves the schema routes.**
  `GET /api/commerce/prescription-schema?type=spectacles|contacts` and
  `GET /api/commerce/frame-schema` are public and unauthenticated so a headless
  storefront can render and pre-validate a form. Both answer **404** when no
  active plugin serves `commerce_schema` — publishing clinical rules that
  checkout will not enforce advertises a capability that does not exist.
- **Lets staff delete one prescription.**
  `DELETE /api/orders/{id}/prescription?line=<n>`, admin-only and audited. A
  prescription is Article 9 health data that a data-subject erasure deliberately
  **retains**, because an optician has a professional obligation to keep it. A
  retention obligation is not forever, so removal is one person, one record, one
  decision — there is no bulk endpoint.

### What core does not do

- **It does not enforce.** With no module serving `order_line_extras`, the
  initial value passes straight through: `requires_prescription` is a stored
  flag that nobody checks, checkout accepts the line, and whatever Rx was sent
  is kept as plain data rather than validated, corrected or rejected. That
  degradation is the required one — an install that removes the module must not
  start 500ing on a field it no longer understands.
- **It does not know what a dioptre is.** Which powers are on the grid, whether
  an axis is required, whether both eyes must be present, what a lab will
  reject: those are the module's rules, and core asks one generic question and
  knows nothing about the answer.

These two seams are not optical-specific. Any vertical with line rules and a
form to publish uses the same pair.
