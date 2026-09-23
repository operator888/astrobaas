#!/usr/bin/env node
/**
 * The WooCommerce planner (src/lib/import/woo.ts).
 *
 * A shop import is different from a blog import in one way that matters: it
 * carries MONEY. A price that silently becomes 0, an unpaid order that arrives
 * marked completed, a staff member imported as a customer — each is a quiet
 * wrong answer that an owner acts on, and none of them look like a bug at the
 * time.
 *
 * So most of this file is about what the planner REFUSES.
 *
 * Run with:  node tests/woo-plan.test.mjs
 */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const cacheDir = path.join(root, 'node_modules', '.cache');
await fs.mkdir(cacheDir, { recursive: true });
const out = path.join(cacheDir, `astrobaas-woo-${process.pid}.mjs`);
await build({
  entryPoints: [path.join(root, 'src/lib/import/woo.ts')],
  bundle: true, format: 'esm', platform: 'node', packages: 'external',
  outfile: out, logLevel: 'silent',
});
const W = await import(pathToFileURL(out).href);
await fs.rm(out, { force: true });

let pass = 0;
let fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };

/* ---- money ---- */
{
  const c = W.centsOrNull;
  check('an integer number of cents is accepted', c(1999) === 1999);
  check('zero is a price, not a missing one', c(0) === 0);
  check('a digit string is accepted', c('1999') === 1999);
  // The one that matters. 19.99 is what a naive dump parser emits, and
  // accepting it would put a €0.20 product in somebody's shop.
  check('a FLOAT is refused rather than rounded', c(19.99) === null);
  check('a decimal string is refused', c('19.99') === null);
  check('a comma decimal is refused', c('19,99') === null);
  check('a negative amount is refused', c(-500) === null);
  check('null is refused', c(null) === null);
  check('undefined is refused', c(undefined) === null);
  check('NaN is refused', c(NaN) === null);
  check('Infinity is refused', c(Infinity) === null);
  check('a number beyond safe integers is refused', c(2 ** 53) === null);
  check('an empty string is refused', c('') === null);
  check('a string with letters is refused', c('19abc') === null);
}

/* ---- order status ---- */
{
  const m = W.mapOrderStatus;
  check('wc-completed → completed', m('wc-completed') === 'completed');
  check('the un-prefixed spelling works too', m('completed') === 'completed');
  check('wc-processing → processing', m('wc-processing') === 'processing');
  check('wc-refunded → refunded', m('wc-refunded') === 'refunded');
  // The model HAS these states, so they map to themselves. Flattening them to
  // pending — the first version — put imported history in the one status the
  // abandonment sweep is allowed to cancel.
  check('failed stays failed, not cancelled', m('wc-failed') === 'failed');
  check('on-hold stays on-hold — untouchable by every automatic process',
    m('wc-on-hold') === 'on-hold');
  check('a real wc-pending is still pending', m('wc-pending') === 'pending');
  // A word this system does not speak translates to "a human needs to look",
  // never to pending (the sweep's kill zone) and never to completed (a lie).
  check('an unknown status → on-hold, never pending or completed',
    m('wc-something-new') === 'on-hold' && m('wc-shipped') === 'on-hold');
  check('a missing status → on-hold', m(undefined) === 'on-hold');
}

/* ---- dates ---- */
{
  const d = W.isoOrUndefined;
  check('a MySQL datetime is read as UTC', d('2024-03-05 09:30:00') === '2024-03-05T09:30:00.000Z');
  check('the zero date means "never", not 1970', d('0000-00-00 00:00:00') === undefined);
  check('an unparseable date is undefined, not Invalid Date', d('whenever') === undefined);
  check('a missing date is undefined rather than now', d(undefined) === undefined);
}

