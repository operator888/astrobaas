#!/usr/bin/env node
/**
 * The plugin platform: routes, admin pages, and plugin-owned data.
 *
 * These three capabilities are what let a module be a real feature rather than
 * a filter on values core already had — and each one hands a plugin something
 * that used to be core's alone: a URL, a screen, and a table.
 *
 * So the assertions here are mostly about what a plugin must NOT be able to do:
 *
 *   1. claim a path that authenticates somebody (/api/auth/…)
 *   2. reach another plugin's data
 *   3. widen its own admin authorisation by accident
 *   4. rewrite its own schema version
 *
 * The routing SAFETY property — that a core route file always beats the
 * catch-all — is not testable here because it is Astro's, not ours. It is
 * asserted end-to-end in smoke, against a built server, by having the fixture
 * claim /api/settings/get and checking core still answers.
 *
 * Run with:  node tests/plugin-platform.test.mjs
 */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cacheDir = path.join(here, '..', 'node_modules', '.cache');
await fs.mkdir(cacheDir, { recursive: true });

async function load(rel, tag) {
  const out = path.join(cacheDir, `astrobaas-${tag}-${process.pid}.mjs`);
  await build({
    entryPoints: [path.join(here, '..', rel)],
    bundle: true, format: 'esm', platform: 'node', packages: 'external',
    outfile: out, logLevel: 'silent',
  });
  const mod = await import(pathToFileURL(out).href);
  await fs.rm(out, { force: true });
  return mod;
}

const R = await load('src/lib/plugin-platform/routes.ts', 'pp-routes');
const S = await load('src/lib/plugin-platform/store.ts', 'pp-store');
const A = await load('src/lib/plugin-platform/admin-pages.ts', 'pp-admin');

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) pass++;
  else { fail++; console.error(`✗ ${name}`); }
}

/** Swallow the registry's console.error while asserting a refusal. */
async function quietly(fn) {
  const real = console.error;
  const seen = [];
  console.error = (...a) => seen.push(a.join(' '));
  try { await fn(); } finally { console.error = real; }
  return seen;
}

const handler = async () => new Response('ok');
const route = (over = {}) => ({ method: 'GET', path: '/api/plugin/demo/things', handler, ...over });

/* ================================================================== *
 * ROUTES — path compilation
 * ================================================================== */
{
  const { compileRoutePath, matchRoute } = R;

  check('a simple path compiles', !!compileRoutePath('/api/plugin/demo/things'));
  check('a trailing slash is ignored', !!compileRoutePath('/api/plugin/demo/things/'));

  // Anything that is not a path is refused rather than coerced. A path is
  // plugin-authored input and turning it into a pattern language is how a stray
  // character becomes an accidental wildcard over the whole API.
  for (const bad of [
    '', '/', '/api', '/api/', 'api/things', '/other/things',
    '/api//double', '/api/../etc', '/api/a/../../b',
    '/api/a/*/b',            // wildcard must be last
    '/api/:1bad',            // parameter must start with a letter
    '/api/a b',              // space
    '/api/a|b', '/api/a(b)', '/api/.*',
  ]) {
    check(`path ${JSON.stringify(bad)} is refused`, compileRoutePath(bad) === null);
  }
  for (const bad of [null, undefined, 42, {}, []]) {
    check(`non-string path ${JSON.stringify(bad) ?? 'undefined'} is refused`, compileRoutePath(bad) === null);
  }

  const m = compileRoutePath('/api/plugin/demo/things/:id');
  check('a parameter is captured', matchRoute(m, '/api/plugin/demo/things/abc')?.params.id === 'abc');
  check('a parameter is URL-decoded', matchRoute(m, '/api/plugin/demo/things/a%2Fb')?.params.id === 'a/b');
  check('too few segments do not match', matchRoute(m, '/api/plugin/demo/things') === null);
  check('too many segments do not match', matchRoute(m, '/api/plugin/demo/things/a/b') === null);
  check('a different literal does not match', matchRoute(m, '/api/plugin/demo/other/abc') === null);

  const w = compileRoutePath('/api/plugin/demo/files/*');
  check('a wildcard matches a tail', matchRoute(w, '/api/plugin/demo/files/a/b/c')?.params.rest === 'a/b/c');
  check('a wildcard matches an empty tail', matchRoute(w, '/api/plugin/demo/files')?.params.rest === '');
  check('a wildcard does not match a shorter path', matchRoute(w, '/api/plugin/demo') === null);

  // A path that differs only by trailing slash must resolve the same way, or
  // access rules keyed on the path can be sidestepped by adding one.
  check('a trailing slash on the REQUEST matches too',
    matchRoute(compileRoutePath('/api/plugin/demo/x'), '/api/plugin/demo/x/') !== null);
}

