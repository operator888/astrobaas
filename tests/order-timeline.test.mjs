#!/usr/bin/env node
/**
 * Order timeline (lib/commerce/order-timeline.ts and the route over it).
 *
 * What is proved, and how:
 *
 *  - P: the pure rules — categories, entry normalisation, derived items,
 *    ordering, actors. One process, no storage.
 *  - S: the write path on ALL THREE drivers, each in its own child process and
 *    database. The race scenarios FORCE the interleaving the way
 *    order-tags.test.mjs does: the interfering append runs to completion
 *    immediately before the first one's decisive write, and the scenario first
 *    proves its hook FIRED (a hook that never fired makes every assertion
 *    vacuously true).
 *  - W: the real writers — setOrderStatus, applyVerifiedEvent, the staff-note
 *    PUT, the tag module, the ship route — each driven for real, not with a
 *    hand-built entry (recurring-bug-patterns #12).
 *  - R: the route — roles, filter, paging, CSV, comments.
 *  - L: staff-only. Every order endpoint is asked for an order with a stored
 *    timeline and must not carry it; the buyer-facing builders are fed the
 *    same order; the source is scanned so a NEW reader has to be added here.
 *  - G: an erasure clears the free text and keeps the facts.
 *
 * Run with:  node tests/order-timeline.test.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, loadTs } from './lib/load.mjs';

const has = (o, k) => !!o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);

/* ---------------------------------------------------------------- child --- */