/* ---- image paths ---- */
{
  const s = W.safeImagePath;
  check('a relative path is kept', s('2024/03/frame.jpg') === '2024/03/frame.jpg');
  check('a ./ prefix is normalised away', s('./2024/frame.jpg') === '2024/frame.jpg');
  check('a traversal is refused', s('../../etc/passwd') === null);
  check('a traversal in the middle is refused', s('2024/../../etc/passwd') === null);
  check('a backslash traversal is refused', s('..\\..\\windows\\system32') === null);
  check('an absolute path is refused', s('/etc/passwd') === null);
  check('a Windows drive path is refused', s('C:\\secrets.txt') === null);
  check('a URL is refused — this field is a dump path', s('https://evil.example/x.jpg') === null);
  check('a NUL byte is refused', s('frame\u0000.jpg') === null);
  check('an empty path is refused', s('') === null);
}

/* ---- products ---- */
{
  const plan = W.planWooImport({
    products: [
      { wp_id: '1', name: 'Titanium frame', slug: 'titanium-frame', price_cents: 19900, in_stock: 'yes', categories: ['Frames'], brand: 'Ray Ban', images: [{ rel: '2024/f.jpg' }, { rel: '../escape.jpg' }] },
      { wp_id: '2', name: 'Broken price', price_cents: 19.99 },
      { wp_id: '3', price_cents: 100 },
      { wp_id: '4', name: 'Titanium frame', price_cents: 5000 },
    ],
  });
  check('a well-formed product is planned', plan.products.length === 2);
  const p = plan.products[0];
  check('the price survives as cents', p.priceCents === 19900);
  check('"yes" is read as in stock', p.inStock === true);
  check('an untracked stock stays null, which is not zero', p.stock === null);
  check('category names are slugified', p.categorySlugs.join() === 'frames');
  // The NAME, not a slug: identity is brandKey's job, and a slug is lossy.
  check('the brand keeps the name the shop gave it', p.brand === 'Ray Ban');
  check('a safe image path is kept', p.imagePaths.includes('2024/f.jpg'));
  check('a traversing image path is dropped, not passed on',
    p.imagePaths.every((x) => !x.includes('..')));
  check('a product with an unparseable price is SKIPPED, not priced at zero',
    plan.skipped.some((s) => s.label === 'Broken price' && /whole number of cents/.test(s.reason)));
  check('a nameless product is skipped with a reason',
    plan.skipped.some((s) => s.kind === 'product' && /no name/.test(s.reason)));
  check('two products with the same name do not collide on slug',
    plan.products[1].slug === 'titanium-frame-2');
}

/* ---- on_sale is not taken on trust ---- */
{
  const plan = W.planWooImport({
    products: [
      { wp_id: '1', name: 'Claims a sale, has no sale price', price_cents: 1000, on_sale: 'yes' },
      { wp_id: '2', name: 'A real sale', price_cents: 800, regular_price_cents: 1000, sale_price_cents: 800, on_sale: true },
    ],
  });
  check('on_sale without a sale price is not a sale — nothing to strike through',
    plan.products[0].onSale === false);
  check('a real sale is a sale', plan.products[1].onSale === true);
  check('the regular price is carried so the discount can be shown',
    plan.products[1].regularPriceCents === 1000);
}

/* ---- customers ---- */
{
  const plan = W.planWooImport({
    customers: [
      { wp_id: '1', email: 'Maria@Example.com', name: 'Maria' },
      { wp_id: '2', email: 'maria@example.com', name: 'Maria again' },
      { wp_id: '3', email: 'owner@shop.gr', role: 'admin' },
      { wp_id: '4', name: 'No email' },
      { wp_id: '5', email: 'not-an-email' },
    ],
  });
  check('a customer is planned once', plan.customers.length === 1);
  check('the email is lower-cased so a re-import matches it',
    plan.customers[0].email === 'maria@example.com');
  check('a duplicate email is not planned twice', !plan.customers.some((c) => c.name === 'Maria again'));
  // The shop's WordPress user table contains its staff. Importing the owner as
  // a customer puts their home address in the customer list.
  check('a WordPress administrator is NOT imported as a customer',
    plan.skipped.some((s) => s.kind === 'customer' && /staff/.test(s.reason)));
  check('a customer with no email is skipped with a reason',
    plan.skipped.some((s) => s.kind === 'customer' && /no usable email/.test(s.reason)));
  check('a malformed email is skipped', plan.skipped.filter((s) => /no usable email/.test(s.reason)).length === 2);
}

