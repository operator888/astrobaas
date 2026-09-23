/**
 * "Tell me when it's back" — the pure half.
 *
 * ## Why a SWEEP finds the restocks, not a hook
 *
 * Stock moves through several paths: an operator editing the number, a
 * cancellation returning reserved units, a refund, a bulk import. Hooking each
 * one is the sibling-gap shape this codebase keeps finding — the fifth path
 * added next year would silently stop notifying.
 *
 * So the scheduler asks the opposite question on its existing tick: of the
 * people waiting, whose product can now be bought? That is correct by
 * construction however the stock arrived.
 *
 * ## One message, then the row is gone
 *
 * This is not a subscription. Somebody asked about one product, they get one
 * email, and the row is deleted — so there is nothing to unsubscribe from and
 * nothing to leak in a later export. A person who wants telling twice can ask
 * twice.
 */
import type { Product } from '../../core/models';
import { settingInt } from '../settings-map';

/** The custom-entity type the rows live under. */
export const WAITLIST_TYPE = 'stock_waitlist';

/**
 * How many back-in-stock emails one scheduler tick may send.
 *
 * ## Why there is a ceiling
 *
 * A popular product sold out for a month can collect thousands of waiting
 * addresses (the per-product ceiling is 5000), and a restock used to email all
 * of them in one tick, one after another, inside the same sweep that publishes
 * scheduled posts and cancels abandoned orders. That is a burst a transactional
 * provider throttles or flags, sent from the shop's own domain, and a sweep
 * that does not finish for minutes.
 *
 * With a ceiling the rest simply wait for the next tick. Nobody is lost — a row
 * is only deleted when its email is attempted — and nobody is sent twice,
 * because a row that was attempted is gone before the next tick looks.
 *
 * 50 per tick at the default one-minute interval is 3000 an hour, which clears
 * the largest possible list for one product in under two hours.
 */
export const WAITLIST_BATCH_KEY = 'stock_waitlist_batch_size';
export const DEFAULT_WAITLIST_BATCH = 50;
const MAX_WAITLIST_BATCH = 5000;

/**
 * The batch size: the setting, else `STOCK_WAITLIST_BATCH_SIZE`, else 50.
 *
 * Clamped to at least 1 — a zero here would not mean "off", it would mean
 * "hold every waiting shopper forever while looking like it works". An
 * operator who wants no notices removes the waitlist button.
 */
export function resolveWaitlistBatchSize(
  settings: Record<string, unknown> | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const bounds = { min: 1, max: MAX_WAITLIST_BATCH };
  const fromEnv = settingInt(env.STOCK_WAITLIST_BATCH_SIZE, DEFAULT_WAITLIST_BATCH, bounds);
  return settingInt(settings?.[WAITLIST_BATCH_KEY], fromEnv, bounds);
}

/**
 * The rows this tick sends: the OLDEST `size` of them.
 *
 * Oldest first, so a restock that takes several ticks to announce tells people
 * in the order they asked — the person who waited longest is not the one left
 * until last because of where storage happened to put their row. Sorted on a
 * copy; ties keep storage order, and a row with no readable timestamp goes
 * after every row that has one.
 */
export function waitlistBatch<T extends { created_at?: string }>(
  rows: readonly T[],
  size: number,
): T[] {
  const n = Math.max(1, Math.trunc(size) || 1);
  const at = (r: T) => {
    const t = Date.parse(String(r.created_at ?? ''));
    return Number.isFinite(t) ? t : Number.MAX_SAFE_INTEGER;
  };
  return rows
    .map((row, i) => ({ row, i, t: at(row) }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .slice(0, n)
    .map((x) => x.row);
}

/** How many people one product may have waiting, so a bot cannot fill the table. */
export const WAITLIST_MAX_PER_PRODUCT = 5000;

export interface WaitlistRow {
  id: string;
  product_id: string;
  variant_id?: string;
  email: string;
  created_at: string;
}

/** Normalise an address the way every other public form here does. */
export function normaliseWaitlistEmail(raw: unknown): string | null {
  const s = String(raw ?? '').trim().toLowerCase();
  if (s.length > 200) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null;
}

/**
 * Can this product actually be bought right now?
 *
 * Deliberately stricter than `in_stock`. A product can be in stock and still
 * unbuyable — archived, draft, or hidden from the catalogue — and telling
 * somebody an item is back when the page 404s is worse than saying nothing.
 *
 * `manage_stock: false` means the shop does not count units, so such a product
 * is available whenever it is active; that is the same rule the catalogue uses.
 */
export function isBackInStock(product: Pick<Product,
  'status' | 'in_stock' | 'stock' | 'manage_stock' | 'catalog_visibility'> | null | undefined): boolean {
  if (!product) return false;
  if (product.status !== 'active') return false;
  if (product.catalog_visibility === 'hidden') return false;
  if (product.manage_stock === false) return true;
  if (typeof product.stock === 'number') return product.stock > 0;
  return product.in_stock === true;
}

/**
 * Who should be told now.
 *
 * Rows for products that no longer exist are returned as `stale` so the sweep
 * can delete them: a waitlist that accumulates rows for deleted products is a
 * table that only grows, and it holds email addresses.
 */
export function selectWaitlistToNotify(
  rows: readonly WaitlistRow[],
  products: ReadonlyMap<string, Product>,
): { notify: WaitlistRow[]; stale: WaitlistRow[] } {
  const notify: WaitlistRow[] = [];
  const stale: WaitlistRow[] = [];
  for (const row of rows) {
    const product = products.get(row.product_id);
    if (!product) { stale.push(row); continue; }
    if (isBackInStock(product)) notify.push(row);
  }
  return { notify, stale };
}
