#!/usr/bin/env node
/**
 * Checkout and payment writes that two requests can make at once.
 *
 * Four read-then-write sequences on the money path, each of which let two
 * concurrent requests both act on what only one of them should have:
 *
 *  - K: COUPON USAGE. placeOrder priced the basket (which checks
 *    `used_count < usage_limit`), created the order, and only then wrote
 *    `used_count + 1` from the count it had READ. Two checkouts with a
 *    one-use code both passed the check and both wrote 1 — the code was used
 *    twice and the counter said once. (S4.7)
 *
 *  - W: WEBHOOK EVENTS. applyVerifiedEvent checked the event id against the
 *    ledger it read, then wrote the payment status and the ledger. Two
 *    deliveries of one event both passed, and both recorded "captured" in the
 *    audit log. Worse, a FAILURE decided on a stale read wrote `failed` over
 *    a `paid` that had landed in between, and then cancelled — and released
 *    the stock of — an order that had been paid. (S4.9)
 *
 *  - F: REFUNDS. refundOrder wrote `[...refunds read earlier, new]`. Two
 *    partial refunds at once each wrote their own one-element array and the
 *    second erased the first: money went back to the buyer and the order
 *    forgot it. A double-clicked full refund was audited twice. (S4.10)
 *
 *  - H: THE PAYMENT HOLD SWEEP (new with S4.1) must not cancel an order whose
 *    payment lands between the sweep's read and its write — the same
 *    re-check the abandonment sweep makes (order-status-race S2).
 *
 *  - I: IDEMPOTENCY-KEY. POST /api/orders had none, so a client retry
 *    duplicated the order and its stock reservation. With the key, a retry
 *    that arrives while the first is still running must be told so (409),
 *    and one that arrives after must get the first answer back. (S4.4)
 *
 * ## How the races are made to happen
 *
 * As tests/order-status-race.test.mjs explains, concurrent requests do not
 * reliably overlap on a quiet machine, so every scenario FORCES the
 * interleaving: LocalDB's static methods are wrapped, and the interfering
 * request runs to completion immediately before the first request's
 * decisive write. The hook matches the write under the old code AND under
 * the fix (e.g. `createOrder` or `claimCouponUse`, whichever comes first), so
 * the same scenario runs against both. Every scenario proves its hook FIRED
 * first; one that never fired would make the rest vacuously true.
 *
 * All three drivers, each in its own child process and database.
 *
 * Run with:  node tests/checkout-race.test.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, loadTs } from './lib/load.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------------- child --- */

/**
 * Wrap LocalDB statics so `run` executes immediately before the first call
 * `match` accepts. Methods that do not exist yet (on the code before the
 * fix) are skipped, which is what lets one scenario describe both versions.
 */
function installHook(LocalDB) {
  let pending = null;
  let fired = 0;
  const names = [
    'getOrder', 'updateOrder', 'createOrder', 'updateCoupon', 'transitionOrderStatus',
    'claimCouponUse', 'claimPaymentEvent', 'appendRefund', 'claimIdempotencyKey',
  ];
  const originals = {};
  for (const name of names) {
    const original = LocalDB[name];
    if (typeof original !== 'function') continue;
    originals[name] = original;
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
    /** Make the next call `match` accepts throw, once. */
    failNext(match) {
      const at = fired;
      pending = { match, run: async () => { throw new Error('forced storage failure'); } };
      return () => fired > at;
    },
  };
}

const has = (o, k) => !!o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);

function fixtures(LocalDB) {
  let n = 0;
  return {
    product: (slug, stock) => LocalDB.createProduct({
      status: 'active', price_cents: 1000, categories: [], images: [], on_sale: false,
      name: slug, slug, stock, in_stock: stock > 0, requires_shipping: false,
    }),
    coupon: (code, over = {}) => LocalDB.createCoupon({
      code, kind: 'percent', value: 1000, enabled: true, used_count: 0, ...over,
    }),
    /** An order as checkout leaves it, holding its stock. */
    async order(productId, qty, over = {}) {
      const ok = await LocalDB.reserveStock(productId, qty);
      if (!ok) throw new Error('fixture could not reserve');
      n += 1;
      return LocalDB.createOrder({
        number: `CR-${process.pid}-${n}`, status: 'pending', payment_status: 'pending',
        email: `race${n}@example.com`, currency: 'EUR',
        items: [{ product_id: productId, name: 'Line', qty, total_cents: 1000 * qty }],
        subtotal_cents: 1000 * qty, total_cents: 1000 * qty, ...over,
      });
    },
    async stock(id) { return (await LocalDB.getProduct(id))?.stock; },
  };
}

