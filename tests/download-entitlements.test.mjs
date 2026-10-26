#!/usr/bin/env node
/**
 * Download entitlements (lib/commerce/download-entitlements.ts and the routes
 * over it).
 *
 * What is proved, and how:
 *
 *  - P: the pure rules — download normalisation, settings, the plan that
 *    grants/revokes/lifts, the email builders, the catalogue projection.
 *  - S: on ALL THREE drivers, each in its own child process and database,
 *    driven through the real writers (saveProduct, setOrderStatus,
 *    storePrivateFile) and the real routes:
 *      grant on paid; revoke on refund and on cancel; lift on reopen; the
 *      LIVE status check; private files streamed and https redirected; the
 *      LIMIT and the EXPIRY each refusing; the count under concurrency —
 *      both a Promise.all burst and a FORCED interleaving (the second
 *      download runs to completion immediately before the first one's
 *      compare-and-set, and the scenario first proves its hook fired);
 *      staff revoke/restore/reset/grant with roles; the buyer list; HEAD
 *      not counting; forged and wrong-purpose tokens; the GDPR export and
 *      erasure; the public catalogue not carrying a download's url.
 *
 * Run with:  node tests/download-entitlements.test.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, loadTs } from './lib/load.mjs';

/* ---------------------------------------------------------------- child --- */

function installHook(LocalDB) {
  let pending = null;
  let fired = 0;
  for (const name of ['compareAndSetOrderField', 'updateOrder']) {
    const original = LocalDB[name];
    if (typeof original !== 'function') continue;
    LocalDB[name] = async function hooked(...args) {
      if (pending && pending.match(name, args)) {
        const p = pending;
        pending = null;
        fired += 1;
        await p.run();
      }
      return original.apply(this, args);
    };
  }
  return {
    before(match, run) {
      const at = fired;
      pending = { match, run };
      return () => fired > at;
    },
    disarm() { pending = null; },
  };
}

const PDF = Buffer.from('%PDF-1.4\n% download-entitlements test file Καλημέρα\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n', 'utf8');

