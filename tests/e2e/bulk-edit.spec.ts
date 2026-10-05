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

test('bulk edit: two changes with a condition, then undo from the history', async ({ page }) => {
  await login(page);
  await page.goto('/admin/products');
  const csrf = await page.locator('meta[name="csrf-token"]').first().getAttribute('content');
  const run = `u${Date.now().toString(36)}`;
  const make = async (name: string, price: number, status: string) => {
    const res = await page.request.post('/api/products', {
      headers: { 'X-CSRF-Token': csrf ?? '' },
      data: { name, slug: `${name.toLowerCase().replace(/\s+/g, '-')}-${run}`, price_cents: price, status, stock: 5 },
    });
    expect(res.status(), await res.text()).toBe(201);
    return (await res.json()).data;
  };
  const live = await make(`Live ${run}`, 1000, 'active');
  const draft = await make(`Draft ${run}`, 2000, 'draft');

  await page.goto(`/admin/products?q=${run}`);
  await page.getByRole('checkbox', { name: 'Select every product on this page' }).check();
  await expect(page.locator('#bulk-count')).toHaveText('2');

  // Change 1: price +10%, queued. Change 2: add a tag.
  await page.getByLabel('Change', { exact: true }).selectOption('price');
  await page.getByLabel('How').selectOption('percent');
  await page.getByLabel('Value').fill('10');
  await page.getByRole('button', { name: 'Add another change' }).click();
  await expect(page.getByRole('list', { name: 'Changes to make' })).toContainText('Price +10%');
  await page.getByLabel('Change', { exact: true }).selectOption('addTag');
  await page.getByLabel('Tag', { exact: true }).fill('autumn');

  // Only the active one.
  await page.locator('#bulk-where summary').click();
  await page.getByLabel('Status is').selectOption('active');
  await page.getByRole('button', { name: 'Preview' }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('#bulk-summary')).toContainText('1 will change');
  await expect(dialog.locator('#bulk-summary')).toContainText('1 do not meet the condition');
  await dialog.getByRole('button', { name: 'Apply to 1 product' }).click();
  await expect(dialog.locator('#bulk-result')).toContainText('Updated 1');
  // Through the staff list: GET /api/products/{id} answers 404 for a draft.
  const get = async (id: string) =>
    ((await (await page.request.get(`/api/products?all=true&limit=100&search=${run}`)).json()).data as { id: string }[]).find((p) => p.id === id) as Record<string, any>;
  expect((await get(live.id)).price_cents).toBe(1100);
  expect((await get(live.id)).tags).toContain('autumn');
  expect((await get(draft.id)).price_cents).toBe(2000);

  // Undo it from the history list.
  await page.goto(`/admin/products?q=${run}`);
  await page.getByRole('button', { name: 'Recent bulk changes' }).click();
  await page.getByRole('button', { name: /^Undo “.*tag autumn.*price \+10%.* on 1 product \(with a condition\)”$/ }).first().click();
  const undoDialog = page.getByRole('dialog');
  await expect(undoDialog).toContainText('1 will be put back');
  await undoDialog.getByRole('button', { name: 'Undo on 1 product' }).click();
  await expect(undoDialog.locator('#bulk-result')).toContainText('Updated 1');
  expect((await get(live.id)).price_cents).toBe(1000);
  expect((await get(live.id)).tags ?? []).not.toContain('autumn');
});

test('bulk edit: a CSV with a bad row cannot be applied; a good one can', async ({ page }) => {
  await login(page);
  await page.goto('/admin/products');
  const csrf = await page.locator('meta[name="csrf-token"]').first().getAttribute('content');
  const run = `c${Date.now().toString(36)}`;
  const res = await page.request.post('/api/products', {
    headers: { 'X-CSRF-Token': csrf ?? '' },
    data: { name: `Csv ${run}`, slug: `csv-${run}`, sku: `SKU-${run}`, price_cents: 1500, status: 'active', stock: 5 },
  });
  expect(res.status()).toBe(201);
  const upload = async (text: string) => {
    await page.goto('/admin/products');
    await page.locator('#bulk-csv-file').setInputFiles({ name: 'prices.csv', mimeType: 'text/csv', buffer: Buffer.from(text) });
    return page.getByRole('dialog');
  };

  const bad = await upload(`sku,price\nSKU-${run},"1,000"\n`);
  await expect(bad.locator('#bulk-problems')).toContainText('Row 2');
  await expect(bad.getByRole('button', { name: /Apply|Nothing to apply/ })).toBeDisabled();
  await bad.getByRole('button', { name: 'Cancel' }).click();

  const good = await upload(`sku,price,stock\nSKU-${run},18.50,9\n`);
  await expect(good.locator('#bulk-summary')).toContainText('1 will change');
  await good.getByRole('button', { name: 'Apply to 1 product' }).click();
  await expect(good.locator('#bulk-result')).toContainText('Updated 1');
  const list = (await (await page.request.get(`/api/products?all=true&limit=100&search=${run}`)).json()).data as { sku: string; price_cents: number; stock: number }[];
  const p = list.find((x) => x.sku === `SKU-${run}`)!;
  expect([p.price_cents, p.stock]).toEqual([1850, 9]);
});


test('product editor: the prescription fields show on the Safety tab only', async ({ page }) => {
  await login(page);
  await page.goto('/admin/products');
  await page.locator('#new-product').click();
  const dialog = page.locator('#product-dialog');
  await expect(dialog).toBeVisible();
  const checkbox = dialog.locator('input[name="requires_prescription"]');
  const tabs = await dialog.locator('#tab-bar .tab-btn').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.tab));
  expect(tabs).toContain('safety');
  for (const tab of tabs) {
    await dialog.locator(`#tab-bar .tab-btn[data-tab="${tab}"]`).click();
    if (tab === 'safety') await expect(checkbox, `on ${tab}`).toBeVisible();
    else await expect(checkbox, `on ${tab}`).toBeHidden();
  }
});
