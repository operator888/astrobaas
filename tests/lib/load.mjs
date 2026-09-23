/**
 * Compiling a TypeScript module for a test, in one place.
 *
 * Twenty-five test files each carried their own `async function load`, in
 * EIGHT variants. They differed in ways that only matter when they differ:
 * some resolved the entry point against `root`, some against `here/..`, some
 * deleted the compiled file afterwards and some left it in `node_modules/.cache`
 * to accumulate one artefact per process id, forever.
 *
 * The recon for this batch found that twenty-three of the thirty-nine remaining
 * capabilities would each have written a twenty-sixth copy. So this exists
 * before they do, and `tests/shared-lib.test.mjs` fails a NEW test file that
 * spells its own.
 *
 * Usage:
 *   import { loadTs } from './lib/load.mjs';
 *   const M = await loadTs('src/lib/thing.ts');
 *
 * The tag is optional and only affects the temporary filename — every caller
 * that passed one was doing it to avoid a collision that the process id and the
 * counter below already prevent.
 */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
/** The repo root — `tests/lib/` is two levels down, and every path is relative to it. */
export const ROOT = path.join(here, '..', '..');

const cacheDir = path.join(ROOT, 'node_modules', '.cache');
let counter = 0;

/**
 * Bundle `rel` (repo-relative, e.g. `src/lib/toc.ts`) and import it.
 *
 * `packages: 'external'` so a dependency is resolved from node_modules at run
 * time rather than inlined — bundling `sharp` or `libsql` into a test artefact
 * is both slow and wrong, because the native binding has to load itself.
 *
 * The artefact is REMOVED after import. Two of the eight variants did not, and
 * `node_modules/.cache` on this machine held one file per test run.
 */
export async function loadTs(rel, tag = '') {
  await fs.mkdir(cacheDir, { recursive: true });
  counter += 1;
  const name = tag ? `${tag}-` : '';
  const out = path.join(cacheDir, `astrobaas-${name}${process.pid}-${counter}.mjs`);
  await build({
    entryPoints: [path.join(ROOT, rel)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    packages: 'external',
    outfile: out,
    logLevel: 'silent',
  });
  try {
    return await import(pathToFileURL(out).href);
  } finally {
    await fs.rm(out, { force: true });
  }
}

/** Repo-relative path to an absolute one. Saves every caller a `path.join(root, …)`. */
export const fromRoot = (...parts) => path.join(ROOT, ...parts);

/** Read a repo file as text. The other thing every one of those files re-spelled. */
export const readRepo = (rel) => fs.readFile(path.join(ROOT, rel), 'utf8');
