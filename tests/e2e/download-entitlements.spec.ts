/**
 * Downloadable products in a real browser: a paid order's receipt shows the
 * buyer's download links, a link downloads the file, and the admin order row
 * shows the entitlement with its count, log and actions.
 *
 * Screenshots are saved only when SHOT_DIR is set:
 *   - download-receipt-1280.png / download-receipt-375.png — the receipt
 *   - download-admin-entitlements.png — Admin → Orders, the Downloads panel
 */
import { test, expect, type Page } from '@playwright/test';
import { adminLogin } from './lib/session';
import crypto from 'node:crypto';

/** Must match AUTH_SECRET in playwright.config.ts: the receipt link is signed with it. */
const AUTH_SECRET = 'e2e-secret-key-at-least-32-characters-long';

const SHOT_DIR = process.env.SHOT_DIR;
async function shot(page: Page, name: string) {
  if (SHOT_DIR) await page.screenshot({ path: `${SHOT_DIR}/${name}.png`, fullPage: true });
}

/** One shared admin session, so the suite stays inside the login throttle — see lib/session.ts. */
const login = (page: Page) => adminLogin(page);

/**
 * The buyer's receipt link, as the confirmation email carries it. Signed the
 * way lib/commerce/receipt.ts signs (`signPurposeToken('receipt', { oid })`),
 * because the email itself is not reachable from a browser test.
 */
function receiptToken(orderId: string): string {
  const body = Buffer.from(JSON.stringify({ oid: orderId, p: 'receipt', exp: Date.now() + 3_600_000 })).toString('base64url');
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

/** A minimal, valid PDF: the private upload door sniffs magic bytes. */
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

test('downloads: a paid order\'s receipt lists the files, the link downloads, admin shows the entitlement', async ({ page }) => {
  await login(page);
  await page.goto('/admin/products');
  const csrf = (await page.locator('meta[name="csrf-token"]').first().getAttribute('content')) ?? '';
  const run = Date.now().toString(36);

  // 1. A private file, through the staff upload route.
  const up = await page.request.post('/api/downloads/upload', {
    headers: { 'X-CSRF-Token': csrf },
    multipart: { file: { name: 'field-guide.pdf', mimeType: 'application/pdf', buffer: PDF } },
  });
  expect(up.status(), await up.text()).toBe(201);
  const privateRef = (await up.json()).data.url as string;
  expect(privateRef).toMatch(/^private:pf_[0-9a-f]{20}$/);

  // 2. A downloadable product: the private file plus an externally hosted one.
  const made = await page.request.post('/api/products', {
    headers: { 'X-CSRF-Token': csrf },
    data: {
      name: `Field Guide ${run}`, slug: `field-guide-${run}`, price_cents: 1200, status: 'active',
      downloadable: true, virtual: true, download_limit: 3,
      downloads: [
        { name: 'Field Guide (PDF)', url: privateRef },
        { name: 'Audio companion', url: 'https://files.example.com/companion.mp3' },
      ],
    },
  });
  expect(made.status(), await made.text()).toBe(201);
  const product = (await made.json()).data;

  // 3. A checkout, then staff mark it paid (processing) — that grants.
  const placed = await page.request.post('/api/orders', {
    headers: { 'X-CSRF-Token': csrf },
    data: { email: `dl-${run}@example.com`, name: 'Ada Buyer', items: [{ product_id: product.id, qty: 1 }] },
  });
  expect(placed.status(), await placed.text()).toBe(201);
  const number = (await placed.json()).data.number;
  const list = await (await page.request.get('/api/orders?limit=200')).json();
  const order = list.data.find((o: { number: string }) => o.number === number);
  expect(order).toBeTruthy();
  const paid = await page.request.put(`/api/orders/${order.id}`, { headers: { 'X-CSRF-Token': csrf }, data: { status: 'processing' } });
  expect(paid.status(), await paid.text()).toBe(200);

  // 4. The buyer's receipt: the downloads section, with a link per file.
  const receipt = `/receipt?token=${encodeURIComponent(receiptToken(order.id))}`;
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(receipt);
  const section = page.locator('#downloads');
  await expect(section.getByRole('heading', { name: 'Your downloads' })).toBeVisible();
  await expect(section.getByRole('link', { name: 'Field Guide (PDF)' })).toBeVisible();
  await expect(section.getByRole('link', { name: 'Audio companion' })).toBeVisible();
  await expect(section).toContainText('3 downloads left');
  // The real locations never reach the page.
  const html = await page.content();
  expect(html).not.toContain(privateRef.slice('private:'.length));
  expect(html).not.toContain('files.example.com');
  await shot(page, 'download-receipt-1280');

  // The link downloads the private file as an attachment.
  const href = await section.getByRole('link', { name: 'Field Guide (PDF)' }).getAttribute('href');
  expect(href).toMatch(/^\/api\/downloads\//);
  const file = await page.request.get(href!);
  expect(file.status()).toBe(200);
  expect(file.headers()['content-disposition']).toMatch(/^attachment;/);
  expect(Buffer.from(await file.body()).subarray(0, 5).toString()).toBe('%PDF-');

  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(receipt);
  await expect(page.locator('#downloads')).toContainText('2 downloads left');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await shot(page, 'download-receipt-375');

  // 5. Admin → Orders: the entitlement, its count and log, and the actions.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/admin/orders');
  const panel = page.locator(`.order-downloads[data-order="${order.id}"]`);
  await expect(panel.getByRole('heading', { name: 'Downloads' })).toBeVisible();
  await expect(panel).toContainText(`Field Guide ${run}`);
  await expect(panel).toContainText('1 downloads · limit 3 per file');
  await expect(panel).toContainText('Field Guide (PDF) (1/3)');
  await expect(panel.getByRole('button', { name: 'Revoke' })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Reset count' })).toBeVisible();
  await panel.locator('summary').first().click();
  await expect(panel).toContainText('Field Guide (PDF)');
  await panel.scrollIntoViewIfNeeded();
  await shot(page, 'download-admin-entitlements');

  // Revoke from the screen; the buyer's link then stops working.
  page.once('dialog', (d) => d.accept());
  await panel.getByRole('button', { name: 'Revoke' }).click();
  await page.waitForLoadState('load');
  await expect(page.locator(`.order-downloads[data-order="${order.id}"]`)).toContainText('Revoked');
  const refused = await page.request.get(href!);
  expect(refused.status()).toBe(403);
  expect((await refused.json()).error.reason).toBe('downloads.revoked');
});
