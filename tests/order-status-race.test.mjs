#!/usr/bin/env node
/**
 * An order's stock moves ONCE per status change, however many requests ask
 * for that change at the same moment.
 *
 * ## The bug
 *
 * `setOrderStatus` read the order, decided from the status it READ whether
 * the change should hand stock back (entering cancelled/refunded) or take it
 * again (leaving them), moved the stock, and only then wrote the new status.
 * Its comment said guarding on the previous status made re-cancelling
 * idempotent. That is true of two requests one after the other. It is not
 * true of two at once: both read `processing`, both release, and every unit
 * on the order goes back on the shelf twice. The shop then sells units it
 * does not have.
 *
 * Two at once is ordinary: an admin double-clicking the status select, an
 * admin cancelling while the provider's refund webhook arrives, a provider
 * delivering the same failure event twice, the abandoned-order sweep reaching
 * an order an admin is cancelling. lowdb's `locked()` mutex does not help —
 * it covers each LocalDB call on its own, not the read–move–write sequence —
 * so every driver has it.
 *
 * ## How the races are made to happen
 *
 * Three ways, from coarse to fine, for the reason stock-race.test.mjs gives:
 * a test that relies on timing proves nothing on a quiet machine.
 *
 *  - CONCURRENT (all drivers): Promise.all over the real callers. For most
 *    of them, on every driver, both requests read before either writes, and
 *    the old code failed them outright. Two do not overlap under Promise.all
 *    — C8 (the refund webhook reads and writes the order before it reaches
 *    the status change) and S1 (the sweep reads settings and the order list
 *    first) — and D6, S3 and S4 force what they could not. The assertions
 *    hold for ANY interleaving, so they stay meaningful if a future driver
 *    orders things differently.
 *
 *  - DETERMINISTIC (all drivers): LocalDB's static methods are wrapped, and
 *    the interfering request runs to completion immediately before the first
 *    request writes the order's status (or reserves a given product). That is
 *    exactly the granularity lowdb and doc-blob can interleave at — each
 *    LocalDB call is one `locked()` hold — and it works whether the status is
 *    written by `updateOrder` (the old code) or by `transitionOrderStatus`.
 *
 *  - RELATIONAL (execute hook): the same interleaving one level down, before
 *    the first `UPDATE orders` statement, on the driver where a single
 *    LocalDB call is itself several statements.
 *
 * Every deterministic scenario first proves its hook FIRED; one that never
 * fired would make every assertion after it vacuously true.
 *
 * ## What "the loser" must do
 *
 * Exactly what the SECOND of two sequential requests does, and nothing else:
 * a repeated cancel is an idempotent success carrying the order; a cancel
 * after a refund (or the reverse) is the state machine's 409 with its own
 * sentence. Never a 500, never a second stock movement, and never a second
 * "status changed" — the plugin action, the webhook delivery, the audit entry
 * and the change-feed entry are each counted.
 *
 * ## D4 is not a reproduction
 *
 * It passes on the original code. It pins the ORDER of the fix: taking stock
 * again BEFORE claiming the reopened status. Claiming first leaves a window
 * in which the order says `processing` while its stock is only partly
 * retaken; a cancel landing there releases lines that were never taken, and
 * the reopen's own undo then cannot put the count right.
 *
 * Run with:  node tests/order-status-race.test.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, loadTs } from './lib/load.mjs';

/* ---------------------------------------------------------------- child --- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Wrap LocalDB's order read and its order and stock writers so a callback
 * runs immediately BEFORE the first call `match` accepts, and a promise can
 * wait for the first call it accepts to have RETURNED.
 *
 * LocalDB is all-static and commerce-service calls it as `LocalDB.x(...)`, so
 * replacing the property reaches every caller in the one bundle.
 * `transitionOrderStatus` is wrapped only when it exists, which is what lets
 * the same scenario run against the code before and after the fix.
 */
function installBoundaryHook(LocalDB) {
  let pending = null;
  let fired = 0;
  const watchers = new Set();
  for (const name of ['getOrder', 'updateOrder', 'transitionOrderStatus', 'reserveStock', 'releaseStock']) {
    const original = LocalDB[name];
    if (typeof original !== 'function') continue;
    LocalDB[name] = async function hooked(...args) {
      if (pending && pending.match(name, args)) {
        const p = pending;
        pending = null;
        fired += 1;
        await p.run();
      }
      const result = await original.apply(this, args);
      for (const w of [...watchers]) {
        if (w.match(name, args)) { watchers.delete(w); w.resolve(); }
      }
      return result;
    };
  }
  return {
    /** Arm once. Returns a function reporting whether it actually fired. */
    before(match, run) {
      const at = fired;
      pending = { match, run };
      return () => fired > at;
    },
    /** Resolves once a call `match` accepts has completed. */
    after(match) {
      return new Promise((resolve) => watchers.add({ match, resolve }));
    },
    disarm() { pending = null; },
  };
}

/** A write of this order's STATUS, by whichever method the code under test uses. */
const statusWriteOf = (orderId) => (name, args) => args[0] === orderId && (
  name === 'transitionOrderStatus'
  || (name === 'updateOrder' && !!args[1] && Object.prototype.hasOwnProperty.call(args[1], 'status'))
);
const reserveOf = (productId) => (name, args) => name === 'reserveStock' && args[0] === productId;
const readOf = (orderId) => (name, args) => name === 'getOrder' && args[0] === orderId;

/**
 * The libSQL execute hook from stock-race.test.mjs: `run` goes immediately
 * before the first statement `match` accepts. Patched on the prototype
 * because the client is a private field of a module-level SqlStorage, and
 * `@libsql/client` is external to the bundle, so this is the instance
 * SqlStorage uses. `run` issues its statements through LocalDB normally; the
 * hook is disarmed before it runs, so they pass straight through.
 */
async function installSqlHook() {
  const { createClient } = await import('@libsql/client');
  const probe = createClient({ url: 'file::memory:' });
  const proto = Object.getPrototypeOf(probe);
  probe.close();
  const original = proto.execute;
  let pending = null;
  let fired = 0;
  proto.execute = async function hooked(stmt, args) {
    const sql = typeof stmt === 'string' ? stmt : stmt.sql;
    if (pending && pending.match(sql)) {
      const p = pending;
      pending = null;
      fired += 1;
      await p.run();
    }
    return original.call(this, stmt, args);
  };
  return {
    before(match, run) {
      const at = fired;
      pending = { match, run };
      return () => fired > at;
    },
  };
}
const UPDATE_ORDERS = (sql) => /^\s*UPDATE\s+orders\b/i.test(sql);

