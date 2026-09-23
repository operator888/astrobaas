#!/usr/bin/env node
/**
 * `astro dev`, with the .env file actually loaded.
 *
 * Astro exposes .env through `import.meta.env`, and this codebase reads its
 * configuration from `process.env` — deliberately, because the same modules run
 * in the CLI, the scheduler and the test harness, none of which have Vite. The
 * consequence is that `SITE_LOCALES` in a .env file does nothing under
 * `astro dev`, and a developer testing multilingual behaviour locally gets a
 * single-locale install with no error to explain it.
 *
 * That cost this project an hour of a review pass: /de/blog 404'd, /ar/blog
 * 404'd, and the RTL work looked broken when it was the environment that was
 * empty.
 *
 *   node scripts/dev.mjs            loads .env.local then .env
 *   node scripts/dev.mjs --port 5000
 *
 * Existing process env always wins, so `SITE_LOCALES=en node scripts/dev.mjs`
 * still does what it says.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Minimal .env reader: KEY=value, `export` allowed, # comments, optional quotes. */
function loadEnvFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return 0; }
  let count = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    // Already set wins: an explicit `FOO=bar node scripts/dev.mjs` must not be
    // overridden by a file the developer forgot they had.
    if (key in process.env) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
    count += 1;
  }
  return count;
}

// .env.local first: it is the one a developer edits and the one .gitignore
// already covers, so it must win over a committed .env.
const local = loadEnvFile(path.join(ROOT, '.env.local'));
const base = loadEnvFile(path.join(ROOT, '.env'));
if (local || base) {
  console.log(`[dev] loaded ${local} from .env.local, ${base} from .env`);
  if (process.env.SITE_LOCALES) console.log(`[dev] locales: ${process.env.SITE_LOCALES}`);
}

const child = spawn(
  process.execPath,
  [path.join(ROOT, 'node_modules/astro/bin/astro.mjs'), 'dev', ...process.argv.slice(2)],
  { stdio: 'inherit', env: process.env, cwd: ROOT },
);
child.on('exit', (code) => process.exit(code ?? 0));
