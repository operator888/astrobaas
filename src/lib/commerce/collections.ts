/**
 * Automatic collections — a category whose membership is a RULE.
 *
 * Pure and dependency-free, in the shape `coupons.ts` established: an evaluator
 * that takes a product and a rule and answers, with a reason it can state.
 *
 * ## Two decisions that carry the whole design
 *
 * **It extends `ProductCategory` rather than inventing a Collection entity.**
 * A parallel entity would be the second mechanism this codebase keeps paying
 * for: coupons restrict by `category_slugs`, the product-count endpoint keys on
 * a category, and BOTH live storefronts route on category slugs. A collection
 * that is not a category would be invisible to all three on the day it shipped.
 *
 * **Membership is derived AT READ TIME and never written back** into
 * `Product.categories`. Writing it back creates two sources of truth that
 * disagree the moment a price changes and nobody re-runs a sweep — and it makes
 * "why is this product in here?" unanswerable, because the stored answer no
 * longer carries the reason. Deriving costs one predicate per product over a
 * catalogue `listProducts` already materialises in full.
 */
import type { Product, ProductCategory } from '../../core/models';
import { brandMatches, type BrandDirectory } from './brand';

/**
 * How a rule's brand VALUE is resolved: the directory `GET /api/brands` and
 * `?brand=` share, so a rule written with a published slug means what the link
 * means. Optional — without it a value is matched by identity alone.
 */
export type BrandResolver = Pick<BrandDirectory, 'keyFor'>;

export type CollectionOperator =
  | 'lt' | 'lte' | 'gt' | 'gte'
  | 'eq' | 'in' | 'not-in' | 'contains' | 'is'
  | 'within-days';

export interface CollectionCondition {
  /**
   * What to compare. A fixed vocabulary plus `custom.<name>` for the fields the
   * merchant declared themselves — the same names `/api/commerce/product-fields`
   * publishes, so a rule can only ever reference something that exists.
   */
  field: string;
  op: CollectionOperator;
  /** Compared as a string for `in`/`eq`/`contains`, as a number otherwise. */
  value: unknown;
}

export interface CollectionRule {
  /** `all` = every condition, `any` = at least one. No nesting, deliberately. */
  match: 'all' | 'any';
  conditions: CollectionCondition[];
}

/** No nesting and a hard cap: a rule nobody can read is a rule nobody can fix. */
export const MAX_CONDITIONS = 10;

const NUMERIC_FIELDS = new Set(['price_cents', 'regular_price_cents', 'sale_price_cents', 'stock']);
const BOOLEAN_FIELDS = new Set(['on_sale', 'in_stock', 'featured']);
const LIST_FIELDS = new Set(['categories', 'tags']);
const SCALAR_FIELDS = new Set(['brand', 'sku', 'gtin', 'status', 'type']);

/** Every field a rule may reference, for the admin's picker and for validation. */
export const COLLECTION_FIELDS: readonly string[] = [
  ...NUMERIC_FIELDS, ...BOOLEAN_FIELDS, ...LIST_FIELDS, ...SCALAR_FIELDS, 'created_at',
];

