#!/usr/bin/env node
/**
 * The `manager` role, and admin-screen access.
 *
 * A manager is shop staff: they run the catalogue and need to see orders and
 * customers to do it, but nothing that changes how the site is built, who can
 * log in, or where money goes.
 *
 * Most of this file asserts what a manager CANNOT do, for two reasons. A new
 * role is only ever dangerous in the permissive direction — nobody files a bug
 * because a button was missing, they file one after a manager deleted the
 * theme. And the previous design expressed admin access three separate times (a
 * middleware regex, a per-page role check, and nothing at all in the sidebar),
 * which is exactly how a permission drifts open in one of the three.
 *
 * `canOpenAdminPage` is now the single rule; the middleware, the page guards and
 * the sidebar all ask it. So the test that matters most is the LAST block:
 * every screen must resolve to a decision, and an unknown screen must deny.
 *
 * Run with:  node tests/admin-access.test.mjs
 */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const cacheDir = path.join(root, 'node_modules', '.cache');
await fs.mkdir(cacheDir, { recursive: true });

async function load(rel, name) {
  const out = path.join(cacheDir, `astrobaas-${name}-${process.pid}.mjs`);
  await build({
    entryPoints: [path.join(root, rel)],
    bundle: true, format: 'esm', platform: 'node', packages: 'external',
    outfile: out, logLevel: 'silent',
  });
  const mod = await import(pathToFileURL(out).href);
  await fs.rm(out, { force: true });
  return mod;
}

const { canOpenAdminPage, navFor, ADMIN_NAV } = await load('src/lib/admin-access.ts', 'admin-access');
const {
  canManageAllPosts, canAuthorPosts, canManageCatalog,
  canDeleteProducts, canReadCommerce, canWriteCommerce,
} = await load('src/lib/auth.ts', 'auth-roles');

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) pass++;
  else { fail++; console.error(`✗ ${name}`); }
}

const ROLES = ['admin', 'editor', 'author', 'manager', 'viewer'];

/* ---------------- what a manager MAY do ---------------- */
{
  check('a manager may manage the catalogue', canManageCatalog('manager') === true);
  check('a manager may DELETE products (was admin-only)', canDeleteProducts('manager') === true);
  check('a manager may read orders and customers', canReadCommerce('manager') === true);
  check('a manager may author posts', canAuthorPosts('manager') === true);
  check('a manager may upload media (same predicate as authoring)', canAuthorPosts('manager') === true);
}

/* ---------------- what a manager MAY NOT do ---------------- */
{
  // Own posts only — this predicate also governs media deletion, so a manager
  // can remove their own uploads and nobody else's.
  check('a manager may NOT manage other people\'s posts', canManageAllPosts('manager') === false);
  check('a manager may NOT change orders or create customers', canWriteCommerce('manager') === false);

  for (const page of [
    '/admin/themes', '/admin/plugins', '/admin/users', '/admin/settings',
    '/admin/api-keys', '/admin/webhooks', '/admin/audit', '/admin/tools',
    '/admin/messages',
  ]) {
    check(`a manager may NOT open ${page}`, canOpenAdminPage(page, 'manager') === false);
    check(`...and an admin may`, canOpenAdminPage(page, 'admin') === true);
  }
}

/* ---------------- the screens a manager needs ---------------- */
{
  for (const page of ['/admin', '/admin/products', '/admin/orders', '/admin/customers',
    '/admin/posts', '/admin/media', '/admin/categories']) {
    check(`a manager may open ${page}`, canOpenAdminPage(page, 'manager') === true);
  }
  // Nested paths inherit their prefix rather than needing their own rule.
  check('a manager may open a product detail page',
    canOpenAdminPage('/admin/products/abc123/edit', 'manager') === true);
  check('a manager may open the post editor',
    canOpenAdminPage('/admin/posts/new', 'manager') === true);
  check('a manager may NOT open a nested users page',
    canOpenAdminPage('/admin/users/abc/edit', 'manager') === false);
}

/* ---------------- existing roles are unchanged ---------------- */
{
  // The whole risk of adding a role is quietly widening the others.
  check('editor still manages all posts', canManageAllPosts('editor') === true);
  check('editor still manages the catalogue', canManageCatalog('editor') === true);
  check('editor still may NOT delete products', canDeleteProducts('editor') === false);
  check('editor may still write commerce', canWriteCommerce('editor') === true);
  check('author still cannot touch the catalogue', canManageCatalog('author') === false);
  check('author still cannot read orders', canReadCommerce('author') === false);
  check('viewer can do none of it',
    !canAuthorPosts('viewer') && !canManageCatalog('viewer') && !canReadCommerce('viewer'));
  check('an author may not open products', canOpenAdminPage('/admin/products', 'author') === false);
  check('an author may still open posts', canOpenAdminPage('/admin/posts', 'author') === true);
  check('a viewer may open nothing in the admin',
    ROLES.filter((r) => r === 'viewer').every((r) =>
      ADMIN_NAV.every((n) => canOpenAdminPage(n.href, r) === false)));
}

/* ---------------- the nav matches what is reachable ---------------- */
{
  // The bug this replaces: the sidebar rendered every link to everyone, so a
  // restricted user clicked one and got bounced with no explanation.
  for (const role of ROLES) {
    const nav = navFor(role);
    check(`nav for "${role}" contains only reachable links`,
      nav.every((item) => canOpenAdminPage(item.href, role)));
    const hidden = ADMIN_NAV.filter((i) => !nav.includes(i));
    check(`...and hides only unreachable ones`,
      hidden.every((item) => !canOpenAdminPage(item.href, role)));
  }
  check('a manager sees fewer links than an admin',
    navFor('manager').length < navFor('admin').length);
  check('a manager sees more than nothing', navFor('manager').length >= 6);
  check('an admin sees every link', navFor('admin').length === ADMIN_NAV.length);
  check('a signed-out visitor sees none', navFor(undefined).length === 0);
}

/* ---------------- THE structural guarantee ---------------- */
{
  // An unknown screen must DENY to everything but admin. A page added later is
  // then admin-only until someone deliberately opens it, which makes forgetting
  // visible instead of silent.
  for (const role of ['editor', 'author', 'manager', 'viewer']) {
    check(`an unknown admin screen denies "${role}"`,
      canOpenAdminPage('/admin/some-future-screen', role) === false);
  }
  check('...and still allows admin', canOpenAdminPage('/admin/some-future-screen', 'admin') === true);
  check('no role at all is denied', canOpenAdminPage('/admin/posts', undefined) === false);

  // Longest-prefix matching: /admin (the dashboard) must not answer for
  // /admin/users, and /admin/posts must not answer for /admin/products.
  check('the dashboard rule does not leak to every screen',
    canOpenAdminPage('/admin', 'author') === true && canOpenAdminPage('/admin/users', 'author') === false);
  check('a prefix does not match a longer sibling name',
    canOpenAdminPage('/admin/products', 'author') === false);

  // Every declared nav entry must be openable by at least its own roles —
  // catches a typo between `href` and `prefix`.
  check('every nav entry is reachable by the roles it declares',
    ADMIN_NAV.every((i) => i.roles.every((r) => canOpenAdminPage(i.href, r))));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