const summary = (r) => (r?.ok
  ? { ok: true, status: r.value?.status ?? null, number: r.value?.number ?? null }
  : { ok: false, code: r?.status ?? null, errCode: r?.code ?? null, message: r?.message ?? null });

const verified = (orderId, outcome, eventId, amountCents, rawType = `race.${outcome}`) => ({
  eventId, reference: orderId, outcome, amountCents, currency: 'EUR', rawType,
});

async function auditCount(LocalDB, action, target) {
  await sleep(250); // recordAudit is fire-and-forget
  return (await LocalDB.getAuditEvents({ action })).filter((e) => e.target === target).length;
}

async function postOrderVia(M, body, headers = {}) {
  const res = await M.postOrder({
    request: new Request('http://localhost/api/orders', {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
    }),
    locals: { user: null, ip: '203.0.113.9' },
    url: new URL('http://localhost/api/orders'),
  });
  const json = await res.json().catch(() => null);
  return {
    code: res.status, number: json?.data?.number ?? null, errCode: json?.error?.reason ?? json?.error?.code ?? null,
    replayed: res.headers.get('idempotent-replayed'),
  };
}

async function child(M) {
  const { LocalDB, placeOrder, applyVerifiedEvent, refundOrder, registry } = M;
  const hook = installHook(LocalDB);
  const f = fixtures(LocalDB);
  const out = {};

  /* ---- K1: a one-use coupon, two checkouts, the second inside the first ---- */
  {
    const p = await f.product('k1', 10);
    const c = await f.coupon('RACEONE', { usage_limit: 1 });
    const place = (email) => placeOrder({ email, items: [{ product_id: p.id, qty: 1 }], coupon_code: 'raceone' });
    let second = null;
    const fired = hook.before(
      (name) => name === 'claimCouponUse' || name === 'createOrder',
      async () => { second = summary(await place('k1b@example.com')); },
    );
    const first = summary(await place('k1a@example.com'));
    hook.disarm();
    const orders = (await LocalDB.getOrders()).filter((o) => o.coupon_code === 'RACEONE');
    const coupon = (await LocalDB.getCoupons()).find((x) => x.id === c.id);
    out.k1 = {
      fired: fired(), first, second, withCoupon: orders.length,
      used: coupon?.used_count ?? null, stock: await f.stock(p.id),
    };
  }

  /* ---- K2: the claim is handed back when the order write fails ---- */
  {
    const p = await f.product('k2', 5);
    const c = await f.coupon('RACEBACK', { usage_limit: 3 });
    const fired = hook.failNext((name) => name === 'createOrder');
    let threw = false;
    try {
      await placeOrder({ email: 'k2@example.com', items: [{ product_id: p.id, qty: 2 }], coupon_code: 'RACEBACK' });
    } catch { threw = true; }
    hook.disarm();
    const coupon = (await LocalDB.getCoupons()).find((x) => x.id === c.id);
    out.k2 = { fired: fired(), threw, used: coupon?.used_count ?? null, stock: await f.stock(p.id) };
  }

  /* ---- K3: five at once against a two-use code (any interleaving) ---- */
  {
    const p = await f.product('k3', 20);
    const c = await f.coupon('RACETWO', { usage_limit: 2 });
    const res = await Promise.all(Array.from({ length: 5 }, (_, i) => placeOrder({
      email: `k3-${i}@example.com`, items: [{ product_id: p.id, qty: 1 }], coupon_code: 'RACETWO',
    })));
    const coupon = (await LocalDB.getCoupons()).find((x) => x.id === c.id);
    const withCoupon = (await LocalDB.getOrders()).filter((o) => o.coupon_code === 'RACETWO').length;
    out.k3 = {
      ok: res.filter((r) => r.ok).length, withCoupon, used: coupon?.used_count ?? null,
      stock: await f.stock(p.id),
    };
  }

  /* ---- W1: one success event, the second delivery inside the first ---- */
  {
    const p = await f.product('w1', 5);
    const o = await f.order(p.id, 2);
    const evt = verified(o.id, 'paid', `evt_w1_${o.id}`, o.total_cents);
    let second = null;
    const fired = hook.before(
      (name, args) => args[0] === o.id && (name === 'claimPaymentEvent' || (name === 'updateOrder' && has(args[1], 'payment_events'))),
      async () => { const r = await applyVerifiedEvent({ ...evt }); second = { applied: r.applied, action: r.decision.action }; },
    );
    const r1 = await applyVerifiedEvent(evt);
    hook.disarm();
    const after = await LocalDB.getOrder(o.id);
    out.w1 = {
      fired: fired(), first: { applied: r1.applied, action: r1.decision.action }, second,
      captured: await auditCount(LocalDB, 'payment.captured', o.id),
      ledger: (after?.payment_events ?? []).filter((e) => e === evt.eventId).length,
      final: after?.status, payment: after?.payment_status, stock: await f.stock(p.id),
    };
  }

  /* ---- W2: a failure decided before a success landed must not overwrite it ---- */
  {
    const p = await f.product('w2', 5);
    const o = await f.order(p.id, 2);
    let captured = null;
    const fired = hook.before(
      (name, args) => args[0] === o.id && (name === 'claimPaymentEvent' || (name === 'updateOrder' && has(args[1], 'payment_events'))),
      async () => { const r = await applyVerifiedEvent(verified(o.id, 'paid', `evt_w2p_${o.id}`, o.total_cents)); captured = r.applied; },
    );
    const r = await applyVerifiedEvent(verified(o.id, 'failed', `evt_w2f_${o.id}`, o.total_cents, 'checkout.session.expired'));
    hook.disarm();
    const after = await LocalDB.getOrder(o.id);
    out.w2 = {
      fired: fired(), captured, action: r.decision.action,
      final: after?.status, payment: after?.payment_status, stock: await f.stock(p.id),
    };
  }

  /* ---- W3: two DIFFERENT declined attempts, one inside the other, both counted ---- */
  {
    const p = await f.product('w3', 5);
    const o = await f.order(p.id, 1);
    const fired = hook.before(
      (name, args) => args[0] === o.id && (name === 'claimPaymentEvent' || name === 'updateOrder'),
      async () => { await applyVerifiedEvent(verified(o.id, 'declined', `evt_w3b_${o.id}`, o.total_cents, 'payment_intent.payment_failed')); },
    );
    await applyVerifiedEvent(verified(o.id, 'declined', `evt_w3a_${o.id}`, o.total_cents, 'payment_intent.payment_failed'));
    hook.disarm();
    const after = await LocalDB.getOrder(o.id);
    out.w3 = { fired: fired(), declines: after?.payment_declines ?? null, final: after?.status, stock: await f.stock(p.id) };
  }

  /* ---- W4: ONE declined attempt delivered twice, one inside the other ---- */
  // A decline leaves the payment status alone, so the status pin cannot tell
  // the two deliveries apart: the ledger check is the only guard.
  {
    const p = await f.product('w4', 5);
    const o = await f.order(p.id, 1);
    const evt = verified(o.id, 'declined', `evt_w4_${o.id}`, o.total_cents, 'payment_intent.payment_failed');
    let second = null;
    const fired = hook.before(
      (name, args) => args[0] === o.id && (name === 'claimPaymentEvent' || name === 'updateOrder'),
      async () => { const r = await applyVerifiedEvent({ ...evt }); second = r.applied; },
    );
    const first = await applyVerifiedEvent(evt);
    hook.disarm();
    const after = await LocalDB.getOrder(o.id);
    out.w4 = {
      fired: fired(), applied: [first.applied, second],
      declines: after?.payment_declines ?? null,
      ledger: (after?.payment_events ?? []).filter((e) => e === evt.eventId).length,
    };
  }

  /* ---- F: refunds through a stub provider that behaves like Stripe ---- */
  const issued = new Map();
  registry.setPluginProviders([{
    id: 'race-stub', label: 'Race stub', requiredEnv: [],
    createSession: async () => ({ reference: 'x', redirectUrl: 'https://example.invalid' }),
    verifyWebhook: async () => { throw new Error('unused'); },
    // Same idempotency key → the SAME refund, as every real provider does.
    refund: async (_order, amountCents, key) => {
      if (!issued.has(key)) issued.set(key, { refundId: `re_${issued.size + 1}`, amountCents });
      return issued.get(key);
    },
  }]);
  const paidOrder = async (tag) => {
    const p = await f.product(tag, 5);
    const o = await f.order(p.id, 2, { status: 'processing', payment_status: 'paid', payment_provider: 'race-stub', payment_reference: 'x' });
    return { p, o };
  };
  const refundWrite = (orderId) => (name, args) => args[0] === orderId
    && (name === 'appendRefund' || (name === 'updateOrder' && has(args[1], 'refunds')));

  /* F1: two different partial refunds, the second inside the first */
  {
    const { o } = await paidOrder('f1');
    let second = null;
    const fired = hook.before(refundWrite(o.id), async () => {
      const r = await refundOrder(o.id, 500, 'admin-b', 'http://localhost');
      second = { ok: r.ok, status: r.status };
    });
    const r1 = await refundOrder(o.id, 300, 'admin-a', 'http://localhost');
    hook.disarm();
    const after = await LocalDB.getOrder(o.id);
    out.f1 = {
      fired: fired(), first: { ok: r1.ok, status: r1.status }, second,
      recorded: (after?.refunds ?? []).map((x) => x.amount_cents).sort((a, b) => a - b),
      payment: after?.payment_status,
      issuedAudits: await auditCount(LocalDB, 'payment.refund.issued', o.id),
    };
  }

  /* F2: a double-clicked full refund — the provider returns the same refund twice */
  {
    const { p, o } = await paidOrder('f2');
    let second = null;
    const fired = hook.before(refundWrite(o.id), async () => {
      const r = await refundOrder(o.id, null, 'admin-b', 'http://localhost');
      second = { ok: r.ok, status: r.status };
    });
    const r1 = await refundOrder(o.id, null, 'admin-a', 'http://localhost');
    hook.disarm();
    const after = await LocalDB.getOrder(o.id);
    out.f2 = {
      fired: fired(), first: { ok: r1.ok, status: r1.status, remaining: r1.remainingCents }, second,
      records: (after?.refunds ?? []).length,
      payment: after?.payment_status, final: after?.status,
      issuedAudits: await auditCount(LocalDB, 'payment.refund.issued', o.id),
      stock: await f.stock(p.id),
    };
  }

  /* ---- H1: the payment lands while the hold sweep is cancelling ---- */
  // The sweep read its list while the order was unpaid; the success event
  // (claim, then the move to processing) runs to completion immediately
  // before the sweep's status write. The sweep must ask again and leave it.
  {
    const p = await f.product('h1', 5);
    const o = await f.order(p.id, 2, { payment_method: 'stripe', payment_status: 'unpaid' });
    let captured = null;
    const fired = hook.before(
      (name, args) => name === 'transitionOrderStatus' && args[0] === o.id,
      async () => {
        const r = await applyVerifiedEvent(verified(o.id, 'paid', `evt_h1_${o.id}`, o.total_cents));
        captured = r.applied;
      },
    );
    const swept = typeof M.scheduler.sweepPaymentHolds === 'function'
      ? await M.scheduler.sweepPaymentHolds(Date.now() + 5 * 3_600_000)
      : { expired: null };
    hook.disarm();
    const after = await LocalDB.getOrder(o.id);
    out.h1 = {
      fired: fired(), captured, expired: swept.expired,
      final: after?.status, payment: after?.payment_status, reason: after?.cancelled_reason ?? null,
      stock: await f.stock(p.id), audits: await auditCount(LocalDB, 'order.hold_expired', o.id),
    };
  }

  /* ---- I1: the same Idempotency-Key, the retry inside the first request ---- */
  {
    const p = await f.product('i1', 10);
    const body = { email: 'i1@example.com', items: [{ product_id: p.id, qty: 1 }] };
    const key = { 'idempotency-key': `race-${process.pid}-i1` };
    let second = null;
    const fired = hook.before(
      (name, args) => name === 'createOrder' && args[0]?.email === 'i1@example.com',
      async () => { second = await postOrderVia(M, body, key); },
    );
    const first = await postOrderVia(M, body, key);
    hook.disarm();
    const third = await postOrderVia(M, body, key);
    const count = (await LocalDB.getOrders()).filter((o) => o.email === 'i1@example.com').length;
    out.i1 = { fired: fired(), first, second, third, count, stock: await f.stock(p.id) };
  }

  return out;
}