/* ---- orders ---- */
{
  const plan = W.planWooImport({
    orders: [
      {
        wp_id: '500', status: 'wc-completed', currency: 'eur', total_cents: 19900,
        customer_wp_id: '1', email: 'maria@example.com', created_at: '2024-03-05 09:30:00',
        items: [
          { product_wp_id: '1', name: 'Titanium frame', qty: 1, total_cents: 19900 },
          { product_wp_id: '9', name: 'Broken line', qty: 1, total_cents: 12.5 },
        ],
      },
      { wp_id: '501', total_cents: 'not money' },
      { status: 'wc-completed', total_cents: 100 },
    ],
  });
  check('a well-formed order is planned', plan.orders.length === 1);
  const o = plan.orders[0];
  check('the order number is derived from the WooCommerce id', o.number === 'WC-500');
  check('the currency is normalised to an uppercase code', o.currency === 'EUR');
  check('the total survives as cents', o.totalCents === 19900);
  check('the order date is kept', o.createdAt === '2024-03-05T09:30:00.000Z');
  check('a line whose money will not parse is dropped, not zeroed', o.items.length === 1);
  check('an order whose total will not parse is skipped',
    plan.skipped.some((s) => s.kind === 'order' && /whole number of cents/.test(s.reason)));
  check('an order with no id is skipped — there is nothing to key a re-run on',
    plan.skipped.some((s) => s.kind === 'order' && /no WooCommerce id/.test(s.reason)));
}

/* ---- staff arrive in every spelling a dump parser emits ---- */
{
  const plan = W.planWooImport({
    customers: [
      { wp_id: '1', email: 'a@shop.gr', role: 'Administrator' },
      { wp_id: '2', email: 'b@shop.gr', roles: ['administrator'] },
      { wp_id: '3', email: 'c@shop.gr', role: 'shop_manager' },
      { wp_id: '4', email: 'd@shop.gr', role: 'editor' },
      { wp_id: '5', email: 'e@shop.gr', role: 'customer' },
      { wp_id: '6', email: 'f@shop.gr', role: 'subscriber' },
    ],
  });
  check('capitalised, array-shaped and manager roles are all staff',
    plan.customers.length === 2);
  check('...and customers/subscribers still come through',
    plan.customers.map((c) => c.email).sort().join() === 'e@shop.gr,f@shop.gr');
}

/* ---- a sale is a SAVING ---- */
{
  const plan = W.planWooImport({
    products: [
      { wp_id: '1', name: 'No saving', price_cents: 1000, regular_price_cents: 1000, sale_price_cents: 1000, on_sale: 'yes' },
      { wp_id: '2', name: 'Worse than regular', price_cents: 800, regular_price_cents: 800, sale_price_cents: 5000, on_sale: 'yes' },
      { wp_id: '3', name: 'No regular to compare', price_cents: 800, sale_price_cents: 700, on_sale: 'yes' },
      { wp_id: '4', name: 'Real sale', price_cents: 800, regular_price_cents: 1000, sale_price_cents: 800, on_sale: 'yes' },
    ],
  });
  const by = (n) => plan.products.find((p) => p.name === n);
  check('a sale price equal to the regular one is not a sale',
    by('No saving').onSale === false && by('No saving').salePriceCents === null);
  check('a sale price ABOVE the regular one is not a sale either',
    by('Worse than regular').onSale === false && by('Worse than regular').salePriceCents === null);
  check('no regular price means nothing to strike through — no sale',
    by('No regular to compare').onSale === false);
  check('a genuine saving still is one', by('Real sale').onSale === true);
}

/* ---- garbage currencies do not reach financial records ---- */
{
  const cur = (v) => W.planWooImport({ orders: [{ wp_id: '1', total_cents: 100, currency: v }] }).orders[0].currency;
  check('a real code passes', cur('gbp') === 'GBP');
  check("'us dollars' does not become 'US '", cur('us dollars') === 'EUR');
  check('a one-letter fragment falls back', cur('e') === 'EUR');
  check('digits fall back', cur('123') === 'EUR');
}

