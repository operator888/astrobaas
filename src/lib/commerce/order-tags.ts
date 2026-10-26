/**
 * Order tags — the shop's own labels on an order ("VIP", "damaged", "needs
 * review").
 *
 * ## One module, because three things must agree
 *
 * What a tag IS (normalisation, the length cap, case-insensitive identity), how
 * it is WRITTEN (atomically, never losing a concurrent edit) and how it is
 * COUNTED and FILTERED. The admin screen, `GET /api/orders?tag=`, the tag
 * routes and — later — the order timeline and bulk actions all call the
 * functions here; none of them should re-spell a rule.
 *
 * ## Where a tag lives
 *
 * On the order, as `tags: string[]`. Not a separate `order_tags` collection: an
 * order is already one whole record on every driver, a second collection would
 * need its own migration, its own delete-with-order and its own consistency
 * story, and "orders with this tag" would be a join the storage layer does not
 * have. As a field it is read with the order that is already being read.
 *
 * ## Staff only
 *
 * Tags are the shop's record, like `staff_note`. Nothing a buyer can reach
 * reads them (receipt, emails, the checkout response, the public lookup all
 * build their output field by field) and `tests/order-tags.test.mjs` pins that
 * by sweeping those surfaces with a tagged order.
 *
 * ## Free text, so it is only ever text
 *
 * A tag is typed by staff and may well contain a customer's name, which is why
 * an erasure clears it (gdpr.ts). Control, format and bidirectional-override
 * characters are removed, and `<` / `>` are refused outright — they have no use
 * in a label and every renderer is meant to escape anyway; refusing them means
 * a tag can never be the thing that makes one forget.
 *
 * ## Colour
 *
 * Derived from the tag, never typed: a deterministic pick from a fixed palette.
 * There is no colour field to validate, so there is nothing to inject into a
 * style attribute, and "VIP" is the same colour on every order, in every
 * admin, without a settings row to keep in step. The palette is NAMES; the
 * admin maps each to static classes.
 */
import { LocalDB } from '../localdb';
import type { Order } from '../../core/models';
import { recordOrderEvent } from './order-timeline';

/** Tags on one order. Enforced here, so the API and every future caller get it. */
export const ORDER_TAG_MAX_PER_ORDER = 10;
/** Characters (code points) in one tag. */
export const ORDER_TAG_MAX_LENGTH = 40;

/** The fixed palette. Order matters: a tag's colour is an index into it. */
export const ORDER_TAG_COLORS = [
  'red', 'orange', 'amber', 'green', 'teal', 'blue', 'indigo', 'purple', 'pink', 'gray',
] as const;
export type OrderTagColor = (typeof ORDER_TAG_COLORS)[number];

export type OrderTagProblem = 'not_text' | 'empty' | 'too_long' | 'invalid_characters';

export type TagCheck =
  | { ok: true; tag: string }
  | { ok: false; reason: OrderTagProblem };

/** Control, format (incl. zero-width and bidi overrides) and line/paragraph separators. */
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/**
 * The identity of a tag: what two spellings must share to be "the same tag".
 * NFC then lower case, so "VIP", "vip" and "Vip" are one, and "Café" typed with
 * a combining accent is the same as the precomposed one.
 */
export function orderTagKey(tag: string): string {
  return tag.normalize('NFC').toLowerCase();
}

/** One raw value → the tag that would be stored, or why it cannot be. */
export function normalizeOrderTag(raw: unknown): TagCheck {
  if (typeof raw !== 'string') return { ok: false, reason: 'not_text' };
  // Whitespace runs (tabs and newlines included) become one space BEFORE the
  // hidden-character strip, so a pasted line break separates words rather than
  // gluing them.
  const tag = raw.normalize('NFC').replace(/\s+/gu, ' ').replace(HIDDEN, '').trim();
  if (!tag) return { ok: false, reason: 'empty' };
  if (/[<>]/.test(tag)) return { ok: false, reason: 'invalid_characters' };
  if ([...tag].length > ORDER_TAG_MAX_LENGTH) return { ok: false, reason: 'too_long' };
  return { ok: true, tag };
}