async function child(M) {
  const { LocalDB, dl } = M;
  const hook = installHook(LocalDB);
  const out = {};
  const admin = { id: 'u-admin', role: 'admin' };
  const manager = { id: 'u-man', role: 'manager' };

  const call = async (fn, { user = null, params = {}, url = 'http://localhost/x', method = 'GET', body, form } = {}) => {
    const init = { method };
    if (form) init.body = form;
    else if (body !== undefined) { init.body = JSON.stringify(body); init.headers = { 'content-type': 'application/json' }; }
    const res = await fn({ params, url: new URL(url), locals: { user, ip: '203.0.113.9' }, request: new Request(url, init) });
    const type = res.headers.get('content-type') || '';
    const buf = Buffer.from(await res.arrayBuffer());
    let json = null;
    if (type.includes('json')) { try { json = JSON.parse(buf.toString('utf8')); } catch { /* not json */ } }
    return { status: res.status, headers: res.headers, json, buf };
  };
  const fetchLink = (href, ip) => {
    const token = decodeURIComponent(href.split('/api/downloads/')[1]);
    return M.downloadFile({ params: { token }, url: new URL(`http://localhost${href}`), locals: { user: null, ip: ip ?? '198.51.100.7' }, request: new Request(`http://localhost${href}`) })
      .then(async (res) => ({ status: res.status, headers: res.headers, buf: Buffer.from(await res.arrayBuffer()) }));
  };
  const reason = async (res) => { try { return JSON.parse(res.buf.toString('utf8'))?.error?.reason; } catch { return null; } };

  // Shop defaults through the real setting keys.
  await LocalDB.updateSetting(dl.DOWNLOAD_SETTING_KEYS.limit, 0);
  await LocalDB.updateSetting(dl.DOWNLOAD_SETTING_KEYS.expiryDays, 30);

  // A private file, through the real writer, and a product through saveProduct.
  const stored = await M.storePrivateFile(PDF, 'Οδηγός.pdf', { purpose: 'product' });
  if (!stored.ok) throw new Error('store failed: ' + stored.error);
  const privateRef = `private:${stored.file.id}`;
  let pn = 0;
  const product = async (over = {}) => {
    pn += 1;
    const r = await M.saveProduct({
      name: `Ebook ${pn}`, slug: `ebook-${process.pid}-${pn}`, price_cents: 1000, status: 'active',
      downloadable: true, virtual: true,
      downloads: [{ name: 'Guide (PDF)', url: privateRef }, { name: 'Bonus', url: 'https://cdn.example.com/bonus.zip' }],
      ...over,
    });
    if (!r.ok) throw new Error('saveProduct failed: ' + r.message);
    return r.value;
  };
  const mug = (await M.saveProduct({ name: 'Mug', slug: `mug-${process.pid}`, price_cents: 500, status: 'active' })).value;
  let on = 0;
  const order = async (prod, over = {}) => {
    on += 1;
    return LocalDB.createOrder({
      number: `DL-${process.pid}-${on}`, status: 'pending', payment_status: 'pending',
      email: `buyer${on}@example.com`, currency: 'EUR',
      items: [{ product_id: prod.id, name: prod.name, qty: 1, total_cents: 1000 }, { product_id: mug.id, name: 'Mug', qty: 1, total_cents: 500 }],
      subtotal_cents: 1500, total_cents: 1500, ...over,
    });
  };
  const paid = async (prod, over) => {
    const o = await order(prod, over);
    const r = await M.setOrderStatus(o.id, 'processing', 'test');
    if (!r.ok) throw new Error('setOrderStatus failed: ' + r.message);
    return r.value;
  };
  const links = (o) => dl.buyerDownloads(o, 24);

  /* ---- S1: grant on paid, with defaults, product override, only downloadable lines ---- */
  {
    const p = await product();
    const pending = await order(p);
    const before = (await LocalDB.getOrder(pending.id)).entitlements;
    const r = await M.setOrderStatus(pending.id, 'processing', 'test');
    const ents = r.value.entitlements ?? [];
    const p2 = await product({ download_limit: 2, download_expiry_days: 0 });
    const o2 = await paid(p2);
    const e2 = o2.entitlements?.[0];
    const onHold = await order(p);
    await M.setOrderStatus(onHold.id, 'on-hold', 'test');
    out.s1 = {
      before: before ?? null, count: ents.length, line: ents[0]?.line, files: ents[0]?.files?.map((f) => f.name),
      limit: ents[0]?.download_limit, expiresDays: ents[0]?.expires_at ? Math.round((Date.parse(ents[0].expires_at) - Date.now()) / 86400000) : null,
      overrideLimit: e2?.download_limit, overrideExpiry: e2?.expires_at,
      onHold: ((await LocalDB.getOrder(onHold.id)).entitlements ?? []).length,
      // Idempotent: a second reconcile grants nothing new.
      again: (await dl.reconcileEntitlements(pending.id)).granted.length,
    };
  }

  /* ---- S2: a private file is STREAMED, an https file REDIRECTED; both counted and logged ---- */
  {
    const p = await product();
    const o = await paid(p);
    const [ent] = links(o);
    const a = await fetchLink(ent.files[0].href, '192.0.2.44');
    const b = await fetchLink(ent.files[1].href);
    const after = (await LocalDB.getOrder(o.id)).entitlements[0];
    out.s2 = {
      privStatus: a.status, same: a.buf.equals(PDF), disp: a.headers.get('content-disposition'),
      type: a.headers.get('content-type'), nosniff: a.headers.get('x-content-type-options'),
      cache: a.headers.get('cache-control'), hrefLeaks: JSON.stringify(ent).includes(stored.file.id) || JSON.stringify(ent).includes('cdn.example.com'),
      extStatus: b.status, location: b.headers.get('location'),
      count: after.download_count, log: after.log?.map((l) => [l.file, l.ip ?? null, typeof l.at]),
    };
  }

  /* ---- S3: the LIMIT refuses the download after it ---- */
  {
    const p = await product({ download_limit: 2 });
    const o = await paid(p);
    const href = links(o)[0].files[0].href;
    const r1 = await fetchLink(href);
    const r2 = await fetchLink(href);
    const r3 = await fetchLink(href);
    // The limit is PER FILE: the other file of the same purchase still works.
    const other = await fetchLink(links(await LocalDB.getOrder(o.id))[0].files[1].href);
    const after = (await LocalDB.getOrder(o.id)).entitlements[0];
    out.s3 = {
      statuses: [r1.status, r2.status, r3.status], reason: await reason(r3), other: other.status,
      count: after.download_count, perFile: after.file_counts,
      // The buyer list offers no link for the spent file, and one for the other.
      offered: links(await LocalDB.getOrder(o.id))[0].files.map((f) => [f.href !== null, f.remaining]),
    };
  }

  /* ---- S4: the EXPIRY refuses — through the route, an entitlement granted 31 days ago with a 30-day expiry ---- */
  {
    const p = await product();
    const o = await order(p);
    await LocalDB.updateOrder(o.id, { status: 'processing' });
    const past = Date.now() - 31 * 86400000;
    await dl.reconcileEntitlements(o.id, past);
    const fresh = await LocalDB.getOrder(o.id);
    const href = links(fresh)[0]?.files[0]?.href;
    // The link is not even offered for an expired entitlement…
    const st = dl.buyerDownloads(fresh, 24)[0]?.state;
    // …and a link minted while it was valid is refused once it is not.
    const t = dl.makeDownloadToken(o.id, { ...fresh.entitlements[0], expires_at: null }, 0, 3600000);
    const r = await fetchLink(`/api/downloads/${encodeURIComponent(t)}`);
    // And the boundary, through claimDownload with a clock: valid the day before, refused the day after.
    const p2 = await product();
    const o2 = await paid(p2);
    const t2 = dl.makeDownloadToken(o2.id, { ...o2.entitlements[0], expires_at: null }, 0, 3600000);
    const exp = Date.parse(o2.entitlements[0].expires_at);
    const before = await dl.claimDownload(t2, null, exp - 86400000);
    const after = await dl.claimDownload(t2, null, exp + 1000);
    out.s4 = { href: href ?? null, state: st, status: r.status, reason: await reason(r), before: before.ok, after: after.ok ? 'ok' : after.code };
  }

  /* ---- S5: concurrency — a burst of 8 against a limit of 3 lands exactly 3 ---- */
  {
    const p = await product({ download_limit: 3 });
    const o = await paid(p);
    const href = links(o)[0].files[1].href;
    const results = await Promise.all(Array.from({ length: 8 }, () => fetchLink(href)));
    out.s5 = {
      ok: results.filter((r) => r.status === 302).length,
      refused: results.filter((r) => r.status === 403).length,
      other: results.filter((r) => r.status !== 302 && r.status !== 403).map((r) => r.status),
      count: (await LocalDB.getOrder(o.id)).entitlements[0].download_count,
    };
  }

  /* ---- S6: FORCED interleaving — the second download completes inside the first's CAS window ---- */
  {
    const p = await product({ download_limit: 1 });
    const o = await paid(p);
    const token = decodeURIComponent(links(o)[0].files[1].href.split('/api/downloads/')[1]);
    let second = null;
    const fired = hook.before(
      (name, args) => name === 'compareAndSetOrderField' && args[0] === o.id && args[1] === 'entitlements',
      async () => { second = await dl.claimDownload(token, '10.0.0.2'); },
    );
    const first = await dl.claimDownload(token, '10.0.0.1');
    hook.disarm();
    const after = (await LocalDB.getOrder(o.id)).entitlements[0];
    out.s6 = { fired: fired(), first: first.ok ? 'ok' : first.code, second: second?.ok ? 'ok' : second?.code, count: after.download_count, log: after.log.length };
  }

  /* ---- S7: refund and cancel revoke; reopening lifts the automatic revocation ---- */
  {
    const p = await product();
    const o = await paid(p);
    const href = links(o)[0].files[0].href;
    await M.setOrderStatus(o.id, 'refunded', 'test');
    const refunded = (await LocalDB.getOrder(o.id)).entitlements[0];
    const r = await fetchLink(href);

    const o2 = await paid(p);
    const href2 = links(o2)[0].files[0].href;
    await M.setOrderStatus(o2.id, 'cancelled', 'test');
    const cancelled = (await LocalDB.getOrder(o2.id)).entitlements[0];
    const r2 = await fetchLink(href2);
    const reopened = await M.setOrderStatus(o2.id, 'processing', 'test');
    const r3 = await fetchLink(href2);
    out.s7 = {
      refunded: [refunded.revoked_reason, typeof refunded.revoked_at], status: r.status, reason: await reason(r),
      cancelled: cancelled.revoked_reason, status2: r2.status,
      reopened: reopened.ok, lifted: reopened.value?.entitlements?.[0]?.revoked_at ?? null, status3: r3.status,
    };
  }

  /* ---- S8: the LIVE check — a status written behind the hook's back still refuses ---- */
  {
    const p = await product();
    const o = await paid(p);
    const href = links(o)[0].files[0].href;
    await LocalDB.updateOrder(o.id, { status: 'cancelled' });
    const r = await fetchLink(href);
    await LocalDB.updateOrder(o.id, { status: 'processing', payment_status: 'refunded' });
    const r2 = await fetchLink(href);
    out.s8 = { status: r.status, reason: await reason(r), stored: (await LocalDB.getOrder(o.id)).entitlements[0].revoked_at ?? null, status2: r2.status };
  }

  /* ---- S9: forged, tampered and wrong-purpose tokens; HEAD does not count ---- */
  {
    const p = await product();
    const o = await paid(p);
    const href = links(o)[0].files[0].href;
    const token = decodeURIComponent(href.split('/api/downloads/')[1]);
    const [body, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), f: 1 })).toString('base64url') + '.' + sig;
    const receipt = M.makeReceiptToken(o.id);
    const res = [];
    for (const t of ['nonsense', forged, receipt, token.slice(0, -2) + 'xx']) {
      const r = await fetchLink(`/api/downloads/${encodeURIComponent(t)}`);
      res.push([r.status, await reason(r)]);
    }
    const head = await M.headFile({ params: { token } });
    const headBad = await M.headFile({ params: { token: 'nope' } });
    out.s9 = { res, head: head.status, headBad: headBad.status, count: (await LocalDB.getOrder(o.id)).entitlements[0].download_count };
  }

  /* ---- S10: staff routes — revoke, restore, reset, grant, and roles ---- */
  {
    const p = await product({ download_limit: 1 });
    const o = await paid(p);
    const eid = o.entitlements[0].id;
    const href = links(o)[0].files[1].href;
    await fetchLink(href);
    const exhausted = await fetchLink(href);
    const reset = await call(M.postOrderDownloads, { user: admin, params: { id: o.id }, method: 'POST', body: { action: 'reset', entitlement_id: eid } });
    const afterReset = await fetchLink(href);
    const revoke = await call(M.postOrderDownloads, { user: admin, params: { id: o.id }, method: 'POST', body: { action: 'revoke', entitlement_id: eid } });
    await call(M.postOrderDownloads, { user: admin, params: { id: o.id }, method: 'POST', body: { action: 'reset', entitlement_id: eid } });
    const afterRevoke = await fetchLink(href);
    const restore = await call(M.postOrderDownloads, { user: admin, params: { id: o.id }, method: 'POST', body: { action: 'restore', entitlement_id: eid } });
    const afterRestore = await fetchLink(href);
    const mgrGet = await call(M.getOrderDownloads, { user: manager, params: { id: o.id } });
    const mgrPost = await call(M.postOrderDownloads, { user: manager, params: { id: o.id }, method: 'POST', body: { action: 'revoke', entitlement_id: eid } });
    const anon = await call(M.getOrderDownloads, { params: { id: o.id } });
    const bad = await call(M.postOrderDownloads, { user: admin, params: { id: o.id }, method: 'POST', body: { action: 'delete', entitlement_id: eid } });
    const noEnt = await call(M.postOrderDownloads, { user: admin, params: { id: o.id }, method: 'POST', body: { action: 'revoke', entitlement_id: 'ent_nope' } });
    // An order that reached `processing` without the hook (an import): grant fills it in.
    const imported = await order(p);
    await LocalDB.updateOrder(imported.id, { status: 'completed' });
    const grant = await call(M.postOrderDownloads, { user: admin, params: { id: imported.id }, method: 'POST', body: { action: 'grant' } });
    const audits = (await LocalDB.getAuditEvents({ action: 'order.downloads.update' })) ?? [];
    out.s10 = {
      exhausted: exhausted.status, reset: reset.status, afterReset: afterReset.status,
      revoke: [revoke.status, revoke.json?.data?.entitlements?.[0]?.state], afterRevoke: afterRevoke.status,
      restore: restore.status, afterRestore: afterRestore.status,
      mgrGet: mgrGet.status, mgrLog: Array.isArray(mgrGet.json?.data?.entitlements?.[0]?.log), mgrPost: mgrPost.status, anon: anon.status,
      bad: bad.status, noEnt: noEnt.status,
      grant: [grant.status, grant.json?.data?.entitlements?.length], audits: audits.length,
    };
  }

  /* ---- S11: the buyer's list — links, never a location or the log ---- */
  {
    const p = await product();
    const o = await paid(p);
    await fetchLink(links(o)[0].files[0].href);
    const receipt = M.makeReceiptToken(o.id);
    const r = await call(M.listBuyerDownloads, { url: `http://localhost/api/downloads?receipt=${encodeURIComponent(receipt)}` });
    const text = r.buf.toString('utf8');
    const bad = await call(M.listBuyerDownloads, { url: 'http://localhost/api/downloads?receipt=nope' });
    const forged = dl.makeDownloadToken(o.id, o.entitlements[0], 0, 3600000);
    const wrongPurpose = await call(M.listBuyerDownloads, { url: `http://localhost/api/downloads?receipt=${encodeURIComponent(forged)}` });
    out.s11 = {
      status: r.status, n: r.json?.data?.length, hrefs: r.json?.data?.[0]?.files?.every((f) => /\/api\/downloads\/[^/]+$/.test(f.href)),
      remaining: r.json?.data?.[0]?.remaining,
      leaks: [text.includes(stored.file.id), text.includes('cdn.example.com'), text.includes('198.51.100.7'), text.includes('"log"')],
      bad: bad.status, wrongPurpose: wrongPurpose.status,
    };
  }

  /* ---- S12: GDPR — the export carries entitlements and log; erasure strips IPs and ends access ---- */
  {
    const p = await product();
    const o = await paid(p, { email: 'gdpr-dl@example.com' });
    const href = links(o)[0].files[0].href;
    await fetchLink(href, '203.0.113.200');
    const exported = await M.collectSubjectData('gdpr-dl@example.com');
    const exportText = JSON.stringify(exported);
    await M.eraseSubject('gdpr-dl@example.com');
    const after = (await LocalDB.getOrder(o.id)).entitlements?.[0];
    const r = await fetchLink(href);
    out.s12 = {
      exported: exportText.includes(o.entitlements[0].id) && exportText.includes('203.0.113.200'),
      ipGone: !JSON.stringify(after ?? {}).includes('203.0.113.200'), logKept: after?.log?.length, reason: after?.revoked_reason,
      count: after?.download_count, status: r.status,
    };
  }

  /* ---- S13: the catalogue a stranger reads names the files, never their location ---- */
  {
    const p = await product();
    const anon = await call(M.getProductRoute, { params: { id: p.id }, url: `http://localhost/api/products/${p.id}` });
    const staff = await call(M.getProductRoute, { user: admin, params: { id: p.id }, url: `http://localhost/api/products/${p.id}` });
    const list = await call(M.listProductsRoute, { url: 'http://localhost/api/products?limit=100' });
    const anonText = anon.buf.toString('utf8') + list.buf.toString('utf8');
    out.s13 = {
      anon: anon.status, names: anon.json?.data?.downloads?.map((d) => d.name), anonLeaks: anonText.includes(stored.file.id) || anonText.includes('cdn.example.com'),
      staffUrls: staff.json?.data?.downloads?.map((d) => d.url),
    };
  }

  /* ---- S14: the upload route — staff only, magic bytes, a private reference back ---- */
  {
    const mk = (bytes, name) => { const f = new FormData(); f.append('file', new Blob([bytes]), name); return f; };
    const ok = await call(M.uploadDownload, { user: admin, method: 'POST', url: 'http://localhost/api/downloads/upload', form: mk(PDF, 'a.pdf') });
    const zip = await call(M.uploadDownload, { user: admin, method: 'POST', url: 'http://localhost/api/downloads/upload', form: mk(Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(40)]), 'a.zip') });
    const txt = await call(M.uploadDownload, { user: admin, method: 'POST', url: 'http://localhost/api/downloads/upload', form: mk(Buffer.from('hello'), 'a.txt') });
    const anon = await call(M.uploadDownload, { method: 'POST', url: 'http://localhost/api/downloads/upload', form: mk(PDF, 'a.pdf') });
    const mgr = await call(M.uploadDownload, { user: { id: 'u-viewer', role: 'viewer' }, method: 'POST', url: 'http://localhost/api/downloads/upload', form: mk(PDF, 'a.pdf') });
    out.s14 = {
      ok: [ok.status, /^private:pf_[0-9a-f]{20}$/.test(ok.json?.data?.url ?? ''), JSON.stringify(ok.json).includes('/uploads')],
      zip: [zip.status, zip.json?.data?.mime_type], txt: txt.status, anon: anon.status, mgr: mgr.status,
    };
  }

  /* ---- S15: a merchant fixing a file's URL reaches existing buyers; a deleted product's buyers keep the frozen copy ---- */
  {
    const p = await product();
    const o = await paid(p);
    await M.saveProduct({ downloads: [{ name: 'Guide (PDF)', url: privateRef }, { name: 'Bonus', url: 'https://cdn.example.com/bonus-v2.zip' }] }, p.id);
    const r = await fetchLink(links(o)[0].files[1].href);
    await LocalDB.deleteProduct?.(p.id);
    const r2 = await fetchLink(links(o)[0].files[1].href);
    out.s15 = { live: r.headers.get('location'), frozen: r2.headers.get('location') };
  }

  /* ---- S16: a product file has its own id space and is never deleted by the form/erasure paths ---- */
  {
    const sameBytes = await M.storePrivateFile(PDF, 'returned.pdf', { form: 'contact' });
    const del = await M.deletePrivateFile(stored.file.id);
    const meta = await M.readPrivateFileMeta(stored.file.id);
    out.s16 = {
      differentId: sameBytes.ok && sameBytes.file.id !== stored.file.id,
      deleted: del, stillThere: !!meta, purpose: meta?.purpose ?? null, form: meta?.form ?? null,
    };
    // A private file gone from disk: refused, and NOT counted.
    const lost = await M.storePrivateFile(Buffer.from('%PDF-1.4\nlost file\n%%EOF\n'), 'lost.pdf', { purpose: 'product' });
    const p = await product({ downloads: [{ name: 'Lost', url: `private:${lost.file.id}` }] });
    const o = await paid(p);
    const href = links(o)[0].files[0].href;
    await fs.rm(path.join(process.env.PRIVATE_UPLOADS_DIR, lost.file.rel), { force: true });
    await fs.rm(path.join(process.env.PRIVATE_UPLOADS_DIR, path.dirname(lost.file.rel), `${lost.file.id}.json`), { force: true });
    const r = await fetchLink(href);
    out.s16.lost = { status: r.status, reason: await reason(r), count: (await LocalDB.getOrder(o.id)).entitlements[0].download_count };
  }

  return out;
}

