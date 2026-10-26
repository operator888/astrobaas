/**
 * Product reviews (C-35), part 1: reviews submitted through the real public
 * route WITH a solved proof of work, then moderated in the admin queue.
 *
 * Screenshots are saved only when SHOT_DIR is set:
 *   - product-reviews-queue-pending.png   the queue, waiting tab
 *   - product-reviews-queue-all.png       pending and published together
 *   - product-reviews-queue-approved.png  after approving one in the browser
 */
import crypto from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { adminLogin } from './lib/session';
import AxeBuilder from '@axe-core/playwright';


/** One shared admin session, so the suite stays inside the login throttle — see lib/session.ts. */
const login = (page: Page) => adminLogin(page);

async function shot(page: Page, name: string) {
  if (!process.env.SHOT_DIR) return;
  await page.screenshot({ path: `${process.env.SHOT_DIR}/${name}.png`, fullPage: true });
}

/** Solve the challenge exactly as /captcha.js does. */
function solvePow(token: string, bits: number): string {
  const ok = (d: Buffer) => {
    let remaining = bits;
    for (let i = 0; i < d.length && remaining > 0; i++) {
      const take = Math.min(8, remaining);
      if (d[i] >>> (8 - take) !== 0) return false;
      remaining -= take;
    }
    return remaining <= 0;
  };
  for (let n = 0; n < 50_000_000; n++) {
    if (ok(crypto.createHash('sha256').update(`${token}.${n}`).digest())) return `${token}::${n}`;
  }
  throw new Error('could not solve the proof of work');
}

test('product reviews: submit through the public route, moderate in the queue', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await login(page);
  await page.goto('/admin/products');
  const csrf = (await page.locator('meta[name="csrf-token"]').first().getAttribute('content')) ?? '';
  const H = { 'X-CSRF-Token': csrf };

  const on = await page.request.post('/api/settings/update', { headers: H, data: { reviews_enabled: true } });
  expect(on.status(), await on.text()).toBe(200);

  const run = Date.now().toString(36);
  const made = await page.request.post('/api/products', {
    headers: H,
    data: { name: `Reviewed frames ${run}`, slug: `reviewed-frames-${run}`, price_cents: 8900, status: 'active', stock: 5 },
  });
  expect(made.status(), await made.text()).toBe(201);
  const product = (await made.json()).data;

  const submit = async (fields: Record<string, unknown>) => {
    const ch = await (await page.request.get('/api/captcha/challenge?surface=reviews')).json();
    expect(ch.data.enabled).toBe(true);
    const res = await page.request.post(`/api/products/${product.id}/reviews`, {
      headers: H,
      data: { ...fields, pow_token: solvePow(ch.data.token, ch.data.bits) },
    });
    expect(res.status(), await res.text()).toBe(201);
    expect((await res.json()).data).toEqual({ received: true });
  };
  await submit({ rating: 5, title: 'Light and sturdy', body: 'Wore them all summer, not a scratch.', author_name: 'Maria P.', author_email: `maria-${run}@example.com` });
  await submit({ rating: 2, title: 'Too narrow for me', body: 'Nice finish, but they pinch after an hour.', author_name: 'Nikos K.', author_email: `nikos-${run}@example.com` });
  await submit({ rating: 4, body: 'Good value. The case is a bit flimsy.', author_name: 'Eleni', author_email: `eleni-${run}@example.com` });

  // Nothing is public yet.
  const before = await (await page.request.get(`/api/products/${product.id}/reviews`)).json();
  expect(before.data.reviews).toEqual([]);

  // Approve one through the API so the queue shows both states.
  const queue = await (await page.request.get(`/api/reviews?product_id=${product.id}`)).json();
  expect(queue.data.length).toBe(3);
  const first = queue.data.find((r: { data: { author_name: string } }) => r.data.author_name === 'Maria P.');
  const mod = await page.request.post('/api/reviews/moderate', { headers: H, data: { ids: [first.id], action: 'approve' } });
  expect(mod.status(), await mod.text()).toBe(200);

  // The queue: waiting reviews first.
  await page.goto(`/admin/reviews?product_id=${product.id}`);
  // By NAME: AdminLayout renders its own (empty) <h1 id="page-title"> too, so a
  // bare level-1 locator matches two elements and fails strict mode.
  await expect(page.getByRole('heading', { level: 1, name: 'Reviews' })).toBeVisible();
  await expect(page.locator('[data-review-status="pending"]')).toHaveCount(2);
  await shot(page, 'product-reviews-queue-pending');

  // Pending and published together.
  await page.goto(`/admin/reviews?status=all&product_id=${product.id}`);
  await expect(page.locator('[data-review-id]')).toHaveCount(3);
  await expect(page.locator('[data-review-status="approved"]')).toHaveCount(1);
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).include('main').analyze();
  expect(violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)).toEqual([]);
  await shot(page, 'product-reviews-queue-all');

  // Approve one more in the browser, with a row button.
  const nikos = page.locator('[data-review-id]', { hasText: 'Nikos K.' });
  await nikos.locator('[data-one="approve"]').click();
  await page.waitForLoadState('load');
  await expect(page.locator('[data-review-status="approved"]')).toHaveCount(2);
  await shot(page, 'product-reviews-queue-approved');

  // The public read now lists two, with the aggregate, and never an email.
  const res = await page.request.get(`/api/products/${product.id}/reviews`);
  const text = await res.text();
  const pub = JSON.parse(text);
  expect(pub.data.reviews.length).toBe(2);
  expect(pub.data.aggregate.count).toBe(2);
  expect(pub.data.aggregate.average).toBe(3.5);
  expect(text).not.toContain('@example.com');
});