/** A human sentence for a refusal. The route sends it; the code is what clients branch on. */
export function describeOrderTagProblem(reason: OrderTagProblem): string {
  switch (reason) {
    case 'not_text': return 'A tag must be text';
    case 'empty': return 'A tag cannot be empty';
    case 'too_long': return `A tag can be at most ${ORDER_TAG_MAX_LENGTH} characters`;
    case 'invalid_characters': return 'A tag cannot contain < or >';
  }
}

/**
 * The tags an order HAS, defensively.
 *
 * A stored value is only trusted as far as it is read: anything that is not a
 * list of acceptable strings is dropped, duplicates (by key) keep the first
 * spelling, and the list is capped. So a row written by a hand edit, a backup
 * from an older build or a plugin cannot put a malformed value on a screen or
 * in a count.
 */
export function orderTagsOf(order: { tags?: unknown } | null | undefined): string[] {
  const raw = order?.tags;
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const checked = normalizeOrderTag(item);
    if (!checked.ok) continue;
    const key = orderTagKey(checked.tag);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(checked.tag);
    if (out.length >= ORDER_TAG_MAX_PER_ORDER) break;
  }
  return out;
}

/** A tag's colour name. Same answer for any spelling of the same tag. */
export function orderTagColor(tag: string): OrderTagColor {
  // FNV-1a over the key's UTF-16 units: tiny, stable across runs and engines.
  let h = 0x811c9dc5;
  const key = orderTagKey(tag);
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return ORDER_TAG_COLORS[h % ORDER_TAG_COLORS.length];
}

export function orderHasTag(order: { tags?: unknown }, tag: unknown): boolean {
  const wanted = normalizeOrderTag(tag);
  if (!wanted.ok) return false;
  const key = orderTagKey(wanted.tag);
  return orderTagsOf(order).some((t) => orderTagKey(t) === key);
}

/** Orders carrying `tag` (any casing). A tag that is not valid matches nothing. */
export function filterOrdersByTag<T extends { tags?: unknown }>(orders: readonly T[], tag: unknown): T[] {
  const wanted = normalizeOrderTag(tag);
  if (!wanted.ok) return [];
  const key = orderTagKey(wanted.tag);
  return orders.filter((o) => orderTagsOf(o).some((t) => orderTagKey(t) === key));
}

export interface OrderTagCount {
  /** The spelling shown: the most used one, ties broken alphabetically. */
  tag: string;
  count: number;
  color: OrderTagColor;
}

/**
 * Every tag in use with the number of ORDERS carrying it — the autocomplete
 * list and the sidebar. Most used first, then alphabetical, so the order is
 * total and a re-render never shuffles two tags with the same count.
 */