if (process.env.DL_ENT_CHILD) {
  const M = await loadTs('tests/fixtures/download-entitlements-entry.ts', 'dlent');
  await M.LocalDB.init();
  const result = await child(M);
  console.log('__RESULT__' + JSON.stringify(result));
  process.exit(0);
}

/* --------------------------------------------------------------- parent --- */
let pass = 0;
let fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };
const j = JSON.stringify;
const same = (a, b) => j(a) === j(b);

/* ---- P: pure rules ---- */
{
  const F = await loadTs('src/lib/product-fields.ts', 'dlpf');
  const urls = (v) => F.normalizeDownloads(v).map((d) => d.url);
  check('P1: https, own media and a well-formed private reference are kept',
    same(urls([{ name: 'a', url: 'https://x.test/a.pdf' }, { name: 'b', url: '/uploads/b.pdf' }, { name: 'c', url: 'private:pf_0123456789abcdef0123' }]),
      ['https://x.test/a.pdf', '/uploads/b.pdf', 'private:pf_0123456789abcdef0123']));
  check('P1: javascript:, http:, //host and a malformed private reference are dropped',
    urls([{ url: 'javascript:alert(1)' }, { url: 'http://x.test/a' }, { url: '//evil.test/a' }, { url: '/\\evil.test/a' }, { url: 'private:pf_short' }, { url: 'private:../../etc' }]).length === 0);
  check('P1: a duplicate name is dropped (names are how an entitlement finds a file again)',
    F.normalizeDownloads([{ name: 'A', url: 'https://x.test/1' }, { name: 'A', url: 'https://x.test/2' }]).length === 1);
  check('P2: privateDownloadId reads only the exact shape', F.privateDownloadId('private:pf_0123456789abcdef0123') === 'pf_0123456789abcdef0123'
    && F.privateDownloadId('https://x') === null && F.privateDownloadId('private:pf_0123456789abcdef0123/x') === null);
  const proj = F.projectProductForReader({ name: 'x', downloads: [{ name: 'Guide', url: 'private:pf_0123456789abcdef0123' }] }, [], false);
  check(`P3: a stranger's projection keeps names, drops urls (${j(proj.downloads)})`, same(proj.downloads, [{ name: 'Guide' }]));
  check('P3: staff see the url', F.projectProductForReader({ downloads: [{ name: 'G', url: 'https://x' }] }, [], true).downloads[0].url === 'https://x');
  check('P4: a blank override is "use the default", 0 is kept', F.normalizeDownloadOverride('', 100) === null && F.normalizeDownloadOverride(0, 100) === 0
    && F.normalizeDownloadOverride('-3', 100) === null && F.normalizeDownloadOverride(1e9, 100) === 100);

  const D = await loadTs('src/lib/commerce/download-entitlements.ts', 'dlpure');
  const s = D.resolveDownloadSettings({});
  check(`P5: defaults are unlimited, 90 days, 24 h links (${j(s)})`, s.limit === 0 && s.expiryDays === 90 && s.linkTtlHours === 24);
  const s2 = D.resolveDownloadSettings({ downloads_limit_default: '5', downloads_expiry_days_default: 0, downloads_link_ttl_hours: 'junk' });
  check(`P5: settings are read through their keys; 0 is kept, junk is the default (${j(s2)})`, s2.limit === 5 && s2.expiryDays === 0 && s2.linkTtlHours === 24);
  check('P6: the product override wins; 0 means unlimited/never', D.effectiveLimit({ download_limit: 3 }, s2) === 3 && D.effectiveLimit({}, s2) === 5
    && D.effectiveLimit({ download_limit: 0 }, s2) === null && D.effectiveExpiryDays({}, s2) === null && D.effectiveExpiryDays({ download_expiry_days: 7 }, s2) === 7);
  check('P7: only processing/completed grant; on-hold, pending, refunded payment and erased do not',
    D.orderGrantsDownloads({ status: 'processing' }) && D.orderGrantsDownloads({ status: 'completed', payment_status: 'paid' })
    && !D.orderGrantsDownloads({ status: 'on-hold', payment_status: 'paid' }) && !D.orderGrantsDownloads({ status: 'pending' })
    && !D.orderGrantsDownloads({ status: 'completed', payment_status: 'refunded' }) && !D.orderGrantsDownloads({ status: 'completed', erased_at: '2026-01-01' }));
  const ent = { id: 'ent_' + 'a'.repeat(24), line: 0, product_id: 'p', name: 'X', files: [{ name: 'f', url: 'https://x' }], download_limit: 2, download_count: 2, file_counts: [2], expires_at: null, granted_at: '2026-01-01' };
  const live = { status: 'processing' };
  check('P8: a refunded or cancelled order reads as revoked, an unpaid one as inactive',
    D.entitlementState(ent, { status: 'cancelled' }) === 'revoked' && D.entitlementState(ent, { status: 'processing', payment_status: 'refunded' }) === 'revoked'
    && D.entitlementState(ent, { status: 'pending' }) === 'inactive' && D.entitlementState(ent, { status: 'on-hold' }) === 'inactive');
  check('P8: state precedence — order, revocation, expiry, count', D.entitlementState(ent, { status: 'pending' }) === 'inactive'
    && D.entitlementState({ ...ent, revoked_at: 'x' }, live) === 'revoked'
    && D.entitlementState({ ...ent, download_count: 0, expires_at: '2000-01-01T00:00:00Z' }, live) === 'expired'
    && D.entitlementState(ent, live) === 'exhausted' && D.entitlementState({ ...ent, file_counts: [1] }, live) === 'active');
  check('P8: exhausted only when EVERY file is at the limit',
    D.entitlementState({ ...ent, files: [{ name: 'a', url: 'https://x' }, { name: 'b', url: 'https://y' }], file_counts: [2, 1] }, live) === 'active'
    && D.remainingDownloads({ ...ent, file_counts: [1] }, 0) === 1 && D.remainingDownloads({ ...ent, download_limit: null }) === null);
  const prod = new Map([['p', { id: 'p', downloadable: true, downloads: [{ name: 'f', url: 'https://x' }] }]]);
  const order = { id: 'o', status: 'processing', items: [{ product_id: 'p', name: 'X', qty: 1, total_cents: 1 }], entitlements: [{ ...ent, revoked_at: 't', revoked_reason: 'refunded' }, { ...ent, id: 'ent_' + 'b'.repeat(24), line: 5, revoked_at: 't', revoked_reason: 'staff' }] };
  const plan = D.planEntitlements(order, prod, s, Date.now());
  check(`P9: reopening lifts an automatic revocation and keeps a staff one (${j(plan?.next?.map((e) => e.revoked_reason ?? null))})`,
    same(plan?.next?.map((e) => e.revoked_reason ?? null), [null, 'staff']) && plan.granted.length === 0);
  check('P9: a downloadable product without files grants nothing', D.planEntitlements({ ...order, entitlements: [] }, new Map([['p', { id: 'p', downloadable: true, downloads: [] }]]), s, 0) === null);

  const email = D.buildDownloadsReadyEmail({ email: 'b@example.com', number: 'N1\r\nBcc: x', id: 'o' }, [{ ...ent, name: '<b>Book</b>', download_limit: 3, expires_at: '2027-01-01T00:00:00.000Z' }], { receiptLink: 'https://shop.test/receipt?token=abc', siteTitle: 'Shop' });
  check('P10: the downloads email names the files and links to the receipt section',
    email.text.includes('https://shop.test/receipt?token=abc#downloads') && email.text.includes('3 downloads') && email.html.includes('&lt;b&gt;Book'));
  check('P10: ...carries no counted link, and the subject cannot inject headers',
    !email.text.includes('/api/downloads/') && !email.html.includes('/api/downloads/') && !/[\r\n]/.test(email.subject));
  check('P10: no receipt link or no address, no email', D.buildDownloadsReadyEmail({ email: 'b@example.com' }, [ent], {}) === null
    && D.buildDownloadsReadyEmail({ email: '' }, [ent], { receiptLink: 'x' }) === null);
  const C = await loadTs('src/lib/commerce/order-confirmation.ts', 'dlconf');
  const conf = C.buildOrderConfirmation({ email: 'b@example.com', number: 'N', items: [], total_cents: 0, currency: 'EUR' }, { receiptLink: 'https://s.test/receipt?token=t', hasDownloads: true });
  const confNo = C.buildOrderConfirmation({ email: 'b@example.com', number: 'N', items: [], total_cents: 0, currency: 'EUR' }, { receiptLink: 'https://s.test/receipt?token=t' });
  check('P11: the confirmation says where the downloads will be, only when there are some',
    conf.text.includes('#downloads') && conf.html.includes('#downloads') && !confNo.text.includes('#downloads'));
}

