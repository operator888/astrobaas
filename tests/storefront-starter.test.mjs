#!/usr/bin/env node
/**
 * The storefront starter (examples/storefront) — the parts that decide what a
 * shopper sends and sees, checked without a browser or a build.
 *
 *  - the cart holds ids and quantities only, and survives whatever is in
 *    localStorage;
 *  - the category tree terminates on a loop and never drops a category;
 *  - the pages keep the promises the README makes: no inline script, no price
 *    arithmetic, the email never in a URL, a receipt link that is not a 404.
 *
 * Run with:  node tests/storefront-starter.test.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadTs, ROOT } from './lib/load.mjs';

const DIR = 'examples/storefront';
const read = (rel) => fs.readFile(path.join(ROOT, DIR, rel), 'utf8');
const C = await loadTs(`${DIR}/src/lib/cart.ts`);
const T = await loadTs(`${DIR}/src/lib/categories.ts`);
const M = await loadTs(`${DIR}/src/lib/money.ts`);
const K = await loadTs(`${DIR}/src/lib/stock.ts`);

let passed = 0;
const failures = [];
async function check(name, fn) {
  try { await fn(); passed += 1; } catch (err) { failures.push(`${name}: ${err.message}`); }
}
function ok(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, what = '') {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
function memory(initial) {
  const m = new Map(initial === undefined ? [] : [[C.CART_KEY, initial]]);
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k), raw: () => m.get(C.CART_KEY) };
}

// ───────────────────────────────────────────────────────── the cart

await check('adding the same product twice is one line, not two', () => {
  const s = memory();
  C.addToCart(s, 'p1', 1);
  eq(C.addToCart(s, 'p1', 2), [{ product_id: 'p1', qty: 3 }]);
});

await check('two variants of one product are two lines', () => {
  const s = memory();
  C.addToCart(s, 'p1', 1, 'red');
  eq(C.addToCart(s, 'p1', 1, 'blue').length, 2);
});

await check('the cart stores no price, name or total — the CMS prices every basket', () => {
  const s = memory();
  C.addToCart(s, 'p1', 2);
  eq(Object.keys(JSON.parse(s.raw())[0]).sort(), ['product_id', 'qty']);
});

await check('a quantity is capped, and zero or less removes the line', () => {
  const s = memory();
  C.addToCart(s, 'p1', 5000);
  eq(C.readCart(s)[0].qty, C.MAX_QTY);
  eq(C.setQty(s, 'p1', 0), []);
  eq(s.raw(), undefined, 'an empty cart is removed, not stored as []');
});

await check('garbage in localStorage empties the cart instead of breaking the page', () => {
  eq(C.readCart(memory('{not json')), []);
  eq(C.readCart(memory('{"a":1}')), []);
  eq(C.readCart(memory(JSON.stringify([{ product_id: '<img src=x>', qty: 1 }, { product_id: 'ok', qty: 'x' }, { product_id: 'good', qty: 2 }]))),
    [{ product_id: 'good', qty: 2 }]);
});

await check('a full or blocked storage does not throw', () => {
  const s = { getItem: () => null, setItem: () => { throw new Error('QuotaExceeded'); }, removeItem: () => {} };
  eq(C.addToCart(s, 'p1', 1), [{ product_id: 'p1', qty: 1 }]);
});

await check('the badge counts items, not lines', () => {
  eq(C.cartCount([{ product_id: 'a', qty: 2 }, { product_id: 'b', qty: 3 }]), 5);
});

// ─────────────────────────────────────────────────── categories

const cats = [
  { slug: 'clothing', name: 'Clothing' },
  { slug: 'shirts', name: 'Shirts', parent_slug: 'clothing' },
  { slug: 'linen', name: 'Linen', parent_slug: 'shirts' },
  { slug: 'shoes', name: 'Shoes' },
];

await check('the tree nests, and the path runs from the top', () => {
  const tree = T.buildTree(cats);
  eq(tree.map((n) => n.cat.slug), ['clothing', 'shoes']);
  eq(tree[0].children[0].children[0].cat.slug, 'linen');
  eq(T.pathTo('linen', cats).map((c) => c.slug), ['clothing', 'shirts', 'linen']);
});

await check('a loop terminates, and every category still appears once', () => {
  const loop = [{ slug: 'a', name: 'A', parent_slug: 'b' }, { slug: 'b', name: 'B', parent_slug: 'a' }];
  const seen = [];
  const walk = (ns) => ns.forEach((n) => { seen.push(n.cat.slug); walk(n.children); });
  walk(T.buildTree(loop));
  eq(seen.sort(), ['a', 'b']);
  ok(T.pathTo('a', loop).length <= 2, 'pathTo walked forever');
});

await check('an orphan is shown at the top, not dropped', () => {
  eq(T.buildTree([{ slug: 'x', name: 'X', parent_slug: 'gone' }]).map((n) => n.cat.slug), ['x']);
});

// ───────────────────────────────────────────────────────── money

await check('minor units match the CMS: none for yen and forint, thousandths for dinars', () => {
  eq(M.formatMoney(1999, 'EUR', 'en'), '€19.99');
  eq(M.formatMoney(500, 'JPY', 'en'), '¥500');
  // A forint shop showed every price a hundred times too small.
  ok(/12,500/.test(M.formatMoney(12500, 'HUF', 'en')), `HUF: ${M.formatMoney(12500, 'HUF', 'en')}`);
  // A dinar shop showed every price ten times too large.
  ok(/12\.500/.test(M.formatMoney(12500, 'KWD', 'en')), `KWD: ${M.formatMoney(12500, 'KWD', 'en')}`);
});

await check('the tables are the CMS\'s own, not a second opinion', async () => {
  const core = await fs.readFile(path.join(ROOT, 'src/lib/money-format.ts'), 'utf8');
  const mine = await read('src/lib/money.ts');
  for (const name of ['ZERO_DECIMAL', 'THREE_DECIMAL']) {
    const set = (src) => [...(src.match(new RegExp(`const ${name} = new Set\\(\\[([^\\]]*)\\]`))?.[1] ?? '').matchAll(/'([A-Z]{3})'/g)].map((m) => m[1]).sort().join();
    ok(set(core) && set(core) === set(mine), `${name} differs from src/lib/money-format.ts`);
  }
});

// ───────────────────────────────────────────── the idempotency key

await check('the same cart and details give the same key; changed details or a new cart do not', async () => {
  const s = memory();
  C.addToCart(s, 'p1', 1);
  const nonce = C.cartNonce(s);
  eq(C.cartNonce(s), nonce, 'the nonce is not stable for one cart');
  const order = { email: 'a@b.c', items: C.readCart(s) };
  const k1 = await C.attemptKey(nonce, order);
  eq(await C.attemptKey(C.cartNonce(s), order), k1, 'a retry would place a second order');
  ok(await C.attemptKey(nonce, { ...order, email: 'a@b.cd' }) !== k1, 'a corrected detail reuses the key, which the CMS refuses');
  C.clearCart(s);
  C.addToCart(s, 'p1', 1);
  ok(await C.attemptKey(C.cartNonce(s), order) !== k1, 'buying the same again tomorrow would replay today\'s order');
  ok(/^[A-Za-z0-9-]{1,255}$/.test(k1), 'not a key the CMS accepts');
});

// ─────────────────────────────────────────── promises the pages keep

const pages = [];
async function walk(rel) {
  for (const e of await fs.readdir(path.join(ROOT, DIR, rel), { withFileTypes: true })) {
    const p = path.join(rel, e.name);
    if (e.isDirectory()) await walk(p);
    else if (p.endsWith('.astro')) pages.push(p);
  }
}
await walk('src');

await check('no inline script or style attribute — the CSP allows neither', async () => {
  for (const p of pages) {
    const src = await read(p);
    ok(!/<script\b[^>]*\bis:inline\b/.test(src), `${p} has an is:inline script`);
    ok(!/\sstyle="/.test(src), `${p} has a style attribute`);
    ok(!/\son[a-z]+="/.test(src), `${p} has an inline event handler`);
  }
});

await check('the CSP is on, without unsafe-inline, and lets the browser reach only the CMS', async () => {
  const cfg = await read('astro.config.mjs');
  ok(/security:\s*\{\s*[\s\S]*csp:/.test(cfg), 'no CSP');
  const directives = cfg.match(/directives: \[([\s\S]*?)\]/)?.[1] ?? '';
  ok(directives.includes("default-src 'self'"), 'no default-src');
  ok(!/unsafe-/.test(directives), 'unsafe-* in the policy');
  ok(/`connect-src 'self' \$\{cms\}`/.test(cfg), 'connect-src is not self + the CMS');
});

await check('no browser code adds up money — every total is the CMS quote', async () => {
  for (const p of [...pages, 'src/scripts/shop-api.ts', 'src/scripts/last-order.ts']) {
    const src = await read(p);
    ok(!/(unit_price_cents|price_cents)\s*\*/.test(src), `${p} multiplies a price`);
    ok(!/reduce\([^)]*cents/.test(src), `${p} sums cents`);
  }
});

