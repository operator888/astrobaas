#!/usr/bin/env node
/**
 * Build dist/mail-test.mjs: the mail test, precompiled, for a built release.
 *
 *   node scripts/build-mail-test.mjs [outfile]      default: dist/mail-test.mjs
 *
 * Run by `npm run build` after `astro build` (which empties dist/ first) and so
 * by deploy.sh and the Dockerfile.
 *
 * ## Why a release needs its own copy
 *
 * `npm run mail:test` compiles the app's TypeScript mail code on the fly with
 * esbuild. A deployed release has neither the TypeScript nor esbuild: deploy.sh
 * ships dist/, package.json and a production node_modules, and nothing else. So
 * the check deploy/README.md prescribes after every deploy — "send one real
 * email, with exactly the environment the service sees" — was a
 * `Cannot find module …/scripts/mail-test.mjs` on every release built that way.
 * First run for real on a live deploy, 2026-09-18, where the
 * form-notification path had to stand in for it.
 *
 * This compiles the same logic (scripts/lib/mail-test-main.mjs) into one file
 * that needs only what a release has. Dependencies stay external
 * (`packages: 'external'`): bundling a package with a native binding — sharp,
 * libsql — breaks it. tests/email-smtp.test.mjs builds this bundle into a
 * directory with no src/ and runs the whole CLI suite against it, and holds
 * every import it makes to `dependencies`, the only packages a release installs.
 */
import { build } from 'esbuild';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { ROOT } from './lib/load-ts.mjs';

export const DEFAULT_OUTFILE = path.join(ROOT, 'dist', 'mail-test.mjs');

/** Compile the mail test to `outfile`. Returns the path written. */
export async function buildMailTest(outfile = DEFAULT_OUTFILE) {
  const main = path.join(ROOT, 'scripts', 'lib', 'mail-test-main.mjs');
  await build({
    // The launcher is the only difference from `npm run mail:test`: the same
    // `main`, called directly, because there is nothing left to compile.
    stdin: {
      contents: `import { main } from ${JSON.stringify(main)};\nprocess.exit(await main(process.argv.slice(2)));\n`,
      resolveDir: ROOT,
      sourcefile: 'mail-test.mjs',
      loader: 'js',
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    packages: 'external',
    banner: { js: '#!/usr/bin/env node\n// Built by scripts/build-mail-test.mjs from scripts/lib/mail-test-main.mjs. Do not edit.' },
    outfile,
    logLevel: 'warning',
  });
  return outfile;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const out = await buildMailTest(process.argv[2] ? path.resolve(process.argv[2]) : undefined);
  const rel = path.relative(process.cwd(), out);
  console.log(`mail test built: ${rel && !rel.startsWith('..') ? rel : out}`);
}
