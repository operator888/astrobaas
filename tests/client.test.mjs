#!/usr/bin/env node
/**
 * Unit tests for the `astrobaas/client` SDK (src/client/index.ts).
 *
 * Uses an injected mock fetch (no live server) to assert the SDK builds the
 * right request — URL, method, Authorization header, query string, JSON body —
 * and correctly unwraps the {success,data} envelope / throws AstroBaasError on
 * failure. Live end-to-end wiring is covered separately in smoke.mjs.
 *
 * Transpiled in-process with esbuild (same approach as lib.test.mjs).
 *
 * Run with:  node tests/client.test.mjs
 */
import { transform } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cacheDir = path.join(here, '..', 'node_modules', '.cache');
await fs.mkdir(cacheDir, { recursive: true });

async function load(rel) {
  const src = await fs.readFile(path.join(here, '..', rel), 'utf8');
  // Strip the type-only import from core/models so esbuild needn't resolve it.
  const { code } = await transform(src, { loader: 'ts', format: 'esm' });
  const tmp = path.join(cacheDir, `astrobaas-${path.basename(rel)}-${process.pid}.mjs`);
  await fs.writeFile(tmp, code);
  const mod = await import(pathToFileURL(tmp).href);
  await fs.rm(tmp, { force: true });
  return mod;
}

const { createClient, AstroBaasError } = await load('src/client/index.ts');

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) pass++;
  else {
    fail++;
    console.error(`✗ ${name}`);
  }
}

/** Build a mock fetch that records calls and returns a scripted JSON Response. */
function mockFetch(scripted) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init });
    const next = typeof scripted === 'function' ? scripted(url, init) : scripted;
    const { status = 200, body = { success: true, data: null } } = next ?? {};
    return new Response(body === null ? '' : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  fn.calls = calls;
  return fn;
}

// ---- baseUrl normalization + no key → no Authorization ----
{
  const f = mockFetch({ status: 200, body: { success: true, data: [] } });
  const baas = createClient('https://api.example.com/', { fetch: f });
  await baas.posts.list();
  const { url, init } = f.calls[0];
  check('trims trailing slash on baseUrl', url === 'https://api.example.com/api/posts');
  check('no Authorization header without an apiKey', !('Authorization' in (init.headers ?? {})));
  check('GET method for posts.list', init.method === 'GET');
  check('Accept: application/json set', (init.headers ?? {}).Accept === 'application/json');
}

// ---- apiKey → bearer header ----
{
  const f = mockFetch({ status: 200, body: { success: true, data: [] } });
  const baas = createClient('https://api.example.com', { fetch: f, apiKey: 'abk_secret' });
  await baas.posts.list();
  check('sends Authorization: Bearer <key>', f.calls[0].init.headers.Authorization === 'Bearer abk_secret');
}

// ---- posts.list query string ----
{
  const f = mockFetch({ status: 200, body: { success: true, data: [] } });
  const baas = createClient('https://api.example.com', { fetch: f });
  await baas.posts.list({ status: 'published', category: 'c1', limit: 5 });
  const u = new URL(f.calls[0].url);
  check('posts.list builds status query', u.searchParams.get('status') === 'published');
  check('posts.list builds category query', u.searchParams.get('category') === 'c1');
  check('posts.list builds limit query', u.searchParams.get('limit') === '5');
}

// ---- posts.list with no options → bare path (no trailing ?) ----
{
  const f = mockFetch({ status: 200, body: { success: true, data: [] } });
  const baas = createClient('https://api.example.com', { fetch: f });
  await baas.posts.list();
  check('posts.list omits empty query string', f.calls[0].url === 'https://api.example.com/api/posts');
}

// ---- posts.list/page build offset+page query + posts.page returns a Page ----
{
  const f = mockFetch({
    status: 200,
    body: { success: true, data: [{ id: 'p5' }, { id: 'p6' }], meta: { total: 10, count: 2, limit: 2, offset: 4, page: 3, hasMore: true } },
  });
  const baas = createClient('https://api.example.com', { fetch: f });
  await baas.posts.list({ limit: 2, offset: 4, page: 3 });
  const u = new URL(f.calls[0].url);
  check('posts.list builds offset query', u.searchParams.get('offset') === '4');
  check('posts.list builds page query', u.searchParams.get('page') === '3');

  const pg = await baas.posts.page({ limit: 2, page: 3 });
  check('posts.page returns items', Array.isArray(pg.items) && pg.items[0].id === 'p5');
  check('posts.page surfaces pagination meta', pg.total === 10 && pg.hasMore === true && pg.page === 3 && pg.offset === 4);
}

