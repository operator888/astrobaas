#!/usr/bin/env node
/**
 * Per-capability editing of the built-in roles (C-138).
 *
 * ## The order matters, and this file is the reason
 *
 * The capability table was extracted from the predicates BEFORE any override
 * mechanism existed, and this test pins every role × capability answer against
 * the hard-coded predicate it replaces. So the extraction is provably
 * behaviour-neutral, and a permissions CHANGE can never arrive mixed with a
 * change in how permissions are COMPUTED — which is the state in which nobody
 * can tell which of the two broke something.
 *
 * ## What this row is not
 *
 * Not arbitrary role names. A custom role is not a row in a table: it is a
 * value that must satisfy dozens of `role === 'admin'` comparisons through the
 * routes, every one of which silently answers "no" for a name it has never
 * heard — producing a role that can sign in and do nothing, with no message
 * anywhere explaining why.
 *
 * Run with:  node tests/capabilities.test.mjs
 */
import { loadTs } from './lib/load.mjs';

const C = await loadTs('src/lib/capabilities.ts');
const A = await loadTs('src/lib/auth.ts');
const V = await loadTs('src/lib/visibility.ts');

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed += 1; }
  catch (err) { failures.push(`${name}: ${err.message}`); }
}
function eq(a, b, what = '') {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${what} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
}

const ROLES = ['admin', 'editor', 'author', 'manager', 'viewer'];

// ─────────────────────────── the extraction is behaviour-neutral

/**
 * The grants as they were BEFORE the table existed, copied from the predicate
 * bodies. Written out rather than derived, because a table derived from the
 * thing it is checking proves nothing.
 */
const BEFORE = {
  author_posts:     ['admin', 'editor', 'author', 'manager'],
  manage_all_posts: ['admin', 'editor'],
  import_content:   ['admin'],
  manage_catalog:   ['admin', 'editor', 'manager'],
  delete_products:  ['admin', 'manager'],
  read_commerce:    ['admin', 'editor', 'manager'],
  write_commerce:   ['admin', 'editor'],
};

check('THE PIN: every role x capability matches what the predicates granted', () => {
  for (const [cap, allowed] of Object.entries(BEFORE)) {
    for (const role of ROLES) {
      const want = allowed.includes(role);
      const got = C.hasCapability(role, cap);
      if (got !== want) throw new Error(`${role} / ${cap}: expected ${want}, got ${got}`);
    }
  }
});

check('THE PIN: the live predicates agree with the table', () => {
  // If a predicate stopped delegating, this diverges.
  for (const role of ROLES) {
    eq(A.canAuthorPosts(role), C.hasCapability(role, 'author_posts'), `canAuthorPosts(${role})`);
    eq(A.canManageAllPosts(role), C.hasCapability(role, 'manage_all_posts'), `canManageAllPosts(${role})`);
    eq(A.canImportContent(role), C.hasCapability(role, 'import_content'), `canImportContent(${role})`);
    eq(A.canManageCatalog(role), C.hasCapability(role, 'manage_catalog'), `canManageCatalog(${role})`);
    eq(A.canDeleteProducts(role), C.hasCapability(role, 'delete_products'), `canDeleteProducts(${role})`);
    eq(A.canReadCommerce(role), C.hasCapability(role, 'read_commerce'), `canReadCommerce(${role})`);
    eq(A.canWriteCommerce(role), C.hasCapability(role, 'write_commerce'), `canWriteCommerce(${role})`);
  }
});

check('the two deliberate oddities survived the extraction', () => {
  // An editor may EDIT the catalogue and not DELETE from it: deleting is
  // destructive in a way editing is not, and it was admin-only before managers
  // existed. Widening it while extracting a table would be a policy change
  // nobody asked for.
  eq(C.hasCapability('editor', 'manage_catalog'), true);
  eq(C.hasCapability('editor', 'delete_products'), false);
  // An import is admin-only and narrower than every other content capability:
  // it rewrites site-wide redirects, and nobody can un-import a site.
  eq(C.hasCapability('editor', 'import_content'), false);
});

