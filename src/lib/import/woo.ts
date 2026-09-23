/**
 * Turning a WooCommerce dump into a plan.
 *
 * The input is the normalized JSON a dump parser produces — products.json,
 * categories.json, brands.json, customers.json, orders.json, blog.json — not
 * WXR. A WooCommerce export is a database dump, not an RSS feed, and pretending
 * otherwise is how importers lose orders.
 *
 * PURE, for the same reason `plan.ts` is: every judgement here is one an
 * operator will argue with when their shop looks wrong, and a judgement you
 * cannot unit-test is one nobody has reviewed. Money in particular: a price
 * that arrives as a float, a string, `null`, or the number 19.99 must land as
 * an integer number of cents or be REFUSED — never rounded quietly into
 * somebody's catalogue.
 */
import { slugifyImported } from './plan';
import { brandKey, normalizeBrand } from '../commerce/brand';
import { slugify, stableHash } from '../validate';

export interface WooProductInput {
  wp_id?: string | number;
  name?: string;
  slug?: string;
  sku?: string;
  description?: string;
  short_description?: string;
  price_cents?: unknown;
  regular_price_cents?: unknown;
  sale_price_cents?: unknown;
  on_sale?: unknown;
  stock?: unknown;
  in_stock?: unknown;
  categories?: unknown;
  brand?: string;
  images?: { rel?: string; src?: string; alt?: string }[];
  created_at?: string;
}

export interface PlannedProduct {
  wpId: string;
  name: string;
  slug: string;
  sku?: string;
  description?: string;
  shortDescription?: string;
  priceCents: number;
  regularPriceCents?: number;
  salePriceCents?: number | null;
  onSale: boolean;
  stock: number | null;
  inStock: boolean;
  categorySlugs: string[];
  /**
   * The brand as the shop spells it — `Όψη Οπτικά`, `Straße`, `Ørgreen` — never
   * a slug. Identity is `brandKey`'s job, and it reads every script.
   */
  brand?: string;
  /** Media paths relative to the dump, resolved by the writer. */
  imagePaths: string[];
  createdAt?: string;
}

export interface PlannedTerm {
  name: string;
  slug: string;
  parentSlug?: string;
}

export interface PlannedCustomer {
  wpId: string;
  email: string;
  name?: string;
  phone?: string;
  address?: string;
  city?: string;
  postcode?: string;
  country?: string;
  createdAt?: string;
}

export interface PlannedOrder {
  wpId: string;
  number: string;
  status: string;
  currency: string;
  totalCents: number;
  customerWpId?: string;
  email: string;
  name?: string;
  phone?: string;
  address?: string;
  items: { productWpId?: string; name: string; qty: number; totalCents: number }[];
  createdAt?: string;
}

export interface WooSkipped {
  kind: 'product' | 'category' | 'brand' | 'customer' | 'order' | 'post';
  label: string;
  reason: string;
}

export interface WooPlan {
  products: PlannedProduct[];
  categories: PlannedTerm[];
  brands: PlannedTerm[];
  customers: PlannedCustomer[];
  orders: PlannedOrder[];
  posts: { wpId: string; title: string; slug: string; content: string; status: 'published' | 'draft'; excerpt?: string; createdAt?: string }[];
  skipped: WooSkipped[];
}

/** The raw JSON files a dump parser produces. Anything missing is simply absent. */
export interface WooDataset {
  products?: unknown[];
  categories?: unknown[];
  brands?: unknown[];
  customers?: unknown[];
  orders?: unknown[];
  blog?: unknown[];
}

/**
 * Statuses WooCommerce writes, mapped to this shop's.
 *
 * The model has real `on-hold` and `failed` states, so they map to THEMSELVES
 * — the first version flattened them (and every unknown plugin status) to
 * `pending`, which is the one status the abandonment sweep is allowed to
 * cancel. Imported history was landing squarely in its kill zone.
 *
 * An unrecognised status — `wc-shipped`, `wc-awaiting-lab`, whatever a plugin
 * invented — becomes `on-hold`, not `pending` and not `completed`: "a human
 * needs to look at this" is the only honest translation of a word this system
 * does not speak, and on-hold is untouchable by every automatic process.
 */
