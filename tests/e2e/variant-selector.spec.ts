/**
 * The variant selector on the storefront starter's product page, in a real
 * browser: colour then size, a sold-out combination disabled with its reason
 * in words, the price / stock / SKU following the choice, the choice kept in
 * ?variant=, a keyboard path through the radio groups, and the plain select
 * that remains when script is off.
 *
 * The CMS has no product page of its own ("nothing in this repo renders a
 * product page" — src/pages/api/products/[id].ts), so the page under test is
 * the starter's: the suite stocks the e2e CMS, builds examples/storefront
 * against it, and serves the build on a second port. The starter's
 * dependencies are installed on first run if they are missing.
 *
 * Screenshots are written only when SHOT_DIR is set:
 *   variant-selector-1280.png, variant-selector-375.png,
 *   variant-selector-nojs-1280.png, variant-selector-nojs-375.png
 */
import { test, expect, type Page, type Browser } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { adminLogin } from './lib/session';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const STOREFRONT = fileURLToPath(new URL('../../examples/storefront', import.meta.url));
const SHOT_DIR = process.env.SHOT_DIR;

async function shot(page: Page, name: string) {
  if (SHOT_DIR) await page.screenshot({ path: `${SHOT_DIR}/${name}.png`, fullPage: true });
}

/** One shared admin session, so the suite stays inside the login throttle — see lib/session.ts. */
const login = (page: Page) => adminLogin(page);

const run = Date.now().toString(36);
const slug = `variant-tee-${run}`;
let sf = '';
let server: http.Server | null = null;
const ids: Record<string, string> = {};

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser, baseURL }) => {
  test.setTimeout(600_000);
  const page = await (await browser.newContext({ baseURL })).newPage();
  await login(page);
  await page.goto('/admin/products');
  const csrf = (await page.locator('meta[name="csrf-token"]').first().getAttribute('content')) ?? '';
  const post = async (url: string, data: unknown) => {
    const res = await page.request.post(url, { headers: { 'X-CSRF-Token': csrf }, data });
    expect(res.ok(), `${url}: ${await res.text()}`).toBe(true);
    return (await res.json()).data;
  };
  await post('/api/settings/update', { commerce_enabled: true });
  // Colour then size. Black is sold out in every size; Red S is sold out;
  // there is no Blue S at all. Red M has its own price and SKU.
  const product = await post('/api/products', {
    name: `Variant Tee ${run}`, slug, price_cents: 2000, sku: 'TEE', status: 'active', stock: null,
    attributes: [
      { name: 'Colour', values: ['Red', 'Blue', 'Black'], visible: true },
      { name: 'Size', values: ['S', 'M', 'L'], visible: true },
    ],
    variants: [
      { options: { Colour: 'Red', Size: 'S' }, stock: 0, sku: 'TEE-R-S' },
      { options: { Colour: 'Red', Size: 'M' }, stock: 10, sku: 'TEE-R-M', price_cents: 2500 },
      { options: { Colour: 'Red', Size: 'L' }, stock: 2, sku: 'TEE-R-L' },
      { options: { Colour: 'Blue', Size: 'M' }, stock: 5, sku: 'TEE-B-M' },
      // On sale through its OWN fields: only the CMS's `resolved` says €15.00,
      // so this proves `resolved` reaches the storefront through the list route.
      { options: { Colour: 'Blue', Size: 'L' }, stock: 5, sku: 'TEE-B-L', price_cents: 2000, regular_price_cents: 2000, sale_price_cents: 1500 },
      { options: { Colour: 'Black', Size: 'M' }, stock: 0, sku: 'TEE-K-M' },
    ],
  });
  for (const v of product.variants) ids[v.sku] = v.id;
  expect(Object.keys(ids)).toHaveLength(6);
  // The price the picker shows comes from the CMS, already resolved.
  const red = product.variants.find((v: { sku: string }) => v.sku === 'TEE-R-M');
  const read = await (await page.request.get(`/api/products/${product.id}`)).json();
  const redRead = read.data.variants.find((v: { id: string }) => v.id === red.id);
  expect(redRead.resolved).toMatchObject({ price_cents: 2500, sku: 'TEE-R-M' });
  await page.context().close();

  if (!fs.existsSync(path.join(STOREFRONT, 'node_modules', 'astro'))) {
    execFileSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: STOREFRONT, stdio: 'inherit' });
  }
  execFileSync('npx', ['astro', 'build'], {
    cwd: STOREFRONT,
    env: { ...process.env, PUBLIC_CMS_URL: baseURL!, PUBLIC_SHOP_NAME: 'Variant Shop' },
    stdio: 'inherit',
  });
  const dist = path.join(STOREFRONT, 'dist');
  const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    let file = path.join(dist, decodeURIComponent(url.pathname));
    if (!file.startsWith(dist)) { res.writeHead(403).end(); return; }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.existsSync(file)) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream' }).end(fs.readFileSync(file));
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  sf = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
});

function watchCsp(page: Page): string[] {
  const out: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && /Content Security Policy|Refused to/.test(m.text())) out.push(m.text());
  });
  return out;
}

