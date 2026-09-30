#!/usr/bin/env node
/**
 * The starter against a real CMS, end to end: a shopper browses a nested
 * category, adds a product, checks out by bank transfer, and the order exists.
 *
 * It starts the CMS from THIS repository (a throwaway database), builds the
 * starter against it, serves the build on a second origin — so CORS is real —
 * and drives Chromium through the shop. Every page is also run through axe and
 * watched for Content-Security-Policy violations.
 *
 * Run from the repository root, after `npm install` in examples/storefront:
 *
 *   node examples/storefront/scripts/e2e.mjs
 *
 * Not part of the gate: it needs the starter's own dependencies installed.
 */
import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STOREFRONT = process.env.STOREFRONT_DIR || path.resolve(HERE, '..');
const ROOT = path.resolve(HERE, '../../..');
const CMS_PORT = Number(process.env.CMS_PORT || 4410);
const SF_PORT = Number(process.env.SF_PORT || 4411);
const CMS = `http://127.0.0.1:${CMS_PORT}`;
const SF = `http://127.0.0.1:${SF_PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-storefront-e2e-'));

let passed = 0;
const failures = [];
const ok = (name) => { passed++; console.log(`  ✓ ${name}`); };
const fail = (name, why) => { failures.push(`${name}: ${why}`); console.log(`  ✗ ${name} — ${why}`); };
const expect = (cond, name, why = '') => (cond ? ok(name) : fail(name, why));

// ───────────────────────────────────────────────────────────── the CMS

const cms = spawn('npx', ['astro', 'dev', '--port', String(CMS_PORT), '--host', '127.0.0.1', '--ignore-lock'], {
  cwd: ROOT,
  env: {
    ...process.env,
    DB_PATH: path.join(tmp, 'db.json'),
    UPLOADS_DIR: path.join(tmp, 'uploads'),
    AUTH_SECRET: 'storefront-e2e-secret-0123456789abcdef0123456789',
    CORS_ORIGINS: SF,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
});
let cmsLog = '';
cms.stdout.on('data', (c) => (cmsLog += c));
cms.stderr.on('data', (c) => (cmsLog += c));

let server;
let browser;
function cleanup() {
  try { process.kill(-cms.pid, 'SIGTERM'); } catch { /* gone */ }
  server?.close();
  browser?.close().catch(() => {});
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

async function waitFor(url, ms = 120_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { if ((await fetch(url)).status < 500) return; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${url} did not come up.\n${cmsLog.slice(-2000)}`);
}

console.log('\n── starting the CMS');
await waitFor(`${CMS}/login`);