/* ---- a duplicate wp_id inside one dump is REPORTED, not vanished ---- */
{
  const plan = W.planWooImport({
    orders: [
      { wp_id: '500', total_cents: 100 },
      { wp_id: '500', total_cents: 200 },
    ],
  });
  check('the first is planned', plan.orders.length === 1);
  check('the second is skipped WITH a reason — the file rule holds',
    plan.skipped.some((s) => s.kind === 'order' && /duplicate wp_id/.test(s.reason)));
}

/* ---- product categories resolve to the record that will exist ---- */
{
  const plan = W.planWooImport({
    categories: [{ name: 'Sunglasses', slug: 'sunglasses-2' }],
    products: [{ wp_id: '1', name: 'Aviator', price_cents: 100, categories: ['Sunglasses'] }],
  });
  check("a product filed by NAME lands in the dump's actual slug",
    plan.products[0].categorySlugs.join() === 'sunglasses-2');
}

/* ---- brands keep their names, in every script ---- */
//
// Both live shops write Greek. The planner used to put a product's brand AND
// the brand record's slug through `slugifyImported`, which keeps only [a-z0-9]
// and does not transliterate — so a Greek, Cyrillic or CJK brand became '',
// its products arrived with NO brand and its record was skipped, while
// `Ørgreen` became `rgreen` and `Straße` became `stra-e` on the product
// itself. Reproduced by execution before the fix, on all three drivers.
//
// What WordPress really stores for a non-Latin term: `sanitize_title` →
// `utf8_uri_encode`, lowercase hex. That is what a dump read from wp_terms
// carries in `slug`.
const wpSlug = (name) => encodeURIComponent(name.toLowerCase().replace(/\s+/g, '-')).toLowerCase();
{
  const names = ['Όψη Οπτικά', 'Straße', 'Ørgreen', 'Кураж', '眼鏡'];
  const plan = W.planWooImport({
    brands: [...names.map((name) => ({ name })), { name: 'Γυαλιά Ηλίου', slug: wpSlug('Γυαλιά Ηλίου') }],
    products: [...names, 'Γυαλιά Ηλίου'].map((brand, i) => ({ wp_id: String(i + 1), name: `Frame ${i + 1}`, price_cents: 100, brand })),
  });
  const rec = (n) => plan.brands.find((b) => b.name === n);
  const brandOf = (i) => plan.products.find((p) => p.wpId === String(i))?.brand;
  check('a Greek brand is planned, with a transliterated slug', rec('Όψη Οπτικά')?.slug === 'opsi-optika');
  check('...and its product keeps the brand, in Greek, rather than none', brandOf(1) === 'Όψη Οπτικά');
  check('Straße keeps its ß: the record is "strasse", the product "Straße" (not "stra-e")',
    rec('Straße')?.slug === 'strasse' && brandOf(2) === 'Straße');
  check('Ørgreen keeps its Ø: the record is "orgreen", the product "Ørgreen" (not "rgreen")',
    rec('Ørgreen')?.slug === 'orgreen' && brandOf(3) === 'Ørgreen');
  check('a Cyrillic brand transliterates', rec('Кураж')?.slug === 'kurazh' && brandOf(4) === 'Кураж');
  check('a brand with nothing to transliterate still gets a usable slug, and keeps its name',
    /^item-[a-z0-9]+$/.test(rec('眼鏡')?.slug ?? '') && brandOf(5) === '眼鏡');
  check("WordPress's percent-encoded slug is decoded and transliterated, not published as hex",
    rec('Γυαλιά Ηλίου')?.slug === 'gyalia-iliou');
  check('no brand record is skipped for having a non-Latin name',
    plan.brands.length === 6 && !plan.skipped.some((s) => s.kind === 'brand'));
}