/* ================================================================== *
 * ROUTES — validation and reserved namespaces
 * ================================================================== */
{
  const { validateRoute, RESERVED_API_PREFIXES } = R;

  check('a good route validates', validateRoute('demo', route()).ok);
  check('access defaults to staff', validateRoute('demo', route()).route.access === 'staff');
  check('csrf defaults to required', validateRoute('demo', route()).route.csrf === 'required');
  check('a declared access survives', validateRoute('demo', route({ access: 'public' })).route.access === 'public');
  check('an unknown access falls back to staff — never to public',
    validateRoute('demo', route({ access: 'everyone' })).route.access === 'staff');
  check('csrf exemption must be spelled exactly',
    validateRoute('demo', route({ csrf: 'no' })).route.csrf === 'required');

  check('a route with no handler is refused', !validateRoute('demo', route({ handler: undefined })).ok);
  check('a route with a non-function handler is refused', !validateRoute('demo', route({ handler: 'x' })).ok);
  for (const bad of ['get', 'HEAD', 'OPTIONS', 'TRACE', 'CONNECT', '', null]) {
    const r = validateRoute('demo', route({ method: bad }));
    // 'get' is lower-case of a supported verb and IS accepted, upper-cased.
    if (bad === 'get') check('a lower-case method is upper-cased', r.ok && r.route.method === 'GET');
    else check(`method ${JSON.stringify(bad)} is refused`, !r.ok);
  }

  // The reserved namespaces. Every one of these authenticates somebody, hands
  // out a credential, or changes who can log in.
  for (const prefix of RESERVED_API_PREFIXES) {
    const p = prefix.endsWith('/') ? `${prefix}anything` : `${prefix}/anything`;
    const r = validateRoute('demo', route({ path: p }));
    check(`the reserved prefix ${prefix} is refused`, !r.ok && r.problem.includes(prefix));
  }
  check('a refusal names the plugin', validateRoute('evil', route({ path: '/api/auth/x' })).problem.includes('evil'));
  // ...but a path that merely LOOKS like one is fine.
  check('a similar-but-different path is allowed', validateRoute('demo', route({ path: '/api/authors/list' })).ok);
}

/* ================================================================== *
 * ROUTES — widening a gate is confined to a namespace core cannot own
 *
 * The middleware decides CSRF and authentication BEFORE routing, so it asks the
 * registry about the RAW request path. A plugin declaring csrf:'exempt' on
 * /api/media/upload never serves that path — the core file wins — but the
 * middleware consulted the declaration anyway and stopped checking CSRF on
 * core's real handler. That was reproduced as a working cross-site upload.
 * ================================================================== */
{
  const { validateRoute, pluginRouteAccess, setPluginRoutes, resolvePluginRoute,
    canWidenAccess, PLUGIN_ROUTE_NAMESPACE } = R;

  const core = '/api/media/upload';
  const mine = `${PLUGIN_ROUTE_NAMESPACE}demo/upload`;

  check('the namespace is what it says', canWidenAccess(mine) && !canWidenAccess(core));

  for (const widening of [{ access: 'public' }, { csrf: 'exempt' }, { scope: 'products:write' }]) {
    const key = Object.keys(widening)[0];
    const bad = validateRoute('demo', route({ method: 'POST', path: core, ...widening }));
    check(`${key} on a CORE path is refused`, !bad.ok);
    check(`...and the refusal explains why (${key})`,
      bad.problem.includes(PLUGIN_ROUTE_NAMESPACE) && bad.problem.includes(core));
    const good = validateRoute('demo', route({ method: 'POST', path: mine, ...widening }));
    check(`${key} inside the namespace is allowed`, good.ok);
  }

  // A staff route may still claim any path: it widens nothing, because an
  // unknown /api path is already staff-gated.
  check('a STAFF route may still claim a core path', validateRoute('demo', route({ path: core })).ok);
  check('and so may an admin route',
    validateRoute('demo', route({ path: core, access: 'admin' })).ok);

  // Belt and braces: even if something got registered, the function the
  // MIDDLEWARE calls refuses to answer outside the namespace.
  setPluginRoutes([{ pluginId: 'demo', route: route({ method: 'POST', path: core }) }]);
  check('a core path IS registered for a staff route', resolvePluginRoute('POST', core) !== null);
  check('but the middleware is told nothing about it', pluginRouteAccess('POST', core) === null);
  setPluginRoutes([]);

  // A parameter in the first segment would match every namespace at once,
  // including the reserved ones the string check protects.
  const { compileRoutePath } = R;
  check('a parameter right after /api is refused', compileRoutePath('/api/:anything/me') === null);
  check('a wildcard right after /api is refused', compileRoutePath('/api/*') === null);
  check('but a parameter deeper in is fine', compileRoutePath('/api/plugin/demo/:id') !== null);
  check('a route using one is refused end-to-end',
    !validateRoute('demo', route({ path: '/api/:x/login', access: 'public' })).ok);

  // The reserved list must cover secret-minting endpoints.
  check('/api/webhooks is reserved', !validateRoute('demo', route({ path: '/api/webhooks' })).ok);
}

