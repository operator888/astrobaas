#!/usr/bin/env node
/**
 * The admin navigation's structure.
 *
 * These are the three rules that a hand-copied `<a>` block kept breaking:
 *
 *   1. EVERY label is a translation key that exists in every locale. The last
 *      screen added to the old sidebar shipped `Redirects` as a bare English
 *      string, and no test noticed, because there was nothing to notice with.
 *   2. NO ROLE EVER SEES AN EMPTY GROUP. A heading with nothing under it tells
 *      someone a section exists and then refuses to show it.
 *   3. Every link a role is offered is one the middleware will actually let
 *      them open. A menu that bounces you back to the dashboard teaches you
 *      nothing except that the product looks broken.
 *
 * Run with:  node tests/admin-nav.test.mjs
 */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cacheDir = path.join(here, '..', 'node_modules', '.cache');
await fs.mkdir(cacheDir, { recursive: true });

async function load(rel, tag) {
  const out = path.join(cacheDir, `astrobaas-${tag}-${process.pid}.mjs`);
  await build({
    entryPoints: [path.join(here, '..', rel)],
    bundle: true, format: 'esm', platform: 'node', packages: 'external',
    outfile: out, logLevel: 'silent',
  });
  const mod = await import(pathToFileURL(out).href);
  await fs.rm(out, { force: true });
  return mod;
}

const N = await load('src/lib/admin-nav.ts', 'adminnav');
const A = await load('src/lib/admin-access.ts', 'adminaccess');

// The locale catalogues, as the app assembles them.
const LOCALES = ['en', 'el', 'de'];
const catalogues = {};
for (const loc of LOCALES) {
  catalogues[loc] = (await load(`src/locales/${loc}/chrome.ts`, `chrome-${loc}`)).chrome;
}

let pass = 0, fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };

const ROLES = ['admin', 'editor', 'author', 'manager', 'viewer', undefined];

/* ---- 1. every label is translated, everywhere ---- */

const allKeys = [
  ...N.NAV.flatMap((g) => g.items.map((i) => `admin.chrome.${i.key}`)),
  ...N.NAV.filter((g) => g.heading).map((g) => `admin.chrome.${g.heading}`),
];
check('the nav declares some items', allKeys.length >= 17);

for (const loc of LOCALES) {
  const missing = allKeys.filter((k) => !catalogues[loc][k]);
  check(`every nav label and heading exists in ${loc}`, missing.length === 0);
  if (missing.length) console.error(`    ${loc} missing: ${missing.join(', ')}`);
  // An empty string is a missing translation wearing a present one's clothes.
  const blank = allKeys.filter((k) => catalogues[loc][k] !== undefined && !String(catalogues[loc][k]).trim());
  check(`no nav label is blank in ${loc}`, blank.length === 0);
}

// Greek and German must actually DIFFER from English, or the catalogue is a
// copy rather than a translation.
for (const loc of ['el', 'de']) {
  const same = allKeys.filter((k) => catalogues[loc][k] === catalogues.en[k]);
  // Some are legitimately identical ("Webhooks", "Plugins" in German, "API").
  check(`${loc} translates most nav labels rather than copying them`, same.length <= 5);
}

/* ---- 2. no role ever sees an empty group ---- */

for (const role of ROLES) {
  const groups = N.navFor(role);
  check(`no empty group for ${role ?? 'signed-out'}`, groups.every((g) => g.items.length > 0));
  // A heading is only rendered for a group that has one; the top group has none.
  check(`every group for ${role ?? 'signed-out'} has items`, groups.every((g) => Array.isArray(g.items)));
}

// A viewer is bounced out of the whole admin, so they get nothing at all.
check('a viewer is offered no admin screens', N.navFor('viewer').length === 0);
check('a signed-out visitor is offered no admin screens', N.navFor(undefined).length === 0);

