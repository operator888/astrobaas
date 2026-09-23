#!/usr/bin/env node
/**
 * The shipped reverse-proxy configs must not refuse what the app accepts.
 *
 * ## The bug this exists to prevent
 *
 * On a live shop, video upload was correct in every file anyone would think
 * to check. The ingester accepted 100 MB, the middleware's ceiling was derived
 * from the ingester's so the two could not drift, the route worked, and the
 * tests passed. The shipped nginx vhost said `client_max_body_size 12m` — a
 * number that had been right when the app allowed 10 MB images and had simply
 * not moved since. Every video upload died at the proxy with a bare 413: no
 * JSON, no message the editor could render, and nothing whatsoever in the app's
 * log, because the request never reached the app.
 *
 * Three more routes — `/api/media/replace`, `/api/import/wordpress` and
 * `/api/forms/*​/upload` — had no location block at all, so they silently
 * inherited the 2 MB server default while the app was willing to take 111 MB,
 * 26 MB and 6 MB respectively.
 *
 * Unit tests cannot catch this, because the defect is not in the code: it is in
 * the disagreement between the code and a config file in another language. So
 * this test READS THE SHIPPED CONFIGS and resolves each route through them.
 *
 * ## What it asserts
 *
 *  1. Every route in `BODY_LIMITS` resolves, under nginx's real location
 *     precedence, to a block whose cap is at least the app's own.
 *  2. The same for Caddy, where the risk is inverted — Caddy has no default
 *     body limit, so the danger is an UNCAPPED route rather than a 413.
 *  3. The operator documentation still lists every route and the constant its
 *     cap derives from, so a route added later cannot be undocumented.
 *
 * Run with:  node tests/body-limits.test.mjs
 */
import fs from 'node:fs/promises';
import { loadTs } from './lib/load.mjs';

const B = await loadTs('src/lib/body-limits.ts');

let pass = 0;
let fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };

/** A concrete path for a rule whose location is written with a wildcard. */
const examplePath = (loc) => loc.replace('*', 'contact-form');

/* ------------------------------------------------------- the table itself */
{
  // `bodyLimitFor` moved out of src/middleware.ts into the table. It is the
  // enforcement point for an OOM guard, so the move has to be provably
  // behaviour-preserving rather than probably.
  const MB = 1024 * 1024;
  check('an ordinary API route gets the small default',
    B.bodyLimitFor('/api/posts') === B.BODY_LIMIT_DEFAULT);
  check('an unknown route gets the small default too, rather than the largest rule',
    B.bodyLimitFor('/api/does/not/exist') === B.BODY_LIMIT_DEFAULT);
  check('the video upload ceiling is the ingester\'s plus multipart headroom',
    B.bodyLimitFor('/api/media/upload') === Math.ceil(100 * MB * 1.1));
  check('replace gets the SAME ceiling as upload — a replacement is an upload',
    B.bodyLimitFor('/api/media/replace') === B.bodyLimitFor('/api/media/upload'));
  check('the backup ceiling is the archive cap plus headroom',
    B.bodyLimitFor('/api/backup/import') === Math.ceil(256 * MB * 1.1));
  check('the WXR ceiling is above the route\'s own file cap, so its error message is reachable',
    B.bodyLimitFor('/api/import/wordpress') === 24 * MB + 2 * MB);

  // The regex rule, including the trailing slash the middleware accepted.
  check('a public form upload matches by shape, whatever the form is called',
    B.bodyLimitFor('/api/forms/contact/upload') === Math.ceil(5 * MB * 1.2));
  check('...with a trailing slash too', B.bodyLimitFor('/api/forms/contact/upload/') === Math.ceil(5 * MB * 1.2));
  // A nested path must NOT inherit the form cap — `[^/]+` is doing real work.
  check('...but not a deeper path that merely starts the same way',
    B.bodyLimitFor('/api/forms/a/b/upload') === B.BODY_LIMIT_DEFAULT);
  check('...nor a route that only looks similar',
    B.bodyLimitFor('/api/forms/contact/uploads') === B.BODY_LIMIT_DEFAULT);

  // Order-independence: the rules are disjoint, so reordering the table cannot
  // change an answer. That is what makes the table safe to append to.
  const hits = (p) => B.BODY_LIMITS.filter((r) => r.match(p)).length;
  check('no path is claimed by two rules at once',
    ['/api/media/upload', '/api/media/replace', '/api/backup/import',
     '/api/import/wordpress', '/api/forms/x/upload'].every((p) => hits(p) === 1));

  check('every rule states the constant it derives from, for the docs and the operator',
    B.BODY_LIMITS.every((r) => r.derivesFrom && r.purpose && r.bytes > B.BODY_LIMIT_DEFAULT));
  check('proxySize always rounds UP, so a proxy is never a byte below the app',
    B.proxySize(1024 * 1024 + 1) === '2m' && B.proxySize(111 * MB) === '111m');
}