/* ================================================================== *
 * ROUTES — malformed input must not throw out of the MIDDLEWARE
 * ================================================================== */
{
  const { compileRoutePath, matchRoute } = R;
  const m = compileRoutePath('/api/plugin/demo/things/:id');
  const w = compileRoutePath('/api/plugin/demo/files/*');

  // decodeURIComponent('%') throws a URIError. This runs unauthenticated, in
  // the middleware, so a throw is a 500 anyone can trigger with one character.
  for (const bad of ['%', '%zz', '%e0%a4%a', '%C0%80', 'a%']) {
    let threw = false;
    let res;
    try { res = matchRoute(m, `/api/plugin/demo/things/${bad}`); } catch { threw = true; }
    check(`a parameter of "${bad}" does not throw`, !threw);
    check(`...and does not match`, res === null);

    let threw2 = false;
    try { matchRoute(w, `/api/plugin/demo/files/${bad}`); } catch { threw2 = true; }
    check(`a wildcard tail of "${bad}" does not throw`, !threw2);
  }
  // Valid encoding still works, so the guard did not disable decoding.
  check('valid percent-encoding still decodes',
    matchRoute(m, '/api/plugin/demo/things/a%20b')?.params.id === 'a b');
}

/* ================================================================== *
 * ROUTES — the registry
 * ================================================================== */
{
  const { setPluginRoutes, resolvePluginRoute, allPluginRoutes, pluginRouteAccess, pluginRouteExistsAtPath } = R;

  setPluginRoutes([
    { pluginId: 'a', route: route({ path: '/api/plugin/a/items' }) },
    { pluginId: 'a', route: route({ path: '/api/plugin/a/items/:id' }) },
    { pluginId: 'a', route: route({ method: 'POST', path: '/api/plugin/a/items', access: 'public' }) },
  ]);
  check('routes register', allPluginRoutes().length === 3);
  check('a GET resolves', resolvePluginRoute('GET', '/api/plugin/a/items')?.route.pluginId === 'a');
  check('a parameterised GET resolves', resolvePluginRoute('GET', '/api/plugin/a/items/9')?.params.id === '9');
  check('method is part of the match', resolvePluginRoute('POST', '/api/plugin/a/items')?.route.access === 'public');
  check('an unknown method on a known path does not resolve',
    resolvePluginRoute('PUT', '/api/plugin/a/items') === null);
  check('...but the path is known, so the caller can answer 405',
    pluginRouteExistsAtPath('/api/plugin/a/items') === true);
  check('an unknown path is not known', pluginRouteExistsAtPath('/api/plugin/a/nope') === false);

  // Specificity: a literal must beat a parameter regardless of declaration
  // order, or /items/summary is swallowed as an id.
  setPluginRoutes([
    { pluginId: 'a', route: route({ path: '/api/plugin/a/items/:id' }) },
    { pluginId: 'a', route: route({ path: '/api/plugin/a/items/summary' }) },
  ]);
  const summary = resolvePluginRoute('GET', '/api/plugin/a/items/summary');
  check('a literal segment beats a parameter, whatever the declaration order',
    summary !== null && summary.params.id === undefined);

  // A wildcard must always lose to anything more specific.
  setPluginRoutes([
    { pluginId: 'a', route: route({ path: '/api/plugin/a/f/*' }) },
    { pluginId: 'a', route: route({ path: '/api/plugin/a/f/exact' }) },
  ]);
  check('a wildcard loses to an exact match',
    resolvePluginRoute('GET', '/api/plugin/a/f/exact')?.matcher === undefined
    || resolvePluginRoute('GET', '/api/plugin/a/f/exact').params.rest === undefined);

  // Two plugins claiming one URL must be REFUSED, not resolved by order —
  // otherwise database row order decides who answers a live endpoint.
  {
    let kept;
    const errs = [];
    const real = console.error;
    console.error = (...a) => errs.push(a.join(' '));
    try {
      setPluginRoutes([
        { pluginId: 'first', route: route({ path: '/api/plugin/shared/x' }) },
        { pluginId: 'second', route: route({ path: '/api/plugin/shared/x' }) },
      ]);
      kept = resolvePluginRoute('GET', '/api/plugin/shared/x');
    } finally { console.error = real; }
    check('a duplicate claim keeps the FIRST registration', kept?.route.pluginId === 'first');
    check('and says so, naming both plugins',
      errs.some((e) => e.includes('second') && e.includes('first')));
  }

  // Registering replaces, so a deactivated plugin's routes really stop.
  setPluginRoutes([]);
  check('registering an empty set clears everything', allPluginRoutes().length === 0);
  check('and nothing resolves afterwards', resolvePluginRoute('GET', '/api/plugin/a/items') === null);
  check('the middleware sees nothing either', pluginRouteAccess('GET', '/api/plugin/a/items') === null);

  // What the middleware reads.
  setPluginRoutes([
    { pluginId: 'p', route: route({ method: 'POST', path: '/api/plugin/p/hook', access: 'public', csrf: 'exempt', scope: 'orders:write' }) },
  ]);
  const acc = pluginRouteAccess('POST', '/api/plugin/p/hook');
  check('the middleware can read access, csrf and scope',
    acc.access === 'public' && acc.csrf === 'exempt' && acc.scope === 'orders:write');
  check('and gets null for a path no plugin owns', pluginRouteAccess('POST', '/api/other') === null);
  setPluginRoutes([]);
}