/* ---- per driver ---- */
const tmpRoot = path.join(os.tmpdir(), `astrobaas-dl-ent-${process.pid}`);
await fs.mkdir(tmpRoot, { recursive: true });

const DRIVERS = [
  { name: 'lowdb', env: (d) => ({ DB_PATH: path.join(d, 'db.json') }) },
  { name: 'libsql', env: (d) => ({ DATABASE_URL: `file:${path.join(d, 'db.sqlite')}` }) },
  { name: 'relational', env: (d) => ({ DATABASE_URL: `file:${path.join(d, 'db.sqlite')}`, DATABASE_DRIVER: 'relational' }) },
];

async function runChild(driver) {
  const dir = path.join(tmpRoot, driver.name);
  await fs.mkdir(path.join(dir, 'uploads'), { recursive: true });
  const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    env: {
      ...process.env, DL_ENT_CHILD: '1', NODE_ENV: 'test',
      AUTH_SECRET: 'download-entitlements-secret-0123456789',
      STAGING: '', ASTROBAAS_STAGING: '', RATE_LIMIT_STORE: '', SITE_URL: '', EMAIL_TRANSPORT: '',
      UPLOADS_DIR: path.join(dir, 'uploads'), PRIVATE_UPLOADS_DIR: path.join(dir, 'private'), ...driver.env(dir),
    },
  });
  const line = (run.stdout || '').split('\n').find((l) => l.startsWith('__RESULT__'));
  if (!line) {
    fail++;
    console.error(`✗ [${driver.name}] child produced no result\n${(run.stderr || '').slice(-3000)}`);
    return null;
  }
  return JSON.parse(line.slice('__RESULT__'.length));
}

