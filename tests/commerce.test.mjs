#!/usr/bin/env node
/**
 * Commerce pricing + import rules (src/lib/commerce-service.ts).
 *
 * These are the decisions that determine what a shopper is charged and whether
 * an item is sellable, so they get isolated, adversarial coverage. Anything
 * needing a database (checkout, stock reservation, cancellation) is covered
 * end-to-end by the smoke suite against all three drivers.
 *
 * House rule under test: money is ALWAYS integer cents — never floats.
 *
 * Run with:  node tests/commerce.test.mjs
 */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cacheDir = path.join(here, '..', 'node_modules', '.cache');
await fs.mkdir(cacheDir, { recursive: true });

const tmp = path.join(cacheDir, `astrobaas-commerce-${process.pid}.mjs`);
await build({
  entryPoints: [path.join(here, '..', 'src/lib/commerce-service.ts')],
  bundle: true, format: 'esm', platform: 'node', packages: 'external',
  outfile: tmp, logLevel: 'silent',
});
const {
  normalizeImportProduct, normalizeStatus, orderTotalCents,
  ORDER_STATUSES, STOCK_RELEASED_STATUSES, releasesStock,
} = await import(pathToFileURL(tmp).href);
await fs.rm(tmp, { force: true });

const limitsTmp = path.join(cacheDir, `astrobaas-commerce-settings-${process.pid}.mjs`);
await build({
  entryPoints: [path.join(here, '..', 'src/lib/commerce-settings.ts')],
  bundle: true, format: 'esm', platform: 'node', packages: 'external',
  outfile: limitsTmp, logLevel: 'silent',
});
const {
  resolveOrderLimits, ORDER_LIMIT_DEFAULTS, ORDER_LIMIT_BOUNDS, ORDER_LIMIT_KEYS,
  resolveCommerceEnabled, COMMERCE_ENABLED_KEY,
  resolveShopCurrency, SHOP_CURRENCY_KEY,
} = await import(pathToFileURL(limitsTmp).href);
await fs.rm(limitsTmp, { force: true });

const fieldsTmp = path.join(cacheDir, `astrobaas-product-fields-${process.pid}.mjs`);
await build({
  entryPoints: [path.join(here, '..', 'src/lib/product-fields.ts')],
  bundle: true, format: 'esm', platform: 'node', packages: 'external',
  outfile: fieldsTmp, logLevel: 'silent',
});
const PF = await import(pathToFileURL(fieldsTmp).href);
await fs.rm(fieldsTmp, { force: true });

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) pass++;
  else {
    fail++;
    console.error(`✗ ${name}`);
  }
}

const CATS = new Set(['shoes', 'hats']);
const row = (over = {}) => ({ slug: 'p1', name: 'P1', price_cents: 1000, ...over });
const okPatch = (over = {}) => {
  const r = normalizeImportProduct(row(over), CATS);
  return r.ok ? r.patch : null;
};

// ---- rows that must be REJECTED (a bad feed must not create junk products) ----
{
  const bad = (over) => normalizeImportProduct(row(over), CATS).ok === false;
  check('rejects a missing slug', bad({ slug: '' }) && bad({ slug: undefined }));
  check('rejects a missing name', bad({ name: '' }));
  check('rejects a null/undefined row', !normalizeImportProduct(null, CATS).ok && !normalizeImportProduct(undefined, CATS).ok);
  check('rejects a negative price', bad({ price_cents: -1 }));
  check('rejects a FLOAT price (money must be integer cents)', bad({ price_cents: 10.5 }));
  check('rejects a string price', bad({ price_cents: '1000' }));
  check('rejects NaN/Infinity prices', bad({ price_cents: NaN }) && bad({ price_cents: Infinity }));
  check('rejects unknown categories rather than dropping them silently', bad({ categories: ['shoes', 'nope'] }));
  check('a rejection explains why', /unknown categories/.test(normalizeImportProduct(row({ categories: ['nope'] }), CATS).reason));
  check('price 0 is allowed (free item)', normalizeImportProduct(row({ price_cents: 0 }), CATS).ok);
}