const ORDER_STATUS: Record<string, string> = {
  'wc-completed': 'completed', completed: 'completed',
  'wc-processing': 'processing', processing: 'processing',
  'wc-on-hold': 'on-hold', 'on-hold': 'on-hold',
  'wc-pending': 'pending', pending: 'pending',
  'wc-cancelled': 'cancelled', cancelled: 'cancelled',
  'wc-refunded': 'refunded', refunded: 'refunded',
  'wc-failed': 'failed', failed: 'failed',
};

export function mapOrderStatus(raw: unknown): string {
  const key = String(raw ?? '').trim().toLowerCase();
  return ORDER_STATUS[key] ?? 'on-hold';
}

/**
 * Money, or nothing.
 *
 * Accepts an integer number of cents (what the dump parser is supposed to
 * emit) and a string of digits. Everything else — a float, `"19,99"`, `null`,
 * `NaN`, a negative — is REFUSED, because the alternative is a catalogue where
 * a handful of prices are wrong by a factor of a hundred and nobody knows
 * which.
 */
export function centsOrNull(raw: unknown): number | null {
  if (typeof raw === 'number') {
    return Number.isSafeInteger(raw) && raw >= 0 ? raw : null;
  }
  if (typeof raw === 'string' && /^\d{1,15}$/.test(raw.trim())) {
    return Number(raw.trim());
  }
  return null;
}

/** Woo writes 1/0/"yes"/"no"/true. Anything unrecognised is false. */
function truthy(raw: unknown): boolean {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return raw === 1;
  const s = String(raw ?? '').trim().toLowerCase();
  return s === 'yes' || s === 'true' || s === '1';
}

/** A stock count, or null for "not tracked" — which is not the same as zero. */
function stockOrNull(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  return Number.isSafeInteger(n) ? n : null;
}

