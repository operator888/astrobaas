#!/usr/bin/env node
/**
 * Breadcrumb trails and schema.org nodes
 * (src/lib/breadcrumbs.ts, src/lib/structured-data.ts).
 *
 * Structured data fails SILENTLY — a malformed node does not break the page,
 * it just quietly stops earning the rich result it was written for. So the
 * invariants get asserted here rather than discovered in Search Console six
 * months later:
 *
 *  - no origin → no absolute URL invented (never `http://localhost:4321` on
 *    a live site);
 *  - images resolve through the MEDIA base, not the site origin, and an
 *    already-absolute imported URL is left alone;
 *  - the visible trail and the BreadcrumbList are the same list;
 *  - money is integer cents in this codebase and a decimal string in
 *    schema.org, converted in exactly one place.
 *
 * Run with:  node tests/structured-data.test.mjs
 */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cacheDir = path.join(here, '..', 'node_modules', '.cache');
await fs.mkdir(cacheDir, { recursive: true });

const entry = path.join(cacheDir, `astrobaas-sd-entry-${process.pid}.ts`);
const outFile = path.join(cacheDir, `astrobaas-sd-${process.pid}.mjs`);
const root = path.join(here, '..');
await fs.writeFile(entry, [
  `export * from ${JSON.stringify(path.join(root, 'src/lib/breadcrumbs.ts'))};`,
  `export * from ${JSON.stringify(path.join(root, 'src/lib/structured-data.ts'))};`,
].join('\n'));
await build({
  entryPoints: [entry], bundle: true, format: 'esm', platform: 'node',
  packages: 'external', outfile: outFile, logLevel: 'silent',
});
const S = await import(pathToFileURL(outFile).href);
await fs.rm(entry, { force: true });
await fs.rm(outFile, { force: true });

let pass = 0;
let fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };

const ORIGIN = 'https://shop.example';

/* ---- trails ---- */
{
  const post = { title: 'How to choose a frame' };

  const plain = S.trailForPost(post);
  check('a post trail is Home › Blog › Title', plain.length === 3
    && plain[0].name === 'Home' && plain[0].href === '/'
    && plain[1].href === '/blog' && plain[2].name === post.title);
  check('the current page is NOT a link to itself', plain[2].href === undefined);

  const withCat = S.trailForPost(post, { categoryName: 'Frames', categorySlug: 'frames' });
  check('a category becomes a fourth crumb linking where the reader can go',
    withCat.length === 4 && withCat[2].name === 'Frames'
    && withCat[2].href === '/blog?category=frames');
  check('a category name without a slug is not guessed into a link',
    S.trailForPost(post, { categoryName: 'Frames' }).length === 3);
  check('category slugs are URL-encoded',
    S.trailForPost(post, { categoryName: 'A&B', categorySlug: 'a&b' })[2].href === '/blog?category=a%26b');

  // Public content language comes from the URL, not the admin's preference.
  check('crumbs speak the CONTENT locale',
    S.trailForPost(post, { locale: 'el' })[0].name === 'Αρχική'
    && S.trailForPost(post, { locale: 'de' })[0].name === 'Startseite'
    && S.trailForPost(post, { locale: 'el-GR' })[0].name === 'Αρχική');
  check('an unknown locale falls back to English, never blank',
    S.trailForPost(post, { locale: 'ja' })[0].name === 'Home');

  check('the archive trail is Home › Blog', S.trailForArchive().length === 2);
  check('a filtered archive adds the category as the current crumb', (() => {
    const t = S.trailForArchive({ categoryName: 'Frames' });
    return t.length === 3 && t[1].href === '/blog' && t[2].name === 'Frames' && !t[2].href;
  })());
  check('a page trail is Home › Title (flat — a Post has no parent)', (() => {
    const t = S.trailForPage({ title: 'About' });
    return t.length === 2 && t[1].name === 'About' && !t[1].href;
  })());
}

/* ---- BreadcrumbList ---- */
{
  const trail = S.trailForPost({ title: 'Post' }, { categoryName: 'C', categorySlug: 'c' });
  const node = S.breadcrumbListJsonLd(trail, ORIGIN);
  check('positions are 1-based and in order',
    node.itemListElement.map((i) => i.position).join() === '1,2,3,4');
  check('names mirror the visible trail exactly',
    node.itemListElement.map((i) => i.name).join('|') === trail.map((i) => i.name).join('|'));
  check('items are absolute', node.itemListElement[1].item === `${ORIGIN}/blog`);
  check('the LAST item carries no url (it is the current page)',
    node.itemListElement[3].item === undefined);

  const noOrigin = S.breadcrumbListJsonLd(trail, null);
  check('with no origin, NO url is invented',
    noOrigin.itemListElement.every((i) => i.item === undefined));
  check('but the names still ship (the crumbs are still true)',
    noOrigin.itemListElement.length === 4);

  check('a trail of one is not a BreadcrumbList',
    S.breadcrumbListJsonLd([{ name: 'Home', href: '/' }], ORIGIN) === null
    && S.breadcrumbListJsonLd([], ORIGIN) === null);
}

