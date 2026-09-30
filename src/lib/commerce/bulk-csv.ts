/**
 * Update products from a spreadsheet: one row per product or variant.
 *
 * The everyday case is a supplier's price list or a stock count from a
 * warehouse — a column of SKUs and a column of numbers. This turns such a file
 * into the same per-product partial updates bulk edit makes, so it previews,
 * applies through `saveProduct`, protects stock sold meanwhile, and can be
 * undone, exactly like any other bulk change.
 *
 * ## Columns (headers are case-insensitive)
 *
 *  - a key: `sku`, `slug` or `id`. Each row uses the first of those it fills
 *    in, so one file can mix products with and without SKUs. A `sku` may be a
 *    PRODUCT's or a VARIANT's; a variant's SKU updates that variant;
 *  - `price` — the regular price, in the shop currency (12.50);
 *  - `sale_price` — a sale price, or `none` to end the sale;
 *  - `stock` — a whole number, or `untracked`;
 *  - `status` — active, draft or archived (products only);
 *  - `featured` — yes/no, true/false or 1/0 (products only).
 *
 * **An empty cell changes nothing.** Other columns (a `name` for readability,
 * say) are ignored and reported, never guessed at.
 *
 * Numbers are plain: one optional decimal separator, no thousands separators.
 * "1,000" is a row error, not one thousand and not one.
 */
import type { Product, ProductVariant } from '../../core/models';
import type { CsvTable } from '../csv';

export const MAX_CSV_ROWS = 1000;
const KEYS = ['sku', 'slug', 'id'] as const;
const FIELDS = ['price', 'sale_price', 'stock', 'status', 'featured'] as const;
type Field = (typeof FIELDS)[number];

export interface CsvPlan {
  /** The key columns the file has, in the order they are tried. */
  keys: (typeof KEYS)[number][];
  ignoredColumns: string[];
  products: { id: string; name: string; patch: Partial<Product>; changes: string[]; skipped?: string }[];
  /** 1-based data-row numbers (header is row 1, so the first data row is 2). */
  rowErrors: { row: number; message: string }[];
}

/**
 * A plain number, or NaN. A separator followed by exactly three digits is
 * REFUSED unless the currency really has three decimals: "1,000" and "1.000"
 * are one thousand to half the people who type them and one to the other half,
 * and either guess prices a whole catalogue wrong.
 */
function plain(text: string, threeDecimals = false): number {
  const t = text.trim();
  if (!/^[-+]?\d+([.,]\d+)?$/.test(t)) return NaN;
  if (!threeDecimals && /[.,]\d{3}$/.test(t)) return NaN;
  return Number(t.replace(',', '.'));
}

/** Decimal text in the shop currency → minor units, or an error sentence. */
function money(text: string, minor: number): number | string {
  const n = plain(text, minor === 1000);
  if (!Number.isFinite(n) || n < 0) return `"${text}" is not a price — write a plain number like 12.50, with no thousands separator`;
  const m = Math.round(n * minor);
  if (Math.abs(n * minor - m) > 1e-6) return `"${text}" has more decimals than the currency allows`;
  return m;
}

const norm = (s: string) => s.trim().toLowerCase();

/** One cell → its value, or the sentence saying what is wrong with it. */
function parseCell(f: Field, raw: string, minor: number): { value: unknown } | { error: string } {
  if (f === 'price' || f === 'sale_price') {
    if (f === 'sale_price' && norm(raw) === 'none') return { value: null };
    const m = money(raw, minor);
    return typeof m === 'string' ? { error: m } : { value: m };
  }
  if (f === 'stock') {
    if (norm(raw) === 'untracked') return { value: null };
    const n = plain(raw);
    return Number.isInteger(n) && n >= 0 && n <= 1_000_000 ? { value: n } : { error: `"${raw}" is not a stock count — a whole number, or "untracked"` };
  }
  if (f === 'status') {
    return ['active', 'draft', 'archived'].includes(norm(raw)) ? { value: norm(raw) } : { error: `"${raw}" is not a status — active, draft or archived` };
  }
  const v = norm(raw);
  if (['yes', 'true', '1'].includes(v)) return { value: true };
  if (['no', 'false', '0'].includes(v)) return { value: false };
  return { error: `"${raw}" is not yes or no` };
}

