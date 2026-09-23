#!/usr/bin/env node
/**
 * AstroBaaS CLI — project bootstrap for self-hosters and AI-generated apps.
 *
 *   npx astrobaas init      Scaffold a .env with a freshly generated AUTH_SECRET
 *   npx astrobaas secret    Print a fresh AUTH_SECRET (openssl rand -hex 32 equiv)
 *   npx astrobaas setup      Create/replace the admin account (interactive)
 *   npx astrobaas --help     Show this help
 *   npx astrobaas --version  Print the AstroBaaS version
 *
 * In a cloned checkout you can also run it directly:  node bin/astrobaas.mjs init
 *
 * Zero runtime dependencies — uses only Node builtins so `npx` works without an
 * install step.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { apiRequest, apiEnvelope } from './lib/api-client.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');

function readPkg() {
  try {
    return JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'));
  } catch {
    return { name: 'astrobaas', version: '0.0.0' };
  }
}

/** A cryptographically strong 64-hex secret (32 bytes) — same strength as `openssl rand -hex 32`. */
function newSecret() {
  return crypto.randomBytes(32).toString('hex');
}

const COLORS = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (COLORS ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s) => c('1', s);
const green = (s) => c('32', s);
const yellow = (s) => c('33', s);
const dim = (s) => c('2', s);

/** Minimal embedded .env template used if .env.example is absent. */
const FALLBACK_ENV = `# AstroBaaS environment. See .env.example for all options.
AUTH_SECRET=__SECRET__
# NODE_ENV=production
# SITE_URL=https://cms.example.com
# DATABASE_URL=libsql://your-db.turso.io
# DATABASE_AUTH_TOKEN=
# CORS_ORIGINS=https://my-frontend.example.com
`;

/** Insert/replace the AUTH_SECRET line in an .env body. */
function withSecret(body, secret) {
  if (/^AUTH_SECRET=.*$/m.test(body)) {
    return body.replace(/^AUTH_SECRET=.*$/m, `AUTH_SECRET=${secret}`);
  }
  return `AUTH_SECRET=${secret}\n${body}`;
}

function cmdInit(args) {
  const force = args.includes('--force') || args.includes('-f');
  const envPath = path.join(process.cwd(), '.env');

  if (fs.existsSync(envPath) && !force) {
    console.error(yellow('.env already exists.') + ' Refusing to overwrite without --force.');
    console.error(dim('To get just a fresh secret to paste in:  ') + 'npx astrobaas secret');
    process.exit(1);
  }

  // Seed from .env.example (kept in sync with documented vars) when available.
  const examplePath = path.join(pkgRoot, '.env.example');
  let template = FALLBACK_ENV;
  try {
    template = fs.readFileSync(examplePath, 'utf8');
  } catch {
    /* use fallback */
  }

  const secret = newSecret();
  const body = withSecret(template, secret);
  fs.writeFileSync(envPath, body.endsWith('\n') ? body : body + '\n');

  console.log(green('✓') + ` Wrote ${bold('.env')} with a fresh AUTH_SECRET.`);
  console.log('\nNext steps:');
  console.log('  1. ' + bold('npm install'));
  console.log('  2. ' + bold('npm run setup') + dim('    # create your admin account'));
  console.log('  3. ' + bold('npm run dev') + dim('      # then open http://localhost:4321/login'));
  console.log('\n' + dim('Production: set NODE_ENV=production and a DATABASE_URL (e.g. Turso) in .env.'));
}

function cmdSecret() {
  // Print ONLY the secret to stdout so it can be piped/captured.
  console.log(newSecret());
}

function cmdSetup(args) {
  // Delegate to the interactive admin setup script (inherits stdio for prompts).
  const script = path.join(pkgRoot, 'scripts', 'setup.mjs');
  if (!fs.existsSync(script)) {
    console.error('setup script not found. Run this inside an AstroBaaS checkout.');
    process.exit(1);
  }
  const res = spawnSync(process.execPath, [script, ...args], { stdio: 'inherit' });
  process.exit(res.status ?? 0);
}

/**
 * Validate a declarative plugin manifest before publishing/installing it.
 * Uses the SAME validator the install path uses (compiled from
 * src/core/manifest.ts), so "valid here" means "installable there".
 */