/* ---- a WordPress slug is decoded, or not trusted at all ---- */
{
  const d = W.decodeWordPressSlug;
  check('a plain slug passes through', d?.('ray-ban') === 'ray-ban');
  check('an encoded slug is decoded', d?.('%ce%bf%cf%88%ce%b7') === 'οψη');
  check('uppercase hex decodes too', d?.('%CE%BF') === 'ο');
  // decodeURIComponent THROWS on these; one bad term must not abort an import.
  check('a truncated sequence is refused rather than thrown', d?.('%ce%bf%cf%88%ce%') === '');
  check('a non-hex escape is refused', d?.('%zz') === '');
  check('a slug STILL encoded after one pass is refused, not decoded again', d?.('%25ce%25b2') === '');
  check('a non-string is empty', d?.(undefined) === '' && d?.(7) === '');

  // Refused means: the slug comes from the NAME, never from the garbage.
  const plan = W.planWooImport({
    brands: [
      { name: 'Όψη', slug: '%ce%bf%cf%88%ce%' },
      { name: 'Βλέμμα', slug: '%25ce%25b2' },
      { name: 'Bad Escape', slug: '%zz' },
    ],
  });
  const slugOf = (n) => plan.brands.find((b) => b.name === n)?.slug;
  check('an undecodable slug falls back to the name', slugOf('Όψη') === 'opsi' && slugOf('Bad Escape') === 'bad-escape');
  check('...and so does a doubly encoded one', slugOf('Βλέμμα') === 'vlemma');
}

/* ---- one maker, one record ---- */
{
  const plan = W.planWooImport({
    brands: [{ name: 'Ray Ban' }, { name: 'Ray-Ban', slug: 'ray-ban-2' }, { name: '  Ray   Ban ' }],
  });
  check('three spellings of one maker plan ONE record, the first',
    plan.brands.length === 1 && plan.brands[0]?.name === 'Ray Ban');
  check('...and the others are REPORTED, naming the one kept',
    plan.skipped.filter((s) => s.kind === 'brand' && /same brand as "Ray Ban"/.test(s.reason)).length === 2);

  const junk = W.planWooImport({
    brands: [{ name: '---' }],
    products: [{ wp_id: '1', name: 'X', price_cents: 1, brand: '***' }],
  });
  check('a brand of only punctuation is skipped, with a reason',
    junk.brands.length === 0 && junk.skipped.some((s) => s.kind === 'brand' && s.label === '---' && /no letter or digit/.test(s.reason)));
  check('...and a product "branded" with punctuation has no brand', junk.products[0]?.brand === undefined);
}

/* ---- two makers that slugify alike ---- */
//
// `slugify` transliterates, so `Straße` and `Strasse` now both want
// `strasse` — a collision `slugifyImported` could not produce. A record
// holding `strasse` would re-point `?brand=strasse`, which means Strasse.
{
  const slugOf = (p, n) => p.brands.find((b) => b.name === n)?.slug;
  const one = W.planWooImport({ brands: [{ name: 'Straße' }, { name: 'Strasse' }] });
  const two = W.planWooImport({ brands: [{ name: 'Strasse' }, { name: 'Straße' }] });
  check('both makers get a record, with different slugs',
    one.brands.length === 2 && slugOf(one, 'Straße') !== slugOf(one, 'Strasse'));
  check('the maker the slug SPELLS keeps it, whichever comes first',
    slugOf(one, 'Strasse') === 'strasse' && slugOf(two, 'Strasse') === 'strasse');
  check('...and the other gets the same stable suffix in either order',
    /^strasse-[a-z0-9]+$/.test(slugOf(one, 'Straße') ?? '') && slugOf(one, 'Straße') === slugOf(two, 'Straße'));
  const byProduct = W.planWooImport({
    brands: [{ name: 'Straße' }],
    products: [{ wp_id: '1', name: 'A', price_cents: 1, brand: 'Strasse' }],
  });
  check('a record never takes the name of a maker the dump knows only from its products',
    /^strasse-[a-z0-9]+$/.test(slugOf(byProduct, 'Straße') ?? ''));
}