// ---- sale pricing: the rule that decides what is charged ----
{
  check('no sale price → charges the list price, not on sale',
    okPatch().price_cents === 1000 && okPatch().on_sale === false && okPatch().sale_price_cents === null);

  const discounted = okPatch({ regular_price_cents: 1000, sale_price_cents: 800 });
  check('a genuine discount is charged and flagged',
    discounted.price_cents === 800 && discounted.on_sale === true && discounted.regular_price_cents === 1000);

  // A feed that sets sale >= regular must NOT be advertised as a discount.
  const fakeEqual = okPatch({ regular_price_cents: 1000, sale_price_cents: 1000 });
  check('sale == regular is NOT a sale', fakeEqual.on_sale === false && fakeEqual.price_cents === 1000);
  const fakeHigher = okPatch({ regular_price_cents: 1000, sale_price_cents: 1200 });
  check('sale > regular is NOT a sale (and never raises the charge)', fakeHigher.on_sale === false && fakeHigher.price_cents === 1000);

  check('regular defaults to the list price when absent', okPatch().regular_price_cents === 1000);
  check('a free sale price (0) still counts as a discount',
    okPatch({ regular_price_cents: 500, sale_price_cents: 0 }).on_sale === true &&
    okPatch({ regular_price_cents: 500, sale_price_cents: 0 }).price_cents === 0);
}

// ---- stock / availability ----
{
  check('null stock = untracked = purchasable', okPatch().stock === null && okPatch().in_stock === true);
  check('stock 0 = out of stock', okPatch({ stock: 0 }).in_stock === false);
  check('positive stock = in stock', okPatch({ stock: 3 }).in_stock === true && okPatch({ stock: 3 }).stock === 3);
}

// ---- status + flags ----
{
  check('draft/archived are preserved', normalizeStatus('draft') === 'draft' && normalizeStatus('archived') === 'archived');
  check('published/unknown/undefined normalize to active',
    normalizeStatus('published') === 'active' && normalizeStatus('bogus') === 'active' && normalizeStatus(undefined) === 'active');
  check('featured is strictly boolean true', okPatch({ featured: true }).featured === true && okPatch({ featured: 'yes' }).featured === false && okPatch().featured === false);
  check('non-numeric position is dropped', okPatch({ position: 'x' }).position === undefined && okPatch({ position: 2 }).position === 2);
}

// ---- untrusted HTML + images ----
{
  const evil = okPatch({ description: '<p>ok</p><script>alert(1)</script>', short_description: '<img src=x onerror=alert(1)>' });
  check('description is sanitized', !/script/i.test(evil.description) && /ok/.test(evil.description));
  check('short_description drops event handlers', !/onerror/i.test(evil.short_description ?? ''));

  /*
   * An import now shares `normalizeImages` with the save path instead of
   * rebuilding entries as `{ src, alt }`. Two consequences, both deliberate:
   *
   *  - The hand-rolled version stripped `kind`, and `importCatalogue` writes
   *    through `updateProduct` rather than `saveProduct`, so nothing put it
   *    back. A feed-driven shop was permanently in the pre-fix state: every
   *    refresh re-created gallery entries with no kind on products that had
   *    been correct an hour before.
   *  - A feed src must now be root-relative or absolute http(s). The old filter
   *    checked only the length, so a compromised or careless feed could put any
   *    string at all into a product's gallery — `javascript:` included.
   *
   * The cost is that a bare relative src like `a.png` is DROPPED rather than
   * stored. It could not have rendered anyway — it would resolve against
   * whatever page happened to display it — and inventing an origin for it would
   * be inventing data.
   */
  const imgs = okPatch({ images: [
    { src: '/uploads/a.png', alt: 'A' },
    { src: '/uploads/' + 'x'.repeat(1200) },
    null,
    { alt: 'no src' },
    { src: 'a.png', alt: 'relative' },
    { src: 'javascript:alert(1)', alt: 'hostile' },
  ] });
  check('oversized/invalid image entries are dropped',
    imgs.images.length === 1 && imgs.images[0].src === '/uploads/a.png');
  check('image alt is preserved', imgs.images[0].alt === 'A');
  check('a relative src is dropped rather than stored unresolvable',
    !imgs.images.some((i) => i.src === 'a.png'));
  check('a hostile scheme from a feed never reaches a product gallery',
    !imgs.images.some((i) => /javascript:/i.test(i.src)));

  // And the reason the normaliser is shared at all: kind survives an import.
  const vid = okPatch({ images: [{ src: '/uploads/a.png' }, { src: '/uploads/clip.mp4' }] });
  check('an imported video is classified, so a feed refresh cannot un-fix a product',
    vid.images.length === 2 && vid.images[1].kind === 'video');
}

