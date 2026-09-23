/**
 * How long an unpaid order may hold stock, and how many one buyer may hold.
 *
 * ## The hoarding problem
 *
 * Checkout reserves stock the moment an order is placed, so two buyers cannot
 * take the last unit. That guarantee is also a lever: POST /api/orders is
 * public and anonymous, and every order it accepts takes units off the shelf
 * until it is paid or cancelled. The day-based abandonment sweep
 * (abandonment.ts) cancels an unpaid order after 1–90 days, 3 by default —
 * fine for a bank transfer, which takes days to clear, and absurd for a card,
 * which takes seconds. One script could empty a catalogue for three days.
 *
 * Two controls, both settings, both conservative:
 *
 *  - THE PAYMENT HOLD. An order whose payment method is an ONLINE provider
 *    (Stripe, PayPal, Klarna — whatever the payment registry lists, never a
 *    hard-coded set) is cancelled by the hold sweep once it has gone
 *    `orders_payment_hold_minutes` unpaid (default 120; 0 = off). Manual
 *    methods — bank transfer, cash on delivery — keep the day-based sweep.
 *
 *  - THE UNPAID CAP. A buyer may have at most `orders_max_unpaid_per_buyer`
 *    open unpaid orders (default 5; 0 = off), counted twice: by normalised
 *    email, and separately by the hashed client address order-risk already
 *    stores. The sixth is refused with 429 `checkout.too_many_unpaid`.
 *
 * ## Consistent with the provider's own session
 *
 * The hold is only honest if the provider stops taking money when it ends. A
 * buyer paying on a page the shop has already given up on is how a paid order
 * ends up without stock (payments/service.ts handles that case, but it should
 * be rare, not routine). So:
 *
 *  - Stripe: the Checkout Session is created with `expires_at` at the end of
 *    the hold, clamped to Stripe's window — "anywhere from 30 minutes to 24
 *    hours after Checkout Session creation" (Stripe API reference). That is
 *    also why the hold itself is clamped to 30 min – 24 h.
 *  - PayPal: an Orders v2 order stays payable for 3 hours after creation
 *    (PayPal's documented default; only PayPal can extend it) and the create
 *    call has no expiry parameter. A hold shorter than 3 h can therefore be
 *    outlived by the PayPal page.
 *  - Klarna HPP: the payment session lives 48 h and the hosted page closes an
 *    hour before it; the create call has no expiry parameter either.
 *
 * Where the session's own expiry is known it is stored on the order
 * (`payment_expires_at`) and the sweep waits for it, plus a grace for the
 * provider's last webhook. Where it is not, a payment that arrives after the
 * hold re-reserves the stock or flags the order for a refund.
 *
 * Pure: no storage, no clock unless passed, no registry import — the caller
 * hands in the provider ids — so every rule is testable on its own.
 */
import type { Order } from '../../core/models';
import { settingBool, settingInt } from '../settings-map';
import { RISK_THRESHOLD } from './order-risk';

/** Settings keys, exported so the admin form and the reader cannot drift. */
export const PAYMENT_HOLD_KEYS = {
  holdMinutes: 'orders_payment_hold_minutes',
  maxUnpaidPerBuyer: 'orders_max_unpaid_per_buyer',
  riskHoldEnabled: 'orders_risk_hold_enabled',
  riskHoldScore: 'orders_risk_hold_score',
} as const;

/** Two hours: long enough to find a card and pass 3-D Secure twice. */
export const DEFAULT_HOLD_MINUTES = 120;
/** Stripe will not create a Checkout Session that expires sooner. */
export const MIN_HOLD_MINUTES = 30;
/** Nor one that lasts longer. */
export const MAX_HOLD_MINUTES = 24 * 60;

/** Five open unpaid orders is more than any real buyer has. */
export const DEFAULT_MAX_UNPAID = 5;
export const MAX_MAX_UNPAID = 1000;

/**
 * Time the provider's last webhook gets after its session closed, before the
 * sweep acts on its own. A success confirmed at the last second is delivered
 * a moment later, and cancelling in that moment would be cancelling a sale.
 */
