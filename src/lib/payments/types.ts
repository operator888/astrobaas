/**
 * Payment provider contract.
 *
 * ## The rules every provider must obey
 *
 * 1. **AstroBaaS never touches card data.** Every provider here uses *hosted*
 *    checkout or client-side tokenisation: we create a session server-side and
 *    hand the buyer a redirect URL. No PAN, CVV, or IBAN ever enters this
 *    process, so this code stays outside PCI-DSS scope. A provider that wants
 *    raw card fields does not belong in this directory.
 *
 * 2. **Credentials come from the environment, never from settings.** The
 *    settings table is a schemaless bucket with a public read path
 *    (`settings-visibility.ts`), so a secret stored there is one config mistake
 *    away from being world-readable. `requiredEnv` is the only channel.
 *
 * 3. **The amount is ours, not the client's.** A session is created from a
 *    stored order whose total was computed server-side. Nothing a browser sends
 *    influences what is charged.
 *
 * 4. **A webhook is untrusted input until its signature verifies.** Anyone can
 *    POST "payment succeeded" to a public URL. Verification is mandatory and
 *    has no bypass flag — a kill switch for signature checking is exactly the
 *    kind of thing that ends up enabled in production.
 *
 * 5. **Verify the amount again on the way back in.** A verified event still has
 *    to match the order's currency and total before it can mark anything paid.
 *    Signature validity proves the message came from the provider; it does not
 *    prove it is about the order you think it is, at the price you expect.
 *
 * 6. **Delivery is at-least-once.** Providers retry. Applying the same event
 *    twice must be a no-op, so capture is keyed on the provider's event id.
 */

import type { Order, PaymentStatus } from '../../core/models';

/**
 * Lifecycle of the money, tracked separately from the order's fulfilment
 * status. Defined on the Order model (so it has no import cycle with this
 * layer) and re-exported here, where consumers of the payments API look for it.
 *
 *   unpaid    no payment attempted (bank transfer, cash on delivery)
 *   pending   session created, buyer sent to the provider, outcome unknown
 *   paid      provider confirmed funds — the only status that may release goods
 *   failed    the session ended unpaid: expired, abandoned, or an async
 *             payment failed (a single declined card is NOT this — see
 *             PaymentOutcome)
 *   refunded  money returned
 */
export type { PaymentStatus };

export const PAYMENT_STATUSES: readonly PaymentStatus[] = [
  'unpaid', 'pending', 'paid', 'failed', 'refunded',
] as const;

/**
 * What a verified webhook resolved to, in provider-neutral terms.
 *
 * `declined` is ONE attempt the provider refused while its payment page stays
 * open — a card declined on Stripe Checkout, after which the buyer can try
 * another card. It is not the end of the order and must not be mapped to
 * `failed`, which cancels the order and hands its stock back: a card-testing
 * run would otherwise churn the stock of every order it touched. `failed` is
 * for the session itself ending unpaid (expired, abandoned, async failure).
 */
export type PaymentOutcome = 'paid' | 'failed' | 'declined' | 'approved' | 'refunded' | 'ignored';
/*
 * `approved` is the buyer saying yes on the provider's page with NO money
 * moved yet — PayPal's Orders v2 with `intent: CAPTURE`, where the merchant
 * must then capture. It is never a reason to ship: the payment layer captures
 * it (PaymentProvider.captureApproved) if, and only if, the order can still
 * be fulfilled, and applies what the CAPTURE says.
 */

/** Injected so providers are testable without network or clock access. */
export interface ProviderContext {
  /** HTTP transport. Injectable: tests pass a stub, production passes fetch. */
  fetch: typeof globalThis.fetch;
  /** Current epoch ms. Injectable so replay-window tests are deterministic. */
  now: () => number;
  /** Absolute base URL of this AstroBaaS install, for return/webhook URLs. */
  siteUrl: string;
  /** Read a required credential. Throws if absent — never returns a default. */
  env: (name: string) => string;
  /**
   * Epoch ms at which this install stops holding the order's stock for an
   * unpaid online payment (commerce/payment-hold.ts), when a hold applies.
   *
   * A provider that can make its hosted page close then SHOULD (Stripe:
   * `expires_at`), so the buyer cannot pay for an order the shop has already
   * cancelled. Optional and advisory: absent means no hold, and a provider
   * that cannot honour it simply ignores it.
   */
  holdUntil?: number;
}

/** Result of opening a hosted-checkout session. */
export interface PaymentSession {
  /** Provider's id for this session/intent. Stored on the order. */
  reference: string;
  /** Where to send the buyer. */
  redirectUrl: string;
  /**
   * When the provider stops taking payment on this session (ISO 8601), if the
   * provider says. Stored on the order so the hold sweep does not cancel an
   * order whose payment page is still open.
   */
  expiresAt?: string;
}

/**
 * A webhook that passed signature verification, normalised.
 *
 * `amountCents`/`currency` are what the PROVIDER says was paid. The caller must
 * compare them against the stored order before acting — see rule 5.
 */
export interface VerifiedEvent {
  /** Provider's event id. Used as the idempotency key. */
  eventId: string;
  /** The session/intent reference this event concerns. */
  reference: string;
  outcome: PaymentOutcome;
  /** Amount the provider reports, in minor units. Null when not applicable. */
  amountCents: number | null;
  /** ISO-4217, upper-case. Null when not applicable. */
  currency: string | null;
  /** Raw provider event type, for the audit log. */
  rawType: string;
  /**
   * The provider's OWN id for the thing this event is about (PayPal's order
   * id), when acting on the event needs it — capturing an approval does.
   * `reference` stays our order id.
   */
  providerReference?: string;
}