export function planCsvUpdate(
  table: CsvTable,
  products: readonly Product[],
  opts: { minor?: number; money?: (minor: number) => string } = {},
): CsvPlan {
  const minor = opts.minor ?? 100;
  const show = opts.money ?? ((c: number) => (c / minor).toFixed(minor === 1 ? 0 : minor === 1000 ? 3 : 2));
  const keys = KEYS.filter((k) => table.headers.includes(k));
  const plan: CsvPlan = {
    keys,
    ignoredColumns: table.headers.filter((h) => !(KEYS as readonly string[]).includes(h) && !(FIELDS as readonly string[]).includes(h)),
    products: [],
    rowErrors: [],
  };
  if (!keys.length) {
    // The usual reason is a spreadsheet saved with semicolons (European Excel):
    // one "column" whose name is the whole header line.
    const semicolons = table.headers.length === 1 && table.headers[0].includes(';');
    plan.rowErrors.push({ row: 1, message: semicolons
      ? 'The file is separated by semicolons. Save it as "CSV (comma delimited)" and upload it again.'
      : 'The file needs a column named sku, slug or id to find each product.' });
    return plan;
  }
  if (!FIELDS.some((f) => table.headers.includes(f))) {
    plan.rowErrors.push({ row: 1, message: `Nothing to change: add a column named ${FIELDS.join(', ')}.` });
    return plan;
  }
  if (table.rows.length > MAX_CSV_ROWS) {
    plan.rowErrors.push({ row: 1, message: `At most ${MAX_CSV_ROWS} rows in one file.` });
    return plan;
  }

  // Lookups. SKUs compare without case or surrounding space, and a SKU that
  // belongs to two things is refused rather than guessed.
  const bySku = new Map<string, { product: Product; variant?: ProductVariant }[]>();
  const add = (sku: string | undefined, hit: { product: Product; variant?: ProductVariant }) => {
    if (!sku || !sku.trim()) return;
    const k = norm(sku);
    bySku.set(k, [...(bySku.get(k) ?? []), hit]);
  };
  for (const p of products) {
    add(p.sku, { product: p });
    for (const v of p.variants ?? []) add(v.sku, { product: p, variant: v });
  }
  const bySlug = new Map(products.map((p) => [norm(p.slug), p]));
  const byId = new Map(products.map((p) => [String(p.id), p]));

  // Per product: the fields set, and which row set each (to catch two rows
  // setting the same thing differently).
  const work = new Map<string, {
    product: Product;
    top: Partial<Record<Field, { value: unknown; row: number }>>;
    variants: Map<string, Partial<Record<Field, { value: unknown; row: number }>>>;
  }>();

  table.rows.forEach((cells, i) => {
    const row = i + 2;
    const key = keys.find((k) => (cells[k] ?? '').trim() !== '');
    if (!key) { plan.rowErrors.push({ row, message: `The row has no ${keys.join(' or ')}.` }); return; }
    const keyValue = (cells[key] ?? '').trim();
    let target: { product: Product; variant?: ProductVariant } | undefined;
    if (key === 'sku') {
      const hits = bySku.get(norm(keyValue)) ?? [];
      if (hits.length > 1) { plan.rowErrors.push({ row, message: `SKU "${keyValue}" belongs to ${hits.length} products or variants — fix the duplicate first.` }); return; }
      target = hits[0];
    } else if (key === 'slug') {
      const p = bySlug.get(norm(keyValue));
      target = p && { product: p };
    } else {
      const p = byId.get(keyValue);
      target = p && { product: p };
    }
    if (!target) { plan.rowErrors.push({ row, message: `No product with ${key} "${keyValue}".` }); return; }

    const w = work.get(target.product.id) ?? { product: target.product, top: {}, variants: new Map() };
    work.set(target.product.id, w);
    const slot = target.variant
      ? (w.variants.get(target.variant.id) ?? w.variants.set(target.variant.id, {}).get(target.variant.id)!)
      : w.top;

    for (const f of FIELDS) {
      const raw = (cells[f] ?? '').trim();
      if (raw === '') continue;
      const parsed = parseCell(f, raw, minor);
      if ('error' in parsed) { plan.rowErrors.push({ row, message: parsed.error }); continue; }
      const value = parsed.value;
      if (target.variant && (f === 'status' || f === 'featured')) {
        plan.rowErrors.push({ row, message: `${f} belongs to the product, not one of its variants.` });
        continue;
      }
      const prev = slot[f];
      if (prev && JSON.stringify(prev.value) !== JSON.stringify(value)) {
        plan.rowErrors.push({ row, message: `Rows ${prev.row} and ${row} set ${f} differently for the same ${target.variant ? 'variant' : 'product'}.` });
        continue;
      }
      slot[f] = { value, row };
    }
  });

  for (const w of work.values()) {
    const p = w.product;
    const patch: Partial<Product> = {};
    const changes: string[] = [];
    const out = { id: p.id, name: p.name, patch, changes } as CsvPlan['products'][number];
    const variants = p.variants ?? [];
    const priced = variants.filter((v) => (v.regular_price_cents ?? v.price_cents ?? null) !== null);

    const t = w.top;
    // A product-row value that cannot apply is a ROW ERROR, not a skip: a skip
    // would let the file be applied with this row silently ignored — and with
    // it, the product's valid variant rows.
    if (t.price && priced.length) { plan.rowErrors.push({ row: t.price.row, message: `${p.name}: its variants have their own prices — give each variant's SKU a row instead.` }); delete t.price; }
    if (t.sale_price && priced.length && t.sale_price.value !== null) { plan.rowErrors.push({ row: t.sale_price.row, message: `${p.name}: a product-level sale does not reach variants with their own prices — put the sale on each variant's row.` }); delete t.sale_price; }
    if (t.stock && variants.length) { plan.rowErrors.push({ row: t.stock.row, message: `${p.name}: it has variants, which keep their own stock — give each variant's SKU a row.` }); delete t.stock; }

    const regular = p.regular_price_cents ?? p.price_cents;
    if (t.price && t.price.value !== regular) { patch.regular_price_cents = t.price.value as number; changes.push(`price ${show(regular)} → ${show(t.price.value as number)}`); }
    if (t.sale_price && t.sale_price.value !== (p.sale_price_cents ?? null)) {
      patch.sale_price_cents = t.sale_price.value as number | null;
      changes.push(t.sale_price.value === null ? 'sale ended' : `sale price ${show(t.sale_price.value as number)}`);
    }
    if (t.stock && t.stock.value !== (p.stock ?? null)) { patch.stock = t.stock.value as number | null; changes.push(`stock ${p.stock ?? 'untracked'} → ${t.stock.value ?? 'untracked'}`); }
    if (t.status && t.status.value !== p.status) { patch.status = t.status.value as Product['status']; changes.push(`status ${p.status} → ${t.status.value}`); }
    if (t.featured && t.featured.value !== !!p.featured) { patch.featured = t.featured.value as boolean; changes.push(t.featured.value ? 'featured' : 'no longer featured'); }

    if (w.variants.size) {
      let touched = false;
      const next = variants.map((v) => {
        const s = w.variants.get(v.id);
        if (!s) return v;
        const nv = { ...v };
        const label = Object.values(v.options ?? {}).join(' / ') || v.sku || v.id;
        const reg = v.regular_price_cents ?? v.price_cents ?? null;
        if (s.price && s.price.value !== reg) {
          nv.regular_price_cents = s.price.value as number;
          nv.price_cents = s.price.value as number; // the variant's regular; checkout derives the sale
          changes.push(`${label}: price ${reg === null ? 'inherited' : show(reg)} → ${show(s.price.value as number)}`);
          touched = true;
        }
        if (s.sale_price && s.sale_price.value !== (v.sale_price_cents ?? null)) {
          nv.sale_price_cents = s.sale_price.value as number | null;
          changes.push(`${label}: ${s.sale_price.value === null ? 'sale ended' : `sale price ${show(s.sale_price.value as number)}`}`);
          touched = true;
        }
        if (s.stock && s.stock.value !== (v.stock ?? null)) {
          nv.stock = s.stock.value as number | null;
          changes.push(`${label}: stock ${v.stock ?? 'untracked'} → ${s.stock.value ?? 'untracked'}`);
          touched = true;
        }
        return nv;
      });
      if (touched) patch.variants = next;
    }
    plan.products.push(out);
  }
  return plan;
}

