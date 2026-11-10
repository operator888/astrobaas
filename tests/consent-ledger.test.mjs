#!/usr/bin/env node
/**
 * The consent ledger, the newsletter on top of it, and the plugin seams
 * `host.consent.*` and `host.mail.send`.
 *
 * ## What must hold
 *
 *   - APPEND-ONLY: every row is snapshotted the moment it is first seen and must
 *     be byte-identical at the end of a full run of normal operation (record,
 *     confirm, withdraw, the routes, the migration, the export, mail). The ONLY
 *     rewrite is the erasure, checked separately: address → sha256, ip/ua gone,
 *     everything else untouched. On the relational driver the database itself
 *     refuses DELETE and any other UPDATE. And no update/delete path exists in
 *     the source except the erasure's.
 *   - text_hash is sha256 of the exact UTF-8 text: the same Greek text gives
 *     the same hash; a different normalisation of it does not.
 *   - double opt-in: `confirm` confirms only when the latest row is a grant. A
 *     game verification with NO newsletter consent subscribes nobody.
 *   - the existing confirm + unsubscribe routes keep working, and now write the
 *     ledger; the one-click POST needs no session.
 *   - the export: only granted + confirmed + not withdrawn — every combination.
 *   - the migration records existing subscribers as `source: 'migration'`,
 *     idempotently, so the export keeps them.
 *   - host.mail.send goes through the configured transport (a capture
 *     transport here — never live); bulk mail only to confirmed contacts, and
 *     always with RFC 8058 headers. Core campaign mail carries them too.
 *   - nothing reaches the public change feed.
 *   - all of it on lowdb, libSQL and relational.
 *
 * Run with:  node tests/consent-ledger.test.mjs
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTs, loadTogether, ROOT } from './lib/load.mjs';

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) pass += 1;
  else { fail += 1; console.error(`✗ ${name}`); }
}
const sha = (s) => crypto.createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------------- child --- */
if (process.env.CONSENT_CHILD) {
  const entry = path.join(ROOT, 'node_modules', '.cache', `consent-ledger-entry-${process.pid}.ts`);
  await fs.mkdir(path.dirname(entry), { recursive: true });
  const abs = (rel) => JSON.stringify(path.join(ROOT, rel));
  await fs.writeFile(entry, [
    `export { LocalDB } from ${abs('src/lib/localdb.ts')};`,
    `export * as Svc from ${abs('src/lib/consent-service.ts')};`,
    `export * as L from ${abs('src/lib/consent-ledger.ts')};`,
    `export * as NC from ${abs('src/lib/newsletter-confirm.ts')};`,
    `export * as Email from ${abs('src/lib/email.ts')};`,
    `export * as Gdpr from ${abs('src/lib/gdpr.ts')};`,
    `export { MIGRATIONS } from ${abs('src/lib/migrations.ts')};`,
    `export { maybeSendCampaign } from ${abs('src/lib/scheduler.ts')};`,
    `export { loadExternalPlugins } from ${abs('src/plugins/external.ts')};`,
    `export { GET as confirmGET } from ${abs('src/pages/api/newsletter/confirm.ts')};`,
    `export { GET as unsubGET, POST as unsubPOST } from ${abs('src/pages/api/newsletter/unsubscribe.ts')};`,
    `export { POST as subDeletePOST } from ${abs('src/pages/api/newsletter/subscribers/delete.ts')};`,
    `export { GET as exportGET } from ${abs('src/pages/api/newsletter/subscribers/export.ts')};`,
    `export { GET as ledgerGET } from ${abs('src/pages/api/consent/ledger.ts')};`,
    `export { POST as adminWithdrawPOST } from ${abs('src/pages/api/consent/ledger/withdraw.ts')};`,
    `export { GET as publicWithdrawGET, POST as publicWithdrawPOST } from ${abs('src/pages/api/consent/withdraw.ts')};`,
  ].join('\n'));
  let M;
  try {
    M = await loadTs(path.relative(ROOT, entry), 'consentledger');
  } finally {
    await fs.rm(entry, { force: true });
  }
  const { LocalDB, Svc, L, NC, Email } = M;
  await LocalDB.init();
  const out = {};

  /* ---- capture: mail and webhooks ---- */
  const sent = [];
  let failNext = false;
  Email.setEmailTransport({
    name: 'capture',
    async send(msg) {
      if (failNext) { failNext = false; throw new Error('550 mailbox unavailable'); }
      sent.push(JSON.parse(JSON.stringify(msg)));
      if (msg.to) return;
    },
  });
  const hooks = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try { hooks.push(JSON.parse(body)); } catch { /* ignore */ }
      res.writeHead(200); res.end('ok');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const hookUrl = `http://127.0.0.1:${server.address().port}/hook`;
  await LocalDB.createWebhook({ url: hookUrl, events: ['*'], secret: 'consent-test-secret', active: true });
  const eventsFor = (name) => hooks.filter((h) => h.event === name);

  /* ---- append-only watcher ---- */
  const firstSeen = new Map();
  let maxCount = 0;
  let shrank = false;
  const observe = async () => {
    const rows = await LocalDB.getConsentRows();
    if (rows.length < maxCount) shrank = true;
    maxCount = Math.max(maxCount, rows.length);
    for (const r of rows) if (!firstSeen.has(r.id)) firstSeen.set(r.id, JSON.stringify(r));
    return rows;
  };
  const rowsOf = async (email, purpose) => (await LocalDB.getConsentRows({ email, purpose }));

  /* ---- the plugin host, through the REAL loader ---- */
  const probe = path.join(process.env.CONSENT_DIR, 'probe-plugin.mjs');
  await fs.writeFile(probe, [
    'export default (host) => {',
    '  globalThis.__consentHost = host;',
    "  return host.definePlugin({ id: 'consent-probe', name: 'Consent probe', version: '1.0.0' });",
    '};',
  ].join('\n'));
  const loaded = await M.loadExternalPlugins({ ASTROBAAS_PLUGINS: probe });
  const host = globalThis.__consentHost;
  out.loaded = loaded.failed.length === 0 && loaded.plugins.map((p) => p.id).join() === 'consent-probe';
  out.shape = {
    record: typeof host?.consent?.record,
    confirm: typeof host?.consent?.confirm,
    withdraw: typeof host?.consent?.withdraw,
    withdrawUrl: typeof host?.consent?.withdrawUrl,
    send: typeof host?.mail?.send,
  };

  /* ---- 1. Greek text, the hash, and the game without newsletter consent ---- */
  const GREEK = 'Συμφωνώ με τους όρους του παιχνιδιού «Γύρνα τον τροχό». Έκδοση 3 — Οπτικά Γωνία.';
  const player = 'Παίκτης.One@Example.GR';
  const g1 = await host.consent.record({
    email: player, purpose: 'game_terms', granted: true, version: '3', text: GREEK,
    ip: '203.0.113.7', ua: 'Mozilla/5.0 (test)', source: 'campaign-games',
  });
  const g2 = await host.consent.record({
    email: 'second@example.gr', purpose: 'game_terms', granted: true, version: '3', text: GREEK,
    source: 'campaign-games',
  });
  await observe();
  out.greek = {
    hash: g1.text_hash,
    sameForSameText: g1.text_hash === g2.text_hash,
    shape: typeof g1.id === 'string' && typeof g1.at === 'string',
  };
  const playerRows = await rowsOf('παίκτης.one@example.gr', 'game_terms');
  out.greek.normalisedEmail = playerRows.length === 1;
  out.greek.ipKept = playerRows[0]?.ip === '203.0.113.7' && playerRows[0]?.ua === 'Mozilla/5.0 (test)';
  out.greek.noTextStored = !JSON.stringify(playerRows).includes('παιχνιδιού');

  const beforeGame = (await LocalDB.getConsentRows()).length;
  const subsBefore = (await LocalDB.getSubscribers()).length;
  const gameConfirm = await host.consent.confirm({ email: player, purpose: 'newsletter', source: 'campaign-games', ip: '203.0.113.7' });
  // ...and the game's own terms CAN be confirmed (it was granted).
  const termsConfirm = await host.consent.confirm({ email: player, purpose: 'game_terms', source: 'campaign-games' });
  await sleep(300);
  out.game = {
    newsletterConfirm: gameConfirm,
    termsConfirm,
    rowsAdded: (await LocalDB.getConsentRows()).length - beforeGame,
    newsletterRows: (await rowsOf('παίκτης.one@example.gr', 'newsletter')).length,
    subscribersAdded: (await LocalDB.getSubscribers()).length - subsBefore,
    subscribedEvents: eventsFor('newsletter.subscribed').length,
  };
  await observe();

  /* ---- 2. a plugin's newsletter double opt-in ---- */
  const reader = 'reader@example.com';
  await host.consent.record({ email: reader, purpose: 'newsletter', granted: true, version: 'n1', text: 'Send me news.', source: 'campaign-games' });
  out.pluginOptIn = { beforeConfirm: (await LocalDB.getSubscribers()).some((s) => s.email === reader) };
  out.pluginOptIn.confirm = await host.consent.confirm({ email: reader, purpose: 'newsletter', source: 'campaign-games' });
  const rowsAfterFirst = (await rowsOf(reader, 'newsletter')).length;
  out.pluginOptIn.again = await host.consent.confirm({ email: reader, purpose: 'newsletter', source: 'campaign-games' });
  out.pluginOptIn.secondConfirmWroteNothing = (await rowsOf(reader, 'newsletter')).length === rowsAfterFirst;
  out.pluginOptIn.subscribed = (await LocalDB.getSubscribers()).filter((s) => s.email === reader).length;
  await sleep(400);
  const subEv = eventsFor('newsletter.subscribed');
  out.pluginOptIn.events = subEv.length;
  out.pluginOptIn.payload = subEv[0]?.data ?? null;
  out.pluginOptIn.confirmedEvents = eventsFor('subscriber.confirmed').filter((h) => h.data?.email === reader).length;
  out.pluginOptIn.lastRow = (await rowsOf(reader, 'newsletter')).at(-1);
  await observe();

  /* ---- 3. the export, every combination ---- */
  const text = 'Newsletter wording v1';
  const rec = (email, granted) => host.consent.record({ email, purpose: 'newsletter', granted, version: 'v1', text, source: 'test' });
  const conf = (email) => host.consent.confirm({ email, purpose: 'newsletter', source: 'test' });
  const wd = (email) => host.consent.withdraw({ email, purpose: 'newsletter', source: 'test' });
  await rec('a-granted-only@example.com', true);
  await rec('b-confirmed@example.com', true); await conf('b-confirmed@example.com');
  await rec('c-withdrawn@example.com', true); await conf('c-withdrawn@example.com'); await wd('c-withdrawn@example.com');
  await rec('d-denied@example.com', false);
  out.deniedConfirm = await conf('d-denied@example.com');
  await rec('e-regranted@example.com', true); await conf('e-regranted@example.com'); await wd('e-regranted@example.com');
  await rec('e-regranted@example.com', true);
  out.regrantedConfirmBeforeClick = (await Svc.consentStateFor('e-regranted@example.com', 'newsletter')).confirmed;
  await rec('f-reconfirmed@example.com', true); await conf('f-reconfirmed@example.com'); await wd('f-reconfirmed@example.com');
  await rec('f-reconfirmed@example.com', true); await conf('f-reconfirmed@example.com');
  // A newer grant on top of a confirmation (re-signup under new wording): still in.
  await rec('g-newgrant@example.com', true); await conf('g-newgrant@example.com'); await rec('g-newgrant@example.com', true);
  await observe();
  const exp = (await Svc.newsletterExport()).map((c) => c.email);
  out.exportList = exp;
  out.cWithdrawnSubscribed = (await LocalDB.getSubscribers()).some((s) => s.email === 'c-withdrawn@example.com');
  out.withdrawTwice = { before: (await rowsOf('c-withdrawn@example.com', 'newsletter')).length };
  await wd('c-withdrawn@example.com');
  out.withdrawTwice.after = (await rowsOf('c-withdrawn@example.com', 'newsletter')).length;
  await observe();

  /* ---- 4. core routes: confirm, unsubscribe, admin delete, export, ledger, withdraw ---- */
  const origin = 'https://shop.example.com';
  const human = 'human@example.com';
  const greekConsent = { version: 'storefront-2', text_hash: sha('Θέλω το newsletter.') };
  const confirmTok = NC.makeConfirmToken(human, greekConsent);
  const req = (u, init) => new Request(u, init);
  const redirect = (to, status) => new Response(null, { status, headers: { Location: to } });
  const r1 = await M.confirmGET({ url: new URL(`${origin}/api/newsletter/confirm?token=${encodeURIComponent(confirmTok)}`), redirect });
  const humanRows = await rowsOf(human, 'newsletter');
  out.route = {
    confirmStatus: r1.status,
    confirmLocation: r1.headers.get('Location') ?? '',
    rows: humanRows.map((r) => ({ granted: r.granted, source: r.source, confirmed: !!r.confirmed_at, version: r.version, hash: r.text_hash })),
    subscribed: (await LocalDB.getSubscribers()).some((s) => s.email === human),
  };
  await M.confirmGET({ url: new URL(`${origin}/api/newsletter/confirm?token=${encodeURIComponent(confirmTok)}`), redirect });
  out.route.secondClickRows = (await rowsOf(human, 'newsletter')).length;
  out.route.secondClickSubs = (await LocalDB.getSubscribers()).filter((s) => s.email === human).length;
  await sleep(300);
  out.route.confirmedEvents = eventsFor('subscriber.confirmed').filter((h) => h.data?.email === human).length;
  // An OLD link, minted before the ledger: recorded under the default wording.
  const oldTok = NC.makeConfirmToken('old-link@example.com');
  await M.confirmGET({ url: new URL(`${origin}/api/newsletter/confirm?token=${encodeURIComponent(oldTok)}`), redirect });
  out.route.oldLink = (await rowsOf('old-link@example.com', 'newsletter')).map((r) => r.version);
  const forged = await M.confirmGET({ url: new URL(`${origin}/api/newsletter/confirm?token=nope`), redirect });
  out.route.forged = forged.headers.get('Location');
  await observe();

  // Export through the ROUTE.
  const expAnon = await M.exportGET({ locals: {}, url: new URL(`${origin}/api/newsletter/subscribers/export`) });
  const expJson = await (await M.exportGET({ locals: { user: { role: 'admin' } }, url: new URL(`${origin}/api/newsletter/subscribers/export`) })).json();
  const expCsv = await M.exportGET({ locals: { user: { role: 'editor' } }, url: new URL(`${origin}/api/newsletter/subscribers/export?format=csv`) });
  out.exportRoute = {
    anon: expAnon.status,
    emails: (expJson?.data?.subscribers ?? []).map((c) => c.email),
    csvType: expCsv.headers.get('Content-Type'),
    csv: await expCsv.text(),
  };

  // One-click unsubscribe: a POST with NO session, the token in the query.
  const unsubTok = NC.makeUnsubscribeToken(human);
  const one = await M.unsubPOST({ url: new URL(`${origin}/api/newsletter/unsubscribe?token=${encodeURIComponent(unsubTok)}`), locals: {} });
  await sleep(300);
  const humanAfter = await rowsOf(human, 'newsletter');
  out.oneClick = {
    status: one.status,
    lastRow: humanAfter.at(-1),
    subscribed: (await LocalDB.getSubscribers()).some((s) => s.email === human),
    unsubEvents: eventsFor('subscriber.unsubscribed').filter((h) => h.data?.email === human).length,
    inExport: (await Svc.newsletterExport()).some((c) => c.email === human),
  };
  const bad = await M.unsubPOST({ url: new URL(`${origin}/api/newsletter/unsubscribe?token=forged`), locals: {} });
  out.oneClick.badStatus = bad.status;
  // THE STALE LINK: the original confirmation email, opened again after the
  // person left (by them, or by a scanner), must not put them back.
  const humanRowsBefore = (await rowsOf(human, 'newsletter')).length;
  const stale = await M.confirmGET({ url: new URL(`${origin}/api/newsletter/confirm?token=${encodeURIComponent(confirmTok)}`), redirect });
  out.stale = {
    location: stale.headers.get('Location'),
    rowsAdded: (await rowsOf(human, 'newsletter')).length - humanRowsBefore,
    subscribed: (await LocalDB.getSubscribers()).some((s) => s.email === human),
  };
  // ...while a NEW signup after leaving works.
  await sleep(5);
  const fresh = await M.confirmGET({ url: new URL(`${origin}/api/newsletter/confirm?token=${encodeURIComponent(NC.makeConfirmToken(human, greekConsent))}`), redirect });
  out.stale.freshLocation = fresh.headers.get('Location');
  out.stale.freshExported = (await Svc.newsletterExport()).some((c) => c.email === human);
  // A confirmed subscriber signing up under NEW wording: that wording is recorded and confirmed.
  const newWording = { version: 'storefront-3', text_hash: sha('Νέο κείμενο.') };
  await M.confirmGET({ url: new URL(`${origin}/api/newsletter/confirm?token=${encodeURIComponent(NC.makeConfirmToken(human, newWording))}`), redirect });
  out.stale.newWording = (await rowsOf(human, 'newsletter')).slice(-2).map((r) => `${r.version}:${r.confirmed_at ? 'c' : 'g'}`);
  // Leave again, so the rest of the run sees the address withdrawn.
  await M.unsubPOST({ url: new URL(`${origin}/api/newsletter/unsubscribe?token=${encodeURIComponent(unsubTok)}`), locals: {} });
  // GET (the link a human clicks) records a withdrawal with its own source.
  await rec('linkclick@example.com', true); await conf('linkclick@example.com');
  await M.unsubGET({ url: new URL(`${origin}/api/newsletter/unsubscribe?token=${encodeURIComponent(NC.makeUnsubscribeToken('linkclick@example.com'))}`), redirect });
  out.oneClick.getSource = (await rowsOf('linkclick@example.com', 'newsletter')).at(-1)?.source;
  await observe();

  // The operator's Remove button.
  await rec('removed-by-admin@example.com', true); await conf('removed-by-admin@example.com');
  const subRow = (await LocalDB.getSubscribers()).find((s) => s.email === 'removed-by-admin@example.com');
  const del = await M.subDeletePOST({
    request: req(`${origin}/x`, { method: 'POST', body: JSON.stringify({ id: subRow?.id }), headers: { 'Content-Type': 'application/json' } }),
    locals: { user: { role: 'admin', id: 'u1' } },
  });
  const adminRows = await rowsOf('removed-by-admin@example.com', 'newsletter');
  out.adminRemove = { status: del.status, last: adminRows.at(-1)?.granted === false && adminRows.at(-1)?.source === 'admin' };
  await observe();

  // The ledger view and the admin withdrawal.
  const lv = await M.ledgerGET({ url: new URL(`${origin}/api/consent/ledger?email=${encodeURIComponent('PAΊΚΤΗΣ.one@example.gr'.toLowerCase())}`), locals: { user: { role: 'admin', id: 'u1' } } });
  const lvEditor = await M.ledgerGET({ url: new URL(`${origin}/api/consent/ledger?email=x@example.com`), locals: { user: { role: 'editor', id: 'u2' } } });
  const lvPlayer = await (await M.ledgerGET({ url: new URL(`${origin}/api/consent/ledger?email=${encodeURIComponent('παίκτης.one@example.gr')}`), locals: { user: { role: 'admin', id: 'u1' } } })).json();
  out.ledgerView = {
    editor: lvEditor.status,
    status: lv.status,
    playerRows: lvPlayer?.data?.rows?.length ?? -1,
    playerState: lvPlayer?.data?.state ?? [],
  };
  const awEditor = await M.adminWithdrawPOST({
    request: req(`${origin}/x`, { method: 'POST', body: JSON.stringify({ email: 'b-confirmed@example.com', purpose: 'newsletter' }) }),
    locals: { user: { role: 'editor', id: 'u2' } },
  });
  const aw = await M.adminWithdrawPOST({
    request: req(`${origin}/x`, { method: 'POST', body: JSON.stringify({ email: 'g-newgrant@example.com', purpose: 'newsletter' }) }),
    locals: { user: { role: 'admin', id: 'u1' } },
  });
  const awBad = await M.adminWithdrawPOST({
    request: req(`${origin}/x`, { method: 'POST', body: JSON.stringify({ email: 'nope', purpose: 'newsletter' }) }),
    locals: { user: { role: 'admin', id: 'u1' } },
  });
  out.adminWithdraw = {
    editor: awEditor.status, admin: aw.status, bad: awBad.status,
    stillExported: (await Svc.newsletterExport()).some((c) => c.email === 'g-newgrant@example.com'),
    bStillExported: (await Svc.newsletterExport()).some((c) => c.email === 'b-confirmed@example.com'),
  };

  // The public, token-signed withdrawal — game_terms only, newsletter untouched.
  await host.consent.record({ email: 'both@example.com', purpose: 'game_terms', granted: true, version: '1', text: 'terms', source: 'campaign-games' });
  await rec('both@example.com', true); await conf('both@example.com');
  const wdTok = NC.makeConsentWithdrawToken('both@example.com', 'game_terms');
  const pw = await M.publicWithdrawPOST({ url: new URL(`${origin}/api/consent/withdraw?token=${encodeURIComponent(wdTok)}`), locals: {} });
  const pwBad = await M.publicWithdrawPOST({ url: new URL(`${origin}/api/consent/withdraw?token=${encodeURIComponent(NC.makeUnsubscribeToken('both@example.com'))}`), locals: {} });
  // A plugin's link, through the host, clicked by a person (GET).
  await host.consent.record({ email: 'clicker@example.com', purpose: 'game_terms', granted: true, version: '1', text: 'terms', source: 'campaign-games' });
  const hostLink = await host.consent.withdrawUrl({ email: 'Clicker@Example.com', purpose: 'game_terms' });
  const clicked = await M.publicWithdrawGET({ url: new URL(hostLink), redirect });
  const badClick = await M.publicWithdrawGET({ url: new URL(`${origin}/api/consent/withdraw?token=nope`), redirect });
  let badUrlThrew = false;
  try { await host.consent.withdrawUrl({ email: 'nope', purpose: 'game_terms' }); } catch { badUrlThrew = true; }
  out.hostLink = {
    shape: /^https:\/\/shop\.example\.com\/api\/consent\/withdraw\?token=/.test(hostLink),
    location: clicked.headers.get('Location'),
    badLocation: badClick.headers.get('Location'),
    withdrawn: (await Svc.consentStateFor('clicker@example.com', 'game_terms')).withdrawn,
    badUrlThrew,
  };
  out.publicWithdraw = {
    status: pw.status, badStatus: pwBad.status,
    terms: (await Svc.consentStateFor('both@example.com', 'game_terms')).withdrawn,
    termsSource: (await rowsOf('both@example.com', 'game_terms')).at(-1)?.source,
    newsletterKept: (await Svc.consentStateFor('both@example.com', 'newsletter')).confirmed,
    // An unsubscribe token replayed here withdrew nothing.
    newsletterRows: (await rowsOf('both@example.com', 'newsletter')).length,
  };
  await observe();

  /* ---- 5. the migration ---- */
  await LocalDB.createSubscriber('legacy-one@example.com');
  await LocalDB.createSubscriber('Legacy-Two@Example.com');
  const mig = M.MIGRATIONS.find((m) => m.version === 16);
  const beforeMig = (await LocalDB.getConsentRows()).length;
  await mig.up(LocalDB);
  const afterFirst = (await LocalDB.getConsentRows()).length;
  await mig.up(LocalDB);
  const afterSecond = (await LocalDB.getConsentRows()).length;
  const legacyRows = await rowsOf('legacy-two@example.com', 'newsletter');
  const exportedNow = (await Svc.newsletterExport());
  out.migration = {
    name: mig?.name,
    written: afterFirst - beforeMig,
    secondRun: afterSecond - afterFirst,
    legacy: legacyRows.map((r) => ({ source: r.source, granted: r.granted, confirmed: !!r.confirmed_at, version: r.version })),
    exported: exportedNow.filter((c) => c.email.startsWith('legacy-')).map((c) => `${c.email}|${c.source}`),
    // reader@ had ledger rows already: the migration must not add a second.
    readerRows: (await rowsOf(reader, 'newsletter')).filter((r) => r.source === 'migration').length,
  };
  await observe();

  /* ---- 6. mail ---- */
  sent.length = 0;
  const tx = await host.mail.send({ to: 'buyer@example.com', subject: 'Ο κωδικός σας', text: 'Κωδικός: 123456', html: '<p>Κωδικός: 123456</p>', category: 'transactional' });
  out.mail = { tx, txSent: sent.length, txTo: sent[0]?.to, txHasListHeader: !!sent[0]?.headers?.['List-Unsubscribe'] };
  sent.length = 0;
  out.mail.bulkNoConsent = await host.mail.send({ to: 'a-granted-only@example.com', subject: 'News', text: 'Hi', category: 'bulk' });
  out.mail.bulkNoConsentSent = sent.length;
  const bulk = await host.mail.send({
    to: 'b-confirmed@example.com', subject: 'News', text: 'Hello', html: '<p>Hello</p>', category: 'bulk',
    headers: { 'List-Unsubscribe': '<https://evil.example/x>', 'X-Campaign': 'spring' },
  });
  out.mail.bulk = bulk;
  out.mail.bulkMsg = sent[0] ?? null;
  out.mail.badTo = await host.mail.send({ to: 'a@example.com, b@example.com', subject: 'x', text: 'x', category: 'transactional' });
  out.mail.badCategory = await host.mail.send({ to: 'a@example.com', subject: 'x', text: 'x', category: 'marketing' });
  failNext = true;
  out.mail.transportFail = await host.mail.send({ to: 'a@example.com', subject: 'x', text: 'x', category: 'transactional' });

  // Core's own campaign mail: RFC 8058 on every newsletter send.
  sent.length = 0;
  await LocalDB.updateSetting('site_url', origin);
  await LocalDB.createCustomEntity('newsletter_campaign', {
    subject: 'Spring', body: 'New frames.', status: 'sending', cursor: 0, sent_count: 0, failed_count: 0, audience: 1,
  });
  // A subscriber row that survived a withdrawal (a restore, a hand edit): the ledger wins.
  await LocalDB.createSubscriber('c-withdrawn@example.com');
  await M.maybeSendCampaign();
  out.campaignSkipsWithdrawn = !sent.some((m) => m.to === 'c-withdrawn@example.com') && sent.length > 0;
  out.campaign = sent.map((m) => ({
    to: m.to,
    lu: m.headers?.['List-Unsubscribe'] ?? '',
    lup: m.headers?.['List-Unsubscribe-Post'] ?? '',
    bodyLink: /\/api\/newsletter\/unsubscribe\?token=/.test(m.text ?? ''),
  }));
  await observe();

  /* ---- 7. the change feed never hears of it ---- */
  const feed = JSON.stringify(await LocalDB.getContentChanges());
  out.feedClean = !feed.includes('consent') && !feed.includes('game_terms') && !feed.includes('b-confirmed@example.com')
    && !feed.includes('παίκτης');

  /* ---- 8. append-only: nothing written so far was ever rewritten ---- */
  const finalRows = await observe();
  const rewritten = finalRows.filter((r) => firstSeen.get(r.id) !== JSON.stringify(r)).map((r) => r.id);
  out.appendOnly = { total: finalRows.length, rewritten, shrank, unique: new Set(finalRows.map((r) => r.id)).size === finalRows.length };
  // A duplicate id is refused, not overwritten.
  let dupThrew = false;
  try { await LocalDB.appendConsentRow({ ...finalRows[0], granted: !finalRows[0].granted }); } catch { dupThrew = true; }
  out.appendOnly.duplicateRefused = dupThrew
    && JSON.stringify((await LocalDB.getConsentRows()).find((r) => r.id === finalRows[0].id)) === firstSeen.get(finalRows[0].id);

  /* ---- 9. the erasure: the one documented rewrite ---- */
  const subject = 'παίκτης.one@example.gr';
  const beforeErase = await rowsOf(subject);
  const access = await M.Gdpr.collectSubjectData(subject);
  out.gdpr = { accessRows: access.consent.length, accessMatches: access.consent.length === beforeErase.length };
  const report = await M.Gdpr.eraseSubject(subject);
  const hashed = `sha256:${sha(subject)}`;
  const afterErase = await LocalDB.getConsentRows({ email: hashed });
  out.gdpr.pseudonymised = report.consentPseudonymised;
  out.gdpr.noteSaysPseudonymised = report.notes.some((n) => /PSEUDONYMISED/.test(n) && /Art\. 7\(1\)/.test(n));
  out.gdpr.leftUnderEmail = (await rowsOf(subject)).length;
  out.gdpr.keptCount = afterErase.length === beforeErase.length;
  out.gdpr.noIpUa = afterErase.every((r) => r.ip === undefined && r.ua === undefined);
  out.gdpr.erasedAt = afterErase.every((r) => typeof r.erased_at === 'string');
  const strip = (r) => { const { email: _e, ip: _i, ua: _u, erased_at: _x, ...rest } = r; return JSON.stringify(rest); };
  out.gdpr.decisionsUntouched = beforeErase.every((b) => afterErase.some((a) => a.id === b.id && strip(a) === strip(b)));
  // Every OTHER row is untouched by somebody else's erasure.
  const others = (await LocalDB.getConsentRows()).filter((r) => r.email !== hashed);
  out.gdpr.othersUntouched = others.every((r) => firstSeen.get(r.id) === JSON.stringify(r));
  // Erasing again finds nothing to rewrite.
  out.gdpr.secondErase = (await M.Gdpr.eraseSubject(subject)).consentPseudonymised;
  // "Hashing the same address finds them again" — the ledger view does it.
  out.gdpr.findByHash = (await Svc.consentRowsFor(subject)).length === beforeErase.length;

  /* ---- 10. relational: the database refuses DELETE and other UPDATEs ---- */
  if (process.env.DATABASE_DRIVER === 'relational') {
    const { createClient } = await import('@libsql/client');
    const db = createClient({ url: process.env.DATABASE_URL });
    const tryRun = async (sql, args = []) => {
      try { await db.execute({ sql, args }); return 'ran'; } catch (e) { return /append-only/.test(String(e?.message ?? e)) ? 'refused' : `error: ${e?.message}`; }
    };
    out.sql = {
      del: await tryRun('DELETE FROM consent_ledger WHERE email = ?', ['b-confirmed@example.com']),
      flip: await tryRun("UPDATE consent_ledger SET data = json_set(data, '$.granted', json('false')) WHERE email = ?", ['b-confirmed@example.com']),
      reEmail: await tryRun("UPDATE consent_ledger SET email = 'someone@else.com' WHERE email = ?", ['b-confirmed@example.com']),
      rehash: await tryRun("UPDATE consent_ledger SET email = 'sha256:abc' WHERE email = ?", [hashed]),
      count: Number((await db.execute({ sql: 'SELECT count(*) AS n FROM consent_ledger WHERE email = ?', args: ['b-confirmed@example.com'] })).rows[0].n),
    };
    db.close();
  }

  server.close();
  console.log(`__RESULT__${JSON.stringify(out)}`);
  process.exit(0);
}