await check('the buyer\'s email never goes into a URL', async () => {
  for (const p of pages) {
    const src = await read(p);
    ok(!/[?&]email=/.test(src), `${p} puts the email in a query string`);
  }
});

await check('checkout keys each order by cart and details, and re-checks the total first', async () => {
  const src = await read('src/pages/checkout.astro');
  ok(/const idempotencyKey = await attemptKey\(cartNonce\(store\), details\)/.test(src), 'the key is not built from the cart nonce and the details');
  ok(/cms\.orders\.place\(\s*\{ \.\.\.details, pow_token: [^}]*\},\s*\{ idempotencyKey \},?\s*\)/.test(src), 'place() does not send exactly the keyed details with that key');
  ok(/const fresh = await reprice\(\);\s*if \(shown !== undefined && fresh\.total_cents !== shown\)/.test(src), 'the total is not re-checked before placing');
});

await check('checkout draws the terms box from the CMS settings and sends only what was shown', async () => {
  const page = await read('src/pages/checkout.astro');
  const api = await read('src/scripts/shop-api.ts');
  ok(/\.\.\.\(terms \? \{ terms_accepted: !!termsInput\?\.checked \} : \{\}\)/.test(page), 'terms_accepted is not sent from the box, only when it was shown');
  ok(/label\.textContent = terms\.label/.test(page), 'the merchant label is not rendered as text');
  ok(!/terms\.label[^;\n]*innerHTML|innerHTML[^;\n]*terms\.label/.test(page), 'the merchant label reaches innerHTML');
  ok(/checkout_terms_required/.test(api) && /\/api\/settings\/get/.test(api), 'the box does not read the shop\'s public settings');
});

