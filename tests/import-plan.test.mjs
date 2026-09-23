#!/usr/bin/env node
/**
 * The import planner (src/lib/import/plan.ts).
 *
 * The parser reports what a file says; the planner DECIDES. Every decision it
 * makes is one somebody will argue with months later — why is that page a
 * draft, why did that URL not redirect, where did those 23 posts go — so each
 * one is pinned here, including the ones that are deliberately conservative.
 *
 * The rule the whole file exists to defend: an item is either planned or
 * skipped WITH A REASON. Nothing is dropped silently.
 *
 * Run with:  node tests/import-plan.test.mjs
 */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cacheDir = path.join(here, '..', 'node_modules', '.cache');
await fs.mkdir(cacheDir, { recursive: true });
const out = path.join(cacheDir, `astrobaas-plan-${process.pid}.mjs`);
await build({
  entryPoints: [path.join(here, '..', 'src/lib/import/plan.ts')],
  bundle: true, format: 'esm', platform: 'node', packages: 'external',
  outfile: out, logLevel: 'silent',
});
const P = await import(pathToFileURL(out).href);
await fs.rm(out, { force: true });

let pass = 0;
let fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };

/** A parsed-document shape, so the planner can be tested without the parser. */
const item = (over = {}) => ({
  type: 'post', wpId: '1', title: 'A post', slug: 'a-post', content: '<p>x</p>',
  excerpt: '', status: 'publish', categories: [], tags: [], ...over,
});
const doc = (items, over = {}) => ({ authors: [], items, ...over });

/* ---- slugs ---- */
{
  const s = P.slugifyImported;
  check('accents fold to ASCII', s('Καλημέρα Café') === 'cafe');
  check('punctuation becomes single hyphens', s('How to  choose --- a frame!') === 'how-to-choose-a-frame');
  check('leading and trailing hyphens are trimmed', s('  --hello--  ') === 'hello');
  check('a slug is capped, so one absurd title cannot produce an absurd URL',
    s('x'.repeat(300)).length === 80);
  check('a title with nothing slugifiable yields empty, not garbage', s('!!! ???') === '');
}

/* ---- statuses ---- */
{
  const m = P.mapStatus;
  check('publish → published', m('publish') === 'published');
  check('draft → draft', m('draft') === 'draft');
  check('pending → review', m('pending') === 'review');
  check('future → scheduled, so the scheduler still owns it', m('future') === 'scheduled');
  // The one that matters: WordPress "private" means logged-in-only. This CMS
  // has no such state, and guessing "published" would put a deliberately
  // non-public page on the open web in the middle of a migration.
  check('private → DRAFT, never published', m('private') === 'draft');
  check('an unknown status falls back to draft, not published', m('whatever') === 'draft');
}

/* ---- permalink paths ---- */
{
  const p = P.permalinkPath;
  check('a full URL yields its path', p('https://old.gr/2024/03/frames/') === '/2024/03/frames');
  check('a query string is dropped — the whole point is dead URLs with gclid on them',
    p('https://old.gr/frames/?gclid=abc') === '/frames');
  check('a fragment is dropped', p('https://old.gr/frames/#top') === '/frames');
  check('a bare path is accepted, because some exports carry one', p('/frames/') === '/frames');
  check('the site root yields null — a redirect from / would swallow the site', p('https://old.gr/') === null);
  check('a wildcard yields null rather than a rule that matches everything', p('/shop/*') === null);
  check('undefined yields null', p(undefined) === null);
  check('a relative fragment yields null', p('not-a-path') === null);
  // //host/path is a network-path reference: new URL() throws on it, so it
  // slips through the catch branch and passed startsWith('/') — becoming a
  // rule no same-site request could ever match.
  check('a protocol-relative URL yields null, not a junk rule', p('//evil.example/x') === null);
}

/* ---- everything is planned or skipped, with a reason ---- */
{
  const plan = P.planImport(doc([
    item({ wpId: '1', type: 'post', slug: 'one' }),
    item({ wpId: '2', type: 'page', slug: 'two' }),
    item({ wpId: '3', type: 'attachment', attachmentUrl: 'https://old.gr/a.jpg' }),
    item({ wpId: '4', type: 'post', status: 'trash', slug: 'four' }),
    item({ wpId: '5', type: 'product', slug: 'five' }),
    item({ wpId: '6', type: 'post', status: 'auto-draft', slug: 'six' }),
    item({ wpId: '7', type: 'attachment' }), // no URL
  ]));
  const accounted = plan.posts.length + plan.media.length + plan.skipped.length;
  check('every item is either planned or skipped — none vanish', accounted === 7);
  check('posts and pages are planned', plan.posts.length === 2);
  check('an attachment with a URL becomes media', plan.media.length === 1);
  check('trash is skipped by default', plan.skipped.some((s) => s.wpId === '4' && /bin/i.test(s.reason)));
  check('a custom type is skipped WITH the flag that would import it',
    plan.skipped.some((s) => s.wpId === '5' && /extraTypes/.test(s.reason)));
  check('an auto-draft is skipped', plan.skipped.some((s) => s.wpId === '6'));
  check('an attachment with no file URL is skipped, not silently lost',
    plan.skipped.some((s) => s.wpId === '7' && /file URL/i.test(s.reason)));
  check('every skip carries a non-empty reason', plan.skipped.every((s) => s.reason.length > 10));
}