// ---- posts.page falls back gracefully when the server omits meta ----
{
  const f = mockFetch({ status: 200, body: { success: true, data: [{ id: 'x' }] } });
  const baas = createClient('https://api.example.com', { fetch: f });
  const pg = await baas.posts.page();
  check('posts.page falls back to items length when meta absent', pg.total === 1 && pg.hasMore === false && pg.limit === null);
}

// ---- content(type).page paginates ----
{
  const f = mockFetch({ status: 200, body: { success: true, data: [{ id: 'e1' }], meta: { total: 3, count: 1, limit: 1, offset: 2, page: 3, hasMore: false } } });
  const baas = createClient('https://api.example.com', { fetch: f, apiKey: 'abk_x' });
  const pg = await baas.content('product').page({ limit: 1, offset: 2 });
  check('content().page → GET with pagination query', /\/api\/content\/product\?/.test(f.calls[0].url));
  check('content().page returns a Page with meta', pg.total === 3 && pg.items[0].id === 'e1' && pg.offset === 2);
}

// ---- listAll auto-paginates ----
{
  let calls = 0;
  const f = async (url) => {
    calls++;
    const offset = Number(new URL(url).searchParams.get('offset') || 0);
    const data = offset === 0 ? [{ id: 'a' }, { id: 'b' }] : [{ id: 'c' }];
    const hasMore = offset === 0;
    return new Response(JSON.stringify({ success: true, data, meta: { total: 3, count: data.length, limit: 100, offset, page: 1, hasMore } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const baas = createClient('https://api.example.com', { fetch: f });
  const all = await baas.posts.listAll();
  check('posts.listAll walks every page', all.map((p) => p.id).join('') === 'abc' && calls === 2);
}

// ---- retry on 5xx then succeed ----
{
  let n = 0;
  const f = async () => {
    n++;
    const ok = n >= 3;
    return new Response(JSON.stringify(ok ? { success: true, data: [] } : { success: false, error: { message: 'busy' } }), { status: ok ? 200 : 503, headers: { 'Content-Type': 'application/json' } });
  };
  const baas = createClient('https://api.example.com', { fetch: f, retries: 3, retryBackoffMs: 1 });
  await baas.posts.list();
  check('retries 5xx until success', n === 3);
}

// ---- retry on 429 honoring Retry-After ----
{
  let n = 0;
  const f = async () => {
    n++;
    return n === 1
      ? new Response('{}', { status: 429, headers: { 'Retry-After': '0' } })
      : new Response(JSON.stringify({ success: true, data: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const baas = createClient('https://api.example.com', { fetch: f, retries: 2, retryBackoffMs: 1 });
  await baas.posts.list();
  check('retries 429 (Retry-After) then succeeds', n === 2);
}

// ---- no retries by default → throws on first 5xx ----
{
  let n = 0;
  const f = async () => {
    n++;
    return new Response('{}', { status: 503 });
  };
  const baas = createClient('https://api.example.com', { fetch: f });
  let thrown = null;
  try {
    await baas.posts.list();
  } catch (e) {
    thrown = e;
  }
  check('no retries by default (1 call, throws 503)', n === 1 && thrown instanceof AstroBaasError && thrown.status === 503);
}

// ---- timeoutMs aborts → AstroBaasError(TIMEOUT) ----
{
  const slow = (url, init) =>
    new Promise((_resolve, reject) => {
      if (init.signal) init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
  const baas = createClient('https://api.example.com', { fetch: slow, timeoutMs: 30 });
  let thrown = null;
  try {
    await baas.posts.list();
  } catch (e) {
    thrown = e;
  }
  check('timeoutMs aborts with AstroBaasError(TIMEOUT)', thrown instanceof AstroBaasError && thrown.code === 'TIMEOUT');
}

// ---- posts.get unwraps data and encodes slug ----
{
  const f = mockFetch({ status: 200, body: { success: true, data: { id: 'p1', slug: 'a b', title: 'Hi' } } });
  const baas = createClient('https://api.example.com', { fetch: f });
  const post = await baas.posts.get('a b');
  check('posts.get encodes the slug', f.calls[0].url.endsWith('/api/posts/a%20b'));
  check('posts.get unwraps envelope data', post.id === 'p1' && post.title === 'Hi');
}

// ---- posts.create sends JSON body + Content-Type ----
{
  const f = mockFetch({ status: 201, body: { success: true, data: { id: 'new', title: 'T' } } });
  const baas = createClient('https://api.example.com', { fetch: f, apiKey: 'abk_x' });
  const created = await baas.posts.create({ title: 'T' });
  const { init } = f.calls[0];
  check('posts.create uses POST', init.method === 'POST');
  check('posts.create sets Content-Type', init.headers['Content-Type'] === 'application/json');
  check('posts.create serializes body', JSON.parse(init.body).title === 'T');
  check('posts.create returns created entity', created.id === 'new');
}

// ---- posts.update / posts.remove hit the RESTful {ref} path ----
{
  const f = mockFetch({ status: 200, body: { success: true, data: { id: 'p1', title: 'Edited' } } });
  const baas = createClient('https://api.example.com', { fetch: f, apiKey: 'abk_x' });
  const updated = await baas.posts.update('hello world', { title: 'Edited', status: 'published' });
  const u = f.calls[0];
  check('posts.update uses PUT /api/posts/{ref}', u.init.method === 'PUT' && u.url.endsWith('/api/posts/hello%20world'));
  check('posts.update serializes the partial body', JSON.parse(u.init.body).status === 'published');
  check('posts.update returns the updated entity', updated.title === 'Edited');
  await baas.posts.remove('p1');
  check('posts.remove uses DELETE /api/posts/{ref}', f.calls[1].init.method === 'DELETE' && f.calls[1].url.endsWith('/api/posts/p1'));
}

// ---- content(type) CRUD path building ----
{
  const f = mockFetch({ status: 200, body: { success: true, data: [] } });
  const baas = createClient('https://api.example.com', { fetch: f, apiKey: 'abk_x' });
  const products = baas.content('product');
  await products.list();
  check('content().list → GET /api/content/<type>', f.calls[0].url === 'https://api.example.com/api/content/product' && f.calls[0].init.method === 'GET');
  await products.create({ name: 'Widget', price: 9 });
  check('content().create → POST collection', f.calls[1].init.method === 'POST' && JSON.parse(f.calls[1].init.body).name === 'Widget');
  await products.update('id9', { name: 'W2', price: 10 });
  check('content().update → PUT /<type>/<id>', f.calls[2].url.endsWith('/api/content/product/id9') && f.calls[2].init.method === 'PUT');
  await products.remove('id9');
  check('content().remove → DELETE /<type>/<id>', f.calls[3].url.endsWith('/api/content/product/id9') && f.calls[3].init.method === 'DELETE');
}

// ---- keys + auth namespaces ----
{
  const f = mockFetch((url) => {
    if (url.endsWith('/api/auth/me')) return { status: 200, body: { success: true, data: { id: 'u1', role: 'admin' } } };
    return { status: 200, body: { success: true, data: { id: 'k1', key: 'abk_new' } } };
  });
  const baas = createClient('https://api.example.com', { fetch: f, apiKey: 'abk_x' });
  const me = await baas.auth.me();
  check('auth.me hits /api/auth/me and unwraps', me.id === 'u1');
  const k = await baas.keys.create({ name: 'ci' });
  check('keys.create returns the once-shown key', k.key === 'abk_new');
}

// ---- audit.list ----
{
  const f = mockFetch({ status: 200, body: { success: true, data: [{ id: 'a1', action: 'auth.login.success' }] } });
  const baas = createClient('https://api.example.com', { fetch: f, apiKey: 'abk_x' });
  const events = await baas.audit.list({ action: 'auth.login.success', limit: 50 });
  const u = new URL(f.calls[0].url);
  check('audit.list → GET /api/audit + query', u.pathname.endsWith('/api/audit') && u.searchParams.get('action') === 'auth.login.success' && u.searchParams.get('limit') === '50');
  check('audit.list returns events', events[0].action === 'auth.login.success');
}

// ---- auth password-reset flow ----
{
  const f = mockFetch({ status: 200, body: { success: true, data: null } });
  const baas = createClient('https://api.example.com', { fetch: f });
  await baas.auth.forgotPassword('a@b.c');
  check('auth.forgotPassword POSTs /api/auth/forgot', f.calls[0].url.endsWith('/api/auth/forgot') && JSON.parse(f.calls[0].init.body).email === 'a@b.c');
  await baas.auth.resetPassword('tok', 'new-password');
  check('auth.resetPassword POSTs token+password', f.calls[1].url.endsWith('/api/auth/reset') && JSON.parse(f.calls[1].init.body).token === 'tok');
}

// ---- keys.create with scopes/expiry + keys.rotate ----
{
  const f = mockFetch({ status: 201, body: { success: true, data: { id: 'k2', key: 'abk_scoped' } } });
  const baas = createClient('https://api.example.com', { fetch: f, apiKey: 'abk_x' });
  await baas.keys.create({ name: 'scoped', scopes: ['posts:write'], expires_in_days: 30 });
  const body = JSON.parse(f.calls[0].init.body);
  check('keys.create forwards scopes', Array.isArray(body.scopes) && body.scopes[0] === 'posts:write');
  check('keys.create forwards expires_in_days', body.expires_in_days === 30);

  const f2 = mockFetch({ status: 200, body: { success: true, data: { id: 'k2', key: 'abk_rotated' } } });
  const baas2 = createClient('https://api.example.com', { fetch: f2, apiKey: 'abk_x' });
  const rot = await baas2.keys.rotate('k2');
  check('keys.rotate POSTs /api/keys/{id}/rotate', f2.calls[0].init.method === 'POST' && f2.calls[0].url.endsWith('/api/keys/k2/rotate'));
  check('keys.rotate returns the new secret', rot.key === 'abk_rotated');
}

// ---- webhooks namespace ----
{
  const f = mockFetch((url, init) => {
    if (init.method === 'POST') return { status: 201, body: { success: true, data: { id: 'w1', url: 'https://x', events: ['post.created'], secret: 'whsec' } } };
    return { status: 200, body: { success: true, data: [] } };
  });
  const baas = createClient('https://api.example.com', { fetch: f, apiKey: 'abk_x' });
  const reg = await baas.webhooks.register({ url: 'https://x', events: ['post.created'] });
  check('webhooks.register POSTs /api/webhooks', f.calls[0].url.endsWith('/api/webhooks') && f.calls[0].init.method === 'POST');
  check('webhooks.register returns the once-shown secret', reg.secret === 'whsec');
  await baas.webhooks.list();
  check('webhooks.list → GET /api/webhooks', f.calls[1].init.method === 'GET');
  await baas.webhooks.remove('w1');
  check('webhooks.remove → DELETE /api/webhooks/<id>', f.calls[2].url.endsWith('/api/webhooks/w1') && f.calls[2].init.method === 'DELETE');
  await baas.webhooks.deliveries({ webhook: 'w1', limit: 5 });
  const du = new URL(f.calls[3].url);
  check('webhooks.deliveries → GET /api/webhooks/deliveries + query', du.pathname.endsWith('/api/webhooks/deliveries') && du.searchParams.get('webhook') === 'w1' && du.searchParams.get('limit') === '5');
  await baas.webhooks.redeliver('d9');
  check('webhooks.redeliver → POST .../deliveries/<id>/redeliver', f.calls[4].init.method === 'POST' && f.calls[4].url.endsWith('/api/webhooks/deliveries/d9/redeliver'));
}

// ---- verifyWebhookSignature (receiver-side, WebCrypto) ----
{
  const { verifyWebhookSignature } = await load('src/client/index.ts');
  const crypto = await import('node:crypto');
  const secret = 'whsec_test';
  const body = JSON.stringify({ event: 'post.created', timestamp: '123', data: { id: 'p1' } });
  const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');
  check('verifyWebhookSignature accepts a valid sha256= header', (await verifyWebhookSignature(secret, body, `sha256=${sig}`)) === true);
  check('verifyWebhookSignature accepts a bare hex signature', (await verifyWebhookSignature(secret, body, sig)) === true);
  check('verifyWebhookSignature rejects a tampered body', (await verifyWebhookSignature(secret, body + ' ', `sha256=${sig}`)) === false);
  check('verifyWebhookSignature rejects a wrong secret', (await verifyWebhookSignature('other', body, `sha256=${sig}`)) === false);
  check('verifyWebhookSignature rejects missing inputs', (await verifyWebhookSignature(secret, body, null)) === false && (await verifyWebhookSignature('', body, sig)) === false);
}

// ---- error mapping → AstroBaasError ----
{
  const f = mockFetch({ status: 401, body: { success: false, error: { message: 'Unauthorized', code: 'UNAUTHORIZED' } } });
  const baas = createClient('https://api.example.com', { fetch: f });
  let thrown = null;
  try {
    await baas.posts.create({ title: 'x' });
  } catch (e) {
    thrown = e;
  }
  check('throws AstroBaasError on {success:false}', thrown instanceof AstroBaasError);
  check('error carries status', thrown?.status === 401);
  check('error carries code', thrown?.code === 'UNAUTHORIZED');
  check('error carries message', thrown?.message === 'Unauthorized');
}

// ---- 422 validation error surfaces details ----
{
  const f = mockFetch({ status: 422, body: { success: false, error: { message: 'Invalid', code: 'VALIDATION_ERROR', details: { price: 'required' } } } });
  const baas = createClient('https://api.example.com', { fetch: f, apiKey: 'abk_x' });
  let thrown = null;
  try {
    await baas.content('product').create({ name: 'NoPrice' });
  } catch (e) {
    thrown = e;
  }
  check('validation error carries details', thrown?.details?.price === 'required');
}

// ---- setApiKey rotates the credential ----
{
  const f = mockFetch({ status: 200, body: { success: true, data: [] } });
  const baas = createClient('https://api.example.com', { fetch: f });
  baas.setApiKey('abk_rotated');
  await baas.posts.list();
  check('setApiKey applies to subsequent requests', f.calls[0].init.headers.Authorization === 'Bearer abk_rotated');
}

// ---- empty (204-like) body resolves without throwing ----
{
  const f = mockFetch({ status: 200, body: null });
  const baas = createClient('https://api.example.com', { fetch: f, apiKey: 'abk_x' });
  let ok = true;
  try {
    await baas.posts.list(); // returns null data — but should not throw
  } catch {
    ok = false;
  }
  check('empty body resolves (no throw)', ok);
}

// ---- missing baseUrl throws early ----
{
  let threw = false;
  try {
    createClient('');
  } catch {
    threw = true;
  }
  check('createClient requires a baseUrl', threw);
}

/* ─── Commerce ──────────────────────────────────────────────────────────────
 *
 * The REST API has had products, orders, customers, coupons and media since
 * the beginning; this client covered posts, keys, webhooks, audit and auth and
 * nothing else. A headless storefront got types for BLOGGING and hand-wrote
 * fetch for the half that takes the money.
 *
 * These assertions are about the WIRE: the method, the path and the query the
 * routes actually parse. A typed method that builds a URL the route ignores is
 * worse than no method, because it reads as a filter that does not work.
 */
{
  const fetchImpl = mockFetch({ body: { success: true, data: [] } });
  const c = createClient('https://cms.example.com', { fetch: fetchImpl });

  await c.products.list();
  check('products.list GETs /api/products',
    fetchImpl.calls[0].url === 'https://cms.example.com/api/products'
    && (fetchImpl.calls[0].init.method ?? 'GET') === 'GET');

  await c.products.list({ search: 'frame', category: 'sun', limit: 10, offset: 20 });
  check('products.list sends the parameters the route parses',
    /[?&]search=frame/.test(fetchImpl.calls[1].url)
    && /[?&]category=sun/.test(fetchImpl.calls[1].url)
    && /[?&]limit=10/.test(fetchImpl.calls[1].url)
    && /[?&]offset=20/.test(fetchImpl.calls[1].url));

  // A false boolean is OMITTED, not sent as "false". The route reads the
  // presence of the parameter, so `featured=false` would filter to featured
  // products — the exact opposite of what the caller asked for.
  await c.products.list({ featured: true, on_sale: false });
  check('a TRUE boolean is sent', /[?&]featured=1/.test(fetchImpl.calls[2].url));
  check('...and a FALSE one is omitted, never sent as "false"',
    !/on_sale/.test(fetchImpl.calls[2].url));

  await c.products.get('smoke-widget');
  check('products.get uses the slug path',
    fetchImpl.calls[3].url === 'https://cms.example.com/api/products/smoke-widget');

  await c.products.notifyWhenBack('abc', 'me@example.com');
  check('notifyWhenBack POSTs to the product route',
    fetchImpl.calls[4].url === 'https://cms.example.com/api/products/abc/notify-me'
    && fetchImpl.calls[4].init.method === 'POST'
    && JSON.parse(fetchImpl.calls[4].init.body).email === 'me@example.com');

  await c.orders.quote({ items: [{ product_id: 'p1', qty: 2 }] });
  check('orders.quote POSTs the basket',
    fetchImpl.calls[5].url === 'https://cms.example.com/api/orders/quote'
    && JSON.parse(fetchImpl.calls[5].init.body).items[0].qty === 2);

  await c.orders.place({ email: 'b@example.com', items: [{ product_id: 'p1', qty: 1 }] });
  check('orders.place POSTs to /api/orders',
    fetchImpl.calls[6].url === 'https://cms.example.com/api/orders'
    && fetchImpl.calls[6].init.method === 'POST');

  await c.orders.ship('o1', { tracking_number: 'EL1', tracking_carrier: 'ELTA' });
  check('orders.ship POSTs to the ship route',
    fetchImpl.calls[7].url === 'https://cms.example.com/api/orders/o1/ship'
    && JSON.parse(fetchImpl.calls[7].init.body).tracking_number === 'EL1');

  await c.orders.update('o1', { staff_note: 'called' });
  check('orders.update PUTs the staff note',
    fetchImpl.calls[8].init.method === 'PUT'
    && JSON.parse(fetchImpl.calls[8].init.body).staff_note === 'called');

  await c.coupons.create({ code: 'X', automatic: true });
  check('coupons.create can make an AUTOMATIC cart rule',
    fetchImpl.calls[9].url === 'https://cms.example.com/api/coupons'
    && JSON.parse(fetchImpl.calls[9].init.body).automatic === true);

  await c.customers.list({ limit: 5 });
  check('customers.list GETs with its query',
    /\/api\/customers\?limit=5$/.test(fetchImpl.calls[10].url));

  await c.media.list();
  check('media.list uses the real endpoint path',
    fetchImpl.calls[11].url === 'https://cms.example.com/api/media/get');

  // An empty option object must not leave a bare "?" on the URL.
  await c.products.list({});
  check('an empty filter set leaves no trailing question mark',
    fetchImpl.calls[12].url === 'https://cms.example.com/api/products');
}

// ---- orders.place is idempotent across its own retries (hardening S4.4) ----
{
  let n = 0;
  const f = mockFetch(() => {
    n += 1;
    return n === 1
      ? { status: 503, body: { success: false, error: { message: 'busy' } } }
      : { status: 201, body: { success: true, data: { number: 'OG-1' } } };
  });
  // The client reuses one headers object across attempts, so each call's
  // headers are copied AS SENT — reading them afterwards would show only the
  // last value and hide a key that changed between attempts.
  const sent = [];
  const snap = async (url, init = {}) => { sent.push({ ...(init.headers ?? {}) }); return f(url, init); };
  const baas = createClient('https://api.example.com', { fetch: snap, retries: 2, retryBackoffMs: 1 });
  await baas.orders.place({ email: 'a@example.com', items: [{ product_id: 'p', qty: 1 }] });
  const keys = sent.map((h) => h['Idempotency-Key']);
  check(`orders.place sends an Idempotency-Key (${keys[0]})`, typeof keys[0] === 'string' && keys[0].length >= 16);
  check('...and the SAME key on its retry', f.calls.length === 2 && keys[0] === keys[1]);

  await baas.orders.place({ email: 'a@example.com', items: [{ product_id: 'p', qty: 1 }] });
  check('a separate place() is a separate checkout with a new key',
    f.calls[2].init.headers['Idempotency-Key'] !== keys[0]);

  await baas.orders.place({ email: 'a@example.com', items: [{ product_id: 'p', qty: 1 }] }, { idempotencyKey: 'mine-1' });
  check('a caller-supplied key is used as given', f.calls[3].init.headers['Idempotency-Key'] === 'mine-1');
}

// ---- the specific reason reaches the caller ----
{
  const f = mockFetch({
    status: 429,
    body: { success: false, error: { message: 'Too many', code: 'RATE_LIMITED', reason: 'checkout.too_many_unpaid', params: { max: 5 } } },
  });
  const baas = createClient('https://api.example.com', { fetch: f });
  let caught = null;
  try { await baas.orders.place({ email: 'a@example.com', items: [] }); } catch (e) { caught = e; }
  check('AstroBaasError keeps the HTTP class in code', caught instanceof AstroBaasError && caught.code === 'RATE_LIMITED');
  check('...and exposes the specific reason and its params',
    caught?.reason === 'checkout.too_many_unpaid' && caught?.params?.max === 5);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
