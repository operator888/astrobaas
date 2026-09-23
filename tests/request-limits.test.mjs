#!/usr/bin/env node
/**
 * Request limits: who the caller is, which buckets a request is charged to,
 * and which writes are refused before a handler reads them.
 *
 *   S3.3  IPv6 is counted per /64, and an IPv4-mapped address is IPv4.
 *   S3.4  checkout, quote, payment start and search have their own per-IP
 *         buckets; payment webhooks leave the anonymous bucket for a generous
 *         one of their own; RateLimit-* names the bucket closest to refusing.
 *   S3.6  a key an admin marked `forward_client_ip` may name the shopper; an
 *         unmarked key and an anonymous caller cannot.
 *   S3.7  a write with Transfer-Encoding and no Content-Length is refused.
 *   S3.12 the scope error message is built from the scope list.
 *   S3.13 the CSRF cookie is set only on HTML pages outside /api.
 *   S3.14 CORS_ORIGINS=* is reported, not changed.
 *
 * The middleware itself imports `astro:middleware` and cannot be loaded here,
 * so its WIRING is checked by reading it: each rule above must be the thing
 * the middleware actually calls. The HTTP-level assertions are in
 * tests/smoke.mjs.
 *
 * Run with:  node tests/request-limits.test.mjs
 */
import { loadTs, readRepo } from './lib/load.mjs';

const L = await loadTs('src/lib/request-limits.ts');
const A = await loadTs('src/lib/auth.ts');
const S = await loadTs('src/lib/api-key-scopes.ts');
const H = await loadTs('src/lib/security-headers.ts');
const { MemoryRateLimitStore } = await loadTs('src/lib/rate-limit.ts');

let pass = 0;
let fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };

/**
 * Source with comments removed, so an explanation cannot satisfy a code check.
 * LINE comments first: the middleware has a `// ... (except /api/auth/*) ...`
 * line, and a block-comment pass that ran first would start a "comment" at
 * that `/*` and swallow four thousand characters of real code.
 */
const code = (src) => src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

