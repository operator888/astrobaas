#!/usr/bin/env node
/**
 * A screenshot of every admin screen, for review.
 *
 *   node scripts/screenshots.mjs [baseUrl] [outDir]
 *
 * Playwright rather than the agent browser, because this has to leave FILES
 * behind: a screenshot an agent looked at and described is not something the
 * owner can open next week and disagree with.
 *
 * It also records, per screen, the HTTP status and every console error — which
 * is the half a picture cannot show. A screen that renders beautifully while
 * throwing in the console is the exact failure this pass is for.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://localhost:4321';
const OUT = path.resolve(process.argv[3] || 'screenshots/admin');
const EMAIL = process.env.REVIEW_EMAIL || 'admin@local';
const PASSWORD = process.env.REVIEW_PASSWORD || 'review-admin-pass';

const SCREENS = [
  ['dashboard', '/admin'],
  ['posts', '/admin/posts'],
  ['post-new', '/admin/posts/new'],
  ['media', '/admin/media'],
  ['categories', '/admin/categories'],
  ['content-types', '/admin/content-types'],
  ['products', '/admin/products'],
  ['orders', '/admin/orders'],
  ['customers', '/admin/customers'],
  ['messages', '/admin/messages'],
  ['users', '/admin/users'],
  ['plugins', '/admin/plugins'],
  ['themes', '/admin/themes'],
  ['settings', '/admin/settings'],
  ['email-templates', '/admin/email-templates'],
  ['operations', '/admin/operations'],
  ['tools', '/admin/tools'],
  ['import', '/admin/import'],
  ['audit', '/admin/audit'],
  ['privacy', '/admin/privacy'],
  ['insights', '/admin/insights'],
  ['translations', '/admin/translations'],
  ['redirects', '/admin/redirects'],
  ['api-keys', '/admin/api-keys'],
  ['webhooks', '/admin/webhooks'],
  ['legal', '/admin/legal'],
  ['profile', '/admin/profile'],
];

const PUBLIC_SCREENS = [
  ['home', '/'],
  ['blog', '/blog'],
  ['blog-de', '/de/blog'],
  ['blog-ar-rtl', '/ar/blog'],
  ['showcase', '/showcase'],
  ['login', '/login'],
];

await fs.mkdir(OUT, { recursive: true });
await fs.mkdir(path.join(path.dirname(OUT), 'public'), { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

const consoleErrors = [];
page.on('console', (msg) => {
  if (msg.type() !== 'error') return;
  const text = msg.text();
  // A missing IMAGE is a property of the data, not of the page. This review
  // database is a real shop import whose media files are not on this machine,
  // so every product row logs one — 443 of them would bury the errors that
  // matter. Counted separately below rather than dropped.
  if (/Failed to load resource.*404/.test(text)) { missingAssets.push(page.url()); return; }
  consoleErrors.push({ at: page.url(), text });
});
const missingAssets = [];
page.on('pageerror', (err) => consoleErrors.push({ at: page.url(), text: `pageerror: ${err.message}` }));

/** Sign in through the real form, so the session is a real session. */
// `domcontentloaded`, like every navigation below — `networkidle` never
// settles on a catalogue whose images 404, and the login page shares the same
// layout.
try {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 15000 });
} catch (err) {
  console.error(`✗ ${BASE} is not answering. Start the dev server first:`);
  console.error('    node scripts/dev.mjs --port 4321');
  await browser.close();
  process.exit(1);
}
await page.fill('input[type="email"], input[name="email"]', EMAIL);
await page.fill('input[type="password"], input[name="password"]', PASSWORD);
await Promise.all([
  page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 15000 }).catch(() => {}),
  page.click('button[type="submit"]'),
]);

const report = [];

async function shoot(dir, name, route) {
  const before = consoleErrors.length;
  let status = 0;
  try {
    // `domcontentloaded`, NOT `networkidle`. A catalogue of 443 products whose
    // images 404 keeps the network busy indefinitely, so networkidle never
    // fires and a screen that renders perfectly is reported as a timeout. That
    // is a property of the review database, not of the page.
    const res = await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    status = res?.status() ?? 0;
  } catch (err) {
    report.push({ name, route, status: 0, note: `navigation failed: ${err.message}`, errors: [] });
    return;
  }
  // Client-rendered lists need a moment: several admin screens fetch their
  // rows from an inline module after the document is parsed.
  await page.waitForTimeout(1600);
  const file = path.join(dir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });

  const text = (await page.textContent('body').catch(() => '')) ?? '';
  const trimmed = text.replace(/\s+/g, ' ').trim();
  let note = 'ok';
  if (trimmed.length < 120) note = `almost empty (${trimmed.length} chars)`;
  else if (/Loading…/.test(trimmed) && trimmed.length < 400) note = 'still loading';
  report.push({
    name, route, status, note,
    chars: trimmed.length,
    errors: consoleErrors.slice(before).map((e) => e.text),
  });
}

for (const [name, route] of SCREENS) await shoot(OUT, name, route);
const publicOut = path.join(path.dirname(OUT), 'public');
for (const [name, route] of PUBLIC_SCREENS) await shoot(publicOut, name, route);

await browser.close();

const lines = ['# Screenshot pass', '', `Base: ${BASE}`, `Taken: ${new Date().toISOString()}`,
  `Missing asset requests (404s for files not on this machine): ${missingAssets.length}`, '',
  '| screen | route | status | render | console errors |', '|---|---|---|---|---|'];
for (const r of report) {
  lines.push(`| ${r.name} | \`${r.route}\` | ${r.status} | ${r.note} | ${r.errors.length ? r.errors.length : '—'} |`);
}
const problems = report.filter((r) => r.status !== 200 || r.note !== 'ok' || r.errors.length);
if (problems.length) {
  lines.push('', '## Needs a look', '');
  for (const p of problems) {
    lines.push(`### ${p.name} (\`${p.route}\`)`);
    lines.push(`- status ${p.status}, ${p.note}, ${p.chars} chars of text`);
    for (const e of p.errors) lines.push(`- console: \`${e.replace(/`/g, "'")}\``);
    lines.push('');
  }
} else {
  lines.push('', 'Every screen answered 200, rendered content, and logged no console error.');
}
await fs.writeFile(path.join(path.dirname(OUT), 'REPORT.md'), lines.join('\n') + '\n');

console.log(`${report.length} screenshots → ${path.dirname(OUT)}`);
console.log(`${problems.length} screens need a look — see screenshots/REPORT.md`);
for (const p of problems) console.log(`  · ${p.route}: status ${p.status}, ${p.note}, ${p.errors.length} console errors`);