/**
 * Count the four things a status change records, per order: the plugin
 * action, the outbound webhook delivery, the audit entry, the change-feed
 * entry. The webhook points at a closed local port; a delivery ROW is written
 * before the attempt, and the row is what is counted.
 */
async function installProbes({ LocalDB, pluginManager, PLUGIN_HOOKS }) {
  const calls = [];
  pluginManager.registerPlugin({
    id: 'order-status-race-probe', name: 'probe', version: '1.0.0', description: '', author: '',
    actions: {
      [PLUGIN_HOOKS.AFTER_ORDER_STATUS_CHANGE]: (order, previous) => { calls.push({ id: order?.id, previous }); },
    },
  });
  pluginManager.activatePlugin('order-status-race-probe');
  const wh = await LocalDB.createWebhook({
    url: 'http://127.0.0.1:9/order-status-race', events: ['order.status_changed'], secret: 'race', active: true,
  });
  return async (orderId) => {
    // recordAudit and fireEvent are fire-and-forget; let them land.
    await sleep(300);
    const audits = (await LocalDB.getAuditEvents({ action: 'order.status_changed' }))
      .filter((e) => e.target === orderId).length;
    const deliveries = (await LocalDB.getWebhookDeliveries({ webhookId: wh.id, limit: 10000 }))
      .filter((d) => { try { return JSON.parse(d.payload)?.data?.id === orderId; } catch { return false; } }).length;
    const feed = (await LocalDB.getContentChanges())
      .filter((c) => c.entity_type === 'order' && c.entity_id === orderId && c.action === 'update').length;
    return { hooks: calls.filter((c) => c.id === orderId).length, audits, deliveries, feed };
  };
}

const twoVariants = (a, b) => [
  { id: 'v-black', options: { Colour: 'Black' }, stock: a, in_stock: a > 0, enabled: true },
  { id: 'v-tort', options: { Colour: 'Tortoise' }, stock: b, in_stock: b > 0, enabled: true },
];

function fixtures(LocalDB) {
  let n = 0;
  const base = { status: 'active', price_cents: 1000, categories: [], images: [], on_sale: false };
  return {
    simple: (slug, stock) => LocalDB.createProduct({ ...base, name: slug, slug, stock, in_stock: stock > 0 }),
    variable: (slug, black, tort) => LocalDB.createProduct({
      ...base, name: slug, slug, stock: null, type: 'variable', variants: twoVariants(black, tort), in_stock: true,
    }),
    /**
     * An order as checkout leaves it. `holds: true` reserves each line first,
     * which is what an open order means; a cancelled order's stock was
     * already handed back, so it is created without reserving.
     */
    async order(lines, { status = 'processing', payment_status = 'paid', holds = status !== 'cancelled' && status !== 'refunded' } = {}) {
      if (holds) {
        for (const l of lines) {
          const ok = await LocalDB.reserveStock(l.product_id, l.qty, { variantId: l.variant_id ?? null });
          if (!ok) throw new Error(`fixture could not reserve ${l.qty} of ${l.product_id}`);
        }
      }
      n += 1;
      const items = lines.map((l, i) => ({ name: `Line ${i + 1}`, price_cents: 1000, total_cents: 1000 * l.qty, ...l }));
      const total = items.reduce((s, i) => s + i.total_cents, 0);
      return LocalDB.createOrder({
        number: `RACE-${process.pid}-${n}`, status, payment_status, email: `race${n}@example.com`,
        items, subtotal_cents: total, total_cents: total, currency: 'EUR',
      });
    },
    async stock(productId, variantId) {
      const p = await LocalDB.getProduct(productId);
      return variantId ? (p?.variants ?? []).find((v) => v.id === variantId)?.stock : p?.stock;
    },
    async statusOf(orderId) { return (await LocalDB.getOrder(orderId))?.status; },
  };
}

const summary = (r) => (r?.ok
  ? { ok: true, status: r.value?.status ?? null }
  : { ok: false, code: r?.status ?? null, message: r?.message ?? null });

