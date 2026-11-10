#!/usr/bin/env node
/**
 * The core seams the paid campaign-games module builds on:
 *
 *   1. scope grammar — named actions per resource (`game:play`,
 *      `coupons:validate`, `stats:read`), with every existing scope unchanged;
 *   2. plugin routes on a bare namespace no core file serves (`/api/game/…`);
 *   3. the client address — X-Client-IP / X-Client-UA honoured ONLY on an
 *      API-key request, and never a second notion of the real address;
 *   4. plugin-declared webhook events and `host.webhooks.emit`;
 *   5. the opt-in public order counter.
 *
 * End-to-end behaviour against the built server (the middleware's real gates,
 * delivery, the admin screen, all three storage drivers) is in tests/smoke.mjs,
 * section 8z.
 *
 * Run with:  node tests/plugin-game-seams.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadTs, ROOT } from './lib/load.mjs';

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
async function quietly(fn) {
  const real = console.error;
  const seen = [];
  console.error = (...a) => seen.push(a.join(' '));
  try { await fn(); } finally { console.error = real; }
  return seen;
}

const S = await loadTs('src/lib/api-key-scopes.ts');
const R = await loadTs('src/lib/plugin-platform/routes.ts');
const C = await loadTs('src/lib/client-address.ts');
const W = await loadTs('src/lib/plugin-platform/webhook-events.ts');
const O = await loadTs('src/lib/commerce/order-stats.ts');
const V = await loadTs('src/lib/settings-validate.ts');
const RL = await loadTs('src/lib/request-limits.ts');

/* ================================================================== *
 * 1. Scope grammar
 * ================================================================== */
