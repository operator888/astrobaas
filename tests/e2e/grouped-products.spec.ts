/**
 * Grouped products in a real browser.
 *
 *  1. Admin: build a group in the product editor's Group tab — search, add,
 *     reorder — and see the out-of-stock warning; the list shows "from" and
 *     "group of N".
 *  2. Storefront starter: the group's page lists every member with a quantity
 *     box and one "Add selected to cart" button, at 1280 px and at 375 px, and
 *     the form works with JavaScript switched off.
 *
 * Screenshots are saved only when SHOT_DIR is set.
 *
 * The starter is a separate static site, so test 2 builds it against this run's
 * CMS (PUBLIC_CMS_URL = the e2e server) into a temp directory and serves that
 * directory itself. It needs `examples/storefront/node_modules`; when that is
 * missing it runs `npm install` there first, and skips — saying why — if that
 * is not possible (no network).
 */
import { test, expect, type Page } from '@playwright/test';
import { adminLogin } from './lib/session';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const SHOT_DIR = process.env.SHOT_DIR;

/** One shared admin session, so the suite stays inside the login throttle — see lib/session.ts. */
const login = (page: Page) => adminLogin(page);

async function shot(page: Page, name: string) {
  if (!SHOT_DIR) return;
  await page.screenshot({ path: `${SHOT_DIR}/${name}.png`, fullPage: true });
}

/** Create the members (one sold out) and return them, through the real API. */
async function makeMembers(page: Page, run: string) {
  await page.goto('/admin/products');
  const csrf = await page.locator('meta[name="csrf-token"]').first().getAttribute('content');
  // Commerce is opt-in: on a fresh install the catalogue API is a 404 to
  // anonymous callers — which is what the starter's build is.
  const open = await page.request.post('/api/settings/update', {
    headers: { 'X-CSRF-Token': csrf ?? '' }, data: { commerce_enabled: true },
  });
  expect(open.status(), await open.text()).toBe(200);
  const make = async (name: string, price: number, stock: number | null) => {
    const res = await page.request.post('/api/products', {
      headers: { 'X-CSRF-Token': csrf ?? '' },
      data: { name, slug: `${name.toLowerCase().replace(/\s+/g, '-')}-${run}`, sku: `${name.slice(0, 3).toUpperCase()}-${run}`, price_cents: price, status: 'active', stock },
    });
    expect(res.status(), await res.text()).toBe(201);
    return (await res.json()).data as { id: string; name: string; slug: string };
  };
  return {
    csrf: csrf ?? '',
    camera: await make(`Camera ${run}`, 80000, 2),
    lens: await make(`Lens ${run}`, 20000, 5),
    tripod: await make(`Tripod ${run}`, 5000, 0),
    battery: await make(`Battery ${run}`, 3000, null),
  };
}

test('grouped products: build a group in the admin with the members picker', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await login(page);
  const run = `g${Date.now().toString(36)}`;
  const m = await makeMembers(page, run);

  await page.goto('/admin/products');
  await page.getByRole('button', { name: '+ New product' }).click();
  const dialog = page.locator('#product-dialog');
  await dialog.locator('input[name="name"]').fill(`Starter kit ${run}`);
  await dialog.getByRole('button', { name: 'Group', exact: true }).click();
  await dialog.locator('input[name="is_grouped"]').check();
  await expect(dialog.locator('#group-editor')).toBeVisible();

  // Search by the run tag: every member, and only the ones that can join.
  const search = dialog.locator('#group-search');
  for (const name of [m.camera.name, m.tripod.name, m.lens.name]) {
    await search.fill(name);
    await dialog.getByRole('button', { name: `Add ${name} to the group` }).click();
  }
  await expect(dialog.locator('#group-members li')).toHaveCount(3);
  // The sold-out tripod raises the warning before anyone saves.
  await expect(dialog.locator('#group-warning')).toContainText(`Out of stock: ${m.tripod.name}`);
  // Reorder: lens to the top.
  await dialog.getByRole('button', { name: `Move ${m.lens.name} up` }).click();
  await dialog.getByRole('button', { name: `Move ${m.lens.name} up` }).click();
  await expect(dialog.locator('#group-members li').first()).toContainText(m.lens.name);
  await search.fill(run);
  await expect(dialog.locator('#group-results li')).toHaveCount(1); // only the battery is left to add
  await shot(page, 'grouped-admin-members-picker');

  const [saved] = await Promise.all([
    page.waitForResponse((r) => new URL(r.url()).pathname === '/api/products' && r.request().method() === 'POST'),
    dialog.getByRole('button', { name: 'Save' }).click(),
  ]);
  // Status only: the page reloads on success, so the body is gone by now.
  expect(saved.status()).toBe(201);
  await page.goto(`/admin/products?q=${encodeURIComponent(`Starter kit ${run}`)}`);
  const row = page.locator('tr.product-row', { hasText: `Starter kit ${run}` });
  await expect(row).toContainText('group of 3');
  // "From" the cheapest member a shopper can see — the €50 tripod, sold out or not.
  await expect(row).toContainText('from €50.00');
  await expect(row).toContainText('1 member out of stock');
  await shot(page, 'grouped-admin-list');

  // The saved order and members come back on edit.
  await row.getByRole('button', { name: 'Edit' }).click();
  await dialog.getByRole('button', { name: 'Group', exact: true }).click();
  await expect(dialog.locator('#group-members li')).toHaveCount(3);
  await expect(dialog.locator('#group-members li').first()).toContainText(m.lens.name);
  await shot(page, 'grouped-admin-edit');
});