export function countOrderTags(orders: readonly { tags?: unknown }[]): OrderTagCount[] {
  const byKey = new Map<string, { count: number; spellings: Map<string, number> }>();
  for (const o of orders) {
    for (const t of orderTagsOf(o)) {
      const key = orderTagKey(t);
      const slot = byKey.get(key) ?? { count: 0, spellings: new Map<string, number>() };
      slot.count += 1;
      slot.spellings.set(t, (slot.spellings.get(t) ?? 0) + 1);
      byKey.set(key, slot);
    }
  }
  const out: OrderTagCount[] = [];
  for (const slot of byKey.values()) {
    const [tag] = [...slot.spellings.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    out.push({ tag, count: slot.count, color: orderTagColor(tag) });
  }
  return out.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/* ---------------------------------------------------------------- writes -- */

export type OrderTagFailure =
  | { ok: false; code: 'not_found' }
  | { ok: false; code: 'invalid'; reason: OrderTagProblem; message: string }
  | { ok: false; code: 'too_many'; message: string }
  /** Every attempt lost a race; nothing was written. Safe to retry. */
  | { ok: false; code: 'busy'; message: string };

export type OrderTagResult =
  | { ok: true; tags: string[]; changed: boolean; order: Order }
  | OrderTagFailure;

/**
 * Rounds a write may lose before it gives up. Each lost round means somebody
 * ELSE's write landed, so N staff editing one order at the same instant cost
 * at most N−1 rounds; ten is far past any real number of people on one order.
 */
const MAX_ATTEMPTS = 10;

type Transform = (current: string[]) => { tags: string[] } | OrderTagFailure;

/**
 * Read the tags, decide the new list, write it only if nobody wrote in
 * between — and if somebody did, decide again from what they wrote.
 *
 * The decision is re-made from the fresh list on every attempt, which is the
 * point: "add VIP" applied to what is there NOW, not to what was there when
 * the request began.
 */
async function change(orderId: string, transform: Transform, actor?: string): Promise<OrderTagResult> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const order = await LocalDB.getOrder(orderId);
    if (!order) return { ok: false, code: 'not_found' };
    const stored = (order as { tags?: unknown }).tags;
    const current = orderTagsOf(order);
    const decided = transform(current);
    if (!('tags' in decided)) return decided;
    const next = decided.tags;
    // Nothing to write — unless the stored value is not what we would write
    // (a malformed row): then the first edit repairs it.
    const canonical = JSON.stringify(stored ?? []) === JSON.stringify(next);
    if (canonical) return { ok: true, tags: current, changed: false, order };
    const written = await LocalDB.compareAndSetOrderTags(orderId, stored, next);
    if (written.outcome === 'applied') {
      // The order's timeline says who added or removed what. Best effort: the
      // edit has landed, and a timeline that cannot be written must not undo it.
      const was = new Set(current.map(orderTagKey));
      const now = new Set(next.map(orderTagKey));
      const added = next.filter((t) => !was.has(orderTagKey(t)));
      const removed = current.filter((t) => !now.has(orderTagKey(t)));
      if (added.length || removed.length) {
        await recordOrderEvent(orderId, { event: 'tags.changed', actor: actor || 'system', added, removed });
      }
      return { ok: true, tags: next, changed: true, order: written.order };
    }
    if (written.outcome === 'missing') return { ok: false, code: 'not_found' };
    // 'changed': go round again with a fresh read.
  }
  return { ok: false, code: 'busy', message: 'The order was being edited at the same time; try again' };
}

/**
 * Add one or more tags. Tags the order already has (any casing) are not an
 * error — adding VIP twice is one VIP. Fails as a whole, writing nothing, when
 * a tag is invalid or the order would pass the limit.
 */
export async function addOrderTags(orderId: string, raw: readonly unknown[], actor?: string): Promise<OrderTagResult> {
  const wanted: string[] = [];
  for (const r of raw) {
    const checked = normalizeOrderTag(r);
    if (!checked.ok) {
      return { ok: false, code: 'invalid', reason: checked.reason, message: describeOrderTagProblem(checked.reason) };
    }
    wanted.push(checked.tag);
  }
  if (wanted.length === 0) {
    return { ok: false, code: 'invalid', reason: 'empty', message: describeOrderTagProblem('empty') };
  }
  return change(orderId, (current) => {
    const next = [...current];
    const keys = new Set(next.map(orderTagKey));
    for (const tag of wanted) {
      const key = orderTagKey(tag);
      if (keys.has(key)) continue;
      keys.add(key);
      next.push(tag);
    }
    if (next.length > ORDER_TAG_MAX_PER_ORDER) {
      return {
        ok: false, code: 'too_many',
        message: `An order can have at most ${ORDER_TAG_MAX_PER_ORDER} tags`,
      };
    }
    return { tags: next };
  }, actor);
}

