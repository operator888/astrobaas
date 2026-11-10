/**
 * Campaign attribution in a real browser: the served /consent.js keeps the
 * landing page's campaign tags ONLY for a visitor who granted marketing
 * consent, checkout puts them on the order, and the admin shows them on the
 * order and in Insights. A visitor without consent leaves no cookie and an
 * order with no attribution.
 *
 * Screenshots are written only when SHOT_DIR is set.
 */
import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { adminLogin } from './lib/session';

const SHOT_DIR = process.env.SHOT_DIR;

/** One shared admin session, so the suite stays inside the login throttle — see lib/session.ts. */
const login = (page: Page) => adminLogin(page);

async function shot(page: Page, name: string) {
  if (!SHOT_DIR) return;
  await page.screenshot({ path: `${SHOT_DIR}/${name}.png`, fullPage: true });
}

/** The consent record the banner would write, for the version the server serves. */
async function consentCookie(page: Page, granted: string[]) {
  const js = await (await page.request.get('/consent.js')).text();
  const v = Number(js.match(/var VERSION = (\d+);/)?.[1]);
  expect(v).toBeGreaterThan(0);
  return encodeURIComponent(JSON.stringify({ v, t: Date.now(), granted }));
}

async function cookieValue(context: BrowserContext, name: string) {
  return (await context.cookies()).find((c) => c.name === name)?.value;
}

/** Visit a campaign link as a shopper, then check out from the same browser. */
async function shopperOrder(
  context: BrowserContext, landing: string, email: string, productId: string,
): Promise<{ status: number; attributionCookie: string | undefined }> {
  const page = await context.newPage();
  await page.goto(landing);
  // consent.js runs deferred; give it the chance to write before reading.
  await page.waitForFunction(() => typeof (window as any).astrobaasConsent === 'object');
  const attributionCookie = await cookieValue(context, 'astrobaas_attribution');
  const csrf = await cookieValue(context, 'astrobaas_csrf');
  const res = await page.request.post('/api/orders', {
    headers: { 'X-CSRF-Token': csrf ?? '' },
    data: { email, name: 'E2E Shopper', items: [{ product_id: productId, qty: 1 }] },
  });
  expect(res.status(), await res.text()).toBe(201);
  await page.close();
  return { status: res.status(), attributionCookie };
}

test('attribution: kept with marketing consent, shown on the order and in Insights; nothing without consent', async ({ page, browser, baseURL }) => {
  await login(page);
  await page.goto('/admin/settings');
  const csrf = await page.locator('meta[name="csrf-token"]').first().getAttribute('content');
  const on = await page.request.post('/api/settings/update', {
    headers: { 'X-CSRF-Token': csrf ?? '' },
    data: { commerce_enabled: true, attribution_enabled: true },
  });
  expect(on.status(), await on.text()).toBe(200);
  const run = Date.now().toString(36);
  const made = await page.request.post('/api/products', {
    headers: { 'X-CSRF-Token': csrf ?? '' },
    data: { name: `Attribution ${run}`, slug: `attribution-${run}`, price_cents: 2500, status: 'active', stock: 20 },
  });
  expect(made.status(), await made.text()).toBe(201);
  const productId = (await made.json()).data.id as string;

  const landing = '/?utm_source=Google&utm_medium=cpc&utm_campaign=autumn-sale&gclid=e2e-click-1';

  // ── A shopper who allowed marketing cookies ──────────────────────────────
  const yesCtx = await browser.newContext({ baseURL });
  await yesCtx.addCookies([{ name: 'astrobaas_consent', value: await consentCookie(page, ['necessary', 'marketing']), url: baseURL! }]);
  const yes = await shopperOrder(yesCtx, landing, `attr-yes-${run}@example.com`, productId);
  expect(yes.attributionCookie, 'the first-party cookie is written after marketing consent').toBeTruthy();
  const stored = JSON.parse(decodeURIComponent(yes.attributionCookie!));
  expect(stored.last.utm_source).toBe('google');
  expect(stored.last.gclid).toBe('e2e-click-1');

  // The cookie declaration names it, at desktop and phone width.
  const decl = await yesCtx.newPage();
  for (const [w, h, tag] of [[1280, 900, '1280'], [375, 812, '375']] as const) {
    await decl.setViewportSize({ width: w, height: h });
    await decl.goto('/cookies');
    await expect(decl.getByText('astrobaas_attribution').first()).toBeVisible();
    await shot(decl, `conversion-attribution-cookies-${tag}`);
  }
  await yesCtx.close();

  // ── A shopper who allowed only analytics ─────────────────────────────────
  const noCtx = await browser.newContext({ baseURL });
  await noCtx.addCookies([{ name: 'astrobaas_consent', value: await consentCookie(page, ['necessary', 'analytics']), url: baseURL! }]);
  const no = await shopperOrder(noCtx, landing, `attr-no-${run}@example.com`, productId);
  expect(no.attributionCookie, 'no marketing consent, no cookie').toBeUndefined();
  await noCtx.close();

  // ── What the shop recorded ───────────────────────────────────────────────
  const list = (await (await page.request.get('/api/orders?limit=200')).json()).data as any[];
  const withAttr = list.find((o) => o.email === `attr-yes-${run}@example.com`);
  const without = list.find((o) => o.email === `attr-no-${run}@example.com`);
  expect(withAttr.attribution.first.utm_campaign).toBe('autumn-sale');
  expect(withAttr.attribution.last.gclid).toBe('e2e-click-1');
  expect(without.attribution).toBeUndefined();

  // The order screen shows it on the one order and not the other.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/admin/orders');
  const block = page.locator(`[data-attribution="${withAttr.id}"]`);
  await expect(block).toBeVisible();
  await expect(block).toContainText('google / cpc · autumn-sale');
  await expect(block).toContainText('gclid: e2e-click-1');
  await expect(page.locator(`[data-attribution="${without.id}"]`)).toHaveCount(0);
  await block.scrollIntoViewIfNeeded();
  await shot(page, 'conversion-attribution-order-detail');

  // Insights: the report section, its range form and the CSV export.
  await page.goto('/admin/insights#attribution');
  const section = page.locator('#attribution');
  await expect(section.getByRole('heading', { name: 'Where paid orders came from' })).toBeVisible();
  await expect(section.getByRole('link', { name: 'Export CSV' })).toHaveAttribute('href', /\/api\/orders\/attribution\?.*format=csv/);
  await section.getByLabel('Credit goes to').selectOption('first');
  await section.getByRole('button', { name: 'Show' }).click();
  await expect(page).toHaveURL(/attr_model=first/);
  await shot(page, 'conversion-attribution-insights');

  const csv = await page.request.get('/api/orders/attribution?format=csv');
  expect(csv.status()).toBe(200);
  expect((await csv.text()).split('\r\n')[0]).toBe('model,from,to,source,medium,campaign,orders,revenue,currency');
});