async function cmdPluginValidate(args) {
  const file = args.find((a) => !a.startsWith('-'));
  if (!file) {
    console.error('Usage: astrobaas plugin validate <manifest.json>');
    process.exit(1);
  }
  const abs = path.resolve(process.cwd(), file);
  if (!fs.existsSync(abs)) {
    console.error(`Not found: ${abs}`);
    process.exit(1);
  }

  let json;
  try {
    json = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (err) {
    console.error(`Invalid JSON: ${err.message}`);
    process.exit(1);
  }

  // Compile the TS validator on demand so the CLI and the server can never drift.
  let validateManifest, checkWebhookUrl;
  try {
    const esbuild = await import('esbuild');
    const os = await import('node:os');
    const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'astrobaas-cli-'));
    for (const [rel, out] of [
      ['src/core/manifest.ts', 'manifest.mjs'],
      ['src/lib/url-guard.ts', 'url-guard.mjs'],
    ]) {
      await esbuild.build({
        entryPoints: [path.join(pkgRoot, rel)],
        bundle: true, format: 'esm', platform: 'node', packages: 'external',
        outfile: path.join(outdir, out), logLevel: 'silent',
      });
    }
    ({ validateManifest } = await import(pathToFileURL(path.join(outdir, 'manifest.mjs')).href));
    ({ checkWebhookUrl } = await import(pathToFileURL(path.join(outdir, 'url-guard.mjs')).href));
    fs.rmSync(outdir, { recursive: true, force: true });
  } catch (err) {
    console.error(`Could not load the validator (run inside an AstroBaaS checkout): ${err.message}`);
    process.exit(1);
  }

  const res = validateManifest(json, { checkWebhookUrl });
  if (res.ok) {
    const caps = Object.keys(res.manifest.capabilities).join(', ') || 'none';
    console.log(`${bold('✓ valid')} — ${res.manifest.id}@${res.manifest.version}`);
    console.log(dim(`  capabilities: ${caps}`));
    process.exit(0);
  }
  console.error(`${bold('✗ invalid')} — ${res.errors.length} problem(s):`);
  for (const e of res.errors) console.error(`  • ${e}`);
  process.exit(1);
}

/**
 * Load the scaffolder, or explain why it is not there.
 *
 * It used to be a bare dynamic import, and `scripts/scaffold.mjs` was missing
 * from package.json's `files` — so every scaffold command failed from an
 * installed package with a module-not-found stack trace and no hint about what
 * to do. The file ships now; this is the belt to that braces, and it turns any
 * future packaging mistake into a sentence instead of a trace.
 */
async function loadScaffold() {
  const target = path.join(pkgRoot, 'scripts', 'scaffold.mjs');
  try {
    return await import(pathToFileURL(target).href);
  } catch {
    console.error(
      'This command needs the scaffolding templates, which are missing from this install.\n'
      + `  looked in: ${target}\n\n`
      + 'Run it from an AstroBaaS checkout, or reinstall the package.',
    );
    process.exit(1);
  }
}

/** Scaffold a code plugin, a declarative manifest, or a theme. */
async function cmdNew(kind, args) {
  const id = args.find((a) => !a.startsWith('-'));
  const force = args.includes('--force');
  const scaffold = await loadScaffold();

  const problem = scaffold.validateId(id);
  if (problem) {
    console.error(problem);
    process.exit(1);
  }

  let files;
  let root = process.cwd();
  if (kind === 'theme') {
    files = {
      [`src/themes/${id}/index.ts`]: scaffold.themeIndexTemplate(id),
      [`src/themes/${id}/Header.astro`]: scaffold.themeHeaderTemplate(id),
    };
  } else if (kind === 'manifest') {
    files = { [`${id}.manifest.json`]: scaffold.manifestTemplate(id) };
  } else {
    files = { [`src/plugins/${id}/index.ts`]: scaffold.codePluginTemplate(id) };
  }

  const res = scaffold.writeFiles(root, files, { force });
  if (!res.ok) {
    console.error(res.error);
    process.exit(1);
  }

  console.log(`${bold('Created')} ${Object.keys(files).length} file(s):`);
  for (const rel of Object.keys(files)) console.log(`  ${rel}`);

  if (kind === 'manifest') {
    console.log(`\n${bold('Next:')}`);
    console.log(`  npx astrobaas plugin validate ${id}.manifest.json`);
    console.log(`  ${dim('then install it from Admin → Plugins (no rebuild needed).')}`);
  } else {
    console.log(`\n${bold('Next:')}\n  ${scaffold.registrationHint(kind, id)}`);
  }
}

