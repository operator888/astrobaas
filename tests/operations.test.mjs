#!/usr/bin/env node
/**
 * Four operational rows: upload scanning (C-76), file integrity (C-82),
 * per-request timings (C-157) and user switching (C-141).
 *
 * What they have in common is that each is easy to ship in a form that LOOKS
 * like the feature and is not one: a scanner that fails open silently, an
 * integrity manifest presented as tamper-proof, a profiler that changes what it
 * measures, an impersonation with no way back and no record. Most of what is
 * below is about those four failures rather than the happy paths.
 *
 * Run with:  node tests/operations.test.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { loadTs, ROOT } from './lib/load.mjs';

const S = await loadTs('src/lib/media/scan.ts');
const I = await loadTs('src/lib/integrity.ts');
const P = await loadTs('src/lib/request-profile.ts');
const A = await loadTs('src/lib/auth.ts');
const read = (rel) => fs.readFile(path.join(ROOT, rel), 'utf8');
const ingest = await read('src/lib/media/ingest.ts');
const privateFiles = await read('src/lib/media/private-files.ts');
const switchRoute = await read('src/pages/api/users/switch.ts');
const banner = await read('src/components/admin/SwitchBanner.astro');
const logoutRoute = await read('src/pages/api/auth/logout.ts');
const adminLayout = await read('src/layouts/AdminLayout.astro');
const integrityScript = await read('scripts/integrity.mjs');
const integritySource = await read('src/lib/integrity.ts');

let passed = 0;
const failures = [];
function check(name, fn) {
  try { const r = fn(); if (r instanceof Promise) throw new Error('async check needs await'); passed += 1; }
  catch (err) { failures.push(`${name}: ${err.message}`); }
}
async function acheck(name, fn) {
  try { await fn(); passed += 1; } catch (err) { failures.push(`${name}: ${err.message}`); }
}
function ok(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, what = '') {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
function code(src) {
  return src.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(?:\/\/|\s\*).*$/gm, '');
}

/* ══════════════════════════════ C-76 · upload scanning ══════════════════════ */

check('OFF unless an operator turns it on — it needs a daemon they must run', () => {
  eq(S.scanConfig({}).mode, 'off');
  eq(S.scanConfig({ MEDIA_SCAN: '' }).mode, 'off');
  for (const on of ['clamd', 'clamav', '1', 'on', 'ClamD']) {
    eq(S.scanConfig({ MEDIA_SCAN: on }).mode, 'clamd', on);
  }
});

check('FAIL CLOSED by default, and only the exact word opens it', () => {
  // "The scanner is down" and "the file is clean" are different answers. A
  // typo in this setting must not silently disable the refusal — that is the
  // entire failure it guards against.
  ok(S.scanConfig({}).failClosed === true);
  // Case and surrounding whitespace are normalised — an env file with
  // `MEDIA_SCAN_FAIL=OPEN ` means open, and pretending otherwise would be a
  // trap of a different kind.
  for (const open of ['open', 'OPEN', ' open ', 'Open']) {
    ok(S.scanConfig({ MEDIA_SCAN_FAIL: open }).failClosed === false, open);
  }
  // A TYPO must not open it. This is the case that matters: the operator
  // believes they are protected and there is nothing on screen to say
  // otherwise.
  for (const typo of ['opne', 'oepn', 'yes', 'true', '1', 'closed', 'off']) {
    ok(S.scanConfig({ MEDIA_SCAN_FAIL: typo }).failClosed === true, typo);
  }
});

check("clamd's three answers are read correctly", () => {
  eq(S.readClamReply('stream: OK\0'), { verdict: 'clean' });
  eq(S.readClamReply('stream: Eicar-Test-Signature FOUND\0'), { verdict: 'infected', signature: 'Eicar-Test-Signature' });
  ok(S.readClamReply('stream: INSTREAM size limit exceeded. ERROR\0').verdict === 'error');
});

