/**
 * `host.coupons` — issue, inspect and revoke discount codes from a compiled
 * plugin.
 *
 * ## Why this exists
 *
 * A compiled plugin imports nothing from the host (src/plugins/external.ts),
 * so a prize wheel, a referral scheme or a loyalty plugin had no way to hand a
 * customer a code the checkout would honour. This is that door, and the only
 * one: the coupon is checked by the admin API's own validator, priced by the
 * same `applyCoupon` the quote and the order use, and counted by the same
 * atomic claim. A plugin never writes a coupon row itself.
 *
 * ## The contract (fixed — other packages build against it)
 *
 * ```ts
 * host.coupons.issue({
 *   type, value?, gift_product_id?,
 *   conditions?: { min_subtotal_cents?, categories?, brands? },
 *   email?, single_use?, max_redemptions?, max_redemptions_per_email?,
 *   expires_at, starts_at?, prefix?, source: { plugin, ref },
 * }) -> Promise<{ id, code, expires_at }>
 * host.coupons.status(code) -> Promise<{ exists, redeemed_count, expired, revoked } | null>
 * host.coupons.revoke(code) -> Promise<boolean>
 * ```
 *
 * `value` is in the stored units: BASIS POINTS for `percent` (1000 = 10%),
 * minor units for `fixed`. The code is generated here — 12 random symbols
 * from an unambiguous alphabet (60 bits), upper-case, as `PREFIX-…` when a
 * prefix is given. `issue` throws (`CouponIssueError`) on input it refuses,
 * naming the field. `status` returns null only for an argument that is not a
 * code at all; an unknown code is `{ exists: false, … }`. `revoke` acts only
 * on coupons a plugin issued — the shop's own promotions are not a plugin's
 * to switch off — and is idempotent.
 */
import type { IssueCouponInput, IssuedCoupon, CouponStatus } from '../commerce/coupon-service';

export type { IssueCouponInput, IssuedCoupon, CouponStatus };

export interface PluginCoupons {
  issue(input: IssueCouponInput): Promise<IssuedCoupon>;
  status(code: string): Promise<CouponStatus | null>;
  revoke(code: string): Promise<boolean>;
}

/**
 * Built lazily: the factory runs while plugins load, and this module must not
 * pull storage in at import time (the same rule `createStore` follows).
 */
export function createPluginCoupons(): PluginCoupons {
  const svc = () => import('../commerce/coupon-service');
  return {
    issue: async (input) => (await svc()).issueCoupon(input),
    status: async (code) => (await svc()).couponStatus(code),
    revoke: async (code) => (await svc()).revokeCoupon(code),
  };
}