/* ================================================================== *
 * STORE — namespacing is the isolation
 * ================================================================== */
{
  const { namespaceFor, isValidPluginId, isValidCollection, createPluginStore, PLUGIN_LIST_CAP } = S;

  check('a namespace is plugin:collection', namespaceFor('shop', 'orders') === 'shop:orders');

  // The leading-underscore rule is what stops a plugin reaching the record that
  // holds its own applied migration version.
  check('a leading underscore is refused', !isValidCollection('_meta'));
  check('and so is a double underscore', !isValidCollection('__meta'));
  check('but an underscore inside is fine', isValidCollection('order_lines'));

  for (const bad of ['', ' ', 'a b', 'a/b', 'a:b', '../x', 'x'.repeat(65), null, undefined, 42, {}]) {
    check(`collection ${JSON.stringify(bad) ?? 'undefined'} is refused`, !isValidCollection(bad));
    check(`plugin id ${JSON.stringify(bad) ?? 'undefined'} is refused`, !isValidPluginId(bad));
  }
  // Throwing rather than sanitising: a rewritten name means data written under
  // one key and read back under another.
  for (const [p, c] of [['shop', 'a/b'], ['a:b', 'orders'], ['shop', '']]) {
    let threw = false;
    try { namespaceFor(p, c); } catch { threw = true; }
    check(`namespaceFor(${JSON.stringify(p)}, ${JSON.stringify(c)}) throws`, threw);
  }

  // An in-memory backend, so the store's behaviour is testable without a DB.
  const rows = new Map();
  const backend = {
    async getPluginData(ns) { return [...rows.values()].filter((r) => r.ns === ns); },
    async getPluginDataRecord(ns, id) { return rows.get(`${ns}|${id}`); },
    async putPluginData(ns, id, data) {
      const rec = { ns, id, data, created_at: 'c', updated_at: 'u' };
      rows.set(`${ns}|${id}`, rec);
      return rec;
    },
    async deletePluginDataRecord(ns, id) { return rows.delete(`${ns}|${id}`); },
    async deletePluginData(ns) {
      let n = 0;
      const prefix = ns.includes(':') ? null : `${ns}:`;
      for (const [k, r] of [...rows]) {
        if (r.ns === ns || (prefix && r.ns.startsWith(prefix))) { rows.delete(k); n += 1; }
      }
      return n;
    },
  };

  const shop = createPluginStore('shop', backend);
  const optical = createPluginStore('optical', backend);

  await shop.put('orders', '1', { total: 100 });
  await optical.put('orders', '1', { total: 999 });
  check('two plugins may use the same collection and id', (await shop.get('orders', '1')).total === 100);
  check('and neither sees the other', (await optical.get('orders', '1')).total === 999);
  check('a list is scoped to its owner', (await shop.list('orders')).length === 1);

  await shop.put('orders', '1', { total: 150 });
  check('put replaces', (await shop.get('orders', '1')).total === 150);
  check('and does not duplicate', (await shop.list('orders')).length === 1);

  check('a missing record is undefined', (await shop.get('orders', 'nope')) === undefined);
  check('delete reports what happened', (await shop.delete('orders', '1')) === true);
  check('deleting twice reports false', (await shop.delete('orders', '1')) === false);
  check("deleting one plugin's record leaves the other's",
    (await optical.get('orders', '1')).total === 999);

  await shop.put('a', '1', {});
  await shop.put('b', '1', {});
  check('clear removes one collection only', (await shop.clear('a')) === 1);
  check('and leaves the sibling', (await shop.list('b')).length === 1);

  // A stored object must be a SNAPSHOT. The relational driver round-trips
  // through JSON, so storing a live reference would persist a later mutation on
  // the document drivers and lose it on relational — a difference between
  // drivers, which is worse than either behaviour alone. (The in-memory backend
  // here mimics the doc driver; the real assertion is the cross-driver smoke.)
  const mutable = { n: 1 };
  await shop.put('snap', '1', mutable);
  mutable.n = 99;
  const readBack = await shop.get('snap', '1');
  // `readBack.n === 1 || readBack.n === 99` is what stood here, which accepts
  // the CORRECT value and the BUGGY one and therefore asserts nothing at all —
  // it passes whether the backend snapshots or stores the live reference. An
  // assertion that cannot fail is worse than no assertion, because it reads as
  // coverage on the scoreboard.
  //
  // The contract is a SNAPSHOT, so pin it. If a future backend genuinely
  // cannot snapshot, this must fail and be argued about, not silently absorbed.
  check('a stored record is a SNAPSHOT, not the caller\'s live object', readBack.n === 1);

  let threw = false;
  try { await shop.put('orders', '', {}); } catch { threw = true; }
  check('a record with no id is refused', threw);

  check('the list cap is a real number', Number.isInteger(PLUGIN_LIST_CAP) && PLUGIN_LIST_CAP > 0);
}

