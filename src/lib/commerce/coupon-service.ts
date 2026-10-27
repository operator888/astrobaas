/**
 * Coupons with storage: issuing a code for a plugin, asking about one,
 * revoking one, and the per-buyer key redemptions are counted under.
 *
 * The maths and the validation stay pure in `coupons.ts`; this module is the
 * thin layer that needs the database and a random source. It is what
 * `host.coupons` (src/lib/plugin-platform/coupons.ts) hands to plugins, so a
 * game, a referral scheme or a loyalty plugin issues a code through exactly
 * the rules an admin's coupon is checked by — `normalizeCoupon` and
 * `checkCouponRecord` — and never writes a coupon row of its own.
 *
 * ## The redemption rule (cancellation)
 *
 * A use is COUNTED when the order is placed (`claimCouponUse`, atomic on every
 * driver). It is HANDED BACK only when the order is cancelled BEFORE it was
 * paid — the buyer never got the discount, so a one-use code they never
 * really used must work again. A cancellation after payment, and a refund,
 * keep the use: the discount was had. Reopening a cancelled order counts it
 * again, without a limit check, because the order exists with the discount
 * whatever has happened to the code since. See `setOrderStatus`.
 */

import { createHash, randomInt } from 'node:crypto';
import { LocalDB } from '../localdb';
import type { Coupon, CouponKind } from './coupons';
import { normalizeCouponCode, normalizeCouponEmail } from './coupons';
import { normalizeCoupon, checkCouponRecord } from './admin-normalize';
import { isValidPluginId } from '../plugin-platform/store';
import { resolvePurchasable } from './variants';

/**
 * The key a buyer's redemptions are counted under, and the `email_hash` the
 * `coupon.redeemed` webhook carries: SHA-256 (hex) of the trimmed,
 * lower-cased address. A receiver that knows an address can match it; the
 * address itself is never stored on the coupon or sent.
 */
export function couponEmailKey(email: unknown): string | null {
  const e = normalizeCouponEmail(email);
  return e ? createHash('sha256').update(e).digest('hex') : null;
}

/**
 * Crockford's base-32 without I, L, O and U: nothing a customer can misread
 * when typing it from an email (0/O, 1/I/L), and no accidental words.
 */
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** 12 symbols × 5 bits = 60 bits: unguessable at any rate a quote endpoint allows. */
export const ISSUED_CODE_LENGTH = 12;