/* ---- a product that names its brand by SLUG ---- */
//
// The name used to be slugified either way, so a parser writing the term
// slug on products came out the same as one writing the name. Now the name is
// kept — so a slug on a product must be resolved to its record's name, or the
// storefront shows `%ce%b3…` and the product is keyed apart from its brand.
{
  const plan = W.planWooImport({
    brands: [
      { name: 'Γυαλιά Ηλίου', slug: wpSlug('Γυαλιά Ηλίου') },
      { name: 'Straße', slug: 'strasse' },
      { name: 'Ray-Ban', slug: 'rb' },
      { name: 'RB' },
    ],
    products: [
      { wp_id: '1', name: 'Encoded', price_cents: 1, brand: wpSlug('Γυαλιά Ηλίου') },
      { wp_id: '2', name: 'Latin slug', price_cents: 1, brand: 'strasse' },
      { wp_id: '3', name: 'Another maker', price_cents: 1, brand: 'rb' },
      { wp_id: '4', name: 'No record', price_cents: 1, brand: wpSlug('Βλέμμα') },
      { wp_id: '5', name: 'Percent in a name', price_cents: 1, brand: '20%20 Vision' },
    ],
  });
  const brandOf = (n) => plan.products.find((p) => p.name === n)?.brand;
  check("a product naming its brand by WordPress's encoded slug gets the record's name",
    brandOf('Encoded') === 'Γυαλιά Ηλίου');
  check('...and by a Latin slug too', brandOf('Latin slug') === 'Straße');
  check('...which then does not count as a maker called "Strasse": Straße keeps "strasse"',
    plan.brands.find((b) => b.name === 'Straße')?.slug === 'strasse');
  check('a slug that is ANOTHER maker\'s name stays that maker\'s: "rb" is RB, not Ray-Ban',
    brandOf('Another maker') === 'rb');
  check('an encoded slug no record explains is at least decoded', brandOf('No record') === 'βλέμμα');
  check('a brand that merely CONTAINS a %-escape is not decoded', brandOf('Percent in a name') === '20%20 Vision');
}

/* ---- blog status is carried, never invented ---- */
{
  const plan = W.planWooImport({
    blog: [
      { wp_id: '1', title: 'Public', status: 'publish' },
      { wp_id: '2', title: 'Secret', status: 'draft' },
      { wp_id: '3', title: 'Private', status: 'private' },
      { wp_id: '4', title: 'Legacy no status' },
    ],
  });
  const st = (t) => plan.posts.find((p) => p.title === t)?.status;
  check('publish → published', st('Public') === 'published');
  check('a DRAFT stays a draft — it does not go on the open web', st('Secret') === 'draft');
  check('private → draft, same as the WXR importer', st('Private') === 'draft');
  check('a record with no status field keeps the old behaviour (published)',
    st('Legacy no status') === 'published');
}

/* ---- an order with no email still exists ---- */
{
  const plan = W.planWooImport({ orders: [{ wp_id: '1', total_cents: 500 }] });
  check('an order with no email is still imported — it is a real sale',
    plan.orders.length === 1);
  check('...with a marked address rather than an invented one',
    /\.invalid$/.test(plan.orders[0].email));
}

/* ---- nothing is dropped silently ---- */
{
  const plan = W.planWooImport({
    products: [{ wp_id: '1', name: 'ok', price_cents: 1 }, { wp_id: '2', name: 'bad', price_cents: 1.5 }],
    categories: [{ name: 'Frames', slug: 'frames' }, { name: '' }],
    brands: [{ name: 'Ray Ban' }, {}],
    customers: [{ wp_id: '1', email: 'a@b.co' }, { wp_id: '2' }],
    orders: [{ wp_id: '1', total_cents: 1 }, { wp_id: '2', total_cents: null }],
    blog: [{ title: 'A post' }, { content: 'no title' }],
  });
  const planned = plan.products.length + plan.categories.length + plan.brands.length
    + plan.customers.length + plan.orders.length + plan.posts.length;
  check('every input record is either planned or skipped', planned + plan.skipped.length === 12);
  check('every skip carries a reason a human can act on',
    plan.skipped.every((s) => s.reason.length > 10 && s.kind));
  check('the summary reports all six kinds',
    /product\(s\).*categor\(ies\).*brand\(s\).*customer\(s\).*order\(s\).*post\(s\)/
      .test(W.summariseWooPlan(plan)));
}

/* ---- a completely empty dump is not an error ---- */
{
  const plan = W.planWooImport({});
  check('an empty dataset plans nothing and throws nothing',
    plan.products.length === 0 && plan.skipped.length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