/* ================================================================== *
 * STORE — per-plugin migrations
 * ================================================================== */
{
  const { createPluginStore, runPluginMigrations, appliedVersion } = S;

  const makeBackend = () => {
    const rows = new Map();
    return {
      rows,
      async getPluginData(ns) { return [...rows.values()].filter((r) => r.ns === ns); },
      async getPluginDataRecord(ns, id) { return rows.get(`${ns}|${id}`); },
      async putPluginData(ns, id, data) {
        const rec = { ns, id, data, created_at: 'c', updated_at: 'u' };
        rows.set(`${ns}|${id}`, rec);
        return rec;
      },
      async deletePluginDataRecord(ns, id) { return rows.delete(`${ns}|${id}`); },
      async deletePluginData() { return 0; },
    };
  };

  {
    const b = makeBackend();
    const store = createPluginStore('shop', b);
    const ran = [];
    const migs = [
      { version: 2, name: 'second', up: async (st) => { ran.push(2); await st.put('c', 'x', { v: 2 }); } },
      { version: 1, name: 'first', up: async (st) => { ran.push(1); await st.put('c', 'x', { v: 1 }); } },
    ];
    const out = await runPluginMigrations('shop', migs, store, b, () => {});
    check('migrations run in VERSION order, not declaration order', ran.join() === '1,2');
    check('the outcome reports the range', out.from === 0 && out.to === 2);
    check('and lists what ran', out.applied.length === 2);
    check('the later migration saw the earlier one', (await store.get('c', 'x')).v === 2);
    check('the version is stamped', (await appliedVersion('shop', b)) === 2);

    // Idempotence: running again does nothing.
    ran.length = 0;
    const again = await runPluginMigrations('shop', migs, store, b, () => {});
    check('a second run applies nothing', ran.length === 0 && again.applied.length === 0);
    check('and reports from === to', again.from === 2 && again.to === 2);
  }

  {
    // A failure must STOP, and must leave the version at the last SUCCESS —
    // carrying on would apply v3 to data v2 never transformed.
    const b = makeBackend();
    const store = createPluginStore('shop', b);
    const ran = [];
    const errs = await quietly(async () => {
      const out = await runPluginMigrations('shop', [
        { version: 1, name: 'ok', up: () => { ran.push(1); } },
        { version: 2, name: 'bad', up: () => { ran.push(2); throw new Error('nope'); } },
        { version: 3, name: 'never', up: () => { ran.push(3); } },
      ], store, b, () => {});
      check('a failing migration stops the run', ran.join() === '1,2');
      check('the version stays at the last SUCCESS', out.to === 1);
      check('and the failure is reported', out.failed?.version === 2 && out.failed.name === 'bad');
    });
    check('the failure is logged, naming the plugin and version',
      errs.some((e) => e.includes('shop') && e.includes('v2')));
    check('a later run retries from the failure', (await appliedVersion('shop', b)) === 1);
  }

  {
    // Malformed declarations are skipped, not crashed on.
    const b = makeBackend();
    const store = createPluginStore('shop', b);
    const out = await runPluginMigrations('shop', [
      { version: 0, name: 'zero', up: () => {} },
      { version: -1, name: 'neg', up: () => {} },
      { version: 1.5, name: 'float', up: () => {} },
      { version: 2, name: 'nofn' },
      null,
    ], store, b, () => {});
    check('malformed migrations are ignored without throwing', out.applied.length === 0);
  }
}

