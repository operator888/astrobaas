#!/usr/bin/env node
/**
 * Give existing media the dimensions and derivatives new uploads now get.
 *
 *   npm run media:backfill              # report what would change, write nothing
 *   npm run media:backfill -- --apply   # do it
 *   npm run media:backfill -- --apply --limit 200
 *
 * ## Why this is a script and not a boot migration
 *
 * One of these shops has 31,349 image files. Generating derivatives for all of
 * them inside a schema migration would mean a deploy that appears to hang for
 * an hour, holds the migration lock the whole time, and cannot be stopped
 * without leaving the database at a half-applied version. A shop would very
 * reasonably kill it, and then be worse off than before.
 *
 * So it is a separate, resumable, interruptible pass an operator runs when they
 * choose. It skips records that already have variants, which is what makes
 * re-running it after a Ctrl-C free.
 *
 * NEW UPLOADS DO NOT DEPEND ON THIS. The pipeline runs in the upload route
 * itself — see src/pages/api/media/upload.ts. If a shop never runs this script,
 * everything uploaded from now on is still complete; only the back catalogue
 * stays as it was.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { loadTsBundle } from './lib/load-ts.mjs';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const limitArg = args.indexOf('--limit');
const LIMIT = limitArg >= 0 ? Number(args[limitArg + 1]) || Infinity : Infinity;

/*
 * The project sources are TypeScript and import each other without extensions,
 * which Node cannot resolve directly. Bundle them the same way the test suite
 * does — esbuild is already a dependency, and this keeps the script running the
 * REAL modules rather than a reimplementation that could drift from the upload
 * path it is meant to match.
 */
async function loadProjectModules() {
  // loadTsBundle, not a fourth private copy of the esbuild dance. The barrel it
  // writes is what lets three modules arrive as one import — and it removes the
  // barrel in a `finally`, which the version here did not.
  return loadTsBundle([
    "export { LocalDB } from '../../src/lib/localdb';",
    "export { generateDerivatives, MAX_INPUT_PIXELS } from '../../src/lib/media/derivatives';",
    "export { getUploadsDir } from '../../src/lib/paths';",
  ], 'backfill');
}

async function main() {
  const sharpMod = await import('sharp').catch((err) => {
    console.error(
      'sharp is not available, so no derivatives can be generated.\n'
      + `  reason: ${err.message}\n`
      + '  Fix with: npm install --include=optional sharp',
    );
    process.exit(2);
  });
  const sharp = sharpMod.default ?? sharpMod;
  try { sharp.cache(false); sharp.concurrency(1); } catch { /* older sharp */ }

  const { LocalDB, generateDerivatives, MAX_INPUT_PIXELS, getUploadsDir } = await loadProjectModules();

  await LocalDB.init();
  const media = await LocalDB.getMedia();
  const uploadsRoot = getUploadsDir();

  const images = media.filter((m) => String(m.mime_type || '').startsWith('image/'));
  const todo = images.filter((m) => !Array.isArray(m.variants) || m.variants.length === 0);

  console.log(
    `${media.length} media records, ${images.length} images, ${todo.length} without derivatives.`,
  );
  if (!APPLY) {
    console.log('\nDry run. Nothing was written. Re-run with --apply to generate.');
    if (todo.length) {
      console.log('\nFirst few that would be processed:');
      for (const m of todo.slice(0, 5)) console.log(`  ${m.url}  (${m.original_name})`);
    }
    return;
  }

  let done = 0, skipped = 0, failedCount = 0, bytes = 0;
  for (const m of todo.slice(0, LIMIT)) {
    // Prefer the untouched original when one exists; otherwise the stored url
    // is the best source we have.
    const source = typeof m.original_url === 'string' ? m.original_url : m.url;
    if (typeof source !== 'string' || !source.startsWith('/uploads/')) { skipped += 1; continue; }

    const abs = path.resolve(uploadsRoot, source.replace(/^\/uploads\//, ''));
    // Containment, exactly as the delete path does it: a stored url is data.
    if (!abs.startsWith(uploadsRoot + path.sep)) { skipped += 1; continue; }

    let buf;
    try {
      buf = await fs.readFile(abs);
    } catch {
      // The record points at a file that is gone. Report rather than crash —
      // an old library always has some of these.
      console.warn(`  missing file, skipped: ${source}`);
      skipped += 1;
      continue;
    }

    try {
      const meta = await sharp(buf, { failOn: 'truncated', limitInputPixels: MAX_INPUT_PIXELS }).metadata();
      const swap = typeof meta.orientation === 'number' && meta.orientation >= 5;
      const width = swap ? meta.height : meta.width;
      const height = swap ? meta.width : meta.height;
      if (!width || !height) { skipped += 1; continue; }

      const dir = path.dirname(abs);
      const urlPrefix = path.posix.dirname(source);
      const hash = path.basename(source).replace(/\.[^.]+$/, '').replace(/-thumb$/, '');

      /*
       * The SAME generator the upload route uses.
       *
       * The hand-rolled loop this replaces wrapped every width in one
       * try/catch, so a single failing size abandoned the whole record — the
       * exact all-or-nothing bug that was fixed in the upload path and then
       * reintroduced here. Two implementations of one rule is two chances for
       * them to disagree, and this is a script an operator runs over 31,000
       * files where one bad frame should cost one size, not the record.
       */
      const { derivatives, failed } = await generateDerivatives({
        sharp, buf, dir, urlPrefix, hash, originalWidth: width,
      });
      const variants = derivatives;
      for (const f of failed) console.warn(`  ${source}: ${f.width}px failed — ${f.reason}`);
      if (variants.length === 0) { failedCount += 1; continue; }
      for (const v of variants) bytes += v.size;

      variants.sort((a, b) => a.width - b.width);

      await LocalDB.updateMediaFile(m.id, {
        width, height,
        variants,
        // Point thumb_url at the 400px variant so the admin library and the
        // product picker pick it up. The record's `url` is deliberately NOT
        // repointed: existing content, exports and any storefront that stored
        // the string still resolve to the file they always resolved to.
        thumb_url: (variants.find((v) => v.width === 400) ?? variants[0])?.url ?? m.thumb_url,
        // For a row written before this change, the stored `url` IS the most
        // original artefact the record has: the old pipeline re-encoded to
        // WebP and deleted the raw upload. Naming it `original_url` lets a
        // storefront offer "the full-size version" the same way for old and
        // new rows. It does not claim the raw camera file still exists.
        ...(m.original_url ? {} : { original_url: m.url }),
      });
      done += 1;
      if (done % 25 === 0) console.log(`  ${done}/${Math.min(todo.length, LIMIT)}…`);
    } catch (err) {
      console.warn(`  failed: ${source} — ${err.message}`);
      failedCount += 1;
    }
  }

  console.log(
    `\nDone. ${done} updated, ${skipped} skipped, ${failedCount} failed, `
    + `${(bytes / 1024 / 1024).toFixed(1)} MB of derivatives written.`,
  );
  if (todo.length > done + skipped + failedCount) {
    console.log('More remain — re-run to continue (already-done records are skipped).');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
