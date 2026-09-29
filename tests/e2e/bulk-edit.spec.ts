/**
 * Bulk product edit in the admin, in a real browser: tick, choose, preview,
 * apply — and the preview dialog passes the same WCAG 2.1 AA check as every
 * admin screen.
 */
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/** Must match ADMIN_PASSWORD in playwright.config.ts (see cms.spec.ts for why). */
const ADMIN_PASSWORD = 'e2e-admin-not-the-default';

async function login(page: Page) {
  await page.goto('/login');
  await page.fill('input[name="email"]', 'admin@local');
  await page.fill('input[name="password"]', ADMIN_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL('**/admin');
}

test('bulk edit: tick two products, preview a 10% rise, apply it', async ({ page }) => {
  await login(page);
  await page.goto('/admin/products');
  const csrf = await page.locator('meta[name="csrf-token"]').first().getAttribute('content');
  const run = Date.now().toString(36);
  const make = async (name: string, price: number) => {
    const res = await page.request.post('/api/products', {
      headers: { 'X-CSRF-Token': csrf ?? '' },
      data: { name, slug: `${name.toLowerCase().replace(/\s+/g, '-')}-${run}`, price_cents: price, status: 'active', stock: 5 },
    });
    expect(res.status(), await res.text()).toBe(201);
    return (await res.json()).data;
  };
  const a = await make(`Bulk A ${run}`, 1000);
  const b = await make(`Bulk B ${run}`, 2550);

  await page.goto(`/admin/products?q=${run}`);
  await page.getByRole('checkbox', { name: `Select ${a.name}` }).check();
  await page.getByRole('checkbox', { name: `Select ${b.name}` }).check();
  await expect(page.locator('#bulk-count')).toHaveText('2');
  await page.getByLabel('Change', { exact: true }).selectOption('price');
  await page.getByLabel('How').selectOption('percent');
  await page.getByLabel('Value').fill('10');
  await page.getByRole('button', { name: 'Preview' }).click();

  const dialog = page.getByRole('dialog', { name: 'Review the change' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('#bulk-summary')).toContainText('2 will change');
  await expect(dialog).toContainText('€10.00 → €11.00');

  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).include('#bulk-dialog').analyze();
  expect(violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)).toEqual([]);

  // Nothing was written by the preview.
  const before = await (await page.request.get(`/api/products/${a.id}`)).json();
  expect(before.data.price_cents).toBe(1000);

  await dialog.getByRole('button', { name: 'Apply to 2 products' }).click();
  await expect(dialog.locator('#bulk-result')).toContainText('Updated 2');
  const after = await Promise.all([a.id, b.id].map(async (id) => (await (await page.request.get(`/api/products/${id}`)).json()).data.price_cents));
  expect(after).toEqual([1100, 2805]);
});
