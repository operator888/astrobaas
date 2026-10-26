/**
 * The consent ledger in a real browser: a plugin records consent through
 * `host.consent` (the e2e-consent fixture, loaded the way a paid module is),
 * the admin's read-only ledger view shows every row with its wording hash,
 * Withdraw APPENDS a record and changes nothing already there, and the
 * subscriber export drops the address.
 *
 * Screenshots are written only when SHOT_DIR is set (the coordinator's run).
 */
import { test, expect, type Page } from '@playwright/test';
import crypto from 'node:crypto';
import { adminLogin } from './lib/session';

/** One shared admin session, so the suite stays inside the login throttle — see lib/session.ts. */
const login = (page: Page) => adminLogin(page);

async function shot(page: Page, name: string) {
  if (!process.env.SHOT_DIR) return;
  await page.screenshot({ path: `${process.env.SHOT_DIR}/${name}.png`, fullPage: true });
}

const TERMS = 'Συμφωνώ με τους όρους του παιχνιδιού. Έκδοση 3.';
const NEWS = 'Θέλω να λαμβάνω το newsletter. Μπορώ να διαγραφώ οποιαδήποτε στιγμή.';
const sha = (s: string) => crypto.createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');

test('consent ledger: recorded by a plugin, read-only in the admin, withdrawn by appending', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await login(page);
  await page.goto('/admin/privacy');
  const csrf = (await page.locator('meta[name="csrf-token"]').first().getAttribute('content')) ?? '';
  const headers = { 'X-CSRF-Token': csrf };
  const email = `e2e-consent-${Date.now().toString(36)}@example.com`;

  // Through the plugin host: game terms granted, newsletter granted + confirmed.
  const recorded = await page.request.post('/api/plugin/e2e-consent/record', {
    headers,
    data: {
      steps: [
        { op: 'record', input: { email, purpose: 'game_terms', granted: true, version: '3', text: TERMS, ip: '203.0.113.9', ua: 'e2e-browser', source: 'e2e-consent' } },
        { op: 'record', input: { email, purpose: 'newsletter', granted: true, version: 'n1', text: NEWS, source: 'e2e-consent' } },
        { op: 'confirm', input: { email, purpose: 'newsletter', source: 'e2e-consent' } },
      ],
    },
  });
  expect(recorded.status(), await recorded.text()).toBe(200);
  const steps = (await recorded.json()).data;
  expect(steps[0].text_hash).toBe(sha(TERMS));
  expect(steps[2]).toEqual({ confirmed: true });

  // Confirmed, so the export carries it — with its proof.
  const exported = (await (await page.request.get('/api/newsletter/subscribers/export')).json()).data.subscribers as Array<{ email: string; text_hash: string; source: string }>;
  const mine = exported.find((c) => c.email === email);
  expect(mine, 'a confirmed newsletter consent is exported').toBeTruthy();
  expect(mine!.text_hash).toBe(sha(NEWS));

  // The read-only view.
  await page.goto(`/admin/privacy/consent?email=${encodeURIComponent(email)}`);
  const rows = page.locator('#ledger-rows tbody tr.ledger-row');
  await expect(rows).toHaveCount(3);
  await expect(page.locator('#ledger-rows')).toContainText('game_terms');
  await expect(page.locator('#ledger-rows')).toContainText('203.0.113.9');
  await expect(rows.nth(0).locator('td').nth(4)).toHaveAttribute('title', sha(TERMS));
  await expect(rows.nth(2)).toHaveAttribute('data-decision', 'confirmed');
  const newsletterState = page.locator('.consent-purpose[data-purpose="newsletter"]');
  await expect(newsletterState.locator('.consent-status')).toHaveText('granted and confirmed');
  await expect(page.locator('.consent-purpose[data-purpose="game_terms"] .consent-status')).toHaveText('granted, not confirmed');
  // Read-only: there is no way to edit or delete a record on this screen.
  await expect(page.locator('#ledger-rows button, #ledger-rows input, #ledger-rows a')).toHaveCount(0);
  await shot(page, 'consent-ledger-before-withdraw');

  const firstRows = await rows.allInnerTexts();

  // Withdraw the newsletter — APPENDED, nothing before it changes.
  page.once('dialog', (d) => d.accept());
  await newsletterState.locator('button.withdraw-consent').click();
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(3)).toHaveAttribute('data-decision', 'withdrawn');
  await expect(rows.nth(3)).toContainText('admin');
  expect((await rows.allInnerTexts()).slice(0, 3)).toEqual(firstRows);
  await expect(page.locator('.consent-purpose[data-purpose="newsletter"] .consent-status')).toHaveText('withdrawn');
  await expect(page.locator('.consent-purpose[data-purpose="newsletter"] button.withdraw-consent')).toHaveCount(0);
  await shot(page, 'consent-ledger-after-withdraw');

  // ...and the export no longer has it.
  const after = (await (await page.request.get('/api/newsletter/subscribers/export')).json()).data.subscribers as Array<{ email: string }>;
  expect(after.some((c) => c.email === email)).toBe(false);

  // A newsletter confirm with no grant subscribes nobody (the game-verification case).
  const other = `e2e-nogrant-${Date.now().toString(36)}@example.com`;
  const refused = await page.request.post('/api/plugin/e2e-consent/record', {
    headers,
    data: { steps: [{ op: 'confirm', input: { email: other, purpose: 'newsletter', source: 'e2e-consent' } }] },
  });
  expect((await refused.json()).data[0]).toEqual({ confirmed: false });
  await page.goto(`/admin/privacy/consent?email=${encodeURIComponent(other)}`);
  await expect(page.locator('#ledger-empty')).toBeVisible();

  // The data-request screen links to the ledger and counts the records.
  await page.goto('/admin/privacy');
  await page.fill('#subject-email', email);
  await page.click('#lookup-btn');
  await expect(page.locator('#result-counts')).toContainText('Consent records');
  await expect(page.locator('#ledger-link')).toHaveAttribute('href', `/admin/privacy/consent?email=${encodeURIComponent(email)}`);
  await shot(page, 'consent-ledger-data-request');
});

test('consent ledger: the public withdraw link and the admin API refuse what they must', async ({ page, request }) => {
  // No session, no token: the same bare 200, nothing revealed.
  const anon = await request.post('/api/consent/withdraw?token=forged');
  expect(anon.status()).toBe(200);
  // The ledger read and the admin withdrawal need an administrator.
  const read = await request.get('/api/consent/ledger?email=someone@example.com');
  expect([401, 403]).toContain(read.status());
  await login(page);
  await page.goto('/admin/privacy');
  const csrf = (await page.locator('meta[name="csrf-token"]').first().getAttribute('content')) ?? '';
  const bad = await page.request.post('/api/consent/ledger/withdraw', {
    headers: { 'X-CSRF-Token': csrf }, data: { email: 'not-an-address', purpose: 'newsletter' },
  });
  expect(bad.status()).toBe(400);
});