function installHook(LocalDB) {
  let pending = null;
  let fired = 0;
  for (const name of ['getOrder', 'updateOrder', 'compareAndSetOrderTimeline', 'compareAndSetOrderTags']) {
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

/** The write that decides an append — the CAS under the fix. */
const timelineWrite = (id) => (name, args) => args[0] === id && name === 'compareAndSetOrderTimeline';

async function child(M) {
  const { LocalDB, timeline: T, tags: G } = M;
  const hook = installHook(LocalDB);
  const out = {};
  let n = 0;
  const order = (over = {}) => {
    n += 1;
    return LocalDB.createOrder({
      number: `OTL-${process.pid}-${n}`, status: 'processing', payment_status: 'pending',
      email: `tl${n}@example.com`, currency: 'EUR',
      items: [{ product_id: 'p', name: 'Line', qty: 1, total_cents: 5000 }],
      subtotal_cents: 5000, total_cents: 5000, ...over,
    });
  };
  const stored = (id) => LocalDB.getOrder(id);
  const view = async (id) => T.buildOrderTimeline(await stored(id));
  const events = async (id) => (await view(id)).map((i) => i.event);
  const admin = { id: 'u-admin', role: 'admin', name: 'Ada Admin' };
  const manager = { id: 'u-man', role: 'manager' };
  const call = async (fn, { user = admin, params = {}, url = 'http://localhost/x', method = 'GET', body } = {}) => {
    const res = await fn({
      params, url: new URL(url), locals: { user, ip: '203.0.113.7' },
      request: new Request(url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* csv */ }
    return { status: res.status, json, text, headers: res.headers };
  };

  /* ---- S1: a fresh order has only what its own fields say ---- */
  {
    const o = await order();
    const v = await view(o.id);
    out.s1 = { events: v.map((i) => i.event), derived: v.every((i) => i.derived), hasKey: has(await stored(o.id), 'timeline') };
  }

  /* ---- S2: append, newest first, id/actor/at stamped by the module ---- */
  {
    const o = await order();
    const a = await T.appendOrderTimeline(o.id, [{ event: 'bulk.status', actor: 'u-1', text: 'first', at: '2026-01-01T10:00:00.000Z' }]);
    const b = await T.appendOrderTimeline(o.id, [{ event: 'bulk.tag', actor: 'u-2', text: 'second', at: '2026-01-02T10:00:00.000Z' }]);
    const v = await view(o.id);
    out.s2 = {
      ok: a.ok && b.ok,
      order: v.map((i) => i.event),
      first: v.find((i) => i.event === 'bulk.status'),
      category: v.find((i) => i.event === 'bulk.status')?.category,
    };
  }

  /* ---- S3: two appends at once, forced: BOTH land ---- */
  {
    const o = await order();
    let second = null;
    const fired = hook.before(timelineWrite(o.id), async () => {
      second = await T.appendOrderTimeline(o.id, [{ event: 'bulk.b', actor: 'u-2', text: 'B' }]);
    });
    const first = await T.appendOrderTimeline(o.id, [{ event: 'bulk.a', actor: 'u-1', text: 'A' }]);
    hook.disarm();
    const texts = (await view(o.id)).filter((i) => !i.derived).map((i) => i.text).sort();
    out.s3 = { fired: fired(), first: first.ok, second: second?.ok === true, texts };
  }

  /* ---- S3b: eight at once, any interleaving ---- */
  {
    const o = await order();
    const res = await Promise.all(Array.from({ length: 8 }, (_, i) => T.appendOrderTimeline(o.id, [{ event: 'bulk.n', actor: `u${i}`, text: `n${i}` }])));
    const texts = (await view(o.id)).filter((i) => !i.derived).map((i) => i.text).sort();
    out.s3b = { ok: res.filter((r) => r.ok).length, texts };
  }

  /* ---- S4: a payment landing between the read and the write is not lost ---- */
  {
    const o = await order({ payment_status: 'pending' });
    const fired = hook.before(timelineWrite(o.id), async () => {
      await LocalDB.updateOrder(o.id, { payment_status: 'paid', staff_note: 'called' });
    });
    await T.appendOrderTimeline(o.id, [{ event: 'bulk.x', actor: 'u', text: 'x' }]);
    hook.disarm();
    const after = await stored(o.id);
    out.s4 = { fired: fired(), payment: after.payment_status, note: after.staff_note, kept: after.timeline?.length };
  }

  /* ---- S5: bounded: 105 appends keep the newest 100; derived "placed" survives ---- */
  {
    const o = await order();
    for (let i = 0; i < 105; i += 1) {
      await T.appendOrderTimeline(o.id, [{ event: 'bulk.n', actor: 'u', text: `e${i}` }]);
    }
    const raw = (await stored(o.id)).timeline;
    out.s5 = {
      count: raw.length, oldest: raw[0].text, newest: raw[raw.length - 1].text,
      placed: (await events(o.id)).includes('order.placed'),
    };
  }

  /* ---- S5b: when full, context goes before the money and the status moves ---- */
  {
    const o = await order();
    await T.appendOrderTimeline(o.id, [
      { event: 'payment.captured', actor: 'provider', amount_cents: 5000 },
      { event: 'status.changed', actor: 'u', from: 'pending', to: 'processing' },
    ]);
    for (let i = 0; i < 110; i += 1) {
      await T.appendOrderTimeline(o.id, [{ event: i % 2 ? 'note.comment' : 'tags.changed', actor: 'u', text: `c${i}`, added: i % 2 ? undefined : ['t'] }]);
    }
    const raw = (await stored(o.id)).timeline;
    out.s5b = {
      count: raw.length,
      kept: raw.filter((e) => e.event === 'payment.captured' || e.event === 'status.changed').length,
      oldestContext: raw.find((e) => e.event === 'note.comment' || e.event === 'tags.changed').text,
    };
  }

  /* ---- S6: invalid entries are refused whole, nothing written ---- */
  {
    const o = await order();
    const bad = await T.appendOrderTimeline(o.id, [{ event: 'bulk.ok', actor: 'u' }, { event: 'Not A Code', actor: 'u' }]);
    const bad2 = await T.appendOrderTimeline(o.id, [{ event: 'bulk.ok', actor: 'u', at: 'yesterday' }]);
    const none = await T.appendOrderTimeline(o.id, []);
    const missing = await T.appendOrderTimeline('nope', [{ event: 'bulk.ok', actor: 'u' }]);
    out.s6 = {
      bad: bad.ok ? 'ok' : bad.code, bad2: bad2.ok ? 'ok' : bad2.code, none: none.ok ? 'ok' : none.code,
      missing: missing.ok ? 'ok' : missing.code, wrote: has(await stored(o.id), 'timeline'),
      neverThrows: await T.recordOrderEvent('nope', { event: 'bulk.ok', actor: 'u' }),
    };
  }

  /* ---- S6b: a burst that exhausts the inner retries does not lose a recorded event ---- */
  {
    const o = await order();
    const real = LocalDB.compareAndSetOrderTimeline;
    let losses = 0;
    LocalDB.compareAndSetOrderTimeline = async function (...a) {
      if (a[0] === o.id && losses < 12) { losses += 1; return { outcome: 'changed' }; }
      return real.apply(this, a);
    };
    const bare = await T.appendOrderTimeline(o.id, [{ event: 'bulk.lost', actor: 'u' }]); // 10 losses -> busy
    const kept = await T.recordOrderEvent(o.id, { event: 'payment.captured', actor: 'provider', amount_cents: 5000 });
    LocalDB.compareAndSetOrderTimeline = real;
    out.s6b = { bare: bare.ok ? 'ok' : bare.code, kept, losses, events: (await stored(o.id)).timeline?.map((e) => e.event) };
  }

  /* ---- S7: junk stored by something else is dropped on read and repaired by the next append ---- */
  {
    const o = await order({ timeline: 'not-a-list' });
    const p = await order({ timeline: [{ event: 'bulk.ok', actor: 'u', at: '2026-01-01T00:00:00.000Z', id: 'keep', text: 'ok' }, 7, null, { event: 'BAD' }, { event: 'bulk.ok', at: 'nope' }] });
    const readJunk = (await view(o.id)).filter((i) => !i.derived).length;
    const readMixed = (await view(p.id)).filter((i) => !i.derived).map((i) => i.id);
    const a = await T.appendOrderTimeline(o.id, [{ event: 'bulk.fine', actor: 'u' }]);
    const b = await T.appendOrderTimeline(p.id, [{ event: 'bulk.more', actor: 'u' }]);
    out.s7 = {
      readJunk, readMixed, a: a.ok, b: b.ok,
      junkAfter: (await stored(o.id)).timeline.map((e) => e.event),
      mixedAfter: (await stored(p.id)).timeline.map((e) => e.event),
    };
  }

  /* ---- S8: text a JSON path could mishandle survives, and appends keep working ---- */
  {
    const o = await order();
    const odd = ['Καλός πελάτης "hi"', 'back\\slash', 'emoji 😀', "O'Brien", 'two\nlines'];
    for (const t of odd) await T.appendOrderTimeline(o.id, [{ event: 'note.comment', actor: 'u', text: t }]);
    const r = await T.appendOrderTimeline(o.id, [{ event: 'note.comment', actor: 'u', text: 'after' }]);
    out.s8 = { ok: r.ok, texts: (await stored(o.id)).timeline.map((e) => e.text) };
  }

  /* ---- S9: an append is bookkeeping: no change-feed row, no updated_at bump ---- */
  {
    const o = await order();
    const before = await stored(o.id);
    await T.appendOrderTimeline(o.id, [{ event: 'bulk.feed', actor: 'u' }]);
    const after = await stored(o.id);
    const changes = (await LocalDB.getContentChanges()).filter((c) => c.entity_id === o.id && c.action === 'update');
    out.s9 = { count: changes.length, sameUpdatedAt: before.updated_at === after.updated_at };
  }

  /* ---- W1: a real status change (the shared path) is recorded ---- */
  {
    const o = await order({ status: 'processing' });
    const r1 = await M.setOrderStatus(o.id, 'on-hold', 'u-admin');
    const r2 = await M.setOrderStatus(o.id, 'on-hold', 'u-admin'); // no-op
    const r3 = await M.setOrderStatus(o.id, 'processing', 'u-other');
    const v = (await view(o.id)).filter((i) => i.event === 'status.changed');
    out.w1 = {
      ok: [r1.ok, r2.ok, r3.ok],
      moves: v.map((i) => [i.from, i.to, i.actor]),
      system: null,
    };
    // A move with no actor (a provider webhook) is "system".
    const o2 = await order({ status: 'pending', payment_status: 'pending' });
    await M.setOrderStatus(o2.id, 'cancelled');
    out.w1.system = (await view(o2.id)).find((i) => i.event === 'status.changed')?.actor;
  }

  /* ---- W1b: two staff moving one order at once: exactly one move recorded ---- */
  {
    const o = await order({ status: 'processing' });
    await Promise.all([M.setOrderStatus(o.id, 'completed', 'a'), M.setOrderStatus(o.id, 'completed', 'b')]);
    out.w1b = { count: (await view(o.id)).filter((i) => i.event === 'status.changed').length };
  }

  /* ---- W2: a provider verdict through applyVerifiedEvent ---- */
  {
    const o = await order({ status: 'pending', payment_status: 'pending', payment_method: 'card', payment_provider: 'stripe' });
    const ev = (outcome, id) => ({ eventId: id, reference: o.id, outcome, amountCents: 5000, currency: 'EUR', rawType: `t.${outcome}` });
    const paid = await M.applyVerifiedEvent(ev('paid', `evt_paid_${o.id}`));
    const dup = await M.applyVerifiedEvent(ev('paid', `evt_paid_${o.id}`));
    const v = await view(o.id);
    const order2 = await order({ status: 'pending', payment_status: 'pending' });
    const failed = await M.applyVerifiedEvent({ eventId: `evt_f_${order2.id}`, reference: order2.id, outcome: 'failed', amountCents: 5000, currency: 'EUR', rawType: 't.failed' });
    const order3 = await order({ status: 'pending', payment_status: 'pending' });
    await M.applyVerifiedEvent({ eventId: `evt_d_${order3.id}`, reference: order3.id, outcome: 'declined', amountCents: 5000, currency: 'EUR', rawType: 't.declined' });
    out.w2 = {
      paid: paid.applied, dup: dup.applied,
      captured: v.filter((i) => i.event === 'payment.captured').map((i) => [i.actor, i.amount_cents, i.currency]),
      status: v.filter((i) => i.event === 'status.changed').map((i) => [i.from, i.to, i.actor]),
      // newest first: the status move comes AFTER the payment that caused it
      order: v.map((i) => i.event).filter((e) => e === 'payment.captured' || e === 'status.changed'),
      failed: failed.applied ? (await events(order2.id)).filter((e) => e.startsWith('payment.')) : null,
      declined: (await events(order3.id)).filter((e) => e.startsWith('payment.')),
    };
  }

  /* ---- W3: the staff note, through the real PUT ---- */
  {
    const o = await order();
    const put = (body) => call(M.putOrder, { params: { id: o.id }, method: 'PUT', url: `http://localhost/api/orders/${o.id}`, body });
    await put({ staff_note: 'called, collecting Tuesday' });
    await put({ staff_note: 'called, collecting Tuesday' }); // same text again: not a change
    await put({ staff_note: 'collecting Wednesday' });
    await put({ staff_note: '' });
    await put({ note: 'customer words changed' });
    const v = (await view(o.id)).filter((i) => i.category === 'notes');
    out.w3 = { notes: v.map((i) => [i.event, i.text ?? null, i.actor]).reverse() };
  }

  /* ---- W4: tag edits through the module, with the actor ---- */
  {
    const o = await order();
    await G.addOrderTags(o.id, ['VIP', 'Fragile'], 'u-admin');
    await G.addOrderTags(o.id, ['vip'], 'u-admin'); // nothing changed: nothing recorded
    await G.removeOrderTag(o.id, 'FRAGILE', 'u-other');
    const v = (await view(o.id)).filter((i) => i.event === 'tags.changed').reverse();
    out.w4 = { entries: v.map((i) => [i.actor, i.added ?? null, i.removed ?? null]) };

    const a = await order({ tags: ['Old'] });
    await G.renameOrderTag('Old', 'New', 'u-admin');
    out.w4.rename = (await view(a.id)).filter((i) => i.event === 'tags.changed').map((i) => [i.added, i.removed, i.actor]);
  }

  /* ---- W5: refunds are derived, with amount and actor ---- */
  {
    const o = await order({
      payment_status: 'paid', refunds: [
        { id: 're_1', amount_cents: 1500, at: '2026-03-01T10:00:00.000Z', actor: 'u-admin' },
        { id: 're_2', amount_cents: 500, at: '2026-03-02T10:00:00.000Z', actor: 'provider' },
      ],
    });
    const v = (await view(o.id)).filter((i) => i.event === 'refund.issued');
    out.w5 = { refunds: v.map((i) => [i.amount_cents, i.currency, i.actor, i.ref, i.category, i.derived]) };
  }

  /* ---- W6: shipping through the real route ---- */
  {
    const o = await order();
    const ship = (body) => call(M.postShip, { params: { id: o.id }, method: 'POST', url: `http://localhost/api/orders/${o.id}/ship`, body });
    const first = await ship({ tracking_number: 'TRK-1', tracking_carrier: 'ELTA' });
    const second = await ship({ tracking_number: 'TRK-2', tracking_carrier: 'ELTA' });
    const v = (await view(o.id)).filter((i) => i.category === 'shipments').reverse();
    out.w6 = {
      codes: [first.status, second.status],
      entries: v.map((i) => [i.event, i.ref, i.text, i.actor, i.derived]),
    };
    // An order posted before shipments were recorded here: derived from shipped_at.
    const legacy = await order({ shipped_at: '2026-02-01T09:00:00.000Z', tracking_number: 'OLD-9', tracking_carrier: 'ACS' });
    out.w6.legacy = (await view(legacy.id)).filter((i) => i.category === 'shipments').map((i) => [i.event, i.ref, i.text, i.actor, i.derived]);
  }

  /* ---- R: the route ---- */
  {
    const o = await order({ status: 'processing' });
    await M.setOrderStatus(o.id, 'completed', admin.id);
    await T.appendOrderTimeline(o.id, [{ event: 'note.comment', actor: admin.id, text: 'Route comment' }]);
    await LocalDB.updateOrder(o.id, { refunds: [{ id: 're_r', amount_cents: 700, at: new Date().toISOString(), actor: admin.id }] });
    const url = (q = '') => `http://localhost/api/orders/${o.id}/timeline${q}`;
    const all = await call(M.getTimeline, { params: { id: o.id }, url: url() });
    const st = await call(M.getTimeline, { params: { id: o.id }, url: url('?filter=status') });
    const pay = await call(M.getTimeline, { params: { id: o.id }, url: url('?filter=payments') });
    const notes = await call(M.getTimeline, { params: { id: o.id }, url: url('?filter=notes') });
    const ship = await call(M.getTimeline, { params: { id: o.id }, url: url('?filter=shipments') });
    const badFilter = await call(M.getTimeline, { params: { id: o.id }, url: url('?filter=everything') });
    const paged = await call(M.getTimeline, { params: { id: o.id }, url: url('?limit=2&offset=1') });
    const mgr = await call(M.getTimeline, { params: { id: o.id }, url: url(), user: manager });
    const anon = await call(M.getTimeline, { params: { id: o.id }, url: url(), user: null });
    const missing = await call(M.getTimeline, { params: { id: 'nope' }, url: url() });
    const csv = await call(M.getTimeline, { params: { id: o.id }, url: url('?format=csv&filter=payments') });
    out.r1 = {
      status: all.status, sorted: all.json.data.every((x, i, a) => i === 0 || a[i - 1].at >= x.at),
      events: all.json.data.map((x) => x.event),
      meta: [all.json.meta.total, all.json.meta.filtered, all.json.meta.hasMore],
      staffName: all.json.data.find((x) => x.event === 'note.comment')?.actor_name,
      staffKind: all.json.data.find((x) => x.event === 'note.comment')?.actor_kind,
      placedKind: all.json.data.find((x) => x.event === 'order.placed')?.actor_kind,
    };
    out.r2 = {
      status: st.json.data.map((x) => x.category), payments: pay.json.data.map((x) => x.event),
      notes: notes.json.data.map((x) => x.event), shipments: ship.json.data.length,
    };
    out.r3 = {
      badFilter: [badFilter.status, badFilter.json?.error?.reason ?? badFilter.json?.error?.code],
      paged: [paged.json.data.length, paged.json.meta.hasMore, paged.json.meta.total],
      pagedIds: paged.json.data.map((x) => x.id),
      allIds: all.json.data.map((x) => x.id),
      mgr: mgr.status, anon: anon.status, missing: missing.status,
    };
    out.r4 = {
      status: csv.status, type: csv.headers.get('content-type'), disp: csv.headers.get('content-disposition'),
      lines: csv.text.trim().split('\n').length,
      refundRow: csv.text.split('\n').find((l) => l.includes('refund.issued')),
    };

    // POST a comment
    const post = (body, user = admin) => call(M.postTimeline, { params: { id: o.id }, method: 'POST', url: url(), body, user });
    const ok = await post({ text: '  Called the customer​  ' });
    const empty = await post({ text: '   ' });
    const notText = await post({ text: 42 });
    const tooLong = await post({ text: 'x'.repeat(1001) });
    const mgrPost = await post({ text: 'hi' }, manager);
    const anonPost = await post({ text: 'hi' }, null);
    const miss = await call(M.postTimeline, { params: { id: 'nope' }, method: 'POST', url: url(), body: { text: 'hi' } });
    await new Promise((r) => setTimeout(r, 300));
    const audits = await LocalDB.getAuditEvents({ action: 'order.timeline.comment' });
    out.r5 = {
      ok: [ok.status, ok.json?.data?.event, ok.json?.data?.text, ok.json?.data?.actor_name],
      bad: [empty.status, notText.status, tooLong.status],
      roles: [mgrPost.status, anonPost.status, miss.status],
      audit: audits.length, auditLeaks: JSON.stringify(audits).includes('Called the customer'),
    };
  }

  /* ---- L: staff-only ---- */
  {
    const SENT = 'LEAK-SENTINEL-TIMELINE';
    const o = await order({
      staff_note: 'internal', tracking_number: 'TRK1', tracking_carrier: 'ELTA', payment_method: 'bank-transfer',
      timeline: [{ id: 'x', at: '2026-01-01T00:00:00.000Z', event: 'note.comment', actor: 'u', text: SENT }],
    });
    const full = await stored(o.id);
    const conf = M.buildOrderConfirmation(full, { siteTitle: 'Shop', instructions: 'IBAN', receiptLink: 'https://x/r' });
    const shipped = M.buildShippedNotice(full, { siteTitle: 'Shop' });
    const recov = M.buildRecoveryNotice(full, { siteTitle: 'Shop', instructions: 'IBAN' });
    const rec = M.receiptView(full, (c) => String(c));
    const list = await call(M.listOrders, { url: 'http://localhost/api/orders?limit=200' });
    const one = await call(M.getOrder, { params: { id: o.id } });
    const put = await call(M.putOrder, { params: { id: o.id }, method: 'PUT', body: { staff_note: 'n2' } });
    const putStatus = await call(M.putOrder, { params: { id: o.id }, method: 'PUT', body: { status: 'completed' } });
    out.l = {
      built: [!!conf, !!shipped, !!recov],
      leaks: [conf, shipped, recov, rec].map((x) => JSON.stringify(x).includes(SENT)),
      list: list.text.includes(SENT), one: one.text.includes(SENT), put: put.text.includes(SENT), putStatus: putStatus.text.includes(SENT),
      hasKeyList: list.text.includes('"timeline"'),
      oneStatus: one.status, putStatus2: putStatus.status,
      // ...and the one reader does show it, to staff.
      reader: (await call(M.getTimeline, { params: { id: o.id }, url: `http://localhost/api/orders/${o.id}/timeline` })).text.includes(SENT),
    };
  }

  /* ---- G: an erasure clears free text, keeps the facts ---- */
  {
    const o = await order({ email: 'erase-tl@example.com', name: 'Mr Papas', tags: ['Papas - fraud?'] });
    await G.addOrderTags(o.id, ['Papas VIP'], 'u-admin');
    await T.appendOrderTimeline(o.id, [
      { event: 'note.comment', actor: 'u-admin', text: 'Mr Papas called from 6900000000' },
      { event: 'shipment.shipped', actor: 'u-admin', ref: 'TRK-ERASE', text: 'ELTA' },
    ]);
    await M.setOrderStatus(o.id, 'completed', 'u-admin');
    // A feed snapshot written while the text is still on the order — the shape
    // that used to survive the erasure (the snapshot of the anonymised order
    // no longer holds the address, so the email purge missed the old one).
    await LocalDB.updateOrder(o.id, { staff_note: 'snapshot with the timeline intact' });
    const feedBefore = (await LocalDB.getContentChanges()).filter((c) => c.entity_id === o.id).length;
    await M.eraseSubject('erase-tl@example.com');
    const after = await stored(o.id);
    const feedAfter = (await LocalDB.getContentChanges()).filter((c) => c.entity_id === o.id);
    const t = after.timeline ?? [];
    out.g = {
      erased: typeof after.erased_at === 'string',
      kept: t.map((e) => e.event),
      anyText: t.some((e) => has(e, 'text') || has(e, 'added') || has(e, 'removed')),
      blob: JSON.stringify(after).includes('Papas') || JSON.stringify(after).includes('6900000000'),
      actors: [...new Set(t.map((e) => e.actor))].sort(),
      ref: t.find((e) => e.event === 'shipment.shipped')?.ref,
      status: t.find((e) => e.event === 'status.changed')?.to,
      feedBefore, feedRows: feedAfter.length,
      feedLeak: JSON.stringify(feedAfter).includes('6900000000') || JSON.stringify(feedAfter).includes('Papas'),
    };
  }

  return out;
}

if (process.env.ORDER_TIMELINE_CHILD) {
  const M = await loadTs('tests/fixtures/order-timeline-entry.ts', 'ordertimeline');
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
  const T = await loadTs('src/lib/commerce/order-timeline.ts', 'ordertimelinepure');

  const cat = (e) => T.timelineCategory(e);
  check('P1: categories', cat('status.changed') === 'status' && cat('order.placed') === 'status'
    && cat('payment.captured') === 'payments' && cat('refund.issued') === 'payments'
    && cat('shipment.shipped') === 'shipments' && cat('note.comment') === 'notes'
    && cat('tags.changed') === 'other' && cat('bulk.status') === 'other' && cat('tax.override') === 'other');
  check('P1: every code this module names has a category (no silent "other" for a payment)',
    T.TIMELINE_EVENTS.filter((e) => /^(payment|refund)\./.test(e)).every((e) => cat(e) === 'payments')
    && T.TIMELINE_EVENTS.filter((e) => e.startsWith('shipment.')).every((e) => cat(e) === 'shipments')
    && T.TIMELINE_EVENTS.filter((e) => e.startsWith('note.')).every((e) => cat(e) === 'notes'));
  check('P2: the filter parser', T.parseTimelineFilter(null) === null && T.parseTimelineFilter('all') === null
    && T.parseTimelineFilter('payments') === 'payments' && T.parseTimelineFilter('nope') === 'invalid'
    && T.parseTimelineFilter(['payments']) === 'invalid');

  const norm = (r) => T.normalizeTimelineEntry(r, new Date('2026-05-05T00:00:00.000Z'));
  check('P3: a minimal entry gets an id and the time', (() => { const e = norm({ event: 'bulk.x', actor: 'u' }); return e && e.id && e.at === '2026-05-05T00:00:00.000Z'; })());
  check('P3: a bad code, a non-object and a bad time are refused',
    norm({ event: 'Bad Code', actor: 'u' }) === null && norm('x') === null && norm(null) === null && norm([]) === null
    && norm({ event: 'bulk.x', actor: 'u', at: 'soon' }) === null && norm({ event: 'a'.repeat(60), actor: 'u' }) === null);
  check('P3: an entry with no actor is "system", not blank', norm({ event: 'bulk.x' }).actor === 'system' && norm({ event: 'bulk.x', actor: '  ' }).actor === 'system');
  check('P3: unknown fields are dropped, not carried', !has(norm({ event: 'bulk.x', actor: 'u', password: 'p', html: '<b>' }), 'password'));
  check('P3: text loses hidden and bidi characters, keeps newlines, is bounded',
    norm({ event: 'note.comment', actor: 'u', text: 'a‮b​c\nline2\u0000' }).text === 'abc\nline2'
    && [...norm({ event: 'note.comment', actor: 'u', text: 'x'.repeat(2000) }).text].length === T.ORDER_TIMELINE_TEXT_MAX);
  check('P3: markup is kept as text (rendering escapes it)', norm({ event: 'note.comment', actor: 'u', text: '<b>x</b>' }).text === '<b>x</b>');
  check('P3: amounts must be integers', norm({ event: 'bulk.x', actor: 'u', amount_cents: 1.5 }).amount_cents === undefined
    && norm({ event: 'bulk.x', actor: 'u', amount_cents: 150 }).amount_cents === 150);
  check('P3: tag lists are bounded and cleaned', (() => {
    const e = norm({ event: 'tags.changed', actor: 'u', added: [...Array.from({ length: 30 }, (_, i) => `t${i}`), 5, ''] });
    return e.added.length === 10;
  })());

  const base = { id: 'o1', number: 'N1', status: 'completed', currency: 'EUR', total_cents: 12000, items: [], email: 'a@b.c', created_at: '2026-04-01T10:00:00.000Z', updated_at: '2026-04-01T10:00:00.000Z' };
  const d = T.buildOrderTimeline({
    ...base, payment_method: 'bank-transfer', shipped_at: '2026-04-03T10:00:00.000Z', tracking_number: 'T1', tracking_carrier: 'ELTA',
    refunds: [{ id: 'r1', amount_cents: 2000, at: '2026-04-05T10:00:00.000Z', actor: 'u1' }],
    abandoned_at: '2026-04-01T11:00:00.000Z', payment_declined_at: '2026-04-01T10:30:00.000Z', payment_declines: 2,
    terms_accepted: true, terms_accepted_at: '2026-04-01T10:00:00.000Z',
    tax_overrides: [{ scope: 'order', reason: 'B2B exempt', actor: 'u2', at: '2026-04-04T10:00:00.000Z' }],
  });
  check(`P4: derived events, newest first, "placed" last (${j(d.map((x) => x.event))})`, same(d.map((x) => x.event),
    ['refund.issued', 'tax.override', 'shipment.shipped', 'order.abandoned', 'payment.declined', 'consent.terms_accepted', 'order.placed']));
  check('P4: sorted by time, newest first', d.every((x, i, a) => i === 0 || a[i - 1].at >= x.at));
  check('P4: every derived item says so', d.every((i) => i.derived === true));
  check('P4: refund carries amount, currency, actor', (() => { const r = d.find((i) => i.event === 'refund.issued'); return r.amount_cents === 2000 && r.currency === 'EUR' && r.actor === 'u1'; })());
  check('P4: placed carries the total', (() => { const r = d.find((i) => i.event === 'order.placed'); return r.amount_cents === 12000 && r.actor === 'customer'; })());
  check('P4: declined carries the count', d.find((i) => i.event === 'payment.declined').count === 2);
  check('P4: shipped carries tracking and carrier', (() => { const r = d.find((i) => i.event === 'shipment.shipped'); return r.ref === 'T1' && r.text === 'ELTA' && r.actor === null; })());
  check('P4: terms acceptance only when accepted', T.buildOrderTimeline({ ...base, terms_accepted: false, terms_accepted_at: '2026-04-01T10:00:00.000Z' })
    .every((i) => i.event !== 'consent.terms_accepted'));
  check('P4: a bad timestamp is skipped, not shown as Invalid Date', T.buildOrderTimeline({ ...base, abandoned_at: 'garbage' }).every((i) => i.event !== 'order.abandoned'));

  const withStored = T.buildOrderTimeline({
    ...base, shipped_at: '2026-04-03T10:00:00.000Z', tracking_number: 'T1',
    timeline: [{ id: 's1', at: '2026-04-03T10:00:00.500Z', event: 'shipment.shipped', actor: 'u1', ref: 'T1' }],
  });
  check('P5: a stored shipment replaces the derived one (no double line)',
    withStored.filter((i) => i.event === 'shipment.shipped').length === 1 && withStored.find((i) => i.event === 'shipment.shipped').actor === 'u1');
  const ties = T.buildOrderTimeline({
    ...base, timeline: [
      { id: 'a', at: '2026-04-02T00:00:00.000Z', event: 'bulk.one', actor: 'u' },
      { id: 'b', at: '2026-04-02T00:00:00.000Z', event: 'bulk.two', actor: 'u' },
    ],
  }).filter((i) => !i.derived).map((i) => i.id);
  check('P5: equal times keep a fixed order, newest append first', same(ties, ['b', 'a']));

  const users = new Map([['u1', { name: 'Ada', email: 'ada@x' }], ['u2', { email: 'bob@x' }]]);
  check('P6: actors', same(T.describeActor('u1', users), { kind: 'staff', name: 'Ada' })
    && same(T.describeActor('u2', users), { kind: 'staff', name: 'bob@x' })
    && same(T.describeActor('gone', users), { kind: 'staff', name: 'gone' })
    && same(T.describeActor('provider', users), { kind: 'provider', name: null })
    && same(T.describeActor('system:payment-capture', users), { kind: 'system', name: null })
    && same(T.describeActor('customer', users), { kind: 'customer', name: null })
    && same(T.describeActor(null, users), { kind: 'unknown', name: null }));

  check('P7: scrubbedTimeline removes text, added, removed only', same(
    T.scrubbedTimeline([{ id: 'a', at: '2026-01-01T00:00:00.000Z', event: 'tags.changed', actor: 'u', text: 't', added: ['x'], removed: ['y'], ref: 'r', from: 'a', to: 'b', amount_cents: 5 }]),
    [{ id: 'a', at: '2026-01-01T00:00:00.000Z', event: 'tags.changed', actor: 'u', from: 'a', to: 'b', amount_cents: 5, ref: 'r' }]));
  check('P7: withoutTimeline drops only that key', (() => { const x = T.withoutTimeline({ id: 'a', timeline: [1], tags: ['t'] }); return !has(x, 'timeline') && x.id === 'a' && same(x.tags, ['t']); })());
}

/* ---- L2: who may read the stored timeline (source scan) ---- */
{
  const ALLOWED = new Set([
    'src/lib/commerce/order-timeline.ts',
    'src/lib/commerce-service.ts',
    'src/lib/commerce/order-tags.ts',
    'src/lib/payments/service.ts',
    'src/lib/gdpr.ts',
    'src/pages/api/orders/index.ts',
    'src/pages/api/orders/[id]/index.ts',
    'src/pages/api/orders/[id]/ship.ts',
    'src/pages/api/orders/[id]/tax-override.ts',
    'src/pages/api/orders/[id]/timeline.ts',
  ]);
  const found = [];
  async function walk(dir) {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) await walk(abs);
      else if (/\.(ts|astro|mjs|js)$/.test(e.name)) {
        const src = await fs.readFile(abs, 'utf8');
        if (/from\s+['"][^'"]*order-timeline['"]/.test(src)) found.push(path.relative(ROOT, abs).split(path.sep).join('/'));
      }
    }
  }
  await walk(path.join(ROOT, 'src'));
  const stray = found.filter((f) => !ALLOWED.has(f));
  check(`L2: only staff and writer code imports the timeline module (stray: ${j(stray)}) — a buyer-facing reader must be added here on purpose`, stray.length === 0);
  check('L2: every allowed importer really exists and imports it', [...ALLOWED].filter((f) => f !== 'src/lib/commerce/order-timeline.ts').every((f) => found.includes(f)));

  // Buyer-facing code reads fields by name; none may name `timeline` on an order.
  const surfaces = [
    'src/lib/commerce/receipt.ts', 'src/lib/commerce/order-confirmation.ts', 'src/lib/commerce/shipped-notice.ts',
    'src/lib/commerce/recovery-notice.ts', 'src/lib/commerce/order-lookup.ts', 'src/pages/receipt.astro',
    'src/pages/receipt.pdf.ts', 'src/pages/api/payments/start.ts', 'src/lib/webhooks.ts',
  ];
  const naming = [];
  for (const f of surfaces) {
    const src = await fs.readFile(path.join(ROOT, f), 'utf8');
    if (/\.timeline\b|\['timeline'\]/.test(src)) naming.push(f);
  }
  check(`L2: no buyer-facing surface names an order's timeline (${j(naming)})`, naming.length === 0);

  // The audit action stays free of text: its call site passes no metadata.
  const route = await fs.readFile(path.join(ROOT, 'src/pages/api/orders/[id]/timeline.ts'), 'utf8');
  check('L2: the comment audit entry carries no metadata', /recordAudit\(AUDIT\.ORDER_TIMELINE_COMMENT, \{[^}]*\}\)/.test(route) && !/ORDER_TIMELINE_COMMENT[^;]*metadata/.test(route));
}

/* ---- per driver ---- */
const tmpRoot = path.join(os.tmpdir(), `astrobaas-order-timeline-${process.pid}`);
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
        ...process.env, ORDER_TIMELINE_CHILD: '1', NODE_ENV: 'test',
        AUTH_SECRET: 'order-timeline-secret-0123456789abcdef',
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

  t('s3 / s4: the interfering request really ran inside the first', r.s3.fired === true && r.s4.fired === true);

  t(`S1: a fresh order shows "placed" from its own fields and stores nothing (${j(r.s1)})`,
    same(r.s1.events, ['order.placed']) && r.s1.derived && r.s1.hasKey === false);
  t(`S2: appended entries are newest first with actor/time as given (${j(r.s2.order)})`,
    r.s2.ok && same(r.s2.order.slice(1, 3), ['bulk.tag', 'bulk.status']) && r.s2.first.actor === 'u-1'
    && r.s2.first.at === '2026-01-01T10:00:00.000Z' && r.s2.first.derived === false && r.s2.category === 'other');
  t(`S3: two appends at once, forced, BOTH land (${j(r.s3)})`, r.s3.first && r.s3.second && same(r.s3.texts, ['A', 'B']));
  t(`S3b: eight simultaneous appends all land (${j(r.s3b.ok)})`, r.s3b.ok === 8 && r.s3b.texts.length === 8 && new Set(r.s3b.texts).size === 8);
  t(`S4: a payment and a note landing in between are not lost (${j(r.s4)})`, r.s4.payment === 'paid' && r.s4.note === 'called' && r.s4.kept === 1);
  t(`S5: 105 appends keep the newest 100; "placed" is still there (${j(r.s5)})`,
    r.s5.count === 100 && r.s5.oldest === 'e5' && r.s5.newest === 'e104' && r.s5.placed);
  t(`S5b: 112 entries on a full list evict comments and tag edits first; the payment and the status move survive (${j(r.s5b)})`,
    r.s5b.count === 100 && r.s5b.kept === 2 && r.s5b.oldestContext === 'c12');
  t(`S6: invalid entries are refused whole and write nothing (${j(r.s6)})`,
    r.s6.bad === 'invalid' && r.s6.bad2 === 'invalid' && r.s6.none === 'invalid' && r.s6.missing === 'not_found'
    && r.s6.wrote === false && r.s6.neverThrows === false);
  t(`S6b: ten lost rounds is a refusal for a bare append, but recordOrderEvent retries and keeps the verdict (${j(r.s6b)})`,
    r.s6b.bare === 'busy' && r.s6b.kept === true && same(r.s6b.events, ['payment.captured']));
  t(`S7: a non-list is read as empty and repaired by the next append (${j(r.s7)})`,
    r.s7.readJunk === 0 && r.s7.a && same(r.s7.junkAfter, ['bulk.fine']));
  t(`S7: junk entries beside good ones are dropped, the good one kept (${j(r.s7.readMixed)})`,
    same(r.s7.readMixed, ['keep']) && r.s7.b && same(r.s7.mixedAfter, ['bulk.ok', 'bulk.more']));
  t(`S8: quotes, backslash, emoji, Greek, newline survive and a LATER append works (${j(r.s8.texts)})`,
    r.s8.ok && same(r.s8.texts, ['Καλός πελάτης "hi"', 'back\\slash', 'emoji 😀', "O'Brien", 'two\nlines', 'after']));
  t(`S9: an append writes no change-feed row and leaves updated_at alone (${j(r.s9)})`, r.s9.count === 0 && r.s9.sameUpdatedAt === true);

  t(`W1: a real status change is recorded with from, to and actor; a no-op is not (${j(r.w1)})`,
    same(r.w1.ok, [true, true, true]) && same(r.w1.moves, [['on-hold', 'processing', 'u-other'], ['processing', 'on-hold', 'u-admin']])
    && r.w1.system === 'system');
  t(`W1b: two staff making the same move at once record ONE move (${j(r.w1b)})`, r.w1b.count === 1);
  t(`W2: a provider capture is recorded with amount and "provider", before the move it caused (${j(r.w2)})`,
    r.w2.paid === true && r.w2.dup === false && same(r.w2.captured, [['provider', 5000, 'EUR']])
    && same(r.w2.status, [['pending', 'processing', 'system']])
    && same(r.w2.order, ['status.changed', 'payment.captured']));
  t(`W2: a failure is recorded as payment.failed, a decline is derived (not stored) (${j([r.w2.failed, r.w2.declined])})`,
    same(r.w2.failed, ['payment.failed']) && same(r.w2.declined, ['payment.declined']));
  t(`W3: staff note edits are recorded with text; the same text again is not (${j(r.w3.notes)})`,
    same(r.w3.notes, [
      ['note.staff_updated', 'called, collecting Tuesday', 'u-admin'],
      ['note.staff_updated', 'collecting Wednesday', 'u-admin'],
      ['note.staff_cleared', null, 'u-admin'],
      ['note.customer_edited', null, 'u-admin'],
    ]));
  t(`W4: tag edits record who added and removed what, and a no-op records nothing (${j(r.w4)})`,
    same(r.w4.entries, [['u-admin', ['VIP', 'Fragile'], null], ['u-other', null, ['Fragile']]])
    && same(r.w4.rename, [[['New'], ['Old'], 'u-admin']]));
  t(`W5: refunds are derived with amount, currency, actor, id (${j(r.w5)})`,
    same(r.w5.refunds, [[500, 'EUR', 'provider', 're_2', 'payments', true], [1500, 'EUR', 'u-admin', 're_1', 'payments', true]]));
  t(`W6: shipping through the route: shipped, then a correction, with the staff member (${j(r.w6)})`,
    same(r.w6.codes, [200, 200]) && same(r.w6.entries, [
      ['shipment.shipped', 'TRK-1', 'ELTA', 'u-admin', false],
      ['shipment.tracking_updated', 'TRK-2', 'ELTA', 'u-admin', false],
    ]));
  t(`W6: an order posted before this existed is still shown, from shipped_at (${j(r.w6.legacy)})`,
    same(r.w6.legacy, [['shipment.shipped', 'OLD-9', 'ACS', null, true]]));

  t(`R1: GET is 200, sorted newest first, with total/filtered/hasMore (${j(r.r1.meta)})`,
    r.r1.status === 200 && r.r1.sorted && r.r1.meta[0] === r.r1.events.length && r.r1.meta[1] === r.r1.meta[0] && r.r1.meta[2] === false);
  t(`R1: all four kinds appear: status, payment/refund, note, placed (${j(r.r1.events)})`,
    ['status.changed', 'refund.issued', 'note.comment', 'order.placed'].every((e) => r.r1.events.includes(e)));
  t(`R1: the actor is shown as the staff member's NAME, and the buyer as customer (${r.r1.staffName}/${r.r1.staffKind}/${r.r1.placedKind})`,
    r.r1.staffKind === 'staff' && r.r1.placedKind === 'customer' && typeof r.r1.staffName === 'string');
  t(`R2: ?filter= keeps only that category (${j(r.r2)})`,
    r.r2.status.length > 0 && r.r2.status.every((c) => c === 'status') && same(r.r2.payments, ['refund.issued'])
    && same(r.r2.notes, ['note.comment']) && r.r2.shipments === 0);
  t(`R3: an unknown filter is 422, never "everything" (${j(r.r3.badFilter)})`, r.r3.badFilter[0] === 422);
  t(`R3: paging returns the slice and says there is more (${j(r.r3.paged)})`,
    r.r3.paged[0] === 2 && r.r3.paged[1] === true && same(r.r3.pagedIds, r.r3.allIds.slice(1, 3)));
  t(`R3: a manager may read, anonymous may not, an unknown order is 404 (${r.r3.mgr}/${r.r3.anon}/${r.r3.missing})`,
    r.r3.mgr === 200 && r.r3.anon === 401 && r.r3.missing === 404);
  t(`R4: ?format=csv is a download with the filtered rows and the amount (${j(r.r4)})`,
    r.r4.status === 200 && /^text\/csv/.test(r.r4.type) && /attachment; filename="order-OTL-[0-9]+-[0-9]+-timeline\.csv"/.test(r.r4.disp)
    && r.r4.lines === 2 && /7\.00/.test(r.r4.refundRow ?? ''));
  t(`R5: a staff comment is added and returned with the name (${j(r.r5.ok)})`,
    r.r5.ok[0] === 200 && r.r5.ok[1] === 'note.comment' && r.r5.ok[2] === 'Called the customer' && typeof r.r5.ok[3] === 'string');
  t(`R5: empty, non-text and over-long comments are 422 (${j(r.r5.bad)})`, r.r5.bad.every((s) => s === 422));
  t(`R5: a manager is 403, anonymous 401, unknown order 404 (${j(r.r5.roles)})`, same(r.r5.roles, [403, 401, 404]));
  t(`R5: the audit trail records it and holds NO text (${r.r5.audit})`, r.r5.audit >= 1 && r.r5.auditLeaks === false);

  t(`L: the confirmation, shipped and recovery emails and the receipt are built (${j(r.l.built)})`, r.l.built.every(Boolean));
  t(`L: ...and none of the four carries the timeline (${j(r.l.leaks)})`, r.l.leaks.every((x) => x === false));
  t(`L: GET /api/orders, GET one, PUT note and PUT status do not return it (${j([r.l.list, r.l.one, r.l.put, r.l.putStatus])})`,
    [r.l.list, r.l.one, r.l.put, r.l.putStatus].every((x) => x === false) && r.l.hasKeyList === false);
  t(`L: ...and the one reader shows it to staff (${r.l.reader})`, r.l.reader === true && r.l.oneStatus === 200 && r.l.putStatus2 === 200);

  t(`G: an erasure clears note, tag and comment text, and keeps what happened and who (${j(r.g)})`,
    r.g.erased && r.g.anyText === false && r.g.blob === false
    && ['note.comment', 'shipment.shipped', 'status.changed', 'tags.changed'].every((e) => r.g.kept.includes(e))
    && r.g.ref === 'TRK-ERASE' && r.g.status === 'completed' && r.g.actors.includes('u-admin'));
  t(`G: no change-feed row about the erased order survives, and none holds the text (${r.g.feedBefore} before) (${j([r.g.feedRows, r.g.feedLeak])})`,
    r.g.feedBefore >= 2 && r.g.feedRows === 0 && r.g.feedLeak === false);
}

await fs.rm(tmpRoot, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