function cmdPlugin(args) {
  const [sub, ...rest] = args;
  if (sub === 'validate') return cmdPluginValidate(rest);
  if (sub === 'new') return cmdNew('plugin', rest);
  if (sub === 'manifest') return cmdNew('manifest', rest);
  if (sub === 'package') return cmdPluginPackage(rest);
  console.error('Usage:\n  astrobaas plugin new <id>\n  astrobaas plugin manifest <id>\n  astrobaas plugin package <id>\n  astrobaas plugin validate <manifest.json>');
  process.exit(1);
}

/**
 * Scaffold a SHIPPABLE plugin package — the out-of-tree kind a customer names
 * in ASTROBAAS_PLUGINS. Distinct from `plugin new`, which scaffolds into
 * src/plugins/ of a checkout: this one creates a standalone npm package with
 * its own build, in the CURRENT directory, because its whole point is living
 * outside the tree.
 */
async function cmdPluginPackage(args) {
  const id = args.find((a) => !a.startsWith('-'));
  const scaffold = await loadScaffold();
  const res = scaffold.scaffoldExternalPackage(id);
  if (!res.ok) {
    console.error(res.error);
    process.exit(1);
  }
  console.log(`${bold('Created')} ${id}/ — a standalone, shippable plugin package.`);
  console.log(`\n${bold('Next:')}`);
  for (const step of res.next) console.log(`  ${step}`);
  console.log(dim('\n  See PLUGIN_DEVELOPMENT.md → "External / shippable plugins".'));
}

function cmdTheme(args) {
  const [sub, ...rest] = args;
  if (sub === 'new') return cmdNew('theme', rest);
  console.error('Usage: astrobaas theme new <id>');
  process.exit(1);
}

function help() {
  const { version } = readPkg();
  console.log(`${bold('AstroBaaS')} ${dim('v' + version)} — TypeScript-native self-hostable backend

${bold('Usage:')} astrobaas <command> [options]

${bold('Commands:')}
  init [--force]   Scaffold a .env with a freshly generated AUTH_SECRET
  secret           Print a fresh AUTH_SECRET (32 bytes, hex) to stdout
  setup            Create/replace the admin account (interactive)
  plugin new <id>  Scaffold a code plugin under src/plugins/<id>/
  plugin manifest <id>
                   Scaffold a declarative plugin manifest (installable at runtime)
  plugin package <id>
                   Scaffold a standalone, shippable plugin package (npm shape)
  plugin validate <file>
                   Validate a declarative plugin manifest (same rules as install)
  theme new <id>   Scaffold a theme under src/themes/<id>/

  ${dim('These talk to a RUNNING site (set ASTROBAAS_URL and ASTROBAAS_KEY):')}
  content types    List the content types this site registers
  content list <type>
                   List the entries in a collection
  content export <type>
                   Every entry as JSON, paged to the end
  user list        List the accounts
  backup export    Write a full archive to stdout
  backup run       Run the configured off-site backup now
  clone <src> <dst>
                   Copy a whole site: download from src, restore into dst

  help             Show this help
  version          Print the version

${bold('Examples:')}
  ${dim('# In a fresh clone:')}
  npx astrobaas init && npm install && npm run setup && npm run dev

  ${dim('# Capture a secret into an existing .env:')}
  echo "AUTH_SECRET=$(npx astrobaas secret)" >> .env

  ${dim('# Against a running site:')}
  ASTROBAAS_URL=https://cms.example.gr ASTROBAAS_KEY=ab_… astrobaas content types
  astrobaas backup export > site-backup.tar.gz
`);
}


/* ------------------------------------------------------------------ *
 * Verbs that talk to a RUNNING site
 * ------------------------------------------------------------------ *
 *
 * Deliberately over the REST API rather than the database.
 *
 * A CLI that opened the store directly would be a fourth storage driver to keep
 * in step, and it would bypass every rule the routes enforce — visibility,
 * moderation, the reference check, the audit log. `wp db query` exists because
 * WordPress has one database; this has three, and the API is the thing that
 * knows about all of them.
 *
 * That means these need a site to be up and an API key to be set. The error
 * when either is missing says which.
 */