// ---- order totals ----
{
  check('sums line totals', orderTotalCents([{ total_cents: 100 }, { total_cents: 250 }]) === 350);
  check('empty order totals 0', orderTotalCents([]) === 0);
  check('stays an integer (no float drift)', Number.isInteger(orderTotalCents([{ total_cents: 1 }, { total_cents: 2 }, { total_cents: 3 }])));
}

// ---- order status vocabulary ----
{
  check('statuses include the lifecycle', ['pending', 'processing', 'completed', 'cancelled', 'refunded'].every((s) => ORDER_STATUSES.includes(s)));
  check('cancelled + refunded release stock', STOCK_RELEASED_STATUSES.includes('cancelled') && STOCK_RELEASED_STATUSES.includes('refunded'));
  check('releasesStock() agrees with the list', releasesStock('cancelled') && releasesStock('refunded') && !releasesStock('pending') && !releasesStock('completed'));
}

// ---- the commerce master switch: opens public WRITE endpoints, so only
// deliberate spellings of "on" may count; everything else is off ----
{
  const on = (v) => resolveCommerceEnabled({ [COMMERCE_ENABLED_KEY]: v });

  check('commerce switch: absent means off',
    resolveCommerceEnabled({}) === false &&
    resolveCommerceEnabled(null) === false &&
    resolveCommerceEnabled(undefined) === false);
  check('commerce switch: true / "true" / "1" / 1 mean on',
    on(true) && on('true') && on('1') && on(1));
  check('commerce switch: the string "false" is OFF (never !!-truthy)',
    on('false') === false && on('0') === false);
  check('commerce switch: corrupt or hostile values are off',
    on('yes') === false && on([]) === false && on({}) === false &&
    on('TRUE') === false && on(2) === false && on(null) === false);
}

// ---- the shop currency: frozen onto every future order, so a wrong value here
// is wrong money on real invoices ----
{
  const cur = (v) => resolveShopCurrency({ [SHOP_CURRENCY_KEY]: v });

  // `placeOrder()` used to write the LITERAL 'EUR', which made every install on
  // earth a euro shop while the money formatter happily handled any currency —
  // so the platform looked multi-currency and was not.
  check('currency: unset falls back to the documented default',
    resolveShopCurrency({}) === 'EUR' && resolveShopCurrency(null) === 'EUR'
    && resolveShopCurrency(undefined) === 'EUR');
  check('currency: a real code is used', cur('GBP') === 'GBP');
  check('currency: case and whitespace are normalised', cur('  gbp  ') === 'GBP');
  check('currency: a zero-decimal currency is just a code here', cur('JPY') === 'JPY');

  // A bad code would be frozen onto every future order, so the fallback — not
  // the operator's typo — is what reaches the books. The write door refuses it
  // separately, so this is the second line of defence rather than the only one.
  check('currency: a symbol is not a code', cur('€') === 'EUR' && cur('$') === 'EUR');
  check('currency: the wrong length is refused',
    cur('EU') === 'EUR' && cur('EURO') === 'EUR');
  check('currency: digits are refused', cur('EU1') === 'EUR' && cur('123') === 'EUR');
  check('currency: a non-string is refused',
    cur(978) === 'EUR' && cur(null) === 'EUR' && cur({}) === 'EUR' && cur([]) === 'EUR');
  check('currency: empty and whitespace fall back', cur('') === 'EUR' && cur('   ') === 'EUR');
}

