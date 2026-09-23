#!/usr/bin/env node
/**
 * Packaging test: build the publishable entrypoints, then import the BUILT
 * artifacts directly (by file path — no tsconfig paths, no Vite), exactly as an
 * external `npm install astrobaas` consumer would. Proves the bundles are
 * self-contained and importable in plain Node ESM, and that .d.ts are emitted.
 *
 * Run with:  node tests/package.test.mjs
 */
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) pass++;
  else {
    fail++;
    console.error(`✗ ${name}`);
  }
}

// Build the package fresh.
execSync('node scripts/build-pkg.mjs', { cwd: root, stdio: 'inherit' });

const load = (rel) => import(pathToFileURL(path.join(root, rel)).href);

// ---- client: the key external artifact; must be fully self-contained ----
{
  const js = fs.readFileSync(path.join(root, 'pkg/client/index.js'), 'utf8');
  check('built client has NO bare/relative imports (self-contained)', !/^\s*import\s/m.test(js));

  const { createClient, AstroBaasError } = await load('pkg/client/index.js');
  check('built client exports createClient + AstroBaasError', typeof createClient === 'function' && typeof AstroBaasError === 'function');

  // Exercise it with an injected fetch — a real typed call through the bundle.
  const baas = createClient('https://api.example.com', {
    apiKey: 'abk_test',
    fetch: async (url, init) =>
      new Response(JSON.stringify({ success: true, data: [{ id: 'p1', title: 'Hi' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  });
  const posts = await baas.posts.list({ limit: 1 });
  check('built client performs a typed request + unwraps data', Array.isArray(posts) && posts[0].id === 'p1');

  let threw = null;
  const failing = createClient('https://api.example.com', {
    fetch: async () => new Response(JSON.stringify({ success: false, error: { message: 'nope', code: 'X' } }), { status: 400, headers: { 'Content-Type': 'application/json' } }),
  });
  try {
    await failing.posts.get('x');
  } catch (e) {
    threw = e;
  }
  check('built client throws AstroBaasError on failure', threw instanceof AstroBaasError && threw.status === 400);
}

// ---- core + plugins: must import without throwing in plain Node ----
{
  // Point storage at a throwaway dir so importing core (which evaluates the
  // storage selector at module load) doesn't touch the repo.
  process.env.DB_PATH = path.join(os.tmpdir(), `astrobaas-pkg-test-${process.pid}.json`);
  const core = await load('pkg/core/index.js');
  check('built core exports sanitizeHtml + ApiResponseBuilder + validate', typeof core.sanitizeHtml === 'function' && typeof core.ApiResponseBuilder === 'function' && typeof core.validate === 'function');
  check('built core exports the plugin manager + hook catalog', !!core.pluginManager && !!core.PLUGIN_HOOKS);

  const plugins = await load('pkg/plugins/index.js');
  check('built plugins exports BUNDLED_PLUGINS + ensurePluginsBootstrapped', Array.isArray(plugins.BUNDLED_PLUGINS) && typeof plugins.ensurePluginsBootstrapped === 'function');
}

// ---- type declarations emitted ----
{
  check('client .d.ts emitted', fs.existsSync(path.join(root, 'pkg/client/index.d.ts')));
  check('core .d.ts emitted', fs.existsSync(path.join(root, 'pkg/core/index.d.ts')));
  check('plugins .d.ts emitted', fs.existsSync(path.join(root, 'pkg/plugins/index.d.ts')));
}

// ---- package.json exports + files point at the built artifacts ----
{
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const e = pkg.exports || {};
  const ok = ['./core', './client', './plugins'].every(
    (k) => e[k]?.types?.startsWith('./pkg/') && e[k]?.default?.startsWith('./pkg/'),
  );
  check('exports map points at pkg/ with types + default', ok);
  check('files allowlist publishes pkg + bin', Array.isArray(pkg.files) && pkg.files.includes('pkg') && pkg.files.includes('bin'));
  check('prepublishOnly builds the package', pkg.scripts?.prepublishOnly === 'npm run build:pkg');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
