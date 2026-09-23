#!/usr/bin/env node
/**
 * Admin-defined content types: the validator, and the precedence rule.
 *
 * The stored value outlives the screen that wrote it (restores, API writes,
 * hand edits), so it gets a hostile manifest's discipline. And a plugin's
 * type must never be shadowable from a settings field — a paid module's
 * collection hijacked by an admin typo would be a support case with no clues.
 *
 * Run with:  node tests/content-types-admin.test.mjs
 */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cacheDir = path.join(here, '..', 'node_modules', '.cache');
await fs.mkdir(cacheDir, { recursive: true });
const out = path.join(cacheDir, `astrobaas-ctadmin-${process.pid}.mjs`);
await build({
  entryPoints: [path.join(here, '..', 'src/core/content-types.ts')],
  bundle: true, format: 'esm', platform: 'node', packages: 'external',
  outfile: out, logLevel: 'silent',
});
const C = await import(pathToFileURL(out).href);
await fs.rm(out, { force: true });

let pass = 0, fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };
const v = (defs) => C.validateContentTypeDefinitions(defs);
const okDef = (over = {}) => ({
  name: 'event', label: 'Event',
  fields: [{ name: 'title', rule: { type: 'string', min: 1, max: 200 } }],
  ...over,
});

/* ---- accepts ---- */
check('a plain valid definition passes', v([okDef()]).ok);
check('public visibility passes', v([okDef({ visibility: 'public' })]).ok);
// Enumerated from ADMIN_FIELD_TYPES on purpose: a type added to that list
// without the parameters it needs fails here rather than in a builder that
// silently refuses to save.
const RULE_PARAMS = {
  enum: { values: ['a', 'b'] },
  array: { of: 'string' },
  ref: { to: 'venue' },
  // A repeater is defined by the shape of its items, so an empty one is
  // refused — there would be nothing to validate an item against.
  repeater: { fields: [{ name: 'label', rule: { type: 'string' } }] },
};
check('every field kind the builder offers is accepted',
  v([okDef({ fields: C.ADMIN_FIELD_TYPES.map((t, i) => ({
    name: `f${i}`,
    rule: { type: t, ...(RULE_PARAMS[t] ?? {}) },
  })) })]).ok);
check('an empty list is valid (deleting the last type)', v([]).ok);

/* ---- refuses, and says why ---- */
const bad = (defs, why) => {
  const r = v(defs);
  check(why, !r.ok && r.errors.length > 0);
};
bad([okDef({ name: 'Products' })], 'refuses a non-kebab name');
bad([okDef({ name: 'posts' })], 'refuses a reserved name');
bad([okDef(), okDef()], 'refuses a duplicate name');
bad([okDef({ label: '' })], 'refuses an empty label');
bad([okDef({ visibility: 'publik' })], 'refuses a typo in visibility rather than guessing');
bad([okDef({ fields: [] })], 'refuses a type with no fields');
bad([okDef({ fields: [{ name: 'x', rule: { type: 'richtext' } }] })], 'refuses an unknown field kind');
bad([okDef({ fields: [{ name: 'a b', rule: { type: 'string' } }] })], 'refuses a field name with a space');
bad([okDef({ fields: [{ name: 'x', rule: { type: 'string' } }, { name: 'x', rule: { type: 'number' } }] })],
  'refuses a duplicate field name');
bad([okDef({ fields: [{ name: 'x', rule: { type: 'string', min: 10, max: 2 } }] })], 'refuses min > max');
bad([okDef({ fields: [{ name: 'x', rule: { type: 'enum', values: [] } }] })], 'refuses an enum with no options');
bad('nope', 'refuses a non-array wholesale');

/* ---- the rebuild strips what it does not know ---- */
{
  const r = v([okDef({ fields: [{ name: 'x', rule: { type: 'string', evil: 'payload', max: 10 } }] })]);
  check('unknown keys on a rule never reach the registry',
    r.ok && !('evil' in r.defs[0].fields[0].rule) && r.defs[0].fields[0].rule.max === 10);
}

/* ---- precedence: a plugin's name stays the plugin's ---- */
{
  C._clearContentTypes();
  C.registerContentType({ name: 'event', label: 'Plugin Event', fields: [{ name: 'a', rule: { type: 'string' } }] });
  // The bootstrap refuses to overwrite; simulate its guard.
  const mine = v([okDef({ label: 'Admin Event' })]).defs[0];
  const taken = !!C.getContentType(mine.name);
  check('the guard sees the name is taken', taken);
  if (!taken) C.registerContentType(mine);
  check("the registry still holds the plugin's definition",
    C.getContentType('event')?.label === 'Plugin Event');
  C._clearContentTypes();
}

/* ---- the menu guarantee: a registered type is a visible door ---- */
//
// contentTypeNavFor lives in admin-nav.ts but MUST share this registry
// instance, so both modules are bundled through one entry file — two
// separate bundles would each get their own empty Map and the test would
// pass vacuously against nothing.
{
  const entry = path.join(cacheDir, `astrobaas-ctnav-entry-${process.pid}.ts`);
  const navOut = path.join(cacheDir, `astrobaas-ctnav-${process.pid}.mjs`);
  const root = path.join(here, '..');
  await fs.writeFile(entry, [
    `export * from ${JSON.stringify(path.join(root, 'src/core/content-types.ts'))};`,
    `export { contentTypeNavFor } from ${JSON.stringify(path.join(root, 'src/lib/admin-nav.ts'))};`,
  ].join('\n'));
  await build({
    entryPoints: [entry], bundle: true, format: 'esm', platform: 'node',
    packages: 'external', outfile: navOut, logLevel: 'silent',
  });
  const N = await import(pathToFileURL(navOut).href);
  await fs.rm(entry, { force: true });
  await fs.rm(navOut, { force: true });

  N._clearContentTypes();
  check('empty registry, empty menu', N.contentTypeNavFor('admin').length === 0);

  N.registerContentType({ name: 'event', label: 'Event', labelPlural: 'Events', fields: [{ name: 'a', rule: { type: 'string' } }] });
  N.registerContentType({ name: 'faq', label: 'FAQ', fields: [{ name: 'q', rule: { type: 'string' } }] });

  const links = N.contentTypeNavFor('admin');
  check('every registered type gets a menu entry', links.length === 2);
  check('entries link to the generated screen and carry the plural label',
    links.some((l) => l.href === '/admin/content/event' && l.label === 'Events'));
  check('a missing labelPlural falls back to label + s',
    links.some((l) => l.href === '/admin/content/faq' && l.label === 'FAQs'));
  check('editor sees the menu (same rule as the middleware)',
    N.contentTypeNavFor('editor').length === 2);
  check('author does not (no /admin/content access, no dangling links)',
    N.contentTypeNavFor('author').length === 0);
  check('anonymous does not', N.contentTypeNavFor(undefined).length === 0);
  N._clearContentTypes();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