/* ================================================================== *
 * ADMIN PAGES
 * ================================================================== */
{
  const { validateAdminPage, setPluginAdminPages, resolveAdminPage, pluginAdminPageRoles,
    pluginNavFor, allPluginAdminPages, PLUGIN_ADMIN_PREFIX } = A;

  const page = (over = {}) => ({ path: 'things', title: 'Things', render: () => '<p>x</p>', ...over });

  const v = validateAdminPage('demo', page());
  check('a page validates', v.ok);
  check('and is namespaced under the plugin', v.page.href === `${PLUGIN_ADMIN_PREFIX}/demo/things`);
  // The default that makes forgetting safe.
  check('no declared roles means ADMIN ONLY', v.page.roles.join() === 'admin');
  check('declared roles survive',
    validateAdminPage('demo', page({ roles: ['admin', 'editor'] })).page.roles.length === 2);
  check('an index page has no trailing segment',
    validateAdminPage('demo', page({ path: '' })).page.href === `${PLUGIN_ADMIN_PREFIX}/demo`);

  check('a page with no render is refused', !validateAdminPage('demo', page({ render: undefined })).ok);
  check('a page with no title is refused', !validateAdminPage('demo', page({ title: '' })).ok);
  // A path is a place, not a pattern — traversal and parameters are refused.
  for (const bad of ['../escape', 'a/../b', 'a b', ':id', 'a/:id', 'a//b', 'a?b=1', '<script>']) {
    check(`admin path ${JSON.stringify(bad)} is refused`, !validateAdminPage('demo', page({ path: bad })).ok);
  }

  setPluginAdminPages([
    { pluginId: 'demo', page: page({ nav: { label: 'Things' }, roles: ['admin', 'editor'] }) },
    { pluginId: 'demo', page: page({ path: 'secret', title: 'Secret' }) },
    { pluginId: 'other', page: page({ path: 'things', title: 'Other Things', nav: { label: 'Other' } }) },
  ]);
  check('pages register', allPluginAdminPages().length === 3);
  check('a page resolves by href', resolveAdminPage(`${PLUGIN_ADMIN_PREFIX}/demo/things`)?.title === 'Things');
  check('a trailing slash still resolves', resolveAdminPage(`${PLUGIN_ADMIN_PREFIX}/demo/things/`)?.title === 'Things');
  check('two plugins may use the same page path', resolveAdminPage(`${PLUGIN_ADMIN_PREFIX}/other/things`)?.title === 'Other Things');
  check('an unknown page is null', resolveAdminPage(`${PLUGIN_ADMIN_PREFIX}/demo/nope`) === null);

  check('roles come from the page', pluginAdminPageRoles(`${PLUGIN_ADMIN_PREFIX}/demo/things`).includes('editor'));
  check('an undeclared page is admin-only', pluginAdminPageRoles(`${PLUGIN_ADMIN_PREFIX}/demo/secret`).join() === 'admin');
  // Unknown → undefined, so admin-access falls through to ITS deny-by-default
  // rather than this module inventing an answer.
  check('an unknown page yields undefined, not a default',
    pluginAdminPageRoles(`${PLUGIN_ADMIN_PREFIX}/demo/nope`) === undefined);
  check('and a CORE admin path is never answered for',
    pluginAdminPageRoles('/admin/products') === undefined);

  check('nav shows a page the role may open', pluginNavFor('editor').some((l) => l.label === 'Things'));
  check('nav hides one it may not', !pluginNavFor('editor').some((l) => l.label === 'Other'));
  check('nav is empty without a role', pluginNavFor(undefined).length === 0);
  check('a page with no nav entry is not linked', pluginNavFor('admin').every((l) => l.label !== 'Secret'));

  setPluginAdminPages([]);
  check('clearing removes every page', allPluginAdminPages().length === 0);
}

