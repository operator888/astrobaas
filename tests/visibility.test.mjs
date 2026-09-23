#!/usr/bin/env node
/**
 * Read-side visibility.
 *
 * AstroBaaS enforces authorization in application code over an identity-blind
 * storage layer. That is a legitimate design with one specific failure mode:
 * where database-enforced row-level security makes a forgotten check return
 * NOTHING, this design makes a forgotten check return EVERYTHING.
 *
 * It has happened twice already — `GET /api/settings/get` returned the whole
 * settings table publicly (including `smtp_password` and `stripe_secret_key`),
 * and `GET /api/media/get` enumerated every uploaded file to anonymous callers.
 * Both were one missing line in one route.
 *
 * So the rule lives in one module and this file pins it, including the case
 * that was wrong for the entire life of the project: `if (!user)` treated
 * ANY authenticated user as trusted, so an `author` could read every other
 * user's unpublished drafts.
 *
 * Run with:  node tests/visibility.test.mjs
 */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const cacheDir = path.join(root, 'node_modules', '.cache');
await fs.mkdir(cacheDir, { recursive: true });

const out = path.join(cacheDir, `astrobaas-visibility-${process.pid}.mjs`);
await build({
  entryPoints: [path.join(root, 'src/lib/visibility.ts')],
  bundle: true, format: 'esm', platform: 'node', packages: 'external',
  outfile: out, logLevel: 'silent',
});
const { visibleContent, visibleOne, canSeeOthersDrafts, explainHidden } =
  await import(pathToFileURL(out).href);
await fs.rm(out, { force: true });

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) pass++;
  else { fail++; console.error(`✗ ${name}`); }
}

const ALICE = 'user-alice';
const BOB = 'user-bob';

const POSTS = [
  { id: 'p1', status: 'published', author_id: ALICE },
  { id: 'p2', status: 'draft', author_id: ALICE },
  { id: 'p3', status: 'draft', author_id: BOB },
  { id: 'p4', status: 'scheduled', author_id: BOB },
  { id: 'p5', status: 'review', author_id: ALICE },
  { id: 'p6', status: 'trashed', author_id: BOB },
];

const ids = (arr) => arr.map((p) => p.id).sort().join(',');
const seenBy = (viewer) => ids(visibleContent(POSTS, viewer));

/* ---------------- the role matrix ---------------- */
{
  check('anonymous sees published only', seenBy(null) === 'p1');
  check('undefined viewer sees published only', seenBy(undefined) === 'p1');
  check('a viewer role sees published only',
    seenBy({ id: 'v', role: 'viewer' }) === 'p1');

  // THE bug this file exists for.
  check('an author sees published + their OWN drafts, not others',
    seenBy({ id: ALICE, role: 'author' }) === 'p1,p2,p5');
  check('...and the other author sees a different set',
    seenBy({ id: BOB, role: 'author' }) === 'p1,p3,p4,p6');

  check('an editor sees everything', seenBy({ id: 'e', role: 'editor' }) === ids(POSTS));
  check('an admin sees everything', seenBy({ id: 'a', role: 'admin' }) === ids(POSTS));

  check('canSeeOthersDrafts is true only for editor and admin',
    canSeeOthersDrafts({ role: 'admin' }) && canSeeOthersDrafts({ role: 'editor' })
    && !canSeeOthersDrafts({ role: 'author' }) && !canSeeOthersDrafts({ role: 'viewer' })
    && !canSeeOthersDrafts(null));
}

/* ---------------- deny by default ---------------- */
{
  // A role added to the union but not considered here must LOSE access, not
  // gain it. This is the assertion that makes the next role safe.
  check('an unknown role sees published only',
    seenBy({ id: 'x', role: 'superuser' }) === 'p1');
  check('a role-less but identified caller sees published + own',
    seenBy({ id: ALICE }) === 'p1,p2,p5');

  // An author with no id must not match records with no author.
  const orphan = [{ id: 'o1', status: 'draft' }];
  check('an orphan draft is not visible to an id-less caller',
    visibleContent(orphan, { role: 'author' }).length === 0);
  check('...nor to anonymous', visibleContent(orphan, null).length === 0);
  check('...but is visible to an editor', visibleContent(orphan, { role: 'editor' }).length === 1);

  // Empty/odd input must not throw.
  check('an empty collection is fine', visibleContent([], { role: 'author', id: ALICE }).length === 0);
  check('a record with no status is treated as unpublished',
    visibleContent([{ id: 'n1', author_id: BOB }], { id: ALICE, role: 'author' }).length === 0);
}

/* ---------------- single-record form ---------------- */
{
  const draftOfBob = POSTS.find((p) => p.id === 'p3');
  const published = POSTS.find((p) => p.id === 'p1');

  check('visibleOne hides another author\'s draft',
    visibleOne(draftOfBob, { id: ALICE, role: 'author' }) === null);
  check('visibleOne shows your own draft',
    visibleOne(draftOfBob, { id: BOB, role: 'author' })?.id === 'p3');
  check('visibleOne shows published to anonymous', visibleOne(published, null)?.id === 'p1');
  check('visibleOne shows anything to an editor',
    visibleOne(draftOfBob, { role: 'editor' })?.id === 'p3');
  check('visibleOne on null is null', visibleOne(null, { role: 'admin' }) === null);
  check('visibleOne on undefined is null', visibleOne(undefined, { role: 'admin' }) === null);
}

/* ---------------- the list and the record agree ---------------- */
{
  // A record hidden from the list must also 404 individually, or the list is
  // just an inconvenience rather than a control.
  const viewers = [
    null,
    { id: ALICE, role: 'author' },
    { id: BOB, role: 'author' },
    { id: 'e', role: 'editor' },
    { id: 'v', role: 'viewer' },
  ];
  check('every record hidden from the list is also hidden individually',
    viewers.every((v) => {
      const listed = new Set(visibleContent(POSTS, v).map((p) => p.id));
      return POSTS.every((p) => listed.has(p.id) === (visibleOne(p, v) !== null));
    }));
}

/* ---------------- explainHidden is for us, not for callers ---------------- */
{
  const draftOfBob = POSTS.find((p) => p.id === 'p3');
  check('explainHidden names the owner mismatch',
    /owned by/.test(explainHidden(draftOfBob, { id: ALICE, role: 'author' })));
  check('explainHidden says visible when it is',
    explainHidden(draftOfBob, { role: 'admin' }) === 'visible');
  check('explainHidden flags anonymous',
    /anonymous/.test(explainHidden(draftOfBob, null)));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
