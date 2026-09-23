/**
 * Local risk signals on an order (roadmap row 28).
 *
 * The same shape and the same honesty as `lib/spam-score.ts`, which this
 * follows deliberately rather than inventing a second scoring mechanism.
 *
 * ## Why local, and what that costs
 *
 * A fraud service works by sending the order — the buyer's name, address,
 * email, IP and basket — to a third party. On a self-hosted CMS whose selling
 * point is that the operator's data stays theirs, that is a disclosure the
 * operator would have to make in their own privacy notice, for signals they can
 * get most of locally. So this is local, weaker, and says so.
 *
 * ## Nothing is ever rejected on this
 *
 * A flagged order is PLACED and FLAGGED, never refused. The signals below are
 * structural correlations, not evidence: an unusually large order from a new
 * email is what a fraudster does and also what a delighted customer does.
 * Refusing means the best order of the month is the one that silently vanished
 * and the buyer is told nothing. Holding costs the operator a glance at a list.
 *
 * ## No raw IP, ever
 *
 * `ConsentReceipt` deliberately stores no IP at all, and storing one on an
 * order would make the order record less careful than the consent record in the
 * same database. What is stored is an HMAC — equality-comparable, so "three
 * orders from one address in ten minutes" still works, and not reversible into
 * an address. Absent means UNKNOWN, never "no match".
 */
import crypto from 'node:crypto';
import type { Order } from '../../core/models';

/** Over this, an order is flagged for a human to look at. */
export const RISK_THRESHOLD = 5;

export interface RiskSignal {
  code: string;
  points: number;
  /** A sentence an operator can act on, not a code they must look up. */
  detail: string;
}

export interface RiskVerdict {
  score: number;
  flagged: boolean;
  signals: RiskSignal[];
  reasons: string[];
}

/**
 * Hash an IP so orders can be COMPARED without the address being stored.
 *
 * Keyed with the install's own AUTH_SECRET, so hashes are not comparable across
 * installs and a stolen database does not become a rainbow-table exercise
 * against the (very small) IPv4 space. Returns undefined rather than a
 * placeholder when there is no secret or no address — absent must mean unknown.
 */
export function hashIp(ip: string | undefined, secret: string | undefined): string | undefined {
  const addr = String(ip ?? '').trim();
  const key = String(secret ?? '');
  if (!addr || key.length < 16) return undefined;
  return crypto.createHmac('sha256', key).update(addr).digest('hex').slice(0, 32);
}

export interface RiskInput {
  order: Pick<Order, 'total_cents' | 'email' | 'name' | 'phone'> & {
    items?: { qty?: number }[];
    shipping_address?: { country?: string; postcode?: string; line1?: string } | undefined;
    billing_address?: { country?: string } | undefined;
    shipping_country?: string;
  };
  /** Hash of this order's IP, if known. */
  ipHash?: string;
  /** Previous orders, for the comparisons that need history. */
  history?: {
    email: string;
    ip_hash?: string;
    total_cents: number;
    created_at: string;
    status?: string;
  }[];
  /** The shop's own country, for the "ships somewhere else" signal. */
  originCountry?: string;
  nowMs?: number;
}

/**
 * Score one order.
 *
 * PURE: no storage, no clock unless injected, no network. Every signal is
 * structural — countable without knowing the language, which is the same reason
 * the spam scorer has no phrase dictionary. Both live shops write Greek.
 */