console.log('scope grammar');
{
  const valid = ['game:play', 'game:*', 'coupons:validate', 'coupons:*', 'stats:read', 'stats:*'];
  for (const s of valid) check(`"${s}" is a valid scope`, S.isValidScope(s));
  const invalid = ['game:read', 'game:write', 'game:spin', 'coupons:read', 'coupons:write', 'stats:write',
    'Game:play', 'game:Play', 'game', 'game:', ':play', 'game:play ', 'games:play', 'stats:read:x'];
  for (const s of invalid) check(`"${s}" is NOT a valid scope (actions are per resource)`, !S.isValidScope(s));

  // Every existing token keeps validating — driven from the list, not retyped.
  for (const r of S.SCOPED_RESOURCES) {
    for (const a of ['read', 'write', '*']) check(`existing "${r}:${a}" still validates`, S.isValidScope(`${r}:${a}`));
    check(`a named action is not invented for "${r}" ("${r}:play")`, !S.isValidScope(`${r}:play`));
  }
  check('"*" still validates', S.isValidScope('*'));

  const overlap = Object.keys(S.NAMED_SCOPE_ACTIONS).filter((r) => S.SCOPED_RESOURCES.includes(r));
  check('named resources and read/write resources are disjoint', overlap.length === 0, overlap.join(','));
  for (const [res, actions] of Object.entries(S.NAMED_SCOPE_ACTIONS)) {
    check(`the mint hint names ${res}:<${actions.join('|')}|*>`, S.SCOPE_FORMAT_HINT.includes(`"${res}:<${[...actions, '*'].join('|')}>"`));
  }
  check('the contract names exist', S.NAMED_SCOPE_ACTIONS.game.includes('play')
    && S.NAMED_SCOPE_ACTIONS.coupons.includes('validate') && S.NAMED_SCOPE_ACTIONS.stats.includes('read'));

  // A named resource is NOT path-mapped: a game route's declared scope governs.
  check('requiredScopeFor does not path-map /api/game/*', S.requiredScopeFor('POST', '/api/game/spin') === null
    && S.requiredScopeFor('GET', '/api/game/campaigns/x') === null);
  check('GET /api/stats/orders-this-month needs stats:read', S.requiredScopeFor('GET', '/api/stats/orders-this-month') === 'stats:read');
  check('a write under /api/stats has no scope at all', S.requiredScopeFor('POST', '/api/stats/orders-this-month') === null);

  const A = S.scopedKeyAllowed;
  check('game:play key → plugin route declaring game:play', A(['game:play'], 'POST', '/api/game/spin', 'game:play'));
  check('game:* key → plugin route declaring game:play', A(['game:*'], 'POST', '/api/game/spin', 'game:play'));
  check('posts:* key is refused there', !A(['posts:*'], 'POST', '/api/game/spin', 'game:play'));
  check('game:play key on a route declaring nothing is refused', !A(['game:play'], 'POST', '/api/game/spin', undefined));
  check('game:play key cannot read orders', !A(['game:play'], 'GET', '/api/orders'));
  check('game:play key cannot loosen a CORE path by a plugin declaration', !A(['game:play'], 'POST', '/api/orders', 'game:play'));

  check('coupons:validate key may POST the quote', A(['coupons:validate'], 'POST', '/api/orders/quote'));
  check('...with a trailing slash too', A(['coupons:validate'], 'POST', '/api/orders/quote/'));
  check('coupons:* key may POST the quote', A(['coupons:*'], 'POST', '/api/orders/quote'));
  check('coupons:validate key may NOT place an order', !A(['coupons:validate'], 'POST', '/api/orders'));
  check('coupons:validate key may NOT read orders', !A(['coupons:validate'], 'GET', '/api/orders/quote'));
  check('coupons:validate key may NOT manage coupons', !A(['coupons:validate'], 'GET', '/api/coupons')
    && !A(['coupons:validate'], 'POST', '/api/coupons'));
  check('orders:write still grants the quote, as before', A(['orders:write'], 'POST', '/api/orders/quote'));
  check('the quote alternative is the only one', S.alternativeScopeFor('POST', '/api/orders') === null
    && S.alternativeScopeFor('GET', '/api/orders/quote') === null
    && S.alternativeScopeFor('POST', '/api/orders/quote') === 'coupons:validate');

  check('stats:read key reads the counter', A(['stats:read'], 'GET', '/api/stats/orders-this-month'));
  check('stats:read key cannot read posts', !A(['stats:read'], 'GET', '/api/posts/x'));
  check('posts:read key cannot read the counter as itself', !A(['posts:read'], 'GET', '/api/stats/orders-this-month'));

  // The existing contract, unchanged.
  check('unscoped keys pass everywhere, as before', A([], 'POST', '/api/game/spin') && A(undefined, 'POST', '/api/keys'));
  check('"*" passes everywhere, as before', A(['*'], 'POST', '/api/game/spin'));
  check('posts:write still allows POST /api/posts', A(['posts:write'], 'POST', '/api/posts'));
  check('posts:read still blocks POST /api/posts', !A(['posts:read'], 'POST', '/api/posts'));
  check('products:* still governs coupons', A(['products:*'], 'POST', '/api/coupons') && !A(['orders:*'], 'POST', '/api/coupons'));
  check('finance:read still reaches a finance plugin route', A(['finance:read'], 'GET', '/api/plugin/finance/x', 'finance:read'));
}

/* ================================================================== *
 * 2. Plugin routes: declared scope must be mintable; bare namespaces
 * ================================================================== */