await check('a payment redirect is only ever followed to https', async () => {
  const src = await read('src/scripts/last-order.ts');
  ok(/!\/\^https:\\\/\\\/\/\.test\(pay\.redirect_url\)/.test(src), 'redirect_url is not checked for https');
});

await check('the pages a CMS links to on a headless shop exist', async () => {
  for (const p of ['src/pages/receipt.astro', 'src/pages/checkout/success.astro', 'src/pages/checkout/cancelled.astro']) {
    ok(pages.includes(p), `${p} is missing, so that link from the CMS is a 404`);
  }
});

// ─────────────────────────────────────────────────────── stock badges

await check('the badge reads the CMS\'s stock_status — three states, words and a tone', () => {
  const b = (stock_status) => K.stockBadge({ stock_status, in_stock: true });
  eq(b({ status: 'in-stock', purchasable: true }), { tone: 'in', label: 'In stock', note: '', buyable: true });
  eq(b({ status: 'low-stock', available_qty: 3, purchasable: true }),
    { tone: 'low', label: 'Low stock \u2013 3 left', note: '3 left', buyable: true });
  eq(b({ status: 'out-of-stock', purchasable: false }),
    { tone: 'out', label: 'Out of stock', note: 'sold out', buyable: false });
});

await check('a backorderable product stays buyable while reading out of stock', () => {
  const x = K.stockBadge({ stock_status: { status: 'out-of-stock', backorderable: true, purchasable: true }, in_stock: false });
  eq([x.tone, x.buyable, x.note], ['out', true, 'backorder']);
  ok(/backorder/i.test(x.label), `label: ${x.label}`);
});

await check('the badge never overrules the CMS: purchasable decides the button, not the stored flag', () => {
  // in_stock says sold out; the CMS says one can still be ordered.
  eq(K.stockBadge({ stock_status: { status: 'out-of-stock', backorderable: true, purchasable: true }, in_stock: false }).buyable, true);
  // in_stock says in stock (a variable product whose every variant sold out).
  eq(K.stockBadge({ stock_status: { status: 'out-of-stock', purchasable: false }, in_stock: true }).buyable, false);
});

await check('a CMS without stock_status falls back to the stored flag, and no further', () => {
  eq(K.stockBadge({ in_stock: true }).tone, 'in');
  eq(K.stockBadge({ in_stock: false }).buyable, false);
  eq(K.stockBadge({}).buyable, true);
});

