/**
 * Colour swatches, in a real browser: the storefront starter's variant
 * selector drawing a colour option as swatches (one chosen, one sold out),
 * under the starter's strict CSP, at 1280 px and 375 px; and the admin
 * product editor's swatch editor.
 *
 * Like variant-selector.spec.ts, the page under test is the starter's: the
 * suite stocks the e2e CMS, builds examples/storefront against it and serves
 * the build on a free port.
 *
 * Screenshots are written only when SHOT_DIR is set:
 *   color-swatches-1280.png, color-swatches-375.png,
 *   color-swatches-focus-1280.png, color-swatches-nojs-375.png,
 *   color-swatches-admin-editor.png
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
const slug = `swatch-tee-${run}`;
let productId = '';
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
  // Colour is marked as a swatch option. Ivory is pale (it needs the darker
  // border); every Black is sold out (cross-hatched, with a reason).
  const product = await post('/api/products', {
    name: `Swatch Tee ${run}`, slug, price_cents: 2000, sku: 'SW', status: 'active', stock: null,
    attributes: [
      {
        name: 'Colour', values: ['Red', 'Ivory', 'Navy', 'Black'], visible: true, display: 'swatch',
        swatches: { Red: { color: '#c62828' }, Ivory: { color: '#fffff0' }, Navy: { color: '#1e3a8a' }, Black: { color: '#111111' } },
      },
      { name: 'Size', values: ['S', 'M'], visible: true },
    ],
    variants: [
      { options: { Colour: 'Red', Size: 'S' }, stock: 4, sku: 'SW-R-S' },
      { options: { Colour: 'Red', Size: 'M' }, stock: 4, sku: 'SW-R-M' },
      { options: { Colour: 'Ivory', Size: 'M' }, stock: 4, sku: 'SW-I-M' },
      { options: { Colour: 'Navy', Size: 'M' }, stock: 4, sku: 'SW-N-M' },
      { options: { Colour: 'Black', Size: 'M' }, stock: 0, sku: 'SW-K-M' },
    ],
  });
  productId = product.id;
  for (const v of product.variants) ids[v.sku] = v.id;
  // Stored, normalised, and on the public read the storefront builds from.
  const read = await (await page.request.get(`/api/products/${product.id}`)).json();
  expect(read.data.attributes[0]).toMatchObject({ display: 'swatch', swatches: { Ivory: { color: '#fffff0' } } });
  await page.context().close();

  if (!fs.existsSync(path.join(STOREFRONT, 'node_modules', 'astro'))) {
    execFileSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: STOREFRONT, stdio: 'inherit' });
  }
  execFileSync('npx', ['astro', 'build'], {
    cwd: STOREFRONT,
    env: { ...process.env, PUBLIC_CMS_URL: baseURL!, PUBLIC_SHOP_NAME: 'Swatch Shop' },
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

test('colour swatches: painted under the strict CSP, chosen by ring and check, sold out cross-hatched with words', async ({ page }) => {
  const csp = watchCsp(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${sf}/product/${slug}/`);

  const colour = page.getByRole('group', { name: /^Colour/ });
  await expect(colour).toBeVisible();
  await expect(colour).toHaveAttribute('data-display', 'swatches');
  await expect(page.getByRole('group', { name: /^Size/ })).toHaveAttribute('data-display', 'buttons');

  // The colour reached the tile through the CSSOM: the CSP allowed it.
  const tile = (value: string) => colour.locator(`[data-value="${value}"] .ab-variant__swatch`);
  await expect(tile('Red')).toHaveCSS('background-color', 'rgb(198, 40, 40)');
  await expect(tile('Navy')).toHaveCSS('background-color', 'rgb(30, 58, 138)');
  await expect(tile('Ivory')).toHaveAttribute('data-swatch-tone', 'light');
  // No inline style in the HTML the server sent. (After mount the CSSOM
  // reflects each painted property into a style attribute on the tile; the
  // CSP does not police that, which is the point. So check the SOURCE.)
  const html = await (await page.request.get(`${sf}/product/${slug}/`)).text();
  const group = html.slice(html.indexOf('data-display="swatches"'), html.indexOf('</fieldset>', html.indexOf('data-display="swatches"')));
  expect(group).toContain('data-swatch-color="#c62828"');
  expect(group).not.toMatch(/\sstyle=/);

  // Sold out: disabled, its name still in the accessible name, and a reason in words.
  const black = colour.getByRole('radio', { name: /^Black/ });
  await expect(black).toBeDisabled();
  await expect(colour.locator('[data-value="Black"] [data-note]')).toHaveText('Sold out');
  await expect(colour.locator('[data-value="Black"] [data-note]')).toBeVisible();
  // ...and its NAME is in sight too: a disabled radio takes no focus, so the
  // hover/focus tag cannot be the only place a sighted keyboard user reads it.
  await expect(colour.locator('[data-value="Black"] .ab-variant__swatch-name')).toBeVisible();
  await expect(colour.locator('[data-value="Black"] .ab-variant__swatch-name')).toHaveText('Black');
  await expect(colour.locator('[data-value="Red"] .ab-variant__swatch-name')).toBeHidden();
  const hatch = await tile('Black').evaluate((el) => getComputedStyle(el, '::after').backgroundImage);
  expect(hatch).toContain('repeating-linear-gradient');

  // Choose Red: a ring and a check, not colour alone.
  await colour.getByRole('radio', { name: /^Red/ }).check();
  await expect(colour.locator('[data-value="Red"] .ab-variant__check')).toBeVisible();
  await expect(colour.locator('[data-value="Navy"] .ab-variant__check')).toBeHidden();
  expect(await tile('Red').evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe('none');
  await page.getByRole('group', { name: /^Size/ }).getByRole('radio', { name: /^M/ }).check();
  await expect(page.locator('[data-variant-sku]')).toHaveText('SW-R-M');
  expect(new URL(page.url()).searchParams.get('variant')).toBe(ids['SW-R-M']);
  await expect(page.locator('legend', { hasText: 'Colour' })).toContainText('Colour: Red');

  // Hover shows the name beside the swatch.
  await colour.locator('[data-value="Navy"]').hover();
  await expect(colour.locator('[data-value="Navy"] .ab-variant__label')).toHaveText('Navy');
  const box = await colour.locator('[data-value="Navy"] .ab-variant__label').boundingBox();
  expect(box && box.width).toBeGreaterThan(10);
  await page.mouse.move(0, 0);
  await shot(page, 'color-swatches-1280');

  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)).toEqual([]);

  await page.setViewportSize({ width: 375, height: 812 });
  await shot(page, 'color-swatches-375');
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(375);
  expect(csp).toEqual([]);
});

test('keyboard: arrows move between swatches skipping sold out, and focus shows the name', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${sf}/product/${slug}/`);
  const colour = page.getByRole('group', { name: /^Colour/ });
  const red = colour.getByRole('radio', { name: /^Red/ });
  await red.focus();
  await page.keyboard.press('Space');
  await expect(red).toBeChecked();
  await page.keyboard.press('ArrowRight');
  const ivory = colour.getByRole('radio', { name: /^Ivory/ });
  await expect(ivory).toBeChecked();
  // Not toBeVisible(): a 1x1 clipped element counts as visible. Its real size does not.
  const tag = await colour.locator('[data-value="Ivory"] .ab-variant__label').boundingBox();
  expect(tag && tag.width).toBeGreaterThan(10);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  // Navy, then past the sold-out Black back to Red.
  await expect(red).toBeChecked();
  await shot(page, 'color-swatches-focus-1280');
});

test('without script: the same plain select as the button display', async ({ browser }: { browser: Browser }) => {
  const ctx = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 375, height: 812 } });
  const page = await ctx.newPage();
  await page.goto(`${sf}/product/${slug}/`);
  await expect(page.getByLabel('Option')).toBeVisible();
  await expect(page.locator('[data-variant-groups]')).toBeHidden();
  await expect(page.getByLabel('Option').locator(`option[value="${ids['SW-K-M']}"]`)).toBeDisabled();
  await shot(page, 'color-swatches-nojs-375');
  await ctx.close();
});

test('admin: set a swatch colour per value, mark the option, and a bad hex is refused', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await login(page);
  await page.goto(`/admin/products?q=${run}`);
  await page.click(`.edit[data-id="${productId}"]`);
  await expect(page.locator('#product-dialog')).toBeVisible();
  await page.click('[data-tab="advanced"]');

  const editor = page.locator('[data-swatch-editor]');
  const colourBox = editor.locator('fieldset[data-swatch-attr="Colour"]');
  await expect(colourBox).toBeVisible();
  await expect(colourBox.locator('[data-swatch-mark]')).toBeChecked();
  await expect(colourBox.locator('tr[data-swatch-value="Ivory"] [data-swatch-color]')).toHaveValue('#fffff0');

  // The values follow the text: a new size value appears in the Size box.
  const text = page.locator('[name="attributes_text"]');
  await text.fill('Colour: Red, Ivory, Navy, Black\nSize: S, M, L');
  await expect(editor.locator('fieldset[data-swatch-attr="Size"] tr[data-swatch-value="L"]')).toBeVisible();
  // The Colour swatches survived the text edit.
  await expect(colourBox.locator('tr[data-swatch-value="Red"] [data-swatch-color]')).toHaveValue('#c62828');

  // Change Navy, mark nothing new, save.
  await colourBox.locator('tr[data-swatch-value="Navy"] [data-swatch-color]').fill('#0b1f5c');
  await page.locator('[data-swatch-section]').scrollIntoViewIfNeeded();
  if (SHOT_DIR) await page.locator('#product-dialog').screenshot({ path: `${SHOT_DIR}/color-swatches-admin-editor.png` });
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).include('[data-swatch-section]').analyze();
  expect(violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)).toEqual([]);

  // A bad hex is refused by the server, with the value named.
  await colourBox.locator('tr[data-swatch-value="Red"] [data-swatch-color]').fill('#ff00zz');
  await expect(colourBox.locator('tr[data-swatch-value="Red"] [data-swatch-color]')).toHaveAttribute('aria-invalid', 'true');
  const alertText = new Promise<string>((resolve) => page.once('dialog', async (d) => { resolve(d.message()); await d.dismiss(); }));
  await page.click('#product-form button[type="submit"]');
  expect(await alertText).toMatch(/Invalid swatch: Colour Red/);

  await colourBox.locator('tr[data-swatch-value="Red"] [data-swatch-color]').fill('#c62828');
  const [saved] = await Promise.all([
    page.waitForResponse((r) => r.url().includes(`/api/products/${productId}`) && r.request().method() === 'PUT'),
    page.click('#product-form button[type="submit"]'),
  ]);
  expect(saved.status()).toBeLessThan(400);
  const after = await (await page.request.get(`/api/products/${productId}`)).json();
  const [c, s] = after.data.attributes;
  expect(c).toMatchObject({ name: 'Colour', display: 'swatch', swatches: { Red: { color: '#c62828' }, Navy: { color: '#0b1f5c' }, Ivory: { color: '#fffff0' } } });
  expect(s).toMatchObject({ name: 'Size', values: ['S', 'M', 'L'] });
  expect(s.swatches).toBeUndefined();
});