check('AN ANSWER WE DO NOT UNDERSTAND IS NOT "CLEAN"', () => {
  // The most dangerous possible bug in this file.
  for (const weird of ['', '\0', 'something else entirely', 'okay', 'found']) {
    const v = S.readClamReply(weird);
    ok(v.verdict !== 'clean', `${JSON.stringify(weird)} read as clean`);
  }
});

check('the INSTREAM wire format is exactly what clamd expects', () => {
  // Getting this subtly wrong produces a scanner that answers OK to everything.
  const frames = S.instreamFrames(Buffer.from('abc'), 2);
  ok(frames.subarray(0, 10).toString('ascii') === 'zINSTREAM\0', frames.subarray(0, 10).toString());
  const body = frames.subarray(10);
  eq(body.readUInt32BE(0), 2, 'first chunk length');
  eq(body.subarray(4, 6).toString(), 'ab');
  eq(body.readUInt32BE(6), 1, 'second chunk length');
  eq(body.subarray(10, 11).toString(), 'c');
  eq(body.readUInt32BE(11), 0, 'the stream must end with a zero length');
  eq(body.length, 15, 'nothing after the terminator');
});

check('an empty file still produces a well-formed stream', () => {
  const frames = S.instreamFrames(Buffer.alloc(0));
  eq(frames.length, 14, 'command plus a bare terminator');
  eq(frames.subarray(10).readUInt32BE(0), 0);
});

await acheck('scanning is a NO-OP when off — no socket, no cost', async () => {
  let connected = false;
  const v = await S.scanBuffer(Buffer.from('x'), S.scanConfig({}), { connect: () => { connected = true; throw new Error('no'); } });
  eq(v, { verdict: 'skipped' });
  ok(!connected, 'it opened a socket with scanning off');
});

await acheck('an infected file is refused, and the SIGNATURE is named', async () => {
  const cfg = S.scanConfig({ MEDIA_SCAN: 'clamd' });
  const refusal = await S.refuseIfInfected(Buffer.from('x'), cfg, { connect: () => fakeClamd('stream: Eicar-Test-Signature FOUND\0') });
  ok(refusal && /Eicar-Test-Signature/.test(refusal), String(refusal));
});

await acheck('a clean file passes', async () => {
  const cfg = S.scanConfig({ MEDIA_SCAN: 'clamd' });
  eq(await S.refuseIfInfected(Buffer.from('x'), cfg, { connect: () => fakeClamd('stream: OK\0') }), null);
});

await acheck('AN UNREACHABLE SCANNER REFUSES THE UPLOAD', async () => {
  // The failure this whole module is shaped around: an operator who turned
  // scanning on believes they are protected.
  const cfg = S.scanConfig({ MEDIA_SCAN: 'clamd' });
  const refusal = await S.refuseIfInfected(Buffer.from('x'), cfg, { connect: () => fakeClamd(null, new Error('ECONNREFUSED')) });
  ok(refusal && /could not check/.test(refusal), String(refusal));
});

await acheck('...unless the operator explicitly said MEDIA_SCAN_FAIL=open', async () => {
  const cfg = S.scanConfig({ MEDIA_SCAN: 'clamd', MEDIA_SCAN_FAIL: 'open' });
  eq(await S.refuseIfInfected(Buffer.from('x'), cfg, { connect: () => fakeClamd(null, new Error('ECONNREFUSED')) }), null);
});

await acheck('a file too big to scan is not silently accepted', async () => {
  const cfg = S.scanConfig({ MEDIA_SCAN: 'clamd', MEDIA_SCAN_MAX_BYTES: '10' });
  const v = await S.scanBuffer(Buffer.alloc(11), cfg, { connect: () => { throw new Error('should not connect'); } });
  eq(v.verdict, 'error');
  ok(await S.refuseIfInfected(Buffer.alloc(11), cfg, {}) !== null, 'an oversized file was allowed');
});