/* ---------------- a plugin reads its OWN settings ---------------- */
{
  // Before this existed, a plugin wanting the settings an operator edits on
  // its own admin screen had to call LocalDB.getPlugins() and filter — which
  // also handed it every other plugin's settings, one typo away from writing
  // them. The accessor is scoped to an id and copies what it returns.
  const records = [
    { id: 'acme', active: true, settings: { token: 'secret', retries: 3, cleared: null }, installed_at: '', updated_at: '' },
    { id: 'other', active: true, settings: { token: 'not-yours' }, installed_at: '', updated_at: '' },
  ];
  const out = path.join(cacheDir, `astrobaas-pp-settings-${process.pid}.mjs`);
  await build({
    entryPoints: [path.join(here, '..', 'src/lib/plugin-platform/settings.ts')],
    bundle: true, format: 'esm', platform: 'node', packages: 'external',
    outfile: out, logLevel: 'silent',
    // The module reads through LocalDB; the double is the seam.
    plugins: [{
      name: 'stub-localdb',
      setup(b) {
        b.onResolve({ filter: /\.\.\/localdb$/ }, () => ({ path: 'stub-localdb', namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: `export const LocalDB = { getPlugins: async () => (globalThis.__records ?? []) };`,
          loader: 'js',
        }));
      },
    }],
  });
  const P = await import(pathToFileURL(out).href);
  await fs.rm(out, { force: true });

  globalThis.__records = records;
  const own = await P.getPluginSettings('acme');
  check('a plugin reads its own settings', own.token === 'secret' && own.retries === 3);
  check('...and not its neighbour\'s', !('not-yours' in Object.values(own)) && own.token !== 'not-yours');

  own.token = 'mutated';
  const again = await P.getPluginSettings('acme');
  check('...and the returned object is a copy, not the stored one', again.token === 'secret');

  check('a plugin with no record gets {} rather than a throw',
    Object.keys(await P.getPluginSettings('missing')).length === 0);

  check('one setting with a fallback', await P.getPluginSetting('acme', 'retries', 1) === 3);
  check('...falls back when the key is absent', await P.getPluginSetting('acme', 'nope', 'dflt') === 'dflt');
  check('...and when the operator cleared the field to null',
    await P.getPluginSetting('acme', 'cleared', 'dflt') === 'dflt');

  globalThis.__records = null;   // storage unreachable → getPlugins throws on .find
  check('unreachable storage answers {} so a handler can fall back',
    Object.keys(await P.getPluginSettings('acme')).length === 0);
  delete globalThis.__records;
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