/* ------------------------------------------------------- pure checks ----- */
const L = await loadTs('src/lib/consent-ledger.ts');
// One bundle for both: each pulls in LocalDB, and two copies of it in one
// process is what tests/test-harness-localdb.test.mjs exists to refuse.
const [CM, CS] = await loadTogether(['src/lib/plugin-platform/consent-mail.ts', 'src/lib/commerce/coupon-service.ts'], 'consentcoupon');
const NL = await loadTs('src/lib/newsletter-campaign.ts');

{
  const greek = 'Αποδέχομαι τους όρους — έκδοση 2. Ευχαριστούμε!';
  check('text hash: sha256 of the exact UTF-8 bytes (Greek)', L.textHash(greek) === sha(greek));
  check('text hash: the same text gives the same hash', L.textHash(greek) === L.textHash(`${greek}`));
  check('text hash: a precomposed and a decomposed accent are DIFFERENT texts',
    L.textHash('ά'.normalize('NFC')) !== L.textHash('ά'.normalize('NFD')));
  check('text hash: nothing is trimmed', L.textHash(`${greek} `) !== L.textHash(greek));
  check('text hash: 64 lower-case hex', /^[0-9a-f]{64}$/.test(L.textHash('x')));
  check('email hash: normalised before hashing', L.emailHash(' A@B.gr ') === sha('a@b.gr'));

  // `newsletter.subscribed` (this ledger) and `coupon.redeemed` (#167's
  // coupons) both publish an `email_hash`, from two separate functions. A
  // webhook consumer joins them on that value, so the two rules must agree
  // for every address a shop sees — case, padding, Greek, a +tag.
  const addrs = [' Maria.P+wheel@Example.GR ', 'ΜΑΡΙΑ@παράδειγμα.ελ', 'a@b.gr', '\tX@Y.COM\n'];
  check('email hash: coupon.redeemed and newsletter.subscribed hash an address the SAME way',
    addrs.every((a) => CS.couponEmailKey(a) === L.emailHash(a) && L.emailHash(a) === sha(a.trim().toLowerCase())));
}