/** ISO 8601, or undefined. Never "now": an invented date is worse than none. */
export function isoOrUndefined(raw: unknown): string | undefined {
  const s = String(raw ?? '').trim();
  if (!s || /^0000-00-00/.test(s)) return undefined;
  const normalised = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? `${s.replace(' ', 'T')}Z` : s;
  const d = new Date(normalised);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/**
 * An image path from the dump, or null.
 *
 * The dump gives paths relative to an extracted uploads folder. A path that
 * climbs out of it (`../../etc/passwd`), is absolute, or carries a NUL is
 * refused here rather than at the point it would be opened — the writer should
 * never receive one it has to be careful about.
 */
export function safeImagePath(raw: unknown): string | null {
  const s = String(raw ?? '').trim();
  if (!s || s.includes('\0')) return null;
  if (s.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(s)) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return null;      // a URL, not a dump path
  const parts = s.replace(/\\/g, '/').split('/');
  if (parts.some((p) => p === '..')) return null;
  return parts.filter((p) => p && p !== '.').join('/') || null;
}

const asRecord = (v: unknown): Record<string, unknown> =>
  (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * A term slug from the dump, decoded — or '' when it cannot be read.
 *
 * WordPress keeps a non-Latin slug PERCENT-ENCODED: `sanitize_title` lowercases
 * the name and `utf8_uri_encode`s it, so the term `Γυαλιά Ηλίου` is stored as
 * `%ce%b3%cf%85%ce%b1…`, and that is what a dump read out of `wp_terms`
 * carries. Slugified as it stands, every `%` became a separator and the brand
 * was published as `ce-b3-cf-85-ce-b1-…` — hex, where the shop had a name.
 * Decoded, it is `γυαλιά-ηλίου`, which `slugify` transliterates like any other
 * Greek text.
 *
 * A slug that will not decode — a truncated sequence, `%zz`, a stray `%` — is
 * not guessed at: '' sends the caller back to the NAME, the one field that
 * always says what the shop meant. `decodeURIComponent` throws on exactly those
 * inputs, and one bad term must not abort a whole shop's import. Nor is a slug
 * that is STILL encoded after one pass trusted (`%25ce…`, a parser that escaped
 * it again): decoding it once more would be guessing how many layers somebody
 * added, and a wrong guess is the hex slug all over again.
 */
export function decodeWordPressSlug(raw: unknown): string {
  const s = str(raw).trim();
  if (!s.includes('%')) return s;
  let decoded: string;
  try {
    decoded = decodeURIComponent(s);
  } catch {
    return '';
  }
  return /%[0-9a-f]{2}/i.test(decoded) ? '' : decoded;
}

/**
 * Decide what a WooCommerce dump becomes.
 *
 * Order matters to the caller, not here: this reports what each record would
 * be, and the writer resolves the references (a product's category slug, an
 * order's customer) once the things they point at exist.
 */
export function planWooImport(data: WooDataset): WooPlan {
  const plan: WooPlan = {
    products: [], categories: [], brands: [], customers: [], orders: [], posts: [], skipped: [],
  };

  /* ---- brands ---- */
  //
  // A product keeps its brand's NAME, in whatever script the shop writes it,
  // and a brand record gets its slug from `slugify`, which transliterates.
  //
  // Both used to go through `slugifyImported`, which keeps only [a-z0-9] and
  // does not transliterate. So every Greek, Cyrillic or CJK brand slugified to
  // '' — its products were imported with NO brand and its record was skipped —
  // and a Latin name lost letters: `Ørgreen` was stored as `rgreen` and
  // `Straße` as `stra-e`, on the product, which is what the storefront, the
  // admin and the schema.org Brand node all show. Both live shops write Greek.
  //
  // The slug is now only the record's HANDLE. The products carry the name,
  // `buildBrandDirectory` keys the record on that same name, and `?brand=`
  // resolves the slug back through the directory — so the listing and the
  // filter agree whatever the slug turned out to be. Shops imported the old
  // way keep working: see the brands step in woo-apply.ts.
  //
  // Records are tidied exactly as a product's brand is, and as POST
  // /api/brands tidies a record's name, so a record and its products cannot
  // differ by a space.
  const records = (data.brands ?? []).map((raw) => {
    const b = asRecord(raw);
    return { name: normalizeBrand(b.name), rawSlug: str(b.slug).trim() };
  });
  const recordNameKeys = new Set(records.map((r) => brandKey(r.name)).filter(Boolean));
  // A dump names a product's brand by its term NAME (data/import.example
  // does). A parser that wrote the term SLUG instead used to come out the same,
  // because both were slugified; now that the name is kept, a slug on a
  // product would be kept too — `%ce%b3%cf%85…` in the storefront, keyed apart
  // from its own record. So a product brand that IS a record's slug, as the
  // dump spells it or decoded, is that record's name.
  const nameBySlug = new Map<string, string>();
  for (const r of records) {
    if (!r.name || !r.rawSlug) continue;
    for (const s of [r.rawSlug, decodeWordPressSlug(r.rawSlug)]) {
      if (s && !nameBySlug.has(s)) nameBySlug.set(s, r.name);
    }
  }
  const productBrand = (raw: unknown): string | undefined => {
    const typed = normalizeBrand(raw);
    const key = brandKey(typed);
    // A "brand" of only punctuation names nobody, here as everywhere else.
    if (!typed || !key) return undefined;
    const decoded = decodeWordPressSlug(typed);
    const named = nameBySlug.get(typed) ?? nameBySlug.get(decoded);
    // Never across makers: `rb` is Ray-Ban's slug, but if the dump also has a
    // maker CALLED RB, a product saying `rb` is RB's.
    if (named && (brandKey(named) === key || !recordNameKeys.has(key))) return named;
    // An encoded slug no record explains still decodes to the maker's
    // letters — which `brandKey` files with the name (`γυαλιά-ηλίου` and
    // `Γυαλιά Ηλίου` are one key). Only something slug-shaped is decoded: a
    // brand really called `100%` is left alone.
    if (decoded && decoded !== typed && /^[\w.%-]+$/.test(typed)) return normalizeBrand(decoded) ?? typed;
    return typed;
  };

  // Every maker the dump names — records AND products — as an identity, so
  // that a record's slug can be kept from spelling ANOTHER maker's name.
  // `slugify` makes that collision possible where `slugifyImported` did not:
  // `Straße` and `Strasse` both want `strasse` now, and a curated record
  // holding it would re-point `?brand=strasse`, which means Strasse. The
  // directory and POST /api/brands refuse exactly that; so does this. Product
  // brands are counted as they will be STORED, so a product naming Straße by
  // its slug `strasse` is not mistaken for a maker called Strasse.
  const makerKeys = new Set<string>([
    ...recordNameKeys,
    ...(data.products ?? []).map((p) => brandKey(productBrand(asRecord(p).brand))).filter(Boolean),
  ]);
  const brandSlugs = new Set<string>();
  /** brandKey → the name already planned for that maker. */
  const plannedBrand = new Map<string, string>();
  for (const { name, rawSlug } of records) {
    if (!name) {
      plan.skipped.push({ kind: 'brand', label: '(unnamed)', reason: 'the record has no name' });
      continue;
    }
    const key = brandKey(name);
    if (!key) {
      plan.skipped.push({ kind: 'brand', label: name, reason: 'the name has no letter or digit, so no product can be filed under it' });
      continue;
    }
    // One maker, one record. Two rows spelling it two ways (`Ray Ban`,
    // `Ray-Ban`) are one brand to every surface, and a second record for it
    // would take over its name in the listing. Reported, not dropped: this was
    // a silent `continue`.
    const first = plannedBrand.get(key);
    if (first !== undefined) {
      plan.skipped.push({ kind: 'brand', label: name, reason: `the same brand as "${first}", which this import already brings` });
      continue;
    }
    // The dump's own slug when it has one — WordPress's, which a storefront
    // moving its old brand URLs across may be keyed on — decoded, then put
    // through the same `slugify` a brand created in the admin gets. Never ''.
    const wanted = slugify(decodeWordPressSlug(rawSlug) || name);
    const shadows = (s: string) => {
      const k = brandKey(s);
      return k !== '' && k !== key && makerKeys.has(k);
    };
    // Two makers that slugify alike BOTH keep a record: the one the slug
    // spells keeps it, whichever comes first in the dump, and the other takes
    // the suffix the directory would give it — hashed from its key, so it is
    // the same on every run.
    let slug = wanted;
    if (brandSlugs.has(slug) || shadows(slug)) {
      const base = `${wanted}-${stableHash(key)}`;
      slug = base;
      for (let n = 2; brandSlugs.has(slug); n += 1) slug = `${base}-${n}`;
    }
    brandSlugs.add(slug);
    plannedBrand.set(key, name);
    plan.brands.push({ name, slug });
  }

  /* ---- product categories ---- */
  const catSlugs = new Set<string>();
  /** slugify(display name) → the slug the category record actually carries. */
  const categoryBySlugifiedName = new Map<string, string>();
  for (const raw of data.categories ?? []) {
    const c = asRecord(raw);
    const name = str(c.name).trim();
    const slug = slugifyImported(str(c.slug) || name);
    if (!name || !slug) {
      plan.skipped.push({ kind: 'category', label: name || '(unnamed)', reason: 'no usable name or slug' });
      continue;
    }
    if (catSlugs.has(slug)) continue;
    catSlugs.add(slug);
    categoryBySlugifiedName.set(slugifyImported(name), slug);
    const parent = slugifyImported(str(c.parent_slug));
    plan.categories.push({ name, slug, ...(parent && parent !== slug ? { parentSlug: parent } : {}) });
  }

  /* ---- products ---- */
  const productSlugs = new Set<string>();
  for (const raw of data.products ?? []) {
    const p = asRecord(raw) as WooProductInput & Record<string, unknown>;
    const name = str(p.name).trim();
    const wpId = String(p.wp_id ?? '').trim();
    if (!name) {
      plan.skipped.push({ kind: 'product', label: wpId || '(unnamed)', reason: 'the product has no name' });
      continue;
    }
    const price = centsOrNull(p.price_cents);
    if (price === null) {
      // Refused, not defaulted. A product priced at zero because its price did
      // not parse is a product somebody can buy for nothing.
      plan.skipped.push({
        kind: 'product', label: name,
        reason: 'the price is not a whole number of cents — fix it in the dump rather than guessing',
      });
      continue;
    }
    const base = slugifyImported(str(p.slug) || name) || `product-${wpId || plan.products.length + 1}`;
    let slug = base;
    for (let n = 2; productSlugs.has(slug); n += 1) slug = `${base.slice(0, 74)}-${n}`;
    productSlugs.add(slug);

    // A product names its categories by DISPLAY NAME; the category records
    // keep the dump's own slug, which Woo may have suffixed ('sunglasses-2')
    // or transliterated. Resolving through the planned category list keeps the
    // reference pointing at the record that will actually exist — slugifying
    // the name directly left the product silently unfiled whenever the two
    // differed.
    const categorySlugs = Array.isArray(p.categories)
      ? [...new Set((p.categories as unknown[])
          .map((c) => {
            const key = slugifyImported(str(c));
            return categoryBySlugifiedName.get(key) ?? key;
          })
          .filter(Boolean))]
      : [];
    const imagePaths = (Array.isArray(p.images) ? p.images : [])
      .map((i) => safeImagePath(asRecord(i).rel ?? asRecord(i).src))
      .filter((v): v is string => !!v);

    const regular = centsOrNull(p.regular_price_cents);
    const rawSale = centsOrNull(p.sale_price_cents);
    // A sale is a SAVING: the products API refuses a sale price at or above
    // the regular one as false advertising, and an import that writes through
    // LocalDB must not smuggle past that rule. No regular price to compare
    // against, or a sale that saves nothing — no sale.
    const sale = rawSale !== null && regular !== null && rawSale < regular ? rawSale : null;

    // The brand as the shop spells it, tidied the way the admin form tidies
    // it. Never slugified: see the brands step above for what that lost.
    const brand = productBrand(p.brand);

    plan.products.push({
      wpId,
      name,
      slug,
      ...(str(p.sku).trim() ? { sku: str(p.sku).trim() } : {}),
      ...(str(p.description) ? { description: str(p.description) } : {}),
      ...(str(p.short_description) ? { shortDescription: str(p.short_description) } : {}),
      priceCents: price,
      ...(regular !== null ? { regularPriceCents: regular } : {}),
      salePriceCents: sale,
      onSale: truthy(p.on_sale) && sale !== null,
      stock: stockOrNull(p.stock),
      inStock: truthy(p.in_stock),
      categorySlugs,
      ...(brand ? { brand } : {}),
      imagePaths,
      ...(isoOrUndefined(p.created_at) ? { createdAt: isoOrUndefined(p.created_at) } : {}),
    });
  }

  /* ---- customers ---- */
  const emails = new Set<string>();
  for (const raw of data.customers ?? []) {
    const c = asRecord(raw);
    const email = str(c.email).trim().toLowerCase();
    const label = email || str(c.name) || '(no email)';
    // A shop's WordPress user table contains its STAFF as well as its
    // customers. Importing an administrator as a customer record is how an
    // owner's home address ends up in a customer list.
    //
    // Roles arrive in every spelling a dump parser might emit — 'admin',
    // 'Administrator', an ARRAY of roles, shop_manager — and the first version
    // matched two exact lowercase strings, so 'Administrator' imported as a
    // customer despite the stated guarantee. Every WordPress role that can
    // open wp-admin is staff; customer and subscriber are the shop's actual
    // customers.
    const staffRole = (() => {
      const rawRoles = Array.isArray((c as Record<string, unknown>).roles)
        ? (c as Record<string, unknown>).roles as unknown[]
        : [c.role, (c as Record<string, unknown>).roles];
      const names = rawRoles
        .filter((r): r is string => typeof r === 'string')
        .map((r) => r.trim().toLowerCase());
      const STAFF = new Set(['admin', 'administrator', 'editor', 'author', 'contributor', 'shop_manager', 'shop-manager']);
      return names.find((n) => STAFF.has(n)) ?? null;
    })();
    if (staffRole) {
      plan.skipped.push({ kind: 'customer', label, reason: `the record is WordPress staff (${staffRole}), not a customer` });
      continue;
    }
    if (!email || !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)) {
      plan.skipped.push({ kind: 'customer', label, reason: 'no usable email address' });
      continue;
    }
    if (emails.has(email)) continue;
    emails.add(email);
    plan.customers.push({
      wpId: String(c.wp_id ?? '').trim(),
      email,
      ...(str(c.name).trim() ? { name: str(c.name).trim() } : {}),
      ...(str(c.phone).trim() ? { phone: str(c.phone).trim() } : {}),
      ...(str(c.address).trim() ? { address: str(c.address).trim() } : {}),
      ...(str(c.city).trim() ? { city: str(c.city).trim() } : {}),
      ...(str(c.postcode).trim() ? { postcode: str(c.postcode).trim() } : {}),
      ...(str(c.country).trim() ? { country: str(c.country).trim() } : {}),
      ...(isoOrUndefined(c.registered_at) ? { createdAt: isoOrUndefined(c.registered_at) } : {}),
    });
  }

  /* ---- orders ---- */
  const numbers = new Set<string>();
  for (const raw of data.orders ?? []) {
    const o = asRecord(raw);
    const wpId = String(o.wp_id ?? '').trim();
    if (!wpId) {
      plan.skipped.push({ kind: 'order', label: '(no id)', reason: 'the order has no WooCommerce id to key on' });
      continue;
    }
    const total = centsOrNull(o.total_cents);
    if (total === null) {
      plan.skipped.push({ kind: 'order', label: `#${wpId}`, reason: 'the total is not a whole number of cents' });
      continue;
    }
    const number = `WC-${wpId}`;
    if (numbers.has(number)) {
      // The file rule: nothing vanishes. A dump carrying the same wp_id twice
      // is corrupt or concatenated, and the operator should hear about it.
      plan.skipped.push({ kind: 'order', label: `#${wpId}`, reason: 'duplicate wp_id within this dump — only the first was planned' });
      continue;
    }
    numbers.add(number);

    const items = (Array.isArray(o.items) ? o.items : []).flatMap((rawItem) => {
      const i = asRecord(rawItem);
      const lineTotal = centsOrNull(i.total_cents);
      const qty = stockOrNull(i.qty);
      if (lineTotal === null || qty === null) return [];
      return [{
        ...(String(i.product_wp_id ?? '').trim() ? { productWpId: String(i.product_wp_id).trim() } : {}),
        name: str(i.name) || 'Item',
        qty,
        totalCents: lineTotal,
      }];
    });

    plan.orders.push({
      wpId,
      number,
      status: mapOrderStatus(o.status),
      // A currency is three letters or it is not a currency. 'us dollars'
      // sliced to 'US ' — with the trailing space — was reaching financial
      // records; anything that is not exactly [A-Z]{3} falls back to EUR.
      currency: (() => {
        const c = str(o.currency).trim().toUpperCase();
        return /^[A-Z]{3}$/.test(c) ? c : 'EUR';
      })(),
      totalCents: total,
      ...(String(o.customer_wp_id ?? '').trim() ? { customerWpId: String(o.customer_wp_id).trim() } : {}),
      // An order with no email still has to exist — it is a real sale, and the
      // owner's totals must add up — but it is marked, not invented.
      email: str(o.email).trim() || 'unknown@imported.invalid',
      ...(str(o.name).trim() ? { name: str(o.name).trim() } : {}),
      ...(str(o.phone).trim() ? { phone: str(o.phone).trim() } : {}),
      ...(str(o.address).trim() ? { address: str(o.address).trim() } : {}),
      items,
      ...(isoOrUndefined(o.created_at) ? { createdAt: isoOrUndefined(o.created_at) } : {}),
    });
  }

  /* ---- blog posts ---- */
  const postSlugs = new Set<string>();
  for (const raw of data.blog ?? []) {
    const p = asRecord(raw);
    const title = str(p.title).trim();
    // The dump's status decides, exactly as the WXR importer's does: only an
    // explicit `publish` publishes, everything else — draft, private, pending,
    // a status this system has never heard of — arrives as a draft. The first
    // version read no status at all and hard-coded 'published', putting a
    // shop's private drafts on the open web.
    const blogStatus = str(p.status).trim().toLowerCase();
    const postStatus: 'published' | 'draft' =
      blogStatus === '' || blogStatus === 'publish' || blogStatus === 'published' ? 'published' : 'draft';
    if (!title) {
      plan.skipped.push({ kind: 'post', label: '(untitled)', reason: 'the post has no title' });
      continue;
    }
    const base = slugifyImported(str(p.slug) || title) || `post-${plan.posts.length + 1}`;
    let slug = base;
    for (let n = 2; postSlugs.has(slug); n += 1) slug = `${base.slice(0, 74)}-${n}`;
    postSlugs.add(slug);
    plan.posts.push({
      wpId: String(p.wp_id ?? '').trim(),
      title,
      slug,
      content: str(p.content),
      status: postStatus,
      ...(str(p.excerpt) ? { excerpt: str(p.excerpt) } : {}),
      ...(isoOrUndefined(p.created_at) ? { createdAt: isoOrUndefined(p.created_at) } : {}),
    });
  }

  return plan;
}

/** Human-readable one-liner for the CLI. */
export function summariseWooPlan(plan: WooPlan): string {
  return `${plan.products.length} product(s), ${plan.categories.length} categor(ies), `
    + `${plan.brands.length} brand(s), ${plan.customers.length} customer(s), `
    + `${plan.orders.length} order(s), ${plan.posts.length} post(s), ${plan.skipped.length} skipped`;
}