/* ------------------------------------------------------------------ nginx */

/**
 * Parse `location <spec> { ... }` blocks, brace-counting so a nested block
 * (there are none today, but `if` blocks are legal here) cannot end one early.
 */
function nginxLocations(rawSrc) {
  // Comments FIRST. The word "location" occurs in the vhost's own prose, and a
  // `location <spec> {` regex run over the raw file happily spans from a
  // comment to the next real brace — which made this test report a correctly
  // configured route as missing. A parser that can be fooled by a comment
  // cannot be trusted to say a config is wrong.
  const src = rawSrc.replace(/#[^\n]*/g, '');
  const out = [];
  const re = /location\s+([^{]+?)\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    let depth = 1;
    let i = re.lastIndex;
    while (i < src.length && depth > 0) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
      i++;
    }
    const body = src.slice(re.lastIndex, i - 1);
    const live = body;
    const cap = live.match(/client_max_body_size\s+([0-9]+)([kKmMgG]?)\s*;/);
    out.push({ spec: m[1].trim(), body: live, cap: cap ? sizeToBytes(cap[1], cap[2]) : undefined });
  }
  return out;
}

function sizeToBytes(n, unit) {
  const mult = { '': 1, k: 1024, m: 1024 * 1024, g: 1024 * 1024 * 1024 }[String(unit).toLowerCase()];
  return Number(n) * mult;
}

/**
 * nginx's own location precedence: `=` exact wins outright; then `^~` on the
 * longest matching prefix; then regexes IN FILE ORDER, first match winning;
 * then the longest plain prefix.
 *
 * Implemented rather than approximated, because "is there a line with the right
 * number in it" is exactly the check that would have passed while production
 * was broken — `/api/media/upload` had a line, and the line was wrong.
 */
function resolveNginx(locations, path) {
  const exact = locations.find((l) => l.spec === `= ${path}`);
  if (exact) return exact;

  const carets = locations
    .filter((l) => l.spec.startsWith('^~ ') && path.startsWith(l.spec.slice(3)))
    .sort((a, b) => b.spec.length - a.spec.length);
  if (carets.length) return carets[0];

  for (const l of locations) {
    const m = l.spec.match(/^~(\*)?\s+(.+)$/);
    if (!m) continue;
    try {
      if (new RegExp(m[2], m[1] ? 'i' : '').test(path)) return l;
    } catch { /* an unparseable regex is reported by the coverage check below */ }
  }

  const prefixes = locations
    .filter((l) => !/^[=~]|\^~/.test(l.spec) && path.startsWith(l.spec))
    .sort((a, b) => b.spec.length - a.spec.length);
  return prefixes[0];
}