/** Remove one tag (any casing). Removing one the order does not have is a no-op. */
export async function removeOrderTag(orderId: string, raw: unknown, actor?: string): Promise<OrderTagResult> {
  const checked = normalizeOrderTag(raw);
  if (!checked.ok) {
    return { ok: false, code: 'invalid', reason: checked.reason, message: describeOrderTagProblem(checked.reason) };
  }
  const key = orderTagKey(checked.tag);
  return change(orderId, (current) => ({ tags: current.filter((t) => orderTagKey(t) !== key) }), actor);
}

export interface BulkTagOutcome {
  /** Orders that carried the tag and were rewritten. */
  changed: number;
  /** Orders that could not be written (lost the race every attempt). */
  failed: number;
}

/**
 * Every order carrying `from`, one atomic write each.
 *
 * NOT one transaction across the shop, and that is stated rather than hidden:
 * each order either has its old tag list or its new one, never a torn one, and
 * a concurrent edit to an order is merged (the decision is re-made from the
 * fresh list). If the process dies half way, some orders are renamed and some
 * are not; running the same rename again finishes it, because already-renamed
 * orders no longer carry `from`.
 */
async function rewriteEverywhere(
  from: string, transform: (current: string[], fromKey: string) => string[], actor?: string,
): Promise<BulkTagOutcome> {
  const key = orderTagKey(from);
  const affected = (await LocalDB.getOrders()).filter((o) => orderTagsOf(o).some((t) => orderTagKey(t) === key));
  const outcome: BulkTagOutcome = { changed: 0, failed: 0 };
  for (const o of affected) {
    const r = await change(o.id, (current) => ({ tags: transform(current, key) }), actor);
    if (r.ok) { if (r.changed) outcome.changed += 1; }
    else if (r.code !== 'not_found') outcome.failed += 1;
  }
  return outcome;
}

/**
 * Rename a tag on every order that has it. Renaming onto a tag an order
 * already has merges them (one tag, not two). `to` may differ from `from` only
 * in casing, which re-spells it everywhere.
 */
export async function renameOrderTag(fromRaw: unknown, toRaw: unknown, actor?: string): Promise<
  { ok: true; outcome: BulkTagOutcome; tag: string } | OrderTagFailure
> {
  const from = normalizeOrderTag(fromRaw);
  if (!from.ok) return { ok: false, code: 'invalid', reason: from.reason, message: describeOrderTagProblem(from.reason) };
  const to = normalizeOrderTag(toRaw);
  if (!to.ok) return { ok: false, code: 'invalid', reason: to.reason, message: describeOrderTagProblem(to.reason) };
  const toKey = orderTagKey(to.tag);
  const outcome = await rewriteEverywhere(from.tag, (current, fromKey) => {
    const next: string[] = [];
    let placed = false;
    for (const t of current) {
      const k = orderTagKey(t);
      if (k === fromKey) {
        // The renamed tag takes the place of the old one — unless the order
        // already carries the target, in which case the old one just goes.
        if (!placed && !current.some((x) => orderTagKey(x) === toKey && orderTagKey(x) !== fromKey)) {
          next.push(to.tag);
          placed = true;
        }
        continue;
      }
      next.push(t);
    }
    return next;
  }, actor);
  return { ok: true, outcome, tag: to.tag };
}

/** Remove a tag from every order that has it. */
export async function deleteOrderTagEverywhere(raw: unknown, actor?: string): Promise<
  { ok: true; outcome: BulkTagOutcome } | OrderTagFailure
> {
  const checked = normalizeOrderTag(raw);
  if (!checked.ok) {
    return { ok: false, code: 'invalid', reason: checked.reason, message: describeOrderTagProblem(checked.reason) };
  }
  const outcome = await rewriteEverywhere(checked.tag, (current, fromKey) =>
    current.filter((t) => orderTagKey(t) !== fromKey), actor);
  return { ok: true, outcome };
}