// ---- order limits: they gate a PUBLIC endpoint, so resolution must never
// produce an absent, zero, or unbounded cap no matter what the settings say ----
{
  const K = ORDER_LIMIT_KEYS;
  const lim = (over) => resolveOrderLimits(over);

  check('defaults are 3 per product / 50 items',
    ORDER_LIMIT_DEFAULTS.maxQtyPerProduct === 3 && ORDER_LIMIT_DEFAULTS.maxItemsPerOrder === 50);
  check('missing settings → defaults',
    lim(null).maxQtyPerProduct === 3 && lim(undefined).maxQtyPerProduct === 3 && lim({}).maxItemsPerOrder === 50);
  check('a configured value is honoured', lim({ [K.maxQtyPerProduct]: 10 }).maxQtyPerProduct === 10);
  check('numeric strings are accepted (settings round-trip as JSON)', lim({ [K.maxQtyPerProduct]: '7' }).maxQtyPerProduct === 7);
  check('fractions floor', lim({ [K.maxQtyPerProduct]: 4.9 }).maxQtyPerProduct === 4);

  // The hostile/corrupt cases: none may disable or unbound the cap.
  check('0 clamps up to the minimum (never "unlimited")', lim({ [K.maxQtyPerProduct]: 0 }).maxQtyPerProduct === ORDER_LIMIT_BOUNDS.maxQtyPerProduct.min);
  check('negative clamps up', lim({ [K.maxQtyPerProduct]: -5 }).maxQtyPerProduct === ORDER_LIMIT_BOUNDS.maxQtyPerProduct.min);
  check('absurdly large clamps down to the ceiling', lim({ [K.maxQtyPerProduct]: 1e9 }).maxQtyPerProduct === ORDER_LIMIT_BOUNDS.maxQtyPerProduct.max);
  check('Infinity/NaN fall back to the default',
    lim({ [K.maxQtyPerProduct]: Infinity }).maxQtyPerProduct === 3 && lim({ [K.maxQtyPerProduct]: NaN }).maxQtyPerProduct === 3);
  check('non-numeric junk falls back to the default',
    lim({ [K.maxQtyPerProduct]: 'lots' }).maxQtyPerProduct === 3 &&
    lim({ [K.maxQtyPerProduct]: {} }).maxQtyPerProduct === 3 &&
    lim({ [K.maxQtyPerProduct]: null }).maxQtyPerProduct === 3);
  check('items-per-order clamps independently',
    lim({ [K.maxItemsPerOrder]: 0 }).maxItemsPerOrder === ORDER_LIMIT_BOUNDS.maxItemsPerOrder.min &&
    lim({ [K.maxItemsPerOrder]: 99999 }).maxItemsPerOrder === ORDER_LIMIT_BOUNDS.maxItemsPerOrder.max);
  check('the two limits do not interfere',
    lim({ [K.maxQtyPerProduct]: 9 }).maxItemsPerOrder === 50 && lim({ [K.maxItemsPerOrder]: 9 }).maxQtyPerProduct === 3);
  check('result is always a positive integer pair', (() => {
    for (const v of [0, -1, 1e12, 'x', null, undefined, {}, NaN, 2.5]) {
      const r = lim({ [K.maxQtyPerProduct]: v, [K.maxItemsPerOrder]: v });
      if (!Number.isInteger(r.maxQtyPerProduct) || r.maxQtyPerProduct < 1) return false;
      if (!Number.isInteger(r.maxItemsPerOrder) || r.maxItemsPerOrder < 1) return false;
    }
    return true;
  })());
}

