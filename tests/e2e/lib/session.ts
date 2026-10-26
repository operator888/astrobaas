/**
 * One admin sign-in, shared by the spec files that use this helper.
 *
 * The login throttle allows TEN sign-in attempts per address and email per
 * fifteen minutes (`perIpEmail` in src/lib/login-guard.ts, deliberately not
 * configurable). The whole e2e suite is one address signing in as admin@local,
 * so every spec that signs in afresh spends that budget. When the
 * color-swatches spec added two more, the eleventh sign-in, in
 * variant-selector's beforeAll, landed on /login?error=rate and the run hung
 * for ten minutes. The throttle was right; the suite was spending it.
 *
 * So the session cookies are kept in a file. Specs run in one worker but are
 * separate modules, so a module variable would not reach the next file; the
 * file does. If the session has gone (a fresh server and a wiped database, or a
 * test that signed out), `/admin` redirects to the sign-in page and this signs
 * in for real, once, and saves the new cookies.
 *
 * Every spec that needs the admin signs in through this. The one deliberate
 * exception is cms.spec.ts's "admin is protected and login works", whose
 * subject is the sign-in form itself. Signing out, or revoking the session,
 * costs the next caller one real sign-in, which it re-saves.
 */
import type { Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Must match ADMIN_PASSWORD in playwright.config.ts (see cms.spec.ts for why). */
export const ADMIN_PASSWORD = 'e2e-admin-not-the-default';

type Cookies = Awaited<ReturnType<ReturnType<Page['context']>['cookies']>>;

function cacheFile(page: Page): string {
  const port = new URL(page.url().startsWith('http') ? page.url() : 'http://127.0.0.1:4399').port || '4399';
  return path.join(os.tmpdir(), `astrobaas-e2e-admin-session-${port}.json`);
}

function readCookies(file: string): Cookies | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as Cookies; } catch { return null; }
}

/** Signed in as admin@local, on /admin, spending a sign-in only when the saved session no longer works. */
export async function adminLogin(page: Page): Promise<void> {
  await page.goto('/login');
  const file = cacheFile(page);
  const saved = readCookies(file);
  if (saved?.length) {
    await page.context().addCookies(saved);
    await page.goto('/admin');
    if (!new URL(page.url()).pathname.startsWith('/login')) return;
  }
  await page.goto('/login');
  await page.fill('input[name="email"]', 'admin@local');
  await page.fill('input[name="password"]', ADMIN_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL('**/admin');
  try { fs.writeFileSync(file, JSON.stringify(await page.context().cookies())); } catch { /* the next spec signs in itself */ }
}