console.log('plugin routes');
{
  const route = (o) => ({ method: 'GET', path: '/api/plugin/demo/x', handler: () => new Response('ok'), ...o });
  const v = (o) => R.validateRoute('campaign-games', route(o));

  check('scope game:play on /api/game/spin registers', v({ method: 'POST', path: '/api/game/spin', scope: 'game:play' }).ok);
  check('public GET on /api/game/campaigns/:id registers', v({ path: '/api/game/campaigns/:id', access: 'public' }).ok);
  const bad = v({ path: '/api/plugin/demo/x', scope: 'game:read' });
  check('a declared scope no key can hold (game:read) is refused', !bad.ok && /game:read/.test(bad.problem ?? ''));
  check('...naming the grammar', /game:<play\|\*>/.test(bad.problem ?? ''));
  check('a typo scope is refused too', !v({ scope: 'post:read' }).ok);

  for (const p of ['/api/orders/x', '/api/stats/x', '/api/finance/x', '/api/plugins/x', '/api/Orders/x', '/api/plugin',
    // Prefix rules in core's scope map: these are answered `products:*` by
    // core, which would override the plugin's declared scope.
    '/api/coupons-plus/x', '/api/shipping-methods2/x']) {
    check(`widening on core namespace ${p} is still refused`, !v({ path: p, access: 'public' }).ok);
  }
  check('canWidenAccess: /api/plugin/… yes', R.canWidenAccess('/api/plugin/x/y'));
  check('canWidenAccess: /api/game/… yes (no core file)', R.canWidenAccess('/api/game/spin'));
  check('canWidenAccess: /api/media/upload no', !R.canWidenAccess('/api/media/upload'));
  check('canWidenAccess: /api/MEDIA/upload no (case)', !R.canWidenAccess('/api/MEDIA/upload'));
  check('canWidenAccess: not under /api no', !R.canWidenAccess('/admin/x') && !R.canWidenAccess('/apix/game'));

  // The campaign-games package's exact route set (contract section D) registers
  // whole, and each one is what the middleware is told.
  {
    const D = [
      { method: 'GET', path: '/api/game/campaigns/:id', access: 'public' },
      { method: 'POST', path: '/api/game/spin', access: 'staff', scope: 'game:play' },
      { method: 'POST', path: '/api/game/claim', access: 'staff', scope: 'game:play' },
      { method: 'POST', path: '/api/game/verify', access: 'staff', scope: 'game:play' },
      { method: 'GET', path: '/api/game/reward/:token', access: 'staff', scope: 'game:play' },
    ];
    const logs = await quietly(() => R.setPluginRoutes(D.map((d) => ({ pluginId: 'campaign-games', route: route(d) }))));
    check('all five campaign-games routes register on bare /api/game paths', R.allPluginRoutes().length === 5 && logs.length === 0, logs.join(' | '));
    check('the bare public route is public to the middleware', R.pluginRouteAccess('GET', '/api/game/campaigns/c1')?.access === 'public');
    for (const d of D.slice(1)) {
      const p = d.path.replace(':token', 'tok');
      check(`${d.method} ${d.path} carries game:play to the middleware`, R.pluginRouteAccess(d.method, p)?.scope === 'game:play');
      check(`...and a game:play key passes, a posts:read key does not`,
        S.scopedKeyAllowed(['game:play'], d.method, p, 'game:play') && !S.scopedKeyAllowed(['posts:read'], d.method, p, 'game:play'));
    }
    // Colliding with core: never widened, never resolved for the middleware.
    const clash = await quietly(() => R.setPluginRoutes([
      { pluginId: 'campaign-games', route: route({ method: 'GET', path: '/api/orders/:id', access: 'public' }) },
      { pluginId: 'campaign-games', route: route({ method: 'POST', path: '/api/products/spin', scope: 'game:play' }) },
    ]));
    check('a public route colliding with a core path is refused', clash.some((l) => l.includes('/api/orders/:id')));
    check('a game:play route colliding with a core path is refused', clash.some((l) => l.includes('/api/products/spin')));
    check('...and neither is registered', R.allPluginRoutes().length === 0 && R.pluginRouteAccess('GET', '/api/orders/o1') === null);
    R.setPluginRoutes([]);
  }

  R.setPluginRoutes([
    { pluginId: 'campaign-games', route: route({ method: 'POST', path: '/api/game/spin', scope: 'game:play' }) },
    { pluginId: 'campaign-games', route: route({ method: 'GET', path: '/api/game/campaigns/:id', access: 'public' }) },
  ]);
  const acc = R.pluginRouteAccess('POST', '/api/game/spin');
  check('the middleware learns the game:play scope for /api/game/spin', acc?.scope === 'game:play');
  check('...and the scope gate passes a game:play key with it',
    S.scopedKeyAllowed(['game:play'], 'POST', '/api/game/spin', acc?.scope));
  check('the middleware learns /api/game/campaigns/:id is public', R.pluginRouteAccess('GET', '/api/game/campaigns/abc')?.access === 'public');
  R.setPluginRoutes([]);

  // CORE_API_NAMESPACES must equal what src/pages/api actually serves. A core
  // directory added without being listed would silently become a namespace a
  // plugin could open — this is what stops that.
  const onDisk = new Set(fs.readdirSync(path.join(ROOT, 'src/pages/api'))
    .filter((n) => !n.startsWith('['))
    .map((n) => n.replace(/\.(ts|js|mjs)$/, '')));
  const listed = new Set(R.CORE_API_NAMESPACES);
  const missing = [...onDisk].filter((n) => !listed.has(n));
  const stale = [...listed].filter((n) => !onDisk.has(n));
  check('every first-level core API name is in CORE_API_NAMESPACES', missing.length === 0, `missing: ${missing.join(', ')}`);
  check('CORE_API_NAMESPACES names nothing that is not on disk', stale.length === 0, `stale: ${stale.join(', ')}`);
  check('no dynamic route file sits at /api/ besides the plugin catch-all',
    fs.readdirSync(path.join(ROOT, 'src/pages/api')).filter((n) => n.startsWith('[')).join() === '[...pluginRoute].ts');
}