/* ---- the options actually change the outcome ---- */
{
  const items = [
    item({ wpId: '1', type: 'page', slug: 'p' }),
    item({ wpId: '2', type: 'attachment', attachmentUrl: 'https://old.gr/a.jpg' }),
    item({ wpId: '3', type: 'post', status: 'trash', slug: 't' }),
    item({ wpId: '4', type: 'portfolio', slug: 'work' }),
  ];
  check('includePages:false skips pages', P.planImport(doc(items), { includePages: false }).posts.length === 0);
  check('includeMedia:false skips media', P.planImport(doc(items), { includeMedia: false }).media.length === 0);
  check('includeTrash:true brings the bin in', P.planImport(doc(items), { includeTrash: true }).posts.length === 2);
  const extra = P.planImport(doc(items), { extraTypes: ['portfolio'] });
  check('extraTypes imports a custom type as a post',
    extra.posts.some((p) => p.slug === 'work' && p.kind === 'post'));
}

/* ---- collisions within one export ---- */
{
  const plan = P.planImport(doc([
    item({ wpId: '1', title: 'Frames', slug: 'frames' }),
    item({ wpId: '2', title: 'Frames', slug: 'frames' }),
    item({ wpId: '3', title: 'Frames', slug: 'frames' }),
  ]));
  const slugs = plan.posts.map((p) => p.slug);
  check('two posts that shared a slug do not collide inside the plan',
    new Set(slugs).size === 3);
  check('...and the first one keeps the clean slug', slugs[0] === 'frames');
  check('...while the others are suffixed', slugs[1] === 'frames-2' && slugs[2] === 'frames-3');
  check('an item with no usable title or slug still gets one',
    P.planImport(doc([item({ wpId: '9', title: '!!!', slug: '' })])).posts[0].slug.length > 0);
}

/* ---- redirects: only where the URL moved ---- */
{
  const plan = P.planImport(doc([
    // A post on WordPress's default dated permalink — this one moves.
    item({ wpId: '1', type: 'post', slug: 'frames', link: 'https://old.gr/2024/03/frames/' }),
    // A page already at its final path — a rule here would be a loop.
    item({ wpId: '2', type: 'page', slug: 'about', link: 'https://old.gr/about/' }),
    // No link in the export at all — nothing can be inferred.
    item({ wpId: '3', type: 'post', slug: 'no-link' }),
  ]));
  check('a moved post gets a redirect', plan.redirects.some((r) => r.from === '/2024/03/frames' && r.to === '/blog/frames'));
  check('a page that did NOT move gets no redirect — that would be a loop',
    !plan.redirects.some((r) => r.from === '/about'));
  check('an item with no link gets no redirect', plan.redirects.length === 1);
  check('no redirect ever points at itself', plan.redirects.every((r) => r.from !== r.to));
}

/* ---- what a planned post carries ---- */
{
  const plan = P.planImport(doc([
    item({
      wpId: '42', title: 'How to choose a frame', slug: 'how-to-choose-a-frame',
      content: '<p>Body</p>', excerpt: 'Short', status: 'publish',
      publishedAt: '2024-03-05T09:30:00.000Z', authorLogin: 'maria',
      categories: [{ slug: 'Frames & Lenses', name: 'Frames & Lenses' }, { slug: 'second', name: 'Second' }],
      tags: ['titanium'], thumbnailId: '77',
      link: 'https://old.gr/2024/03/how-to-choose-a-frame/',
    }),
  ]));
  const p = plan.posts[0];
  check('the WordPress id is carried, because idempotency depends on it', p.wpId === '42');
  check('the publish date survives', p.publishedAt === '2024-03-05T09:30:00.000Z');
  check('the author LOGIN is reported, not turned into an account', p.authorLogin === 'maria');
  check('the category slug is slugified — a raw WP name is not a URL',
    p.categorySlug === 'frames-lenses');
  check('tags come across', p.tags.join() === 'titanium');
  check('the featured image is remembered by wp id', p.thumbnailWpId === '77');
  check('the original path is kept for the redirect', p.originalUrl === '/2024/03/how-to-choose-a-frame');
}

/* ---- authors are reported, never created ---- */
{
  const plan = P.planImport(doc([item()], {
    authors: [{ login: 'maria', email: 'maria@old.gr', displayName: 'Maria K.' }],
    siteUrl: 'https://old.gr',
  }));
  check('the author list reaches the plan so an operator can invite them',
    plan.authors.length === 1 && plan.authors[0].email === 'maria@old.gr');
  check('the old site URL reaches the plan', plan.siteUrl === 'https://old.gr');
  check('no planned post claims an account id — only a login',
    plan.posts.every((p) => !('authorId' in p)));
}

/* ---- the summary counts what actually happened ---- */
{
  const plan = P.planImport(doc([
    item({ wpId: '1', type: 'post', slug: 'a' }),
    item({ wpId: '2', type: 'page', slug: 'b' }),
    item({ wpId: '3', type: 'attachment', attachmentUrl: 'https://old.gr/a.jpg' }),
    item({ wpId: '4', type: 'product', slug: 'd' }),
  ]));
  const s = P.summarisePlan(plan);
  check('the summary separates posts from pages', /1 post\(s\), 1 page\(s\)/.test(s));
  check('...and reports media and skips', /1 media file\(s\)/.test(s) && /1 skipped/.test(s));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