// An author writes; they have no business in the shop.
{
  const hrefs = N.navFor('author').flatMap((g) => g.items.map((i) => i.href));
  check('an author is not offered Orders', !hrefs.includes('/admin/orders'));
  check('an author IS offered Posts', hrefs.includes('/admin/posts'));
  check('...and no Shop heading is left behind',
    !N.navFor('author').some((g) => g.heading === 'groupShop'));
}
// A manager runs the shop and does not administer the system.
{
  const hrefs = N.navFor('manager').flatMap((g) => g.items.map((i) => i.href));
  check('a manager IS offered Orders', hrefs.includes('/admin/orders'));
  check('a manager is not offered Users', !hrefs.includes('/admin/users'));
  check('a manager IS offered Redirects (it is catalogue work)', hrefs.includes('/admin/redirects'));
}
// An admin sees everything that is declared.
check('an admin sees every declared item',
  N.navFor('admin').flatMap((g) => g.items).length === N.NAV.flatMap((g) => g.items).length);

/* ---- 3. every offered link is actually reachable ---- */

for (const role of ROLES) {
  const offered = N.navFor(role).flatMap((g) => g.items.map((i) => i.href));
  const unreachable = offered.filter((h) => !A.canOpenAdminPage(h, role));
  check(`every link offered to ${role ?? 'signed-out'} is one they can open`, unreachable.length === 0);
  if (unreachable.length) console.error(`    ${role}: ${unreachable.join(', ')}`);
}

/* ---- structure ---- */

const items = N.NAV.flatMap((g) => g.items);
check('no href is declared twice', new Set(items.map((i) => i.href)).size === items.length);
check('no translation key is declared twice', new Set(items.map((i) => i.key)).size === items.length);
check('every item has at least one icon path', items.every((i) => i.paths.length > 0));
check('every href is under /admin', items.every((i) => i.href.startsWith('/admin')));
check('the first group is the ungrouped one', N.NAV[0].heading === null);
check('Shop comes before Content', 
  N.NAV.findIndex((g) => g.heading === 'groupShop') < N.NAV.findIndex((g) => g.heading === 'groupContent'));
check('System is last', N.NAV[N.NAV.length - 1].heading === 'groupSystem');

/* ---- the active-link rule ---- */

check('dashboard is active on /admin', N.isActiveNav('/admin', '/admin'));
check('dashboard is active on /admin/', N.isActiveNav('/admin', '/admin/'));
// The whole reason this is not a startsWith: /admin prefixes every admin path.
check('dashboard is NOT active on /admin/orders', !N.isActiveNav('/admin', '/admin/orders'));
check('orders is active on its own screen', N.isActiveNav('/admin/orders', '/admin/orders'));
check('orders is active on a child screen', N.isActiveNav('/admin/orders', '/admin/orders/123'));
check('posts is not active on products', !N.isActiveNav('/admin/posts', '/admin/products'));
// Boundary: /admin/post must not light up /admin/posts.
check('a prefix that is not a path segment does not match', !N.isActiveNav('/admin/post', '/admin/posts'));

/* ---------------- the property the command palette rests on ---------------- */
{
  /*
   * The palette is an index of `navFor(role)`, rendered server-side, and its
   * header states the reason as a security property: "a palette must never
   * reveal that something exists." A manager typing "users" must not learn
   * there is a Users screen before the door refuses them.
   *
   * That property is entirely inherited from this function, and it was
   * untested here — the palette asserted it in prose and nothing asserted it in
   * code. Driven over every role rather than spot-checked, so a screen added
   * later is covered without anyone remembering to extend this.
   */
  const AA = await load('src/lib/admin-access.ts', 'adminaccess');
  for (const role of ['admin', 'editor', 'author', 'manager', 'viewer', undefined]) {
    const items = N.navFor(role).flatMap((g) => g.items);
    const leaked = items.filter((i) => !AA.canOpenAdminPage(i.href, role));
    check(`navFor(${String(role)}) offers nothing that role cannot open${
      leaked.length ? ` (${leaked.map((i) => i.href).join(', ')})` : ''}`, leaked.length === 0);
  }
  // And the converse, so the filter is not simply returning nothing.
  check('an admin is still offered the whole admin',
    N.navFor('admin').flatMap((g) => g.items).length > 20);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