{
  const ok = { email: 'X@Y.gr', purpose: 'newsletter', granted: true, version: 2, text: 'Ναι', source: 'campaign-games' };
  const row = L.buildGrantRow(ok, 'id1', '2026-10-26T00:00:00.000Z');
  check('record: email lower-cased, version stringified, text hashed not stored',
    row.email === 'x@y.gr' && row.version === '2' && row.text_hash === sha('Ναι') && !('text' in row));
  const throws = (patch) => { try { L.buildGrantRow({ ...ok, ...patch }, 'i', 'a'); return false; } catch (e) { return e instanceof L.ConsentInputError; } };
  check('record: "false" as a string is NOT a decision', throws({ granted: 'false' }));
  check('record: a bad email is refused', throws({ email: 'nope' }));
  check('record: a bad purpose is refused', throws({ purpose: 'News Letter' }));
  check('record: an empty text is refused', throws({ text: '' }));
  check('record: a missing version is refused', throws({ version: '' }));
  check('record: a missing source is refused', throws({ source: '' }));
  const c = L.cleanClient('not an ip', 'a\u0000b'.padEnd(900, 'x'));
  check('record: a malformed ip is dropped, a ua is cleaned and capped', c.ip === undefined && c.ua.length === 512 && !c.ua.includes('\u0000'));
}

