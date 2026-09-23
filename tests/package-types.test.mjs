#!/usr/bin/env node
/**
 * The published types work for a TypeScript consumer who INSTALLED the package.
 *
 * tests/package.test.mjs imports pkg/ by file path, which proves the JS runs but
 * never type-checks anything the way a consumer does. 0.1.0 shipped 94 .d.ts
 * files whose 116 relative imports had no extension (`from '../core/models'`).
 * Under `moduleResolution: nodenext` — what `tsc --init` picks for an ESM Node
 * project — that is TS2834 inside node_modules/astrobaas, for anyone who does
 * not set skipLibCheck. Found by installing 0.1.0 from npm in a clean container.
 *
 * So: pack the real tarball (only what `files` ships), unpack it as
 * node_modules/astrobaas in an empty project, and run tsc with
 * skipLibCheck: false under both `nodenext` and `bundler` (Astro/Vite).
 * Runtime dependencies resolve through links to this repo's node_modules —
 * they are other people's packages, and the question here is only about ours.
 *
 * Needs pkg/ built — test:pkg runs tests/package.test.mjs first, which builds
 * it; run standalone, this builds it too.
 *
 * Run with:  node tests/package-types.test.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
let fail = 0;
const check = (n, c, detail = '') => {
  if (c) pass++;
  else { fail++; console.error(`✗ ${n}${detail ? `\n${detail}` : ''}`); }
};

if (!fs.existsSync(path.join(root, 'pkg/client/index.d.ts'))) {
  execFileSync(process.execPath, [path.join(root, 'scripts/build-pkg.mjs')], { cwd: root, stdio: 'inherit' });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'abtypes-'));
try {
  const tgz = execFileSync('npm', ['pack', '--ignore-scripts', '--silent', '--pack-destination', tmp], { cwd: root, encoding: 'utf8' })
    .trim().split('\n').pop();
  const consumer = path.join(tmp, 'consumer');
  const nm = path.join(consumer, 'node_modules');
  fs.mkdirSync(path.join(nm, 'astrobaas'), { recursive: true });
  execFileSync('tar', ['-xzf', path.join(tmp, tgz), '-C', path.join(nm, 'astrobaas'), '--strip-components=1']);

  // Everything else in node_modules is a dependency; link it, so the only copy
  // of astrobaas the checker can find is the unpacked tarball.
  const repoNm = path.join(root, 'node_modules');
  for (const e of fs.readdirSync(repoNm)) {
    if (e === 'astrobaas' || e === '.bin' || e.startsWith('.')) continue;
    if (e.startsWith('@')) {
      fs.mkdirSync(path.join(nm, e), { recursive: true });
      for (const s of fs.readdirSync(path.join(repoNm, e))) fs.symlinkSync(path.join(repoNm, e, s), path.join(nm, e, s));
    } else {
      fs.symlinkSync(path.join(repoNm, e), path.join(nm, e));
    }
  }

  fs.writeFileSync(path.join(consumer, 'package.json'), '{"name":"consumer","private":true,"type":"module"}');

  // A Node project using all three entrypoints (it has @types/node, as any
  // server project does), and a frontend that only talks to the API through
  // the client and has no Node types at all.
  fs.writeFileSync(path.join(consumer, 'server.ts'), `
import { createClient, AstroBaasError, type ClientOptions } from 'astrobaas/client';
import { definePlugin, type Post, type Product, type Order } from 'astrobaas/core';
import { BUNDLED_PLUGINS, reloadPlugins } from 'astrobaas/plugins';

const options: ClientOptions = { apiKey: 'abk_x' };
const client = createClient('https://cms.example.com', options);
export async function titles(): Promise<string[]> {
  const posts: Post[] = await client.posts.list({ status: 'published', limit: 10 });
  return posts.map((p) => p.title);
}
export type Shop = { product: Product; order: Order };
export const isApiError = (e: unknown): e is AstroBaasError => e instanceof AstroBaasError;
export const plugin = definePlugin;
export const bundled: number = BUNDLED_PLUGINS.length;
export const reload: () => Promise<void> = reloadPlugins;
`);
  fs.writeFileSync(path.join(consumer, 'frontend.ts'), `
import { createClient } from 'astrobaas/client';
export const client = createClient('https://cms.example.com');
export const firstTitle = async (): Promise<string | undefined> => (await client.posts.list())[0]?.title;
`);

  const tsc = path.join(repoNm, 'typescript/bin/tsc');
  const cases = [
    ['a Node project (core + client + plugins)', 'server.ts', 'nodenext', 'nodenext', ['node']],
    ['a Node project (core + client + plugins)', 'server.ts', 'bundler', 'esnext', ['node']],
    ['a frontend using only the client, no Node types', 'frontend.ts', 'bundler', 'esnext', []],
    ['a frontend using only the client, no Node types', 'frontend.ts', 'nodenext', 'nodenext', []],
  ];
  for (const [who, file, mode, moduleKind, types] of cases) {
    fs.writeFileSync(path.join(consumer, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        strict: true, noEmit: true, skipLibCheck: false, target: 'es2022', lib: ['es2022', 'dom'],
        module: moduleKind, moduleResolution: mode, types,
      },
      files: [file],
    }));
    let out = '';
    try {
      execFileSync(process.execPath, [tsc, '-p', consumer], { cwd: consumer, encoding: 'utf8', stdio: 'pipe' });
    } catch (e) {
      out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    }
    const errors = out.split('\n').filter((l) => /error TS\d+/.test(l));
    check(`${who} type-checks under moduleResolution: ${mode}`, errors.length === 0,
      errors.slice(0, 6).join('\n') + (errors.length > 6 ? `\n… ${errors.length - 6} more` : ''));
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
