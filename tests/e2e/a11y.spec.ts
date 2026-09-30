/**
 * WCAG 2.1 AA, checked on every build — public pages and the admin.
 *
 * ## Why this runs in CI rather than once
 *
 * Accessibility regresses the way a CSP does: silently, on a page nobody
 * re-tested, through a change that looked finished. An icon-only button
 * without a name reads as "button" to a screen reader; a grey that looked fine
 * on a good monitor is 2.5:1 on a phone in the sun. Neither throws, and
 * neither shows up in a screenshot review. So axe-core runs against the BUILT
 * server on the pages people actually use, and anything it rates SERIOUS or
 * CRITICAL fails the build.
 *
 * ## What it can and cannot promise
 *
 * Automated checking finds roughly a third of WCAG failures — contrast,
 * missing names, missing labels, broken ARIA, landmarks. It cannot tell
 * whether an alt text is accurate or a flow makes sense to a screen-reader
 * user. This is the floor that stops regressions, not a conformance claim;
 * README says the same in the same words.
 *
 * `moderate` and `minor` findings are reported in the output but do not fail,
 * so the gate is one a contributor can actually keep green.
 */
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/** Must match ADMIN_PASSWORD in playwright.config.ts (see cms.spec.ts for why). */
const ADMIN_PASSWORD = 'e2e-admin-not-the-default';
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/*
 * One real login, cookies reused: the login throttle allows ten sign-ins per
 * address per fifteen minutes, and one per test would trip it — correctly —
 * halfway through the admin pages.
 */
let cachedCookies: Awaited<ReturnType<ReturnType<Page['context']>['cookies']>> | null = null;
async function login(page: Page) {
  if (cachedCookies) {
    await page.context().addCookies(cachedCookies);
    await page.goto('/admin');
    if (!page.url().includes('/login')) return;
    cachedCookies = null;
  }
  await page.goto('/login');
  await page.fill('input[name="email"]', 'admin@local');
  await page.fill('input[name="password"]', ADMIN_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL('**/admin');
  cachedCookies = await page.context().cookies();
}

type Violation = Awaited<ReturnType<AxeBuilder['analyze']>>['violations'][number];

/** One line per rule, with where — so a failure names what to fix. */
function explain(violations: Violation[]): string {
  return violations
    .map((v) => `${v.id} [${v.impact}] ${v.help}\n    ${v.nodes.slice(0, 4).map((n) => n.target.join(' ')).join('\n    ')}`)
    .join('\n');
}

async function audit(page: Page, url: string) {
  await page.goto(url, { waitUntil: 'networkidle' });
  // Screens that build their content after load (the admin lists) are
  // audited once it has arrived, not while the page is still a skeleton.
  await page.waitForTimeout(400);
  const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const blocking = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  const advisory = violations.filter((v) => !blocking.includes(v));
  if (advisory.length) console.log(`\n[a11y] ${url} — advisory (not failing):\n${explain(advisory)}`);
  return blocking;
}

const PUBLIC = ['/', '/blog', '/blog/welcome-to-astrobaas', '/about', '/contact', '/login'];
const ADMIN = [
  '/admin', '/admin/posts', '/admin/posts/new', '/admin/media', '/admin/categories',
  '/admin/navigation', '/admin/settings', '/admin/users', '/admin/profile',
];

for (const url of PUBLIC) {
  test(`a11y: ${url} has no serious or critical WCAG 2.1 AA violations`, async ({ page }) => {
    const blocking = await audit(page, url);
    expect(blocking, explain(blocking)).toEqual([]);
  });
}

for (const url of ADMIN) {
  test(`a11y: admin ${url} has no serious or critical WCAG 2.1 AA violations`, async ({ page }) => {
    await login(page);
    const blocking = await audit(page, url);
    expect(blocking, explain(blocking)).toEqual([]);
  });
}

test('a11y: the first Tab reaches "skip to content", and it moves focus into the page', async ({ page }) => {
  await page.goto('/blog');
  await page.keyboard.press('Tab');
  const first = page.locator(':focus');
  await expect(first).toHaveAttribute('href', '#main-content');
  await expect(first).toBeVisible(); // hidden until focused, then shown — never focusable-but-invisible
  await page.keyboard.press('Enter');
  await expect(page.locator('#main-content')).toBeFocused();
});

test('a11y: the admin has the same skip link', async ({ page }) => {
  await login(page);
  await page.goto('/admin/posts');
  await page.keyboard.press('Tab');
  await expect(page.locator(':focus')).toHaveAttribute('href', '#main-content');
});

/*
 * The colour and underline remaps, checked in the real cascade.
 *
 * The rules live in global.css next to Tailwind's own utilities, and whether
 * one beats another depends on layers, specificity and order — which only a
 * browser resolves. Both regressions below shipped once: a substring match
 * underlined every menu link, and an !important remap beat the hover colour
 * that marks a delete button. Elements are injected so the test does not
 * depend on which screen happens to contain one.
 */
test('a11y: the remaps help text without breaking hover colours or menus', async ({ page }) => {
  await login(page);
  await page.goto('/admin/posts');
  const probe = await page.evaluate(() => {
    const main = document.querySelector('main')!;
    main.insertAdjacentHTML('beforeend', `
      <div id="probe">
        <button id="p-del" type="button" class="text-gray-400 hover:text-red-600">Delete</button>
        <p><a id="p-inline" href="#x" class="text-blue-600 hover:underline">inline</a></p>
        <ul><li><a id="p-toc" href="#y" class="text-gray-600 hover:text-blue-600">toc</a></li></ul>
        <nav><ul><li><a id="p-nav" href="#z" class="text-blue-600">nav</a></li></ul></nav>
        <div class="bg-gray-900"><p id="p-dark" class="text-gray-400">footer</p></div>
      </div>`);
    const cs = (id: string) => getComputedStyle(document.getElementById(id)!);
    return {
      del: cs('p-del').color,
      inline: cs('p-inline').textDecorationLine,
      toc: cs('p-toc').textDecorationLine,
      nav: cs('p-nav').textDecorationLine,
      dark: cs('p-dark').color,
      muted: getComputedStyle(document.documentElement).getPropertyValue('--muted-color').trim(),
    };
  });
  expect(probe.inline, 'a link inside a sentence is underlined').toBe('underline');
  expect(probe.toc, 'a list link styled only on hover is not underlined at rest').toBe('none');
  expect(probe.nav, 'a menu link is not underlined').toBe('none');
  const rest = probe.del;
  await page.hover('#p-del');
  const hovered = await page.evaluate(() => getComputedStyle(document.getElementById('p-del')!).color);
  expect(hovered, 'hover:text-red-600 still changes the colour of a gray-400 button').not.toBe(rest);
  expect(probe.dark, 'gray-400 on the dark footer keeps its own colour').not.toBe(rest);
  expect(probe.muted).not.toBe('');
});
