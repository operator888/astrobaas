/**
 * A DRAFT product opens in the admin editor.
 *
 * The editor loads the full product through GET /api/products/{id}, and that
 * route used to 404 every non-active product even for staff — so clicking Edit
 * on a draft raised "Could not load that product" and the dialog never opened.
 * The route now applies the list rule (staff and ?all=true), and the editor opts in.
 */
import { test, expect, type Page } from '@playwright/test';
import { adminLogin } from './lib/session';


/** One shared admin session, so the suite stays inside the login throttle — see lib/session.ts. */
const login = (page: Page) => adminLogin(page);

const shot = async (page: Page, name: string) => {
  if (process.env.SHOT_DIR) {
    await page.screenshot({ path: `${process.env.SHOT_DIR}/${name}.png`, fullPage: true });
  }
};

// ONE login for the whole file: the per IP+email login throttle (10 per 15
// minutes, successes included) is shared by every spec in the run.
test('a draft product opens in the admin editor, and stays 404 for anonymous', async ({ page, playwright, baseURL }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await login(page);
  await page.goto('/admin/products');
  const csrf = await page.locator('meta[name="csrf-token"]').first().getAttribute('content');
  const run = Date.now().toString(36);
  const name = `Draft Editor ${run}`;
  const res = await page.request.post('/api/products', {
    headers: { 'X-CSRF-Token': csrf ?? '' },
    data: { name, slug: `draft-editor-${run}`, price_cents: 4200, status: 'draft', stock: 3 },
  });
  expect(res.status(), await res.text()).toBe(201);
  const product = (await res.json()).data;
  expect(product.status).toBe('draft');

  // The API itself: staff get the draft, a caller without the session does not.
  const staff = await page.request.get(`/api/products/${product.id}?all=true`);
  expect(staff.status()).toBe(200);
  expect(staff.headers()['cache-control']).toContain('no-store');

  // A failed load would raise an alert; fail loudly instead of auto-dismissing.
  const alerts: string[] = [];
  page.on('dialog', async (d) => { alerts.push(d.message()); await d.dismiss(); });

  await page.goto(`/admin/products?q=${run}`);
  await page.locator(`button.edit[data-id="${product.id}"]`).click();

  const dialog = page.locator('#product-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('input[name="name"]')).toHaveValue(name);
  await expect(dialog.locator('[name="status"]')).toHaveValue('draft');
  await expect(dialog.locator('input[name="price"]')).toHaveValue('42.00');
  expect(alerts).toEqual([]);
  await shot(page, 'draft-product-editor-desktop');

  // A fresh request context: no cookie, no key. Even with the opt-in.
  const anon = await playwright.request.newContext({ baseURL });
  try {
    expect((await anon.get(`/api/products/${product.id}?all=true`)).status()).toBe(404);
    expect((await anon.get(`/api/products/draft-editor-${run}?all=true`)).status()).toBe(404);
  } finally {
    await anon.dispose();
  }
});
