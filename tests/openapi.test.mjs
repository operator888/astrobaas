#!/usr/bin/env node
/**
 * Contract test: every path + method documented in /openapi.json must resolve
 * to a real Astro route file that exports that HTTP method. Guards against the
 * hand-curated spec drifting from the actual routes (typos, renamed/removed
 * endpoints, undocumented method changes).
 *
 * Loads the spec by transpiling the route module (no server needed) and scans
 * src/pages/api for the real routes.
 *
 * Run with:  node tests/openapi.test.mjs
 */
import { transform } from 'esbuild';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const pagesDir = path.join(root, 'src', 'pages');

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) pass++;
  else {
    fail++;
    console.error(`✗ ${name}`);
  }
}

/** Transpile + import a TS module, returning its exports. */
async function load(abs) {
  const src = await fsp.readFile(abs, 'utf8');
  const { code } = await transform(src, { loader: 'ts', format: 'esm' });
  const tmp = path.join(root, 'node_modules', '.cache', `astrobaas-openapi-${process.pid}.mjs`);
  await fsp.mkdir(path.dirname(tmp), { recursive: true });
  await fsp.writeFile(tmp, code);
  const mod = await import(pathToFileURL(tmp).href);
  await fsp.rm(tmp, { force: true });
  return mod;
}

/** Normalize an OpenAPI path: `/api/posts/{ref}` → `/api/posts/{}`. */
const specToPath = (p) => p.replace(/\{[^}]+\}/g, '{}');

/** Map a route file (relative to src/pages) to its URL path with `{}` for params. */
function fileToPath(rel) {
  let p = rel.replace(/\\/g, '/').replace(/\.(ts|js|mjs)$/, '');
  p = p.replace(/\/index$/, '');
  p = '/' + p;
  p = p.replace(/\[[^\]]+\]/g, '{}');
  return p.length > 1 ? p.replace(/\/$/, '') : p;
}

/** Recursively collect *.ts route files under a directory. */
function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(abs));
    else if (/\.(ts|js)$/.test(entry.name)) out.push(abs);
  }
  return out;
}

// Build path -> Set(methods) from the real routes under src/pages/api.
const routeMap = new Map();
for (const abs of walk(path.join(pagesDir, 'api'))) {
  const rel = path.relative(pagesDir, abs);
  const urlPath = fileToPath(rel);
  const content = fs.readFileSync(abs, 'utf8');
  const methods = [...content.matchAll(/export\s+const\s+(GET|POST|PUT|PATCH|DELETE)\b/g)].map((m) => m[1]);
  const set = routeMap.get(urlPath) ?? new Set();
  methods.forEach((m) => set.add(m));
  routeMap.set(urlPath, set);
}

// Load the spec by invoking the route's GET handler.
const mod = await load(path.join(pagesDir, 'openapi.json.ts'));
const res = await mod.GET({ site: undefined, url: new URL('http://localhost/openapi.json') });
const spec = await res.json();

check('openapi.json is a 3.x spec', typeof spec.openapi === 'string' && spec.openapi.startsWith('3.'));
check('spec has at least one path', spec.paths && Object.keys(spec.paths).length > 0);

let pathCount = 0;
let methodCount = 0;
for (const [specPath, ops] of Object.entries(spec.paths)) {
  pathCount++;
  const norm = specToPath(specPath);
  const real = routeMap.get(norm);
  check(`path ${specPath} resolves to a route file (${norm})`, !!real);
  if (!real) continue;
  for (const method of Object.keys(ops)) {
    // Only HTTP verbs are method keys; skip any non-verb (none today).
    if (!/^(get|post|put|patch|delete)$/.test(method)) continue;
    methodCount++;
    check(`${method.toUpperCase()} ${specPath} is exported by the route`, real.has(method.toUpperCase()));
  }
}

// ---- the OTHER direction: every route must be DOCUMENTED ----
// Without this the spec drifts silently — routes get added and agents that
// consume /openapi.json never learn the capability exists. (That happened: 2FA,
// plugin install/registry, locales, and revisions were all missing.)
{
  // Routes intentionally absent from the public contract, with the reason.
  const UNDOCUMENTED = new Set([
    '/api/auth/logout',     // trivial companion to login
    '/api/auth/forgot',     // deliberately opaque (no account enumeration)
    '/api/auth/reset',      // token-driven, not an agent-facing capability
    '/api/posts/create',    // deprecated shim -> POST /api/posts
    '/api/posts/update',    // deprecated shim -> PUT /api/posts/{ref}
    '/api/posts/delete',    // deprecated shim -> DELETE /api/posts/{ref}
    '/api/posts/get',       // deprecated shim -> GET /api/posts
    '/api/categories/get',
    '/api/settings/get',
    '/api/themes/get',
    '/api/themes/update',
    '/api/themes/activate',
    '/api/media/get',
    '/api/media/upload',
    '/api/media/delete',
    '/api/users/update',
    '/api/backup/export',
    '/api/backup/import',
    '/api/plugins/toggle',
    // Admin-console CRUD: driven by the admin UI, not part of the headless
    // contract agents are pointed at. Documented in the admin, not the spec.
    '/api/categories/create',
    '/api/categories/update',
    '/api/categories/delete',
    '/api/users/create',
    '/api/users/get',
    '/api/users/delete',
    '/api/messages/read',
    '/api/messages/delete',
    '/api/settings/update',
    // NOT '/api/content/changes' any more: it is the revalidation feed headless
    // storefronts poll, with a paging contract (since/limit/cursor) that an
    // agent pointed at this spec needs to know. It was listed here as admin
    // CRUD, which it never was.
    '/api/webhooks/deliveries',
    '/api/webhooks/redeliver',
    '/api/keys/{}/rotate',
    // The plugin-route dispatcher, src/pages/api/[...pluginRoute].ts.
    //
    // It is a mount point, not an endpoint: what it serves is decided at
    // runtime by whichever plugins an install has active, so there is no fixed
    // contract to publish and documenting the catch-all itself would advertise
    // a path that answers 404 on a stock install. A plugin's own routes are
    // documented by the plugin.
    '/api/{}',
  ]);

  const specPaths = new Set(Object.keys(spec.paths).map(specToPath));
  const missing = [...routeMap.keys()]
    .filter((p) => !specPaths.has(p) && !UNDOCUMENTED.has(p))
    .sort();
  check(
    `every API route is documented in openapi.json${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`,
    missing.length === 0,
  );
}

check('exercised at least one path', pathCount > 0);
check('exercised at least one method', methodCount > 0);

console.log(`\n${pass} passed, ${fail} failed (checked ${pathCount} paths / ${methodCount} operations)`);
process.exit(fail === 0 ? 0 : 1);
