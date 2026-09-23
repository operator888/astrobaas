#!/usr/bin/env node
/**
 * Uploads never ship inside the build, so the app's /uploads route — the one
 * that sets nosniff, the SVG sandbox CSP and X-Frame-Options — serves them all.
 *
 * `astro build` copied public/uploads into dist/client, and the node adapter
 * serves that copy before the app runs: on a built server an SVG uploaded
 * before the build came back with no security headers at all (reproduced
 * 2026-09-23). src/lib/strip-built-uploads.ts removes the copy after each build.
 *
 * Run with:  node tests/build-uploads.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadTs, readRepo } from './lib/load.mjs';

let pass = 0;
let fail = 0;
const check = (n, c, detail = '') => {
  if (c) pass++;
  else { fail++; console.error(`✗ ${n}${detail ? `\n    ${detail}` : ''}`); }
};

const { stripBuiltUploads, stripBuiltUploadsIntegration } = await loadTs('src/lib/strip-built-uploads.ts');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'abbuild-'));
try {
  const up = path.join(tmp, 'uploads');
  fs.mkdirSync(path.join(up, '2026', '09'), { recursive: true });
  fs.writeFileSync(path.join(up, '.gitkeep'), '');
  fs.writeFileSync(path.join(up, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  fs.writeFileSync(path.join(up, '2026', '09', 'photo.webp'), 'x');
  fs.writeFileSync(path.join(tmp, 'favicon.ico'), 'x');

  const removed = stripBuiltUploads(tmp).sort();
  check('every upload in the build output is removed, nested ones too', JSON.stringify(removed) === '["2026","logo.svg"]', JSON.stringify(removed));
  check('.gitkeep stays', fs.existsSync(path.join(up, '.gitkeep')));
  check('nothing outside uploads/ is touched', fs.existsSync(path.join(tmp, 'favicon.ico')));
  check('a build with no uploads directory is fine', JSON.stringify(stripBuiltUploads(path.join(tmp, 'nope'))) === '[]');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

const integration = stripBuiltUploadsIntegration();
check('it runs after the build', typeof integration.hooks['astro:build:done'] === 'function');
const config = await readRepo('astro.config.ts');
check('astro.config.ts registers it — without that, the copy ships',
  /integrations:\s*\[[^\]]*stripBuiltUploadsIntegration\(\)/.test(config));

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