check('BOTH upload doors scan — not just the admin one', () => {
  // A stranger's file on a public form matters MORE than a colleague's upload,
  // not less: it is downloaded later by whoever handles the submission. A scan
  // on one door only would protect the person least at risk.
  //
  // The CALL, not the import. The first version of this check matched
  // `import { refuseIfInfected }`, so deleting the actual call still passed —
  // the same "matched something else in the file" mistake as the capability
  // gate in ai-tasks.test.mjs.
  const called = (src) => /(?<!import [^\n]*)\brefuseIfInfected\(buf\)/.test(
    code(src).split('\n').filter((l) => !l.trimStart().startsWith('import ')).join('\n'),
  );
  ok(called(ingest), 'the media library does not scan');
  ok(called(privateFiles), 'public form uploads do not scan');
  // ...and the refusal is acted on rather than computed and dropped.
  for (const [what, src] of [['ingest', ingest], ['private files', privateFiles]]) {
    ok(/if \(infected\) return \{ ok: false, error: infected \}/.test(code(src)), `${what}: the verdict is ignored`);
  }
});

check('the scan happens BEFORE the re-encode', () => {
  // Re-encoding a raster can destroy a signature while leaving a polyglot's
  // other half intact, so a scan after it reports clean on a file that is not.
  //
  // Compared on the CALL, not the identifier: `code()` strips comments but not
  // imports, so the first occurrence of `refuseIfInfected` was line 26 —
  // `import { refuseIfInfected } …` — which is before everything. The check
  // measured the position of an import statement and could never fail.
  //
  // Measured against the operations that TRANSFORM OR PERSIST the bytes, not
  // against the sniff.
  //
  // It used to compare the scan's position to `const sniffed = sniff(buf)`, and
  // that marker disappeared the day video arrived: the size ceiling depends on
  // what the file IS, so the sniff moved above it and the assertion started
  // failing on a rename while the security property was untouched. It failed
  // LOUDLY rather than silently, which is why this is a correction and not an
  // incident — but it was measuring a proxy.
  //
  // Sniffing reads a few header bytes of a buffer already in memory. It cannot
  // destroy a signature, so it was never the thing the scan had to precede. The
  // write and the re-encode are.
  const src = code(ingest).split('\n').filter((l) => !l.trimStart().startsWith('import ')).join('\n');
  const scan = src.indexOf('refuseIfInfected(buf)');
  ok(scan >= 0, 'the media library does not scan at all');

  for (const [what, marker] of [
    ['the file is written', 'fs.writeFile(target'],
    ['camera metadata is stripped', 'stripImageMetadata(buf'],
    ['derivatives are generated', 'generateDerivatives('],
  ]) {
    const at = src.indexOf(marker);
    ok(at >= 0, `the marker for "${what}" moved — this check needs updating`);
    ok(scan < at, `the scan runs AFTER ${what}`);
  }
});

/* ══════════════════════════════ C-82 · file integrity ══════════════════════ */

check('a manifest is sorted, so two machines produce the same bytes', () => {
  const m = I.buildManifest([['b.js', 'h2'], ['a.js', 'h1'], ['c/d.js', 'h3']], 'now');
  eq(Object.keys(m.files), ['a.js', 'b.js', 'c/d.js']);
});

check('THE DIGEST IGNORES THE TIMESTAMP', () => {
  // Regenerating an unchanged build must produce the same digest, or an
  // operator comparing two deploys reads "different, because time passed".
  const a = I.buildManifest([['a.js', 'h1']], '2020-01-01T00:00:00.000Z');
  const b = I.buildManifest([['a.js', 'h1']], '2026-09-02T00:00:00.000Z');
  eq(I.manifestDigest(a), I.manifestDigest(b));
});

check('...and changes when ANY file changes', () => {
  const a = I.buildManifest([['a.js', 'h1']], 'now');
  const b = I.buildManifest([['a.js', 'h2']], 'now');
  ok(I.manifestDigest(a) !== I.manifestDigest(b));
});