check('an unknown role has nothing', () => {
  for (const cap of C.CAPABILITIES) eq(C.hasCapability('superuser', cap), false);
  eq(C.hasCapability(undefined, 'author_posts'), false);
  eq(C.effectiveCapabilities('nope'), []);
});

check('canSeeOthersDrafts still answers what it always did', () => {
  eq(V.canSeeOthersDrafts({ role: 'editor' }), true);
  eq(V.canSeeOthersDrafts({ role: 'admin' }), true);
  eq(V.canSeeOthersDrafts({ role: 'author' }), false);
  eq(V.canSeeOthersDrafts({ role: 'manager' }), false);
  eq(V.canSeeOthersDrafts(null), false);
});

// ──────────────────────────────────────────────────────── overrides

check('an override grants', () => {
  eq(C.hasCapability('author', 'manage_catalog'), false);
  eq(C.hasCapability('author', 'manage_catalog', { author: { manage_catalog: true } }), true);
});

check('an override revokes', () => {
  eq(C.hasCapability('manager', 'delete_products', { manager: { delete_products: false } }), false);
});

check('AN UNSET CAPABILITY FALLS BACK, it does not deny', () => {
  // The stored table holds only differences. If absence meant deny, every
  // capability added in a later release would arrive switched OFF for anyone
  // who had ever saved this table — silently, on upgrade.
  const overrides = { manager: { delete_products: false } };
  eq(C.hasCapability('manager', 'author_posts', overrides), true);
  eq(C.hasCapability('manager', 'read_commerce', overrides), true);
});

check('only a real boolean counts as an override', () => {
  for (const junk of ['true', 1, null, {}, []]) {
    eq(C.hasCapability('author', 'manage_catalog', { author: { manage_catalog: junk } }), false,
      String(junk));
  }
});

check('ADMIN IS NOT REDUCIBLE', () => {
  // An operator who switched off their own last capability would be locked out
  // of the screen that switches it back on, and there is no CLI verb to repair
  // it. The table is simply not consulted for admin.
  for (const cap of C.CAPABILITIES) {
    eq(C.hasCapability('admin', cap, { admin: { [cap]: false } }), true, cap);
  }
});

// ──────────────────────────────────────────────────── the stored table

check('normalise drops an unknown role or capability rather than failing', () => {
  // A table that refused to load because a later release renamed one capability
  // would take every other override down with it.
  eq(C.normaliseOverrides({ superuser: { author_posts: false }, editor: { fly: true } }), {});
  eq(C.normaliseOverrides('nonsense'), {});
  eq(C.normaliseOverrides(null), {});
  eq(C.normaliseOverrides([1, 2]), {});
});

check('normalise drops ADMIN, so a hand edit cannot express what is ignored', () => {
  eq(C.normaliseOverrides({ admin: { import_content: false } }), {});
});

check('normalise drops an entry equal to the built-in grant', () => {
  // Otherwise the table fills with entries that change nothing and hide the
  // ones that do.
  eq(C.normaliseOverrides({ editor: { author_posts: true } }), {});
  eq(C.normaliseOverrides({ editor: { author_posts: false } }), { editor: { author_posts: false } });
});

check('normalise keeps a real difference', () => {
  eq(C.normaliseOverrides({ author: { manage_catalog: true }, viewer: { author_posts: true } }),
    { author: { manage_catalog: true }, viewer: { author_posts: true } });
});

check('every capability has a label, and every label a capability', () => {
  // A matrix with a blank row is a checkbox nobody can interpret.
  eq(Object.keys(C.CAPABILITY_LABELS).sort(), [...C.CAPABILITIES].sort());
  for (const label of Object.values(C.CAPABILITY_LABELS)) {
    if (!label || label.length < 8) throw new Error(JSON.stringify(label));
  }
});

check('admin is NOT in the editable list', () => {
  if (C.EDITABLE_ROLES.includes('admin')) throw new Error('admin is offered for editing');
  eq([...C.EDITABLE_ROLES].sort(), ['author', 'editor', 'manager', 'viewer']);
});

if (failures.length) {
  console.error(`\n✗ capabilities: ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error(`  · ${f}`);
  process.exit(1);
}
console.log(`✓ capabilities: ${passed} passed`);
