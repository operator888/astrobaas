#!/usr/bin/env node
/**
 * Order tags (lib/commerce/order-tags.ts and the routes over it).
 *
 * What is proved, and how:
 *
 *  - P: the pure rules — normalisation, identity, colour, counting. One
 *    process, no storage.
 *  - S: the write path on ALL THREE drivers, each in its own child process and
 *    database. The race scenarios FORCE the interleaving the way
 *    checkout-race.test.mjs does: the interfering request runs to completion
 *    immediately before the first one's decisive write, and the scenario first
 *    proves its hook FIRED (a hook that never fired makes every assertion
 *    vacuously true).
 *  - R: the routes — roles, validation, the `?tag=` filter, the counts, and
 *    that PUT /api/orders/{id} cannot write tags.
 *  - L: staff-only. A tagged order is pushed through every buyer-facing
 *    builder (confirmation, shipped and recovery emails, receipt), and the
 *    source is scanned so that a NEW reader of the tags has to be added to the
 *    allow-list here on purpose.
 *  - G: an erasure clears tags (free text; may be a name).
 *
 * Run with:  node tests/order-tags.test.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, loadTs } from './lib/load.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const has = (o, k) => !!o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);

/* ---------------------------------------------------------------- child --- */

function installHook(LocalDB) {
  let pending = null;
  let fired = 0;
  for (const name of ['getOrder', 'updateOrder', 'compareAndSetOrderTags', 'claimPaymentEvent']) {
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

/** The write that decides a tag edit — the CAS under the fix, a blind updateOrder before it. */
const tagWrite = (id) => (name, args) => args[0] === id
  && (name === 'compareAndSetOrderTags' || (name === 'updateOrder' && has(args[1], 'tags')));

async function child(M) {
  const { LocalDB, tags: T } = M;
  const hook = installHook(LocalDB);
  const out = {};
  let n = 0;
  const order = (over = {}) => {
    n += 1;
    return LocalDB.createOrder({
      number: `OT-${process.pid}-${n}`, status: 'processing', payment_status: 'pending',
      email: `tags${n}@example.com`, currency: 'EUR',
      items: [{ product_id: 'p', name: 'Line', qty: 1, total_cents: 1000 }],
      subtotal_cents: 1000, total_cents: 1000, ...over,
    });
  };
  const stored = async (id) => LocalDB.getOrder(id);
  const tagsOf = async (id) => (await stored(id))?.tags;

  /* ---- S1: add, and remove-all leaves NO key (not []) ---- */
  {
    const o = await order();
    const a = await T.addOrderTags(o.id, ['VIP', 'Needs review']);
    const afterAdd = await tagsOf(o.id);
    const r = await T.removeOrderTag(o.id, 'vip');
    const r2 = await T.removeOrderTag(o.id, 'NEEDS   review');
    const raw = await stored(o.id);
    out.s1 = {
      added: a.ok && a.changed, afterAdd, removed: r.ok && r.changed, removedSecond: r2.ok && r2.changed,
      hasKey: has(raw, 'tags'), value: raw.tags ?? null,
    };
  }

  /* ---- S2: case-insensitive identity, first spelling kept ---- */
  {
    const o = await order();
    await T.addOrderTags(o.id, ['VIP']);
    const again = await T.addOrderTags(o.id, ['vip', ' Vip ']);
    out.s2 = { tags: await tagsOf(o.id), changed: again.ok && again.changed };
  }

  /* ---- S3: the limit of ten, enforced by the module ---- */
  {
    const o = await order();
    const ten = Array.from({ length: 10 }, (_, i) => `t${i}`);
    const okTen = await T.addOrderTags(o.id, ten);
    const eleventh = await T.addOrderTags(o.id, ['t10']);
    const dupAtLimit = await T.addOrderTags(o.id, ['T3']);
    const o2 = await order();
    await T.addOrderTags(o2.id, ten.slice(0, 9));
    const two = await T.addOrderTags(o2.id, ['x1', 'x2']);
    out.s3 = {
      okTen: okTen.ok, eleventh: eleventh.ok ? 'ok' : eleventh.code, count: (await tagsOf(o.id)).length,
      dupAtLimit: dupAtLimit.ok && !dupAtLimit.changed,
      twoOverLimit: two.ok ? 'ok' : two.code, nineStill: (await tagsOf(o2.id)).length,
    };
  }

  /* ---- S4: two staff add DIFFERENT tags at once — both survive ---- */
  {
    const o = await order();
    let second = null;
    const fired = hook.before(tagWrite(o.id), async () => { second = await T.addOrderTags(o.id, ['Beta']); });
    const first = await T.addOrderTags(o.id, ['Alpha']);
    hook.disarm();
    out.s4 = { fired: fired(), first: first.ok, second: second?.ok === true, tags: (await tagsOf(o.id) ?? []).slice().sort() };
  }

  /* ---- S4b: the same, but the interference is a REMOVE ---- */
  {
    const o = await order();
    await T.addOrderTags(o.id, ['Keep', 'Drop']);
    const fired = hook.before(tagWrite(o.id), async () => { await T.removeOrderTag(o.id, 'Drop'); });
    await T.addOrderTags(o.id, ['New']);
    hook.disarm();
    out.s4b = { fired: fired(), tags: (await tagsOf(o.id) ?? []).slice().sort() };
  }

  /* ---- S4c: the limit is judged on what is there NOW, not on what was read ---- */
  {
    const o = await order();
    await T.addOrderTags(o.id, Array.from({ length: 9 }, (_, i) => `a${i}`));
    let second = null;
    const fired = hook.before(tagWrite(o.id), async () => { second = await T.addOrderTags(o.id, ['Z']); });
    const first = await T.addOrderTags(o.id, ['Y']);
    hook.disarm();
    const final = (await tagsOf(o.id)) ?? [];
    out.s4c = {
      fired: fired(), count: final.length,
      results: [first.ok ? 'ok' : first.code, second?.ok ? 'ok' : second?.code].sort(),
    };
  }

  /* ---- S5: a payment landing in between is not lost (and the tags are not) ---- */
  {
    const o = await order({ payment_status: 'pending' });
    const fired = hook.before(tagWrite(o.id), async () => {
      await LocalDB.updateOrder(o.id, { payment_status: 'paid', staff_note: 'called' });
    });
    await T.addOrderTags(o.id, ['Paid late']);
    hook.disarm();
    const after = await stored(o.id);
    out.s5 = { fired: fired(), tags: after.tags, payment: after.payment_status, note: after.staff_note };
  }

  /* ---- S6: six adds at once, any interleaving ---- */
  {
    const o = await order();
    const names = ['a', 'b', 'c', 'd', 'e', 'f'];
    const res = await Promise.all(names.map((t) => T.addOrderTags(o.id, [t])));
    out.s6 = { ok: res.filter((r) => r.ok).length, tags: ((await tagsOf(o.id)) ?? []).slice().sort() };
  }

  /* ---- S7: the SAME tag added twice at once is one tag ---- */
  {
    const o = await order();
    let second = null;
    const fired = hook.before(tagWrite(o.id), async () => { second = await T.addOrderTags(o.id, ['dup']); });
    await T.addOrderTags(o.id, ['DUP']);
    hook.disarm();
    out.s7 = { fired: fired(), tags: await tagsOf(o.id), secondOk: second?.ok === true };
  }

  /* ---- S8: a stored value the module did not write is repaired, not wedged ---- */
  {
    const junk = await order({ tags: 'not-a-list' });
    const dupes = await order({ tags: ['VIP', 'vip', '<b>x</b>', 7, 'ok'] });
    const a = await T.addOrderTags(junk.id, ['fine']);
    const b = await T.addOrderTags(dupes.id, ['more']);
    out.s8 = { junk: await tagsOf(junk.id), a: a.ok, dupes: await tagsOf(dupes.id), b: b.ok };
  }

  /* ---- S9: text a JSON path could mishandle survives, and edits keep working ---- */
  {
    const o = await order();
    const odd = ['Καλός πελάτης', 'He said "hi"', 'back\\slash', 'emoji 😀', "O'Brien", 'tab\there'];
    const a = await T.addOrderTags(o.id, odd);
    const b = await T.addOrderTags(o.id, ['after']);
    out.s9 = { a: a.ok, b: b.ok, tags: await tagsOf(o.id) };
  }

  /* ---- S10: a missing order ---- */
  {
    const r = await T.addOrderTags('nope', ['x']);
    const r2 = await T.removeOrderTag('nope', 'x');
    out.s10 = { add: r.ok ? 'ok' : r.code, remove: r2.ok ? 'ok' : r2.code };
  }

  /* ---- S11: the change feed records the write, naming only `tags` ---- */
  {
    const o = await order();
    await T.addOrderTags(o.id, ['Feed']);
    const changes = (await LocalDB.getContentChanges()).filter((c) => c.entity_id === o.id && c.action === 'update');
    out.s11 = { count: changes.length, fields: changes[0]?.fields ?? null };
  }

  /* ---- B: global rename and remove ---- */
  {
    // Names of their own: the database is shared with every scenario above.
    const a = await order({ tags: ['BulkVIP', 'Fragile'] });
    const b = await order({ tags: ['bulkvip'] });
    const c = await order({ tags: ['Other'] });
    const d = await order({ tags: ['BulkVIP', 'Premium'] });
    const r = await T.renameOrderTag('BulkVIP', 'Premium');
    out.b1 = {
      ok: r.ok, outcome: r.ok ? r.outcome : null,
      a: await tagsOf(a.id), b: await tagsOf(b.id), c: await tagsOf(c.id), d: await tagsOf(d.id),
    };
    const re = await T.renameOrderTag('premium', 'PREMIUM');
    out.b2 = { ok: re.ok, a: await tagsOf(a.id) };
    const del = await T.deleteOrderTagEverywhere('fragile');
    out.b3 = { ok: del.ok, outcome: del.ok ? del.outcome : null, a: await tagsOf(a.id) ?? null, aHasKey: has(await stored(a.id), 'tags') };
    const bad = await T.renameOrderTag('x', '<script>');
    out.b4 = { code: bad.ok ? 'ok' : bad.code };
  }
  /* ---- B5: an edit that lands inside a rename is merged ---- */
  {
    const a = await order({ tags: ['Old'] });
    let landed = null;
    const fired = hook.before(tagWrite(a.id), async () => { landed = await T.addOrderTags(a.id, ['Late']); });
    const r = await T.renameOrderTag('Old', 'New');
    hook.disarm();
    out.b5 = { fired: fired(), landed: landed?.ok === true, ok: r.ok, tags: ((await tagsOf(a.id)) ?? []).slice().sort() };
  }

  /* ---- C: counts and the list filter over stored orders ---- */
  {
    const all = await LocalDB.getOrders();
    const counts = T.countOrderTags(all);
    out.c = { counts: counts.map((x) => [x.tag, x.count]).slice(0, 3) };
  }

  /* ---- R: routes ---- */
  {
    const admin = { id: 'u-admin', role: 'admin' };
    const manager = { id: 'u-man', role: 'manager' };
    const call = async (fn, { user = admin, params = {}, url = 'http://localhost/api/orders', method = 'GET', body } = {}) => {
      const res = await fn({
        params, url: new URL(url), locals: { user, ip: '203.0.113.7' },
        request: new Request(url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }),
      });
      const json = await res.json().catch(() => null);
      return { status: res.status, json };
    };
    const o = await order();
    const secret = 'Route-Tag-Σ';

    const add = await call(M.postOrderTags, { params: { id: o.id }, method: 'POST', body: { tag: secret } });
    const addMgr = await call(M.postOrderTags, { params: { id: o.id }, method: 'POST', body: { tag: 'x' }, user: manager });
    const addAnon = await call(M.postOrderTags, { params: { id: o.id }, method: 'POST', body: { tag: 'x' }, user: null });
    const getMgr = await call(M.getOrderTags, { params: { id: o.id }, user: manager });
    const bad1 = await call(M.postOrderTags, { params: { id: o.id }, method: 'POST', body: { tag: '<img src=x onerror=alert(1)>' } });
    const bad2 = await call(M.postOrderTags, { params: { id: o.id }, method: 'POST', body: { tag: '   ' } });
    const bad3 = await call(M.postOrderTags, { params: { id: o.id }, method: 'POST', body: { tag: 'x'.repeat(41) } });
    const bad4 = await call(M.postOrderTags, { params: { id: o.id }, method: 'POST', body: { tags: Array.from({ length: 11 }, (_, i) => `r${i}`) } });
    const bad5 = await call(M.postOrderTags, { params: { id: o.id }, method: 'POST', body: { nothing: 1 } });
    const bad6 = await call(M.postOrderTags, { params: { id: o.id }, method: 'POST', body: { tag: 42 } });
    const missing = await call(M.postOrderTags, { params: { id: 'nope' }, method: 'POST', body: { tag: 'x' } });
    out.r1 = {
      add: [add.status, add.json?.data?.tags?.map((t) => t.tag), add.json?.data?.max, typeof add.json?.data?.tags?.[0]?.color],
      mgrWrite: addMgr.status, anonWrite: addAnon.status, mgrRead: getMgr.status,
      bad: [bad1.status, bad2.status, bad3.status, bad4.status, bad5.status, bad6.status],
      badReason: bad1.json?.error?.reason, tooMany: bad4.json?.error?.reason, missing: missing.status,
    };

    // The filter, case-insensitively and with an invalid value.
    const other = await order({ tags: ['Something else'] });
    const f1 = await call(M.listOrders, { url: `http://localhost/api/orders?tag=${encodeURIComponent(secret.toLowerCase())}` });
    const f2 = await call(M.listOrders, { url: 'http://localhost/api/orders?tag=%3Cb%3E' });
    const f3 = await call(M.listOrders, { url: 'http://localhost/api/orders?tag=' });
    const f4 = await call(M.listOrders, { url: 'http://localhost/api/orders?limit=200' });
    out.r2 = {
      filtered: f1.json?.data?.map((x) => x.id), expected: o.id,
      invalid: f2.json?.data?.length, empty: f3.json?.data?.length,
      unfilteredHasBoth: !!f4.json?.data?.some((x) => x.id === o.id) && !!f4.json?.data?.some((x) => x.id === other.id),
    };

    // The counts route.
    const counts = await call(M.getTagCounts, { url: 'http://localhost/api/orders/tags' });
    const countsMgr = await call(M.getTagCounts, { user: manager });
    const countsAnon = await call(M.getTagCounts, { user: null });
    out.r3 = {
      status: counts.status, sample: counts.json?.data?.find((x) => x.tag === secret) ?? null,
      max: counts.json?.meta?.max_per_order, mgr: countsMgr.status, anon: countsAnon.status,
    };

    // PUT cannot write tags; it still saves what it should.
    const put = await call(M.putOrder, { params: { id: other.id }, method: 'PUT', body: { tags: ['hacked'], staff_note: 'n' } });
    const afterPut = await stored(other.id);
    out.r4 = { status: put.status, tags: afterPut.tags, note: afterPut.staff_note };

    // GET one order shows tags to staff.
    const one = await call(M.getOrder, { params: { id: o.id } });
    out.r5 = { tags: one.json?.data?.tags };

    // Remove.
    const rm = await call(M.deleteOrderTag, { params: { id: o.id }, method: 'DELETE', url: `http://localhost/x?tag=${encodeURIComponent(secret.toUpperCase())}` });
    const rmNone = await call(M.deleteOrderTag, { params: { id: o.id }, method: 'DELETE', url: 'http://localhost/x' });
    out.r6 = { status: rm.status, tags: rm.json?.data?.tags, noTag: rmNone.status, mgr: (await call(M.deleteOrderTag, { params: { id: o.id }, method: 'DELETE', user: manager, url: 'http://localhost/x?tag=a' })).status };

    // Bulk routes + audit holds counts and never the text.
    const bulkOrder = await order({ tags: ['Bulk-Secret-Name'] });
    const ren = await call(M.patchTags, { method: 'PATCH', url: 'http://localhost/api/orders/tags', body: { from: 'bulk-secret-name', to: 'Bulk-Renamed' } });
    const renMgr = await call(M.patchTags, { method: 'PATCH', user: manager, body: { from: 'a', to: 'b' } });
    const renBad = await call(M.patchTags, { method: 'PATCH', body: { from: 'a' } });
    const del = await call(M.deleteTagEverywhere, { method: 'DELETE', url: 'http://localhost/api/orders/tags?tag=Bulk-Renamed' });
    const delBad = await call(M.deleteTagEverywhere, { method: 'DELETE', url: 'http://localhost/api/orders/tags' });
    await sleep(300);
    const audits = [
      ...(await LocalDB.getAuditEvents({ action: 'order.tags.update' })),
      ...(await LocalDB.getAuditEvents({ action: 'order.tags.bulk' })),
    ];
    const blob = JSON.stringify(audits);
    out.r7 = {
      ren: [ren.status, ren.json?.data?.tag, ren.json?.data?.changed], renMgr: renMgr.status, renBad: renBad.status,
      del: [del.status, del.json?.data?.changed], delBad: delBad.status,
      after: await tagsOf(bulkOrder.id) ?? null,
      audits: audits.length,
      auditLeaksText: /Bulk-|Route-Tag|Σ/.test(blob),
    };
  }

  /* ---- L: buyer-facing builders never carry a tag ---- */
  {
    const SENT = 'LEAK-SENTINEL-VIP';
    const o = await order({
      tags: [SENT], staff_note: 'internal', tracking_number: 'TRK1', tracking_carrier: 'ELTA',
      payment_method: 'bank-transfer',
    });
    const full = await stored(o.id);
    const conf = M.buildOrderConfirmation(full, { siteTitle: 'Shop', instructions: 'IBAN', receiptLink: 'https://x/r' });
    const shipped = M.buildShippedNotice(full, { siteTitle: 'Shop' });
    const recov = M.buildRecoveryNotice(full, { siteTitle: 'Shop', instructions: 'IBAN' });
    const rec = M.receiptView(full, (c) => String(c));
    out.l = {
      built: [!!conf, !!shipped, !!recov],
      leaks: [conf, shipped, recov, rec].map((x) => JSON.stringify(x).includes(SENT)),
    };
  }

  /* ---- G: an erasure clears tags ---- */
  {
    const o = await order({ email: 'erase-tags@example.com', name: 'Mr Papas', tags: ['Papas - fraud?', 'VIP'], staff_note: 'keep me' });
    await M.eraseSubject('erase-tags@example.com');
    const after = await stored(o.id);
    // `=== undefined`, not a key test: the lowdb document holds the key with an
    // undefined value until it is next serialised, and JSON drops it.
    out.g = { hasTags: after.tags !== undefined, erased: typeof after.erased_at === 'string', note: after.staff_note, email: after.email.startsWith('erased+') };
  }

  return out;
}

if (process.env.ORDER_TAGS_CHILD) {
  const M = await loadTs('tests/fixtures/order-tags-entry.ts', 'ordertags');
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
  const T = await loadTs('src/lib/commerce/order-tags.ts', 'ordertagspure');
  const ok = (raw) => { const r = T.normalizeOrderTag(raw); return r.ok ? r.tag : `!${r.reason}`; };

  check('P1: trims and collapses whitespace', ok('  Needs \t\n  review ') === 'Needs review');
  check('P1: removes zero-width and bidi-override characters', ok('V​I‮P') === 'VIP');
  check('P1: removes control characters', ok('a\u0000b\u0007c') === 'abc');
  check('P1: a tag of only hidden characters is empty', ok('​‍') === '!empty');
  check('P1: empty and blank are refused', ok('') === '!empty' && ok('   ') === '!empty');
  check('P1: non-strings are refused, not coerced', ok(42) === '!not_text' && ok(null) === '!not_text' && ok(['a']) === '!not_text');
  check('P1: < and > are refused rather than stripped', ok('<b>x</b>') === '!invalid_characters' && ok('a > b') === '!invalid_characters');
  check('P1: 40 characters pass, 41 do not', ok('x'.repeat(40)) === 'x'.repeat(40) && ok('x'.repeat(41)) === '!too_long');
  check('P1: the cap counts characters, not UTF-16 units (40 emoji pass)', ok('😀'.repeat(40)) === '😀'.repeat(40) && ok('😀'.repeat(41)) === '!too_long');
  check('P1: Greek and quotes are kept', ok('Καλός "πελάτης"') === 'Καλός "πελάτης"');
  check('P1: a decomposed accent is normalised (NFC)', ok('Café') === 'Café');

  check('P2: identity ignores case', T.orderTagKey('VIP') === T.orderTagKey('vip'));
  check('P2: identity ignores Unicode composition', T.orderTagKey('Café') === T.orderTagKey('Café'));
  check('P2: Greek case-folds (ΚΑΛΟΣ = καλος)', T.orderTagKey('ΚΑΛΟΣ') === T.orderTagKey('καλος'));
  check('P2: different words differ', T.orderTagKey('VIP') !== T.orderTagKey('VIPs'));

  const palette = T.ORDER_TAG_COLORS;
  check('P3: a colour is always one of the fixed palette', ['VIP', 'x', 'Καλός', '😀', 'Fraud', 'a'.repeat(40)].every((t) => palette.includes(T.orderTagColor(t))));
  check('P3: the same tag is the same colour in any casing', T.orderTagColor('VIP') === T.orderTagColor('vip') && T.orderTagColor('Fraud') === T.orderTagColor('FRAUD'));
  check('P3: colours are stable across releases (pinned) — a change recolours every tag a shop has',
    same(['VIP', 'Fraud', 'Damaged', 'Needs review', 'Fragile'].map(T.orderTagColor), ['indigo', 'blue', 'amber', 'amber', 'orange']));
  const spread = new Set(Array.from({ length: 60 }, (_, i) => T.orderTagColor(`tag-${i}`)));
  check('P3: the palette is actually used (>= 6 of 10 colours over 60 tags)', spread.size >= 6);

  check('P4: orderTagsOf drops junk, duplicates and over-long lists', same(
    T.orderTagsOf({ tags: ['VIP', 'vip', 7, null, '<x>', ' ok ', ...Array.from({ length: 20 }, (_, i) => `z${i}`)] }).slice(0, 3),
    ['VIP', 'ok', 'z0']) && T.orderTagsOf({ tags: Array.from({ length: 20 }, (_, i) => `z${i}`) }).length === 10);
  check('P4: a non-list is no tags', same(T.orderTagsOf({ tags: 'VIP' }), []) && same(T.orderTagsOf({}), []) && same(T.orderTagsOf(null), []));

  const sample = [
    { tags: ['VIP', 'Fragile'] }, { tags: ['vip'] }, { tags: ['VIP', 'vip'] }, {}, { tags: ['Zeta'] }, { tags: ['alpha'] },
  ];
  const counts = T.countOrderTags(sample).map((c) => [c.tag, c.count]);
  check('P5: counts ORDERS (an order with VIP and vip counts once), merged by case', same(counts[0], ['VIP', 3]));
  check('P5: ties are alphabetical, so the order is total', same(counts.slice(1).map((c) => c[0]), ['alpha', 'Fragile', 'Zeta']));
  check('P5: the shown spelling is the most used one', T.countOrderTags([{ tags: ['vip'] }, { tags: ['vip'] }, { tags: ['VIP'] }])[0].tag === 'vip');
  check('P6: filterOrdersByTag matches any casing and nothing for a bad tag',
    T.filterOrdersByTag(sample, ' VIP ').length === 3 && T.filterOrdersByTag(sample, '<b>').length === 0 && T.filterOrdersByTag(sample, '').length === 0);
}

/* ---- L2: who may read the tags (source scan) ---- */
{
  const ALLOWED = new Set([
    'src/lib/commerce/order-tags.ts',
    'src/pages/admin/orders.astro',
    'src/pages/api/orders/index.ts',
    'src/pages/api/orders/tags.ts',
    'src/pages/api/orders/[id]/tags.ts',
  ]);
  const found = [];
  async function walk(dir) {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) await walk(abs);
      else if (/\.(ts|astro|mjs|js)$/.test(e.name)) {
        const src = await fs.readFile(abs, 'utf8');
        if (/order-tags['"]/.test(src)) found.push(path.relative(ROOT, abs).split(path.sep).join('/'));
      }
    }
  }
  await walk(path.join(ROOT, 'src'));
  const stray = found.filter((f) => !ALLOWED.has(f));
  check(`L2: only staff surfaces import the tag module (stray: ${j(stray)}) — a buyer-facing reader must be added here on purpose`, stray.length === 0);
  check('L2: every allowed importer really exists and imports it', [...ALLOWED].filter((f) => f !== 'src/lib/commerce/order-tags.ts').every((f) => found.includes(f)));

  // Buyer-facing and export code reads fields by name; none may name `.tags` on an order.
  const surfaces = [
    'src/lib/commerce/receipt.ts', 'src/lib/commerce/order-confirmation.ts', 'src/lib/commerce/shipped-notice.ts',
    'src/lib/commerce/recovery-notice.ts', 'src/lib/commerce/order-lookup.ts', 'src/pages/receipt.astro',
    'src/pages/receipt.pdf.ts', 'src/pages/api/payments/start.ts',
  ];
  const naming = [];
  for (const f of surfaces) {
    const src = await fs.readFile(path.join(ROOT, f), 'utf8');
    if (/\border\.tags\b|\bo\.tags\b|\['tags'\]/.test(src)) naming.push(f);
  }
  check(`L2: no buyer-facing surface names an order's tags (${j(naming)})`, naming.length === 0);
}

/* ---- per driver ---- */
const tmpRoot = path.join(os.tmpdir(), `astrobaas-order-tags-${process.pid}`);
await fs.mkdir(tmpRoot, { recursive: true });

const DRIVERS = [
  { name: 'lowdb', env: (d) => ({ DB_PATH: path.join(d, 'db.json') }) },
  { name: 'libsql', env: (d) => ({ DATABASE_URL: `file:${path.join(d, 'db.sqlite')}` }) },
  { name: 'relational', env: (d) => ({ DATABASE_URL: `file:${path.join(d, 'db.sqlite')}`, DATABASE_DRIVER: 'relational' }) },
];

function runChild(driver) {
  const dir = path.join(tmpRoot, driver.name);
  return fs.mkdir(path.join(dir, 'uploads'), { recursive: true }).then(() => {
    const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env, ORDER_TAGS_CHILD: '1', NODE_ENV: 'test',
        AUTH_SECRET: 'order-tags-secret-0123456789abcdef',
        STAGING: '', ASTROBAAS_STAGING: '', RATE_LIMIT_STORE: '', SITE_URL: '',
        UPLOADS_DIR: path.join(dir, 'uploads'), ...driver.env(dir),
      },
    });
    const line = (run.stdout || '').split('\n').find((l) => l.startsWith('__RESULT__'));
    if (!line) {
      fail++;
      console.error(`✗ [${driver.name}] child produced no result\n${(run.stderr || '').slice(-2500)}`);
      return null;
    }
    return JSON.parse(line.slice('__RESULT__'.length));
  });
}

