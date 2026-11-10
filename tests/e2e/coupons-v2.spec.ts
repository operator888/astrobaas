/**
 * The coupon editor (/admin/coupons) with the v2 types, against the built
 * server.
 *
 * Creates a bogo50, a gift_product and an email-bound single-use percent
 * coupon THROUGH THE FORM, edits one, and checks what was stored through the
 * API — the form's unit conversions (percent → basis points, major → minor
 * units, local datetime → ISO) are the part a unit test cannot see. Then a
 * cookie-less storefront quotes baskets with them, so the editor is proven to
 * produce coupons the checkout honours. Screenshots (1280 px and 375 px) only
 * when SHOT_DIR is set.
 */
import { test, expect, type Page } from '@playwright/test';
import { adminLogin } from './lib/session';

/** One shared admin session, so the suite stays inside the login throttle — see lib/session.ts. */
const login = (page: Page) => adminLogin(page);

const shot = async (page: Page, name: string) => {
  if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/${name}.png`, fullPage: true });
};

test('coupons v2: the editor creates and edits every new type, and the checkout honours them', async ({ page }) => {
  await login(page);
  await page.goto('/admin/products');
  const csrf = (await page.locator('meta[name="csrf-token"]').first().getAttribute('content')) ?? '';
  const settings = (data: Record<string, unknown>) =>
    page.request.post('/api/settings/update', { headers: { 'X-CSRF-Token': csrf }, data });

  const run = `cv${Date.now().toString(36)}`.toUpperCase();
  const before = (await (await page.request.get('/api/settings/get')).json()).data ?? {};
  const createdCoupons: string[] = [];
  try {
    const set = await settings({ commerce_enabled: true, tax_enabled: false });
    expect(set.status(), await set.text()).toBe(200);

    const mk = async (name: string, price: number, stock: number) => {
      const r = await page.request.post('/api/products', {
        headers: { 'X-CSRF-Token': csrf },
        data: { name: `${name} ${run}`, slug: `${name.toLowerCase().replace(/\s+/g, '-')}-${run.toLowerCase()}`, price_cents: price, status: 'active', stock, requires_shipping: false },
      });
      expect(r.status(), await r.text()).toBe(201);
      return (await r.json()).data as { id: string; name: string };
    };
    const frame = await mk('Frame', 10000, 20);
    const lens = await mk('Lens', 4000, 20);
    const gift = await mk('Gift case', 1500, 5);

    await page.goto('/admin/coupons');
    await expect(page.locator('#coupon-form')).toBeVisible();
    await shot(page, 'coupons-v2-empty-1280');

    const save = async () => {
      await page.click('#c-save');
      await expect(page.locator('#c-message')).toHaveClass(/text-green-700/);
    };

    // 1. bogo50: no value field, its own explanation.
    await page.fill('#c-code', `BOGO-${run}`);
    await page.selectOption('#c-kind', 'bogo50');
    await expect(page.locator('#c-value-wrap')).toBeHidden();
    await expect(page.locator('#c-help-bogo50')).toBeVisible();
    await save();
    createdCoupons.push(`BOGO-${run}`);
    await expect(page.locator(`tr.coupon-row[data-code="BOGO-${run}"]`)).toBeVisible();

    // 2. gift_product: the gift picker appears and is required.
    await page.fill('#c-code', `GIFT-${run}`);
    await page.selectOption('#c-kind', 'gift_product');
    await expect(page.locator('#c-gift-wrap')).toBeVisible();
    await page.click('#c-save');
    await expect(page.locator('#c-message')).toHaveClass(/text-red-600/); // no gift chosen
    await page.selectOption('#c-gift', gift.id);
    await save();
    createdCoupons.push(`GIFT-${run}`);

    // 3. percent, bound to one email, single use, with a minimum and an expiry.
    await page.fill('#c-code', `WIN-${run}`);
    await page.selectOption('#c-kind', 'percent');
    await page.fill('#c-value', '12.5');
    await page.fill('#c-min', '50');
    await page.fill('#c-email', 'Winner@Example.com');
    await page.check('#c-single');
    await page.fill('#c-ends', '2099-12-31T23:30');
    await save();
    createdCoupons.push(`WIN-${run}`);

    // Edit it: 12.5% -> 15%.
    await page.locator(`tr.coupon-row[data-code="WIN-${run}"] .coupon-edit`).click();
    await expect(page.locator('#c-value')).toHaveValue('12.5');
    await expect(page.locator('#c-single')).toBeChecked();
    await page.fill('#c-value', '15');
    await save();
    await shot(page, 'coupons-v2-list-1280');
    await page.setViewportSize({ width: 375, height: 812 });
    await shot(page, 'coupons-v2-list-375');
    await page.setViewportSize({ width: 1280, height: 900 });

    // What the form STORED.
    const list = (await (await page.request.get('/api/coupons')).json()).data as Array<Record<string, any>>;
    const byCode = (c: string) => list.find((x) => x.code === c)!;
    expect(byCode(`BOGO-${run}`)).toMatchObject({ kind: 'bogo50', value: 0, enabled: true });
    expect(byCode(`GIFT-${run}`)).toMatchObject({ kind: 'gift_product', gift_product_id: gift.id });
    const win = byCode(`WIN-${run}`);
    expect(win).toMatchObject({ kind: 'percent', value: 1500, min_subtotal_cents: 5000, email: 'winner@example.com', single_use: true });
    expect(Number.isNaN(Date.parse(win.ends_at))).toBe(false);

    // A cookie-less storefront (see reverse-charge-checkout.spec.ts for why not
    // the admin's own context) quotes with what the editor made.
    const anon = await page.context().browser()!.newContext({
      baseURL: new URL(page.url()).origin,
      extraHTTPHeaders: { Origin: 'https://frontend.example.com' },
    });
    const quote = async (data: Record<string, unknown>) => {
      const r = await anon.request.post('/api/orders/quote', { data });
      const text = await r.text();
      expect(r.status(), text).toBe(200);
      return JSON.parse(text).data;
    };
    // bogo50 across lines: (100,40) -> the 40 is half price.
    const bogo = await quote({ items: [{ product_id: frame.id, qty: 1 }, { product_id: lens.id, qty: 1 }], coupon_code: `bogo-${run}` });
    expect(bogo.coupon).toMatchObject({ ok: true, kind: 'bogo50' });
    expect(bogo.discount_cents).toBe(2000);
    // The gift: one more line, at 0.
    const g = await quote({ items: [{ product_id: frame.id, qty: 1 }], coupon_code: `GIFT-${run}` });
    expect(g.lines.at(-1)).toMatchObject({ product_id: gift.id, unit_price_cents: 0, coupon_gift: true });
    expect(g.total_cents).toBe(10000);
    // Email-bound: another email gets the generic refusal, the bound one the discount.
    const other = await quote({ items: [{ product_id: frame.id, qty: 1 }], coupon_code: `WIN-${run}`, email: 'someone@example.com' });
    expect(other.coupon).toMatchObject({ ok: false, refusal: 'coupon.not_found' });
    const mine = await quote({ items: [{ product_id: frame.id, qty: 1 }], coupon_code: `WIN-${run}`, email: 'WINNER@example.com' });
    expect(mine.discount_cents).toBe(1500);
    await anon.close();

    // Delete through the table.
    page.once('dialog', (d) => d.accept());
    await page.locator(`tr.coupon-row[data-code="BOGO-${run}"] .coupon-delete`).click();
    await expect(page.locator(`tr.coupon-row[data-code="BOGO-${run}"]`)).toHaveCount(0);
    createdCoupons.splice(createdCoupons.indexOf(`BOGO-${run}`), 1);
  } finally {
    const list = (await (await page.request.get('/api/coupons')).json()).data as Array<{ id: string; code: string }> | undefined;
    for (const c of list ?? []) {
      if (createdCoupons.includes(c.code)) await page.request.delete(`/api/coupons/${c.id}`, { headers: { 'X-CSRF-Token': csrf } });
    }
    await settings({ commerce_enabled: before.commerce_enabled ?? false, tax_enabled: before.tax_enabled ?? false });
  }
});
