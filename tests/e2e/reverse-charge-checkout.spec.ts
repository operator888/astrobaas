/**
 * EU reverse charge at checkout, against the built server.
 *
 * No new screen: the fix is in pricing. So this drives the two public endpoints
 * a storefront calls — the quote and the order — with and without a buyer VAT
 * id, then shows the placed orders in the admin list so the 0-VAT order can be
 * seen next to the taxed one. Screenshots only when SHOT_DIR is set.
 */
import { test, expect, type Page } from '@playwright/test';
import { adminLogin } from './lib/session';


/** One shared admin session, so the suite stays inside the login throttle — see lib/session.ts. */
const login = (page: Page) => adminLogin(page);

const shot = async (page: Page, name: string) => {
  if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/${name}.png`, fullPage: true });
};

test('reverse charge: an EU business buyer with a VAT id pays 0 VAT on the quote and the order', async ({ page }) => {
  await login(page);
  await page.goto('/admin/products');
  const csrf = (await page.locator('meta[name="csrf-token"]').first().getAttribute('content')) ?? '';
  const settings = (data: Record<string, unknown>) =>
    page.request.post('/api/settings/update', { headers: { 'X-CSRF-Token': csrf }, data });

  const run = `rc${Date.now().toString(36)}`;
  // What the shared e2e database had before, so `finally` can put it back.
  const KEYS = ['commerce_enabled', 'tax_enabled', 'shop_country', 'tax_destination_mode', 'tax_reverse_charge_enabled', 'tax_prices_include_tax', 'tax_rates'];
  const before = (await (await page.request.get('/api/settings/get')).json()).data ?? {};
  try {
    // A Greek shop, destination mode on, reverse charge on, a German rate on file.
    const set = await settings({
      commerce_enabled: true, tax_enabled: true, shop_country: 'GR', tax_destination_mode: 'oss',
      tax_reverse_charge_enabled: true, tax_prices_include_tax: false,
      tax_rates: [
        { class: 'standard', label: 'Standard', rate_bp: 2400 },
        { class: 'standard', label: 'Germany', rate_bp: 1900, country: 'DE' },
      ],
    });
    expect(set.status(), await set.text()).toBe(200);

    const made = await page.request.post('/api/products', {
      headers: { 'X-CSRF-Token': csrf },
      data: { name: `Reverse charge ${run}`, slug: `reverse-charge-${run}`, price_cents: 10000, status: 'active', stock: 10, requires_shipping: false },
    });
    expect(made.status(), await made.text()).toBe(201);
    const product = (await made.json()).data;
    const items = [{ product_id: product.id, qty: 1 }];
    const de = (tax_id?: string) => ({ name: 'Muster GmbH', line1: 'Hauptstr. 1', city: 'Berlin', postcode: '10115', country: 'DE', ...(tax_id ? { tax_id } : {}) });

    // The quote a cart page asks for.
    // Both from a fresh context: a cookie-less headless storefront on the
    // allow-listed origin (CORS_ORIGINS in playwright.config.ts). The admin
    // page's context carries a session cookie, and a cookie-authenticated POST
    // without a CSRF token is refused (403) — correctly; so is a cookie-less one
    // with no allow-listed Origin (CROSS_ORIGIN_PUBLIC_WRITE in middleware.ts).
    const anon = await page.context().browser()!.newContext({
      baseURL: new URL(page.url()).origin,
      extraHTTPHeaders: { Origin: 'https://frontend.example.com' },
    });
    const quote = async (billing: ReturnType<typeof de>) => {
      const res = await anon.request.post('/api/orders/quote', { data: { items, shipping_address: de(), billing_address: billing } });
      const text = await res.text();
      expect(res.status(), text).toBe(200);
      return JSON.parse(text).data;
    };
    const b2bQuote = await quote(de('DE123456789'));
    expect(b2bQuote.tax_cents).toBe(0);
    const b2cQuote = await quote(de());
    expect(b2cQuote.tax_cents).toBe(1900);

    // The orders themselves, from the same anonymous storefront.
    const placeAs = async (email: string, billing: ReturnType<typeof de>) => {
      const res = await anon.request.post('/api/orders', { data: { items, email, name: 'Buyer', shipping_address: de(), billing_address: billing } });
      expect(res.status(), await res.text()).toBe(201);
      return (await res.json()).data;
    };
    const b2bOrder = await placeAs(`b2b-${run}@example.com`, de('DE123456789'));
    expect(b2bOrder.tax_cents).toBe(0);
    const b2cOrder = await placeAs(`b2c-${run}@example.com`, de());
    expect(b2cOrder.tax_cents).toBe(1900);
    await anon.close();

    await page.goto('/admin/orders');
    await expect(page.locator('body')).toContainText(`b2b-${run}@example.com`);
    await shot(page, 'reverse-charge-admin-orders');
  } finally {
    // Leave the shared e2e database as the other specs expect it.
    // Keys that were set are restored exactly; keys that were absent get the
    // value that behaves like absent (destination mode and reverse charge off).
    const restore: Record<string, unknown> = { commerce_enabled: false, tax_destination_mode: 'off', tax_reverse_charge_enabled: false };
    for (const k of KEYS) if (before[k] !== undefined) restore[k] = before[k];
    const res = await settings(restore);
    expect(res.status(), await res.text()).toBe(200);
  }
});