for (const driver of DRIVERS) {
  const r = await runChild(driver);
  if (!r) continue;
  const t = (n, c) => check(`[${driver.name}] ${n}`, c);

  t(`S1: an unpaid order has no entitlements; paying grants one for the downloadable line only (${j(r.s1)})`,
    r.s1.before === null && r.s1.count === 1 && r.s1.line === 0 && same(r.s1.files, ['Guide (PDF)', 'Bonus']));
  t(`S1: shop defaults apply (unlimited, 30 days) (${r.s1.limit}, ${r.s1.expiresDays})`, r.s1.limit === null && r.s1.expiresDays === 30);
  t(`S1: a product override applies (limit 2, never expires) (${r.s1.overrideLimit}, ${r.s1.overrideExpiry})`, r.s1.overrideLimit === 2 && r.s1.overrideExpiry === null);
  t(`S1: on-hold grants nothing (${r.s1.onHold}); a second reconcile grants nothing new (${r.s1.again})`, r.s1.onHold === 0 && r.s1.again === 0);

  t(`S2: a private file is streamed byte-for-byte as an attachment (${r.s2.privStatus}, ${r.s2.disp})`,
    r.s2.privStatus === 200 && r.s2.same && /^attachment;/.test(r.s2.disp ?? '') && r.s2.disp.includes("filename*=UTF-8''") && r.s2.type === 'application/pdf');
  t('S2: ...with nosniff and no-store', r.s2.nosniff === 'nosniff' && /no-store/.test(r.s2.cache ?? ''));
  t('S2: the buyer\'s list carries neither the private id nor the external url', r.s2.hrefLeaks === false);
  t(`S2: an https file is a 302 to it (${r.s2.extStatus} → ${r.s2.location})`, r.s2.extStatus === 302 && r.s2.location === 'https://cdn.example.com/bonus.zip');
  t(`S2: both counted and logged with time, file and IP (${j(r.s2.log)})`,
    r.s2.count === 2 && same(r.s2.log, [['Guide (PDF)', '192.0.2.44', 'string'], ['Bonus', '198.51.100.7', 'string']]));

  t(`S3: LIMIT — 2 allowed, the 3rd refused 403 downloads.limit_reached (${j(r.s3)})`,
    same(r.s3.statuses, [200, 200, 403]) && r.s3.reason === 'downloads.limit_reached');
  t(`S3: ...per file: the purchase's other file still downloads, and counts are kept per file (${j(r.s3.perFile)})`,
    r.s3.other === 302 && r.s3.count === 3 && same(r.s3.perFile, [2, 1]) && same(r.s3.offered, [[false, 0], [true, 1]]));

  t(`S4: EXPIRY — an expired entitlement offers no link (${r.s4.href}, ${r.s4.state})`, r.s4.href === null && r.s4.state === 'expired');
  t(`S4: ...and a link minted earlier is refused 403 downloads.expired (${r.s4.status}, ${r.s4.reason})`, r.s4.status === 403 && r.s4.reason === 'downloads.expired');
  t(`S4: the boundary — allowed the day before expiry, refused after (${r.s4.before}, ${r.s4.after})`, r.s4.before === true && r.s4.after === 'expired');

  t(`S5: 8 downloads at once against a limit of 3 → exactly 3 (${j(r.s5)})`,
    r.s5.ok === 3 && r.s5.refused === 5 && r.s5.other.length === 0 && r.s5.count === 3);
  t(`S6: the interfering download really ran inside the first one's write (${r.s6.fired})`, r.s6.fired === true);
  t(`S6: limit 1, forced interleaving → exactly one granted, the other refused (${j(r.s6)})`,
    r.s6.second === 'ok' && r.s6.first === 'limit_reached' && r.s6.count === 1 && r.s6.log === 1);

  t(`S7: a refund revokes (reason refunded) and the link stops (${j(r.s7)})`,
    same(r.s7.refunded, ['refunded', 'string']) && r.s7.status === 403 && r.s7.reason === 'downloads.revoked');
  t('S7: a cancellation revokes (reason cancelled)', r.s7.cancelled === 'cancelled' && r.s7.status2 === 403);
  t(`S7: reopening the order lifts the automatic revocation (${j(r.s7)})`, r.s7.reopened && r.s7.lifted === null && r.s7.status3 === 200);

  t(`S8: a status written without the hook still refuses — the check is live (${j(r.s8)})`,
    r.s8.status === 403 && r.s8.stored === null && r.s8.status2 === 403);

  t(`S9: forged, tampered, garbage and a RECEIPT token are all 403 downloads.link_invalid (${j(r.s9.res)})`,
    r.s9.res.every(([s, why]) => s === 403 && why === 'downloads.link_invalid'));
  t(`S9: HEAD checks the link and does not count (${r.s9.head}/${r.s9.headBad}, count ${r.s9.count})`, r.s9.head === 204 && r.s9.headBad === 403 && r.s9.count === 0);

  t(`S10: reset reopens an exhausted entitlement (${r.s10.exhausted} → ${r.s10.reset} → ${r.s10.afterReset})`,
    r.s10.exhausted === 403 && r.s10.reset === 200 && r.s10.afterReset === 302);
  t(`S10: revoke stops it, restore brings it back (${j([r.s10.revoke, r.s10.afterRevoke, r.s10.restore, r.s10.afterRestore])})`,
    same(r.s10.revoke, [200, 'revoked']) && r.s10.afterRevoke === 403 && r.s10.restore === 200 && r.s10.afterRestore === 302);
  t(`S10: a manager reads (with the log) but cannot act; anonymous is 401 (${r.s10.mgrGet}/${r.s10.mgrPost}/${r.s10.anon})`,
    r.s10.mgrGet === 200 && r.s10.mgrLog && r.s10.mgrPost === 403 && r.s10.anon === 401);
  t(`S10: an unknown action is 422, an unknown entitlement 404 (${r.s10.bad}/${r.s10.noEnt})`, r.s10.bad === 422 && r.s10.noEnt === 404);
  t(`S10: grant fills in an order that reached a paid status by another path (${j(r.s10.grant)})`, same(r.s10.grant, [200, 1]));
  t(`S10: staff actions are audited (${r.s10.audits})`, r.s10.audits >= 4);

  t(`S11: the buyer list (receipt token) has links and the remaining count (${j(r.s11)})`,
    r.s11.status === 200 && r.s11.n === 1 && r.s11.hrefs === true && r.s11.remaining === null);
  t(`S11: ...and no private id, external url, IP or log (${j(r.s11.leaks)})`, r.s11.leaks.every((x) => x === false));
  t(`S11: a bad token and a download token used as a receipt are 404 (${r.s11.bad}/${r.s11.wrongPurpose})`, r.s11.bad === 404 && r.s11.wrongPurpose === 404);

  t(`S12: the subject export carries the entitlement and its log (${r.s12.exported})`, r.s12.exported === true);
  t(`S12: erasure removes the IP, keeps the count and log times, revokes (${j(r.s12)})`,
    r.s12.ipGone && r.s12.logKept === 1 && r.s12.count === 1 && r.s12.reason === 'erased' && r.s12.status === 403);

  t(`S13: a stranger's catalogue names the files and never their location (${j(r.s13)})`,
    r.s13.anon === 200 && same(r.s13.names, ['Guide (PDF)', 'Bonus']) && r.s13.anonLeaks === false);
  t('S13: staff still see the urls', r.s13.staffUrls?.[1] === 'https://cdn.example.com/bonus.zip' && /^private:pf_/.test(r.s13.staffUrls?.[0] ?? ''));

  t(`S14: staff upload → 201 and a private reference, no public path (${j(r.s14.ok)})`, same(r.s14.ok, [201, true, false]));
  t(`S14: a ZIP is accepted for a product, plain text is not (${j(r.s14.zip)}, ${r.s14.txt})`, same(r.s14.zip, [201, 'application/zip']) && r.s14.txt === 400);
  t(`S14: anonymous 401, a role without catalogue rights 403 (${r.s14.anon}/${r.s14.mgr})`, r.s14.anon === 401 && r.s14.mgr === 403);

  t(`S16: a form upload of a product file's exact bytes gets ANOTHER id (${j(r.s16)})`, r.s16.differentId === true);
  t('S16: the erasure/delete path refuses a product file, which stays marked as one, with no form',
    r.s16.deleted === false && r.s16.stillThere && r.s16.purpose === 'product' && r.s16.form === null);
  t(`S16: a private file gone from disk is 404 file_missing and costs no download (${j(r.s16.lost)})`,
    r.s16.lost.status === 404 && r.s16.lost.reason === 'downloads.file_missing' && r.s16.lost.count === 0);

  t(`S15: a fixed URL reaches existing buyers; a deleted product's buyers keep the frozen copy (${j(r.s15)})`,
    r.s15.live === 'https://cdn.example.com/bonus-v2.zip' && r.s15.frozen === 'https://cdn.example.com/bonus.zip');
}

await fs.rm(tmpRoot, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