/** The template: every product and variant with its current values, ready to edit. */
export function csvTemplateRows(products: readonly Product[], minor = 100): Record<string, unknown>[] {
  const fmt = (c: number | null | undefined) => (c === null || c === undefined ? '' : (c / minor).toFixed(minor === 1 ? 0 : minor === 1000 ? 3 : 2));
  const rows: Record<string, unknown>[] = [];
  for (const p of products) {
    const variants = p.variants ?? [];
    rows.push({
      sku: p.sku ?? '', slug: p.slug, name: p.name,
      price: variants.some((v) => (v.regular_price_cents ?? v.price_cents ?? null) !== null) ? '' : fmt(p.regular_price_cents ?? p.price_cents),
      sale_price: p.sale_price_cents === null || p.sale_price_cents === undefined ? '' : fmt(p.sale_price_cents),
      stock: variants.length ? '' : (p.stock ?? 'untracked'),
      status: p.status, featured: p.featured ? 'yes' : 'no',
    });
    for (const v of variants) {
      if (!v.sku) continue; // a variant without a SKU cannot be addressed by a row
      rows.push({
        sku: v.sku, slug: '', name: `${p.name} (${Object.values(v.options ?? {}).join(' / ')})`,
        price: fmt(v.regular_price_cents ?? v.price_cents), sale_price: fmt(v.sale_price_cents), stock: v.stock ?? 'untracked',
        status: '', featured: '',
      });
    }
  }
  return rows;
}

export const CSV_TEMPLATE_COLUMNS = ['sku', 'slug', 'name', 'price', 'sale_price', 'stock', 'status', 'featured'] as const;
