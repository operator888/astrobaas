#!/usr/bin/env node
/**
 * Emit the static maintenance page a REVERSE PROXY serves.
 *
 * The in-app page only works while the process is running. During an actual
 * redeploy — the case this was asked for — the process is stopped and replaced,
 * so nothing the app can do will answer. That window belongs to whatever sits
 * in front, and it needs a plain HTML file on disk.
 *
 * Generated from src/lib/maintenance.ts rather than written by hand, so the
 * page a visitor sees mid-deploy is the same page they see mid-migration. Two
 * hand-maintained copies of one screen is how they drift, and the one that
 * drifts is the one nobody looks at until the day it is showing.
 *
 *   node scripts/build-maintenance-page.mjs [outfile]
 */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const outFile = process.argv[2] || path.join(root, 'public', 'maintenance.html');

const tmp = path.join(root, 'node_modules', '.cache', `maint-page-${process.pid}.mjs`);
await fs.mkdir(path.dirname(tmp), { recursive: true });
await build({
  entryPoints: [path.join(root, 'src/lib/maintenance.ts')],
  bundle: true, format: 'esm', platform: 'node', packages: 'external',
  outfile: tmp, logLevel: 'silent',
});
const { maintenanceHtml, resolveMaintenance } = await import(pathToFileURL(tmp).href);
await fs.rm(tmp, { force: true });

// No end time: a redeploy's duration is not knowable in advance, and a wrong
// "back by" is worse than none.
const state = resolveMaintenance(
  { MAINTENANCE_MODE: '1', MAINTENANCE_MESSAGE: process.env.MAINTENANCE_MESSAGE || '' },
  null,
  Date.now(),
);

await fs.mkdir(path.dirname(outFile), { recursive: true });
await fs.writeFile(outFile, maintenanceHtml(state, process.env.SITE_TITLE || 'This site'), 'utf8');
console.log(`wrote ${path.relative(root, outFile)}`);