{
  // The four combinations, on the pure reducer.
  let n = 0;
  const row = (email, granted, confirmed) => ({
    id: `r${n += 1}`, email, purpose: 'newsletter', granted, version: 'v', text_hash: 'h', at: 't', source: 's',
    ...(confirmed ? { confirmed_at: 't' } : {}),
  });
  const rows = [
    row('granted@x.gr', true, false),
    row('confirmed@x.gr', true, false), row('confirmed@x.gr', true, true),
    row('withdrawn@x.gr', true, false), row('withdrawn@x.gr', true, true), row('withdrawn@x.gr', false, false),
    row('never@x.gr', false, false),
    { ...row('erased', true, true), email: 'sha256:abc' },
  ];
  const exp = L.exportableContacts(rows).map((c) => c.email);
  check('export (pure): granted only → out', !exp.includes('granted@x.gr'));
  check('export (pure): granted + confirmed → in', exp.includes('confirmed@x.gr'));
  check('export (pure): granted + confirmed + withdrawn → out', !exp.includes('withdrawn@x.gr'));
  check('export (pure): never granted → out', !exp.includes('never@x.gr'));
  check('export (pure): an erased row is never a contact', !exp.some((e) => e.startsWith('sha256:')));
  const s = L.consentState([row('z', true, true), row('z', false, false), row('z', true, false)]);
  check('state: a grant after a withdrawal needs a NEW confirmation', s.granted && !s.confirmed);
}

