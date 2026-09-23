#!/usr/bin/env node
/**
 * Performing an import, against a real database, on every driver.
 *
 * The parser and the planner are pure and tested as such. This is the part
 * that WRITES, and the properties that matter cannot be checked without a
 * database behind it:
 *
 *   1. Re-running an import does not duplicate a site. The single most likely
 *      thing an operator does is run it twice — the first run was interrupted,
 *      or they were not sure it worked.
 *   2. Content is sanitized on the way in. A decade-old blog is full of
 *      inline handlers and dead plugin embeds.
 *   3. `private` content does not become public.
 *   4. Redirects are created for the URLs that moved, and only those.
 *   5. All of the above behave identically on lowdb, libSQL and relational.
 *      The importer this replaces wrote db.json directly and therefore did
 *      NOTHING on the two drivers a real deployment uses.
 *
 * Each driver runs in a child process with its own throwaway database, because
 * LocalDB resolves its storage engine once at module load.
 *
 * Run with:  node tests/import-apply.test.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

/* ------------------------------------------------------------------ *
 * The child: one driver, one database, the whole scenario.            *
 * ------------------------------------------------------------------ */
if (process.env.IMPORT_TEST_CHILD) {
  const { build } = await import('esbuild');
  const { pathToFileURL } = await import('node:url');

  const cacheDir = path.join(root, 'node_modules', '.cache');
  await fs.mkdir(cacheDir, { recursive: true });
  const load = async (entry, name) => {
    const out = path.join(cacheDir, `astrobaas-imp-${name}-${process.pid}.mjs`);
    await build({
      entryPoints: [path.join(root, entry)],
      bundle: true, format: 'esm', platform: 'node', packages: 'external',
      outfile: out, logLevel: 'silent',
    });
    const mod = await import(pathToFileURL(out).href);
    await fs.rm(out, { force: true });
    return mod;
  };

  const { parseWxr } = await load('src/lib/import/wxr.ts', 'wxr');
  const { planImport } = await load('src/lib/import/plan.ts', 'plan');
  const { applyImport } = await load('src/lib/import/apply.ts', 'apply');
  const { LocalDB } = await load('src/lib/localdb.ts', 'db');

  const xml = await fs.readFile(path.join(here, 'fixtures', 'wordpress-export.xml'), 'utf8');
  const plan = planImport(parseWxr(xml));

  await LocalDB.init();
  const users = await LocalDB.getUsers();
  const admin = users.find((u) => u.role === 'admin');
  if (!admin) {
    console.log(JSON.stringify({ fatal: 'no admin in a fresh install' }));
    process.exit(0);
  }

  const postsBefore = (await LocalDB.getPosts()).length;

  // Rehearse FIRST. Running a dry run after the import would report zero work
  // — correctly, since everything is already imported — and would prove
  // nothing about whether a rehearsal writes.
  const dry = await applyImport(plan, admin.id, { dryRun: true });
  const afterDry = (await LocalDB.getPosts()).length;

  const first = await applyImport(plan, admin.id, { dryRun: false });
  const afterFirst = await LocalDB.getPosts();

  // The same plan, again — exactly what an operator does after an interruption.
  const second = await applyImport(plan, admin.id, { dryRun: false });
  const afterSecond = await LocalDB.getPosts();

  // ---- redirect follows the ACTUAL slug on a collision ----
  //
  // A post already lives at /blog/frames. The import brings a DIFFERENT
  // article whose planned slug is also 'frames'; storage renames it to
  // frames-2, and the legacy redirect must follow it there — pointing the old
  // URL at the unrelated existing article is the failure mode.
  await LocalDB.createPost({
    title: 'Pre-existing frames article', slug: 'frames',
    content: '<p>already here</p>', status: 'published',
    author_id: admin.id, tags: [], views: 0,
  });
  const collidingPlan = planImport(parseWxr(`<?xml version="1.0"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:wp="http://wordpress.org/export/1.2/">
<channel><title>X</title><wp:base_site_url>https://old2.example</wp:base_site_url>
<item><title>Frames from the old site</title><link>https://old2.example/2020/01/frames/</link>
<wp:post_id>777</wp:post_id><wp:post_name>frames</wp:post_name>
<wp:post_type>post</wp:post_type><wp:status>publish</wp:status>
<content:encoded><![CDATA[<p>the OLD article</p>]]></content:encoded></item>
</channel></rss>`));
  await applyImport(collidingPlan, admin.id, { dryRun: false });
  const collided = (await LocalDB.getPosts()).find((p) => p.wp_id === '777');
  const collisionRedirect = (await LocalDB.getRedirects()).find((r) => r.match === '/2020/01/frames');

  // ---- concurrency: two overlapping applies of ONE plan ----
  const concPlan = planImport(parseWxr(`<?xml version="1.0"?>
<rss version="2.0" xmlns:wp="http://wordpress.org/export/1.2/">
<channel><title>X</title>
<item><title>Race target</title><wp:post_id>888</wp:post_id><wp:post_name>race-target</wp:post_name>
<wp:post_type>post</wp:post_type><wp:status>publish</wp:status></item>
</channel></rss>`));
  await Promise.all([
    applyImport(concPlan, admin.id, { dryRun: false }),
    applyImport(concPlan, admin.id, { dryRun: false }),
  ]);
  const raceCopies = (await LocalDB.getPosts()).filter((p) => p.wp_id === '888').length;

  const imported = afterFirst.filter((p) => p.wp_id);
  const article = imported.find((p) => p.slug === 'how-to-choose-a-frame');
  const page = imported.find((p) => p.slug === 'about-us');
  const secret = imported.find((p) => p.slug === 'secret-plans');
  const redirects = await LocalDB.getRedirects();
  const categories = await LocalDB.getCategories();

  console.log(JSON.stringify({
    postsBefore,
    firstCreated: first.createdPosts + first.createdPages,
    countAfterFirst: afterFirst.length,
    secondCreated: second.createdPosts + second.createdPages,
    countAfterSecond: afterSecond.length,
    secondSkippedAsAlreadyImported: second.skipped.filter((s) => /already imported/.test(s.reason)).length,
    countAfterDry: afterDry,
    dryReportsWork: dry.createdPosts + dry.createdPages,
    failed: first.failed,
    article: article && {
      status: article.status,
      kind: article.kind ?? 'post',
      hasScript: /<script/i.test(article.content ?? ''),
      keepsText: /A frame should fit your face/.test(article.content ?? ''),
      publish_date: article.publish_date,
      tags: article.tags,
      wp_id: article.wp_id,
      category_id: article.category_id,
    },
    pageKind: page?.kind,
    secretStatus: secret?.status,
    categories: categories.map((c) => ({ slug: c.slug, name: c.name })),
    redirects: redirects.map((r) => ({ match: r.match, target: r.target, status: r.status })),
    collision: {
      actualSlug: collided?.slug ?? null,
      redirectTarget: collisionRedirect?.target ?? null,
    },
    raceCopies,
  }));
  process.exit(0);
}