export const HOLD_GRACE_MS = 5 * 60_000;

/**
 * How long the checkout velocity and unpaid-cap reads look back when the
 * abandonment window is shorter — risk velocity looks at 30 minutes.
 */
export const VELOCITY_WINDOW_MS = 30 * 60_000;

export interface PaymentHoldSettings {
  /** 0 = off. Otherwise within MIN..MAX_HOLD_MINUTES. */
  holdMinutes: number;
  /** 0 = off. */
  maxUnpaidPerBuyer: number;
  /** The opt-in "hold, don't just flag" switch for risky orders (S4.15). */
  riskHold: { enabled: boolean; score: number };
}

export function resolvePaymentHoldSettings(
  settings: Record<string, unknown> | null | undefined,
): PaymentHoldSettings {
  const map = settings ?? {};
  const rawHold = settingInt(map[PAYMENT_HOLD_KEYS.holdMinutes], DEFAULT_HOLD_MINUTES);
  const rawCap = settingInt(map[PAYMENT_HOLD_KEYS.maxUnpaidPerBuyer], DEFAULT_MAX_UNPAID);
  return {
    // Zero or below is OFF — the conventional "no limit" spelling — rather
    // than clamped up to a minimum the operator did not ask for.
    holdMinutes: rawHold <= 0 ? 0 : Math.min(MAX_HOLD_MINUTES, Math.max(MIN_HOLD_MINUTES, rawHold)),
    maxUnpaidPerBuyer: rawCap <= 0 ? 0 : Math.min(MAX_MAX_UNPAID, rawCap),
    riskHold: {
      // OFF by default. Holding an order changes what a live storefront is
      // told (status "on-hold"), so it is the operator's decision to make.
      enabled: settingBool(map[PAYMENT_HOLD_KEYS.riskHoldEnabled], false),
      score: settingInt(map[PAYMENT_HOLD_KEYS.riskHoldScore], RISK_THRESHOLD, { min: 1, max: 100 }),
    },
  };
}

type PaymentFields = Pick<Order, 'payment_method' | 'payment_provider'>;

/**
 * Is this order paid through an online provider?
 *
 * The provider ids come from the payment registry (`allProviders()`), so a
 * provider added by a plugin is online without anyone editing a list here.
 * An order sent to a provider after checkout (payment_provider set) counts
 * too: its money is now coming through that provider's page.
 */
export function isOnlinePayment(order: PaymentFields, providerIds: readonly string[]): boolean {
  const method = String(order.payment_method ?? '');
  const provider = String(order.payment_provider ?? '');
  return (method !== '' && providerIds.includes(method))
    || (provider !== '' && providerIds.includes(provider));
}

/**
 * Open, unpaid, and holding stock — what the cap counts and the sweeps cancel.
 *
 * `pending`, or `on-hold` when the RISK hold put it there (a human hold is a
 * human decision and is left alone). Paid and refunded orders never count.
 */
export function isUnpaidOpen(
  order: Pick<Order, 'status' | 'payment_status'> & { risk_held?: boolean },
): boolean {
  const payment = order.payment_status ?? 'unpaid';
  if (payment === 'paid' || payment === 'refunded') return false;
  return order.status === 'pending' || (order.status === 'on-hold' && order.risk_held === true);
}

/**
 * When the hold clock started for this order.
 *
 * An order placed WITH an online method: when it was placed. Starting a
 * payment again does not move it — otherwise anyone holding an order number
 * and its email could keep its stock reserved forever by re-opening the page.
 *
 * An order placed with a MANUAL method and later sent to a provider (the buyer
 * chose to pay by card after all): when its first payment was started
 * (`payment_started_at`, written once). Measured from `created_at` it would
 * be over already, and the sweep would cancel the order while the buyer sat
 * on the provider's page. The day-based abandonment sweep still bounds it.
 */