/* ------------------------------------------------------------ starter --- */

const STARTER = path.resolve(process.cwd(), 'examples/storefront');

function ensureStarterDeps(): string | null {
  if (fs.existsSync(path.join(STARTER, 'node_modules', 'astro'))) return null;
  try {
    execFileSync('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: STARTER, stdio: 'pipe', timeout: 240_000 });
    return null;
  } catch (err) {
    return `could not install the starter's dependencies: ${(err as Error).message.split('\n')[0]}`;
  }
}

/** A minimal static server for the built starter: directory index, nothing else. */
function serve(root: string): Promise<{ url: string; close: () => void }> {
  const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };
  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    let file = path.join(root, pathname);
    if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.existsSync(file)) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const { port } = server.address() as { port: number };
    resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close() });
  }));
}

test('grouped products: the starter\'s group page at 1280 px and 375 px, and without JavaScript', async ({ page, browser, baseURL }) => {
  test.setTimeout(420_000);
  await login(page);
  const run = `s${Date.now().toString(36)}`;
  const m = await makeMembers(page, run);
  const slug = `camera-kit-${run}`;
  const res = await page.request.post('/api/products', {
    headers: { 'X-CSRF-Token': m.csrf },
    data: {
      name: `Everything you need ${run}`, slug, price_cents: 0, status: 'active',
      short_description: '<p>A camera, a lens, a tripod and a battery — each bought on its own.</p>',
      type: 'grouped', grouped_product_ids: [m.tripod.id, m.camera.id, m.lens.id, m.battery.id],
    },
  });
  expect(res.status(), await res.text()).toBe(201);

  const why = ensureStarterDeps();
  test.skip(why !== null, why ?? '');

  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'starter-grouped-'));
  execFileSync('npx', ['astro', 'build', '--outDir', out], {
    cwd: STARTER, stdio: 'pipe', timeout: 300_000,
    env: { ...process.env, PUBLIC_CMS_URL: baseURL ?? 'http://127.0.0.1:4399', PUBLIC_SHOP_NAME: 'Demo shop' },
  });
  const site = await serve(out);
  try {
    const url = `${site.url}/product/${slug}/`;
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(url);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(`Everything you need ${run}`);
    const items = page.locator('.group-item');
    await expect(items).toHaveCount(4);
    await expect(items.first()).toContainText(m.tripod.name);
    await expect(items.first()).toContainText('Out of stock');
    await expect(page.locator(`input[name="add.${m.tripod.id}"]`)).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Add selected to cart' })).toBeEnabled();
    await shot(page, 'grouped-starter-1280');

    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(url);
    // No sideways scroll at phone width.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await shot(page, 'grouped-starter-375');

    // With JavaScript OFF the form still submits: the browser sends one
    // `add.<id>` per member to the cart page.
    const noJs = await browser.newContext({ javaScriptEnabled: false });
    const plain = await noJs.newPage();
    await plain.goto(url);
    await plain.locator(`input[name="add.${m.lens.id}"]`).fill('2');
    await plain.locator(`input[name="add.${m.battery.id}"]`).fill('0');
    await plain.getByRole('button', { name: 'Add selected to cart' }).click();
    await plain.waitForURL(/\/cart\/\?/);
    const sent = new URL(plain.url()).searchParams;
    expect(sent.get(`add.${m.camera.id}`)).toBe('1');
    expect(sent.get(`add.${m.lens.id}`)).toBe('2');
    expect(sent.get(`add.${m.battery.id}`)).toBe('0');
    expect(sent.has(`add.${m.tripod.id}`)).toBe(false); // disabled: not sent
    await noJs.close();

    // With JavaScript on, the cart page takes those lines in — each member its
    // own line, the group never one — and drops the query.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(url);
    await page.locator(`input[name="add.${m.lens.id}"]`).fill('2');
    await page.getByRole('button', { name: 'Add selected to cart' }).click();
    await page.waitForURL(/\/cart\/$/);
    const cart = await page.evaluate(() => JSON.parse(localStorage.getItem('astrobaas-cart') ?? '[]'));
    expect(cart).toEqual(expect.arrayContaining([
      { product_id: m.camera.id, qty: 1 }, { product_id: m.lens.id, qty: 2 }, { product_id: m.battery.id, qty: 1 },
    ]));
    expect(cart).toHaveLength(3);
    await shot(page, 'grouped-starter-cart');
  } finally {
    site.close();
    fs.rmSync(out, { recursive: true, force: true });
  }
});