{
  const src = await fs.readFile('deploy/nginx/astrobaas.conf', 'utf8');
  const live = src.replace(/#[^\n]*/g, '');
  const locations = nginxLocations(src);

  // The server-level default, which is what an uncovered route inherits.
  const serverDefault = live.match(/^\s*client_max_body_size\s+([0-9]+)([kKmMgG]?)\s*;/m);
  const inherited = serverDefault ? sizeToBytes(serverDefault[1], serverDefault[2]) : 1024 * 1024;
  check('the vhost sets a server-level body limit at least the app default',
    inherited >= B.BODY_LIMIT_DEFAULT);

  for (const rule of B.BODY_LIMITS) {
    const path = examplePath(rule.location);
    const loc = resolveNginx(locations, path);
    const effective = loc?.cap ?? inherited;

    // Named per route, so a failure says which line to change without reading
    // the test — the operator seeing this in CI is the one holding the vhost.
    check(
      `nginx: ${rule.location} resolves to a block of its own (got ${loc?.spec ?? 'no location — inherits the server default'})`,
      !!loc && loc.cap !== undefined,
    );
    check(
      `nginx: ${rule.location} allows the app's ${Math.ceil(rule.bytes / 1048576)} MB (config allows ${Math.floor(effective / 1048576)} MB, from ${rule.derivesFrom})`,
      effective >= rule.bytes,
    );
  }

  // A path with no rule must NOT be handed a large cap by accident — a 282 MB
  // ceiling on `/` would undo the DoS guard the middleware exists to provide.
  const ordinary = resolveNginx(locations, '/api/posts');
  check('nginx: an ordinary API route is still held to the small default',
    (ordinary?.cap ?? inherited) <= B.BODY_LIMIT_DEFAULT);

  // The upload routes need a timeout to match their size: 100 MB over a
  // domestic uplink outlasts a 60s client_body_timeout, and the editor is then
  // told an upload failed with no reason.
  const upload = resolveNginx(locations, '/api/media/upload');
  check('nginx: the video upload route raises its own body timeout',
    /client_body_timeout\s+(\d+)s/.test(upload?.body ?? '')
      && Number(upload.body.match(/client_body_timeout\s+(\d+)s/)[1]) >= 300);
}

/* ------------------------------------------------------------------ caddy */
{
  const src = await fs.readFile('deploy/caddy/Caddyfile', 'utf8');
  // Caddy comments are whole-line `#`. Strip them so a commented example block
  // at the foot of the file is not read as configuration.
  const live = src.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

  const sizes = [...live.matchAll(/max_size\s+([0-9]+)(MB|KB|GB|B)?/gi)].map((m) => ({
    bytes: Number(m[1]) * ({ b: 1, kb: 1024, mb: 1024 * 1024, gb: 1024 * 1024 * 1024 }[String(m[2] ?? 'b').toLowerCase()]),
    at: m.index,
  }));
  check('caddy: the file sets request-body ceilings at all — Caddy has no default',
    sizes.length >= B.BODY_LIMITS.length);

  for (const rule of B.BODY_LIMITS) {
    const path = examplePath(rule.location);
    // Find the matcher naming this route, then the first max_size after it.
    const escaped = rule.location.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('\\*', '[^/]+');
    const matcher = new RegExp(`(?:path|path_regexp)[^\\n]*${rule.location.includes('*') ? '' : escaped}`);
    const idx = rule.location.includes('*')
      ? live.search(/path_regexp[^\n]*\/api\/forms/)
      : live.search(matcher);
    const next = sizes.find((s) => s.at > idx);
    check(
      `caddy: ${rule.location} is named by a matcher`,
      idx !== -1,
    );
    check(
      `caddy: ${rule.location} allows the app's ${Math.ceil(rule.bytes / 1048576)} MB`,
      !!next && next.bytes >= rule.bytes,
    );
  }

  /*
   * The catch-all must come LAST.
   *
   * Caddy takes the FIRST `handle` that matches, so an unmatched `handle` above
   * the specific ones swallows every route below it and caps the lot at 2 MB —
   * the same production failure as the nginx one, arrived at from the other
   * direction. Checking only that the last ceiling is the default does not
   * catch it: the default is still last, it is just no longer alone.
   */
  const handles = [...live.matchAll(/handle(\s+@[A-Za-z_][\w]*)?\s*\{/g)]
    .map((m) => ({ matched: !!m[1], at: m.index }));
  const catchAlls = handles.filter((h) => !h.matched);
  check('caddy: there is exactly one catch-all handle', catchAlls.length === 1);
  check('caddy: ...and it is the LAST handle, so it cannot shadow the routes above it',
    catchAlls.length === 1 && catchAlls[0].at === Math.max(...handles.map((h) => h.at)));

  const lastSize = sizes[sizes.length - 1];
  check('caddy: the small default is the last ceiling in the file',
    !!lastSize && lastSize.bytes === B.BODY_LIMIT_DEFAULT);
}

/* -------------------------------------------------------------- the docs */
{
  const doc = await fs.readFile('deploy/README.md', 'utf8');
  for (const rule of B.BODY_LIMITS) {
    check(`docs: ${rule.location} is listed for operators`, doc.includes(rule.location));
    // The constant is the thing an operator changes; a table of bare numbers
    // goes stale the first time somebody raises one.
    const constant = rule.derivesFrom.split(' ')[0];
    check(`docs: ...alongside ${constant}, the constant it derives from`, doc.includes(constant));
  }
  check('docs: the env var that moves the video ceiling is named',
    doc.includes('MEDIA_MAX_VIDEO_MB'));
  check('docs: an operator is told how to tell an app 413 from a proxy 413',
    /413/.test(doc) && /PAYLOAD_TOO_LARGE/.test(doc));

  const env = await fs.readFile('.env.example', 'utf8');
  check('.env.example documents MEDIA_MAX_VIDEO_MB', env.includes('MEDIA_MAX_VIDEO_MB'));
  check('...and warns that the proxy must be raised with it',
    /proxy|nginx|Caddy/i.test(env.slice(Math.max(0, env.indexOf('MEDIA_MAX_VIDEO_MB') - 900), env.indexOf('MEDIA_MAX_VIDEO_MB') + 900)));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