export function holdStartMs(
  order: Pick<Order, 'created_at' | 'payment_method'> & { payment_started_at?: string },
  providerIds: readonly string[],
): number | null {
  const created = Date.parse(order.created_at ?? '');
  if (!Number.isFinite(created)) return null;
  const placedOnline = providerIds.includes(String(order.payment_method ?? ''));
  if (placedOnline) return created;
  const started = Date.parse(order.payment_started_at ?? '');
  return Number.isFinite(started) ? Math.max(created, started) : created;
}

/** Epoch ms after which the hold sweep may cancel this order, or null when it never may. */
export function holdDeadlineMs(
  order: Pick<Order, 'created_at' | 'payment_method'>
    & { payment_expires_at?: string; payment_started_at?: string; payment_capture_started_at?: string },
  holdMinutes: number,
  providerIds: readonly string[],
): number | null {
  if (holdMinutes <= 0) return null;
  const start = holdStartMs(order, providerIds);
  if (start === null) return null;
  let deadline = start + holdMinutes * 60_000;
  // The provider's page is still open: wait for it to close.
  const session = Date.parse(order.payment_expires_at ?? '');
  if (Number.isFinite(session)) deadline = Math.max(deadline, session + HOLD_GRACE_MS);
  // A capture is in progress (payments/service.ts): money is being taken for
  // this order right now. Cancelling it in the middle would release stock the
  // buyer is paying for.
  const capture = Date.parse(order.payment_capture_started_at ?? '');
  if (Number.isFinite(capture)) deadline = Math.max(deadline, capture + HOLD_GRACE_MS);
  return deadline;
}

export type HoldSkipReason = 'off' | 'not-online' | 'closed-or-paid' | 'imported' | 'no-date' | 'not-yet';

export type HoldDecision = { expire: true } | { expire: false; reason: HoldSkipReason };

type HoldOrder = Pick<Order, 'status' | 'payment_status' | 'payment_method' | 'payment_provider' | 'created_at'>
  & {
    payment_expires_at?: string; payment_started_at?: string; payment_capture_started_at?: string;
    risk_held?: boolean; wp_id?: unknown;
  };

/**
 * Should the hold sweep cancel this order now?
 *
 * Asked twice by the sweep: once on its list, and again on the order as it is
 * at the moment of the write (setOrderStatus's `when`), because a payment can
 * land in between.
 */
export function shouldExpireHold(
  order: HoldOrder,
  settings: Pick<PaymentHoldSettings, 'holdMinutes'>,
  providerIds: readonly string[],
  nowMs: number,
): HoldDecision {
  if (settings.holdMinutes <= 0) return { expire: false, reason: 'off' };
  // Never an imported order: no stock was held for it here — see abandonment.ts.
  if (typeof order.wp_id === 'string' && order.wp_id !== '') return { expire: false, reason: 'imported' };
  if (!isOnlinePayment(order, providerIds)) return { expire: false, reason: 'not-online' };
  if (!isUnpaidOpen(order)) return { expire: false, reason: 'closed-or-paid' };
  const deadline = holdDeadlineMs(order, settings.holdMinutes, providerIds);
  if (deadline === null) return { expire: false, reason: 'no-date' };
  if (nowMs < deadline) return { expire: false, reason: 'not-yet' };
  return { expire: true };
}

export function selectExpiredHolds<T extends HoldOrder>(
  orders: readonly T[],
  settings: Pick<PaymentHoldSettings, 'holdMinutes'>,
  providerIds: readonly string[],
  nowMs: number,
): T[] {
  return orders.filter((o) => shouldExpireHold(o, settings, providerIds, nowMs).expire);
}

/**
 * Stripe's `expires_at` (epoch SECONDS) for a session opened at `nowMs` that
 * should close when the hold does.
 *
 * Clamped into Stripe's window with a minute's margin at each end: Stripe
 * measures from ITS clock at creation, and a request that lands a few seconds
 * late must not be refused for asking for 29 min 58 s.
 */