{
  const m = CM.withUnsubscribe({ text: 'Hi', html: '<p>Hi</p>', headers: { 'list-unsubscribe': '<x>', 'X-A': '1' } }, 'https://s.example/api/newsletter/unsubscribe?token=a&b');
  check('bulk mail: List-Unsubscribe is core\'s, the plugin\'s is replaced',
    m.headers['List-Unsubscribe'] === '<https://s.example/api/newsletter/unsubscribe?token=a&b>' && !('list-unsubscribe' in m.headers));
  check('bulk mail: List-Unsubscribe-Post is the RFC 8058 value', m.headers['List-Unsubscribe-Post'] === 'List-Unsubscribe=One-Click');
  check('bulk mail: other headers survive', m.headers['X-A'] === '1');
  check('bulk mail: a link in the text and an ESCAPED link in the html',
    m.text.includes('token=a&b') && m.html.includes('token=a&amp;b'));
  const camp = NL.campaignMessage({ subject: 'S', body: 'B' }, 'r@example.com', 'https://s.example');
  check('core campaign mail carries both RFC 8058 headers',
    /^<https:\/\/s\.example\/api\/newsletter\/unsubscribe\?token=/.test(camp.headers['List-Unsubscribe'])
    && camp.headers['List-Unsubscribe-Post'] === 'List-Unsubscribe=One-Click');
}