/* ------------------------------------------------------------------ *
 * The parent: run the child once per driver and judge the results.    *
 * ------------------------------------------------------------------ */
let pass = 0;
let fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };

const tmpRoot = path.join(os.tmpdir(), `astrobaas-import-test-${process.pid}`);
await fs.mkdir(tmpRoot, { recursive: true });

const DRIVERS = [
  { name: 'lowdb', env: (dir) => ({ DB_PATH: path.join(dir, 'db.json') }) },
  { name: 'libsql', env: (dir) => ({ DATABASE_URL: `file:${path.join(dir, 'db.sqlite')}` }) },
  {
    name: 'relational',
    env: (dir) => ({
      DATABASE_URL: `file:${path.join(dir, 'db.sqlite')}`,
      DATABASE_DRIVER: 'relational',
    }),
  },
];

for (const driver of DRIVERS) {
  const dir = path.join(tmpRoot, driver.name);
  await fs.mkdir(path.join(dir, 'uploads'), { recursive: true });

  const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      IMPORT_TEST_CHILD: '1',
      UPLOADS_DIR: path.join(dir, 'uploads'),
      NODE_ENV: 'test',
      ...driver.env(dir),
    },
    maxBuffer: 32 * 1024 * 1024,
  });

  const line = (run.stdout ?? '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
  if (!line) {
    fail++;
    console.error(`✗ [${driver.name}] the import child produced no result`);
    console.error((run.stderr ?? '').split('\n').slice(-15).join('\n'));
    continue;
  }
  const r = JSON.parse(line);
  if (r.fatal) { fail++; console.error(`✗ [${driver.name}] ${r.fatal}`); continue; }

  const t = (n, c) => check(`[${driver.name}] ${n}`, c);

  /* --- it wrote what it said it would --- */
  t('the import creates the two publishable posts and the page',
    r.firstCreated === 3);
  t('nothing failed', Array.isArray(r.failed) && r.failed.length === 0);
  t('the records are actually in the database',
    r.countAfterFirst === r.postsBefore + 3);

  /* --- idempotency: the property the whole design turns on --- */
  t('a SECOND run of the same export writes nothing', r.secondCreated === 0);
  t('...and the database is unchanged', r.countAfterSecond === r.countAfterFirst);
  t('...and it says WHY, rather than silently doing nothing',
    r.secondSkippedAsAlreadyImported === 3);

  /* --- a dry run is a dry run --- */
  t('a dry run reports all the work it would do', r.dryReportsWork === 3);
  t('...and writes nothing', r.countAfterDry === r.postsBefore);

  /* --- the content itself --- */
  t('a published post arrives published', r.article?.status === 'published');
  t('inline script is stripped on the way in', r.article?.hasScript === false);
  t('...while the actual text survives', r.article?.keepsText === true);
  t('the WordPress publish date is kept', r.article?.publish_date === '2024-03-05T09:30:00.000Z');
  t('tags come across', Array.isArray(r.article?.tags) && r.article.tags.includes('titanium'));
  t('the WordPress id is stamped, which is what makes a re-run safe',
    r.article?.wp_id === '42');
  t('the post is filed under the imported category',
    typeof r.article?.category_id === 'string' && r.article.category_id.length > 0);
  // WordPress's `nicename` IS the category slug, and keeping it is what makes
  // an old /category/frames/ URL still mean something.
  t('the category keeps its WordPress slug',
    r.categories.some((c) => c.slug === 'frames'));
  // The name is carried separately: un-slugifying `frames` would silently
  // rename the shop's "Frames & Lenses" category to "Frames".
  t('...and its display name, not a slug turned back into words',
    r.categories.find((c) => c.slug === 'frames')?.name === 'Frames & Lenses');
  t('a WordPress page becomes a page, not a post', r.pageKind === 'page');

  /* --- the one that would be a disclosure bug --- */
  t('WordPress `private` content is NOT published', r.secretStatus === 'draft');

  /* --- a slug collision cannot hijack the old URL --- */
  t('a colliding import is renamed by storage rather than refused',
    typeof r.collision.actualSlug === 'string' && r.collision.actualSlug !== 'frames');
  // The one that mattered: pointing /2020/01/frames at the PLANNED slug would
  // serve the unrelated pre-existing article to every old link forever.
  t('...and its legacy redirect follows the slug the record actually got',
    r.collision.redirectTarget === `/blog/${r.collision.actualSlug}`);

  /* --- two overlapping imports do not duplicate the site --- */
  t('two concurrent applies of one export create the post ONCE', r.raceCopies === 1);

  /* --- redirects --- */
  const moved = r.redirects.find((x) => x.match === '/2024/03/how-to-choose-a-frame');
  t('the moved post gets a 301 to its new home',
    moved?.target === '/blog/how-to-choose-a-frame' && moved.status === 301);
  t('the page that did not move gets no rule — that would be a loop',
    !r.redirects.some((x) => x.match === '/about-us'));
  t('no redirect points at itself', r.redirects.every((x) => x.match !== x.target));
}

await fs.rm(tmpRoot, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