test('choose colour then size: sold-out values are disabled with a reason, the page follows the choice', async ({ page }) => {
  const csp = watchCsp(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${sf}/product/${slug}/`);

  const colour = page.getByRole('group', { name: /^Colour/ });
  const size = page.getByRole('group', { name: /^Size/ });
  await expect(colour).toBeVisible();
  await expect(page.locator('[data-variant-fallback]')).toBeHidden();

  // Every Black is sold out: disabled, and it says so in words.
  const black = colour.getByRole('radio', { name: /^Black/ });
  await expect(black).toBeDisabled();
  await expect(colour.locator('[data-value="Black"] [data-note]')).toHaveText('Sold out');
  // Nothing chosen yet: nothing to buy.
  await expect(page.locator('[data-variant-buy]')).toBeDisabled();

  await colour.getByRole('radio', { name: /^Red/ }).check();
  await expect(size.getByRole('radio', { name: /^S/ })).toBeDisabled();
  await expect(size.locator('[data-value="S"] [data-note]')).toHaveText('Sold out in Red');

  await size.getByRole('radio', { name: /^M/ }).check();
  await expect(page.locator('[data-variant-price]')).toHaveText('€25.00');
  await expect(page.locator('[data-variant-sku]')).toHaveText('TEE-R-M');
  await expect(page.locator('[data-stock]')).toHaveText('In stock');
  await expect(page.locator('[data-variant-live]')).toContainText('Red / M: €25.00');
  await expect(page.locator('[data-variant-buy]')).toBeEnabled();
  expect(new URL(page.url()).searchParams.get('variant')).toBe(ids['TEE-R-M']);
  await shot(page, 'variant-selector-1280');

  // Blue has no S: switching colour keeps M, which Blue has, and S reads unavailable.
  await colour.getByRole('radio', { name: /^Blue/ }).check();
  await expect(size.locator('[data-value="S"] [data-note]')).toHaveText('Not available in Blue');
  await expect(page.locator('[data-variant-sku]')).toHaveText('TEE-B-M');
  await expect(page.locator('[data-variant-price]')).toHaveText('€20.00');

  await page.setViewportSize({ width: 375, height: 812 });
  await colour.getByRole('radio', { name: /^Red/ }).check();
  await size.getByRole('radio', { name: /^M/ }).check();
  await shot(page, 'variant-selector-375');
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(375);

  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)).toEqual([]);
  expect(csp).toEqual([]);
});

test('a ?variant= link opens that choice', async ({ page }) => {
  await page.goto(`${sf}/product/${slug}/?variant=${ids['TEE-B-L']}`);
  await expect(page.getByRole('group', { name: /^Colour/ }).getByRole('radio', { name: /^Blue/ })).toBeChecked();
  await expect(page.getByRole('group', { name: /^Size/ }).getByRole('radio', { name: /^L/ })).toBeChecked();
  await expect(page.locator('[data-variant-sku]')).toHaveText('TEE-B-L');
  // The sale price the checkout will charge, and the regular one struck through.
  await expect(page.locator('[data-variant-price]')).toContainText('€15.00');
  await expect(page.locator('[data-variant-price] del')).toContainText('€20.00');
});

test('keyboard: arrow keys move within an option, skipping sold-out values', async ({ page }) => {
  await page.goto(`${sf}/product/${slug}/`);
  const red = page.getByRole('group', { name: /^Colour/ }).getByRole('radio', { name: /^Red/ });
  await red.focus();
  await page.keyboard.press('Space');
  await expect(red).toBeChecked();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('group', { name: /^Colour/ }).getByRole('radio', { name: /^Blue/ })).toBeChecked();
  // Black is sold out: the next arrow wraps past it, back to Red.
  await page.keyboard.press('ArrowRight');
  await expect(red).toBeChecked();
  // Tab leaves the colour group for the size group.
  await page.keyboard.press('Tab');
  const focusedGroup = await page.evaluate(() => document.activeElement?.closest('fieldset')?.dataset.axis);
  expect(focusedGroup).toBe('Size');
});

test('without script: a plain select, sold-out variants disabled, that submits the choice', async ({ browser }: { browser: Browser }) => {
  for (const width of [1280, 375]) {
    const ctx = await browser.newContext({ javaScriptEnabled: false, viewport: { width, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(`${sf}/product/${slug}/`);
    const select = page.getByLabel('Option');
    await expect(select).toBeVisible();
    await expect(page.locator('[data-variant-groups]')).toBeHidden();
    await expect(select.locator(`option[value="${ids['TEE-R-S']}"]`)).toBeDisabled();
    await expect(select.locator(`option[value="${ids['TEE-K-M']}"]`)).toBeDisabled();
    await select.selectOption(ids['TEE-R-M']);
    await shot(page, `variant-selector-nojs-${width}`);
    if (width === 375) {
      await Promise.all([page.waitForURL(/[?&]variant=/), page.getByRole('button', { name: 'Add to cart' }).click()]);
      expect(new URL(page.url()).searchParams.get('variant')).toBe(ids['TEE-R-M']);
    }
    await ctx.close();
  }
});
