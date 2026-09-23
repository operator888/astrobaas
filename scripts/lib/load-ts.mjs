/**
 * Compiling project TypeScript for a maintenance script.
 *
 * The scripts run the REAL modules rather than a reimplementation — an importer
 * that re-spells the ingest rules is an importer that drifts from the upload
 * path it is meant to match — so each of them needed a way to import a `.ts`
 * file. `import-wp.mjs` and `import-woocommerce.mjs` each carried a verbatim
 * copy of this, differing only in the cache filename prefix.
 *
 * esbuild is already a dependency, so this adds nothing to the install.
 */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
/** Repo root — `scripts/lib/` is two levels down. */
export const ROOT = path.join(here, '..', '..');

let counter = 0;

/**
 * Bundle a repo-relative `.ts` entry point and import it.
 *
 * `packages: 'external'` keeps dependencies resolved from node_modules at run
 * time: bundling `sharp` or `libsql` would inline a package whose native
 * binding has to load itself.
 *
 * The compiled artefact is removed after import, in a `finally` — one of the
 * two copies this replaces left it behind whenever the import threw.
 */
export async function loadTs(entry, tag = '') {
  const cacheDir = path.join(ROOT, 'node_modules', '.cache');
  await fs.mkdir(cacheDir, { recursive: true });
  counter += 1;
  const name = tag ? `${tag}-` : '';
  const out = path.join(cacheDir, `astrobaas-cli-${name}${process.pid}-${counter}.mjs`);
  await build({
    entryPoints: [path.join(ROOT, entry)],
    bundle: true, format: 'esm', platform: 'node', packages: 'external',
    outfile: out, logLevel: 'silent',
  });
  try {
    return await import(pathToFileURL(out).href);
  } finally {
    await fs.rm(out, { force: true });
  }
}

/**
 * Bundle several entry points as ONE module, by writing a temporary barrel.
 *
 * `media-backfill.mjs` needed this and wrote its own; a second caller would
 * have written a third. The barrel is removed with the artefact.
 */
export async function loadTsBundle(reexports, tag = 'bundle') {
  const cacheDir = path.join(ROOT, 'node_modules', '.cache');
  await fs.mkdir(cacheDir, { recursive: true });
  counter += 1;
  const stem = `astrobaas-cli-${tag}-${process.pid}-${counter}`;
  const entry = path.join(cacheDir, `${stem}.ts`);
  const out = path.join(cacheDir, `${stem}.mjs`);
  await fs.writeFile(entry, reexports.join('\n') + '\n');
  try {
    await build({
      entryPoints: [entry],
      bundle: true, format: 'esm', platform: 'node', packages: 'external',
      outfile: out, logLevel: 'silent',
    });
    return await import(pathToFileURL(out).href);
  } finally {
    await fs.rm(entry, { force: true });
    await fs.rm(out, { force: true });
  }
}