/* ================================================================== *
 * 3. The client address
 * ================================================================== */
console.log('client address');
{
  const H = (o) => new Headers(o);
  const REAL = '127.0.0.9';
  const SHOP = { 'x-client-ip': '203.0.113.7', 'x-client-ua': 'Shopper/1.0', 'user-agent': 'StorefrontServer/2' };
  const r = (headers, viaApiKey, extra = {}) =>
    C.resolveRequestClient({ headers: H(headers), viaApiKey, address: REAL, ...extra });

  const anon = r(SHOP, false);
  check('anonymous: X-Client-IP ignored', anon.ip === REAL);
  check('anonymous: X-Client-UA ignored', anon.ua === 'StorefrontServer/2');
  check('anonymous: not forwarded', anon.forwarded === false);
  // A cookie session reaches this helper with viaApiKey false — the same branch.
  const cookie = r({ ...SHOP, cookie: 'astrobaas_session=x' }, false);
  check('cookie session: headers ignored', cookie.ip === REAL && cookie.ua === 'StorefrontServer/2' && !cookie.forwarded);
  check('only a literal true counts as an API key', r(SHOP, 'true').ip === REAL && r(SHOP, 1).ip === REAL);

  const keyed = r(SHOP, true);
  check('API key: X-Client-IP used', keyed.ip === '203.0.113.7');
  check('API key: X-Client-UA used', keyed.ua === 'Shopper/1.0');
  check('API key: forwarded', keyed.forwarded === true);

  for (const junk of ['not-an-ip', '999.1.1.1', '203.0.113.7, 10.0.0.1', '203.0.113.7 10.0.0.1', '1.2.3', '', 'localhost', '::g']) {
    const g = r({ ...SHOP, 'x-client-ip': junk }, true);
    check(`API key: garbage X-Client-IP ${JSON.stringify(junk)} falls back to the real address`, g.ip === REAL);
  }
  const v6 = r({ 'x-client-ip': '2001:db8:1:2:aaaa:bbbb:cccc:dddd' }, true);
  check('API key: an IPv6 shopper is grouped to /64, the limiter\'s identity', v6.ip === '2001:db8:1:2::/64');
  check('...the same identity the limiter computes for that address', v6.ip === RL.clientIdentity('2001:db8:1:2:aaaa:bbbb:cccc:dddd'));
  const mapped = r({ 'x-client-ip': '::ffff:198.51.100.4' }, true);
  check('API key: an IPv4-mapped shopper is unwrapped', mapped.ip === '198.51.100.4');
  const noUa = r({ 'x-client-ip': '203.0.113.7', 'user-agent': 'Server/1' }, true);
  check('API key without X-Client-UA keeps the request UA', noUa.ua === 'Server/1' && noUa.forwarded === true);
  const uaOnly = r({ 'x-client-ua': 'Shopper/2' }, true);
  check('API key with only X-Client-UA: ip is the real address, forwarded', uaOnly.ip === REAL && uaOnly.ua === 'Shopper/2' && uaOnly.forwarded);

  const long = 'A'.repeat(2000);
  check('X-Client-UA is capped at 512', r({ 'x-client-ua': long }, true).ua.length === C.CLIENT_UA_MAX && C.CLIENT_UA_MAX === 512);
  check('the request UA is capped at 512 too', r({ 'user-agent': long }, false).ua.length === 512);
  check('control characters are removed from a UA', C.capUserAgent('a\r\nb\u0000c') === 'a b c');
  check('an empty UA is null', C.capUserAgent('   ') === null && C.capUserAgent(undefined) === null);

  check('no address known → ip null', C.resolveRequestClient({ headers: H({}), viaApiKey: false, address: 'unknown' }).ip === null);
  check('S3.6 forwarding of the address is reported', C.resolveRequestClient({ headers: H({}), viaApiKey: true, address: '203.0.113.9', addressForwarded: true }).forwarded === true);

  check('requestClient(locals) returns what the middleware put there',
    C.requestClient({ client: { ip: '1.2.3.4', ua: 'x', forwarded: true } }).ip === '1.2.3.4');
  const fb = C.requestClient({ ip: '5.6.7.8' });
  check('requestClient falls back to locals.ip, never forwarded', fb.ip === '5.6.7.8' && fb.forwarded === false && fb.ua === null);
  check('requestClient on nothing is all-null', C.requestClient(null).ip === null);

  // ONE notion of the real address: the middleware builds locals.client FROM
  // `ip` (the limiter's identity), never from the socket or a proxy header.
  const mw = fs.readFileSync(path.join(ROOT, 'src/middleware.ts'), 'utf8');
  const call = mw.match(/locals\.client = resolveRequestClient\(\{([\s\S]*?)\}\);/);
  check('the middleware resolves locals.client', !!call);
  check('...from `ip`, the address the rate limiter charges', /address:\s*ip,/.test(call?.[1] ?? ''));
  check('...trusting X-Client-* only for a bearer key', /viaApiKey:\s*isBearer/.test(call?.[1] ?? ''));
  check('the scope downgrade to anonymous drops the forwarded client too',
    /locals\.user = null;\s*\n[\s\S]{0,400}viaApiKey:\s*false/.test(mw));
  const src = fs.readFileSync(path.join(ROOT, 'src/lib/client-address.ts'), 'utf8');
  check('client-address reads no proxy header or socket of its own',
    !/x-forwarded-for|x-real-ip|clientAddress|TRUST_PROXY/i.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')));
  const dispatcher = fs.readFileSync(path.join(ROOT, 'src/pages/api/[...pluginRoute].ts'), 'utf8');
  check('the plugin dispatcher hands ctx.client from locals', /client:\s*requestClient\(locals\)/.test(dispatcher));
}

/* ================================================================== *
 * 4. Plugin-declared webhook events
 * ================================================================== */
console.log('plugin webhook events');
{
  check('"game.verified" is a valid plugin event', W.pluginEventNameProblem('game.verified') === null);
  for (const core of ['order.created', 'order.anything', 'coupon.redeemed', 'newsletter.subscribed', 'consent.recorded',
    'post.created', 'subscriber.confirmed', 'invoice.paid', 'customer.created', 'product.x']) {
    check(`core namespace refused: ${core}`, W.pluginEventNameProblem(core) !== null);
  }
  // Driven from WEBHOOK_EVENTS, so a core event added there is reserved at once.
  const { WEBHOOK_EVENTS } = await loadTs('src/lib/webhook-util.ts');
  const unreserved = WEBHOOK_EVENTS.filter((e) => W.pluginEventNameProblem(e) === null);
  check('every published core event is refused as a plugin event', unreserved.length === 0, unreserved.join(','));
  for (const junk of ['game', 'Game.verified', 'game.*', '*', 'game verified', 'game..x', '.game', 'game.', 'x'.repeat(70) + '.y', 42, null]) {
    check(`malformed name refused: ${JSON.stringify(junk)}`, W.pluginEventNameProblem(junk) !== null);
  }

  const logs = await quietly(() => W.setPluginWebhookEvents([
    { pluginId: 'campaign-games', events: ['game.verified', 'order.created', 'Bad Name'] },
    { pluginId: 'loyalty', events: ['loyalty.tier_changed', 'game.verified'] },
  ]));
  const listed = W.allPluginWebhookEvents();
  check('declared events are listed with their plugin',
    JSON.stringify(listed) === JSON.stringify([
      { event: 'game.verified', pluginId: 'campaign-games' },
      { event: 'loyalty.tier_changed', pluginId: 'loyalty' },
    ]), JSON.stringify(listed));
  check('a core name and a malformed name are refused loudly at boot', logs.some((l) => /order\.created/.test(l)) && logs.some((l) => /Bad Name/.test(l)));
  check('a second plugin declaring the same event is refused loudly', logs.some((l) => /already declared by "campaign-games"/.test(l)));

  const sent = [];
  const deliver = async (event, data) => { sent.push({ event, data }); };
  const emit = (who, event, data) => W.emitPluginWebhookEvent(new Set(who), event, data, deliver);
  const rejects = async (p) => { try { await p; return null; } catch (e) { return String(e.message); } };

  const payload = { email_hash: 'abc', n: 1 };
  check('a declared event is accepted', (await rejects(emit(['campaign-games'], 'game.verified', payload))) === null);
  payload.n = 2; // mutating after emit must not change what is sent
  await new Promise((r) => setImmediate(r));
  check('...and delivered through the deliverer, as a copy', sent.length === 1 && sent[0].event === 'game.verified' && sent[0].data.n === 1);
  check('an undeclared event is refused', /not declared/.test(await rejects(emit(['campaign-games'], 'game.undeclared', {})) ?? ''));
  check('a core event is refused', /core owns/.test(await rejects(emit(['campaign-games'], 'order.created', {})) ?? ''));
  check('a core-namespace event is refused even if never published', /core owns/.test(await rejects(emit(['campaign-games'], 'coupon.redeemed', {})) ?? ''));
  check("another plugin's event is refused", /belongs to plugin "loyalty"/.test(await rejects(emit(['campaign-games'], 'loyalty.tier_changed', {})) ?? ''));
  check('an unbound host (no owners) can emit nothing', /belongs to/.test(await rejects(emit([], 'game.verified', {})) ?? ''));
  const circ = {}; circ.self = circ;
  check('non-JSON data is refused', /not JSON/.test(await rejects(emit(['campaign-games'], 'game.verified', circ)) ?? ''));
  check('oversized data is refused', /larger than/.test(await rejects(emit(['campaign-games'], 'game.verified', { s: 'x'.repeat(70 * 1024) })) ?? ''));
  check('nothing refused was delivered', sent.length === 1);

  // Deactivation: the registry is rebuilt from ACTIVE plugins only.
  W.setPluginWebhookEvents([{ pluginId: 'loyalty', events: ['loyalty.tier_changed'] }]);
  check('an inactive plugin\'s event is no longer emittable', /not declared/.test(await rejects(emit(['campaign-games'], 'game.verified', {})) ?? ''));
  check('...nor listed', !W.allPluginWebhookEvents().some((e) => e.event === 'game.verified'));
  W.setPluginWebhookEvents([]);

  // Delivery reuses the core machinery: the default deliverer is the function
  // fireEvent itself delegates to — one signer, one log, one retry schedule.
  const wh = fs.readFileSync(path.join(ROOT, 'src/lib/webhooks.ts'), 'utf8');
  check('fireEvent delegates to deliverWebhookEvent', /export async function fireEvent[^{]*\{\s*return deliverWebhookEvent\(event, data, now\);\s*\}/.test(wh));
  check('deliverWebhookEvent signs and retries (signWebhook, runWithRetries, staging gate)',
    /export async function deliverWebhookEvent[\s\S]*isStagingEnv\(\)[\s\S]*runWithRetries/.test(wh) && /signWebhook\(secret, body\)/.test(wh));
  const wev = fs.readFileSync(path.join(ROOT, 'src/lib/plugin-platform/webhook-events.ts'), 'utf8');
  check('the plugin emit path uses deliverWebhookEvent', /deliverWebhookEvent\(event, data\)/.test(wev));
  const ext = fs.readFileSync(path.join(ROOT, 'src/plugins/external.ts'), 'utf8');
  check('host.webhooks.emit is bound to the module\'s own plugin ids', /emitPluginWebhookEvent\(owners, event, data\)/.test(ext)
    && /owners\.add\(pl\.id\)/.test(ext));
  const boot = fs.readFileSync(path.join(ROOT, 'src/plugins/index.ts'), 'utf8');
  check('bootstrap registers webhookEvents from ACTIVE plugins', /setPluginWebhookEvents\(\s*activePlugins\.map/.test(boot));
}

/* ================================================================== *
 * 5. The public order counter
 * ================================================================== */
console.log('public order counter');
{
  const ATHENS = 'Europe/Athens';
  // 2026-10-31T23:30Z is 01:30 on 1 November in Athens (EET, UTC+2 after the
  // 25 October DST change). 2026-11-30T22:30Z is 00:30 on 1 December there.
  const orders = [
    { created_at: '2026-10-31T21:30:00.000Z', payment_status: 'paid' }, // Oct everywhere (23:30 Athens)
    { created_at: '2026-10-31T23:30:00.000Z', payment_status: 'paid' }, // Oct UTC, NOV Athens
    { created_at: '2026-11-15T12:00:00.000Z', payment_status: 'paid' }, // Nov
    { created_at: '2026-11-15T12:00:00.000Z', payment_status: 'unpaid' }, // not counted
    { created_at: '2026-11-16T12:00:00.000Z', payment_status: 'pending' }, // not counted
    { created_at: '2026-11-17T12:00:00.000Z', payment_status: 'refunded' }, // not counted
    { created_at: '2026-11-18T12:00:00.000Z' }, // no status = unpaid
    { created_at: '2026-11-30T22:30:00.000Z', payment_status: 'paid' }, // Nov UTC, DEC Athens
    { created_at: 'not a date', payment_status: 'paid' },
  ];
  const now = Date.parse('2026-11-20T10:00:00.000Z');
  const athens = O.paidOrdersThisMonth(orders, now, ATHENS);
  check('Athens: the month is 2026-11', athens.month === '2026-11');
  check('Athens: counts the order placed at 01:30 on 1 Nov local, not the one at 00:30 on 1 Dec', athens.count === 2, JSON.stringify(athens));
  const utc = O.paidOrdersThisMonth(orders, now, 'UTC');
  check('UTC: November is the 15th and the 30th 22:30Z instead', utc.count === 2 && utc.month === '2026-11', JSON.stringify(utc));

  // The boundary itself, from both sides of it.
  const edge = [
    { created_at: '2026-10-31T12:00:00.000Z', payment_status: 'paid' },   // Oct in both
    { created_at: '2026-10-31T23:30:00.000Z', payment_status: 'paid' },   // Oct UTC, Nov Athens
    { created_at: '2026-10-31T23:40:00.000Z', payment_status: 'unpaid' }, // never
  ];
  const at = Date.parse('2026-10-31T23:45:00.000Z');
  const utcEdge = O.paidOrdersThisMonth(edge, at, 'UTC');
  const athensEdge = O.paidOrdersThisMonth(edge, at, ATHENS);
  check('at 23:45Z on 31 Oct it is October in UTC: both paid orders', utcEdge.month === '2026-10' && utcEdge.count === 2, JSON.stringify(utcEdge));
  check('...and already November in Athens: only the 23:30Z one', athensEdge.month === '2026-11' && athensEdge.count === 1, JSON.stringify(athensEdge));
  check('only paid orders count', O.paidOrdersThisMonth([{ created_at: '2026-11-02T00:00:00Z', payment_status: 'unpaid' }], now, 'UTC').count === 0);

  check('shop timezone defaults to UTC', O.resolveShopTimeZone({}) === 'UTC');
  check('an unknown zone falls back to UTC', O.resolveShopTimeZone({ shop_timezone: 'Mars/Olympus' }) === 'UTC');
  check('a real zone is used', O.resolveShopTimeZone({ shop_timezone: ' Europe/Athens ' }) === 'Europe/Athens');

  // Settings: the switch is a strict boolean, the zone is validated.
  check('the switch key is the contract name', O.PUBLIC_ORDER_STATS_KEY === 'public_order_stats_enabled');
  check('public_order_stats_enabled refuses junk', V.validateSetting(O.PUBLIC_ORDER_STATS_KEY, 'yes please') !== null);
  check('...stores "false" as false', V.normaliseSettingValue(O.PUBLIC_ORDER_STATS_KEY, 'false') === false);
  check('shop_timezone refuses an unknown zone', V.validateSetting(O.SHOP_TIMEZONE_KEY, 'Mars/Olympus') !== null);
  check('shop_timezone accepts a real zone and empty', V.validateSetting(O.SHOP_TIMEZONE_KEY, 'Europe/Athens') === null
    && V.validateSetting(O.SHOP_TIMEZONE_KEY, '') === null);

  // The route: off → 404, paid only, cacheable, never an amount.
  const route = fs.readFileSync(path.join(ROOT, 'src/pages/api/stats/orders-this-month.ts'), 'utf8');
  check('the route reads the switch through settingBool, default off', /settingBool\(settings\[PUBLIC_ORDER_STATS_KEY\], false\)/.test(route));
  check('the route answers 404 while off', /return notFound\(\)/.test(route) && /status: 404/.test(route));
  check('the route body is { count, month } only', /data: \{ count: value\.count, month: value\.month \}/.test(route));
  check('the route is cacheable for a short time', /public, max-age=\$\{CACHE_SECONDS\}/.test(route) && /CACHE_SECONDS = 60/.test(route));
  const mw = fs.readFileSync(path.join(ROOT, 'src/middleware.ts'), 'utf8');
  check('the middleware lets an anonymous caller reach it (exact path)', mw.includes('/^\\/api\\/stats\\/orders-this-month\\/?$/,'));

  // The admin setting: in the markup AND in the save list (the "renders, says
  // saved, writes nothing" shape).
  const admin = fs.readFileSync(path.join(ROOT, 'src/pages/admin/settings/index.astro'), 'utf8');
  check('admin settings show the switch', /name=\{PUBLIC_ORDER_STATS_KEY\}/.test(admin));
  check('admin settings show the timezone', /name=\{SHOP_TIMEZONE_KEY\}/.test(admin));
  check('...and both are in the commerce form\'s save list', /'public_order_stats_enabled', 'shop_timezone'\]/.test(admin));
}

/* ================================================================== *
 * Docs: every new seam is documented where an author looks.
 * ================================================================== */
console.log('docs');
{
  const doc = fs.readFileSync(path.join(ROOT, 'PLUGIN_DEVELOPMENT.md'), 'utf8');
  for (const term of ['ctx.client', 'X-Client-IP', 'webhookEvents', 'host.webhooks.emit', 'game:play', 'coupons:validate', 'stats:read']) {
    check(`PLUGIN_DEVELOPMENT.md documents ${term}`, doc.includes(term));
  }
  const openapi = fs.readFileSync(path.join(ROOT, 'src/pages/openapi.json.ts'), 'utf8');
  check('openapi lists /api/stats/orders-this-month', openapi.includes("'/api/stats/orders-this-month'"));
  const llms = fs.readFileSync(path.join(ROOT, 'src/pages/llms.txt.ts'), 'utf8');
  check('llms.txt lists /api/stats/orders-this-month', llms.includes('/api/stats/orders-this-month'));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