/** A fresh random code body, `ISSUED_CODE_LENGTH` symbols from CODE_ALPHABET. */
export function randomCouponCode(): string {
  let out = '';
  for (let i = 0; i < ISSUED_CODE_LENGTH; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}

/** What `host.coupons.issue` accepts. Field names are the plugin contract's. */
export interface IssueCouponInput {
  type: CouponKind;
  /** Basis points for `percent` (1000 = 10%), minor units for `fixed`. Ignored by the other types. */
  value?: number;
  gift_product_id?: string;
  conditions?: { min_subtotal_cents?: number; categories?: string[]; brands?: string[] };
  email?: string;
  single_use?: boolean;
  max_redemptions?: number;
  max_redemptions_per_email?: number;
  expires_at: string;
  starts_at?: string;
  /** Letters and digits, up to 12; the code becomes `PREFIX-XXXXXXXXXXXX`. */
  prefix?: string;
  description?: string;
  source: { plugin: string; ref: string };
}

export interface IssuedCoupon {
  id: string;
  code: string;
  expires_at: string;
}

export interface CouponStatus {
  exists: boolean;
  redeemed_count: number;
  expired: boolean;
  revoked: boolean;
}

/** Thrown for input `issue` refuses. The message names the field. */
export class CouponIssueError extends Error {
  constructor(message: string) {
    super(`coupons.issue: ${message}`);
    this.name = 'CouponIssueError';
  }
}

/**
 * Turn the contract's input into a stored coupon, or say what is wrong.
 *
 * Pure apart from `nowMs`, so every refusal is testable without storage. The
 * fields go through `normalizeCoupon` — the admin API's own validator — so a
 * plugin cannot create a coupon an admin could not.
 */
export function parseIssueInput(raw: unknown, nowMs: number): { ok: true; value: Partial<Coupon>; prefix: string } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'input must be an object' };
  const b = raw as Record<string, unknown>;

  const source = b.source as Record<string, unknown> | undefined;
  if (!source || typeof source !== 'object') return { ok: false, error: 'source { plugin, ref } is required' };
  if (typeof source.plugin !== 'string' || !isValidPluginId(source.plugin)) {
    return { ok: false, error: 'source.plugin must be your plugin id' };
  }
  if (typeof source.ref !== 'string' || !source.ref.trim() || source.ref.length > 200) {
    return { ok: false, error: 'source.ref must be a non-empty string of at most 200 characters' };
  }

  let prefix = '';
  if (b.prefix !== undefined && b.prefix !== null && b.prefix !== '') {
    if (typeof b.prefix !== 'string' || !/^[A-Za-z0-9]{1,12}$/.test(b.prefix)) {
      return { ok: false, error: 'prefix must be 1–12 letters or digits' };
    }
    prefix = b.prefix.toUpperCase();
  }

  if (typeof b.expires_at !== 'string' || !Number.isFinite(Date.parse(b.expires_at))) {
    return { ok: false, error: 'expires_at is required (ISO date)' };
  }
  if (Date.parse(b.expires_at) <= nowMs) return { ok: false, error: 'expires_at must be in the future' };

  if ((b.type === 'percent' || b.type === 'fixed') && !(Number(b.value) > 0)) {
    return { ok: false, error: `a ${b.type} coupon needs a positive value` };
  }
  for (const k of ['max_redemptions', 'max_redemptions_per_email'] as const) {
    if (b[k] !== undefined && !(Number.isInteger(b[k]) && (b[k] as number) >= 1)) {
      return { ok: false, error: `${k} must be a whole number of at least 1` };
    }
  }
  if (b.email !== undefined && b.email !== null && typeof b.email !== 'string') {
    return { ok: false, error: 'email must be a string' };
  }

  // The admin validator, with a placeholder code (the real one is generated
  // after). Only the contract's fields are passed, so a plugin cannot set
  // `automatic`, `product_ids` or a count through this door.
  const parsed = normalizeCoupon({
    code: 'PLACEHOLDER',
    type: b.type,
    ...(b.value !== undefined ? { value: b.value } : {}),
    ...(b.gift_product_id !== undefined ? { gift_product_id: b.gift_product_id } : {}),
    ...(b.conditions !== undefined ? { conditions: b.conditions } : {}),
    ...(b.email !== undefined ? { email: b.email } : {}),
    ...(b.single_use !== undefined ? { single_use: b.single_use === true } : {}),
    ...(b.max_redemptions !== undefined ? { max_redemptions: b.max_redemptions } : {}),
    ...(b.max_redemptions_per_email !== undefined ? { max_redemptions_per_email: b.max_redemptions_per_email } : {}),
    expires_at: b.expires_at,
    ...(b.starts_at !== undefined ? { starts_at: b.starts_at } : {}),
    ...(typeof b.description === 'string' ? { description: b.description } : {}),
  });
  if (!parsed.ok) return { ok: false, error: parsed.error };
  if (b.conditions !== undefined && (typeof b.conditions !== 'object' || b.conditions === null || Array.isArray(b.conditions))) {
    return { ok: false, error: 'conditions must be an object' };
  }
  const whole = checkCouponRecord(parsed.value);
  if (whole) return { ok: false, error: whole };

  const { code: _placeholder, ...rest } = parsed.value;
  return {
    ok: true,
    prefix,
    value: { ...rest, source: { plugin: source.plugin, ref: source.ref.trim() } },
  };
}