/** A short, readable line per record — a CLI is read by a person. */
function printRows(rows, columns) {
  if (rows.length === 0) {
    console.log(dim('(nothing)'));
    return;
  }
  const widths = columns.map((c) => Math.max(c.label.length, ...rows.map((r) => String(c.get(r) ?? '').length)));
  console.log(bold(columns.map((c, i) => c.label.padEnd(widths[i])).join('  ')));
  for (const r of rows) {
    console.log(columns.map((c, i) => String(c.get(r) ?? '').padEnd(widths[i])).join('  '));
  }
}

function apiOpts(args) {
  const i = args.indexOf('--base');
  return i >= 0 && args[i + 1] ? { base: args[i + 1].replace(/\/+$/, '') } : {};
}

async function withApi(what, fn) {
  try {
    await fn();
  } catch (err) {
    console.error(`${what} failed: ${err.message}`);
    if (!process.env.ASTROBAAS_KEY) {
      console.error(dim('  (no ASTROBAAS_KEY set — most of these need an API key with the right scope)'));
    }
    process.exit(1);
  }
}

/** `astrobaas content list <type>` and `astrobaas content export <type>`. */
async function cmdContent(sub, args) {
  const type = args.find((a) => !a.startsWith('-'));
  const opts = apiOpts(args);
  if (sub === 'list' || sub === 'export') {
    if (!type) {
      console.error('Usage: astrobaas content list|export <type> [--json] [--base URL]');
      process.exit(1);
    }
  }
  switch (sub) {
    case 'types':
      return withApi('Listing content types', async () => {
        const defs = await apiRequest('GET', '/api/content-types', undefined, opts);
        if (args.includes('--json')) return console.log(JSON.stringify(defs, null, 2));
        printRows(defs, [
          { label: 'NAME', get: (d) => d.name },
          { label: 'LABEL', get: (d) => d.label },
          { label: 'READ', get: (d) => d.visibility ?? 'staff' },
          { label: 'WRITE', get: (d) => d.writable ?? 'staff' },
          { label: 'FIELDS', get: (d) => (d.fields ?? []).length },
        ]);
      });
    case 'list':
      return withApi('Listing entries', async () => {
        const rows = await apiRequest('GET', `/api/content/${encodeURIComponent(type)}?limit=200`, undefined, opts);
        if (args.includes('--json')) return console.log(JSON.stringify(rows, null, 2));
        printRows(rows, [
          { label: 'ID', get: (r) => r.id },
          { label: 'CREATED', get: (r) => String(r.created_at ?? '').slice(0, 10) },
          { label: 'STATUS', get: (r) => r.data?._status ?? '—' },
        ]);
      });
    case 'export':
      // Paged to the end and printed as JSON, because "export" that silently
      // stopped at the first 200 rows would be worse than no export.
      return withApi('Exporting entries', async () => {
        const all = [];
        let offset = 0;
        for (;;) {
          const env = await apiEnvelope(
            'GET', `/api/content/${encodeURIComponent(type)}?limit=200&offset=${offset}`, undefined, opts,
          );
          const page = env.data ?? [];
          all.push(...page);
          const total = Number(env.meta?.total ?? all.length);
          offset += page.length;
          if (page.length === 0 || offset >= total) break;
        }
        console.log(JSON.stringify(all, null, 2));
      });
    default:
      console.error('Usage: astrobaas content types|list|export [<type>]');
      process.exit(1);
  }
}

/** `astrobaas user list`. */
async function cmdUser(sub, args) {
  const opts = apiOpts(args);
  if (sub !== 'list') {
    console.error('Usage: astrobaas user list [--json] [--base URL]');
    console.error(dim('  Creating and resetting accounts is `astrobaas setup` / `npm run reset-password`,'));
    console.error(dim('  which work offline against the configured store.'));
    process.exit(1);
  }
  return withApi('Listing users', async () => {
    const users = await apiRequest('GET', '/api/users', undefined, opts);
    if (args.includes('--json')) return console.log(JSON.stringify(users, null, 2));
    printRows(users, [
      { label: 'EMAIL', get: (u) => u.email },
      { label: 'ROLE', get: (u) => u.role },
      { label: 'STATUS', get: (u) => u.status },
      { label: 'LAST LOGIN', get: (u) => String(u.last_login ?? '').slice(0, 10) || '—' },
    ]);
  });
}

