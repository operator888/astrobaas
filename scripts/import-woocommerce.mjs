#!/usr/bin/env node
/**
 * Import a normalized WooCommerce dataset into AstroBaaS.
 *
 *   npm run import:woo -- ./dump                 # rehearse, write nothing
 *   npm run import:woo -- ./dump --apply         # perform it
 *
 * Expects the JSON a dump parser produces, in one directory:
 *   products.json categories.json brands.json customers.json orders.json
 *   blog.json
 *
 * A THIN wrapper, like scripts/import-wp.mjs: what a record means and whether
 * it is safe to write lives in src/lib/import/woo.ts and woo-apply.ts, so the
 * rules cannot differ between one entry point and another.
 *
 * The version this replaces wrote db.json directly — a lowdb-only tool that did
 * nothing on the two drivers a real shop runs, skipped HTML sanitization, and
 * would happily write a product whose price had failed to parse.
 */
import { loadTs as load } from './lib/load-ts.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

const argv = process.argv.slice(2);
const dir = argv.find((a) => !a.startsWith('-'));
const has = (flag) => argv.includes(flag);
const value = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};

if (!dir || has('--help') || has('-h')) {
  console.log(`
Usage: npm run import:woo -- <dir-with-json> [options]

  --apply            Perform the import. Without this nothing is written.
  --media <dir>      After importing, ingest product images from this folder
                     (the extracted wp-content/uploads) through the media
                     pipeline and point the products at the stored copies.
  --no-posts         Shop only; leave the blog behind.
  --author <email>   File imported posts under this account.
                     Defaults to the oldest administrator.
  --site-stopped     Required with --apply on the doc-blob driver (a
                     DATABASE_URL without DATABASE_DRIVER=relational): you
                     confirm the site is not running, because on that driver
                     the two would silently overwrite each other's writes.

Importing products or orders turns the shop on if it is off. It is never
turned off — an install that is already selling stays that way.

Brands arrive as the shop spells them, in any script: a product branded
"Όψη Οπτικά" keeps that name, and its brand record gets a transliterated slug
(opsi-optika). Re-running recognises a brand by name as well as by slug, and
gives back the brand an earlier version of this importer dropped from products
whose brand had no Latin letter or digit. Nothing else an earlier run wrote is
changed, and a new product of a brand that run stored as a slug is filed under
that same slug, so the brand stays one entry.
`.trim());
  process.exit(dir ? 0 : 2);
}


const base = path.resolve(process.cwd(), dir);
async function readJson(name) {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(base, name), 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    // A missing file is normal — not every shop has brands. A CORRUPT one is
    // not, and silently treating it as empty would drop a whole entity type
    // without saying so.
    if (err?.code === 'ENOENT') {
      console.log(`  (${name} not found — skipped)`);
      return [];
    }
    console.error(`\n  ${name} is not valid JSON: ${err.message}\n`);
    process.exit(1);
  }
}

const [products, categories, brands, customers, orders, blog] = await Promise.all([
  readJson('products.json'), readJson('categories.json'), readJson('brands.json'),
  readJson('customers.json'), readJson('orders.json'), readJson('blog.json'),
]);

const { planWooImport, summariseWooPlan } = await load('src/lib/import/woo.ts', 'plan');
const plan = planWooImport({ products, categories, brands, customers, orders, blog });

console.log(`\n  ${summariseWooPlan(plan)}\n`);