/* ------------------------------------------------------------------ *
 * Extended product fields (WooCommerce/Shopify parity)
 * ------------------------------------------------------------------ */
{
  const {
    normalizeMeasurement, normalizeBackorders, normalizeCatalogVisibility, normalizeTaxStatus,
    normalizeClassSlug, normalizeGtin, normalizeTags, normalizeDimensions, normalizeAttributes,
    normalizeDownloads, normalizeLinkedIds, normalizeImages, setMainImage, mainImage,
    availableFor, isLowStock, saleActiveAt, WRITABLE_PRODUCT_FIELDS,
    pickWritableProductFields, PRODUCT_LIMITS,
  } = PF;

  // ---- enums fall back to the SAFE member, never to what was typed ----
  check('an unknown backorder policy falls back to "no" (cannot oversell)',
    normalizeBackorders('yes-please') === 'no' && normalizeBackorders(undefined) === 'no' &&
    normalizeBackorders(true) === 'no' && normalizeBackorders('YES') === 'no');
  check('valid backorder policies pass through',
    normalizeBackorders('yes') === 'yes' && normalizeBackorders('notify') === 'notify');
  check('catalog visibility defaults to visible', normalizeCatalogVisibility('nope') === 'visible');
  check('tax status defaults to taxable', normalizeTaxStatus('nope') === 'taxable');

  // ---- measurements are integers, bounded ----
  check('a float weight is rounded, not stored as a float',
    normalizeMeasurement(1500.6, PRODUCT_LIMITS.maxWeightGrams) === 1501);
  check('numeric strings are accepted', normalizeMeasurement('250', 10000) === 250);
  check('negative and junk become null',
    normalizeMeasurement(-5, 100) === null && normalizeMeasurement('heavy', 100) === null &&
    normalizeMeasurement(NaN, 100) === null && normalizeMeasurement(Infinity, 100) === null);
  check('empty/absent becomes null',
    normalizeMeasurement('', 100) === null && normalizeMeasurement(null, 100) === null &&
    normalizeMeasurement(undefined, 100) === null);
  check('an absurd measurement is capped', normalizeMeasurement(9e9, 1000) === 1000);

  // ---- dimensions: all three or none ----
  check('a complete box is kept', (() => {
    const d = normalizeDimensions({ length_mm: 200, width_mm: 100, height_mm: 50 });
    return d && d.length_mm === 200 && d.height_mm === 50;
  })());
  check('a PARTIAL box is rejected outright (a shipping integration would guess)',
    normalizeDimensions({ length_mm: 200, width_mm: 100 }) === null);
  check('junk dimensions are null',
    normalizeDimensions(null) === null && normalizeDimensions('big') === null);

  // ---- slug-like fields reach lookups, so they are constrained ----
  check('a normal class slug is kept', normalizeClassSlug('reduced-rate') === 'reduced-rate');
  check('class slugs are lower-cased', normalizeClassSlug('Reduced-Rate') === 'reduced-rate');
  check('a class slug with markup or spaces is refused',
    normalizeClassSlug('<script>') === undefined && normalizeClassSlug('two words') === undefined &&
    normalizeClassSlug('../etc') === undefined);

  // ---- GTIN is a barcode, not free text ----
  check('a valid EAN is kept', normalizeGtin('4006381333931') === '4006381333931');
  check('spaces are stripped from a barcode', normalizeGtin('4006 3813 33931') === '4006381333931');
  check('a non-numeric barcode is refused',
    normalizeGtin('ABC123') === undefined && normalizeGtin('<script>1</script>') === undefined);

  // ---- tags ----
  check('tags are trimmed and de-duplicated',
    normalizeTags([' sun ', 'sun', 'polarised']).length === 2);
  check('tags are capped', normalizeTags(Array.from({ length: 200 }, (_, i) => `t${i}`)).length === PRODUCT_LIMITS.tags);
  check('non-array tags become an empty list', normalizeTags('sun').length === 0);

  // ---- downloads are handed to a paying customer to CLICK ----
  const downloads = normalizeDownloads([
    { name: 'Manual', url: 'https://cdn.example.com/manual.pdf' },
    { name: 'Own media', url: '/media/uploads/guide.pdf' },
    { name: 'XSS', url: 'javascript:alert(1)' },
    { name: 'Local', url: 'file:///etc/passwd' },
    { name: 'Insecure', url: 'http://cdn.example.com/x.pdf' },
    { name: 'No url' },
  ]);
  check('only https and own-media downloads survive', downloads.length === 2);
  check('a javascript: download is dropped', !downloads.some((d) => /javascript:/i.test(d.url)));
  check('a file: download is dropped', !downloads.some((d) => /^file:/i.test(d.url)));
  check('a plain-http download is dropped', !downloads.some((d) => /^http:\/\//i.test(d.url)));
  check('a download without a name gets one', normalizeDownloads([{ url: 'https://x.example/a' }])[0].name === 'Download');

  // ---- linked ids are rendered as links ----
  check('valid linked ids are kept', normalizeLinkedIds(['abc-123', 'def_456']).length === 2);
  check('injection-shaped linked ids are dropped',
    normalizeLinkedIds(['<script>', '../x', 'a b', 'https://evil.example']).length === 0);
  check('a product cannot link to ITSELF', normalizeLinkedIds(['self', 'other'], 'self').join() === 'other');
  check('linked ids are de-duplicated', normalizeLinkedIds(['a', 'a', 'b']).length === 2);

  // ---- images: index 0 is the main image ----
  const imgs = normalizeImages([
    { src: '/media/a.jpg', alt: 'A' },
    { src: 'https://cdn.example.com/b.jpg' },
    { src: '/media/a.jpg' },                 // duplicate
    { src: 'javascript:alert(1)' },
    { src: 'data:image/png;base64,AAAA' },
    { alt: 'no src' },
  ]);
  check('valid images survive, duplicates and hostile srcs do not', imgs.length === 2);
  check('a javascript: image src is dropped', !imgs.some((i) => /javascript:/i.test(i.src)));
  check('a data: image src is dropped (it is not a media reference)', !imgs.some((i) => /^data:/i.test(i.src)));
  check('image order is preserved so index 0 stays the main image', imgs[0].src === '/media/a.jpg');
  check('mainImage returns the first', mainImage(imgs).src === '/media/a.jpg');
  check('mainImage of an empty list is undefined', mainImage([]) === undefined && mainImage(undefined) === undefined);

  const reordered = setMainImage(imgs, 1);
  check('setMainImage promotes the chosen photo', reordered[0].src === 'https://cdn.example.com/b.jpg');
  check('setMainImage keeps every other photo', reordered.length === imgs.length);
  check('setMainImage on index 0 or out of range is a no-op',
    setMainImage(imgs, 0) === imgs && setMainImage(imgs, 99) === imgs && setMainImage(imgs, -1) === imgs);

  // ---- attributes ----
  const attrs = normalizeAttributes([
    { name: 'Colour', values: ['Black', 'Tortoise'] },
    { name: 'Empty', values: [] },
    { name: '', values: ['x'] },
    { name: 'Hidden', values: ['x'], visible: false },
    'not an object',
  ]);
  check('attributes with values are kept', attrs.length === 2);
  check('an attribute with no values is dropped', !attrs.some((a) => a.name === 'Empty'));
  check('attributes are visible by default', attrs.find((a) => a.name === 'Colour').visible === true);
  check('visible:false is respected', attrs.find((a) => a.name === 'Hidden').visible === false);

  // ---- availability: three rules interacting ----
  check('untracked stock is always available', availableFor({ stock: null }, 99).ok);
  check('enough stock is available', availableFor({ stock: 5 }, 3).ok);
  check('too little stock is refused when backorders are off',
    !availableFor({ stock: 1, backorders: 'no' }, 3).ok);
  check('backorders allow selling past zero',
    availableFor({ stock: 0, backorders: 'yes' }, 3).ok &&
    availableFor({ stock: 0, backorders: 'notify' }, 3).ok);
  check('an ABSENT backorder policy behaves as "no"', !availableFor({ stock: 0 }, 1).ok);
  check('sold_individually caps the line at 1 even with plenty of stock',
    !availableFor({ stock: 100, sold_individually: true }, 2).ok &&
    availableFor({ stock: 100, sold_individually: true }, 1).ok);
  check('sold_individually beats a backorder policy',
    !availableFor({ stock: 100, sold_individually: true, backorders: 'yes' }, 2).ok);
  check('a non-positive quantity is always refused',
    !availableFor({ stock: 10 }, 0).ok && !availableFor({ stock: 10 }, -1).ok && !availableFor({ stock: 10 }, 1.5).ok);

  // The rejection CODE decides the HTTP status, and the two kinds are not
  // interchangeable: a policy refusal is a permanent 400, running out of stock
  // is a retryable 409. Collapsing them tells a client not to retry something
  // it should. (This regressed once; hence the assertion.)
  check('running out of stock is reported as a CONFLICT, not a bad request',
    availableFor({ stock: 1, backorders: 'no' }, 3).code === 'insufficient-stock');
  check('a policy refusal is reported as a bad request, not a conflict',
    availableFor({ stock: 100, sold_individually: true }, 2).code === 'sold-individually' &&
    availableFor({ stock: 10 }, 0).code === 'invalid-quantity');

  // ---- low stock ----
  check('at or below the threshold is low', isLowStock({ stock: 2, low_stock_threshold: 2 }) &&
    isLowStock({ stock: 1, low_stock_threshold: 2 }));
  check('above the threshold is not low', !isLowStock({ stock: 5, low_stock_threshold: 2 }));
  check('no threshold means never low', !isLowStock({ stock: 0 }) && !isLowStock({ stock: 0, low_stock_threshold: null }));
  check('untracked stock is never low', !isLowStock({ stock: null, low_stock_threshold: 5 }));

  // ---- scheduled sales ----
  const T = Date.parse('2026-06-15T12:00:00Z');
  check('no schedule returns null (the stored flag stands alone)',
    saleActiveAt({}, T) === null);
  check('inside the window is active',
    saleActiveAt({ sale_starts_at: '2026-06-01', sale_ends_at: '2026-06-30' }, T) === true);
  check('before the start is not active',
    saleActiveAt({ sale_starts_at: '2026-07-01' }, T) === false);
  check('after the end is not active',
    saleActiveAt({ sale_ends_at: '2026-06-01' }, T) === false);
  check('an open-ended start still works', saleActiveAt({ sale_starts_at: '2026-01-01' }, T) === true);

  // ---- the shared write allow-list ----
  check('server-owned fields are NOT writable', (() => {
    const forbidden = ['id', 'created_at', 'updated_at', 'on_sale', 'in_stock'];
    return forbidden.every((f) => !WRITABLE_PRODUCT_FIELDS.includes(f));
  })());
  check('the Woo-parity fields ARE writable', (() => {
    const wanted = ['sku', 'gtin', 'tags', 'weight_grams', 'dimensions_mm', 'backorders',
      'sold_individually', 'tax_status', 'tax_class', 'shipping_class', 'virtual',
      'downloadable', 'downloads', 'upsell_ids', 'cross_sell_ids', 'attributes',
      'purchase_note', 'catalog_visibility', 'low_stock_threshold', 'images'];
    return wanted.every((f) => WRITABLE_PRODUCT_FIELDS.includes(f));
  })());
  check('picking drops unknown and server-owned keys', (() => {
    const picked = pickWritableProductFields({
      name: 'X', id: 'hacked', on_sale: true, created_at: 'x', __proto__: {}, nope: 1, sku: 'S1',
    });
    return picked.name === 'X' && picked.sku === 'S1' &&
      !('id' in picked) && !('on_sale' in picked) && !('created_at' in picked) && !('nope' in picked);
  })());
  check('picking a non-object is empty', Object.keys(pickWritableProductFields(null)).length === 0);
}

/* ------------------------------------------------------------------ *
 * The sale rule — derived, shared, and the same on every write path
 *
 * `on_sale` is documented as server-derived and nothing on the products API
 * derived it: it was computed only in the CSV importer and hardcoded false on
 * create. A manager could set a sale price on 400 products and no shopper ever
 * saw a discount — no strikethrough, no badge, and `?on_sale=true` empty. It
 * never errored, which is what made it expensive.
 * ------------------------------------------------------------------ */
{
  const { deriveSaleState, deriveInStock } = PF;

  // A fixed clock: these assertions are about prices, and Date.now() would make
  // the scheduled-window cases flap depending on when CI ran.
  const T = Date.parse('2026-06-15T12:00:00Z');
  const d = (patch, stored) => deriveSaleState(patch, stored, T);

  // ---- create ----
  const created = d({ price_cents: 12900, regular_price_cents: 15900, sale_price_cents: 12900 });
  check('create with a genuine discount is on sale',
    created.on_sale === true && created.price_cents === 12900 && created.regular_price_cents === 15900);

  const plain = d({ price_cents: 1000 });
  check('create with only a price is not on sale, and price becomes regular',
    plain.on_sale === false && plain.price_cents === 1000 && plain.regular_price_cents === 1000);

  // ---- update INTO a sale, as a PARTIAL patch ----
  // The case most likely to be missed: only sale_price_cents is sent, so the
  // regular price has to come from what is STORED, not from the empty patch.
  const stored = { price_cents: 15900, regular_price_cents: 15900, sale_price_cents: null };
  const intoSale = d({ sale_price_cents: 11900 }, stored);
  check('a partial PUT of only sale_price_cents is judged against the STORED regular',
    intoSale.on_sale === true && intoSale.price_cents === 11900 && intoSale.regular_price_cents === 15900);

  // ---- update OUT of a sale ----
  const onSale = { price_cents: 11900, regular_price_cents: 15900, sale_price_cents: 11900 };
  const cleared = d({ sale_price_cents: null }, onSale);
  check('clearing sale_price_cents ends the sale and restores the regular price',
    cleared.on_sale === false && cleared.price_cents === 15900);

  // ---- a "sale" that is not a discount ----
  const notCheaper = d({ sale_price_cents: 15900 }, stored);
  check('a sale price equal to regular is NOT a sale',
    notCheaper.on_sale === false && notCheaper.price_cents === 15900);
  const dearer = d({ sale_price_cents: 20000 }, stored);
  check('a sale price ABOVE regular is not advertised, and price falls back to regular',
    dearer.on_sale === false && dearer.price_cents === 15900);

  // ---- 0 is a price, not "absent" ----
  const free = d({ sale_price_cents: 0 }, stored);
  check('sale_price_cents: 0 is a free item, not a falsy miss',
    free.on_sale === true && free.price_cents === 0);

  // ---- no regular price ever set ----
  const neverHadRegular = d({ sale_price_cents: 900 }, { price_cents: 1000 });
  check('a product with no regular price can still go on sale (price_cents is the regular)',
    neverHadRegular.on_sale === true && neverHadRegular.regular_price_cents === 1000 &&
    neverHadRegular.price_cents === 900);

  // ---- an operator setting the price must not be silently reverted ----
  const repriced = d({ price_cents: 13900 }, { price_cents: 15900, regular_price_cents: 15900 });
  check('a supplied price_cents with no regular becomes the new regular',
    repriced.regular_price_cents === 13900 && repriced.price_cents === 13900);

  // ---- the scheduled window ----
  // saleActiveAt() had no production caller, so deriving on_sale from price
  // alone would have taken every sale scheduled for next month and made it live
  // TODAY — and price_cents follows on_sale, so that charges the sale price
  // early. This is the guard against that.
  const future = d({ sale_price_cents: 11900, sale_starts_at: '2026-12-01' }, stored);
  check('a sale scheduled for the future is not live yet, and does not change the price',
    future.on_sale === false && future.price_cents === 15900);
  const expired = d({ sale_price_cents: 11900, sale_ends_at: '2026-01-01' }, stored);
  check('a sale whose window has ended is not live', expired.on_sale === false);
  const live = d({ sale_price_cents: 11900, sale_starts_at: '2026-06-01', sale_ends_at: '2026-06-30' }, stored);
  check('a sale inside its window is live', live.on_sale === true && live.price_cents === 11900);
  const noWindow = d({ sale_price_cents: 11900 }, stored);
  check('no window configured means the price decides on its own', noWindow.on_sale === true);

  // ---- in_stock, the sibling in the same doc comment ----
  check('stock 0 is out of stock', deriveInStock({ stock: 0 }) === false);
  check('positive stock is in stock', deriveInStock({ stock: 3 }) === true);
  check('null stock is untracked and always purchasable', deriveInStock({ stock: null }) === true);
  check('an absent stock in a partial patch uses the stored value',
    deriveInStock({}, { stock: 0 }) === false && deriveInStock({}, { stock: 5 }) === true);
  check('a product that never had stock is untracked', deriveInStock({}, {}) === true);

  // ---- THE anti-drift assertion ----
  // The API path and the importer disagreeing about what a sale is, is the
  // whole bug. They now share deriveSaleState(), and this pins them: identical
  // input must give identical on_sale AND price_cents. If someone re-inlines
  // the rule in either place, this fails.
  let sameOnAllPaths = true;
  const details = [];
  for (const c of [
    { price_cents: 1000, regular_price_cents: 1000, sale_price_cents: null },
    { price_cents: 1000, regular_price_cents: 1500, sale_price_cents: 1000 },
    { price_cents: 1500, regular_price_cents: 1500, sale_price_cents: 1500 },
    { price_cents: 1500, regular_price_cents: 1500, sale_price_cents: 2000 },
    { price_cents: 1000, regular_price_cents: 1000, sale_price_cents: 0 },
    { price_cents: 1200, regular_price_cents: undefined, sale_price_cents: 900 },
  ]) {
    const viaApi = deriveSaleState(c);
    const viaImport = okPatch({ ...c, slug: 'x', name: 'X' });
    if (!viaImport ||
        viaImport.on_sale !== viaApi.on_sale ||
        viaImport.price_cents !== viaApi.price_cents) {
      sameOnAllPaths = false;
      details.push(`${JSON.stringify(c)} api=${viaApi.on_sale}/${viaApi.price_cents} import=${viaImport?.on_sale}/${viaImport?.price_cents}`);
    }
  }
  check('the API path and the import path agree on on_sale AND price_cents' +
    (details.length ? ` — ${details.join(' | ')}` : ''), sameOnAllPaths);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
