/**
 * Invoice records in the admin, in a real browser: an order gets a final
 * record by hand, the Orders screen shows it with its state and PDF link, the
 * PDF downloads, and Settings → Invoices renders.
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

test('invoice records: a final record on the order screen, with its PDF', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await login(page);
  await page.goto('/admin/orders');
  const csrf = (await page.locator('meta[name="csrf-token"]').first().getAttribute('content')) ?? '';
  const headers = { 'X-CSRF-Token': csrf };

  // The shop switch is a setting; turn it on for this test and leave it as found.
  const before = await (await page.request.get('/api/settings/get')).json().catch(() => null);
  await page.request.post('/api/settings/update', { headers, data: { commerce_enabled: true } });

  try {
    const run = Date.now().toString(36);
    const product = await page.request.post('/api/products', {
      headers,
      data: { name: `Invoice Frames ${run}`, slug: `invoice-frames-${run}`, price_cents: 12400, status: 'active', stock: 5 },
    });
    expect(product.status(), await product.text()).toBe(201);
    const pid = (await product.json()).data.id;

    const placed = await page.request.post('/api/orders', {
      headers,
      data: {
        email: `invoice-${run}@example.com`, name: 'Γιώργος Παπαδόπουλος',
        items: [{ product_id: pid, qty: 1 }],
        shipping_address: { name: 'Γιώργος Παπαδόπουλος', line1: 'Ερμού 10', city: 'Αθήνα', postcode: '10563', country: 'GR', tax_id: 'EL123456789' },
      },
    });
    expect([200, 201]).toContain(placed.status());
    const number = (await placed.json()).data.number as string;
    const orders = (await (await page.request.get('/api/orders?limit=200')).json()).data as Array<{ id: string; number: string }>;
    const order = orders.find((o) => o.number === number)!;
    expect(order, 'the order just placed is listed').toBeTruthy();

    const made = await page.request.post(`/api/orders/${order.id}/invoice-records`, { headers, data: { action: 'create', finalise: true } });
    expect(made.status(), await made.text()).toBe(201);
    const record = (await made.json()).data.record;
    expect(record.status).toBe('final');

    await page.goto('/admin/orders');
    const box = page.locator(`.invoice-records[data-order="${order.id}"]`);
    await expect(box).toBeVisible();
    const row = box.locator(`.invoice-record[data-record="${record.id}"]`);
    await expect(row).toContainText('Invoice record');
    await expect(row).toContainText('Final');
    // No issuer on a fresh install: the screen says these are not tax documents.
    await expect(box).toContainText('not tax documents');
    const link = row.locator('a.invoice-pdf');
    await expect(link).toHaveAttribute('href', `/api/invoice-records/${encodeURIComponent(record.id)}/pdf`);
    await box.scrollIntoViewIfNeeded();
    await shot(page, 'invoice-records-order-detail');
    if (process.env.SHOT_DIR) await box.screenshot({ path: `${process.env.SHOT_DIR}/invoice-records-row.png` });

    // The PDF itself — fetched twice, so a slow render shows up as a failure
    // here rather than as a timeout somewhere else.
    for (const _ of [1, 2]) {
      const t0 = Date.now();
      const pdf = await page.request.get(`/api/invoice-records/${encodeURIComponent(record.id)}/pdf`);
      expect(pdf.status()).toBe(200);
      expect(pdf.headers()['content-type']).toContain('application/pdf');
      expect(Buffer.from(await pdf.body()).subarray(0, 5).toString('latin1')).toBe('%PDF-');
      expect(Date.now() - t0, 'a record PDF renders in well under the test budget').toBeLessThan(5000);
    }

    // The link on the screen opens the PDF in a new tab. The tab's REQUEST and
    // its answer are asserted, NOT its 'load' event: headless Chromium has no
    // PDF viewer, so the tab turns the response into a download, stays blank
    // and never fires 'load' — waiting for it spent the whole 30 s budget.
    const pdfPath = `/api/invoice-records/${encodeURIComponent(record.id)}/pdf`;
    const [popup, response] = await Promise.all([
      page.waitForEvent('popup'),
      page.context().waitForEvent('response', (r) => r.url().endsWith(pdfPath)),
      link.click(),
    ]);
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('application/pdf');
    await popup.close();
    // The link, as staff see it (a headless browser cannot draw the PDF).
    await link.hover();
    if (process.env.SHOT_DIR) await row.screenshot({ path: `${process.env.SHOT_DIR}/invoice-records-pdf-link.png` });
  } finally {
    const was = before?.data?.commerce_enabled;
    await page.request.post('/api/settings/update', { headers, data: { commerce_enabled: was === true } });
  }
});

test('invoice records: Settings → Invoices', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await login(page);
  await page.goto('/admin/settings#set-invoices');
  const section = page.locator('#set-invoices');
  await expect(section).toBeVisible();
  await expect(section.getByLabel('Create the record when')).toHaveValue('paid');
  await expect(section).toContainText('never as an invoice number');
  await section.scrollIntoViewIfNeeded();
  if (process.env.SHOT_DIR) await section.screenshot({ path: `${process.env.SHOT_DIR}/invoice-settings.png` });
});