function putVia(putOrder) {
  return async (id, body) => {
    const res = await putOrder({
      params: { id },
      request: new Request(`http://localhost/api/orders/${id}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      }),
      locals: { user: { id: 'race-admin', role: 'admin' } },
    });
    const json = await res.json().catch(() => null);
    return { code: res.status, status: json?.data?.status ?? null, message: json?.error?.message ?? null };
  };
}

const verified = (orderId, outcome, eventId, amountCents) => ({
  eventId, reference: orderId, outcome, amountCents, currency: 'EUR', rawType: `race.${outcome}`,
});

async function concurrentChild(M) {
  const { LocalDB, setOrderStatus, applyVerifiedEvent } = M;
  const effects = await installProbes(M);
  const f = fixtures(LocalDB);
  const put = putVia(M.putOrder);
  const out = {};

  // C1. Two cancels of an order holding a simple product.
  {
    const p = await f.simple('c1', 5);
    const o = await f.order([{ product_id: p.id, qty: 2 }]);
    const held = await f.stock(p.id);
    const res = await Promise.all([
      setOrderStatus(o.id, 'cancelled', 'admin-a'), setOrderStatus(o.id, 'cancelled', 'admin-b'),
    ]);
    out.c1 = { held, stock: await f.stock(p.id), results: res.map(summary), final: await f.statusOf(o.id), effects: await effects(o.id) };
  }

  // C2. The same with a variant line: the credit goes to the variant, once.
  {
    const p = await f.variable('c2', 3, 3);
    const o = await f.order([{ product_id: p.id, variant_id: 'v-black', qty: 1 }]);
    const held = await f.stock(p.id, 'v-black');
    const res = await Promise.all([
      setOrderStatus(o.id, 'cancelled', 'admin-a'), setOrderStatus(o.id, 'cancelled', 'admin-b'),
    ]);
    out.c2 = {
      held, black: await f.stock(p.id, 'v-black'), tort: await f.stock(p.id, 'v-tort'),
      results: res.map(summary), effects: await effects(o.id),
    };
  }

  // C3. An admin cancel and a refund at the same moment, on an order holding
  //     a simple line and a variant line. Both statuses release stock; only
  //     one of them may, and the other is the state machine's refusal.
  {
    const p = await f.simple('c3', 4);
    const v = await f.variable('c3v', 5, 5);
    const o = await f.order([
      { product_id: p.id, qty: 1 },
      { product_id: v.id, variant_id: 'v-black', qty: 2 },
    ]);
    const held = { simple: await f.stock(p.id), black: await f.stock(v.id, 'v-black') };
    const res = await Promise.all([
      setOrderStatus(o.id, 'cancelled', 'admin'), setOrderStatus(o.id, 'refunded', 'provider'),
    ]);
    out.c3 = {
      held, simple: await f.stock(p.id), black: await f.stock(v.id, 'v-black'),
      results: res.map(summary), final: await f.statusOf(o.id), effects: await effects(o.id),
    };
  }

  // C4. The reverse: two reopenings of a cancelled order must take its stock
  //     once — simple and variant.
  {
    const p = await f.simple('c4', 10);
    const v = await f.variable('c4v', 5, 5);
    const o = await f.order([
      { product_id: p.id, qty: 3 },
      { product_id: v.id, variant_id: 'v-tort', qty: 2 },
    ], { status: 'cancelled' });
    const res = await Promise.all([
      setOrderStatus(o.id, 'processing', 'admin-a'), setOrderStatus(o.id, 'processing', 'admin-b'),
    ]);
    out.c4 = {
      simple: await f.stock(p.id), tort: await f.stock(v.id, 'v-tort'), black: await f.stock(v.id, 'v-black'),
      results: res.map(summary), final: await f.statusOf(o.id), effects: await effects(o.id),
    };
  }

  // C5. Reopened to two DIFFERENT open statuses at once. Sequentially that is
  //     a reopen and then an ordinary move between open statuses: stock taken
  //     once, both succeed, two status changes recorded.
  {
    const p = await f.simple('c5', 10);
    const o = await f.order([{ product_id: p.id, qty: 4 }], { status: 'cancelled' });
    const res = await Promise.all([
      setOrderStatus(o.id, 'pending', 'admin-a'), setOrderStatus(o.id, 'processing', 'admin-b'),
    ]);
    out.c5 = { stock: await f.stock(p.id), results: res.map(summary), effects: await effects(o.id) };
  }

  // C6. The admin double-click, through the real PUT /api/orders/{id}.
  {
    const p = await f.simple('c6', 6);
    const o = await f.order([{ product_id: p.id, qty: 1 }]);
    const res = await Promise.all([put(o.id, { status: 'cancelled' }), put(o.id, { status: 'cancelled' })]);
    out.c6 = { stock: await f.stock(p.id), res, effects: await effects(o.id) };
  }

  // C7. Cancel and refund through the route: one 200, one 409, no 500.
  {
    const p = await f.simple('c7', 6);
    const o = await f.order([{ product_id: p.id, qty: 2 }]);
    const res = await Promise.all([put(o.id, { status: 'cancelled' }), put(o.id, { status: 'refunded' })]);
    out.c7 = { stock: await f.stock(p.id), res, final: await f.statusOf(o.id), effects: await effects(o.id) };
  }

  // C8. The provider's refund webhook racing an admin cancel. The webhook
  //     reads and writes the order before it reaches the status change, so
  //     under Promise.all the admin usually finishes first and this does not
  //     overlap at all; D6 forces the overlap. Kept because its assertions
  //     hold for any interleaving.
  {
    const p = await f.simple('c8', 5);
    const o = await f.order([{ product_id: p.id, qty: 2 }], { payment_status: 'paid' });
    const [admin, hook] = await Promise.all([
      setOrderStatus(o.id, 'cancelled', 'admin'),
      applyVerifiedEvent(verified(o.id, 'refunded', `evt_refund_${o.id}`, o.total_cents)),
    ]);
    out.c8 = {
      stock: await f.stock(p.id), admin: summary(admin), applied: hook.applied,
      final: await f.statusOf(o.id), effects: await effects(o.id),
    };
  }

  // C9. The provider delivering the same failure event twice at once. Both
  //     deliveries pass the idempotency ledger (neither has written it yet),
  //     so both reach the cancel.
  {
    const p = await f.simple('c9', 5);
    const o = await f.order([{ product_id: p.id, qty: 3 }], { status: 'pending', payment_status: 'pending' });
    const evt = verified(o.id, 'failed', `evt_fail_${o.id}`, o.total_cents);
    const res = await Promise.all([applyVerifiedEvent(evt), applyVerifiedEvent({ ...evt })]);
    out.c9 = {
      stock: await f.stock(p.id), actions: res.map((r) => r.decision.action),
      final: await f.statusOf(o.id), effects: await effects(o.id),
    };
  }

  return out;
}

async function deterministicChild(M) {
  const { LocalDB, setOrderStatus, applyVerifiedEvent } = M;
  const effects = await installProbes(M);
  const hook = installBoundaryHook(LocalDB);
  const f = fixtures(LocalDB);
  const out = {};

  // D1. A second cancel runs start to finish between the first cancel's read
  //     and its status write.
  {
    const p = await f.simple('d1', 5);
    const o = await f.order([{ product_id: p.id, qty: 2 }]);
    let second = null;
    const fired = hook.before(statusWriteOf(o.id), async () => {
      second = summary(await setOrderStatus(o.id, 'cancelled', 'admin-b'));
    });
    const first = summary(await setOrderStatus(o.id, 'cancelled', 'admin-a'));
    out.d1 = { fired: fired(), stock: await f.stock(p.id), first, second, effects: await effects(o.id) };
  }

  // D1v. The same, on a variant.
  {
    const p = await f.variable('d1v', 2, 2);
    const o = await f.order([{ product_id: p.id, variant_id: 'v-black', qty: 2 }]);
    let second = null;
    const fired = hook.before(statusWriteOf(o.id), async () => {
      second = summary(await setOrderStatus(o.id, 'cancelled', 'admin-b'));
    });
    const first = summary(await setOrderStatus(o.id, 'cancelled', 'admin-a'));
    out.d1v = {
      fired: fired(), black: await f.stock(p.id, 'v-black'), tort: await f.stock(p.id, 'v-tort'),
      first, second, effects: await effects(o.id),
    };
  }

  // D2. A refund lands inside an admin's cancel. The refund wins; the cancel
  //     must then answer exactly what a cancel after a refund answers.
  {
    const p = await f.simple('d2', 5);
    const o = await f.order([{ product_id: p.id, qty: 1 }]);
    let refund = null;
    const fired = hook.before(statusWriteOf(o.id), async () => {
      refund = summary(await setOrderStatus(o.id, 'refunded', 'provider'));
    });
    const cancel = summary(await setOrderStatus(o.id, 'cancelled', 'admin'));
    out.d2 = {
      fired: fired(), stock: await f.stock(p.id), cancel, refund,
      final: await f.statusOf(o.id), effects: await effects(o.id),
    };
  }

  // D3. A second reopen runs inside the first.
  {
    const p = await f.simple('d3', 10);
    const v = await f.variable('d3v', 4, 4);
    const o = await f.order([
      { product_id: p.id, qty: 3 },
      { product_id: v.id, variant_id: 'v-black', qty: 1 },
    ], { status: 'cancelled' });
    let second = null;
    const fired = hook.before(statusWriteOf(o.id), async () => {
      second = summary(await setOrderStatus(o.id, 'processing', 'admin-b'));
    });
    const first = summary(await setOrderStatus(o.id, 'processing', 'admin-a'));
    out.d3 = {
      fired: fired(), simple: await f.stock(p.id), black: await f.stock(v.id, 'v-black'),
      first, second, final: await f.statusOf(o.id), effects: await effects(o.id),
    };
  }

  // D4. A reopen that must fail (line 2's product has none left), with a
  //     cancel starting just before it tries line 2 and finishing its status
  //     write before line 2 is tried. See the header: this pins the ORDER of
  //     the fix, and passes on the original code.
  {
    const p1 = await f.simple('d4a', 5);
    const p2 = await f.simple('d4b', 0);
    const o = await f.order([
      { product_id: p1.id, qty: 1 },
      { product_id: p2.id, qty: 1 },
    ], { status: 'cancelled' });
    let cancel = null;
    const fired = hook.before(reserveOf(p2.id), async () => {
      const running = setOrderStatus(o.id, 'cancelled', 'admin-b').then((r) => { cancel = r; return r; });
      await Promise.race([running, hook.after(statusWriteOf(o.id))]);
      // Leave the cancel running: its stock movements now interleave with the
      // reopen's failure and undo.
      out.d4Pending = running;
    });
    const reopen = summary(await setOrderStatus(o.id, 'processing', 'admin-a'));
    await out.d4Pending;
    delete out.d4Pending;
    out.d4 = {
      fired: fired(), p1: await f.stock(p1.id), p2: await f.stock(p2.id),
      reopen, cancel: summary(cancel), final: await f.statusOf(o.id), effects: await effects(o.id),
    };
  }

  // D5. A payment FAILURE event is being applied when the provider's success
  //     for the same order lands (its payment write) between the failure's
  //     payment write and its cancel. A paid order must not be cancelled.
  {
    const p = await f.simple('d5', 5);
    const o = await f.order([{ product_id: p.id, qty: 2 }], { status: 'pending', payment_status: 'pending' });
    const fired = hook.before(statusWriteOf(o.id), async () => {
      await LocalDB.updateOrder(o.id, { payment_status: 'paid' });
    });
    const res = await applyVerifiedEvent(verified(o.id, 'failed', `evt_late_${o.id}`, o.total_cents));
    const after = await LocalDB.getOrder(o.id);
    out.d5 = {
      fired: fired(), stock: await f.stock(p.id), action: res.decision.action,
      final: after?.status, payment: after?.payment_status, effects: await effects(o.id),
    };
  }

  // D6. C8, forced: the admin's cancel runs between the refund webhook's
  //     read of the order and its status write.
  {
    const p = await f.simple('d6', 5);
    const o = await f.order([{ product_id: p.id, qty: 2 }], { payment_status: 'paid' });
    let admin = null;
    const fired = hook.before(statusWriteOf(o.id), async () => {
      admin = summary(await setOrderStatus(o.id, 'cancelled', 'admin'));
    });
    const res = await applyVerifiedEvent(verified(o.id, 'refunded', `evt_refund_${o.id}`, o.total_cents));
    const after = await LocalDB.getOrder(o.id);
    out.d6 = {
      fired: fired(), stock: await f.stock(p.id), admin, applied: res.applied,
      final: after?.status, payment: after?.payment_status, effects: await effects(o.id),
    };
  }

  // D7. A reopen finds the order's units already gone — taken by a second
  //     reopen of the SAME order that ran to completion inside it. That is
  //     not "out of stock"; it is the repeat of a reopen that worked, and it
  //     answers as one.
  {
    const p = await f.simple('d7', 2);
    const o = await f.order([{ product_id: p.id, qty: 2 }], { status: 'cancelled' });
    let second = null;
    const fired = hook.before(reserveOf(p.id), async () => {
      second = summary(await setOrderStatus(o.id, 'processing', 'admin-b'));
    });
    const first = summary(await setOrderStatus(o.id, 'processing', 'admin-a'));
    out.d7 = {
      fired: fired(), stock: await f.stock(p.id), first, second,
      final: await f.statusOf(o.id), effects: await effects(o.id),
    };
  }

  hook.disarm();

  // R1–R3. The relational driver, one level down: the interfering request
  // runs before the first `UPDATE orders` STATEMENT.
  if (process.env.DATABASE_DRIVER === 'relational') {
    const sql = await installSqlHook();

    {
      const p = await f.simple('r1', 5);
      const o = await f.order([{ product_id: p.id, qty: 2 }]);
      let second = null;
      const fired = sql.before(UPDATE_ORDERS, async () => {
        second = summary(await setOrderStatus(o.id, 'cancelled', 'admin-b'));
      });
      const first = summary(await setOrderStatus(o.id, 'cancelled', 'admin-a'));
      out.r1 = { fired: fired(), stock: await f.stock(p.id), first, second, effects: await effects(o.id) };
    }

    {
      const v = await f.variable('r2', 6, 6);
      const o = await f.order([{ product_id: v.id, variant_id: 'v-tort', qty: 2 }], { status: 'cancelled' });
      let second = null;
      const fired = sql.before(UPDATE_ORDERS, async () => {
        second = summary(await setOrderStatus(o.id, 'processing', 'admin-b'));
      });
      const first = summary(await setOrderStatus(o.id, 'processing', 'admin-a'));
      out.r2 = {
        fired: fired(), tort: await f.stock(v.id, 'v-tort'), black: await f.stock(v.id, 'v-black'),
        first, second, effects: await effects(o.id),
      };
    }

    {
      const p = await f.simple('r3', 5);
      const o = await f.order([{ product_id: p.id, qty: 1 }]);
      let cancel = null;
      const fired = sql.before(UPDATE_ORDERS, async () => {
        cancel = summary(await setOrderStatus(o.id, 'cancelled', 'admin'));
      });
      const refund = summary(await setOrderStatus(o.id, 'refunded', 'provider'));
      out.r3 = {
        fired: fired(), stock: await f.stock(p.id), cancel, refund,
        final: await f.statusOf(o.id), effects: await effects(o.id),
      };
    }
  }

  return out;
}

/**
 * The abandoned-order sweep, in a database of its own: it cancels EVERY stale
 * unpaid pending order it finds, so it must not meet the other scenarios'.
 */
async function sweepChild(M) {
  const { LocalDB, setOrderStatus, sweepAbandonedOrders } = M;
  const effects = await installProbes(M);
  const hook = installBoundaryHook(LocalDB);
  const f = fixtures(LocalDB);
  const out = {};
  // Far enough ahead that a just-created pending order is stale under any
  // configured abandonment window (the maximum is 90 days).
  const later = Date.now() + 120 * 86_400_000;

  // S1. The sweep and an admin cancel of the same stale order, at once.
  {
    const p = await f.simple('s1', 5);
    const o = await f.order([{ product_id: p.id, qty: 2 }], { status: 'pending', payment_status: 'unpaid' });
    const [swept, admin] = await Promise.all([
      sweepAbandonedOrders(later),
      setOrderStatus(o.id, 'cancelled', 'race-admin'),
    ]);
    await sleep(300);
    const after = await LocalDB.getOrder(o.id);
    const audits = (await LocalDB.getAuditEvents({ action: 'order.status_changed' })).filter((e) => e.target === o.id);
    out.s1 = {
      stock: await f.stock(p.id), swept: swept.cancelled, admin: summary(admin),
      final: after?.status, reason: after?.cancelled_reason ?? null,
      changedBy: audits.map((e) => e.actor), effects: await effects(o.id),
    };
  }

  // S2. The sweep read its list while the order was unpaid; the payment
  //     lands (payment write, then the move to processing) between the
  //     sweep's decision and its status write.
  {
    const p = await f.simple('s2', 5);
    const o = await f.order([{ product_id: p.id, qty: 2 }], { status: 'pending', payment_status: 'pending' });
    let captured = null;
    const fired = hook.before(statusWriteOf(o.id), async () => {
      await LocalDB.updateOrder(o.id, { payment_status: 'paid' });
      captured = summary(await setOrderStatus(o.id, 'processing'));
    });
    const swept = await sweepAbandonedOrders(later);
    hook.disarm();
    const after = await LocalDB.getOrder(o.id);
    out.s2 = {
      fired: fired(), stock: await f.stock(p.id), swept: swept.cancelled, captured,
      final: after?.status, payment: after?.payment_status, reason: after?.cancelled_reason ?? null,
    };
  }

  // S3. S1, forced one way: an admin cancel runs between the sweep's read of
  //     the order and its status write.
  {
    const p = await f.simple('s3', 5);
    const o = await f.order([{ product_id: p.id, qty: 2 }], { status: 'pending', payment_status: 'unpaid' });
    let admin = null;
    const fired = hook.before(statusWriteOf(o.id), async () => {
      admin = summary(await setOrderStatus(o.id, 'cancelled', 'race-admin'));
    });
    const swept = await sweepAbandonedOrders(later);
    hook.disarm();
    const after = await LocalDB.getOrder(o.id);
    out.s3 = {
      fired: fired(), stock: await f.stock(p.id), swept: swept.cancelled, admin,
      final: after?.status, reason: after?.cancelled_reason ?? null, effects: await effects(o.id),
    };
  }

  // S4. S1, forced the other way: the sweep read its LIST while the order was
  //     pending, and an admin cancels it before the sweep reads the order
  //     itself. The sweep must not record a staff cancel as an abandonment.
  {
    const p = await f.simple('s4', 5);
    const o = await f.order([{ product_id: p.id, qty: 2 }], { status: 'pending', payment_status: 'unpaid' });
    let admin = null;
    const fired = hook.before(readOf(o.id), async () => {
      admin = summary(await setOrderStatus(o.id, 'cancelled', 'race-admin'));
    });
    const swept = await sweepAbandonedOrders(later);
    hook.disarm();
    const after = await LocalDB.getOrder(o.id);
    const abandonedAudit = (await LocalDB.getAuditEvents({ action: 'order.abandoned' })).filter((e) => e.target === o.id).length;
    out.s4 = {
      fired: fired(), stock: await f.stock(p.id), swept: swept.cancelled, admin,
      final: after?.status, reason: after?.cancelled_reason ?? null, abandonedAudit, effects: await effects(o.id),
    };
  }

  return out;
}

if (process.env.ORDER_RACE_CHILD) {
  const M = await loadTs('tests/fixtures/storage-entry.ts', 'orderrace');
  await M.LocalDB.init();
  const mode = process.env.ORDER_RACE_CHILD;
  const result = mode === 'concurrent'
    ? await concurrentChild(M)
    : mode === 'deterministic'
      ? await deterministicChild(M)
      : await sweepChild(M);
  console.log('__RESULT__' + JSON.stringify(result));
  process.exit(0);
}

/* --------------------------------------------------------------- parent --- */
let pass = 0;
let fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };

const tmpRoot = path.join(os.tmpdir(), `astrobaas-order-race-${process.pid}`);
await fs.mkdir(tmpRoot, { recursive: true });

const DRIVERS = [
  { name: 'lowdb', env: (d) => ({ DB_PATH: path.join(d, 'db.json') }) },
  { name: 'libsql', env: (d) => ({ DATABASE_URL: `file:${path.join(d, 'db.sqlite')}` }) },
  { name: 'relational', env: (d) => ({ DATABASE_URL: `file:${path.join(d, 'db.sqlite')}`, DATABASE_DRIVER: 'relational' }) },
];

async function runChild(mode, driver) {
  const dir = path.join(tmpRoot, `${mode}-${driver.name}`);
  await fs.mkdir(path.join(dir, 'uploads'), { recursive: true });
  const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    env: {
      ...process.env, ORDER_RACE_CHILD: mode, NODE_ENV: 'test',
      // A staging flag inherited from the shell would silence fireEvent, and
      // the webhook-delivery count would pass for the wrong reason.
      STAGING: '', ASTROBAAS_STAGING: '',
      UPLOADS_DIR: path.join(dir, 'uploads'), ...driver.env(dir),
    },
  });
  const line = (run.stdout || '').split('\n').find((l) => l.startsWith('__RESULT__'));
  if (!line) {
    fail++;
    console.error(`✗ [${driver.name}/${mode}] child produced no result\n${(run.stderr || '').slice(-1500)}`);
    return null;
  }
  return JSON.parse(line.slice('__RESULT__'.length));
}

const ONCE = { hooks: 1, audits: 1, deliveries: 1, feed: 1 };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fx = (e) => `hooks=${e?.hooks} audits=${e?.audits} deliveries=${e?.deliveries} feed=${e?.feed}`;
// What the SECOND of two sequential requests answers, by what the first did.
const REFUSAL = {
  'cancelled->refunded': 'An order cannot go from "cancelled" to "refunded".',
  'refunded->cancelled': 'A refunded order is final — its money has already been returned.',
};

/* ---- concurrent callers, every driver ---- */
for (const driver of DRIVERS) {
  const r = await runChild('concurrent', driver);
  if (!r) continue;
  const t = (n, c) => check(`[${driver.name}] ${n}`, c);

  t(`C1: the fixture order holds its stock (stock=${r.c1.held}, expected 3)`, r.c1.held === 3);
  t(`C1: two concurrent cancels credit the stock ONCE (stock=${r.c1.stock}, expected 5)`, r.c1.stock === 5);
  t(`C1: ...both answer as a sequential repeat does, with the cancelled order (${JSON.stringify(r.c1.results)})`,
    r.c1.results.every((x) => x.ok && x.status === 'cancelled'));
  t(`C1: ...and the status change is recorded once (${fx(r.c1.effects)})`, same(r.c1.effects, ONCE));

  t(`C2: the fixture order holds the variant (black=${r.c2.held}, expected 2)`, r.c2.held === 2);
  t(`C2: two concurrent cancels credit the VARIANT once (black=${r.c2.black}, tort=${r.c2.tort}, expected 3 and 3)`,
    r.c2.black === 3 && r.c2.tort === 3);
  t(`C2: ...both succeed (${JSON.stringify(r.c2.results)})`, r.c2.results.every((x) => x.ok && x.status === 'cancelled'));
  t(`C2: ...recorded once (${fx(r.c2.effects)})`, same(r.c2.effects, ONCE));

  t(`C3: the fixture holds both lines (${JSON.stringify(r.c3.held)})`, r.c3.held.simple === 3 && r.c3.held.black === 3);
  t(`C3: a cancel racing a refund returns each line ONCE (simple=${r.c3.simple} black=${r.c3.black}, expected 4 and 5)`,
    r.c3.simple === 4 && r.c3.black === 5);
  {
    const won = r.c3.results.filter((x) => x.ok);
    const lost = r.c3.results.filter((x) => !x.ok);
    const loserWanted = r.c3.final === 'cancelled' ? 'refunded' : 'cancelled';
    t(`C3: exactly one of cancel/refund wins, and the order is in its status (${JSON.stringify(r.c3.results)} final=${r.c3.final})`,
      won.length === 1 && won[0].status === r.c3.final && (r.c3.final === 'cancelled' || r.c3.final === 'refunded'));
    t(`C3: ...the other gets the SAME 409 a sequential second request gets (${JSON.stringify(lost[0])})`,
      lost.length === 1 && lost[0].code === 409 && lost[0].message === REFUSAL[`${r.c3.final}->${loserWanted}`]);
  }
  t(`C3: ...recorded once (${fx(r.c3.effects)})`, same(r.c3.effects, ONCE));

  t(`C4: two concurrent reopens take the stock ONCE (simple=${r.c4.simple} tort=${r.c4.tort}, expected 7 and 3)`,
    r.c4.simple === 7 && r.c4.tort === 3);
  t(`C4: ...the colour nobody ordered is untouched (black=${r.c4.black})`, r.c4.black === 5);
  t(`C4: ...both succeed, as a repeated reopen does (${JSON.stringify(r.c4.results)} final=${r.c4.final})`,
    r.c4.results.every((x) => x.ok && x.status === 'processing') && r.c4.final === 'processing');
  t(`C4: ...recorded once (${fx(r.c4.effects)})`, same(r.c4.effects, ONCE));

  t(`C5: reopening to pending and to processing at once takes the stock ONCE (stock=${r.c5.stock}, expected 6)`,
    r.c5.stock === 6);
  t(`C5: ...both succeed, as the two in sequence do (${JSON.stringify(r.c5.results)})`, r.c5.results.every((x) => x.ok));
  t(`C5: ...and two status changes are recorded, one each (${fx(r.c5.effects)})`,
    same(r.c5.effects, { hooks: 2, audits: 2, deliveries: 2, feed: 2 }));

  t(`C6: an admin double-click through PUT /api/orders/{id} credits the stock ONCE (stock=${r.c6.stock}, expected 6)`,
    r.c6.stock === 6);
  t(`C6: ...both clicks answer 200 with the cancelled order (${JSON.stringify(r.c6.res)})`,
    r.c6.res.every((x) => x.code === 200 && x.status === 'cancelled'));
  t(`C6: ...recorded once (${fx(r.c6.effects)})`, same(r.c6.effects, ONCE));

  t(`C7: cancel and refund through the route credit the stock ONCE (stock=${r.c7.stock}, expected 6)`, r.c7.stock === 6);
  {
    const codes = r.c7.res.map((x) => x.code).sort();
    const lost = r.c7.res.find((x) => x.code !== 200);
    const loserWanted = r.c7.final === 'cancelled' ? 'refunded' : 'cancelled';
    t(`C7: ...one 200 and one 409, never a 500 (${codes.join(',')})`, same(codes, [200, 409]));
    t(`C7: ...the 409 carries the state machine's sentence (${lost?.message})`,
      lost?.message === REFUSAL[`${r.c7.final}->${loserWanted}`]);
  }
  t(`C7: ...recorded once (${fx(r.c7.effects)})`, same(r.c7.effects, ONCE));

  t(`C8: a refund webhook racing an admin cancel credits the stock ONCE (stock=${r.c8.stock}, expected 5)`, r.c8.stock === 5);
  t(`C8: ...the order ends cancelled or refunded (final=${r.c8.final})`, r.c8.final === 'cancelled' || r.c8.final === 'refunded');
  t(`C8: ...the admin's answer matches who won (${JSON.stringify(r.c8.admin)})`,
    r.c8.final === 'cancelled'
      ? r.c8.admin.ok === true
      : r.c8.admin.code === 409 && r.c8.admin.message === REFUSAL['refunded->cancelled']);
  t(`C8: ...the event itself was applied (applied=${r.c8.applied})`, r.c8.applied === true);
  // The change feed also carries the webhook's own payment write.
  t(`C8: ...recorded once (${fx(r.c8.effects)})`, same(r.c8.effects, { ...ONCE, feed: 2 }));

  t(`C9: one failure event delivered twice at once credits the stock ONCE (stock=${r.c9.stock}, expected 5)`, r.c9.stock === 5);
  t(`C9: ...and cancels the order (final=${r.c9.final}, actions=${r.c9.actions.join(',')})`, r.c9.final === 'cancelled');
  // Feed: ONE payment write — the second delivery's claim is refused as a
  // duplicate and writes nothing (claimPaymentEvent, hardening step 4; it was
  // two writes before) — plus one status change.
  t(`C9: ...recorded once (${fx(r.c9.effects)})`, same(r.c9.effects, { ...ONCE, feed: 2 }));
  t(`C9: ...and only one delivery applied the event (${r.c9.actions.join(',')})`,
    r.c9.actions.filter((a) => a === 'fail').length === 1);
}

/* ---- forced interleavings, every driver (and statement-level on relational) ---- */
for (const driver of DRIVERS) {
  const r = await runChild('deterministic', driver);
  if (!r) continue;
  const t = (n, c) => check(`[${driver.name}] ${n}`, c);
  const keys = ['d1', 'd1v', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', ...(driver.name === 'relational' ? ['r1', 'r2', 'r3'] : [])];
  for (const k of keys) t(`${k}: the interfering request really ran inside the first`, r[k]?.fired === true);

  t(`D1: a cancel run inside another cancel credits the stock ONCE (stock=${r.d1.stock}, expected 5)`, r.d1.stock === 5);
  t(`D1: ...both succeed with the cancelled order (first=${JSON.stringify(r.d1.first)} second=${JSON.stringify(r.d1.second)})`,
    r.d1.first?.ok && r.d1.first.status === 'cancelled' && r.d1.second?.ok && r.d1.second.status === 'cancelled');
  t(`D1: ...recorded once (${fx(r.d1.effects)})`, same(r.d1.effects, ONCE));

  t(`D1v: ...and on a variant (black=${r.d1v.black}, tort=${r.d1v.tort}, expected 2 and 2)`, r.d1v.black === 2 && r.d1v.tort === 2);
  t(`D1v: ...both succeed (${JSON.stringify([r.d1v.first, r.d1v.second])})`, r.d1v.first?.ok && r.d1v.second?.ok);
  t(`D1v: ...recorded once (${fx(r.d1v.effects)})`, same(r.d1v.effects, ONCE));

  t(`D2: a refund inside a cancel credits the stock ONCE (stock=${r.d2.stock}, expected 5)`, r.d2.stock === 5);
  t(`D2: ...the refund, which finished first, won (refund=${JSON.stringify(r.d2.refund)} final=${r.d2.final})`,
    r.d2.refund?.ok && r.d2.final === 'refunded');
  t(`D2: ...and the cancel answers what a cancel after a refund answers (${JSON.stringify(r.d2.cancel)})`,
    r.d2.cancel?.ok === false && r.d2.cancel.code === 409 && r.d2.cancel.message === REFUSAL['refunded->cancelled']);
  t(`D2: ...recorded once (${fx(r.d2.effects)})`, same(r.d2.effects, ONCE));

  t(`D3: a reopen inside a reopen takes the stock ONCE (simple=${r.d3.simple} black=${r.d3.black}, expected 7 and 3)`,
    r.d3.simple === 7 && r.d3.black === 3);
  t(`D3: ...both succeed and the order is open (${JSON.stringify([r.d3.first, r.d3.second])} final=${r.d3.final})`,
    r.d3.first?.ok && r.d3.second?.ok && r.d3.final === 'processing');
  t(`D3: ...recorded once (${fx(r.d3.effects)})`, same(r.d3.effects, ONCE));

  t(`D4: a reopen that fails for stock, with a cancel landing mid-way, leaves every count as it was (p1=${r.d4.p1} p2=${r.d4.p2}, expected 5 and 0)`,
    r.d4.p1 === 5 && r.d4.p2 === 0);
  t(`D4: ...the reopen is refused with today's sentence (${JSON.stringify(r.d4.reopen)})`,
    r.d4.reopen?.ok === false && r.d4.reopen.code === 409 && r.d4.reopen.message === 'Cannot reopen order: insufficient stock for Line 2');
  t(`D4: ...the cancel succeeds and the order stays cancelled (${JSON.stringify(r.d4.cancel)} final=${r.d4.final})`,
    r.d4.cancel?.ok === true && r.d4.final === 'cancelled');
  t(`D4: ...and nothing was recorded as a status change (${fx(r.d4.effects)})`,
    same(r.d4.effects, { hooks: 0, audits: 0, deliveries: 0, feed: 0 }));

  t(`D5: a late payment failure does not cancel an order that was paid meanwhile (final=${r.d5.final}, payment=${r.d5.payment})`,
    r.d5.final === 'pending' && r.d5.payment === 'paid');
  t(`D5: ...so its stock stays held (stock=${r.d5.stock}, expected 3)`, r.d5.stock === 3);
  // Feed: the two payment writes, and no status change.
  t(`D5: ...and no status change is recorded (${fx(r.d5.effects)})`,
    same(r.d5.effects, { hooks: 0, audits: 0, deliveries: 0, feed: 2 }));

  t(`D6: an admin cancel inside the refund webhook credits the stock ONCE (stock=${r.d6.stock}, expected 5)`, r.d6.stock === 5);
  t(`D6: ...the cancel, which finished first, stands (admin=${JSON.stringify(r.d6.admin)} final=${r.d6.final})`,
    r.d6.admin?.ok === true && r.d6.final === 'cancelled');
  t(`D6: ...the refund is still recorded as money (applied=${r.d6.applied}, payment=${r.d6.payment})`,
    r.d6.applied === true && r.d6.payment === 'refunded');
  t(`D6: ...recorded once (${fx(r.d6.effects)})`, same(r.d6.effects, { ...ONCE, feed: 2 }));

  t(`D7: the order's units are taken once (stock=${r.d7.stock}, expected 0)`, r.d7.stock === 0);
  t(`D7: a reopen that finds its units taken by a concurrent reopen of the same order succeeds as the repeat it is (${JSON.stringify([r.d7.first, r.d7.second])} final=${r.d7.final})`,
    r.d7.first?.ok === true && r.d7.first.status === 'processing' && r.d7.second?.ok === true && r.d7.final === 'processing');
  t(`D7: ...recorded once (${fx(r.d7.effects)})`, same(r.d7.effects, ONCE));

  if (driver.name === 'relational') {
    t(`R1: a cancel before the first cancel's UPDATE statement credits the stock ONCE (stock=${r.r1.stock}, expected 5)`,
      r.r1.stock === 5);
    t(`R1: ...both succeed (${JSON.stringify([r.r1.first, r.r1.second])})`, r.r1.first?.ok && r.r1.second?.ok);
    t(`R1: ...recorded once (${fx(r.r1.effects)})`, same(r.r1.effects, ONCE));

    t(`R2: a reopen before the first reopen's UPDATE statement takes the variant ONCE (tort=${r.r2.tort}, black=${r.r2.black}, expected 4 and 6)`,
      r.r2.tort === 4 && r.r2.black === 6);
    t(`R2: ...both succeed (${JSON.stringify([r.r2.first, r.r2.second])})`, r.r2.first?.ok && r.r2.second?.ok);
    t(`R2: ...recorded once (${fx(r.r2.effects)})`, same(r.r2.effects, ONCE));

    t(`R3: a cancel before a refund's UPDATE statement credits the stock ONCE (stock=${r.r3.stock}, expected 5)`,
      r.r3.stock === 5);
    t(`R3: ...the cancel won and the refund gets the state machine's 409 (${JSON.stringify([r.r3.cancel, r.r3.refund])} final=${r.r3.final})`,
      r.r3.cancel?.ok && r.r3.final === 'cancelled'
        && r.r3.refund?.ok === false && r.r3.refund.code === 409 && r.r3.refund.message === REFUSAL['cancelled->refunded']);
    t(`R3: ...recorded once (${fx(r.r3.effects)})`, same(r.r3.effects, ONCE));
  }
}

/* ---- the abandoned-order sweep, every driver ---- */
for (const driver of DRIVERS) {
  const r = await runChild('sweep', driver);
  if (!r) continue;
  const t = (n, c) => check(`[${driver.name}] ${n}`, c);

  t(`S1: the sweep and an admin cancelling the same order credit the stock ONCE (stock=${r.s1.stock}, expected 5)`,
    r.s1.stock === 5);
  t(`S1: ...the order is cancelled by exactly one of them (final=${r.s1.final}, changed by ${r.s1.changedBy.join(',')})`,
    r.s1.final === 'cancelled' && r.s1.changedBy.length === 1);
  {
    const bySweep = r.s1.changedBy[0] === 'system:abandonment';
    t(`S1: ...it is recorded as abandoned only if the SWEEP cancelled it (reason=${r.s1.reason}, swept=${r.s1.swept}, by=${r.s1.changedBy[0]})`,
      bySweep ? r.s1.reason === 'abandoned' && r.s1.swept === 1 : r.s1.reason === null && r.s1.swept === 0);
    t(`S1: ...and the admin's cancel succeeded either way (${JSON.stringify(r.s1.admin)})`, r.s1.admin.ok === true);
  }
  t(`S1: ...recorded once (${fx(r.s1.effects)})`, same(r.s1.effects, ONCE));

  t('S2: the payment really landed inside the sweep', r.s2.fired === true && r.s2.captured?.ok === true);
  t(`S2: the sweep does not cancel an order that was paid after it read its list (final=${r.s2.final}, payment=${r.s2.payment}, swept=${r.s2.swept})`,
    r.s2.final === 'processing' && r.s2.payment === 'paid' && r.s2.swept === 0);
  t(`S2: ...its stock stays held (stock=${r.s2.stock}, expected 3)`, r.s2.stock === 3);
  t(`S2: ...and it is not recorded as abandoned (reason=${r.s2.reason})`, r.s2.reason === null);

  t('S3: the admin cancel really ran inside the sweep', r.s3.fired === true && r.s3.admin?.ok === true);
  t(`S3: an admin cancel inside the sweep credits the stock ONCE (stock=${r.s3.stock}, expected 5)`, r.s3.stock === 5);
  t(`S3: ...the sweep reports nothing cancelled and records no abandonment (swept=${r.s3.swept}, reason=${r.s3.reason}, final=${r.s3.final})`,
    r.s3.swept === 0 && r.s3.reason === null && r.s3.final === 'cancelled');
  t(`S3: ...recorded once (${fx(r.s3.effects)})`, same(r.s3.effects, ONCE));

  t('S4: the admin cancel really ran between the sweep\'s list and its read', r.s4.fired === true && r.s4.admin?.ok === true);
  t(`S4: the stock is credited once (stock=${r.s4.stock}, expected 5)`, r.s4.stock === 5);
  t(`S4: ...and a staff cancel is not recorded as an abandonment (swept=${r.s4.swept}, reason=${r.s4.reason}, order.abandoned audits=${r.s4.abandonedAudit})`,
    r.s4.swept === 0 && r.s4.reason === null && r.s4.abandonedAudit === 0);
  t(`S4: ...recorded once (${fx(r.s4.effects)})`, same(r.s4.effects, ONCE));
}

await fs.rm(tmpRoot, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
