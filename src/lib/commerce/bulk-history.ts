/**
 * Undo for bulk product edits.
 *
 * Every applied batch — a bulk change or a CSV update — records, per product,
 * each field it changed with its value BEFORE and AFTER. Undo puts a field back
 * only while it still holds the batch's after-value. Anything that has moved
 * since is left alone and reported:
 *
 *  - a price someone edited by hand afterwards keeps their edit;
 *  - a stock count a checkout decremented afterwards is NOT restored — undoing
 *    "set stock to 50" after 3 sold must not give those 3 back.
 *
 * So undo can never overwrite work done after the batch; the worst it does is
 * restore less than everything, and it says which fields it skipped and why.
 *
 * The pure half lives here (what to record, what undo would do). The route
 * reads and writes the records through LocalDB's plugin-data store under a
 * namespace no plugin can claim (plugin ids cannot start with "@").
 */
import type { Product } from '../../core/models';

export const HISTORY_NS = '@core:bulk-edit';
/** Batches kept. Older ones drop off; undo is for the edit you just regretted. */
export const HISTORY_KEEP = 20;

type Value = string | number | boolean | null | string[];

/** One field path: a top-level field, or `variants.<id>.<field>`. */
export interface FieldChange {
  path: string;
  before: Value;
  after: Value;
}

export interface BatchRecord {
  id: string;
  at: string;
  actor: string;
  kind: 'bulk' | 'csv' | 'undo';
  /** One line for the history list, e.g. "Price +10% on 12 products". */
  label: string;
  products: Record<string, { name: string; changes: FieldChange[] }>;
  undone_at?: string;
  undone_by?: string;
}

const TOP = ['status', 'featured', 'categories', 'tags', 'regular_price_cents', 'sale_price_cents', 'stock'] as const;
const VARIANT = ['price_cents', 'regular_price_cents', 'sale_price_cents', 'stock'] as const;

/**
 * The fields bulk edit and CSV can change, flattened to paths.
 *
 * `regular_price_cents` is the EFFECTIVE regular price: a product stored with
 * only `price_cents` (the WooCommerce import writes that shape) has a regular
 * price all the same, and recording it as "none" made undo write null — which
 * the price derivation ignores, so the undo reported success and changed
 * nothing.
 */
export function trackedFields(p: Product): Record<string, Value> {
  const out: Record<string, Value> = {};
  const r = p as unknown as Record<string, unknown>;
  for (const k of TOP) {
    const v = k === 'regular_price_cents' ? (r.regular_price_cents ?? r.price_cents) : r[k];
    out[k] = Array.isArray(v) ? [...(v as string[])] : (v === undefined ? null : (v as Value));
  }
  for (const v of p.variants ?? []) {
    const vr = v as unknown as Record<string, unknown>;
    for (const k of VARIANT) out[`variants.${v.id}.${k}`] = (vr[k] ?? null) as Value;
  }
  return out;
}

const same = (a: Value, b: Value) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * The field paths a patch actually sets, relative to the product it was built
 * from. Only these are recorded for undo: diffing EVERY tracked field between a
 * snapshot and the saved row also recorded whatever else changed meanwhile — a
 * unit a checkout sold during a long batch, another admin's edit — and undo
 * would then "restore" those too.
 */
export function patchedPaths(patch: Partial<Product>, from: Product): Set<string> {
  const paths = new Set<string>();
  const pr = patch as Record<string, unknown>;
  for (const k of TOP) if (k in pr) paths.add(k);
  // A price the patch sets through price_cents is the regular price.
  if ('price_cents' in pr) paths.add('regular_price_cents');
  if (Array.isArray(patch.variants)) {
    const old = new Map((from.variants ?? []).map((v) => [v.id, v as unknown as Record<string, unknown>]));
    for (const v of patch.variants) {
      const was = old.get(v.id);
      const now = v as unknown as Record<string, unknown>;
      for (const k of VARIANT) {
        if (!was || JSON.stringify(was[k] ?? null) !== JSON.stringify(now[k] ?? null)) paths.add(`variants.${v.id}.${k}`);
      }
    }
  }
  return paths;
}

/** What changed between two snapshots of one product, optionally only on some paths. */
export function diffFields(before: Record<string, Value>, after: Record<string, Value>, only?: ReadonlySet<string>): FieldChange[] {
  const out: FieldChange[] = [];
  for (const path of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (only && !only.has(path)) continue;
    const b = before[path] ?? null;
    const a = after[path] ?? null;
    if (!same(b, a)) out.push({ path, before: b, after: a });
  }
  return out;
}

export interface UndoPlan {
  id: string;
  name: string;
  /** The partial update that restores what can be restored. Empty = nothing. */
  patch: Partial<Product>;
  restored: string[];
  /** Fields left as they are, and why. */
  kept: string[];
  missing?: boolean;
}

/**
 * What undoing one batch would do to each product, judged against the
 * products as they are NOW.
 */
export function planUndo(record: BatchRecord, current: ReadonlyMap<string, Product>): UndoPlan[] {
  return Object.entries(record.products).map(([id, entry]) => {
    const plan: UndoPlan = { id, name: entry.name, patch: {}, restored: [], kept: [] };
    const p = current.get(id);
    if (!p) { plan.missing = true; return plan; }
    const now = trackedFields(p);
    const variants = (p.variants ?? []).map((v) => ({ ...v }));
    let variantsTouched = false;
    for (const c of entry.changes) {
      if (!(c.path in now)) { plan.kept.push(`${c.path}: no longer exists`); continue; }
      if (!same(now[c.path], c.after)) {
        plan.kept.push(`${c.path}: changed since (${fmt(now[c.path])}), left as it is`);
        continue;
      }
      if (c.path.startsWith('variants.')) {
        const [, vid, field] = c.path.split('.');
        const v = variants.find((x) => x.id === vid);
        if (!v) { plan.kept.push(`${c.path}: variant no longer exists`); continue; }
        (v as unknown as Record<string, unknown>)[field] = c.before;
        variantsTouched = true;
      } else {
        (plan.patch as Record<string, unknown>)[c.path] = c.before;
      }
      plan.restored.push(`${c.path} → ${fmt(c.before)}`);
    }
    if (variantsTouched) plan.patch.variants = variants;
    return plan;
  });
}

function fmt(v: Value): string {
  if (v === null) return 'none';
  if (Array.isArray(v)) return v.join(', ') || '(none)';
  return String(v);
}
