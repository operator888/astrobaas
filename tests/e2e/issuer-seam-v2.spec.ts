/**
 * The invoice issuer seam, version 2, in a real browser — what a stock server
 * (no issuer plugin installed) can show:
 *
 *  - Settings → Invoices explains the issuer order: only a decline passes a
 *    record on, and a record every issuer declines gets the internal reference;
 *  - the records API answers the issuer chain (empty here) and each record
 *    line's frozen tax treatment, which is `standard` only where VAT was
 *    charged and absent where the order cannot say;
 *  - the order screen still shows a final record with no issuer as
 *    "not tax documents", with no decline or retry note.
 *
 * The declined and retry states need an issuer plugin, which no API can
 * install; tests/invoice-issuer-seam.test.mjs drives them on all three drivers.
 *
 * Screenshots are written only when SHOT_DIR is set (the coordinator's run).
 */
import { test, expect, type Page } from '@playwright/test';
import { adminLogin } from './lib/session';


/** One shared admin session, so the suite stays inside the login throttle — see lib/session.ts. */
const login = (page: Page) => adminLogin(page);

async function shot(page: Page, name: string) {
  if (!process.env.SHOT_DIR) return;
  await page.screenshot({ path: `${process.env.SHOT_DIR}/${name}.png`, fullPage: true });
}

test('issuer seam v2: Settings → Invoices explains the issuer order', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await login(page);
  await page.goto('/admin/settings#set-invoices');
  const section = page.locator('#set-invoices');
  await expect(section).toBeVisible();
  const status = section.locator('#invoice-issuer-status');
  await expect(status).toContainText('No issuer plugin is active');
  await expect(status).toContainText('only a decline passes a record on');
  await expect(status).toContainText('internal reference');
  await section.scrollIntoViewIfNeeded();
  await shot(page, 'issuer-seam-v2-settings');
  if (process.env.SHOT_DIR) await section.screenshot({ path: `${process.env.SHOT_DIR}/issuer-seam-v2-settings-section.png` });
});

test('issuer seam v2: a record carries its issuer chain and frozen tax treatment', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await login(page);
  await page.goto('/admin/orders');
  const csrf = (await page.locator('meta[name="csrf-token"]').first().getAttribute('content')) ?? '';
  const headers = { 'X-CSRF-Token': csrf };

  const before = await (await page.request.get('/api/settings/get')).json().catch(() => null);
  await page.request.post('/api/settings/update', { headers, data: { commerce_enabled: true } });

  try {
    const run = Date.now().toString(36);
    const product = await page.request.post('/api/products', {
      headers,
      data: { name: `Seam Frames ${run}`, slug: `seam-frames-${run}`, price_cents: 9900, status: 'active', stock: 5 },
    });
    expect(product.status(), await product.text()).toBe(201);
    const pid = (await product.json()).data.id;

    const placed = await page.request.post('/api/orders', {
      headers,
      data: {
        email: `seam-${run}@example.com`, name: 'Μαρία Οικονόμου',
        items: [{ product_id: pid, qty: 1 }],
        shipping_address: { name: 'Μαρία Οικονόμου', line1: 'Πανεπιστημίου 5', city: 'Αθήνα', postcode: '10564', country: 'GR' },
      },
    });
    expect([200, 201]).toContain(placed.status());
    const number = (await placed.json()).data.number as string;
    const orders = (await (await page.request.get('/api/orders?limit=200')).json()).data as Array<{ id: string; number: string }>;
    const order = orders.find((o) => o.number === number)!;
    expect(order, 'the order just placed is listed').toBeTruthy();

    const made = await page.request.post(`/api/orders/${order.id}/invoice-records`, { headers, data: { action: 'create', finalise: true } });
    expect(made.status(), await made.text()).toBe(201);
    const body = (await made.json()).data;
    expect(body.issuer_chain, 'no issuer installed: an empty chain').toEqual([]);
    const record = body.record;
    expect(record.status).toBe('final');
    expect(record.issuer ?? null, 'no issuer: no issuer state at all').toBeNull();
    for (const line of record.lines as Array<{ tax_rate_bp: number; tax_treatment?: string }>) {
      // `standard` only where VAT was charged; a 0 % line on this install
      // (tax off by default) is left unknown rather than called standard.
      if (line.tax_rate_bp > 0) expect(line.tax_treatment).toBe('standard');
      else expect(line.tax_treatment).toBeUndefined();
    }

    await page.goto('/admin/orders');
    const box = page.locator(`.invoice-records[data-order="${order.id}"]`);
    await expect(box).toBeVisible();
    const row = box.locator(`.invoice-record[data-record="${record.id}"]`);
    await expect(row).toHaveAttribute('data-state', 'final');
    await expect(row.locator('.invoice-declined')).toHaveCount(0);
    await expect(row.locator('.invoice-retry')).toHaveCount(0);
    await expect(box).toContainText('not tax documents');
    await box.scrollIntoViewIfNeeded();
    await shot(page, 'issuer-seam-v2-order-records');
    if (process.env.SHOT_DIR) await box.screenshot({ path: `${process.env.SHOT_DIR}/issuer-seam-v2-order-row.png` });
  } finally {
    const was = before?.data?.commerce_enabled;
    await page.request.post('/api/settings/update', { headers, data: { commerce_enabled: was === true } });
  }
});
