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
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

/*
 * Give every relative import in the declarations the file it resolves to.
 *
 * The source imports `'../core/models'` (moduleResolution: bundler, where that
 * is fine) and tsc copies the specifier into the .d.ts as written. A consumer
 * on `moduleResolution: nodenext` — the ESM Node default — resolves types the
 * way Node resolves files, with no extension guessing, and gets TS2834 inside
 * node_modules/astrobaas. 0.1.0 shipped 116 such imports in 94 files.
 *
 * Rewritten here rather than in src/ because the app (Vite/Astro) is happy
 * without extensions and this is purely a property of the published artefact.
 * `x` → `x.js` when `x.d.ts` exists, `x/index.js` when `x/index.d.ts` does;
 * anything else is left alone and fails tests/package-types.test.mjs loudly.
 */
const SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"]*?)\2/g;
function withExtension(fromFile, spec) {
  if (/\.(js|mjs|cjs|json)$/.test(spec)) return spec;
  const base = path.resolve(path.dirname(fromFile), spec);
  if (existsSync(`${base}.d.ts`)) return `${spec}.js`;
  if (existsSync(path.join(base, 'index.d.ts'))) return `${spec}/index.js`;
  return spec;
}
let rewritten = 0;
for (const file of readdirSync('pkg', { recursive: true })) {
  if (!String(file).endsWith('.d.ts')) continue;
  const abs = path.join('pkg', String(file));
  const before = readFileSync(abs, 'utf8');
  const after = before.replace(SPECIFIER, (m, lead, q, spec) => {
    const next = withExtension(abs, spec);
    if (next !== spec) rewritten++;
    return `${lead}${q}${next}${q}`;
  });
  if (after !== before) writeFileSync(abs, after);
}
console.log(`✓ .d.ts relative imports resolved for nodenext (${rewritten} rewritten)`);