export function stripeSessionExpiry(holdUntilMs: number, nowMs: number): number {
  const min = nowMs + MIN_HOLD_MINUTES * 60_000 + 60_000;
  const max = nowMs + MAX_HOLD_MINUTES * 60_000 - 60_000;
  return Math.floor(Math.min(max, Math.max(min, holdUntilMs)) / 1000);
}

/**
 * How far back the PER-ADDRESS count looks: the payment hold, at least an
 * hour, two hours when the hold is off.
 *
 * Shorter than the per-email window on purpose. One address is often many
 * people — an office, and above all a mobile carrier's NAT, which is how a
 * large share of Greek shoppers reach the internet — so over days an address
 * collects unrelated buyers' unpaid bank transfers. Over a couple of hours,
 * five open orders from one address is a script.
 */
export function ipWindowMs(holdMinutes: number): number {
  const minutes = holdMinutes > 0 ? Math.max(60, holdMinutes) : DEFAULT_HOLD_MINUTES;
  return minutes * 60_000;
}

/**
 * Is this a shopper's own address, rather than a proxy's or a container's?
 *
 * The per-address controls (the unpaid cap, the webhook throttle) only mean
 * something when the address is the client's. Behind a reverse proxy that is
 * not trusted (`TRUST_PROXY` unset) every request arrives from the proxy —
 * loopback — and in a container from the bridge — a private address. Counting
 * those would treat the whole shop as one buyer: the sixth open bank transfer
 * of the week would refuse everybody, and twenty forged webhooks would shut
 * out the real provider. So loopback, private, link-local, unspecified and
 * unknown addresses are simply not counted; the per-email cap still applies.
 *
 * Accepts an IPv6 prefix with a length (`2001:db8::/64`), the form a grouped
 * per-network key takes, and IPv4-mapped IPv6.
 */
export function isRoutableClientIp(ip: unknown): boolean {
  let s = String(ip ?? '').trim().toLowerCase();
  if (!s || s === 'unknown') return false;
  if (s.startsWith('[')) s = s.slice(1, s.includes(']') ? s.indexOf(']') : undefined);
  s = s.replace(/\/\d{1,3}$/, '');
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (mapped) s = mapped[1];
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(s)) {
    const [a, b] = s.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 169 && b === 254) return false;
    return true;
  }
  if (s.includes(':')) {
    if (s === '::' || s === '::1') return false;
    if (/^f[cd][0-9a-f]{0,2}:/.test(s)) return false; // fc00::/7, unique local
    if (/^fe[89ab][0-9a-f]?:/.test(s)) return false; // fe80::/10, link-local
    return true;
  }
  return false;
}

/** The shape the unpaid cap reads — a subset of an order. */
export interface CapHistoryRow {
  email?: string;
  ip_hash?: string;
  status?: string;
  payment_status?: string;
  created_at: string;
  risk_held?: boolean;
}

/** An email as the cap compares it. */
export function normaliseBuyerEmail(email: unknown): string {
  return String(email ?? '').trim().toLowerCase();
}

/**
 * How many open unpaid orders this buyer already has: by email among orders
 * created at or after `since.email`, and by hashed address among those created
 * at or after `since.ip` (see ipWindowMs for why that window is shorter).
 *
 * Counted separately on purpose: one person with several addresses and one
 * address with several people are both what a hoarding script looks like,
 * and a combined count would let either hide behind the other.
 */
export function countUnpaidForBuyer(
  history: readonly CapHistoryRow[],
  buyer: { email?: string; ipHash?: string },
  since: { email: number; ip: number },
): { byEmail: number; byIp: number } {
  const email = normaliseBuyerEmail(buyer.email);
  let byEmail = 0;
  let byIp = 0;
  for (const o of history) {
    const created = Date.parse(o.created_at ?? '');
    if (!Number.isFinite(created)) continue;
    if (!isUnpaidOpen(o as never)) continue;
    if (email && created >= since.email && normaliseBuyerEmail(o.email) === email) byEmail += 1;
    if (buyer.ipHash && created >= since.ip && o.ip_hash === buyer.ipHash) byIp += 1;
  }
  return { byEmail, byIp };
}
