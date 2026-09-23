#!/usr/bin/env node
/**
 * Article vs. page classification.
 *
 * The property that matters is not "isPage works" — it is that a record written
 * before Pages existed still counts as an article. Every row on the two
 * production sites has no `kind` field at all, so a classifier that tested
 * `kind === 'post'` would empty their blog archive, their RSS feed and their
 * storefront's post list on the first deploy.
 *
 * The second property is that the six routes agree. They agree by construction
 * (they all call these helpers), so what is asserted here is that the helpers
 * are total: every record lands in exactly one of the two buckets.
 *
 * Run with:  node tests/post-kind.test.mjs
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

const { isPage, isArticle, articlesOnly, pagesOnly, PAGE_KIND } =
  await load('src/lib/post-kind.ts', 'post-kind');

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) pass++;
  else { fail++; console.error(`✗ ${name}`); }
}

const p = (kind) => (kind === undefined ? { slug: 'x' } : { slug: 'x', kind });

/* ---------------- the backward-compatibility property ---------------- */
{
  // THE assertion. A pre-Pages row has no `kind`; it must remain an article.
  check('a record with no kind is an article', isArticle(p(undefined)));
  check('a record with no kind is not a page', !isPage(p(undefined)));
  check('an explicit "post" is an article', isArticle(p('post')));
  check('a "page" is a page', isPage(p('page')));
  check('a "page" is not an article', !isArticle(p('page')));

  // Both spellings of "article" have to behave identically, because the create
  // path omits the field and the update path writes it explicitly.
  check('absent and explicit "post" classify identically',
    isArticle(p(undefined)) === isArticle(p('post')) && isPage(p(undefined)) === isPage(p('post')));
}

/* ---------------- the classification is total ---------------- */
{
  // Anything unexpected — a hand-edited row, a future kind, a null — must land
  // somewhere rather than vanishing from every listing at once.
  for (const odd of [undefined, null, '', 'post', 'PAGE', 'pages', 0, 'article']) {
    const rec = { slug: 's', kind: odd };
    check(`kind ${JSON.stringify(odd)} is in exactly one bucket`,
      isPage(rec) !== isArticle(rec));
  }
  // Case matters: only the exact stored token is a page. A near-miss falling
  // back to "article" keeps it visible in the blog rather than making it
  // unreachable at every URL.
  check('"PAGE" is not treated as a page', !isPage(p('PAGE')));
}

/* ---------------- the list helpers partition ---------------- */
{
  const items = [p(undefined), p('post'), p('page'), p('page'), p('post')];
  const arts = articlesOnly(items);
  const pgs = pagesOnly(items);
  check('articlesOnly keeps the three articles', arts.length === 3);
  check('pagesOnly keeps the two pages', pgs.length === 2);
  check('together they account for every record', arts.length + pgs.length === items.length);
  check('and they never overlap', arts.every((a) => !pgs.includes(a)));

  // A filter that mutates its input would corrupt the cached array the storage
  // layer hands out — the exact bug that made a public GET reorder the database.
  const original = [p('page'), p('post')];
  const snapshot = JSON.stringify(original);
  articlesOnly(original);
  pagesOnly(original);
  check('filtering does not mutate the source array', JSON.stringify(original) === snapshot);
  check('filtering returns a new array', articlesOnly(original) !== original);

  check('an empty list yields empty lists',
    articlesOnly([]).length === 0 && pagesOnly([]).length === 0);
  check('the stored token is the one baked into live rows', PAGE_KIND === 'page');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
