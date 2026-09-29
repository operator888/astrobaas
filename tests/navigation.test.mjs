#!/usr/bin/env node
/**
 * The site menu (src/lib/navigation.ts).
 *
 * Whatever this module accepts is rendered as `<a href>` in the header of every
 * public page, so the first half of this file is a list of links that must be
 * REFUSED — each one a way to write an executable or off-site URL that a naive
 * check would let through. The rest is the promise that makes shipping this
 * safe for sites that never touch it: no menu saved means every theme keeps its
 * own links, byte for byte.
 *
 * Run with:  node tests/navigation.test.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadTs, ROOT } from './lib/load.mjs';

const N = await loadTs('src/lib/navigation.ts');
const V = await loadTs('src/lib/settings-validate.ts');
const read = (rel) => fs.readFile(path.join(ROOT, rel), 'utf8');

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed += 1; } catch (err) { failures.push(`${name}: ${err.message}`); }
}
function ok(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, what = '') {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

const MULTI = { SITE_LOCALES: 'en,de,el' };
const menu = (items) => ({ items });

// ─────────────────────────────────────────────────────────── which links

check('the five shapes a menu link can take are accepted', () => {
  for (const href of [
    '/', '/about', '/blog?category=news', '/shop#new', '#top',
    'https://example.com', 'http://example.com/path?q=1',
    'mailto:hello@example.com', 'tel:+302101234567',
  ]) ok(N.navHrefProblem(href) === null, `refused ${href}: ${N.navHrefProblem(href)}`);
});

check('every executable or off-shape link is refused', () => {
  for (const href of [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',          // case is not a defence
    'java\tscript:alert(1)',         // a tab the browser strips
    ' javascript:alert(1)',          // leading space the browser strips
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'ftp://example.com/file',        // a scheme, just not one a menu needs
    '//evil.example/x',              // a path to the eye, another ORIGIN to the browser
    '/\\evil.example/x',             // the browser reads \ as /, so this is //evil.example
    '\\\\evil.example',                // likewise
    '/a b',                          // a space inside is a mistake, not a URL
    '',
    '   ',
    null,
    42,
  ]) ok(N.navHrefProblem(href) !== null, `accepted ${JSON.stringify(href)}`);
});

check('a bare word is told what to write, not just "invalid"', () => {
  const msg = N.navHrefProblem('about');
  ok(/try "\/about"/.test(msg), `no suggestion: ${msg}`);
});

check('an over-long link is refused', () => {
  ok(N.navHrefProblem('/' + 'a'.repeat(N.NAV_LIMITS.href)) !== null, 'accepted a link past the limit');
});

// ────────────────────────────────────────────────────────── the whole menu

check('no menu, null, empty string and an empty list are all valid — that is "reset"', () => {
  for (const v of [undefined, null, '', menu([]), {}]) ok(N.validateNavigation(v) === null, `refused ${JSON.stringify(v)}`);
});

check('a menu with a submenu is valid', () => {
  eq(N.validateNavigation(menu([
    { label: 'Shop', href: '/shop', children: [{ label: 'New', href: '/shop/new' }] },
    { label: 'Journal', href: '/blog' },
  ])), null);
});

check('a submenu cannot have its own submenu', () => {
  const msg = N.validateNavigation(menu([
    { label: 'A', href: '/a', children: [{ label: 'B', href: '/b', children: [{ label: 'C', href: '/c' }] }] },
  ]));
  ok(msg && /cannot have its own submenu/.test(msg), `accepted three levels: ${msg}`);
});

check('the problem names the item, so the operator can find it', () => {
  const msg = N.validateNavigation(menu([
    { label: 'Home', href: '/' },
    { label: 'Shop', href: 'javascript:void(0)' },
  ]));
  ok(/Item 2/.test(msg) && /Shop/.test(msg), `unhelpful: ${msg}`);
});

check('labels are required, bounded and plain', () => {
  ok(N.validateNavigation(menu([{ label: '', href: '/' }])), 'accepted an empty label');
  ok(N.validateNavigation(menu([{ label: '   ', href: '/' }])), 'accepted a blank label');
  ok(N.validateNavigation(menu([{ label: 'x'.repeat(N.NAV_LIMITS.label + 1), href: '/' }])), 'accepted a label past the limit');
  ok(N.validateNavigation(menu([{ label: 'a\u0000b', href: '/' }])), 'accepted a control character');
});

check('translations must be keyed by a language code', () => {
  eq(N.validateNavigation(menu([{ label: 'About', href: '/about', labels: { de: 'Über uns', el: 'Σχετικά' } }])), null);
  ok(N.validateNavigation(menu([{ label: 'About', href: '/about', labels: { 'not a lang': 'x' } }])), 'accepted a bad key');
  ok(N.validateNavigation(menu([{ label: 'About', href: '/about', labels: ['de'] }])), 'accepted a list as translations');
});

check('the size limits hold', () => {
  const many = Array.from({ length: N.NAV_LIMITS.items + 1 }, (_, i) => ({ label: `L${i}`, href: `/p${i}` }));
  ok(N.validateNavigation(menu(many)), 'accepted too many items');
  const kids = Array.from({ length: N.NAV_LIMITS.children + 1 }, (_, i) => ({ label: `K${i}`, href: `/k${i}` }));
  ok(N.validateNavigation(menu([{ label: 'P', href: '/p', children: kids }])), 'accepted too many children');
});

check('newTab must be a boolean', () => {
  ok(N.validateNavigation(menu([{ label: 'X', href: 'https://x.test', newTab: 'yes' }])), 'accepted a string');
});

// ─────────────────────────────────────────────────── one shape on disk

check('normalising trims, and drops what carries no information', () => {
  eq(N.normaliseNavigation(menu([
    { label: '  Shop  ', href: ' /shop ', newTab: false, labels: { de: '', el: ' Κατάστημα ' }, children: [] },
  ])), { items: [{ label: 'Shop', href: '/shop', labels: { el: 'Κατάστημα' } }] });
});

check('an empty menu is stored as null — "use the theme\'s own links"', () => {
  eq(N.normaliseNavigation(menu([])), null);
  eq(N.normaliseNavigation(null), null);
});

check('reading tolerates anything a store might hand back', () => {
  eq(N.readNavigation('{"items":[{"label":"A","href":"/a"}]}'), { items: [{ label: 'A', href: '/a' }] });
  eq(N.readNavigation('not json'), null);
  eq(N.readNavigation({ items: [{ label: 'X', href: 'javascript:1' }] }), null);
  eq(N.readNavigation(undefined), null);
});

// ──────────────────────────────────────────────── resolved for a request

check('no menu resolves to nothing, which is the theme\'s cue to use its own links', () => {
  eq(N.resolveNavigation(null), []);
  eq(N.resolveNavigation({ items: [] }), []);
});

check('internal links keep a German reader in German', () => {
  const [item] = N.resolveNavigation(menu([{ label: 'About', href: '/about' }]), { locale: 'de', env: MULTI });
  eq(item.href, '/de/about');
});

check('a link the operator already localised is not prefixed twice', () => {
  const [item] = N.resolveNavigation(menu([{ label: 'Über', href: '/de/about' }]), { locale: 'de', env: MULTI });
  eq(item.href, '/de/about');
});

check('the default language keeps unprefixed links', () => {
  const [item] = N.resolveNavigation(menu([{ label: 'About', href: '/about' }]), { locale: 'en', env: MULTI });
  eq(item.href, '/about');
});

check('external links, anchors and mailto are never prefixed', () => {
  const items = N.resolveNavigation(menu([
    { label: 'Etsy', href: 'https://etsy.com/shop/x' },
    { label: 'Top', href: '#top' },
    { label: 'Mail', href: 'mailto:a@b.co' },
  ]), { locale: 'de', env: MULTI });
  eq(items.map((i) => i.href), ['https://etsy.com/shop/x', '#top', 'mailto:a@b.co']);
  eq(items.map((i) => i.external), [true, false, true]);
});

check('a label is shown in the reader\'s language when there is one', () => {
  const nav = menu([{ label: 'About', href: '/about', labels: { de: 'Über uns' } }]);
  eq(N.resolveNavigation(nav, { locale: 'de', env: MULTI })[0].label, 'Über uns');
  eq(N.resolveNavigation(nav, { locale: 'el', env: MULTI })[0].label, 'About');
});

check('newTab is honoured for external links only', () => {
  const items = N.resolveNavigation(menu([
    { label: 'Etsy', href: 'https://etsy.com', newTab: true },
    { label: 'About', href: '/about', newTab: true },
  ]));
  eq(items.map((i) => i.newTab), [true, false]);
});

check('the item for the current page is marked, and only that one', () => {
  const items = N.resolveNavigation(menu([
    { label: 'Home', href: '/' },
    { label: 'About', href: '/about' },
    { label: 'Blog', href: '/blog' },
  ]), { currentPath: '/about/' });
  eq(items.map((i) => i.current), [false, true, false]);
});

check('children are resolved the same way as their parent', () => {
  const [shop] = N.resolveNavigation(menu([
    { label: 'Shop', href: '/shop', children: [{ label: 'Neu', href: '/shop/new', labels: { de: 'Neu' } }] },
  ]), { locale: 'de', env: MULTI, currentPath: '/de/shop/new' });
  eq(shop.children[0].href, '/de/shop/new');
  eq(shop.children[0].current, true);
});

// ───────────────────────────────────── wired into the settings write path

check('the settings endpoint refuses a bad menu with the reason', () => {
  const msg = V.validateSetting('navigation', menu([{ label: 'X', href: 'javascript:alert(1)' }]));
  ok(msg && /Item 1/.test(msg), `settings accepted it: ${msg}`);
});

check('the settings endpoint stores the normalised menu', () => {
  eq(V.normaliseSettingValue('navigation', menu([{ label: ' A ', href: '/a' }])), { items: [{ label: 'A', href: '/a' }] });
});

// ───────────────────────────── every bundled theme honours the contract

for (const file of [
  'src/components/public/PublicHeader.astro',
  'src/themes/editorial/Header.astro',
  'src/themes/marquee/Header.astro',
]) {
  const src = await read(file);
  check(`${file}: reads the navigation prop`, () => {
    ok(/navigation = \[\]/.test(src), 'does not destructure navigation with a default');
    ok(/navigation\.length > 0 \? navigation : builtIn/.test(src), 'does not fall back to built-in links when empty');
  });
  check(`${file}: marks the current page for screen readers`, () => {
    ok(/aria-current=\{[a-z]+\.current \? 'page' : undefined\}/.test(src), 'no aria-current');
  });
  check(`${file}: a new tab says so and does not leak the opener`, () => {
    ok(/opens in a new tab/.test(src), 'no announcement for a new tab');
    ok(/rel=\{[a-z]+\.newTab \? 'noopener' : undefined\}/.test(src), 'no rel=noopener');
  });
  check(`${file}: a submenu opens for the keyboard, not only on hover`, () => {
    // Either form: a CSS :focus-within rule, or Tailwind's group-focus-within.
    ok(/:focus-within > \.[a-z-]+sub/.test(src) || /group-focus-within:block/.test(src), 'hover-only submenu');
  });
}

{
  const layout = await read('src/layouts/PublicLayout.astro');
  check('PublicLayout passes navigation to the Header slot', () => {
    ok(/<Header [^>]*navigation=\{navigation\}/.test(layout), 'Header is not given the menu');
    ok(/resolveNavigation\(readNavigation\(/.test(layout), 'the menu is not read tolerantly');
  });
}

if (failures.length) {
  console.error(`\n✗ navigation: ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error(`  · ${f}`);
  process.exit(1);
}
console.log(`✓ navigation: ${passed} passed`);
