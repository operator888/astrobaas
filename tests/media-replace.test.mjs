#!/usr/bin/env node
/**
 * Replacing the file behind a media record, on every driver.
 *
 * The property that makes this a replace rather than a re-upload:
 *
 *   **The record keeps its id, and every stored reference to the old file
 *   points at the new one afterwards.** Uploads are content-addressed and
 *   served `immutable` for a year, so the new bytes MUST get a new URL —
 *   which means a replace that does not rewrite references is a replace that
 *   leaves the old picture on every page. That failure is invisible to the
 *   person who made the change: the media library shows the new file.
 *
 * And the one that stops it being destructive: two records with identical
 * bytes share one path, so the old file is unlinked only when nothing else
 * points at it.
 *
 * Run with:  node tests/media-replace.test.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTogether } from './lib/load.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

/* ------------------------------------------------------------------ *
 * The child: one driver, one database, real files on disk.            *
 * ------------------------------------------------------------------ */
if (process.env.REPLACE_TEST_CHILD) {
  const { build } = await import('esbuild');
  const { pathToFileURL } = await import('node:url');

  const cacheDir = path.join(root, 'node_modules', '.cache');
  await fs.mkdir(cacheDir, { recursive: true });
  const load = async (entry, name) => {
    const out = path.join(cacheDir, `astrobaas-repl-${name}-${process.pid}.mjs`);
    await build({
      entryPoints: [path.join(root, entry)],
      bundle: true, format: 'esm', platform: 'node', packages: 'external',
      outfile: out, logLevel: 'silent',
    });
    const mod = await import(pathToFileURL(out).href);
    await fs.rm(out, { force: true });
    return mod;
  };

  const [
    { ingestMedia },
    R,
    { LocalDB },
  ] = await loadTogether([
    'src/lib/media/ingest.ts',
    'src/lib/media/replace.ts',
    'src/lib/localdb.ts',
  ]);

  const sharpMod = await import('sharp');
  const sharp = sharpMod.default ?? sharpMod;
  const png = (w, h, r) => sharp({
    create: { width: w, height: h, channels: 3, background: { r, g: 80, b: 120 } },
  }).png().toBuffer();

  await LocalDB.init();
  const admin = (await LocalDB.getUsers()).find((u) => u.role === 'admin');

  const first = await ingestMedia(await png(1600, 1000, 200), {
    originalName: 'logo.png', declaredType: 'image/png',
    altText: 'The shop logo', uploadedBy: admin.id,
  });
  if (!first.ok) { console.log(JSON.stringify({ fatal: first.error })); process.exit(0); }
  const original = first.media;

  // A post and a product that both embed the file, at more than one size.
  const post = await LocalDB.createPost({
    title: 'About us', slug: 'about-us-replace-test',
    content: `<p>Hello</p><img src="${original.url}" alt="logo">`
      + (original.thumb_url ? `<img src="${original.thumb_url}" alt="small">` : ''),
    status: 'published', author_id: admin.id, tags: [], views: 0,
  });
  const untouchedPost = await LocalDB.createPost({
    title: 'Unrelated', slug: 'unrelated-replace-test',
    content: '<p>Nothing to do with any of this.</p>',
    status: 'published', author_id: admin.id, tags: [], views: 0,
  });
  const product = await LocalDB.createProduct({
    name: 'A thing', slug: 'a-thing-replace-test', price_cents: 1000,
    on_sale: false, stock: null, in_stock: true, categories: [],
    images: [{ src: original.url }], status: 'active',
    // The three hiding places the audit caught: a variant's own image
    // override, a translated description, and (below) a brand logo.
    variants: [{ id: 'v1', options: {}, image: original.url }],
    description: `<img src="${original.url}">`,
    i18n: { de: { description: `<p>Deutsch <img src="${original.url}"></p>` } },
  });
  const brand = await LocalDB.createBrand({
    name: 'Replace Test Brand', slug: 'replace-test-brand', logo: original.url,
  });
  const postWithFeatured = await LocalDB.createPost({
    title: 'Has a featured image', slug: 'featured-replace-test',
    content: '<p>body</p>', status: 'published', author_id: admin.id,
    tags: [], views: 0, featured_image: original.url,
  });

  // A record with UNIQUE bytes, replaced later: the one case whose old files
  // are shared with nobody, so the unlink half of the contract can actually
  // be observed failing. The twin below shares every path and proves the
  // KEEP half; without this record, removedFiles was 0 in every run and the
  // deletion code was untestable.
  const solo = await ingestMedia(await png(1600, 1000, 90), {
    originalName: 'solo.png', declaredType: 'image/png', uploadedBy: admin.id,
  });

  // A SECOND record with the very same bytes. Content-addressed, so it shares
  // the file on disk — and the replace must not delete it out from under it.
  const twin = await ingestMedia(await png(1600, 1000, 200), {
    originalName: 'logo-copy.png', declaredType: 'image/png', uploadedBy: admin.id,
  });

  const uploads = process.env.UPLOADS_DIR;
  const onDisk = async (url) => {
    try { await fs.access(path.join(uploads, url.replace(/^\/uploads\//, ''))); return true; }
    catch { return false; }
  };

  const { mediaFilePaths } = await load('src/lib/media/files.ts', 'files');
  const oldUrl = original.url;
  const oldThumb = original.thumb_url ?? null;
  const oldPathsBefore = mediaFilePaths(original);

  const result = await R.replaceMediaFile(original.id, await png(500, 320, 40), {
    originalName: 'logo-v2.png', declaredType: 'image/png', uploadedBy: admin.id,
  });

  const after = ((await LocalDB.getMedia())).find((m) => m.id === original.id);
  const postAfter = (await LocalDB.getPosts()).find((p) => p.id === post.id);
  const untouchedAfter = (await LocalDB.getPosts()).find((p) => p.id === untouchedPost.id);
  const productAfter = (await LocalDB.getProducts()).find((p) => p.id === product.id);
  const mediaCount = (await LocalDB.getMedia()).length;

  const productAfterR = (await LocalDB.getProducts()).find((p) => p.id === product.id);
  const brandAfter = (await LocalDB.getBrands()).find((b) => b.id === brand.id);
  const featuredAfter = (await LocalDB.getPosts()).find((p) => p.id === postWithFeatured.id);

  // Replace the solo record: nothing shares its bytes, so its old files must
  // actually LEAVE the disk.
  const soloOldUrl = solo.ok ? solo.media.url : null;
  const soloResult = solo.ok
    ? await R.replaceMediaFile(solo.media.id, await png(500, 320, 150), {
        originalName: 'solo-v2.png', declaredType: 'image/png', uploadedBy: admin.id,
      })
    : { ok: false };

  // Replacing with the SAME bytes it already has must be a no-op, not a
  // sequence that deletes the file it just wrote.
  const sameAgain = await R.replaceMediaFile(after.id, await png(500, 320, 40), {
    originalName: 'again.png', declaredType: 'image/png', uploadedBy: admin.id,
  });
  const afterNoop = ((await LocalDB.getMedia())).find((m) => m.id === original.id);

  console.log(JSON.stringify({
    ok: result.ok,
    keptId: after?.id === original.id,
    urlChanged: after?.url !== oldUrl,
    keptAlt: after?.alt_text,
    keptUploader: after?.uploaded_by === admin.id,
    newDimensions: after ? [after.width, after.height] : null,
    // How many paths the old record owned. The variant pairing is only
    // testable when there are MIDDLE widths — ones that are neither `url` nor
    // `thumb_url` — which a small fixture does not produce.
    oldPathCount: oldPathsBefore.length,
    // The replacement is smaller, so it has FEWER derivative widths. A width
    // with no counterpart must still be mapped — to the new main image — or a
    // page that embedded it shows a 404 instead of a picture.
    widthsDropped: result.ok
      ? (original.variants ?? []).length - ((after?.variants ?? []).length)
      : null,
    // The whole point.
    postStillPointsAtOld: (postAfter?.content ?? '').includes(oldUrl),
    postPointsAtNew: (postAfter?.content ?? '').includes(after?.url ?? '#'),
    thumbRewritten: oldThumb ? !(postAfter?.content ?? '').includes(oldThumb) : null,
    hadThumb: !!oldThumb,
    // The invariant that actually matters: not one line of pairUrls, but that
    // NO path the old record owned is left without a destination. An unmapped
    // URL is a broken image on a live page.
    unmappedOldPaths: result.ok ? oldPathsBefore.filter((p) => !(p in result.rewrote)) : null,
    productStillPointsAtOld: (productAfter?.images ?? []).some((i) => i.src === oldUrl),
    productPointsAtNew: (productAfter?.images ?? []).some((i) => i.src === after?.url),
    untouchedUnchanged: (untouchedAfter?.content ?? '') === '<p>Nothing to do with any of this.</p>',
    reported: result.ok ? result.updated : null,
    // One record in, one record out: the ingest of the replacement must not
    // leave a second row behind.
    mediaCount,
    variantRewritten: productAfterR?.variants?.[0]?.image === after?.url,
    descriptionRewritten: (productAfterR?.description ?? '').includes(after?.url ?? '#'),
    i18nRewritten: (productAfterR?.i18n?.de?.description ?? '').includes(after?.url ?? '#'),
    i18nTextKept: (productAfterR?.i18n?.de?.description ?? '').includes('Deutsch'),
    brandRewritten: brandAfter?.logo === after?.url,
    featuredRewritten: featuredAfter?.featured_image === after?.url,
    solo: {
      ok: soloResult.ok === true,
      removed: soloResult.ok ? soloResult.removedFiles : -1,
      oldGone: soloOldUrl ? !(await onDisk(soloOldUrl)) : null,
    },
    twinUrl: twin.ok ? twin.media.url : null,
    twinFileStillThere: twin.ok ? await onDisk(twin.media.url) : null,
    oldFileGone: !(await onDisk(oldUrl)),
    newFileThere: after ? await onDisk(after.url) : false,
    noop: {
      ok: sameAgain.ok,
      urlUnchanged: afterNoop?.url === after?.url,
      fileStillThere: afterNoop ? await onDisk(afterNoop.url) : false,
      rewroteNothing: sameAgain.ok ? Object.keys(sameAgain.rewrote).length === 0 : null,
    },
    missing: (await R.replaceMediaFile('no-such-id', await png(10, 10, 1), {
      originalName: 'x.png', declaredType: 'image/png', uploadedBy: admin.id,
    })),
  }));
  process.exit(0);
}

/* ------------------------------------------------------------------ *
 * The parent.                                                         *
 * ------------------------------------------------------------------ */
let pass = 0;
let fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };

const tmpRoot = path.join(os.tmpdir(), `astrobaas-replace-test-${process.pid}`);
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
      REPLACE_TEST_CHILD: '1',
      UPLOADS_DIR: path.join(dir, 'uploads'),
      NODE_ENV: 'test',
      ...driver.env(dir),
    },
    maxBuffer: 32 * 1024 * 1024,
  });

  const line = (run.stdout ?? '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
  if (!line) {
    fail++;
    console.error(`✗ [${driver.name}] the replace child produced no result`);
    console.error((run.stderr ?? '').split('\n').slice(-15).join('\n'));
    continue;
  }
  const r = JSON.parse(line);
  if (r.fatal) { fail++; console.error(`✗ [${driver.name}] ${r.fatal}`); continue; }
  const t = (n, c) => check(`[${driver.name}] ${n}`, c);

  /* --- the record --- */
  t('the replace succeeds', r.ok === true);
  t('the record KEEPS its id — that is what makes it a replace', r.keptId === true);
  t('the URL changes, because the bytes did and the path is their hash',
    r.urlChanged === true);
  // Preserved because the update names only the file's own fields. A payload
  // that started overwriting alt_text would fail here.
  t('the alt text survives — it describes the picture, not the file',
    r.keptAlt === 'The shop logo');
  t('the original uploader is not overwritten', r.keptUploader === true);
  t('the new dimensions are recorded', JSON.stringify(r.newDimensions) === '[500,320]');
  t('the fixture is big enough to have middle derivative widths, so the '
    + 'variant pairing is actually exercised', r.oldPathCount >= 4);
  t('the replacement really does have fewer widths, so the no-counterpart '
    + 'fallback is exercised too', r.widthsDropped >= 1);
  // original + twin + solo — and NOT a fourth row from the replacement's own
  // ingest, which is the leak this asserts against.
  t('no extra media row is left behind by ingesting the replacement',
    r.mediaCount === 3);

  /* --- references, which is what makes it real --- */
  t('the post no longer points at the old file', r.postStillPointsAtOld === false);
  t('...and points at the new one instead', r.postPointsAtNew === true);
  t('the fixture really does have a thumbnail, so the next check means something',
    r.hadThumb === true);
  t('an embedded THUMBNAIL is rewritten too, not just the main image',
    r.thumbRewritten === true);
  t('EVERY path the old record owned has a destination — none is left dangling',
    Array.isArray(r.unmappedOldPaths) && r.unmappedOldPaths.length === 0);
  t('the product image is rewritten', r.productStillPointsAtOld === false && r.productPointsAtNew === true);
  t('a post that never mentioned the file is left exactly alone',
    r.untouchedUnchanged === true);
  // The blocker: the field is featured_image; the first version wrote
  // cover_image, a name that exists nowhere, so featured images stayed broken.
  t('the FEATURED IMAGE field is rewritten', r.featuredRewritten === true);
  t('a variant IMAGE OVERRIDE is rewritten', r.variantRewritten === true);
  t('the product description HTML is rewritten', r.descriptionRewritten === true);
  t('a TRANSLATED description is rewritten too — bilingual pages must not keep the dead URL',
    r.i18nRewritten === true);
  t('...without corrupting the translated text around it', r.i18nTextKept === true);
  t('a brand LOGO is rewritten', r.brandRewritten === true);
  // Two posts now reference the file: the embedded one and the featured one.
  t('the report says how many records were rewritten',
    r.reported?.posts === 2 && r.reported?.products === 1);

  /* --- files on disk --- */
  t('the new file is on disk', r.newFileThere === true);
  // The twin has identical bytes, so it shares the old path. Deleting it
  // would break a different record's image.
  t('a file another record still points at is NOT deleted', r.twinFileStillThere === true);
  t('...which is why the old path survives here', r.oldFileGone === false);

  /* --- old files of an UNSHARED record actually leave the disk --- */
  t('replacing a record nobody shares removes its old files', r.solo.removed >= 1);
  t('...verifiably: the old main file is gone from disk', r.solo.oldGone === true);

  /* --- replacing with what is already there --- */
  t('replacing a file with identical bytes succeeds', r.noop.ok === true);
  t('...changes nothing', r.noop.urlUnchanged === true && r.noop.rewroteNothing === true);
  // The dangerous version of this: treat it as a normal replace, unlink the
  // "old" paths, and delete the file that was just written.
  t('...and does NOT delete the file it just wrote', r.noop.fileStillThere === true);

  /* --- a record that is not there --- */
  t('replacing a missing record fails with a reason rather than throwing',
    r.missing?.ok === false && /No such media/.test(r.missing?.error ?? ''));
}

await fs.rm(tmpRoot, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
