/**
 * The cart: product ids and quantities, kept in the browser.
 *
 * ## What it deliberately does not hold
 *
 * No prices, no names, no totals. The CMS prices every basket itself, from ids
 * and quantities — `POST /api/orders/quote` for the cart page and
 * `POST /api/orders` for the order — and ignores any money a client sends. A
 * cart that stored prices would show yesterday's price after a sale ended, and
 * would invite someone to edit localStorage and wonder why it did not work.
 * The cart page asks the CMS every time it opens.
 *
 * ## Tolerant on the way in
 *
 * localStorage is written by this code, by an older version of it, and by
 * anyone with devtools open. `readCart` accepts anything and keeps only lines
 * that make sense, so a corrupt value empties the cart rather than breaking
 * every page that shows the cart count.
 *
 * Pure functions over a storage interface, so every rule is testable in Node.
 */

export interface CartLine {
  product_id: string;
  /** Required by the CMS for a product with variants. */
  variant_id?: string;
  qty: number;
}

/** The subset of `Storage` the cart needs. */
export interface CartStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const CART_KEY = 'astrobaas-cart';

/**
 * The most of one line. The CMS enforces its own per-product limit and says so
 * in the quote; this only stops a typo of 1000 from being sent at all.
 */
export const MAX_QTY = 99;
/** Lines in one cart, for the same reason. */
export const MAX_LINES = 50;

const ID = /^[A-Za-z0-9_-]{1,80}$/;

function validLine(raw: unknown): CartLine | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.product_id !== 'string' || !ID.test(r.product_id)) return null;
  if (r.variant_id !== undefined && (typeof r.variant_id !== 'string' || !ID.test(r.variant_id))) return null;
  const qty = Math.floor(Number(r.qty));
  if (!Number.isFinite(qty) || qty < 1) return null;
  return {
    product_id: r.product_id,
    ...(r.variant_id ? { variant_id: r.variant_id as string } : {}),
    qty: Math.min(qty, MAX_QTY),
  };
}

const sameLine = (a: CartLine, productId: string, variantId?: string) =>
  a.product_id === productId && (a.variant_id ?? '') === (variantId ?? '');

/** The cart as stored, cleaned. Never throws. */
export function readCart(storage: CartStorage): CartLine[] {
  let raw: unknown;
  try { raw = JSON.parse(storage.getItem(CART_KEY) ?? '[]'); } catch { return []; }
  if (!Array.isArray(raw)) return [];
  const out: CartLine[] = [];
  for (const item of raw) {
    const line = validLine(item);
    if (!line) continue;
    // Two entries for the same thing (an older writer) become one.
    const existing = out.find((l) => sameLine(l, line.product_id, line.variant_id));
    if (existing) existing.qty = Math.min(existing.qty + line.qty, MAX_QTY);
    else if (out.length < MAX_LINES) out.push(line);
  }
  return out;
}

function write(storage: CartStorage, lines: CartLine[]): CartLine[] {
  try {
    if (lines.length) storage.setItem(CART_KEY, JSON.stringify(lines));
    else storage.removeItem(CART_KEY);
  } catch {
    // Storage full or blocked (a private window in some browsers). The cart
    // still works for this page; it just will not survive a reload.
  }
  return lines;
}

/** Add `qty` of a product (or one variant of it). Returns the new cart. */
export function addToCart(storage: CartStorage, productId: string, qty = 1, variantId?: string): CartLine[] {
  const line = validLine({ product_id: productId, variant_id: variantId, qty });
  const lines = readCart(storage);
  if (!line) return lines;
  const existing = lines.find((l) => sameLine(l, productId, variantId));
  if (existing) existing.qty = Math.min(existing.qty + line.qty, MAX_QTY);
  else if (lines.length < MAX_LINES) lines.push(line);
  return write(storage, lines);
}

/** Set a line's quantity; 0 or less removes it. */
export function setQty(storage: CartStorage, productId: string, qty: number, variantId?: string): CartLine[] {
  const lines = readCart(storage);
  const n = Math.floor(Number(qty));
  const kept = !Number.isFinite(n) || n < 1
    ? lines.filter((l) => !sameLine(l, productId, variantId))
    : lines.map((l) => (sameLine(l, productId, variantId) ? { ...l, qty: Math.min(n, MAX_QTY) } : l));
  return write(storage, kept);
}

export function clearCart(storage: CartStorage): CartLine[] {
  try { storage.removeItem(NONCE_KEY); } catch { /* see write() */ }
  return write(storage, []);
}

const NONCE_KEY = 'astrobaas-cart-nonce';

/**
 * A random value that lives exactly as long as this cart: created with the
 * first checkout attempt, kept in the same storage as the cart (so every tab
 * shares it), and removed when an order empties the cart.
 *
 * Checkout hashes it with the order's details into the Idempotency-Key. The
 * same cart and details give the same key, so pressing "Place order" again —
 * after a timeout, in another tab, after a reload — returns the first order
 * instead of placing a second. Changed details give a new key, so fixing a
 * typo is a new request rather than a refusal. And a new cart gives a new
 * nonce, so buying the same thing again tomorrow is a new order, not a replay
 * of yesterday's.
 */
export function cartNonce(storage: CartStorage): string {
  try {
    const existing = storage.getItem(NONCE_KEY);
    if (existing && /^[a-f0-9-]{16,64}$/.test(existing)) return existing;
    const fresh = crypto.randomUUID();
    storage.setItem(NONCE_KEY, fresh);
    return fresh;
  } catch {
    return crypto.randomUUID();
  }
}

/** The Idempotency-Key for one checkout attempt: this cart, these details. */
export async function attemptKey(nonce: string, order: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(`${nonce}|${JSON.stringify(order)}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return `sf-${Array.from(digest.slice(0, 20), (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * localStorage, or an in-memory stand-in when the browser refuses it — merely
 * touching `window.localStorage` throws in some privacy modes, and a shop whose
 * every page crashes on that has lost the sale before the cart.
 */
export function browserStorage(): CartStorage {
  try {
    const s = window.localStorage;
    s.getItem(CART_KEY);
    return s;
  } catch {
    const mem = new Map<string, string>();
    return {
      getItem: (k) => mem.get(k) ?? null,
      setItem: (k, v) => { mem.set(k, v); },
      removeItem: (k) => { mem.delete(k); },
    };
  }
}

/** How many items, for the header badge. */
export function cartCount(lines: readonly CartLine[]): number {
  return lines.reduce((n, l) => n + l.qty, 0);
}