/* ================================================================== *
 * S3.3 — client identity
 * ================================================================== */
{
  const id = L.clientIdentity;
  check('an IPv4 address is its own identity', id('203.0.113.7') === '203.0.113.7');
  check('...with surrounding whitespace ignored', id('  203.0.113.7 ') === '203.0.113.7');

  // THE BUG: every address inside one subscriber's /64 was a fresh bucket.
  const a = id('2001:db8:1:2:aaaa:bbbb:cccc:dddd');
  const b = id('2001:db8:1:2:1111:2222:3333:4444');
  check('two addresses in one /64 are ONE caller', a === b && a === '2001:db8:1:2::/64');
  check('...and the neighbouring /64 is another', id('2001:db8:1:3::1') === '2001:db8:1:3::/64');
  check('compressed and expanded spellings agree',
    id('2001:0db8:0000:0000:0000:0000:0000:0001') === id('2001:db8::1'));
  check('...and case does not matter', id('2001:DB8::ABCD') === id('2001:db8::abcd'));
  check('a zone id is dropped', id('fe80::1%eth0') === 'fe80:0:0:0::/64');
  check('a bracketed address with a port is parsed', id('[2001:db8::1]:443') === '2001:db8:0:0::/64');
  check('an IPv4 address with a port is parsed', id('203.0.113.7:51234') === '203.0.113.7');

  // IPv4-mapped: a dual-stack socket reports every IPv4 client this way. Left
  // alone it is a different bucket from the same client over IPv4 — and
  // grouped by /64 it would put the whole IPv4 internet in one bucket.
  check('::ffff:a.b.c.d is IPv4', id('::ffff:198.51.100.23') === '198.51.100.23');
  check('...in upper case too', id('::FFFF:198.51.100.23') === '198.51.100.23');
  check('...and in its hex spelling', id('::ffff:c633:6417') === '198.51.100.23');
  check('two mapped clients are NOT one bucket',
    id('::ffff:198.51.100.23') !== id('::ffff:198.51.100.24'));
  check('loopback stays readable', id('::1') === '::1');

  for (const junk of ['', '   ', 'unknown', 'not-an-ip', '1.2.3', '999.1.1.1', '1.2.3.4, 5.6.7.8', null, undefined, 'x'.repeat(100)]) {
    check(`${JSON.stringify(junk)?.slice(0, 20)} is not an address`, id(junk) === null);
  }

  // resolveClientIp keeps the trust rules the middleware had.
  const r = L.resolveClientIp;
  check('no proxy trust: the socket address', r({ forwardedFor: '1.1.1.1', directAddr: '10.0.0.5', trustProxy: false }) === '10.0.0.5');
  check('no proxy trust: X-Real-IP is ignored too', r({ realIp: '1.1.1.1', directAddr: '10.0.0.5', trustProxy: false }) === '10.0.0.5');
  check('trusted proxy: the RIGHT-most X-Forwarded-For hop',
    r({ forwardedFor: '6.6.6.6, 203.0.113.9', directAddr: '127.0.0.1', trustProxy: true }) === '203.0.113.9');
  check('trusted proxy: that hop is grouped like any other',
    r({ forwardedFor: 'evil, 2001:db8:9:9::42', directAddr: '127.0.0.1', trustProxy: true }) === '2001:db8:9:9::/64');
  check('trusted proxy: X-Real-IP when there is no X-Forwarded-For',
    r({ realIp: '203.0.113.10', directAddr: '127.0.0.1', trustProxy: true }) === '203.0.113.10');
  check('a hop that is not an address falls back instead of naming a bucket',
    r({ forwardedFor: 'garbage', directAddr: '::ffff:127.0.0.1', trustProxy: true }) === '127.0.0.1');
  check('nothing usable at all is "unknown"', r({ directAddr: '', trustProxy: false }) === 'unknown');

  // The middleware must use THIS, not its own copy, and must put it in locals.ip
  // so every downstream per-IP bucket groups the same way.
  const mw = code(await readRepo('src/middleware.ts'));
  check('the middleware resolves the IP through resolveClientIp', /resolveClientIp\(\{/.test(mw));
  check('...and no longer splits X-Forwarded-For itself', !/x-forwarded-for'\)\s*;\s*\n\s*if \(fwd\)/.test(mw) && !/fwd\.split\(/.test(mw));
  check('...and puts the identity in locals.ip', /locals\.ip\s*=\s*ip\b/.test(mw));
}

/* ================================================================== *
 * S3.6 — trusted client-IP forwarding
 * ================================================================== */
{
  const t = L.trustedForwardedIp;
  const marked = { forward_client_ip: true };
  check('the header is spelled as documented', L.CLIENT_IP_HEADER === 'x-astrobaas-client-ip');
  check('a marked key may name the shopper', t(marked, '198.51.100.40') === '198.51.100.40');
  check('...grouped like every other identity', t(marked, '2001:db8:4:4::9') === '2001:db8:4:4::/64');
  check('...and mapped addresses unwrapped', t(marked, '::ffff:198.51.100.40') === '198.51.100.40');

  // THE SPOOFING CASES.
  check('an UNMARKED key cannot', t({}, '198.51.100.40') === null);
  check('...nor one marked false', t({ forward_client_ip: false }, '198.51.100.40') === null);
  check('...nor one whose flag is the STRING "true"', t({ forward_client_ip: 'true' }, '198.51.100.40') === null);
  check('...nor an anonymous caller (no key)', t(null, '198.51.100.40') === null && t(undefined, '198.51.100.40') === null);
  check('a list is refused, not picked from', t(marked, '198.51.100.40, 10.0.0.1') === null);
  check('...as is anything with spaces inside', t(marked, '198.51.100.40 10.0.0.1') === null);
  check('...or something that is not an address', t(marked, 'localhost') === null && t(marked, '') === null && t(marked, null) === null);

  // Wiring: forwarding is consulted only for a bearer request, with the key
  // record the bearer block authenticated, and the result becomes locals.ip.
  const mw = code(await readRepo('src/middleware.ts'));
  check('the middleware asks trustedForwardedIp only for a bearer request',
    /const forwardedIp\s*=\s*isBearer\s*\?\s*trustedForwardedIp\(bearerKey,\s*request\.headers\.get\(CLIENT_IP_HEADER\)\)\s*:\s*null/.test(mw));
  check('...with the record of the key that authenticated',
    /bearerKey\s*=\s*rec\s*;/.test(mw));
  check('...and uses it ahead of the socket address', /const ip\s*=\s*forwardedIp\s*\?\?\s*clientIp\(/.test(mw));
  check('...and tells the bucket planner it was forwarded', /forwarded:\s*forwardedIp\s*!==\s*null/.test(mw));

  // The header must NOT be offered to browsers: it is for a server, and a
  // preflight that allowed it would invite exactly the wrong callers.
  const cors = H.corsHeaders('https://shop.example', { CORS_ORIGINS: 'https://shop.example' });
  check('browsers are not invited to send it (CORS allow-list)',
    !/x-astrobaas-client-ip/i.test(cors['Access-Control-Allow-Headers'] ?? ''));

  // Only an admin can set it: both routes that write it are admin-gated, and
  // they are the only writers.
  const mint = code(await readRepo('src/pages/api/keys/index.ts'));
  const patch = code(await readRepo('src/pages/api/keys/[id]/index.ts'));
  check('minting accepts the flag as a strict boolean', /forward_client_ip:\s*\{\s*type:\s*'boolean'/.test(mint));
  check('...behind the admin check',
    mint.indexOf("session.role !== 'admin'") > -1
    && mint.indexOf("session.role !== 'admin'", mint.indexOf('export const POST')) < mint.indexOf('forward_client_ip'));
  check('PATCH is admin-only and accepts nothing else',
    /export const PATCH/.test(patch)
    && patch.indexOf("session.role !== 'admin'", patch.indexOf('export const PATCH')) > -1
    && /validate<\{\s*forward_client_ip:\s*boolean\s*\}>/.test(patch)
    && /updateApiKey\(id,\s*\{\s*forward_client_ip:\s*result\.value\.forward_client_ip\s*\}\)/.test(patch));
}

/* ================================================================== *
 * S3.4 — route buckets
 * ================================================================== */
{
  const rb = L.routeBucketFor;
  const q = (s) => new URLSearchParams(s);
  check('POST /api/orders is checkout', rb('POST', '/api/orders') === 'checkout' && rb('post', '/api/orders/') === 'checkout');
  check('POST /api/orders/quote is quote', rb('POST', '/api/orders/quote') === 'quote');
  check('POST /api/payments/start is payment-start', rb('POST', '/api/payments/start') === 'payment-start');
  check('GET /api/search is search', rb('GET', '/api/search', q('q=x')) === 'search' && rb('GET', '/api/search/') === 'search');
  check('GET /api/products?search= is search', rb('GET', '/api/products', q('search=ray')) === 'search');
  check('...but a plain catalogue page is NOT', rb('GET', '/api/products', q('category=x')) === null);
  check('...nor an empty search', rb('GET', '/api/products', q('search=%20')) === null);
  check('payment webhooks are webhook', rb('POST', '/api/payments/webhook/stripe') === 'webhook' && rb('POST', '/api/payments/webhook/test-gateway/') === 'webhook');
  check('an order READ is not checkout', rb('GET', '/api/orders') === null && rb('POST', '/api/orders/abc/refund') === null);
  check('a GET to a POST route is not charged to it', rb('GET', '/api/orders/quote') === null);
  check('a lookalike path is not a webhook', rb('POST', '/api/payments/webhook/stripe/extra') === null);

  // Defaults: each expensive route sits BELOW the general anonymous ceiling.
  const d = L.resolveRouteLimits({});
  check('defaults: checkout 10, quote 30, payment start 10, search 30, webhook 600',
    d.checkout === 10 && d.quote === 30 && d['payment-start'] === 10 && d.search === 30 && d.webhook === 600);
  check('every shopper route is tighter than the general 60/min',
    ['checkout', 'quote', 'payment-start', 'search'].every((k) => d[k] < 60));
  check('the webhook bucket is generous', d.webhook > 60);
  const e = L.resolveRouteLimits({
    RATE_LIMIT_CHECKOUT_PER_MIN: '25', RATE_LIMIT_QUOTE_PER_MIN: '0', RATE_LIMIT_PAYMENT_START_PER_MIN: 'x',
    RATE_LIMIT_SEARCH_PER_MIN: '45.9', RATE_LIMIT_WEBHOOK_PER_MIN: '-1',
  });
  check('env tunes a ceiling', e.checkout === 25);
  check('...and a zero, junk or negative value keeps the default',
    e.quote === 30 && e['payment-start'] === 10 && e.webhook === 600);
  check('...and a fraction is floored', e.search === 45);

  const limits = { windowMs: 60_000, anonymous: 60, apiKey: 6000, staff: 1800, routes: d };
  const plan = (o) => L.planRateBuckets({ method: 'GET', pathname: '/api/posts', ip: '198.51.100.1', limits, ...o });
  const keys = (p) => p.map((b) => `${b.key}@${b.limit}`);

  check('an anonymous read is charged to its address only',
    JSON.stringify(keys(plan({}))) === JSON.stringify(['api:198.51.100.1@60']));
  check('an anonymous checkout: address AND checkout bucket',
    JSON.stringify(keys(plan({ method: 'POST', pathname: '/api/orders' })))
      === JSON.stringify(['api:198.51.100.1@60', 'route:checkout:198.51.100.1@10']));
  check('an anonymous WEBHOOK leaves the anonymous bucket for its own',
    JSON.stringify(keys(plan({ method: 'POST', pathname: '/api/payments/webhook/stripe' })))
      === JSON.stringify(['route:webhook:198.51.100.1@600']));
  check('a key WITHOUT forwarding checks out on its own bucket only — its address is the whole shop',
    JSON.stringify(keys(plan({ method: 'POST', pathname: '/api/orders', apiKeyId: 'k1' })))
      === JSON.stringify(['apikey:k1@6000']));
  check('a FORWARDING key: its own bucket AND the shopper\'s checkout bucket',
    JSON.stringify(keys(plan({ method: 'POST', pathname: '/api/orders', apiKeyId: 'k1', forwarded: true, ip: '203.0.113.5' })))
      === JSON.stringify(['apikey:k1@6000', 'route:checkout:203.0.113.5@10']));
  check('...but not the anonymous bucket (a BFF makes several calls per page)',
    !keys(plan({ apiKeyId: 'k1', forwarded: true })).some((k) => k.startsWith('api:')));
  check('a staff session is never charged per route',
    JSON.stringify(keys(plan({ method: 'POST', pathname: '/api/orders', userId: 'u1' })))
      === JSON.stringify(['user:u1@1800']));
  check('a searching storefront page is charged to search',
    keys(plan({ pathname: '/api/products', searchParams: q('search=ray') })).includes('route:search:198.51.100.1@30'));
  check('every plan names at least one bucket',
    [plan({}), plan({ method: 'POST', pathname: '/api/payments/webhook/x' }), plan({ apiKeyId: 'k' }), plan({ userId: 'u' })]
      .every((p) => p.length >= 1));

  // THE BEHAVIOUR, against the real store: the eleventh checkout from one
  // address is refused while that address can still read the catalogue.
  const store = new MemoryRateLimitStore();
  const charge = (p) => {
    for (const b of p) {
      const r = store.consume(b.key, b.windowMs, b.limit);
      if (!r.allowed) return { allowed: false, r };
    }
    return { allowed: true };
  };
  let placed = 0;
  for (let i = 0; i < 12; i += 1) if (charge(plan({ method: 'POST', pathname: '/api/orders' })).allowed) placed += 1;
  check('ten checkouts a minute per address, not sixty', placed === 10);
  check('...while the same address can still browse', charge(plan({})).allowed);
  check('...and a different shopper can still check out',
    charge(plan({ method: 'POST', pathname: '/api/orders', ip: '198.51.100.2' })).allowed);
  let hooks = 0;
  for (let i = 0; i < 100; i += 1) if (charge(plan({ method: 'POST', pathname: '/api/payments/webhook/stripe', ip: '54.187.174.169' })).allowed) hooks += 1;
  check('a provider burst of 100 webhooks is not throttled', hooks === 100);
  check('...and did not spend that address\'s anonymous budget',
    store.consume('api:54.187.174.169', 60_000, 60).remaining === 59);

  // Behind a BFF: two shoppers, one key, one server address.
  const bff = (shopper) => plan({ method: 'POST', pathname: '/api/orders', apiKeyId: 'shop', forwarded: true, ip: shopper });
  let first = 0;
  for (let i = 0; i < 11; i += 1) if (charge(bff('203.0.113.50')).allowed) first += 1;
  check('behind a BFF one shopper is limited on their OWN address', first === 10);
  check('...and the next shopper through the same key is not', charge(bff('203.0.113.51')).allowed);

  // RateLimit-* names the bucket closest to refusing.
  const mr = L.mostRestrictive;
  const res = (limit, remaining, allowed = true, retry = 30) => ({ allowed, limit, remaining, resetAt: 0, retryAfterSeconds: retry });
  check('headers describe the bucket with the least left',
    mr([res(60, 55), res(10, 3)]).limit === 10);
  check('...and on a tie, the tighter ceiling', mr([res(60, 3), res(10, 3)]).limit === 10);
  check('a refusal wins outright', mr([res(60, 0, true), res(10, 0, false, 12)]).allowed === false);
  check('...the longest wait among refusals', mr([res(60, 0, false, 5), res(10, 0, false, 40)]).retryAfterSeconds === 40);

  // Wiring.
  const mw = code(await readRepo('src/middleware.ts'));
  check('the middleware charges the planned buckets',
    /planRateBuckets\(\{/.test(mw) && /chargeBuckets\(plan\)/.test(mw));
  check('...with the configured route ceilings', /routes:\s*ROUTE_LIMITS/.test(mw) && /const ROUTE_LIMITS\s*=\s*resolveRouteLimits\(\)/.test(mw));
  check('...stopping at the first refusal', /if \(!r\.allowed\) return \{ allowed: false, result: r \}/.test(mw));
  check('...and publishing the most restrictive budget', /mostRestrictive\(results\)/.test(mw));
  check('the old single-bucket rateCheck is gone', !/function rateCheck\(/.test(mw));
}

/* ================================================================== *
 * S3.7 — writes without a length
 * ================================================================== */
{
  const u = L.isUnframedWrite;
  const h = (o) => new Headers(o);
  check('a chunked POST is refused', u('POST', h({ 'transfer-encoding': 'chunked' })));
  for (const m of ['PUT', 'PATCH', 'DELETE', 'post']) {
    check(`...and a chunked ${m}`, u(m, h({ 'Transfer-Encoding': 'chunked' })));
  }
  check('a POST with Content-Length is not', !u('POST', h({ 'content-length': '12' })));
  check('...nor one with neither header (no body)', !u('POST', h({})));
  check('...nor a chunked GET (reads are not size-checked)', !u('GET', h({ 'transfer-encoding': 'chunked' })) && !u('HEAD', h({ 'transfer-encoding': 'chunked' })));
  check('...nor a request that has both (Node refuses those first)', !u('POST', h({ 'transfer-encoding': 'chunked', 'content-length': '5' })));

  const mw = code(await readRepo('src/middleware.ts'));
  const i411 = mw.indexOf('isUnframedWrite(method, request.headers)');
  const i413 = mw.indexOf('bodyLimitFor(pathname)');
  check('the middleware refuses them with 411', i411 > -1 && /status:\s*411/.test(mw.slice(i411, i411 + 600)));
  check('...as JSON with a stable code', /code:\s*'LENGTH_REQUIRED'/.test(mw.slice(i411, i411 + 600)));
  check('...BEFORE the Content-Length size check that they used to skip', i411 > -1 && i413 > i411);
  check('...inside the /api block', mw.lastIndexOf("if (pathname.startsWith('/api/')) {", i411) > mw.indexOf('// ---- Rate-limit API ----'));
}

/* ================================================================== *
 * S3.13 — the CSRF cookie only where it is read
 * ================================================================== */
{
  const s = A.shouldSetCsrfCookie;
  check('an HTML page gets it', s('/login', 'text/html; charset=utf-8') && s('/admin/posts', 'text/html'));
  check('...a public page too (its forms read it)', s('/contact', 'text/html;charset=UTF-8') && s('/', 'TEXT/HTML'));
  check('an API response does NOT — even an HTML one', !s('/api/products', 'application/json') && !s('/api/print/1', 'text/html'));
  check('...nor /api itself', !s('/api', 'text/html'));
  check('non-HTML responses do NOT', !s('/sitemap.xml', 'application/xml') && !s('/uploads/a.png', 'image/png')
    && !s('/rss.xml', 'application/rss+xml') && !s('/captcha.js', 'application/javascript'));
  check('...nor a response with no type at all (a redirect)', !s('/admin', null) && !s('/admin', ''));
  check('a path that merely starts with "api" is still a page', s('/apiary', 'text/html'));

  const cookie = A.csrfCookie('tok123');
  check('the cookie is readable by page script', /^astrobaas_csrf=tok123;/.test(cookie) && !/HttpOnly/.test(cookie));
  check('...and SameSite=Lax', /SameSite=Lax/.test(cookie));

  const mw = code(await readRepo('src/middleware.ts'));
  check('the middleware decides AFTER next(), from the response type',
    /if \(csrfIsNew && shouldSetCsrfCookie\(pathname, res\.headers\.get\('content-type'\)\)\)/.test(mw));
  check('...and no longer sets it unconditionally', !/if \(setCsrf\)/.test(mw));
  check('every request still gets a token for its page', /locals\.csrf\s*=\s*csrf/.test(mw));

  // The one API response that DOES set it: signing in, for a script that never
  // loads a page. Only when the request had none.
  const login = code(await readRepo('src/pages/api/auth/login.ts'));
  check('signing in hands a cookie-less client its CSRF token',
    /const needsCsrf = !cookies\.get\(CSRF_COOKIE\)\?\.value/.test(login)
    && (login.match(/if \(needsCsrf\) res\.headers\.append\('Set-Cookie', csrfCookie\(locals\.csrf\)\)/g) ?? []).length === 2);

  // The admin UI reads the token from the PAGE it was served with. Every
  // reader must be one of the two page-sourced forms — never an API response.
  const readers = [
    'src/layouts/AdminLayout.astro', 'src/layouts/BaseLayout.astro', 'src/lib/apiClient.ts',
    'src/components/admin/SwitchBanner.astro', 'src/pages/admin/import.astro', 'src/pages/popup.js.ts',
    'src/components/public/SubmissionForm.astro', 'src/components/public/PostComments.astro', 'src/pages/contact.astro',
  ];
  let pageSourced = true;
  for (const f of readers) {
    const src = await readRepo(f);
    if (!/locals\.csrf|meta\[name="csrf-token"\]|document\.cookie|meta\('csrf-token'\)/.test(src)) pageSourced = false;
  }
  check('every CSRF reader in the UI takes it from the page or document.cookie', pageSourced);

  // A cookie-less cross-origin storefront write never needed it.
  check('cookie-less cross-origin public writes skip the double-submit check',
    /const cookielessPublic = isCrossOriginPublicWrite\(/.test(mw) && /!cookielessPublic\)/.test(mw));
}

/* ================================================================== *
 * S3.12 — the scope message cannot go stale again
 * ================================================================== */
{
  for (const r of S.SCOPED_RESOURCES) {
    check(`the hint names "${r}"`, S.SCOPE_FORMAT_HINT.includes(r));
    check(`...and "${r}:read" validates`, S.isValidScope(`${r}:read`));
  }
  check('the hint no longer stops at media', !/<posts\|content\|media>/.test(S.SCOPE_FORMAT_HINT));
  check('an unknown resource still fails', !S.isValidScope('order:read') && !S.isValidScope('users:read'));
  check('...as does a bad action', !S.isValidScope('posts:delete'));
  check('the global grant still validates', S.isValidScope('*'));
  const mint = code(await readRepo('src/pages/api/keys/index.ts'));
  check('the mint route uses the shared hint, not a literal',
    /scopes:\s*SCOPE_FORMAT_HINT/.test(mint) && !/<posts\|content\|media>/.test(mint));
}

/* ================================================================== *
 * S3.14 — CORS_ORIGINS=* is reported
 * ================================================================== */
{
  const d = H.describeCorsPosture;
  const w = d({ CORS_ORIGINS: '*' });
  check('a wildcard is flagged', w.wildcard === true && typeof w.warning === 'string');
  check('...and the warning says what it opens', /ANY website/.test(w.warning) && /CSRF/.test(w.warning));
  check('...and what to do instead', /CORS_ORIGINS=https:\/\//.test(w.warning));
  check('a wildcard among others is still a wildcard', d({ CORS_ORIGINS: 'https://a.example *' }).wildcard === true);
  check('named origins are not flagged', !d({ CORS_ORIGINS: 'https://a.example,https://b.example' }).warning);
  check('...and are counted', d({ CORS_ORIGINS: 'https://a.example https://b.example' }).origins.length === 2);
  check('unset is not flagged', !d({}).warning && d({}).origins.length === 0);
  // Behaviour is unchanged: the wildcard still allows every origin.
  check('the wildcard still allows any origin (no behaviour change)',
    H.corsAllowOrigin('https://anything.example', { CORS_ORIGINS: '*' }) === '*');

  const mw = code(await readRepo('src/middleware.ts'));
  check('the warning is logged at startup',
    /const cors = describeCorsPosture\(\);\s*\n\s*if \(cors\.warning\) console\.warn\(/.test(mw));
  const deep = code(await readRepo('src/pages/api/health/deep.ts'));
  check('the deep health check reports it as a WARNING, never a failure',
    /run\('cors_origins', checkCorsPosture\)/.test(deep)
    && /status:\s*'warn',\s*detail:\s*posture\.warning/.test(deep)
    && !/cors[\s\S]{0,400}status:\s*'fail'/.test(deep.slice(deep.indexOf('async function checkCorsPosture'), deep.indexOf('async function checkCorsPosture') + 700)));
}

/* ---- the CORS echo merges Vary instead of replacing it ---- */
{
  const mv = H.mergeVary;
  check('Vary: CORS adds Origin to what a cacheable route already said',
    mv?.('Cookie, Authorization', 'Origin') === 'Cookie, Authorization, Origin');
  check('Vary: nothing there yet → just Origin', mv?.(null, 'Origin') === 'Origin' && mv?.('', 'Origin') === 'Origin');
  check('Vary: a token already present is not repeated, whatever its case',
    mv?.('origin, Cookie', 'Origin') === 'origin, Cookie');
  check('Vary: * stays *', mv?.('*', 'Origin') === '*');
  const mwSrc = await readRepo('src/middleware.ts');
  const echo = mwSrc.slice(mwSrc.indexOf('Echo CORS headers on allowed cross-origin API responses'));
  check('middleware: the CORS echo merges Vary rather than setting it',
    /mergeVary\(res\.headers\.get\(k\), v\)/.test(echo.slice(0, 700)));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
