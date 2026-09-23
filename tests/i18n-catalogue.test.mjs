#!/usr/bin/env node
/**
 * Catalogue integrity.
 *
 * A missing translation does not throw and does not look broken — it silently
 * renders English inside an otherwise Greek screen, and nobody notices until a
 * customer does. So the invariants that keep 642 keys x 3 languages honest are
 * checked mechanically rather than by reading:
 *
 *   1. every locale has EXACTLY the same key set
 *   2. no value is empty
 *   3. every key a t() call names actually exists
 *   4. no key is declared twice across the per-surface modules
 *
 * Run with:  node tests/i18n-catalogue.test.mjs
 */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const cacheDir = path.join(root, 'node_modules', '.cache');
await fs.mkdir(cacheDir, { recursive: true });

const out = path.join(cacheDir, `astrobaas-cat-${process.pid}.mjs`);
await build({
  entryPoints: [path.join(root, 'src/locales/index.ts')],
  bundle: true, format: 'esm', platform: 'node', packages: 'external',
  outfile: out, logLevel: 'silent',
});
const { BUNDLED_CATALOGUES } = await import(pathToFileURL(out).href);
await fs.rm(out, { force: true });

let pass = 0, fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };

const LOCALES = Object.keys(BUNDLED_CATALOGUES);
check('the shipped locales are en, el, de', LOCALES.sort().join() === 'de,el,en');

/* ---------- 1. identical key sets ---------- */
{
  const base = Object.keys(BUNDLED_CATALOGUES.en).sort();
  check('the base catalogue is substantial', base.length > 400);
  for (const loc of LOCALES) {
    const keys = Object.keys(BUNDLED_CATALOGUES[loc]).sort();
    const missing = base.filter((k) => !keys.includes(k));
    const extra = keys.filter((k) => !base.includes(k));
    check(`${loc} is missing no key that en has${missing.length ? ` (${missing.slice(0, 5).join(', ')})` : ''}`,
      missing.length === 0);
    check(`${loc} has no key en lacks${extra.length ? ` (${extra.slice(0, 5).join(', ')})` : ''}`,
      extra.length === 0);
  }
}

/* ---------- 2. no empty values ---------- */
for (const loc of LOCALES) {
  const bad = Object.entries(BUNDLED_CATALOGUES[loc])
    .filter(([, v]) => typeof v !== 'string' || v.trim() === '')
    .map(([k]) => k);
  check(`${loc} has no empty or non-string value${bad.length ? ` (${bad.slice(0, 4).join(', ')})` : ''}`,
    bad.length === 0);
}

/* ---------- 3. every t() key resolves ---------- */
{
  // Walk the source for t('…') / window.t('…') / translate(locale, '…').
  const files = [];
  const walk = async (dir) => {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === 'locales') continue;
        await walk(p);
      } else if (/\.(astro|ts|tsx)$/.test(e.name)) files.push(p);
    }
  };
  await walk(path.join(root, 'src'));

  const used = new Set();
  for (const f of files) {
    const src = await fs.readFile(f, 'utf8');
    for (const m of src.matchAll(/\bt\(\s*'((?:admin|public)\.[^']+)'/g)) used.add(m[1]);
  }
  check('the source actually calls t()', used.size > 100);

  const known = new Set(Object.keys(BUNDLED_CATALOGUES.en));
  // A plural call names the STEM; the catalogue holds stem_one / stem_other.
  const resolves = (k) => known.has(k) || known.has(`${k}_one`) || known.has(`${k}_other`);
  const missing = [...used].filter((k) => !resolves(k)).sort();
  check(`every key used in src/ exists in the catalogue${missing.length ? ` (${missing.slice(0, 6).join(', ')})` : ''}`,
    missing.length === 0);
}

/* ---------- 4. no key declared twice ---------- */
{
  for (const loc of LOCALES) {
    const dir = path.join(root, 'src/locales', loc);
    const seen = new Map();
    const dupes = [];
    for (const name of await fs.readdir(dir)) {
      if (name === 'index.ts' || !name.endsWith('.ts')) continue;
      const src = await fs.readFile(path.join(dir, name), 'utf8');
      for (const m of src.matchAll(/^\s*'([^']+)':/gm)) {
        // Two modules declaring one key means the spread order silently decides
        // which wins — a change in index.ts would then move a translation.
        if (seen.has(m[1])) dupes.push(`${m[1]} (${seen.get(m[1])} + ${name})`);
        else seen.set(m[1], name);
      }
    }
    check(`${loc} declares no key in two modules${dupes.length ? ` (${dupes.slice(0, 3).join('; ')})` : ''}`,
      dupes.length === 0);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