function asNumber(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function readField(product: Product, field: string): unknown {
  if (field.startsWith('custom.')) {
    // Merchant-declared fields, from the bag row 24 shipped. Reading them here
    // rather than special-casing each one is what lets a shop segment on
    // "material = titanium" without anybody adding a column.
    return (product.custom ?? {})[field.slice('custom.'.length)];
  }
  return (product as unknown as Record<string, unknown>)[field];
}

/**
 * Does one condition hold for this product?
 *
 * An UNKNOWN field or an unusable value is `false`, never `true`. A rule that
 * silently matched everything because of a typo would quietly publish the whole
 * catalogue into a collection, and on a storefront that is indistinguishable
 * from a merchandising decision somebody made on purpose.
 */
export function conditionHolds(
  product: Product,
  c: CollectionCondition,
  nowMs = Date.now(),
  brands?: BrandResolver,
): boolean {
  const actual = readField(product, c.field);

  switch (c.op) {
    case 'lt': case 'lte': case 'gt': case 'gte': {
      const a = asNumber(actual);
      const b = asNumber(c.value);
      if (a === null || b === null) return false;
      return c.op === 'lt' ? a < b : c.op === 'lte' ? a <= b : c.op === 'gt' ? a > b : a >= b;
    }
    case 'is': {
      // Only for the booleans, and compared to a real boolean — `'false'` from
      // a hand-written rule must not read as true.
      const want = c.value === true || c.value === 'true';
      return actual === true ? want : !want;
    }
    case 'eq':
      // `brand` is compared by IDENTITY, not by exact text.
      //
      // The sibling of the catalogue filter's bug, and the reason to fix both
      // in one pass: a rule reading `brand eq "Rayban"` silently excluded the
      // product spelled `RAYBAN`, so an automatic collection quietly held 16 of
      // 17 products. Nothing errors, nothing logs, and the collection looks
      // like it works.
      //
      // And the value resolves like `?brand=`: a rule saved with a published
      // slug (`strasse`, `gyalia-opsi`, a curated `rb`) holds for that brand,
      // where re-folding the slug would match no product at all.
      if (c.field === 'brand') return brandMatches(actual, c.value, brands);
      return String(actual ?? '') === String(c.value ?? '');
    case 'in': case 'not-in': {
      const list = Array.isArray(c.value) ? c.value.map((x) => String(x)) : [String(c.value)];
      // Same identity rule as `eq` — an `in` list of brands is several `eq`s.
      if (c.field === 'brand') {
        const inList = list.some((x) => brandMatches(actual, x, brands));
        return c.op === 'in' ? inList : !inList;
      }
      // A LIST field matches when ANY of its members is in the list — a product
      // tagged both "sale" and "new" is in a "sale" collection.
      const hit = Array.isArray(actual)
        ? actual.some((x) => list.includes(String(x)))
        : list.includes(String(actual ?? ''));
      return c.op === 'in' ? hit : !hit;
    }
    case 'contains': {
      if (Array.isArray(actual)) return actual.some((x) => String(x) === String(c.value));
      return String(actual ?? '').toLowerCase().includes(String(c.value ?? '').toLowerCase());
    }
    case 'within-days': {
      const days = asNumber(c.value);
      if (days === null || days <= 0) return false;
      const t = Date.parse(String(actual ?? ''));
      if (Number.isNaN(t)) return false;
      return nowMs - t <= days * 86_400_000;
    }
    default:
      return false;
  }
}

/** Does the whole rule hold? An empty rule matches NOTHING, never everything. */
export function ruleMatches(
  product: Product,
  rule: CollectionRule | undefined,
  nowMs = Date.now(),
  brands?: BrandResolver,
): boolean {
  if (!rule || !Array.isArray(rule.conditions) || rule.conditions.length === 0) return false;
  const held = rule.conditions.slice(0, MAX_CONDITIONS).map((c) => conditionHolds(product, c, nowMs, brands));
  return rule.match === 'any' ? held.some(Boolean) : held.every(Boolean);
}

/**
 * Every category slug this product belongs to, manual and automatic together.
 *
 * `rule_mode`:
 *  - `'add'` (or absent) — the rule ADDS to whatever was filed by hand, so an
 *    automatic collection never removes a product a human deliberately placed.
 *  - `'only'` — membership is the rule alone, and a hand-filed product is
 *    dropped. Destructive-feeling, so it is never the default.
 */
export function effectiveCategories(
  product: Product,
  categories: readonly ProductCategory[],
  nowMs = Date.now(),
  brands?: BrandResolver,
): string[] {
  const manual = new Set(product.categories ?? []);
  const out = new Set(manual);

  for (const cat of categories) {
    const rule = (cat as ProductCategory & { rule?: CollectionRule }).rule;
    if (!rule) continue;
    const mode = (cat as ProductCategory & { rule_mode?: string }).rule_mode === 'only' ? 'only' : 'add';
    const hit = ruleMatches(product, rule, nowMs, brands);
    if (hit) out.add(cat.slug);
    else if (mode === 'only') out.delete(cat.slug);
  }
  return [...out];
}

/**
 * Why this product is in this collection — one line per satisfied condition.
 *
 * Exists because "why is this here?" is the first question a merchant asks of a
 * rule they did not write today, and a derived membership with no explanation
 * is worse than a manual one they can at least edit.
 */
export function explainMembership(
  product: Product,
  rule: CollectionRule | undefined,
  nowMs = Date.now(),
  brands?: BrandResolver,
): { matches: boolean; reasons: string[] } {
  if (!rule?.conditions?.length) return { matches: false, reasons: ['This collection has no rule'] };
  const reasons = rule.conditions.slice(0, MAX_CONDITIONS).map((c) => {
    const held = conditionHolds(product, c, nowMs, brands);
    const actual = readField(product, c.field);
    return `${held ? '✓' : '✗'} ${c.field} ${c.op} ${JSON.stringify(c.value)} (is ${JSON.stringify(actual)})`;
  });
  return { matches: ruleMatches(product, rule, nowMs, brands), reasons };
}

/**
 * Clean a stored rule. A malformed condition is DROPPED, and a rule left with
 * no conditions becomes undefined — which means the category is manual again,
 * not that it matches everything.
 */
export function normalizeCollectionRule(raw: unknown): CollectionRule | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const conditions = Array.isArray(r.conditions) ? r.conditions : [];
  const out: CollectionCondition[] = [];

  for (const row of conditions.slice(0, MAX_CONDITIONS)) {
    if (!row || typeof row !== 'object') continue;
    const c = row as Record<string, unknown>;
    const field = String(c.field ?? '').trim();
    if (!field) continue;
    // A field the catalogue does not have cannot be compared, and a rule that
    // references one would silently never match — which reads as "the rule is
    // broken" long after the typo was made.
    if (!field.startsWith('custom.') && !COLLECTION_FIELDS.includes(field)) continue;
    const op = String(c.op ?? '') as CollectionOperator;
    if (!['lt', 'lte', 'gt', 'gte', 'eq', 'in', 'not-in', 'contains', 'is', 'within-days'].includes(op)) continue;
    if (c.value === undefined) continue;
    out.push({ field, op, value: c.value });
  }
  if (!out.length) return undefined;
  return { match: r.match === 'any' ? 'any' : 'all', conditions: out };
}
