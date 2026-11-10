/**
 * Priced per-line add-ons (PLUGIN_HOOKS.ORDER_LINE_ADDONS), against the built
 * server.
 *
 * A fixture plugin (tests/e2e/fixtures/line-addons-plugin.mjs, loaded through
 * ASTROBAAS_PLUGINS in playwright.config.ts) prices an "e2e-engrave" add-on.
 * A cookie-less storefront quotes and places an order with two add-ons; the
 * quote and the order must agree, and the add-ons must show on the buyer's
 * receipt (1280 px and 375 px) and on the admin order line. Screenshots only
 * when SHOT_DIR is set.
 */
import { test, expect, type Page } from '@playwright/test';
import { adminLogin } from './lib/session';
import crypto from 'node:crypto';

/** Must match AUTH_SECRET in playwright.config.ts: the receipt link is signed with it. */
const AUTH_SECRET = 'e2e-secret-key-at-least-32-characters-long';

/** One shared admin session, so the suite stays inside the login throttle — see lib/session.ts. */
const login = (page: Page) => adminLogin(page);

const shot = async (page: Page, name: string) => {
  if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/${name}.png`, fullPage: true });
};

/**
 * The signed receipt link the confirmation email carries — the same format as
 * `makeReceiptToken` (src/lib/commerce/receipt.ts → signPurposeToken in
 * src/lib/auth.ts): base64url(JSON payload) "." base64url(HMAC-SHA256).
 */
function receiptPath(orderId: string): string {
  const body = Buffer.from(JSON.stringify({ oid: orderId, p: 'receipt', exp: Date.now() + 3_600_000 })).toString('base64url');
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(body).digest('base64url');
  return `/receipt?token=${encodeURIComponent(`${body}.${sig}`)}`;
}

test('add-ons: a storefront order with priced add-ons shows them on the receipt and the admin order line', async ({ page }) => {
  await login(page);
  await page.goto('/admin/products');
  const csrf = (await page.locator('meta[name="csrf-token"]').first().getAttribute('content')) ?? '';
  const settings = (data: Record<string, unknown>) =>
    page.request.post('/api/settings/update', { headers: { 'X-CSRF-Token': csrf }, data });

  const run = `la${Date.now().toString(36)}`;
  const KEYS = ['commerce_enabled', 'tax_enabled'];
  const before = (await (await page.request.get('/api/settings/get')).json()).data ?? {};
  try {
    const set = await settings({ commerce_enabled: true, tax_enabled: false });
    expect(set.status(), await set.text()).toBe(200);

    const made = await page.request.post('/api/products', {
      headers: { 'X-CSRF-Token': csrf },
      data: { name: `Signet ring ${run}`, slug: `signet-ring-${run}`, price_cents: 12000, status: 'active', stock: 10, requires_shipping: false },
    });
    expect(made.status(), await made.text()).toBe(201);
    const product = (await made.json()).data;
    const items = [{ product_id: product.id, qty: 2, addons: { 'e2e-engrave': ['engrave', 'case'] } }];

    // A cookie-less storefront on the allow-listed origin (see
    // reverse-charge-checkout.spec.ts for why not the admin's own context).
    const anon = await page.context().browser()!.newContext({
      baseURL: new URL(page.url()).origin,
      extraHTTPHeaders: { Origin: 'https://frontend.example.com' },
    });
    const q = await anon.request.post('/api/orders/quote', { data: { items } });
    const qText = await q.text();
    expect(q.status(), qText).toBe(200);
    const quote = JSON.parse(qText).data;
    // (12000 + 900 + 1500) × 2
    expect(quote.subtotal_cents).toBe(28800);
    expect(quote.lines[0].addons.map((a: { label: string }) => a.label)).toEqual(['Engraving', 'Hard case']);

    const o = await anon.request.post('/api/orders', { data: { items, email: `addons-${run}@example.com`, name: 'Add-on Buyer' } });
    const oText = await o.text();
    expect(o.status(), oText).toBe(201);
    const order = JSON.parse(oText).data;
    expect(order.subtotal_cents).toBe(quote.subtotal_cents);
    expect(order.total_cents).toBe(quote.total_cents);

    // A selection the plugin refuses is a 400 with its own reason, not an
    // order without the add-on.
    const refused = await anon.request.post('/api/orders', {
      data: { items: [{ product_id: product.id, qty: 1, addons: { 'e2e-engrave': ['gold-leaf'] } }], email: `addons-no-${run}@example.com` },
    });
    expect(refused.status()).toBe(400);
    expect((await refused.json()).error.reason).toBe('e2e.unknown_option');
    await anon.close();

    // The stored line, through the staff API.
    const list = await (await page.request.get('/api/orders?limit=200')).json();
    const stored = (list.data as Array<{ id: string; number: string; items: Array<{ total_cents: number; addons?: Array<{ id: string; unit_price_cents: number }> }> }>)
      .find((x) => x.number === order.number)!;
    expect(stored.items[0].total_cents).toBe(28800);
    expect(stored.items[0].addons?.map((a) => [a.id, a.unit_price_cents])).toEqual([['engrave', 900], ['case', 1500]]);

    // The admin order line.
    await page.goto('/admin/orders');
    const row = page.locator('li', { hasText: `Signet ring ${run}` }).first();
    await expect(row).toContainText('+ Engraving');
    await expect(row).toContainText('+ Hard case');
    await row.scrollIntoViewIfNeeded();
    await shot(page, 'order-line-addons-admin');

    // The buyer's receipt, desktop and phone width.
    for (const [w, h, name] of [[1280, 900, 'order-line-addons-receipt-1280'], [375, 812, 'order-line-addons-receipt-375']] as const) {
      await page.setViewportSize({ width: w, height: h });
      const res = await page.goto(receiptPath(stored.id));
      expect(res?.status()).toBe(200);
      const addons = page.locator('.receipt-addons li');
      await expect(addons).toHaveCount(2);
      await expect(addons.nth(0)).toContainText('Engraving');
      await expect(addons.nth(1)).toContainText('Hard case');
      // No horizontal scroll at phone width.
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      await shot(page, name);
    }
  } finally {
    await page.setViewportSize({ width: 1280, height: 720 });
    const restore: Record<string, unknown> = { commerce_enabled: false };
    for (const k of KEYS) if (before[k] !== undefined) restore[k] = before[k];
    const res = await settings(restore);
    expect(res.status(), await res.text()).toBe(200);
  }
});