export function scoreOrder(input: RiskInput): RiskVerdict {
  const { order } = input;
  const now = input.nowMs ?? Date.now();
  const signals: RiskSignal[] = [];
  const add = (code: string, points: number, detail: string) => signals.push({ code, points, detail });

  const history = input.history ?? [];
  const email = String(order.email ?? '').toLowerCase();

  /* --- velocity: the same buyer, repeatedly, in minutes --- */
  const recentByEmail = history.filter(
    (h) => h.email?.toLowerCase() === email && now - Date.parse(h.created_at) < 30 * 60_000,
  );
  if (recentByEmail.length >= 3) {
    add('velocity_email', 3, `${recentByEmail.length} orders from this email in the last 30 minutes`);
  }

  if (input.ipHash) {
    const recentByIp = history.filter(
      (h) => h.ip_hash && h.ip_hash === input.ipHash && now - Date.parse(h.created_at) < 30 * 60_000,
    );
    if (recentByIp.length >= 3) {
      add('velocity_ip', 3, `${recentByIp.length} orders from the same network in the last 30 minutes`);
    }
    // Several DIFFERENT emails from one address is a stronger signal than
    // several orders from one person, who may simply have made a mistake.
    const emailsFromIp = new Set(
      history.filter((h) => h.ip_hash === input.ipHash).map((h) => h.email?.toLowerCase()),
    );
    emailsFromIp.delete(email);
    if (emailsFromIp.size >= 3) {
      add('many_emails_one_ip', 3, `${emailsFromIp.size + 1} different emails from the same network`);
    }
  }

  /* --- value, relative to this shop rather than to an absolute --- */
  const past = history.filter((h) => h.status !== 'cancelled').map((h) => h.total_cents);
  if (past.length >= 5) {
    const mean = past.reduce((s, n) => s + n, 0) / past.length;
    if (mean > 0 && order.total_cents > mean * 5) {
      // Relative, because "large" means nothing without the shop's own scale:
      // €800 is routine for spectacles and extraordinary for a card shop.
      add('unusual_value', 2, `Order is ${Math.round(order.total_cents / mean)}x this shop's average`);
    }
  }

  /* --- addresses that do not agree --- */
  const ship = order.shipping_address?.country ?? order.shipping_country;
  const bill = order.billing_address?.country;
  if (ship && bill && ship !== bill) {
    add('country_mismatch', 2, `Delivery to ${ship} but billed to ${bill}`);
  }
  if (input.originCountry && ship && ship !== input.originCountry) {
    // One point, not three: a foreign sale is ordinary, it is only context.
    add('foreign_destination', 1, `Ships to ${ship}, outside the shop's own country`);
  }

  /* --- first order, and a big one --- */
  const seenBefore = history.some((h) => h.email?.toLowerCase() === email);
  if (!seenBefore && past.length >= 5) {
    const mean = past.reduce((s, n) => s + n, 0) / past.length;
    if (mean > 0 && order.total_cents > mean * 3) {
      add('first_order_large', 2, 'First order from this email, and well above average');
    }
  }

  /* --- the basket itself --- */
  const units = (order.items ?? []).reduce((s, i) => s + (Number(i.qty) || 0), 0);
  if (units >= 20) {
    add('bulk_quantity', 2, `${units} units in one order`);
  }

  /* --- missing contact detail on a delivered order --- */
  if (!order.phone && order.shipping_address?.line1) {
    // A courier that cannot call is a failed delivery, which is a cost even
    // when the order is entirely genuine — so this is operational as much as
    // it is risk.
    add('no_phone', 1, 'No phone number, and a courier usually calls before delivery');
  }

  const score = signals.reduce((s, x) => s + x.points, 0);
  return {
    score,
    flagged: score >= RISK_THRESHOLD,
    signals,
    reasons: signals.map((s) => s.detail),
  };
}

/**
 * The fields to store, and ONLY when flagged.
 *
 * An ordinary order carries no risk fields at all — the same discipline
 * `spamFields()` uses, so the common record does not grow a column of zeroes
 * and "flagged" stays visible as an exception rather than a default.
 */
export function riskFields(verdict: RiskVerdict, ipHash?: string): Partial<Order> {
  const out: Partial<Order> = {};
  if (ipHash) out.ip_hash = ipHash;
  if (!verdict.flagged) return out;
  out.risk_score = verdict.score;
  out.risk_flagged = true;
  out.risk_reasons = verdict.reasons;
  out.risk_signals = verdict.signals.map((s) => s.code);
  return out;
}