if (process.env.CHECKOUT_RACE_CHILD) {
  const M = await loadTs('tests/fixtures/checkout-entry.ts', 'checkoutrace');
  await M.LocalDB.init();
  const result = await child(M);
  console.log('__RESULT__' + JSON.stringify(result));
  process.exit(0);
}

/* --------------------------------------------------------------- parent --- */
let pass = 0;
let fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };

const tmpRoot = path.join(os.tmpdir(), `astrobaas-checkout-race-${process.pid}`);
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
        ...process.env, CHECKOUT_RACE_CHILD: '1', NODE_ENV: 'test',
        AUTH_SECRET: 'checkout-race-secret-0123456789abcdef',
        STAGING: '', ASTROBAAS_STAGING: '', RATE_LIMIT_STORE: '', SITE_URL: '',
        UPLOADS_DIR: path.join(dir, 'uploads'), ...driver.env(dir),
      },
    });
    const line = (run.stdout || '').split('\n').find((l) => l.startsWith('__RESULT__'));
    if (!line) {
      fail++;
      console.error(`✗ [${driver.name}] child produced no result\n${(run.stderr || '').slice(-2000)}`);
      return null;
    }
    return JSON.parse(line.slice('__RESULT__'.length));
  });
}

for (const driver of DRIVERS) {
  const r = await runChild(driver);
  if (!r) continue;
  const t = (n, c) => check(`[${driver.name}] ${n}`, c);
  const j = JSON.stringify;

  for (const k of ['k1', 'k2', 'w1', 'w2', 'w3', 'w4', 'f1', 'f2', 'h1', 'i1']) {
    t(`${k}: the interfering request really ran inside the first`, r[k]?.fired === true);
  }

  // K1
  t(`K1: a one-use code is used by exactly one of two overlapping checkouts (with coupon=${r.k1.withCoupon}, first=${j(r.k1.first)}, second=${j(r.k1.second)})`,
    r.k1.withCoupon === 1 && [r.k1.first, r.k1.second].filter((x) => x?.ok).length === 1);
  t(`K1: ...and the counter says so (used_count=${r.k1.used})`, r.k1.used === 1);
  {
    const lost = [r.k1.first, r.k1.second].find((x) => x && !x.ok);
    t(`K1: ...the loser is refused as an invalid coupon, not a 500 (${j(lost)})`,
      lost?.code === 400 && lost?.errCode === 'checkout.coupon_invalid');
  }
  t(`K1: ...and the loser's stock was handed back (stock=${r.k1.stock}, expected 9)`, r.k1.stock === 9);

  // K2
  t(`K2: an order write that fails after the claim hands the use back (threw=${r.k2.threw}, used_count=${r.k2.used})`,
    r.k2.threw === true && r.k2.used === 0);
  t(`K2: ...and the stock (stock=${r.k2.stock}, expected 5)`, r.k2.stock === 5);

  // K3
  t(`K3: five checkouts at once never use a two-use code more than twice (with coupon=${r.k3.withCoupon}, used=${r.k3.used})`,
    r.k3.withCoupon <= 2 && r.k3.used === r.k3.withCoupon);
  t(`K3: ...every refused checkout returned its unit (stock=${r.k3.stock}, orders=${r.k3.ok})`,
    r.k3.stock === 20 - r.k3.ok);

  // W1
  t(`W1: one success event delivered twice is captured ONCE (payment.captured audits=${r.w1.captured})`, r.w1.captured === 1);
  t(`W1: ...the ledger holds the event once (${r.w1.ledger})`, r.w1.ledger === 1);
  t(`W1: ...exactly one delivery applied it (first=${j(r.w1.first)} second=${j(r.w1.second)})`,
    [r.w1.first, r.w1.second].filter((x) => x?.applied).length === 1);
  t(`W1: ...and the order is paid and open with its stock (final=${r.w1.final} payment=${r.w1.payment} stock=${r.w1.stock})`,
    r.w1.final === 'processing' && r.w1.payment === 'paid' && r.w1.stock === 3);

  // W2
  t(`W2: a failure decided before a success landed does not overwrite "paid" (payment=${r.w2.payment}, captured=${r.w2.captured})`,
    r.w2.captured === true && r.w2.payment === 'paid');
  t(`W2: ...nor cancel the paid order and release its stock (final=${r.w2.final}, stock=${r.w2.stock}, expected processing/3)`,
    r.w2.final === 'processing' && r.w2.stock === 3);
  t(`W2: ...the failure ends as "ignore" (${r.w2.action})`, r.w2.action === 'ignore');

  // W3
  t(`W3: two overlapping declined attempts are both counted (payment_declines=${r.w3.declines})`, r.w3.declines === 2);
  t(`W3: ...and neither cancels the order (final=${r.w3.final}, stock=${r.w3.stock})`, r.w3.final === 'pending' && r.w3.stock === 4);

  // W4
  t(`W4: one declined attempt delivered twice is counted ONCE (payment_declines=${r.w4.declines})`, r.w4.declines === 1);
  t(`W4: ...applied by exactly one delivery (${j(r.w4.applied)})`, r.w4.applied.filter(Boolean).length === 1);
  t(`W4: ...and in the ledger once (${r.w4.ledger})`, r.w4.ledger === 1);

  // F1
  t(`F1: two overlapping partial refunds are BOTH recorded (${j(r.f1.recorded)})`, j(r.f1.recorded) === j([300, 500]));
  t(`F1: ...both succeed (${j([r.f1.first, r.f1.second])})`, r.f1.first?.ok && r.f1.second?.ok);
  t(`F1: ...the order is still partly paid (payment=${r.f1.payment})`, r.f1.payment === 'paid');
  t(`F1: ...two refunds audited (${r.f1.issuedAudits})`, r.f1.issuedAudits === 2);

  // F2
  t(`F2: a double-clicked full refund is recorded ONCE (records=${r.f2.records})`, r.f2.records === 1);
  t(`F2: ...and audited ONCE (${r.f2.issuedAudits})`, r.f2.issuedAudits === 1);
  t(`F2: ...both clicks answer ok (${j([r.f2.first, r.f2.second])})`, r.f2.first?.ok && r.f2.second?.ok);
  t(`F2: ...the order is refunded and its stock returned once (payment=${r.f2.payment} final=${r.f2.final} stock=${r.f2.stock})`,
    r.f2.payment === 'refunded' && r.f2.final === 'refunded' && r.f2.stock === 5);

  // H1
  t(`H1: the payment really landed inside the hold sweep (captured=${r.h1.captured})`, r.h1.captured === true);
  t(`H1: the sweep does not cancel an order paid after it read its list (final=${r.h1.final} payment=${r.h1.payment} expired=${r.h1.expired})`,
    r.h1.final === 'processing' && r.h1.payment === 'paid' && r.h1.expired === 0);
  t(`H1: ...its stock stays held (stock=${r.h1.stock}, expected 3)`, r.h1.stock === 3);
  t(`H1: ...and nothing records a hold expiry (reason=${r.h1.reason}, audits=${r.h1.audits})`,
    r.h1.reason === null && r.h1.audits === 0);

  // I1
  t(`I1: the first request with an Idempotency-Key places the order (${j(r.i1.first)})`,
    r.i1.first.code === 201 && !!r.i1.first.number);
  t(`I1: a retry arriving while the first is still running is told so, not served a second order (${j(r.i1.second)})`,
    r.i1.second?.code === 409 && r.i1.second?.errCode === 'IDEMPOTENCY_IN_PROGRESS');
  t(`I1: a retry after it finished gets the SAME order back (${j(r.i1.third)})`,
    r.i1.third.code === 201 && r.i1.third.number === r.i1.first.number && r.i1.third.replayed === 'true');
  t(`I1: ...one order, one reservation (orders=${r.i1.count}, stock=${r.i1.stock}, expected 1/9)`,
    r.i1.count === 1 && r.i1.stock === 9);
}

await fs.rm(tmpRoot, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