check('three categories, because they mean different things', () => {
  const m = I.buildManifest([['keep.js', 'h1'], ['edited.js', 'h2'], ['gone.js', 'h3']], 'now');
  const diff = I.diffManifest(m, { 'keep.js': 'h1', 'edited.js': 'CHANGED', 'new.js': 'h9' });
  eq(diff.changed, ['edited.js']);
  eq(diff.removed, ['gone.js']);
  eq(diff.added, ['new.js'], 'an ADDED file is what a web shell is');
  ok(!diff.ok);
});

check('an unchanged tree is ok', () => {
  const m = I.buildManifest([['a.js', 'h1']], 'now');
  ok(I.diffManifest(m, { 'a.js': 'h1' }).ok);
  eq(I.describeDiff(I.diffManifest(m, { 'a.js': 'h1' })), 'integrity: unchanged');
});

check('A FILE NAMED LIKE AN OBJECT KEY IS STILL SEEN', () => {
  // `'toString' in {}` is TRUE, so a plain object made `dist/toString`,
  // `dist/constructor` and `dist/valueOf` invisible — in the ADDED category,
  // which this module says is the one people forget to look for and the one a
  // web shell is. Verified end to end against a real dist tree as well.
  const m = I.buildManifest([['a.js', 'h1']], 'now');
  const diff = I.diffManifest(m, { 'a.js': 'h1', toString: 'x', constructor: 'y', valueOf: 'z' });
  eq(diff.added.sort(), ['constructor', 'toString', 'valueOf']);
  ok(!diff.ok);
});

check('...and one named __proto__ is actually recorded', () => {
  // `files['__proto__'] = hash` on a plain object is a silent no-op — the file
  // was never even hashed, so it could not be missed later either.
  const m = I.buildManifest([['__proto__', 'h9'], ['a.js', 'h1']], 'now');
  eq(Object.keys(m.files).sort(), ['__proto__', 'a.js']);
  eq(I.diffManifest(m, { 'a.js': 'h1' }).removed, ['__proto__'], 'a deleted __proto__ was not noticed');
});

check('the walk reports SYMLINKS rather than skipping them', () => {
  // `readdir` returns lstat-semantics entries, so a symlink is neither
  // isFile() nor isDirectory() — the first version skipped them entirely, and
  // `dist/shell.js -> /tmp/payload.js` was invisible to every command.
  ok(/isSymbolicLink\(\)/.test(integrityScript), 'symlinks are still skipped');
  ok(/symlink:/.test(integrityScript), 'a symlink is hashed as a file rather than by its target');
});

check('a corrupt manifest does not throw — it reports everything as added', () => {
  const diff = I.diffManifest({}, { 'a.js': 'h1' });
  eq(diff.added, ['a.js']);
  ok(!diff.ok);
});

check('THE LIMITATION IS WRITTEN DOWN where an operator will read it', () => {
  // The manifest sits on the same disk as the files it describes. Presenting
  // it as tamper-proof would be the dangerous version of this feature.
  ok(/not tamper-proof/i.test(integritySource), 'the module does not say so');
  ok(/not this server/i.test(integrityScript), 'the command does not tell them to record the digest off-box');
});

check('verify exits non-zero, so it drops into cron', () => {
  ok(/process\.exit\(1\)/.test(integrityScript), 'a difference does not fail the command');
});

check('the manifest does not record ITSELF', () => {
  ok(/e\.rel !== MANIFEST_NAME/.test(integrityScript), 'writing the manifest would change the tree it describes');
});

/* ══════════════════════════════ C-157 · request timings ═══════════════════ */

check('OFF by default: a list of recent URLs is a decision, not a default', () => {
  ok(P.profilingEnabled({}) === false);
  ok(P.profilingEnabled({ PROFILE_REQUESTS: '1' }) === true);
});

