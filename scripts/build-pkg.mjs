#!/usr/bin/env node
/**
 * Build the publishable library entrypoints into pkg/.
 *
 * Why a dedicated build: the package `exports` (astrobaas/core, /client,
 * /plugins) point at TypeScript SOURCE for in-repo Vite/Astro use (resolved via
 * tsconfig `paths`). An EXTERNAL consumer that `npm install`s the package can't
 * transpile our .ts, so we ship built JS + .d.ts here and point the published
 * `exports` conditions at pkg/.
 *
 *   JS:    esbuild, ESM, code-split so shared internals (LocalDB, the plugin
 *          manager) are a single instance across entrypoints; node/3rd-party
 *          packages stay external (resolved from the consumer's node_modules).
 *   types: tsc --emitDeclarationOnly (tsconfig.build.json).
 *
 * Output lives in pkg/ (NOT dist/, which is the Astro app build) and is what the
 * `files` allowlist publishes.
 */
import { build } from 'esbuild';
import { execSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);

rmSync('pkg', { recursive: true, force: true });

await build({
  entryPoints: {
    'core/index': 'src/core/index.ts',
    'client/index': 'src/client/index.ts',
    'plugins/index': 'src/plugins/index.ts',
  },
  outdir: 'pkg',
  bundle: true,
  splitting: true, // dedupe shared internal modules → single LocalDB etc.
  format: 'esm',
  platform: 'node',
  target: 'node18',
  packages: 'external', // keep lowdb/@libsql/client/astrobaas-* as bare imports
  logLevel: 'warning',
});
console.log('✓ bundled JS  → pkg/{core,client,plugins}/index.js');

execSync('tsc -p tsconfig.build.json', { stdio: 'inherit' });
console.log('✓ emitted .d.ts → pkg/**/*.d.ts');