if (plan.skipped.length) {
  const byReason = new Map();
  for (const s of plan.skipped) byReason.set(s.reason, (byReason.get(s.reason) ?? 0) + 1);
  console.log('  Not imported:');
  for (const [reason, n] of [...byReason].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(5)} × ${reason}`);
  }
  console.log('');
}

if (!has('--apply')) {
  console.log('  Nothing was written. Re-run with --apply to perform this import.\n');
  process.exit(0);
}

// The doc-blob driver (a DATABASE_URL without DATABASE_DRIVER=relational)
// keeps the whole site in ONE row, and every write replaces that row with the
// writing process's copy. This import writing while the site writes means
// each silently overwrites the other — no error, just products or orders
// missing afterwards. SQLite's lock used to make that collision fail loudly;
// the 5 s busy timeout (src/lib/storage/local-sqlite.ts) now makes it wait and
// succeed, so the refusal has to live here. The relational driver writes one
// row per statement and is safe beside a running site. The environment is
// read exactly as LocalDB will read it: nothing in this script or the modules
// it loads reads a .env file.
const docBlob = !!process.env.DATABASE_URL?.trim() && process.env.DATABASE_DRIVER?.trim() !== 'relational';
if (docBlob && !has('--site-stopped')) {
  console.error(`
  This install uses the doc-blob database driver (DATABASE_URL without
  DATABASE_DRIVER=relational), which stores the whole site as one row. If the
  site is running while this imports, the two silently overwrite each other's
  changes.

  Stop the site, then re-run with --site-stopped. Or move the shop to
  DATABASE_DRIVER=relational, where an import can run beside the site.
`);
  process.exit(1);
}

const { LocalDB } = await load('src/lib/localdb.ts', 'db');
const { applyWooImport } = await load('src/lib/import/woo-apply.ts', 'apply');

await LocalDB.init();

const wanted = value('--author');
const users = await LocalDB.getUsers();
const admins = users
  .filter((u) => u.role === 'admin' && u.status === 'active')
  .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
const author = wanted
  ? users.find((u) => u.email?.toLowerCase() === wanted.toLowerCase())
  : admins[0];

if (!author) {
  console.error(wanted
    ? `  No account with the email ${wanted}.\n`
    : '  This install has no active administrator to file the content under.\n');
  process.exit(1);
}

let lastLine = 0;
const result = await applyWooImport(plan, author.id, {
  dryRun: false,
  includePosts: !has('--no-posts'),
  onProgress: (done, total, label) => {
    const now = Date.now();
    if (now - lastLine < 80 && done < total) return;
    lastLine = now;
    process.stdout.write(`\r  ${done}/${total}  ${String(label).slice(0, 60).padEnd(62)}`);
  },
});
process.stdout.write('\r'.padEnd(80) + '\r');

console.log(`  Created: ${result.createdProducts} product(s), ${result.createdCategories} categor(ies), `
  + `${result.createdBrands} brand(s), ${result.createdCustomers} customer(s), `
  + `${result.createdOrders} order(s), ${result.createdPosts} post(s)`);

if (result.restoredBrands) {
  console.log(`  Restored the brand on ${result.restoredBrands} product(s) an earlier import left without one.`);
}

if (result.enabledCommerce) {
  console.log('\n  The shop was off; this import turned it on.');
}

if (result.failed.length) {
  console.log(`\n  ${result.failed.length} record(s) could not be imported:`);
  for (const f of result.failed.slice(0, 20)) console.log(`    · ${f.label} — ${f.reason}`);
  if (result.failed.length > 20) console.log(`    …and ${result.failed.length - 20} more`);
}

// ---- the media step ----
//
// Products were imported with the dump's RELATIVE image paths. Given the
// extracted uploads folder, push each file through the same ingest pipeline an
// upload uses (sniffing, EXIF strip, derivatives) and rewrite the product to
// the stored copy. Content-addressed storage makes re-running this harmless:
// identical bytes land on the identical path.
const mediaDir = value('--media');
if (mediaDir) {
  const { ingestMedia } = await load('src/lib/media/ingest.ts', 'ingest');
  const root = path.resolve(process.cwd(), mediaDir);
  let ingested = 0;
  let missing = 0;
  let rewired = 0;
  const byRel = new Map();
  for (const product of await LocalDB.getProducts()) {
    const images = product.images ?? [];
    let changed = false;
    const next = [];
    for (const img of images) {
      const src = String(img?.src ?? '');
      if (!src || src.startsWith('/uploads/') || /^[a-z][a-z0-9+.-]*:/i.test(src)) {
        next.push(img);
        continue;
      }
      let url = byRel.get(src);
      if (url === undefined) {
        const file = path.resolve(root, src);
        // The dump's rel paths were traversal-checked by the planner, but this
        // flag takes ANY directory, so check again at the point of use.
        if (!file.startsWith(root + path.sep)) { url = null; }
        else {
          try {
            const buf = await fs.readFile(file);
            const r = await ingestMedia(buf, { originalName: path.basename(src), uploadedBy: author.id });
            url = r.ok ? r.media.url : null;
            if (r.ok) ingested += 1;
          } catch { url = null; }
        }
        byRel.set(src, url);
      }
      if (url) {
        /*
         * The src changes here — a relative export path becomes a /uploads URL
         * for the same file — so a `kind` derived from the OLD path is stale.
         * Re-derive from the new one rather than carrying it over: the ingester
         * names files from the sniffed type, so the new extension is the more
         * reliable of the two.
         */
        const isVideo = /\.(mp4|webm)(?:[?#]|$)/i.test(url);
        next.push({ ...img, src: url, ...(isVideo ? { kind: 'video' } : { kind: undefined }) });
        changed = true;
      }
      else { next.push(img); missing += 1; }
    }
    if (changed) {
      await LocalDB.updateProduct(product.id, { images: next });
      rewired += 1;
    }
  }
  console.log(`  Media: ${ingested} file(s) ingested, ${rewired} product(s) repointed`
    + (missing ? `, ${missing} reference(s) had no file under ${mediaDir}` : ''));
}

console.log('\n  Done. Re-running this import is safe: already-imported records are skipped.\n');
process.exit(result.failed.length ? 1 : 0);