await acheck('A SPAN NEVER CHANGES WHAT THE CALLER SEES', () => {
  // A profiler that swallows an exception is worse than no profiler.
  return (async () => {
    P.clearProfiles();
    eq(await P.span('x', async () => 42), 42, 'with profiling off');
    let caught = null;
    try { await P.span('x', async () => { throw new Error('boom'); }); } catch (e) { caught = e.message; }
    eq(caught, 'boom', 'the error was swallowed');
  })();
});

check('nothing is recorded while profiling is off', () => {
  P.clearProfiles();
  P.beginProfile();
  P.addSpan('db', 5);
  eq(P.endProfile({ method: 'GET', path: '/', status: 200, ms: 10 }), null);
  eq(P.recentProfiles(), []);
});

check('repeated spans AGGREGATE with a count', () => {
  // "40 × 2 ms of database" is the interesting shape, and it is invisible if
  // each call overwrites the last.
  process.env.PROFILE_REQUESTS = '1';
  try {
    P.clearProfiles();
    P.beginProfile();
    P.addSpan('db.posts', 2);
    P.addSpan('db.posts', 3);
    P.addSpan('render', 10);
    const profile = P.endProfile({ method: 'GET', path: '/blog', status: 200, ms: 40 });
    eq(profile.spans.map((s) => [s.name, s.ms, s.count]), [['render', 10, 1], ['db.posts', 5, 2]], 'sorted slowest first');
    eq(profile.unaccounted, 25, 'the part nothing claimed');
  } finally { delete process.env.PROFILE_REQUESTS; }
});

check('unaccounted never goes negative', () => {
  // Overlapping spans can exceed the wall clock; a negative on screen reads as
  // a bug in the page rather than in the arithmetic.
  process.env.PROFILE_REQUESTS = '1';
  try {
    P.clearProfiles();
    P.beginProfile();
    P.addSpan('a', 100);
    eq(P.endProfile({ method: 'GET', path: '/', status: 200, ms: 10 }).unaccounted, 0);
  } finally { delete process.env.PROFILE_REQUESTS; }
});

check('THE BUFFER IS BOUNDED — unbounded is a memory leak with a nice name', () => {
  process.env.PROFILE_REQUESTS = '1';
  try {
    P.clearProfiles();
    for (let i = 0; i < P.PROFILE_BUFFER + 25; i += 1) {
      P.beginProfile();
      P.endProfile({ method: 'GET', path: `/p${i}`, status: 200, ms: i });
    }
    eq(P.recentProfiles().length, P.PROFILE_BUFFER);
    eq(P.recentProfiles()[0].path, `/p${P.PROFILE_BUFFER + 24}`, 'newest first');
  } finally { delete process.env.PROFILE_REQUESTS; }
});

check('per-path totals, which is where a real problem shows up', () => {
  // One 900 ms request is a cold cache. Ninety 200 ms ones are the thing to
  // fix, and that is invisible in a list sorted by duration.
  process.env.PROFILE_REQUESTS = '1';
  try {
    P.clearProfiles();
    for (const [p, ms] of [['/a', 900], ['/b', 200], ['/b', 200], ['/b', 200], ['/b', 200], ['/b', 200], ['/b', 200]]) {
      P.beginProfile();
      P.endProfile({ method: 'GET', path: p, status: 200, ms });
    }
    const summary = P.profileSummary();
    eq(summary[0].path, '/b', 'the busy path should lead on total time');
    eq(summary[0].count, 6);
    eq(summary[0].avgMs, 200);
    eq(P.slowestProfiles(1)[0].path, '/a', 'and the single slowest is still findable');
  } finally { delete process.env.PROFILE_REQUESTS; }
});

check('Server-Timing names are sanitised to what the grammar allows', () => {
  // A span called `db (posts)` produces a header the browser drops SILENTLY,
  // taking every other timing with it.
  const header = P.serverTimingHeader([{ name: 'db (posts)', ms: 5, count: 1 }], 40);
  ok(/db_.posts.;dur=5/.test(header), header);
  ok(!/[()]/.test(header), header);
  ok(/total;dur=40/.test(header), header);
});