/* ----------------------------------- no update/delete path in the source --- */
{
  const read = (rel) => fs.readFile(path.join(ROOT, rel), 'utf8');
  const sql = await read('src/lib/storage/sql-storage.ts');
  const local = await read('src/lib/localdb.ts');
  const storage = await read('src/core/storage.ts');
  const updates = sql.match(/UPDATE consent_ledger/g) ?? [];
  check('sql: exactly ONE UPDATE of consent_ledger (the erasure)', updates.length === 1);
  const updateAt = sql.indexOf("'UPDATE consent_ledger");
  const fnStart = sql.lastIndexOf('async pseudonymiseConsentRows', updateAt);
  check('sql: ...and it is inside pseudonymiseConsentRows', fnStart > 0 && sql.lastIndexOf('async ', updateAt) === fnStart);
  check('sql: no DELETE FROM consent_ledger anywhere', !/DELETE FROM consent_ledger/.test(sql));
  check('sql: no INSERT OR REPLACE / upsert into consent_ledger', !/INSERT OR (REPLACE|IGNORE) INTO consent_ledger|consent_ledger[^;]*ON CONFLICT/.test(sql));
  // lowdb: the array is only ever pushed to, except the erasure's map.
  // `= []` (creating a missing array) is not a rewrite; anything else is counted.
  const assigns = local.match(/db\.data\.consentLedger\s*=(?!=)(?!\s*\[\])/g) ?? [];
  check(`lowdb: consentLedger is reassigned only by init and the erasure (${assigns.length})`,
    assigns.length === 2 && /consentLedger = db\.data\.consentLedger \?\? \[\]/.test(local)
    && /db\.data\.consentLedger = db\.data\.consentLedger\.map\(/.test(local));
  check('lowdb: no splice/filter/pop/shift on the ledger', !/consentLedger\.(splice|pop|shift|filter\([^)]*\)\s*$)/m.test(local)
    && !/db\.data\.consentLedger\s*=\s*db\.data\.consentLedger\.filter/.test(local));
  const methods = [...storage.matchAll(/^\s+(\w*[Cc]onsent\w*)\(/gm)].map((m) => m[1]).sort();
  check('Storage: the ledger surface is append, read and pseudonymise — nothing else',
    JSON.stringify(methods.filter((m) => /ConsentRow/.test(m))) === JSON.stringify(['appendConsentRow', 'getConsentRows', 'pseudonymiseConsentRows']));
  // Every src writer goes through the service or the migration, never LocalDB directly.
  const callers = spawnSync('grep', ['-rln', 'appendConsentRow(\\|pseudonymiseConsentRows(', path.join(ROOT, 'src')], { encoding: 'utf8' })
    .stdout.trim().split('\n').map((f) => path.relative(ROOT, f)).sort();
  check(`ledger writers are only the service, the migration helper, gdpr and the drivers (${callers.join(', ')})`,
    JSON.stringify(callers) === JSON.stringify([
      'src/core/storage.ts', 'src/lib/consent-ledger.ts', 'src/lib/consent-service.ts', 'src/lib/gdpr.ts',
      'src/lib/localdb.ts', 'src/lib/storage/sql-storage.ts',
    ]));
  const doc = await read('PLUGIN_DEVELOPMENT.md');
  for (const member of ['host.consent.record', 'host.consent.confirm', 'host.consent.withdraw', 'host.mail.send']) {
    check(`PLUGIN_DEVELOPMENT.md documents ${member}`, doc.includes(member));
  }
  check('PLUGIN_DEVELOPMENT.md documents the newsletter.subscribed event', doc.includes('newsletter.subscribed'));
}

/* ------------------------------------------- the host, per storage driver -- */
const here = path.dirname(fileURLToPath(import.meta.url));
const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'astrobaas-consent-ledger-'));
const DRIVERS = [
  { name: 'lowdb', env: (d) => ({ DB_PATH: path.join(d, 'db.json') }) },
  { name: 'libsql', env: (d) => ({ DATABASE_URL: `file:${path.join(d, 'db.sqlite')}` }) },
  { name: 'relational', env: (d) => ({ DATABASE_URL: `file:${path.join(d, 'db.sqlite')}`, DATABASE_DRIVER: 'relational' }) },
];