await check('the pages ask the badge — no threshold, count or in_stock logic of their own', async () => {
  for (const p of ['src/components/ProductCard.astro', 'src/pages/product/[slug].astro']) {
    const src = await read(p);
    ok(/stockBadge\(/.test(src), `${p} does not use stockBadge`);
    ok(!/\.in_stock/.test(src), `${p} reads in_stock itself`);
    ok(!/low_stock_threshold|available_qty|\.stock\b/.test(src), `${p} computes from the count`);
  }
});

await check('the stock colours exist in both themes', async () => {
  const css = await read('src/styles/shop.css');
  const defs = [...css.matchAll(/--stock-(in|low):/g)].length;
  ok(defs === 4, `expected --stock-in and --stock-low in light and dark, found ${defs}`);
  for (const c of ['stock-in', 'stock-low', 'stock-out']) ok(new RegExp(`\\.${c}\\b`).test(css), `.${c} has no rule`);
});

// ─────────────────────────────────────────────────── variant selector

await check('the product page chooses variants through VariantSelector, not a select of its own', async () => {
  const page = await read('src/pages/product/[slug].astro');
  ok(/<VariantSelector product=\{product\} currency=\{currency\} \/>/.test(page), 'the page does not render VariantSelector');
  ok(!/<select\b/.test(page), 'the page still has its own select');
  for (const hook of ['data-product-root', 'data-variant-price', 'data-variant-image', 'data-variant-buy', 'data-stock']) {
    ok(page.includes(hook), `the page has no ${hook} for the selector to update`);
  }
});

await check('the selector: a radio group per option, a live region, and a select that works without script', async () => {
  const c = await read('src/components/VariantSelector.astro');
  ok(/<fieldset class="ab-variant__axis"[^>]*\bdisabled\b/.test(c), 'the option groups are not disabled until the script runs');
  ok(/<legend\b/.test(c), 'an option group has no legend');
  ok(/type="radio"/.test(c), 'no radios');
  ok(/data-variant-groups hidden/.test(c), 'the radio groups show before the script can drive them');
  ok(/<select id=\{`\$\{uid\}-select`\} name=\{name\} required/.test(c), 'no fallback select submitting the variant');
  ok(/role="status" aria-live="polite"/.test(c), 'no live region for the price');
  ok(/<script type="application\/json" data-variant-data set:html=\{pickerJson\(data\)\}>/.test(c), 'the data is not a non-executable JSON block');
  ok(/import \{ mountVariantSelector \} from '\.\.\/scripts\/variant-selector'/.test(c), 'the behaviour is not the bundled script');
});

await check('the selector decides nothing itself: availability is the shared rule, prices come preformatted', async () => {
  const js = await read('src/scripts/variant-selector.ts');
  ok(/from '\.\.\/lib\/variant-selection'/.test(js), 'the script does not use lib/variant-selection');
  ok(!/formatMoney|price_cents|stock_status|in_stock/.test(js), 'the script formats money or reads stock itself');
  ok(/searchParams\.set\('variant', view\.id\)/.test(js), 'the choice is not kept in ?variant=');
  ok(/history\.replaceState/.test(js), 'the URL is not updated in place');
});

await check('a theme can restyle the selector: every --ab-variant-* token has the shop\'s token as fallback', async () => {
  const css = await read('src/styles/shop.css');
  const uses = [...css.matchAll(/var\(--ab-variant-[a-z-]+(\s*,[^)]*\))?/g)];
  ok(uses.length >= 10, `only ${uses.length} --ab-variant-* uses`);
  for (const m of uses) ok(m[1], `${m[0]} has no fallback, so the selector is unstyled until a theme sets it`);
  ok(!/--ab-variant-[a-z-]+\s*:/.test(css), 'the starter defines an --ab-variant-* token, which would beat a theme setting it on :root');
  for (const c of ['ab-variant__choice', 'ab-variant__pill', 'ab-variant__note']) ok(new RegExp(`\\.${c}\\b`).test(css), `.${c} has no rule`);
  ok(/\.ab-variant__input:disabled \+ \.ab-variant__pill \.ab-variant__value \{ text-decoration: line-through/.test(css), 'sold out is shown by colour alone');
});

await check('every --ab-variant-* token the stylesheet reads is documented in the README, and no other', async () => {
  const css = await read('src/styles/shop.css');
  const readme = await read('README.md');
  const used = [...new Set([...css.matchAll(/var\(--ab-variant(-[a-z-]+)/g)].map((m) => m[1]))].sort();
  const para = readme.match(/\*\*Restyling the variant picker\.\*\*[\s\S]*?(?=\n- \*\*|\n## )/)?.[0] ?? '';
  const documented = [...new Set([...para.matchAll(/`(-[a-z-]+)`/g)].map((m) => m[1]))].sort();
  eq(documented, used, 'README tokens');
});

if (failures.length) {
  console.error(`\n✗ storefront-starter: ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error(`  · ${f}`);
  process.exit(1);
}
console.log(`✓ storefront-starter: ${passed} passed`);