/* ══════════════════════════════ C-141 · user switching ════════════════════ */

process.env.AUTH_SECRET = process.env.AUTH_SECRET || 'operations-test-secret-please-change';

check('a switch-back token round-trips, and names WHO is being acted as', () => {
  const t = A.signSwitchBack('admin-1', 3, 'editor-9');
  eq(A.verifySwitchBack(t), { uid: 'admin-1', sv: 3, acting: 'editor-9' });
});

await acheck('A TOKEN WITHOUT `acting` IS REFUSED', async () => {
  // That field is the whole reason this is safe to honour. A token minted
  // before it existed is exactly the token this check was added to stop
  // trusting — so "missing" must fail closed rather than default to something.
  const legacy = A.signPending2fa('x');  // a well-formed token of another kind
  eq(A.verifySwitchBack(legacy), null);
  const handMade = Buffer.from(JSON.stringify({ uid: 'admin-1', sv: 0, p: 'switch', exp: Date.now() + 60000 })).toString('base64url');
  const crypto = await import('node:crypto');
  const sig = crypto.createHmac('sha256', process.env.AUTH_SECRET).update(handMade).digest('base64url');
  eq(A.verifySwitchBack(`${handMade}.${sig}`), null, 'a correctly-signed token with no `acting` was honoured');
});

check('A FORGED OR TAMPERED TOKEN IS NOTHING', () => {
  const t = A.signSwitchBack('admin-1', 3, 'editor-9');
  for (const bad of [null, '', 'nope', t.slice(0, -1) + 'x', t.replace('.', ''), `${t}x`]) {
    eq(A.verifySwitchBack(bad), null, String(bad).slice(0, 20));
  }
});

check('THE PURPOSE TAG: a 2FA token is not a switch-back token', () => {
  // Without it the two are the same signed blob with different fields, and one
  // minted for a five-minute password step becomes an hour of impersonation.
  eq(A.verifySwitchBack(A.signPending2fa('admin-1')), null);
  eq(A.verifyPending2fa(A.signSwitchBack('admin-1', 0, 'editor-9')), null);
});

check('it expires — a forgotten switch is not a spare login', () => {
  ok(A.SWITCH_TTL_MS <= 2 * 60 * 60 * 1000, `${A.SWITCH_TTL_MS} ms is too long`);
});

check('ADMIN ONLY, and never onto another admin', () => {
  const src = code(switchRoute);
  ok(/Only an admin can switch user/.test(src), 'not admin-gated');
  ok(/target\.role === 'admin'/.test(src), 'an admin can be impersonated');
  ok(/You cannot act as another admin/.test(src), 'no refusal message');
});

check('NO CHAINS: already switched must switch back first', () => {
  // Nested impersonation makes "who was really acting" unanswerable, which is
  // the one question this must always be able to answer.
  ok(/already acting as someone else/i.test(switchRoute), 'chains are allowed');
});

check('an inactive account cannot be impersonated', () => {
  ok(/target\.status !== 'active'/.test(code(switchRoute)), 'a disabled account can be acted as');
});

check('SWITCHING BACK RE-CHECKS the admin, it does not trust the cookie', () => {
  // An admin deactivated or revoked while impersonating does not get their
  // session handed back.
  const src = code(switchRoute);
  ok(/admin\.status !== 'active'/.test(src), 'status is not re-checked');
  ok(/session_version \?\? 0\) !== back\.sv/.test(src), 'the session version is not re-checked');
  ok(/admin\.role !== 'admin'/.test(src), 'a demoted admin still gets back in');
});

check('THE WAY BACK IS ONLY FOR THE SESSION IT WAS ISSUED FOR', () => {
  // Without this, a switch cookie left on a shared browser is a one-click
  // admin session for whoever signs in next: the admin switches to Bob, logs
  // out — which used to clear only the session cookie — an editor signs in
  // within the hour, sees the banner, presses "Back to my account", and is
  // handed the admin's session. An audit found exactly that path.
  const src = code(switchRoute);
  ok(/locals\.user\.id !== back\.acting/.test(src), 'any session can spend the token');
  ok(/clearCookie\(SWITCH_COOKIE\)/.test(src), 'a refused token is left in place to try again');
});