/**
 * `astrobaas clone <source> <target>` — move a whole site.
 *
 * Downloads the source's archive and posts it to the target, both over the same
 * REST routes the admin uses. That is the point: there is no third
 * implementation of the archive format, so a clone can only ever move what a
 * restore can read.
 *
 * TARGET FIRST in the confirmation, because this OVERWRITES the target's
 * content, and the commonest way to lose a site with a tool like this is to
 * type the two URLs the wrong way round.
 */
async function cmdClone(args) {
  const positional = args.filter((a) => !a.startsWith('-'));
  const [source, target] = positional;
  if (!source || !target) {
    console.error('Usage: astrobaas clone <source-url> <target-url> [--yes]');
    console.error(dim('  Keys: ASTROBAAS_KEY for both, or ASTROBAAS_SOURCE_KEY / ASTROBAAS_TARGET_KEY.'));
    process.exit(1);
  }
  const src = source.replace(/\/+$/, '');
  const dst = target.replace(/\/+$/, '');
  const srcKey = process.env.ASTROBAAS_SOURCE_KEY || process.env.ASTROBAAS_KEY || '';
  const dstKey = process.env.ASTROBAAS_TARGET_KEY || process.env.ASTROBAAS_KEY || '';

  if (src === dst) {
    console.error('The source and the target are the same site. Refusing.');
    process.exit(1);
  }
  if (!args.includes('--yes')) {
    console.error(`${bold('This REPLACES the content of')} ${dst}`);
    console.error(`  with a copy of ${src}`);
    console.error('\nRe-run with --yes when that is what you mean.');
    process.exit(1);
  }

  await withApi('Clone', async () => {
    process.stderr.write(`Downloading from ${src}… `);
    const got = await fetch(`${src}/api/backup/export`, {
      headers: srcKey ? { Authorization: `Bearer ${srcKey}` } : {},
    });
    if (!got.ok) throw new Error(`source returned HTTP ${got.status}`);
    const archive = await got.text();
    process.stderr.write(`${archive.length} bytes\n`);

    process.stderr.write(`Restoring into ${dst}… `);
    const put = await fetch(`${dst}/api/backup/import`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(dstKey ? { Authorization: `Bearer ${dstKey}` } : {}),
      },
      body: archive,
    });
    const body = await put.text();
    if (!put.ok) throw new Error(`target returned HTTP ${put.status}: ${body.slice(0, 200)}`);
    process.stderr.write('done\n');
    console.log(body);
  });
}

/** `astrobaas backup export > site.tar.gz`. */
async function cmdBackup(sub, args) {
  const opts = apiOpts(args);
  if (sub === 'run') {
    return withApi('Off-site backup', async () => {
      const out = await apiRequest('POST', '/api/backup/run', {}, opts);
      console.log(JSON.stringify(out, null, 2));
    });
  }
  if (sub !== 'export') {
    console.error('Usage: astrobaas backup export > archive.json');
    console.error('       astrobaas backup run');
    process.exit(1);
  }
  return withApi('Exporting a backup', async () => {
    const base = opts.base ?? (process.env.ASTROBAAS_URL || 'http://localhost:4321').replace(/\/+$/, '');
    const key = process.env.ASTROBAAS_KEY || '';
    const res = await fetch(`${base}/api/backup/export`, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // Straight to stdout as BYTES. Buffering an archive through a string would
    // corrupt it, and an operator redirecting to a file expects the file to be
    // the archive.
    if (process.stdout.isTTY) {
      console.error('Refusing to write binary to a terminal — redirect it:');
      console.error('  astrobaas backup export > site-backup.tar.gz');
      process.exit(1);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    process.stdout.write(buf);
  });
}

function main() {
  const [, , cmd, ...args] = process.argv;
  switch (cmd) {
    case 'init':
      return cmdInit(args);
    case 'secret':
      return cmdSecret();
    case 'setup':
      return cmdSetup(args);
    case 'plugin':
      return cmdPlugin(args);
    case 'content':
      return cmdContent(args[0], args.slice(1));
    case 'user':
      return cmdUser(args[0], args.slice(1));
    case 'backup':
      return cmdBackup(args[0], args.slice(1));
    case 'clone':
      return cmdClone(args);
    case 'theme':
      return cmdTheme(args);
    case 'version':
    case '--version':
    case '-v':
      return console.log(readPkg().version);
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      return help();
    default:
      console.error(`Unknown command: ${cmd}\n`);
      help();
      process.exit(1);
  }
}

main();