/**
 * A gift coupon's gift must exist and be a SIMPLE product: a gift is one unit
 * with no choice to make, and a variable product cannot be put on a shelf
 * without one. Null when fine (or not a gift coupon). Whether it is in stock
 * is decided at the quote and the order, because stock moves.
 */
export async function checkGiftProduct(c: Partial<Coupon>): Promise<string | null> {
  if (c.kind !== 'gift_product') return null;
  const product = c.gift_product_id ? await LocalDB.getProduct(String(c.gift_product_id)) : null;
  if (!product || !resolvePurchasable(product, null)) {
    return 'gift_product_id must name an existing simple (non-variable) product';
  }
  return null;
}

/**
 * Issue a new coupon with a server-generated code.
 *
 * Throws `CouponIssueError` on input it refuses. A gift product must exist
 * and be a simple product NOW; whether it is in stock is decided at the
 * quote and the order, because stock moves.
 */
export async function issueCoupon(input: IssueCouponInput, nowMs = Date.now()): Promise<IssuedCoupon> {
  const parsed = parseIssueInput(input, nowMs);
  if (!parsed.ok) throw new CouponIssueError(parsed.error);
  await LocalDB.init();

  const gift = await checkGiftProduct(parsed.value);
  if (gift) throw new CouponIssueError(gift);

  const taken = new Set((await LocalDB.getCoupons()).map((c) => normalizeCouponCode(c.code)));
  for (let attempt = 0; attempt < 8; attempt++) {
    const body = randomCouponCode();
    const code = parsed.prefix ? `${parsed.prefix}-${body}` : body;
    if (taken.has(code)) continue; // 60 bits: in practice never
    const created = await LocalDB.createCoupon({
      ...(parsed.value as Omit<Coupon, 'id' | 'created_at' | 'updated_at'>),
      code,
      enabled: true,
      used_count: 0,
    });
    return { id: created.id, code: created.code, expires_at: String(created.ends_at) };
  }
  throw new CouponIssueError('could not generate a unique code');
}

async function findByCode(code: unknown): Promise<Coupon | null> {
  const want = normalizeCouponCode(code);
  if (!want) return null;
  await LocalDB.init();
  return (await LocalDB.getCoupons()).find((c) => normalizeCouponCode(c.code) === want) ?? null;
}

/**
 * What a plugin may know about a code: whether it exists, how often it was
 * redeemed, whether it has expired or been revoked. `null` only for an
 * argument that is not a code at all.
 */
export async function couponStatus(code: unknown, nowMs = Date.now()): Promise<CouponStatus | null> {
  if (!normalizeCouponCode(code)) return null;
  const c = await findByCode(code);
  if (!c) return { exists: false, redeemed_count: 0, expired: false, revoked: false };
  const end = c.ends_at ? Date.parse(c.ends_at) : NaN;
  return {
    exists: true,
    redeemed_count: Number(c.used_count) || 0,
    expired: Number.isFinite(end) && nowMs > end,
    revoked: !!c.revoked_at,
  };
}

/**
 * Revoke a code a PLUGIN issued. True when it is now revoked (also when it
 * already was). False for an unknown code and for a coupon staff made: a
 * plugin cannot switch off the shop's own promotions through this door.
 */
export async function revokeCoupon(code: unknown): Promise<boolean> {
  const c = await findByCode(code);
  if (!c || !c.source) return false;
  if (c.revoked_at) return true;
  const updated = await LocalDB.updateCoupon(c.id, { enabled: false, revoked_at: new Date().toISOString() });
  return !!updated;
}

/**
 * The claim options for a checkout: the per-email count rides along only when
 * the coupon limits uses per email, so a popular automatic rule does not
 * collect a hash for every buyer who ever used it.
 */
export function claimOptionsFor(coupon: Pick<Coupon, 'usage_limit_per_customer'>, email: unknown): { emailKey?: string; perEmailLimit?: number } {
  if (coupon.usage_limit_per_customer == null) return {};
  const key = couponEmailKey(email);
  return key ? { emailKey: key, perEmailLimit: coupon.usage_limit_per_customer } : {};
}