// The development seed's admin, through the API — the same harness login the
// smoke suite uses. A throwaway database, discarded at the end.
const login = await fetch(`${CMS}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ email: 'admin@local', password: 'admin', next: '/admin' }),
  redirect: 'manual',
});
let session = '';
let csrf = '';
for (const c of login.headers.getSetCookie()) {
  const m = c.match(/(astrobaas_session|astrobaas_csrf)=([^;]+)/);
  if (m?.[1] === 'astrobaas_session') session = `astrobaas_session=${m[2]}`;
  if (m?.[1] === 'astrobaas_csrf') csrf = decodeURIComponent(m[2]);
}
if (!session) throw new Error(`login failed: ${login.status}`);
const H = { Cookie: `${session}; astrobaas_csrf=${csrf}`, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' };
const staff = async (method, p, body) => {
  const r = await fetch(`${CMS}${p}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${JSON.stringify(j)}`);
  return j?.data;
};

console.log('── stocking the shop');
await staff('POST', '/api/settings/update', {
  commerce_enabled: true,
  payment_instructions_bank_transfer: 'Test Bank\nIBAN: GR00 0000 0000 0000 0000 0000 000',
});
await staff('POST', '/api/product-categories', { name: 'Clothing', slug: 'clothing' });
await staff('POST', '/api/product-categories', { name: 'Shirts', slug: 'shirts', parent_slug: 'clothing' });
await staff('POST', '/api/product-categories', { name: 'Shoes', slug: 'shoes' });
await staff('POST', '/api/products', { name: 'Linen Shirt', slug: 'linen-shirt', price_cents: 4900, stock: 20, status: 'active', categories: ['shirts'], featured: true });
await staff('POST', '/api/products', { name: 'Canvas Sneaker', slug: 'canvas-sneaker', price_cents: 7500, stock: 5, status: 'active', categories: ['shoes'] });
await staff('POST', '/api/settings/update', {
  navigation: { items: [
    { label: 'Everything', href: '/shop/', children: [{ label: 'Clothing', href: '/shop/clothing/' }] },
    { label: 'Journal', href: '/blog/' },
  ] },
});
const retired = await staff('POST', '/api/products', { name: 'Retired Scarf', slug: 'retired-scarf', price_cents: 1500, stock: 5, status: 'active', categories: ['clothing'] });
await staff('POST', '/api/products', { name: 'Backroom Jacket', slug: 'backroom-jacket', price_cents: 12000, stock: 3, status: 'active', categories: ['clothing'], catalog_visibility: 'hidden' });

// ────────────────────────────────────────────────────── the storefront

console.log('── building the storefront');
execFileSync('npx', ['astro', 'build'], {
  cwd: STOREFRONT,
  env: { ...process.env, PUBLIC_CMS_URL: CMS, PUBLIC_SHOP_NAME: 'Test Shop', PUBLIC_SHIP_COUNTRIES: 'GR,DE' },
  stdio: 'inherit',
});
const DIST = path.join(STOREFRONT, 'dist');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
server = http.createServer((req, res) => {
  const url = new URL(req.url, SF);
  let file = path.join(DIST, decodeURIComponent(url.pathname));
  if (!file.startsWith(DIST)) { res.writeHead(403).end(); return; }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) { res.writeHead(404, { 'Content-Type': 'text/html' }).end(fs.readFileSync(path.join(DIST, '404.html'))); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' }).end(fs.readFileSync(file));
}).listen(SF_PORT, '127.0.0.1');

console.log('── shopping');
browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
let expectRefusals = false;
const cspViolations = [];
const consoleErrors = [];
page.on('console', (m) => {
  // The storefront's own pages only: the receipt check ends on the CMS, which
  // rightly answers 404 for the made-up token it is given.
  if (m.type() !== 'error' || !page.url().startsWith(SF)) return;
  // While a withdrawn product is in the cart, the CMS refusing its quote IS
  // the scenario under test; the browser logs each refusal as a failed load.
  if (expectRefusals && /status of 4\d\d/.test(m.text())) return;
  (/Content Security Policy|Refused to/.test(m.text()) ? cspViolations : consoleErrors).push(`${page.url()}: ${m.text()}`);
});
const axeBlocking = [];
async function audit(label) {
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  for (const v of violations.filter((x) => x.impact === 'serious' || x.impact === 'critical')) {
    axeBlocking.push(`${label}: ${v.id} — ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`);
  }
}

await page.goto(`${SF}/`);
expect(await page.getByRole('link', { name: 'Linen Shirt' }).count() > 0, 'the home page shows the featured product');
await audit('/');

const menu = await page.locator('nav[aria-label="Main"]').innerText();
expect(menu.includes('Everything') && menu.includes('Journal'), 'the header uses the menu edited in the CMS', menu);
expect(await page.locator('nav[aria-label="Main"] .submenu a', { hasText: 'Clothing' }).count() === 1, 'with its submenu');

await page.goto(`${SF}/shop/clothing/`);
const clothing = await page.locator('.grid').innerText();
expect(clothing.includes('Linen Shirt'), 'a category includes its subcategory\'s products', clothing);
expect(!clothing.includes('Backroom Jacket'), 'a hidden product stays off the shelves', clothing);
expect(await page.locator('.cats a[aria-current="page"]').innerText() === 'Clothing', 'the tree marks the current category');
await audit('/shop/clothing/');

// Suggestions in the header: a category and a product, from the CMS.
const search = page.getByRole('combobox', { name: 'Search the shop' });
await search.fill('linen');
await page.getByRole('listbox', { name: 'Suggestions' }).waitFor({ timeout: 10_000 }).catch(() => {});
const offered = await page.locator('#site-suggest').innerText().catch(() => '');
expect(offered.includes('Linen Shirt'), 'the search box suggests matching products', offered);
expect(!offered.includes('Backroom Jacket'), 'a hidden product is not suggested', offered);
await audit('/shop/clothing/ with suggestions open');
await search.press('ArrowDown');
await search.press('Enter');
await page.waitForURL('**/product/linen-shirt/', { timeout: 10_000 }).catch(() => {});
expect(page.url().endsWith('/product/linen-shirt/'), 'arrow down and Enter open the suggestion', page.url());

await page.goto(`${SF}/search/?q=sneaker`);
await page.waitForFunction(() => !/Searching/.test(document.querySelector('[data-search-status]')?.textContent ?? ''), null, { timeout: 10_000 }).catch(() => {});
const results = await page.locator('[data-search-results]').innerText();
expect(results.includes('Canvas Sneaker'), 'the results page lists matches', results);

await page.goto(`${SF}/product/backroom-jacket/`);
expect(await page.locator('h1').innerText() === 'Backroom Jacket', 'a hidden product is still reachable by its link');

await page.goto(`${SF}/product/linen-shirt/`);
await audit('/product/linen-shirt/');
await page.fill('#qty', '2');
await page.getByRole('button', { name: 'Add to cart' }).click();
await page.waitForSelector('[data-added]:not([hidden])');
expect((await page.locator('[data-cart-count]').innerText()) === '2', 'the header badge counts the items');

await page.goto(`${SF}/cart/`);
await page.waitForSelector('[data-cart-body]:not([hidden])');
const cartTotals = await page.locator('[data-cart-totals]').innerText();
expect(cartTotals.includes('98.00'), 'the cart is priced by the CMS (2 × 49.00)', cartTotals);
await audit('/cart/');

// A product withdrawn after it went into the cart: the CMS refuses any quote
// that includes it, and the cart must name it and let the buyer drop just it.
await page.goto(`${SF}/product/retired-scarf/`);
await page.getByRole('button', { name: 'Add to cart' }).click();
await staff('PUT', `/api/products/${retired.id}`, { status: 'archived' });
expectRefusals = true;
await page.goto(`${SF}/cart/`);
await page.getByRole('button', { name: 'Remove Retired Scarf' }).waitFor({ timeout: 15_000 }).catch(() => {});
const stuck = await page.locator('[data-cart-status]').innerText();
expect(stuck.includes('Retired Scarf'), 'a withdrawn product is named in the cart', stuck);
await page.getByRole('button', { name: 'Remove Retired Scarf' }).click().catch(() => {});
await page.waitForSelector('[data-cart-body]:not([hidden])', { timeout: 15_000 }).catch(() => {});
expect((await page.locator('[data-cart-totals]').innerText().catch(() => '')).includes('98.00'), 'removing it leaves the rest of the cart', await page.locator('main').innerText());

expectRefusals = false;

await page.goto(`${SF}/checkout/`);
await page.waitForSelector('[data-checkout]:not([hidden])');
await audit('/checkout/');
await page.fill('#email', 'buyer@example.com');
await page.fill('#name', 'Test Buyer');
await page.fill('#line1', 'Odos Ermou 1');
await page.fill('#postcode', '10563');
await page.fill('#city', 'Athens');
await page.selectOption('#country', 'GR');
await page.waitForTimeout(800); // the re-quote for the destination
await page.getByLabel('Bank transfer', { exact: false }).check();
await page.getByRole('button', { name: 'Place order' }).click();
await page.waitForURL('**/order/placed/', { timeout: 30_000 }).catch(() => {});
const placedUrl = page.url();
expect(placedUrl.endsWith('/order/placed/'), 'placing the order lands on the confirmation', `${placedUrl} — ${await page.locator('[data-co-error]').innerText().catch(() => '')}`);
const placed = await page.locator('main').innerText();
const number = placed.match(/Your order (\S+) is placed/)?.[1];
expect(!!number, 'the confirmation names the order', placed);
expect(placed.includes('IBAN: GR00'), 'bank-transfer instructions are shown', placed);
expect(!placedUrl.includes('@') && !placedUrl.includes('email'), 'the email is not in the URL', placedUrl);
expect((await page.locator('[data-cart-count]').innerText()) === '0', 'the cart is emptied after ordering');
await audit('/order/placed/');

const orders = await staff('GET', '/api/orders');
const order = (orders ?? []).find((o) => o.number === number);
expect(!!order, 'the order exists in the CMS', number);
if (order) {
  expect(order.items?.[0]?.qty === 2 && order.subtotal_cents === 9800, 'with the right items and subtotal', JSON.stringify({ items: order.items, subtotal: order.subtotal_cents }));
  expect(order.payment_method === 'bank-transfer', 'and the chosen payment method', order.payment_method);
}

await page.goto(`${SF}/receipt/?token=not-a-real-token-at-all`);
await page.waitForURL(`${CMS}/receipt**`, { timeout: 10_000 }).catch(() => {});
expect(page.url().startsWith(`${CMS}/receipt?token=`), 'the emailed receipt link is forwarded to the CMS', page.url());

expect(cspViolations.length === 0, 'no Content-Security-Policy violations', cspViolations.join('\n'));
expect(consoleErrors.length === 0, 'no console errors', consoleErrors.join('\n'));
expect(axeBlocking.length === 0, 'no serious or critical WCAG 2.1 AA findings', `\n    ${axeBlocking.join('\n    ')}`);

cleanup();
fs.rmSync(tmp, { recursive: true, force: true });
if (failures.length) {
  console.error(`\n✗ storefront e2e: ${failures.length} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`\n✓ storefront e2e: ${passed} passed`);
process.exit(0);