/* ---- article ---- */
{
  const ctx = { origin: ORIGIN, mediaBase: 'https://cms.example', siteTitle: 'Shop' };
  const a = S.articleNode({
    title: 'T', description: 'D', path: '/blog/t',
    datePublished: '2026-01-01', dateModified: '2026-02-02',
    authorName: 'Someone', image: '/uploads/2026/01/x.webp', categoryName: 'Frames',
  }, ctx);
  check('BlogPosting carries headline, dates and author',
    a['@type'] === 'BlogPosting' && a.headline === 'T'
    && a.datePublished === '2026-01-01' && a.author.name === 'Someone');
  check('url and mainEntityOfPage are the canonical article URL',
    a.url === `${ORIGIN}/blog/t` && a.mainEntityOfPage === a.url);
  check('the image resolves against the MEDIA base, not the site origin',
    a.image === 'https://cms.example/uploads/2026/01/x.webp');
  check('it references the Organization by @id instead of redefining it',
    a.publisher['@id'] === `${ORIGIN}/#organization`);

  const imported = S.articleNode({ title: 'T', path: '/blog/t', image: 'https://old-shop.gr/img.jpg' }, ctx);
  check('an already-absolute imported image is left alone, never double-prefixed',
    imported.image === 'https://old-shop.gr/img.jpg');

  const originless = S.articleNode({ title: 'T', path: '/blog/t', image: '/uploads/x.webp' }, { origin: null });
  check('with no origin: no url, no image, but the article still describes itself',
    originless.url === undefined && originless.image === undefined && originless.headline === 'T');
  check('an absolute image survives even with no origin at all',
    S.articleNode({ title: 'T', path: '/p', image: 'https://cdn.example/i.png' }, { origin: null }).image
      === 'https://cdn.example/i.png');
}

/* ---- site identity ---- */
{
  const ctx = { origin: ORIGIN, siteTitle: 'Example Optics' };
  const org = S.organizationNode(ctx);
  check('Organization is @id-addressable so other nodes can point at it',
    org['@id'] === `${ORIGIN}/#organization` && org.name === 'Example Optics');
  check('no site title → no Organization (an unnamed publisher is not a fact)',
    S.organizationNode({ origin: ORIGIN }) === null);

  const site = S.webSiteNode({ ...ctx, tagline: 'Eyewear', searchPath: '/blog?q=' });
  check('WebSite links to its publisher by @id', site.publisher['@id'] === `${ORIGIN}/#organization`);
  check('the SearchAction template points at the real search endpoint',
    site.potentialAction.target.urlTemplate === `${ORIGIN}/blog?q={search_term_string}`);
  check('no search endpoint claimed when the site has none',
    S.webSiteNode(ctx).potentialAction === undefined);
}

/* ---- collection ---- */
{
  const c = S.collectionPageNode({
    title: 'Blog', path: '/blog',
    items: [{ title: 'A', path: '/blog/a' }, { title: 'B', path: '/blog/b' }],
  }, { origin: ORIGIN });
  check('CollectionPage carries an ItemList of the right size',
    c.mainEntity['@type'] === 'ItemList' && c.mainEntity.numberOfItems === 2);
  check('list entries are positions + urls, not duplicated articles',
    c.mainEntity.itemListElement[1].position === 2
    && c.mainEntity.itemListElement[1].url === `${ORIGIN}/blog/b`
    && c.mainEntity.itemListElement[1].headline === undefined);
  check('an empty archive omits the list rather than claiming an empty one',
    S.collectionPageNode({ title: 'Blog', path: '/blog', items: [] }, { origin: ORIGIN }).mainEntity === undefined);
}

/* ---- product ---- */
{
  const ctx = { origin: ORIGIN, mediaBase: 'https://cms.example' };
  const p = S.productNode({
    name: 'Frame', sku: 'F-1', gtin: '123', brand: 'Ray',
    priceCents: 12950, currency: 'EUR', inStock: true, status: 'active',
    images: ['/uploads/a.webp'], path: '/shop/frame',
  }, ctx);
  check('money: integer cents become a schema.org decimal STRING',
    p.offers.price === '129.50' && typeof p.offers.price === 'string');
  check('an active, in-stock product is InStock',
    p.offers.availability === 'https://schema.org/InStock');
  check('brand is a Brand node, sku and gtin survive',
    p.brand.name === 'Ray' && p.sku === 'F-1' && p.gtin === '123');
  check('product images resolve through the media base',
    p.image[0] === 'https://cms.example/uploads/a.webp');

  check('out of stock is OutOfStock',
    S.productNode({ name: 'X', priceCents: 100, inStock: false, status: 'active' }, ctx)
      .offers.availability === 'https://schema.org/OutOfStock');
  check('a non-active product is never advertised as buyable',
    S.productNode({ name: 'X', priceCents: 100, inStock: true, status: 'draft' }, ctx)
      .offers.availability === 'https://schema.org/OutOfStock');
  check('no price → no Offer at all (rather than an offer of nothing)',
    S.productNode({ name: 'X', status: 'active' }, ctx).offers === undefined);
  check('a zero price is still a price (free is a real offer)',
    S.productNode({ name: 'X', priceCents: 0, status: 'active', inStock: true }, ctx).offers.price === '0.00');
}

/* ---- the graph wrapper ---- */
{
  const g = S.structuredData([{ '@type': 'A' }, null, undefined, { '@type': 'B' }]);
  check('nulls are dropped so callers can pass optional nodes inline',
    g['@graph'].length === 2 && g['@context'] === 'https://schema.org');
  check('nothing to say → null, so the caller can skip the element',
    S.structuredData([null, undefined]) === null && S.structuredData([]) === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