check('LOGGING OUT CLEARS THE SWITCH COOKIE TOO', () => {
  // Second door, and the one that stops a stranger seeing somebody else's
  // impersonation banner at all.
  // The CALL, not the identifier: the import line alone satisfied the first
  // version of this check, so deleting the actual clear still passed. That is
  // the third time in this suite — grep for what the code DOES, never for a
  // name that also appears in an import.
  ok(/clearCookie\(SWITCH_COOKIE\)/.test(
    code(logoutRoute).split('\n').filter((l) => !l.trimStart().startsWith('import ')).join('\n'),
  ), 'logout leaves the switch cookie behind');
  // `headers.append`, not an object literal: an object has ONE `Set-Cookie`
  // key, so the second cookie silently replaces the first — which is how the
  // first version of this fix left the switch cookie in place while looking
  // correct.
  ok(/headers\.append\('Set-Cookie'/.test(code(logoutRoute)), 'two cookies cannot go out in one object literal');
});

check('THE IMPERSONATED SESSION EXPIRES WITH THE SWITCH', () => {
  // It was minted with `sessionTtlMs` — 24 HOURS. So the switch cookie expired
  // after an hour, the banner vanished, the way back stopped working, and the
  // browser stayed authenticated as somebody else until the next day with
  // nothing on screen saying so. The "spare login" the hour was meant to
  // prevent, arrived at from the other direction.
  const post = code(switchRoute).slice(0, code(switchRoute).indexOf('export const DELETE'));
  ok(/SESSION_COOKIE, session, \{ maxAgeMs: SWITCH_TTL_MS/.test(post), 'the impersonated session outlives the switch');
});

check('switching back is NOT admin-gated, and that is deliberate', () => {
  // The caller is currently the impersonated user, whose role is not admin.
  // The token is the authorisation and it names exactly one account.
  const del = switchRoute.slice(switchRoute.indexOf('export const DELETE'));
  ok(!/Only an admin/.test(code(del)), 'the way back requires a role the caller no longer has');
  ok(/verifySwitchBack/.test(del), 'the way back is not token-authorised');
});

check('both directions are audited, with the REAL admin as the actor', () => {
  const src = code(switchRoute);
  ok(/AUDIT\.USER_SWITCH_START/.test(src) && /AUDIT\.USER_SWITCH_END/.test(src), 'one direction is unaudited');
  ok(/actor: me\.id/.test(src), 'the start is not attributed to the admin');
  ok(/actor: admin\.id/.test(src), 'the end is not attributed to the admin');
});

check('THE BANNER IS ON EVERY ADMIN SCREEN', () => {
  // An impersonation you can forget you are in is the failure mode.
  ok(/<SwitchBanner \/>/.test(adminLayout), 'the layout does not render it');
  ok(/verifySwitchBack/.test(banner), 'the banner asks about a prop instead of the signed cookie');
});

check('the banner offers the way back, and says what is being recorded', () => {
  ok(/switch-back/.test(banner), 'no way back');
  ok(/recorded as them/.test(banner), 'it does not say whose name the actions carry');
});

if (failures.length) {
  console.error(`\n✗ operations: ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error(`  · ${f}`);
  process.exit(1);
}
console.log(`✓ operations: ${passed} passed`);

/** A stand-in clamd: connects, then answers (or errors). */
function fakeClamd(reply, error) {
  const socket = new EventEmitter();
  socket.setTimeout = () => {};
  socket.destroy = () => {};
  socket.write = () => {
    setImmediate(() => {
      if (error) socket.emit('error', error);
      else socket.emit('data', Buffer.from(reply));
    });
  };
  setImmediate(() => socket.emit('connect'));
  return socket;
}
