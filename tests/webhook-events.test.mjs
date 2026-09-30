#!/usr/bin/env node
/**
 * The published webhook event list is exactly the events the core fires.
 *
 * `WEBHOOK_EVENTS` (src/lib/webhook-util.ts) is what operators and plugin
 * manifests subscribe from. It had drifted both ways: it offered
 * `order.updated`, which nothing ever sent, so a subscription to it waited
 * forever; and it left out `content.submitted`, which fires on every public
 * form submission and is the event a notification integration wants.
 *
 * List-free on purpose: it scans every `fireEvent('…')` call in src/, so a new
 * event cannot ship without being published, and a published one cannot lose
 * its sender unnoticed.
 *
 * Run with:  node tests/webhook-events.test.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTs } from './lib/load.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { WEBHOOK_EVENTS } = await loadTs('src/lib/webhook-util.ts');

async function walk(dir) {
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(p));
    else if (/\.(ts|mjs|js|astro)$/.test(e.name)) out.push(p);
  }
  return out;
}

const fired = new Map(); // event -> first file that fires it
const dynamic = [];
for (const file of await walk(path.join(ROOT, 'src'))) {
  const src = await fs.readFile(file, 'utf8');
  for (const m of src.matchAll(/\bfireEvent\(\s*(['"`])([^'"`]*)\1/g)) {
    if (m[1] === '`' && m[2].includes('${')) { dynamic.push(path.relative(ROOT, file)); continue; }
    if (!fired.has(m[2])) fired.set(m[2], path.relative(ROOT, file));
  }
  // A call whose event is a variable cannot be checked here; it must be rare
  // enough to look at by hand.
  for (const m of src.matchAll(/\bfireEvent\(\s*(?!['"`])([A-Za-z_$][\w$.]*)/g)) {
    if (!/function\s+fireEvent|export\s*\{[^}]*fireEvent/.test(src.slice(Math.max(0, m.index - 40), m.index + 20))) {
      dynamic.push(`${path.relative(ROOT, file)} (${m[1]})`);
    }
  }
}

let failed = 0;
const ok = (msg) => console.log(`  ✓ ${msg}`);
const fail = (msg) => { failed++; console.log(`  ✗ ${msg}`); };

const published = new Set(WEBHOOK_EVENTS);
const unpublished = [...fired.keys()].filter((e) => !published.has(e));
const unsent = [...published].filter((e) => !fired.has(e));

unpublished.length
  ? fail(`fired but not in WEBHOOK_EVENTS: ${unpublished.map((e) => `${e} (${fired.get(e)})`).join(', ')}`)
  : ok(`every fired event is published (${fired.size})`);
unsent.length
  ? fail(`in WEBHOOK_EVENTS but never fired: ${unsent.join(', ')}; a subscription to it would wait forever`)
  : ok(`every published event has a sender (${published.size})`);
dynamic.length
  ? fail(`fireEvent with a computed event name, which this check cannot see: ${[...new Set(dynamic)].join(', ')}`)
  : ok('every fireEvent names its event literally');

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
