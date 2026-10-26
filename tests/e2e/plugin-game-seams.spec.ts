/**
 * The two admin surfaces the plugin game seams added, in a real browser:
 *
 *   1. Admin → Webhooks lists the core events AND every event an active plugin
 *      declared (`webhookEvents`), and one click adds an event to the form.
 *   2. Settings → Commerce → Public order counter: the switch and the timezone
 *      are wired to the settings the public endpoint reads — on, the endpoint
 *      answers `{ count, month }`; off, it is a 404.
 *
 * The plugin event comes from tests/e2e/fixtures/line-addons-plugin.mjs
 * (`e2e.engraved`), loaded through ASTROBAAS_PLUGINS like a paid module.
 * Screenshots are written only when SHOT_DIR is set.
 */
import { test, expect, type Page } from '@playwright/test';
import { adminLogin } from './lib/session';

const SHOT_DIR = process.env.SHOT_DIR;

/** One shared admin session, so the suite stays inside the login throttle — see lib/session.ts. */
const login = (page: Page) => adminLogin(page);

async function shot(page: Page, name: string) {
  if (!SHOT_DIR) return;
  await page.screenshot({ path: `${SHOT_DIR}/${name}.png`, fullPage: true });
}

async function csrfOf(page: Page): Promise<string> {
  return (await page.locator('meta[name="csrf-token"]').first().getAttribute('content')) ?? '';
}

test('webhooks: core and plugin-declared events are listed, and one click adds one', async ({ page }) => {
  await login(page);
  await page.goto('/admin/webhooks');

  const catalogue = page.locator('#event-catalogue');
  await expect(catalogue).toBeVisible();
  await expect(catalogue.locator('button[data-event="order.created"]')).toBeVisible();
  // The fixture plugin's declared event, labelled with its plugin.
  const pluginEvent = page.locator('#plugin-events button[data-event="e2e.engraved"]');
  await expect(pluginEvent).toBeVisible();
  await expect(page.locator('#plugin-events li', { hasText: 'e2e.engraved' })).toContainText('e2e-line-addons');

  const input = page.locator('#w-events');
  await input.fill('');
  await pluginEvent.click();
  await catalogue.locator('button[data-event="order.created"]').click();
  await pluginEvent.click(); // a second click does not duplicate it
  await expect(input).toHaveValue('e2e.engraved, order.created');
  await shot(page, 'plugin-game-seams-webhooks');
});

test('public order counter: the admin switch decides whether the endpoint exists', async ({ page }) => {
  await login(page);
  await page.goto('/admin/settings');
  // The commerce form renders only for a shop.
  const on = await page.request.post('/api/settings/update', {
    headers: { 'X-CSRF-Token': await csrfOf(page) },
    data: { commerce_enabled: true, public_order_stats_enabled: false },
  });
  expect(on.ok()).toBeTruthy();
  await page.goto('/admin/settings');

  const box = page.locator('#commerce-form input[name="public_order_stats_enabled"]');
  const tz = page.locator('#shop_timezone');
  await box.scrollIntoViewIfNeeded();
  await expect(box).not.toBeChecked();
  expect((await page.request.get('/api/stats/orders-this-month')).status()).toBe(404);

  await box.check();
  await tz.fill('Europe/Athens');
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/settings/update') && r.request().method() === 'POST'),
    page.click('#commerce-form button[type="submit"]'),
  ]);

  const res = await page.request.get('/api/stats/orders-this-month');
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(Object.keys(body.data).sort()).toEqual(['count', 'month']);
  expect(Number.isInteger(body.data.count)).toBeTruthy();
  expect(body.data.month).toMatch(/^\d{4}-\d{2}$/);
  expect(res.headers()['cache-control']).toContain('max-age=60');

  await page.goto('/admin/settings');
  await expect(box).toBeChecked();
  await expect(tz).toHaveValue('Europe/Athens');
  await box.scrollIntoViewIfNeeded();
  await shot(page, 'plugin-game-seams-settings');

  // An unknown zone is refused, not silently replaced by UTC.
  await tz.fill('Mars/Olympus');
  const [bad] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/settings/update') && r.request().method() === 'POST'),
    page.click('#commerce-form button[type="submit"]'),
  ]);
  expect(bad.status()).toBe(400);

  // Switch it off again so the suite is re-runnable against a persistent db.
  await page.goto('/admin/settings');
  await box.uncheck();
  await tz.fill('');
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/settings/update') && r.request().method() === 'POST'),
    page.click('#commerce-form button[type="submit"]'),
  ]);
  expect((await page.request.get('/api/stats/orders-this-month')).status()).toBe(404);
});