const results = {};
for (const driver of DRIVERS) {
  const dir = path.join(tmpRoot, driver.name);
  await fs.mkdir(path.join(dir, 'uploads'), { recursive: true });
  const run = spawnSync(process.execPath, [path.join(here, 'consent-ledger.test.mjs')], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 180_000,
    env: {
      ...process.env, CONSENT_CHILD: '1', CONSENT_DIR: dir, NODE_ENV: 'test',
      SITE_URL: 'https://shop.example.com', AUTH_SECRET: 'test-secret-'.padEnd(40, 'x'),
      UPLOADS_DIR: path.join(dir, 'uploads'), ASTROBAAS_PLUGINS: '', WEBHOOK_ALLOW_PRIVATE: '1',
      EMAIL_TRANSPORT: 'console', ...driver.env(dir),
    },
  });
  const line = (run.stdout || '').split('\n').find((l) => l.startsWith('__RESULT__'));
  if (!line) {
    fail += 1;
    console.error(`✗ [${driver.name}] child produced no result\n${(run.stdout || '').slice(-800)}\n${(run.stderr || '').slice(-2500)}`);
    continue;
  }
  const o = JSON.parse(line.slice('__RESULT__'.length));
  results[driver.name] = o;
  const t = (n, c) => check(`[${driver.name}] ${n}`, c);

  t('the real loader hands the factory a host with consent.record/confirm/withdraw and mail.send',
    o.loaded && Object.values(o.shape).every((v) => v === 'function'));

  t('Greek text: the returned text_hash is sha256 of the exact UTF-8 text', o.greek.hash === sha('Συμφωνώ με τους όρους του παιχνιδιού «Γύρνα τον τροχό». Έκδοση 3 — Οπτικά Γωνία.'));
  t('Greek text: the same text gives the same hash for another person', o.greek.sameForSameText);
  t('record returns { id, text_hash, at }', o.greek.shape);
  t('the address is stored normalised (Greek local part lower-cased)', o.greek.normalisedEmail);
  t('ip and ua are kept when passed', o.greek.ipKept);
  t('the consent TEXT is never stored, only its hash', o.greek.noTextStored);

  t('a game verification with NO newsletter consent: confirm answers { confirmed: false }',
    o.game.newsletterConfirm?.confirmed === false);
  t('...records nothing for newsletter', o.game.newsletterRows === 0);
  t('...subscribes NOBODY', o.game.subscribersAdded === 0);
  t('...and fires no newsletter.subscribed', o.game.subscribedEvents === 0);
  t('...while the game terms it DID grant confirm (one row)', o.game.termsConfirm?.confirmed === true && o.game.rowsAdded === 1);

  t('a plugin grant alone subscribes nobody', o.pluginOptIn.beforeConfirm === false);
  t('confirm after a grant: { confirmed: true }', o.pluginOptIn.confirm?.confirmed === true);
  t('confirming twice: true, and no second row', o.pluginOptIn.again?.confirmed === true && o.pluginOptIn.secondConfirmWroteNothing);
  t('the confirmed address is on the list exactly once', o.pluginOptIn.subscribed === 1);
  t('newsletter.subscribed fired once', o.pluginOptIn.events === 1);
  t('newsletter.subscribed carries { email_hash, source, at } and never the address',
    o.pluginOptIn.payload?.email_hash === sha('reader@example.com') && o.pluginOptIn.payload?.source === 'campaign-games'
    && typeof o.pluginOptIn.payload?.at === 'string' && !JSON.stringify(o.pluginOptIn.payload).includes('reader@'));
  t('the existing subscriber.confirmed still fires for ESP sync, once for two confirms', o.pluginOptIn.confirmedEvents === 1);
  t('the confirmation is its OWN row: granted, confirmed_at set, the grant\'s version and text hash',
    o.pluginOptIn.lastRow?.granted === true && typeof o.pluginOptIn.lastRow?.confirmed_at === 'string'
    && o.pluginOptIn.lastRow?.version === 'n1' && o.pluginOptIn.lastRow?.text_hash === sha('Send me news.'));

  const ex = o.exportList;
  t('export: granted only → OUT', !ex.includes('a-granted-only@example.com'));
  t('export: granted + confirmed → IN', ex.includes('b-confirmed@example.com'));
  t('export: granted + confirmed + withdrawn → OUT', !ex.includes('c-withdrawn@example.com'));
  t('export: never granted → OUT, and confirm refuses it', !ex.includes('d-denied@example.com') && o.deniedConfirm?.confirmed === false);
  t('export: withdrawn then granted again, not re-confirmed → OUT', !ex.includes('e-regranted@example.com') && o.regrantedConfirmBeforeClick === false);
  t('export: withdrawn then granted and confirmed again → IN', ex.includes('f-reconfirmed@example.com'));
  t('export: a newer grant on top of a confirmation stays IN', ex.includes('g-newgrant@example.com'));
  t('a withdrawal takes the address off the subscriber list', o.cWithdrawnSubscribed === false);
  t('withdrawing twice writes one withdrawal row, not two', o.withdrawTwice.after === o.withdrawTwice.before);

  t('confirm route: still redirects to the confirmed page with an unsubscribe token',
    o.route.confirmStatus === 302 && /\/newsletter\/confirmed\?ok=1&u=/.test(o.route.confirmLocation));
  t('confirm route: writes the grant (newsletter_form) and its confirmation, with the signed wording',
    o.route.rows.length === 2
    && o.route.rows[0].granted && o.route.rows[0].source === 'newsletter_form' && !o.route.rows[0].confirmed
    && o.route.rows[1].granted && o.route.rows[1].source === 'newsletter_confirm_link' && o.route.rows[1].confirmed
    && o.route.rows.every((r) => r.version === 'storefront-2' && r.hash === sha('Θέλω το newsletter.')));
  t('confirm route: the address is on the list', o.route.subscribed);
  t('confirm route: a second click adds no row, no second subscriber, no second subscriber.confirmed',
    o.route.secondClickRows === 2 && o.route.secondClickSubs === 1 && o.route.confirmedEvents === 1);
  t('confirm route: a link minted before the ledger is recorded under the default wording',
    JSON.stringify(o.route.oldLink) === JSON.stringify(['core-newsletter-1', 'core-newsletter-1']));
  t('confirm route: a forged token still gets the same failure redirect', o.route.forged === '/newsletter/confirmed?ok=0');

  t('export route: staff only', o.exportRoute.anon === 403);
  t('export route: lists exactly the exportable contacts', o.exportRoute.emails.includes('b-confirmed@example.com')
    && o.exportRoute.emails.includes('human@example.com') && !o.exportRoute.emails.includes('a-granted-only@example.com')
    && !o.exportRoute.emails.includes('c-withdrawn@example.com'));
  t('export route: CSV with the proof columns', /^text\/csv/.test(o.exportRoute.csvType ?? '')
    && o.exportRoute.csv.startsWith('email,confirmed_at,version,text_hash,source\r\n') && o.exportRoute.csv.includes('b-confirmed@example.com,'));

  t('one-click unsubscribe: POST with no session answers 200', o.oneClick.status === 200);
  t('...and appends a withdrawal row (source one_click)', o.oneClick.lastRow?.granted === false && o.oneClick.lastRow?.source === 'one_click');
  t('...and removes the subscriber, fires subscriber.unsubscribed once, drops them from the export',
    o.oneClick.subscribed === false && o.oneClick.unsubEvents === 1 && o.oneClick.inExport === false);
  t('...a forged token still gets the bare 200', o.oneClick.badStatus === 200);
  t('the GET unsubscribe link records its own source', o.oneClick.getSource === 'unsubscribe_link');
  t('STALE LINK: the old confirmation link, opened after unsubscribing, fails and writes nothing',
    o.stale.location === '/newsletter/confirmed?ok=0' && o.stale.rowsAdded === 0 && o.stale.subscribed === false);
  t('...while a signup made AFTER leaving confirms again', /ok=1/.test(o.stale.freshLocation ?? '') && o.stale.freshExported);
  t('a confirmed subscriber signing up under new wording gets that grant and its confirmation recorded',
    JSON.stringify(o.stale.newWording) === JSON.stringify(['storefront-3:g', 'storefront-3:c']));
  t('host.consent.withdrawUrl: a signed link on the site origin', o.hostLink.shape && o.hostLink.badUrlThrew);
  t('...clicked (GET), it withdraws and lands on the withdrawn page',
    o.hostLink.withdrawn && o.hostLink.location === '/consent/withdrawn?ok=1' && o.hostLink.badLocation === '/consent/withdrawn?ok=0');
  t('the operator\'s Remove button records a withdrawal (source admin)', o.adminRemove.status === 200 && o.adminRemove.last);

  t('ledger view: administrators only', o.ledgerView.editor === 403);
  t('ledger view: every row for the address, with state per purpose',
    o.ledgerView.playerRows === 2 && o.ledgerView.playerState.some((s) => s.purpose === 'game_terms' && s.confirmed));
  t('admin withdraw: editors refused, a bad address 400', o.adminWithdraw.editor === 403 && o.adminWithdraw.bad === 400);
  t('admin withdraw: withdraws (out of the export), touches nobody else',
    o.adminWithdraw.admin === 200 && !o.adminWithdraw.stillExported && o.adminWithdraw.bStillExported);

  t('public withdraw: a signed token withdraws exactly its purpose', o.publicWithdraw.status === 200 && o.publicWithdraw.terms && o.publicWithdraw.termsSource === 'withdraw_link');
  t('public withdraw: the newsletter is untouched, and an unsubscribe token replayed here does nothing',
    o.publicWithdraw.newsletterKept && o.publicWithdraw.badStatus === 200 && o.publicWithdraw.newsletterRows === 2);

  t('migration 16 exists', o.migration.name === 'subscribers-into-consent-ledger');
  t('migration: existing subscribers without a ledger row get ONE confirmed row each', o.migration.written === 2);
  t('migration: a second run writes nothing', o.migration.secondRun === 0);
  t('migration: rows are source migration, granted, confirmed, pre-ledger wording',
    o.migration.legacy.length === 1 && o.migration.legacy[0].source === 'migration' && o.migration.legacy[0].granted
    && o.migration.legacy[0].confirmed && o.migration.legacy[0].version === 'pre-ledger');
  t('migration: the export keeps them', o.migration.exported.includes('legacy-one@example.com|migration')
    && o.migration.exported.includes('legacy-two@example.com|migration'));
  t('migration: an address already in the ledger gets no migration row', o.migration.readerRows === 0);

  t('mail: transactional goes through the configured transport, ok', o.mail.tx?.ok === true && o.mail.txSent === 1 && o.mail.txTo === 'buyer@example.com');
  t('mail: transactional gets no list headers', o.mail.txHasListHeader === false);
  t('mail: bulk to an unconfirmed address is refused and NOT sent',
    o.mail.bulkNoConsent?.ok === false && o.mail.bulkNoConsent?.error === 'no_newsletter_consent' && o.mail.bulkNoConsentSent === 0);
  t('mail: bulk to a confirmed contact is sent with RFC 8058 headers',
    o.mail.bulk?.ok === true && o.mail.bulkMsg?.category === 'bulk'
    && /^<https:\/\/shop\.example\.com\/api\/newsletter\/unsubscribe\?token=/.test(o.mail.bulkMsg?.headers?.['List-Unsubscribe'] ?? '')
    && o.mail.bulkMsg?.headers?.['List-Unsubscribe-Post'] === 'List-Unsubscribe=One-Click');
  t('mail: the plugin cannot point List-Unsubscribe elsewhere; its other headers pass',
    !JSON.stringify(o.mail.bulkMsg?.headers ?? {}).includes('evil.example') && o.mail.bulkMsg?.headers?.['X-Campaign'] === 'spring');
  t('mail: the unsubscribe link is in the body too', /api\/newsletter\/unsubscribe\?token=/.test(o.mail.bulkMsg?.text ?? '')
    && /api\/newsletter\/unsubscribe\?token=/.test(o.mail.bulkMsg?.html ?? ''));
  t('mail: one recipient only', o.mail.badTo?.ok === false && o.mail.badTo?.error === 'invalid_recipient');
  t('mail: an unknown category is refused', o.mail.badCategory?.ok === false && o.mail.badCategory?.error === 'invalid_category');
  t('mail: a transport failure is { ok: false, error }, never a throw',
    o.mail.transportFail?.ok === false && /550/.test(o.mail.transportFail?.error ?? ''));
  t('core campaign mail: every message carries List-Unsubscribe + List-Unsubscribe-Post and a body link',
    o.campaign.length > 0 && o.campaign.every((m) => /^<https?:\/\/.+\/api\/newsletter\/unsubscribe\?token=/.test(m.lu)
      && m.lup === 'List-Unsubscribe=One-Click' && m.bodyLink));

  t('nothing about consent reaches the public change feed', o.feedClean);
  t('core campaign mail skips a withdrawn address even if its subscriber row survived', o.campaignSkipsWithdrawn);

  t(`APPEND-ONLY: no row was rewritten in normal operation (${o.appendOnly.total} rows)`,
    o.appendOnly.total > 30 && o.appendOnly.rewritten.length === 0 && !o.appendOnly.shrank && o.appendOnly.unique);
  t('APPEND-ONLY: a duplicate id is refused, the stored row unchanged', o.appendOnly.duplicateRefused);

  t('GDPR access: the export includes the ledger rows', o.gdpr.accessRows === 2 && o.gdpr.accessMatches);
  t('GDPR erasure: rows are KEPT, pseudonymised', o.gdpr.pseudonymised === 2 && o.gdpr.keptCount && o.gdpr.leftUnderEmail === 0);
  t('GDPR erasure: ip and ua removed, erased_at set', o.gdpr.noIpUa && o.gdpr.erasedAt);
  t('GDPR erasure: decision, purpose, version, hash, times and source untouched', o.gdpr.decisionsUntouched);
  t('GDPR erasure: nobody else\'s rows change', o.gdpr.othersUntouched);
  t('GDPR erasure: the report says why, and says pseudonymised', o.gdpr.noteSaysPseudonymised);
  t('GDPR erasure: a second erasure rewrites nothing', o.gdpr.secondErase === 0);
  t('GDPR erasure: the ledger lookup finds the kept rows by hashing the address', o.gdpr.findByHash);

  if (driver.name === 'relational') {
    t('relational: the database refuses DELETE', o.sql?.del === 'refused');
    t('relational: the database refuses flipping a decision', o.sql?.flip === 'refused');
    t('relational: the database refuses changing an address', o.sql?.reEmail === 'refused');
    t('relational: the database refuses re-hashing an erased row', o.sql?.rehash === 'refused');
    t('relational: ...and the rows are all still there', o.sql?.count >= 2);
  }
}

/* ---------------------------------------------- the drivers agree ----- */
{
  const names = Object.keys(results);
  const fingerprint = (o) => JSON.stringify({
    export: o.exportList, game: o.game, migration: o.migration.written, total: o.appendOnly.total,
    route: o.route.rows, gdpr: o.gdpr.pseudonymised,
  });
  check(`all three drivers agree (${names.join(', ')})`,
    names.length === 3 && names.every((n) => fingerprint(results[n]) === fingerprint(results[names[0]])));
}

await fs.rm(tmpRoot, { recursive: true, force: true });
console.log(`\nconsent-ledger: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