for (const driver of DRIVERS) {
  const r = await runChild(driver);
  if (!r) continue;
  const t = (n, c) => check(`[${driver.name}] ${n}`, c);

  for (const k of ['s4', 's4b', 's4c', 's5', 's7', 'b5']) {
    t(`${k}: the interfering request really ran inside the first`, r[k]?.fired === true);
  }

  t(`S1: add stores, removal is case-insensitive (${j(r.s1)})`,
    r.s1.added && same(r.s1.afterAdd, ['VIP', 'Needs review']) && r.s1.removed && r.s1.removedSecond);
  t('S1: ...and an order with no tags has NO key, not []', r.s1.hasKey === false && r.s1.value === null);

  t(`S2: VIP / vip / " Vip " are one tag, first spelling kept (${j(r.s2)})`, same(r.s2.tags, ['VIP']) && r.s2.changed === false);

  t(`S3: ten tags fit (${r.s3.okTen}), the eleventh is refused and not written (${r.s3.eleventh}, count ${r.s3.count})`,
    r.s3.okTen && r.s3.eleventh === 'too_many' && r.s3.count === 10);
  t('S3: re-adding an existing tag at the limit is a no-op, not a refusal', r.s3.dupAtLimit);
  t(`S3: two new tags on nine are refused WHOLE — neither written (${r.s3.twoOverLimit}, now ${r.s3.nineStill})`,
    r.s3.twoOverLimit === 'too_many' && r.s3.nineStill === 9);

  t(`S4: two staff adding different tags at once BOTH land (${j(r.s4)})`,
    r.s4.first && r.s4.second && same(r.s4.tags, ['Alpha', 'Beta']));
  t(`S4b: an add that overlaps a remove keeps the remove (${j(r.s4b.tags)})`, same(r.s4b.tags, ['Keep', 'New']));
  t(`S4c: with nine tags, two overlapping adds → exactly one lands, the other is refused (${j(r.s4c)})`,
    r.s4c.count === 10 && same(r.s4c.results, ['ok', 'too_many']));
  t(`S5: a payment and a note landing in between are not lost (${j(r.s5)})`,
    same(r.s5.tags, ['Paid late']) && r.s5.payment === 'paid' && r.s5.note === 'called');
  t(`S6: six simultaneous adds all land (${j(r.s6)})`, r.s6.ok === 6 && same(r.s6.tags, ['a', 'b', 'c', 'd', 'e', 'f']));
  t(`S7: the same tag added twice at once is one tag, whichever landed first (${j(r.s7.tags)})`,
    r.s7.tags?.length === 1 && r.s7.tags[0].toLowerCase() === 'dup' && r.s7.secondOk);
  t(`S8: a stored non-list is repaired by the next edit (${j(r.s8.junk)})`, r.s8.a && same(r.s8.junk, ['fine']));
  t(`S8: stored duplicates, markup and non-strings are cleaned on the next edit (${j(r.s8.dupes)})`,
    r.s8.b && same(r.s8.dupes, ['VIP', 'ok', 'more']));
  t(`S9: quotes, backslash, emoji, Greek survive, and a LATER edit still works (${j(r.s9.tags)})`,
    r.s9.a && r.s9.b && same(r.s9.tags, ['Καλός πελάτης', 'He said "hi"', 'back\\slash', 'emoji 😀', "O'Brien", 'tab here', 'after']));
  t(`S10: a missing order is not_found (${j(r.s10)})`, r.s10.add === 'not_found' && r.s10.remove === 'not_found');
  t(`S11: the change feed records it, naming only tags (${j(r.s11)})`, r.s11.count === 1 && same(r.s11.fields, ['tags']));

  t(`B1: rename VIP→Premium rewrites every casing, merges onto an existing tag, keeps order (${j([r.b1.a, r.b1.b, r.b1.c, r.b1.d])})`,
    r.b1.ok && same(r.b1.a, ['Premium', 'Fragile']) && same(r.b1.b, ['Premium']) && same(r.b1.c, ['Other']) && same(r.b1.d, ['Premium']));
  t(`B1: ...reporting what changed (${j(r.b1.outcome)})`, r.b1.outcome.changed === 3 && r.b1.outcome.failed === 0);
  t(`B2: a casing-only rename re-spells (${j(r.b2.a)})`, r.b2.ok && same(r.b2.a, ['PREMIUM', 'Fragile']));
  t(`B3: delete-everywhere removes it, and an emptied order has no key (${j(r.b3)})`,
    r.b3.ok && same(r.b3.a, ['PREMIUM']) && r.b3.outcome.changed === 1);
  t(`B4: renaming to an invalid tag is refused (${r.b4.code})`, r.b4.code === 'invalid');
  t(`B5: an edit landing inside a rename is merged, not overwritten (${j(r.b5)})`,
    r.b5.ok && r.b5.landed && same(r.b5.tags, ['Late', 'New']));

  t(`R1: staff add → 200 with the tag, colour and limit (${j(r.r1.add)})`,
    r.r1.add[0] === 200 && same(r.r1.add[1], ['Route-Tag-Σ']) && r.r1.add[2] === 10 && r.r1.add[3] === 'string');
  t(`R1: a manager can read but not write; anonymous gets 401 (${r.r1.mgrRead}/${r.r1.mgrWrite}/${r.r1.anonWrite})`,
    r.r1.mgrRead === 200 && r.r1.mgrWrite === 403 && r.r1.anonWrite === 401);
  t(`R1: markup, blank, 41 chars, 11 tags, no body, non-text are 422 (${j(r.r1.bad)})`, r.r1.bad.every((s) => s === 422));
  t(`R1: ...with a machine reason (${r.r1.badReason}, ${r.r1.tooMany})`, r.r1.badReason === 'order_tags.invalid' && r.r1.tooMany === 'order_tags.too_many');
  t(`R1: an unknown order is 404 (${r.r1.missing})`, r.r1.missing === 404);

  t(`R2: ?tag= filters, any casing (${r.r2.filtered?.length})`, same(r.r2.filtered, [r.r2.expected]));
  t(`R2: an invalid tag matches NOTHING, not everything (${r.r2.invalid}); an empty ?tag= too (${r.r2.empty})`, r.r2.invalid === 0 && r.r2.empty === 0);
  t('R2: with no ?tag= the list is unfiltered', r.r2.unfilteredHasBoth);

  t(`R3: counts route lists the tag with its number of orders (${j(r.r3.sample)})`,
    r.r3.status === 200 && r.r3.sample?.count === 1 && typeof r.r3.sample?.color === 'string' && r.r3.max === 10);
  t(`R3: manager may read, anonymous may not (${r.r3.mgr}/${r.r3.anon})`, r.r3.mgr === 200 && r.r3.anon === 401);

  t(`R4: PUT /api/orders/{id} cannot write tags, and still saves the note (${j(r.r4)})`,
    r.r4.status === 200 && same(r.r4.tags, ['Something else']) && r.r4.note === 'n');
  t(`R5: staff GET /api/orders/{id} shows the tags (${j(r.r5.tags)})`, same(r.r5.tags, ['Route-Tag-Σ']));
  t(`R6: DELETE ?tag= removes (any casing), no ?tag= is 422, a manager is 403 (${j(r.r6)})`,
    r.r6.status === 200 && same(r.r6.tags, []) && r.r6.noTag === 422 && r.r6.mgr === 403);
  t(`R7: bulk rename and delete routes work and are role-gated (${j(r.r7)})`,
    same(r.r7.ren, [200, 'Bulk-Renamed', 1]) && r.r7.renMgr === 403 && r.r7.renBad === 422
    && same(r.r7.del, [200, 1]) && r.r7.delBad === 422 && r.r7.after === null);
  t(`R7: the audit trail records the edits and holds NO tag text (${r.r7.audits} entries)`,
    r.r7.audits >= 4 && r.r7.auditLeaksText === false);

  t(`L: the confirmation, shipped and recovery emails and the receipt are built (${j(r.l.built)})`, r.l.built.every(Boolean));
  t(`L: ...and none of the four carries a tag (${j(r.l.leaks)})`, r.l.leaks.every((x) => x === false));

  t(`G: an erasure clears tags and keeps the shop's own note (${j(r.g)})`,
    r.g.erased && r.g.hasTags === false && r.g.note === 'keep me' && r.g.email);
}

await fs.rm(tmpRoot, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