/** Outcome of asking a provider to send money back. */
export interface RefundResult {
  /** Provider's refund id, recorded on the order for the audit trail. */
  refundId: string;
  /** What the provider says it actually refunded, in minor units. */
  amountCents: number;
}

export interface PaymentProvider {
  /** Stable id. Persisted on orders, so renaming one is a migration. */
  readonly id: string;
  /** Human label for the admin and the storefront. */
  readonly label: string;
  /**
   * Env vars that must be present and non-empty for this provider to be
   * usable. Absence disables the provider — it is never a runtime surprise
   * mid-checkout.
   */
  readonly requiredEnv: readonly string[];
  /**
   * Optional deeper check on credentials that ARE set but cannot work.
   *
   * `requiredEnv` answers "is it there?", which is all most providers need. It
   * cannot answer "is it usable?" — and a value that is present and wrong puts
   * the provider in exactly the state the two-condition enablement exists to
   * prevent: offered at checkout, failing at the till, after stock is reserved.
   *
   * A gateway addressed by a checksummed identifier is the clear case. A Greek
   * ΑΦΜ with one digit mistyped is a well-formed string that is not a VAT
   * number, and the first time anyone finds out is when a buyer cannot pay.
   *
   * Returns human-readable problems; an empty array means usable. Anything
   * returned here is rendered in the admin and served to staff over the API, so
   * it must name VARIABLES and describe faults — never echo a value. Reporting
   * a problem disables the provider, the same as a missing variable does.
   */
  validateEnv?(env: Record<string, string | undefined>): string[];
  /** Open a hosted-checkout session for an order. */
  createSession(order: Order, ctx: ProviderContext): Promise<PaymentSession>;
  /**
   * Verify and normalise an inbound webhook.
   *
   * MUST throw on any verification failure. Returning an 'ignored' outcome is
   * for events that verified fine but are irrelevant (e.g. a provider's
   * bookkeeping notifications) — never for events that failed to verify.
   *
   * A provider in THIS repository throws `WebhookVerificationError`. One that
   * ships as a separate package cannot import that class, so it throws its own
   * error class named `<Something>VerificationError` — see
   * `isWebhookVerificationError`. Getting that name wrong does not make an
   * event trusted; it makes a forgery answered 500 and retried instead of 401
   * and recorded.
   */
  verifyWebhook(
    rawBody: string,
    headers: Headers,
    ctx: ProviderContext,
  ): Promise<VerifiedEvent>;

  /**
   * Send money back.
   *
   * Optional: a provider without it cannot be refunded from the admin, and the
   * UI says so rather than offering a button that fails.
   *
   * `amountCents` is always explicit — there is no "refund everything" mode,
   * because the caller has already bounded it against what the order charged
   * minus what was already returned. A provider must not infer the amount from
   * its own records; that is how a partial refund silently becomes a full one.
   *
   * `idempotencyKey` comes from the caller and must be passed to the provider.
   * A double-clicked button, or a retry after a timeout that actually
   * succeeded, must not send the money twice.
   */
  refund?(
    order: Order,
    amountCents: number,
    idempotencyKey: string,
    ctx: ProviderContext,
  ): Promise<RefundResult>;

  /**
   * Turn an `approved` event into money: capture it.
   *
   * Required for any provider whose `verifyWebhook` can return `approved`.
   * Called by the payment layer only once the order has been judged able to
   * ship (payments/service.ts), never from `verifyWebhook` itself — the
   * provider cannot see stock.
   *
   * Returns the event the CAPTURE produced, with the outcome and amount taken
   * from the provider's capture response, so the ordinary amount check still
   * applies: `paid`, `declined` when the provider definitively refused, or
   * `ignored` when the money is not there yet. MUST throw on a transient
   * failure (network, 5xx) so the webhook is answered 500 and redelivered.
   * MUST be idempotent across calls for the same approval.
   */
  captureApproved?(event: VerifiedEvent, ctx: ProviderContext): Promise<VerifiedEvent>;
}

/** Thrown when a webhook cannot be trusted. Always answered with 401. */
export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookVerificationError';
  }
}

/**
 * Is this throw a verification failure (401) or a processing failure (500)?
 *
 * The distinction is not cosmetic. A processing failure must be 500 so the
 * provider retries and a real confirmation is not dropped; a forged event must
 * be 401 so it is recorded as a security event and not retried at all.
 *
 * `instanceof` alone cannot answer it. A provider that ships as a separate
 * PACKAGE — which is the whole point of `PLUGIN_HOOKS.PAYMENT_PROVIDERS` —
 * imports nothing from this repository, so it cannot construct an instance of
 * the class above. Its rejections were therefore landing in the 500 branch:
 * still refused, and still not applied, but answered as "our fault, please
 * retry", logged with a stack trace on every probe, and counted by the PSP
 * against the endpoint's health.
 *
 * So the contract for an out-of-repo provider is the error's NAME: any Error
 * whose `name` ends in `VerificationError` thrown from `verifyWebhook` is a
 * verification failure. That is the convention such a class already follows,
 * and `verifyWebhook` is documented as throwing only for that reason.
 */
export function isWebhookVerificationError(err: unknown): boolean {
  if (err instanceof WebhookVerificationError) return true;
  const name = (err as { name?: unknown } | null | undefined)?.name;
  return typeof name === 'string' && name.endsWith('VerificationError');
}
