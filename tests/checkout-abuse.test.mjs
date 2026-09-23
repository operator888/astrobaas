#!/usr/bin/env node
/**
 * Checkout and payment abuse controls (hardening step 4).
 *
 * Each block names the register item it covers. The pure half runs in this
 * process; everything that needs storage runs once per driver in a child
 * process with its own database, through the REAL routes where the answer a
 * storefront sees is the contract.
 *
 *  S4.1  unpaid-order cap per buyer (email, and hashed IP), and the short
 *        payment hold for online methods, consistent with Stripe's session
 *        expiry
 *  S4.2  a declined card is an ATTEMPT, not the end of the order
 *  S4.3  a payment that lands on a cancelled order re-reserves or is flagged
 *  S4.4  Idempotency-Key replays, mismatches and releases
 *  S4.5  proof-of-work on checkout and magic-link
 *  S4.6  coupon rejection reasons are not an oracle for strangers
 *  S4.8  checkout email validation and the per-recipient confirmation cap
 *  S4.11 PayPal's OAuth token is reused until it expires
 *  S4.12 forged webhooks are throttled before any outbound call, and their
 *        audit entries aggregated
 *  S4.13 payment return URLs come from the configured site, and the start
 *        route looks the order up by number
 *  S4.14 risk velocity is not truncated by a busy half hour
 *  S4.15 an opt-in risk hold places a high-risk order ON HOLD
 *
 * The race-shaped items (S4.4 concurrency, S4.7, S4.9, S4.10) are in
 * tests/checkout-race.test.mjs.
 *
 * Run with:  node tests/checkout-abuse.test.mjs
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, loadTs } from './lib/load.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SECRET = 'checkout-abuse-secret-0123456789abcdef';

/* ---------------------------------------------------------------- child --- */

/** Solve a proof-of-work challenge the way /captcha.js does. */
function solvePow(token, bits) {
  for (let n = 0; n < 5_000_000; n++) {
    const d = crypto.createHash('sha256').update(`${token}.${n}`).digest();
    let remaining = bits;
    let okBits = true;
    for (let i = 0; i < d.length && remaining > 0; i++) {
      const take = Math.min(8, remaining);
      if (d[i] >>> (8 - take) !== 0) { okBits = false; break; }
      remaining -= take;
    }
    if (okBits) return `${token}::${n}`;
  }
  return null;
}

async function child(M) {
  const { LocalDB } = M;
  const out = {};
  const guard = async (key, fn) => {
    try { out[key] = await fn(); } catch (err) { out[key] = { error: String(err?.stack || err).slice(0, 400) }; }
  };
  let seq = 0;
  const product = (slug, stock) => LocalDB.createProduct({
    status: 'active', price_cents: 1000, categories: [], images: [], on_sale: false,
    name: slug, slug: `${slug}-${++seq}`, stock, in_stock: stock > 0, requires_shipping: false,
  });
  const stockOf = async (id) => (await LocalDB.getProduct(id))?.stock;
  const setting = (k, v) => LocalDB.updateSetting(k, v);
  // Every call from its own address unless a scenario says otherwise, so the
  // per-IP unpaid cap in one scenario cannot refuse another's orders.
  let ipSeq = 0;
  const nextIp = () => `100.64.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`;

  const call = async (handler, { url = 'http://localhost/api/x', body, headers = {}, locals = {}, params = {}, raw, site } = {}) => {
    const res = await handler({
      request: new Request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: raw !== undefined ? raw : JSON.stringify(body ?? {}),
      }),
      locals: { user: null, ip: nextIp(), ...locals },
      url: new URL(url),
      params,
      site,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return {
      code: res.status, json, text: json ? undefined : text,
      data: json?.data, errCode: json?.error?.reason ?? json?.error?.code ?? null, message: json?.error?.message ?? null,
      headers: Object.fromEntries(res.headers),
    };
  };
  const order = (body, opts = {}) => call(M.postOrder, { url: 'http://localhost/api/orders', body, ...opts });
  const staff = { user: { id: 'staff-1', role: 'admin' } };
  const apiKey = { user: { id: 'apikey:k1', role: 'editor' } };

  /* ---------------- S4.1 the unpaid-order cap ---------------- */
  await guard('cap', async () => {
    const p = await product('cap', 100);
    const item = [{ product_id: p.id, qty: 1 }];
    const r = {};
    // Five from one email, each from a different address: the email is capped.
    r.email = [];
    for (let i = 0; i < 6; i++) {
      r.email.push((await order({ email: 'Cap.Buyer@Example.com', items: item }, { locals: { ip: `192.0.2.${10 + i}` } })));
    }
    r.email = r.email.map((x) => ({ code: x.code, errCode: x.errCode, retry: x.headers['retry-after'] ?? null }));
    // The same buyer, differently capitalised, is the same buyer.
    r.emailCase = (await order({ email: 'cap.buyer@example.com', items: item }, { locals: { ip: '192.0.2.99' } })).code;
    // A cancelled one no longer counts.
    const mine = (await LocalDB.getOrders()).filter((o) => o.email.toLowerCase() === 'cap.buyer@example.com');
    await M.setOrderStatus(mine[0].id, 'cancelled', 'test');
    r.afterCancel = (await order({ email: 'cap.buyer@example.com', items: item }, { locals: { ip: '192.0.2.98' } })).code;
    // Nor does a paid one.
    const mine2 = (await LocalDB.getOrders()).filter((o) => o.email.toLowerCase() === 'cap.buyer@example.com' && o.status === 'pending');
    await LocalDB.updateOrder(mine2[0].id, { payment_status: 'paid' });
    r.afterPaid = (await order({ email: 'cap.buyer@example.com', items: item }, { locals: { ip: '192.0.2.97' } })).code;
    // Five emails from one network: the address is capped.
    r.ip = [];
    for (let i = 0; i < 6; i++) {
      r.ip.push((await order({ email: `net${i}@example.com`, items: item }, { locals: { ip: '198.51.100.77' } })).code);
    }
    const ipBlocked = await order({ email: 'net-last@example.com', items: item }, { locals: { ip: '198.51.100.77' } });
    r.ipErr = ipBlocked.errCode;
    // Loopback and private addresses are a proxy or a container, not a shopper:
    // many emails from one of them are never refused by address.
    r.loopback = [];
    for (let i = 0; i < 7; i++) {
      r.loopback.push((await order({ email: `lo${i}@example.com`, items: item }, { locals: { ip: '127.0.0.1' } })).code);
    }
    r.private = [];
    for (let i = 0; i < 7; i++) {
      r.private.push((await order({ email: `pv${i}@example.com`, items: item }, { locals: { ip: '10.0.0.5' } })).code);
    }
    // ...but the email cap still applies to a buyer behind one.
    r.loopbackEmail = [];
    for (let i = 0; i < 6; i++) {
      r.loopbackEmail.push((await order({ email: 'lo-same@example.com', items: item }, { locals: { ip: '127.0.0.1' } })).code);
    }
    // The per-address window is the hold: five open orders from one address,
    // three hours old, no longer refuse the next buyer there.
    for (let i = 0; i < 5; i++) {
      await order({ email: `old${i}@example.com`, items: item }, { locals: { ip: '198.51.100.88' } });
    }
    for (const o of (await LocalDB.getOrders()).filter((x) => /^old\d@example\.com$/.test(x.email))) {
      await LocalDB.updateOrder(o.id, { created_at: new Date(Date.now() - 3 * 3_600_000).toISOString() });
    }
    r.afterWindow = (await order({ email: 'fresh@example.com', items: item }, { locals: { ip: '198.51.100.88' } })).code;
    // Staff placing phone orders are not capped.
    r.staff = [];
    for (let i = 0; i < 7; i++) {
      r.staff.push((await order({ email: 'phone@example.com', items: item }, { locals: { ...staff, ip: '198.51.100.5' } })).code);
    }
    // An API key (a storefront's server): every shopper shares its address,
    // so the IP cap does not apply — the email cap does. A ROUTABLE address,
    // so it is the caller type that exempts it, not the address.
    r.keyIp = [];
    for (let i = 0; i < 7; i++) {
      r.keyIp.push((await order({ email: `bff${i}@example.com`, items: item }, { locals: { ...apiKey, ip: '198.51.100.150' } })).code);
    }
    r.keyEmail = [];
    for (let i = 0; i < 6; i++) {
      r.keyEmail.push((await order({ email: 'bff-same@example.com', items: item }, { locals: { ...apiKey, ip: '198.51.100.150' } })).code);
    }
    // Off switch.
    await setting('orders_max_unpaid_per_buyer', 0);
    r.off = [];
    for (let i = 0; i < 7; i++) {
      r.off.push((await order({ email: 'nocap@example.com', items: item }, { locals: { ip: '198.51.100.200' } })).code);
    }
    await setting('orders_max_unpaid_per_buyer', 5);
    r.stock = await stockOf(p.id);
    // Orders still holding a unit: the cancelled one handed its unit back.
    r.orders = (await LocalDB.getOrders())
      .filter((o) => o.items?.[0]?.product_id === p.id && o.status !== 'cancelled').length;
    return r;
  });

  /* ---------------- S4.1 the payment hold ---------------- */
  await guard('hold', async () => {
    const r = {};
    const p = await product('hold', 20);
    const mk = async (over) => {
      await LocalDB.reserveStock(p.id, 1);
      return LocalDB.createOrder({
        number: `HOLD-${++seq}`, status: 'pending', payment_status: 'unpaid', email: `h${seq}@example.com`,
        currency: 'EUR', items: [{ product_id: p.id, name: 'x', qty: 1, total_cents: 1000 }],
        total_cents: 1000, payment_method: 'stripe', ...over,
      });
    };
    const online = await mk({});
    const onlinePending = await mk({ payment_status: 'pending', payment_provider: 'stripe' });
    const paid = await mk({ payment_status: 'paid', status: 'processing' });
    const manual = await mk({ payment_method: 'bank-transfer' });
    const cod = await mk({ payment_method: 'cod' });
    const lateSession = await mk({
      payment_status: 'pending', payment_provider: 'stripe',
      payment_expires_at: new Date(Date.now() + 6 * 3_600_000).toISOString(),
    });
    const riskHeld = await mk({ status: 'on-hold', risk_held: true });
    const imported = await mk({ wp_id: '77' });
    r.fn = typeof M.scheduler.sweepPaymentHolds;
    if (r.fn !== 'function') return r;
    const before = await stockOf(p.id);
    // Not yet: an hour in, under the 120-minute default.
    r.early = (await M.scheduler.sweepPaymentHolds(Date.now() + 60 * 60_000)).expired;
    const res = await M.scheduler.sweepPaymentHolds(Date.now() + 3 * 3_600_000);
    r.expired = res.expired;
    const st = async (o) => { const x = await LocalDB.getOrder(o.id); return `${x.status}/${x.cancelled_reason ?? '-'}`; };
    r.states = {
      online: await st(online), onlinePending: await st(onlinePending), paid: await st(paid),
      manual: await st(manual), cod: await st(cod), lateSession: await st(lateSession),
      riskHeld: await st(riskHeld), imported: await st(imported),
    };
    r.released = (await stockOf(p.id)) - before;
    // A second sweep finds nothing and releases nothing.
    r.again = (await M.scheduler.sweepPaymentHolds(Date.now() + 3 * 3_600_000)).expired;
    r.releasedAfterAgain = (await stockOf(p.id)) - before;
    // The late session's own deadline, plus grace, does expire it.
    r.lateExpired = (await M.scheduler.sweepPaymentHolds(Date.now() + 7 * 3_600_000)).expired;
    // Hold off (0): an online order is left to the day-based sweep.
    await setting('orders_payment_hold_minutes', 0);
    const offOrder = await mk({});
    r.offExpired = (await M.scheduler.sweepPaymentHolds(Date.now() + 5 * 3_600_000)).expired;
    r.offState = await st(offOrder);
    await setting('orders_payment_hold_minutes', 120);
    r.audits = (await (async () => { await sleep(250); return (await LocalDB.getAuditEvents({ action: 'order.hold_expired' })).length; })());
    return r;
  });

  /* ---------------- S4.1 / S4.13 starting a payment ---------------- */
  await guard('start', async () => {
    const r = {};
    const seen = [];
    M.registry.setPluginProviders([{
      id: 'hold-stub', label: 'Hold stub', requiredEnv: [],
      createSession: async (o, ctx) => {
        seen.push({ siteUrl: ctx.siteUrl, holdUntil: ctx.holdUntil ?? null, created: o.created_at });
        return { reference: `ref-${o.id}`, redirectUrl: 'https://pay.example.com/x', expiresAt: new Date(Date.now() + 45 * 60_000).toISOString() };
      },
      verifyWebhook: async () => { throw new Error('unused'); },
    }]);
    const p = await product('start', 10);
    const placed = await order({ email: 'start@example.com', items: [{ product_id: p.id, qty: 1 }], payment_method: 'hold-stub' });
    r.placed = placed.code;
    const number = placed.data?.number;
    await setting('site_url', 'https://shop.example.com/');
    let listCalls = 0;
    const realGetOrders = LocalDB.getOrders;
    LocalDB.getOrders = async (...a) => { listCalls += 1; return realGetOrders.apply(LocalDB, a); };
    const started = await call(M.postPaymentStart, {
      url: 'http://attacker-host.example/api/payments/start',
      body: { order_number: number, email: 'START@example.com', provider: 'hold-stub' },
    });
    LocalDB.getOrders = realGetOrders;
    r.started = started.code;
    r.listCalls = listCalls;
    r.siteUrl = seen[0]?.siteUrl ?? null;
    const o = (await LocalDB.getOrders()).find((x) => x.number === number);
    r.holdUntil = seen[0]?.holdUntil != null ? seen[0].holdUntil - Date.parse(o.created_at) : null;
    r.expiresStored = typeof o?.payment_expires_at === 'string';
    // Without a configured site, the request's own origin is the fallback.
    await setting('site_url', '');
    await call(M.postPaymentStart, {
      url: 'http://cms.example.net/api/payments/start',
      body: { order_number: number, email: 'start@example.com', provider: 'hold-stub' },
    });
    r.fallbackSiteUrl = seen[1]?.siteUrl ?? null;
    // Past the hold, no new session is opened for an order about to be swept.
    await LocalDB.updateOrder(o.id, { created_at: new Date(Date.now() - 3 * 3_600_000).toISOString(), payment_expires_at: undefined });
    const late = await call(M.postPaymentStart, {
      url: 'http://cms.example.net/api/payments/start',
      body: { order_number: number, email: 'start@example.com', provider: 'hold-stub' },
    });
    r.late = { code: late.code, errCode: late.errCode, sessions: seen.length };
    // An unknown number and a wrong email get the same answer.
    const wrong = await call(M.postPaymentStart, { body: { order_number: number, email: 'x@example.com', provider: 'hold-stub' } });
    const missing = await call(M.postPaymentStart, { body: { order_number: 'OG-999999', email: 'start@example.com', provider: 'hold-stub' } });
    r.oracle = [wrong.code, missing.code, wrong.message === missing.message];
    return r;
  });

  /* ---------------- S4.2 a declined attempt ---------------- */
  await guard('decline', async () => {
    const p = await product('decline', 5);
    await LocalDB.reserveStock(p.id, 2);
    const o = await LocalDB.createOrder({
      number: `DEC-${++seq}`, status: 'pending', payment_status: 'pending', email: 'd@example.com', currency: 'EUR',
      items: [{ product_id: p.id, name: 'x', qty: 2, total_cents: 2000 }], total_cents: 2000,
      payment_method: 'stripe', payment_provider: 'stripe',
    });
    const evt = (i) => ({ eventId: `evt_dec_${o.id}_${i}`, reference: o.id, outcome: 'declined', amountCents: 2000, currency: 'EUR', rawType: 'payment_intent.payment_failed' });
    const first = await M.applyVerifiedEvent(evt(1));
    const a = await LocalDB.getOrder(o.id);
    const r = {
      action: first.decision.action, status: a.status, payment: a.payment_status,
      declines: a.payment_declines ?? null, stock: await stockOf(p.id),
    };
    for (let i = 2; i <= 5; i++) await M.applyVerifiedEvent(evt(i));
    // A replay of one already counted is not a sixth.
    await M.applyVerifiedEvent(evt(5));
    const b = await LocalDB.getOrder(o.id);
    r.after5 = { declines: b.payment_declines ?? null, flagged: b.risk_flagged === true, signals: b.risk_signals ?? [], status: b.status };
    // The session expiring is still the end.
    await M.applyVerifiedEvent({ ...evt(9), outcome: 'failed', rawType: 'checkout.session.expired' });
    const c = await LocalDB.getOrder(o.id);
    r.expired = { status: c.status, payment: c.payment_status, stock: await stockOf(p.id) };
    return r;
  });

  /* ---------------- S4.3 success after a cancellation ---------------- */
  await guard('late', async () => {
    const r = {};
    await setting('admin_email', 'owner@example.com');
    const mk = async (p, qty) => {
      await LocalDB.reserveStock(p.id, qty);
      return LocalDB.createOrder({
        number: `LATE-${++seq}`, status: 'pending', payment_status: 'pending', email: `l${seq}@example.com`, currency: 'EUR',
        items: [{ product_id: p.id, name: 'Late line', qty, total_cents: 1000 * qty }], total_cents: 1000 * qty,
        payment_method: 'stripe', payment_provider: 'stripe', payment_reference: 'cs_x',
      });
    };
    const paidEvt = (o) => ({ eventId: `evt_late_${o.id}`, reference: o.id, outcome: 'paid', amountCents: o.total_cents, currency: 'EUR', rawType: 'checkout.session.completed' });

    // (a) the stock is still there: the order is reopened and holds it again.
    const pa = await product('late-a', 3);
    const oa = await mk(pa, 2);
    await M.setOrderStatus(oa.id, 'cancelled', 'system:hold');
    const beforeA = await stockOf(pa.id);
    await M.applyVerifiedEvent(paidEvt(oa));
    const aa = await LocalDB.getOrder(oa.id);
    r.a = { before: beforeA, stock: await stockOf(pa.id), status: aa.status, payment: aa.payment_status, flag: aa.needs_refund ?? null };

    // (b) the stock went to someone else: paid, still cancelled, flagged.
    const pb = await product('late-b', 2);
    const ob = await mk(pb, 2);
    await M.setOrderStatus(ob.id, 'cancelled', 'system:hold');
    await LocalDB.reserveStock(pb.id, 2); // another buyer took both
    const ownerMails = async () => (await LocalDB.getEmailLog(2000)).filter((m) => String(m.to).includes('owner@example.com')).length;
    const mailsBefore = await ownerMails();
    const res = await M.applyVerifiedEvent(paidEvt(ob));
    await sleep(400);
    const bb = await LocalDB.getOrder(ob.id);
    r.b = {
      applied: res.applied, stock: await stockOf(pb.id), status: bb.status, payment: bb.payment_status,
      flag: bb.needs_refund ?? null,
      audits: (await LocalDB.getAuditEvents({ action: 'payment.needs_refund' })).filter((e) => e.target === ob.id).length,
      ownerMailed: (await ownerMails()) > mailsBefore,
    };
    // A replay of the same success changes nothing and flags nothing twice.
    await M.applyVerifiedEvent(paidEvt(ob));
    await sleep(250);
    r.b.auditsAfterReplay = (await LocalDB.getAuditEvents({ action: 'payment.needs_refund' })).filter((e) => e.target === ob.id).length;
    return r;
  });

  /* ---------------- S4.4 Idempotency-Key ---------------- */
  await guard('idem', async () => {
    const r = {};
    const p = await product('idem', 3);
    const body = { email: 'idem@example.com', items: [{ product_id: p.id, qty: 1 }] };
    const k = (key) => ({ headers: { 'Idempotency-Key': key } });
    const a = await order(body, k('idem-key-1'));
    const b = await order({ ...body, pow_token: 'ignored-in-fingerprint' }, k('idem-key-1'));
    r.first = { code: a.code, number: a.data?.number };
    r.replay = { code: b.code, number: b.data?.number, replayed: b.headers['idempotent-replayed'] ?? null, same: JSON.stringify(a.data) === JSON.stringify(b.data) };
    // The same key with a different body is a client bug, said plainly.
    const c = await order({ ...body, items: [{ product_id: p.id, qty: 2 }] }, k('idem-key-1'));
    r.mismatch = { code: c.code, errCode: c.errCode };
    // Keys are per caller: a staff member reusing a shopper's key is not a replay.
    const s = await order({ ...body, email: 'idem-staff@example.com' }, { ...k('idem-key-1'), locals: staff });
    r.otherCaller = s.code;
    // A malformed key is refused before anything happens.
    const bad = await order(body, k('x'.repeat(300)));
    r.badKey = { code: bad.code, errCode: bad.errCode };
    // A refusal does not burn the key: fix the basket's cause, retry, succeed.
    const q = await order({ email: 'idem2@example.com', items: [{ product_id: p.id, qty: 3 }] }, k('idem-key-2'));
    await LocalDB.releaseStock(p.id, 5);
    const q2 = await order({ email: 'idem2@example.com', items: [{ product_id: p.id, qty: 3 }] }, k('idem-key-2'));
    r.retryAfterRefusal = [q.code, q2.code];
    r.count = (await LocalDB.getOrders()).filter((o) => o.email === 'idem@example.com').length;
    // No key: behaves exactly as before.
    const n1 = await order({ email: 'nokey@example.com', items: [{ product_id: p.id, qty: 1 }] });
    const n2 = await order({ email: 'nokey@example.com', items: [{ product_id: p.id, qty: 1 }] });
    r.noKey = [n1.code, n2.code, n1.data?.number !== n2.data?.number];
    return r;
  });

  /* ---------------- S4.5 proof-of-work surfaces ---------------- */
  await guard('pow', async () => {
    const r = {};
    r.surfaces = [...(M.captcha.CAPTCHA_SURFACES ?? [])];
    const p = await product('pow', 10);
    const body = { email: 'pow@example.com', items: [{ product_id: p.id, qty: 1 }] };
    // Off by default: nothing changes for a storefront that sends no token.
    r.offByDefault = (await order(body, { locals: { ip: '203.0.113.50' } })).code;
    await setting('captcha_surfaces', ['checkout', 'magic-link']);
    const missing = await order({ ...body, email: 'pow2@example.com' }, { locals: { ip: '203.0.113.51' } });
    r.missing = { code: missing.code, errCode: missing.errCode };
    let token = null;
    if (r.surfaces.includes('checkout')) {
      const ch = M.captcha.makeChallenge('checkout');
      token = solvePow(ch.token, ch.bits);
    }
    const solved = await order({ ...body, email: 'pow3@example.com', pow_token: token }, { locals: { ip: '203.0.113.52' } });
    r.solved = solved.code;
    const replay = await order({ ...body, email: 'pow4@example.com', pow_token: token }, { locals: { ip: '203.0.113.53' } });
    r.replay = replay.code;
    // A login-surface proof does not open checkout.
    const loginCh = M.captcha.makeChallenge('login');
    const wrongSurface = await order({ ...body, email: 'pow5@example.com', pow_token: solvePow(loginCh.token, loginCh.bits) }, { locals: { ip: '203.0.113.54' } });
    r.wrongSurface = wrongSurface.code;
    // Staff and API keys are not asked to burn CPU.
    r.staff = (await order({ ...body, email: 'pow6@example.com' }, { locals: staff })).code;
    r.key = (await order({ ...body, email: 'pow7@example.com' }, { locals: apiKey })).code;
    // magic-link: JSON and form posts.
    const ml = await call(M.postMagicLink, { url: 'http://localhost/api/auth/magic-link', body: { email: 'someone@example.com' } });
    r.magicMissing = ml.code;
    const mlForm = await call(M.postMagicLink, {
      url: 'http://localhost/api/auth/magic-link', raw: 'email=someone%40example.com',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    r.magicFormMissing = { code: mlForm.code, location: mlForm.headers.location ?? null };
    let mlToken = null;
    if (r.surfaces.includes('magic-link')) {
      const c = M.captcha.makeChallenge('magic-link');
      mlToken = solvePow(c.token, c.bits);
    }
    r.magicSolved = (await call(M.postMagicLink, { url: 'http://localhost/api/auth/magic-link', body: { email: 'someone@example.com', pow_token: mlToken } })).code;
    await setting('captcha_surfaces', []);
    r.magicOff = (await call(M.postMagicLink, { url: 'http://localhost/api/auth/magic-link', body: { email: 'someone@example.com' } })).code;
    return r;
  });

  /* ---------------- S4.6 coupon reasons ---------------- */
  await guard('coupon', async () => {
    const r = {};
    const p = await product('cpn', 50);
    await LocalDB.createCoupon({ code: 'OLDCODE', kind: 'percent', value: 1000, enabled: true, used_count: 0, ends_at: '2020-01-01T00:00:00Z' });
    await LocalDB.createCoupon({ code: 'BIGSPEND', kind: 'fixed', value: 500, enabled: true, used_count: 0, min_subtotal_cents: 100000 });
    await LocalDB.createCoupon({ code: 'SPENT', kind: 'fixed', value: 500, enabled: true, used_count: 3, usage_limit: 3 });
    const quote = (code, locals = {}) => call(M.postQuote, {
      url: 'http://localhost/api/orders/quote', body: { items: [{ product_id: p.id, qty: 1 }], coupon_code: code }, locals,
    });
    const view = (x) => x.data?.coupon ?? null;
    r.anonExpired = view(await quote('OLDCODE'));
    r.anonSpent = view(await quote('SPENT'));
    r.anonMissing = view(await quote('NOPE'));
    r.anonMinimum = view(await quote('BIGSPEND'));
    r.staffExpired = view(await quote('OLDCODE', staff));
    r.keyExpired = view(await quote('OLDCODE', apiKey));
    const anonOrder = await order({ email: 'cpn@example.com', items: [{ product_id: p.id, qty: 1 }], coupon_code: 'SPENT' });
    r.anonOrder = { code: anonOrder.code, errCode: anonOrder.errCode, message: anonOrder.message, params: anonOrder.json?.error?.params ?? null };
    const anonMinOrder = await order({ email: 'cpn2@example.com', items: [{ product_id: p.id, qty: 1 }], coupon_code: 'BIGSPEND' });
    r.anonMinOrder = { code: anonMinOrder.code, message: anonMinOrder.message, params: anonMinOrder.json?.error?.params ?? null };
    const staffOrder = await order({ email: 'cpn3@example.com', items: [{ product_id: p.id, qty: 1 }], coupon_code: 'SPENT' }, { locals: staff });
    r.staffOrder = { code: staffOrder.code, message: staffOrder.message };
    r.stock = await stockOf(p.id);
    return r;
  });

  /* ---------------- S4.8 email ---------------- */
  await guard('email', async () => {
    const r = {};
    const p = await product('mail', 50);
    const item = [{ product_id: p.id, qty: 1 }];
    const bad = ['not an email a@b.co', 'a@b.co\r\nBcc: victim@example.com', '<a@b.co>', 'a@b', '@b.co', 'a@@b.co'];
    r.bad = [];
    for (const e of bad) r.bad.push((await order({ email: e, items: item }, { locals: staff })).code);
    const good = ['buyer@example.com', 'first.last+tag@sub.example.gr', 'όνομα@παράδειγμα.ελ', 'x@xn--qxam.xn--qxam'];
    r.good = [];
    for (const e of good) r.good.push((await order({ email: e, items: item }, { locals: staff })).code);
    // Eight orders to one inbox: the inbox hears about at most five per hour.
    for (let i = 0; i < 8; i++) await order({ email: 'Flooded@Example.com', items: item }, { locals: staff });
    await sleep(600);
    r.confirmations = (await LocalDB.getEmailLog(1000)).filter((m) => String(m.to).toLowerCase() === 'flooded@example.com').length;
    r.placed = (await LocalDB.getOrders()).filter((o) => o.email.toLowerCase() === 'flooded@example.com').length;
    return r;
  });

  /* ---------------- S4.12 forged webhooks ---------------- */
  await guard('webhook', async () => {
    const r = {};
    let outbound = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      outbound += 1;
      if (String(url).includes('/v1/oauth2/token')) {
        return new Response(JSON.stringify({ access_token: 'tok', expires_in: 32400 }), { status: 200 });
      }
      return new Response(JSON.stringify({ verification_status: 'FAILURE' }), { status: 200 });
    };
    const forge = (ip) => call(M.postWebhook, {
      url: 'http://localhost/api/payments/webhook/paypal',
      params: { provider: 'paypal' },
      raw: JSON.stringify({ id: 'WH-1', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'X' } }),
      headers: { 'paypal-cert-url': 'https://api.paypal.com/cert.pem', 'paypal-transmission-id': 't' },
      locals: { ip },
    });
    try {
      const codes = [];
      let outboundAt20 = 0;
      for (let i = 0; i < 26; i++) {
        codes.push((await forge('203.0.113.66')).code);
        if (i === 19) outboundAt20 = outbound;
      }
      r.codes = codes;
      r.outboundAfterBlock = outbound - outboundAt20;
      r.retryAfter = (await forge('203.0.113.66')).headers['retry-after'] ?? null;
      r.otherIp = (await forge('203.0.113.67')).code;
      const loopbackCodes = [];
      for (let i = 0; i < 25; i++) loopbackCodes.push((await forge('127.0.0.1')).code);
      r.loopbackCodes = loopbackCodes;
      await sleep(300);
      const audits = (await LocalDB.getAuditEvents({ action: 'payment.webhook.invalid' }));
      const mine = audits.filter((e) => e.ip === '203.0.113.66');
      r.audits = mine.length;
      r.throttleAudit = mine.find((e) => e.metadata?.throttled === true)?.metadata ?? null;
      r.loopbackAudits = audits.filter((e) => e.ip === '127.0.0.1').length;
      r.auditsTotal = audits.length;
      r.tokenCalls = null;
    } finally {
      globalThis.fetch = realFetch;
    }
    return r;
  });

  /* ---------------- S4.14 velocity over a busy half hour ---------------- */
  const velocitySetup = async (tag) => {
    const ip = `198.18.0.${++seq % 250}`;
    const ipHash = M.orderRisk.hashIp(ip, SECRET);
    const email = `${tag}-velocity@example.com`;
    for (let i = 0; i < 3; i++) {
      await LocalDB.createOrder({
        number: `V-${tag}-${i}`, status: 'pending', payment_status: 'paid', email, ip_hash: ipHash,
        currency: 'EUR', items: [], total_cents: 1000,
      });
    }
    for (let i = 0; i < 210; i++) {
      await LocalDB.createOrder({
        number: `V-${tag}-other-${i}`, status: 'completed', payment_status: 'paid', email: `other${i}@example.com`,
        currency: 'EUR', items: [], total_cents: 1000,
      });
    }
    return { ip, email };
  };
  await guard('velocity', async () => {
    const { ip, email } = await velocitySetup('vel');
    const p = await product('vel', 10);
    const placed = await order({ email, items: [{ product_id: p.id, qty: 1 }] }, { locals: { ...staff, ip } });
    const o = (await LocalDB.getOrders()).find((x) => x.number === placed.data?.number);
    return { code: placed.code, signals: o?.risk_signals ?? [], flagged: o?.risk_flagged === true, status: o?.status };
  });

  /* ---------------- S4.15 risk hold ---------------- */
  await guard('riskHold', async () => {
    await setting('orders_risk_hold_enabled', true);
    const { ip, email } = await velocitySetup('rh');
    const p = await product('rh', 10);
    const placed = await order({ email, items: [{ product_id: p.id, qty: 1 }], payment_method: 'stripe' }, { locals: { ...staff, ip } });
    const o = (await LocalDB.getOrders()).find((x) => x.number === placed.data?.number);
    const r = {
      code: placed.code, bodyStatus: placed.data?.status ?? null, status: o?.status, held: o?.risk_held === true,
      stock: await stockOf(p.id),
    };
    // Paying does not skip the review.
    if (o) {
      await M.applyVerifiedEvent({ eventId: `evt_rh_${o.id}`, reference: o.id, outcome: 'paid', amountCents: o.total_cents, currency: o.currency, rawType: 'checkout.session.completed' });
      const after = await LocalDB.getOrder(o.id);
      r.afterPay = { status: after.status, payment: after.payment_status };
    }
    // An ordinary order is untouched by the switch.
    const plain = await order({ email: 'plain-rh@example.com', items: [{ product_id: p.id, qty: 1 }] }, { locals: { ip: '198.19.0.1' } });
    r.plain = plain.data?.status ?? null;
    await setting('orders_risk_hold_enabled', false);
    const { ip: ip2, email: email2 } = await velocitySetup('rh2');
    const off = await order({ email: email2, items: [{ product_id: p.id, qty: 1 }] }, { locals: { ...staff, ip: ip2 } });
    const o2 = (await LocalDB.getOrders()).find((x) => x.number === off.data?.number);
    r.off = { status: o2?.status, flagged: o2?.risk_flagged === true };
    return r;
  });

  return out;
}

if (process.env.CHECKOUT_ABUSE_CHILD) {
  const M = await loadTs('tests/fixtures/checkout-entry.ts', 'checkoutabuse');
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
const safe = async (label, fn) => {
  try { await fn(); } catch (err) { check(`${label} (threw: ${String(err?.message || err).slice(0, 200)})`, false); }
};

/* ================= pure ================= */

await safe('capture', async () => {
  const cap = await loadTs('src/lib/payments/capture.ts');
  const order = { total_cents: 5000, currency: 'EUR', payment_status: 'pending', payment_events: [] };
  const d = cap.decidePaymentEvent(order, { eventId: 'e1', reference: 'o', outcome: 'declined', amountCents: 5000, currency: 'EUR', rawType: 'payment_intent.payment_failed' });
  check(`S4.2: a declined attempt is recorded, not a failure (${j(d)})`, d.action === 'decline');
  check('S4.2: ...and it moves neither the order nor the payment status', d.orderStatus === undefined && d.paymentStatus === undefined);
  const paid = cap.decidePaymentEvent({ ...order, payment_status: 'paid' }, { eventId: 'e2', reference: 'o', outcome: 'declined', amountCents: 5000, currency: 'EUR', rawType: 'payment_intent.payment_failed' });
  check('S4.2: a decline after the payment succeeded is ignored', paid.action === 'ignore');
  const expired = cap.decidePaymentEvent(order, { eventId: 'e3', reference: 'o', outcome: 'failed', amountCents: 5000, currency: 'EUR', rawType: 'checkout.session.expired' });
  check('S4.2: session expiry still fails and cancels', expired.action === 'fail' && expired.orderStatus === 'cancelled');
});

await safe('stripe', async () => {
  const { stripeProvider } = await loadTs('src/lib/payments/stripe.ts');
  const reg = await loadTs('src/lib/payments/registry.ts');
  const secret = 'whsec_test';
  const sign = (body) => {
    const t = Math.floor(Date.now() / 1000);
    const v1 = crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
    return new Headers({ 'stripe-signature': `t=${t},v1=${v1}` });
  };
  const ctx = reg.providerContext({ env: { STRIPE_SECRET_KEY: 'sk_test', STRIPE_WEBHOOK_SECRET: secret }, siteUrl: 'https://shop.example.com' });
  const outcome = async (type, object = {}) => {
    const body = JSON.stringify({ id: `evt_${type}`, type, data: { object: { metadata: { order_id: 'o1' }, amount: 100, currency: 'eur', ...object } } });
    return (await stripeProvider.verifyWebhook(body, sign(body), ctx)).outcome;
  };
  check('S4.2: Stripe payment_intent.payment_failed is a DECLINED attempt', (await outcome('payment_intent.payment_failed')) === 'declined');
  check('S4.2: Stripe checkout.session.expired is still a failure', (await outcome('checkout.session.expired')) === 'failed');
  check('S4.2: Stripe checkout.session.async_payment_failed is still a failure', (await outcome('checkout.session.async_payment_failed')) === 'failed');

  // expires_at from the hold, clamped to Stripe's 30 min – 24 h window.
  const bodies = [];
  const fetchStub = async (_url, init) => {
    bodies.push(new URLSearchParams(String(init.body)));
    return new Response(JSON.stringify({ id: 'cs_1', url: 'https://checkout.stripe.com/x', expires_at: 1 }), { status: 200 });
  };
  const now = Date.now();
  const orderFixture = { id: 'o1', number: 'OG-1', currency: 'EUR', email: 'a@b.co', items: [{ name: 'x', qty: 1, total_cents: 100 }], total_cents: 100 };
  const expiresFor = async (holdUntil) => {
    const c = reg.providerContext({ env: { STRIPE_SECRET_KEY: 'sk', STRIPE_WEBHOOK_SECRET: 's' }, siteUrl: 'https://x', fetch: fetchStub, now: () => now });
    if (holdUntil !== undefined) c.holdUntil = holdUntil;
    await stripeProvider.createSession(orderFixture, c);
    const v = bodies.at(-1).get('expires_at');
    return v === null ? null : Number(v) - Math.floor(now / 1000);
  };
  const noHold = await expiresFor(undefined);
  check(`S4.1: with no hold, Stripe's own 24 h default is left alone (expires_at=${noHold})`, noHold === null);
  const twoHours = await expiresFor(now + 2 * 3_600_000);
  check(`S4.1: a two-hour hold sets the session to expire with it (${twoHours}s)`, twoHours === 7200);
  const soon = await expiresFor(now + 5 * 60_000);
  check(`S4.1: a hold ending sooner than Stripe allows is clamped up to its 30-minute minimum, with margin (${soon}s)`, soon >= 1800 && soon <= 1800 + 120);
  const long = await expiresFor(now + 30 * 3_600_000);
  check(`S4.1: ...and one past 24 h down to Stripe's maximum (${long}s)`, long <= 86400 && long >= 86400 - 120);
  const past = await expiresFor(now - 3_600_000);
  check(`S4.1: a hold already over still yields a valid expiry (${past}s)`, past >= 1800 && past <= 1800 + 120);
});

await safe('payment-hold', async () => {
  const H = await loadTs('src/lib/commerce/payment-hold.ts');
  const s = H.resolvePaymentHoldSettings({});
  check(`S4.1: the hold defaults to 120 minutes and the cap to 5 (${j(s)})`, s.holdMinutes === 120 && s.maxUnpaidPerBuyer === 5);
  check('S4.1: the risk hold is OFF by default', s.riskHold.enabled === false);
  check('S4.1: 0 switches the hold off', H.resolvePaymentHoldSettings({ orders_payment_hold_minutes: 0 }).holdMinutes === 0);
  check('S4.1: 0 switches the cap off', H.resolvePaymentHoldSettings({ orders_max_unpaid_per_buyer: '0' }).maxUnpaidPerBuyer === 0);
  check('S4.1: a hold under Stripe\'s 30-minute session minimum is raised to it',
    H.resolvePaymentHoldSettings({ orders_payment_hold_minutes: 5 }).holdMinutes === 30);
  check('S4.1: a hold over 24 h is lowered to it',
    H.resolvePaymentHoldSettings({ orders_payment_hold_minutes: 99999 }).holdMinutes === 1440);
  check('S4.1: garbage falls back to the default',
    H.resolvePaymentHoldSettings({ orders_payment_hold_minutes: 'soon', orders_max_unpaid_per_buyer: -3 }).holdMinutes === 120);
  check('S4.1: a negative cap is off, not negative',
    H.resolvePaymentHoldSettings({ orders_max_unpaid_per_buyer: -3 }).maxUnpaidPerBuyer === 0);
  const ids = ['stripe', 'paypal', 'klarna'];
  check('S4.1: online = a provider id, from the registry list passed in', H.isOnlinePayment({ payment_method: 'paypal' }, ids));
  check('S4.1: bank transfer is not online', !H.isOnlinePayment({ payment_method: 'bank-transfer' }, ids));
  check('S4.1: a manual order that was sent to a provider is online', H.isOnlinePayment({ payment_method: 'bank-transfer', payment_provider: 'stripe' }, ids));
  const counts = H.countUnpaidForBuyer([
    { email: 'A@x.co', ip_hash: 'h1', status: 'pending', payment_status: 'unpaid', created_at: new Date().toISOString() },
    { email: 'a@x.co', ip_hash: 'h2', status: 'pending', payment_status: 'pending', created_at: new Date().toISOString() },
    { email: 'a@x.co', ip_hash: 'h1', status: 'cancelled', payment_status: 'failed', created_at: new Date().toISOString() },
    { email: 'b@x.co', ip_hash: 'h1', status: 'pending', payment_status: 'paid', created_at: new Date().toISOString() },
    { email: 'c@x.co', ip_hash: 'h1', status: 'on-hold', risk_held: true, payment_status: 'unpaid', created_at: new Date().toISOString() },
    { email: 'a@x.co', ip_hash: 'h1', status: 'pending', payment_status: 'unpaid', created_at: '2020-01-01T00:00:00Z' },
  ], { email: ' a@X.co ', ipHash: 'h1' }, { email: Date.now() - 86_400_000, ip: Date.now() - 86_400_000 });
  check(`S4.1: counts open unpaid orders by email and by IP hash, inside the window (${j(counts)})`,
    counts.byEmail === 2 && counts.byIp === 2);
  const threeHoursAgo = new Date(Date.now() - 3 * 3_600_000).toISOString();
  const windows = H.countUnpaidForBuyer([
    { email: 'w@x.co', ip_hash: 'hw', status: 'pending', payment_status: 'unpaid', created_at: threeHoursAgo },
  ], { email: 'w@x.co', ipHash: 'hw' }, { email: Date.now() - 86_400_000, ip: Date.now() - H.ipWindowMs(120) });
  check(`S4.1: an order three hours old still counts by email, but no longer by address (${j(windows)})`,
    windows.byEmail === 1 && windows.byIp === 0);
  check('S4.1: the per-address window is the hold, at least an hour, two hours when the hold is off',
    H.ipWindowMs(120) === 7_200_000 && H.ipWindowMs(30) === 3_600_000 && H.ipWindowMs(0) === 7_200_000 && H.ipWindowMs(600) === 36_000_000);
  for (const ip of ['203.0.113.7', '8.8.8.8', '2001:db8::1', '2a02:587:1234::/64', '::ffff:198.51.100.2', '172.32.0.1', '100.64.1.1']) {
    check(`S4.1: ${ip} is a shopper's address`, H.isRoutableClientIp(ip) === true);
  }
  for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '10.1.2.3', '172.16.0.9', '172.31.255.1', '192.168.1.10',
    '169.254.1.1', '0.0.0.0', 'fd12:3456::1', 'fe80::1', '[::1]', 'unknown', '', undefined]) {
    check(`S4.1: ${j(ip)} is NOT counted as a shopper's address`, H.isRoutableClientIp(ip) === false);
  }
});

await safe('coupon-public', async () => {
  const C = await loadTs('src/lib/commerce/coupons.ts');
  const expired = { ok: false, reason: 'expired', message: 'That code has expired.' };
  const min = { ok: false, reason: 'minimum-not-met', message: 'Spend 3.00 more to use this code.', shortfall_cents: 300 };
  const pub = C.publicCouponRejection(expired);
  check(`S4.6: a stranger sees one generic reason (${j(pub)})`, pub.reason === 'invalid' && !/expire/i.test(pub.message));
  const pubMin = C.publicCouponRejection(min);
  check(`S4.6: ...except the minimum-spend shortfall, which is actionable (${j(pubMin)})`,
    pubMin.reason === 'minimum-not-met' && pubMin.shortfall_cents === 300);
  const notFound = C.applyCoupon(null, { lines: [], subtotal_cents: 0, nowMs: 0 });
  check('S4.6: a missing code reads exactly like an expired one to a stranger',
    j(C.publicCouponRejection(notFound)) === j(pub));
});

await safe('email-validate', async () => {
  const E = await loadTs('src/lib/commerce/checkout-email.ts');
  for (const e of ['buyer@example.com', 'first.last+tag@sub.example.gr', 'όνομα@παράδειγμα.ελ', 'x@xn--qxam.xn--qxam']) {
    check(`S4.8: "${e}" is accepted`, E.isCheckoutEmail(e));
  }
  for (const e of ['not an email a@b.co', 'a@b.co\nBcc: v@x.co', '<a@b.co>', 'a@b', '@b.co', 'a@@b.co', 'a@b.co ', `${'a'.repeat(250)}@b.co`, 'a@b..co', 'a@.b.co',
    // A control character that is not whitespace, so only the control-character rule catches it.
    'ab@example.com']) {
    check(`S4.8: ${j(e)} is refused`, !E.isCheckoutEmail(e));
  }
});

await safe('confirmation-throttle', async () => {
  const OC = await loadTs('src/lib/commerce/order-confirmation.ts');
  const sent = [];
  const order = { id: 'o', number: 'OG-1', email: 'x@example.com', currency: 'EUR', total_cents: 100, items: [] };
  await OC.sendOrderConfirmation(order, {
    readSettings: async () => ({}), send: async (m) => { sent.push(m); },
    instructionsFor: () => undefined, allowSend: async () => false,
  });
  check('S4.8: a recipient over its budget is not mailed', sent.length === 0);
  await OC.sendOrderConfirmation(order, {
    readSettings: async () => ({}), send: async (m) => { sent.push(m); },
    instructionsFor: () => undefined, allowSend: async (to) => to === 'x@example.com',
  });
  check('S4.8: ...and one inside it is, with the address the budget was asked about', sent.length === 1);
});

await safe('captcha-surfaces', async () => {
  const cap = await loadTs('src/lib/captcha.ts');
  check(`S4.5: checkout and magic-link are protectable surfaces (${j(cap.CAPTCHA_SURFACES)})`,
    cap.CAPTCHA_SURFACES.includes('checkout') && cap.CAPTCHA_SURFACES.includes('magic-link'));
  check('S4.5: ...and off unless the operator ticks them', cap.resolveCaptchaSurfaces({}).size === 0);
  const sv = await loadTs('src/lib/settings-validate.ts');
  check('S4.5: the settings API accepts the new surface ids',
    sv.validateSetting('captcha_surfaces', ['checkout', 'magic-link']) === null);
});

await safe('paypal-token', async () => {
  const { paypalProvider } = await loadTs('src/lib/payments/paypal.ts');
  const reg = await loadTs('src/lib/payments/registry.ts');
  let tokenCalls = 0;
  const fetchStub = async (url) => {
    if (String(url).includes('/v1/oauth2/token')) {
      tokenCalls += 1;
      return new Response(JSON.stringify({ access_token: `tok${tokenCalls}`, expires_in: 32400 }), { status: 200 });
    }
    if (String(url).includes('verify-webhook-signature')) {
      return new Response(JSON.stringify({ verification_status: 'SUCCESS' }), { status: 200 });
    }
    return new Response(JSON.stringify({ status: 'APPROVED', purchase_units: [{ custom_id: 'o1', amount: { value: '1.00', currency_code: 'EUR' } }] }), { status: 200 });
  };
  const env = { PAYPAL_CLIENT_ID: 'id-a', PAYPAL_CLIENT_SECRET: 'secret-a', PAYPAL_WEBHOOK_ID: 'wh' };
  let clock = Date.now();
  const ctx = (e = env) => reg.providerContext({ env: e, siteUrl: 'https://x', fetch: fetchStub, now: () => clock });
  const headers = new Headers({ 'paypal-cert-url': 'https://api.paypal.com/cert.pem' });
  const body = JSON.stringify({ id: 'WH-1', event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: 'PP1' } });
  await paypalProvider.verifyWebhook(body, headers, ctx());
  await paypalProvider.verifyWebhook(body, headers, ctx());
  check(`S4.11: two verifications share ONE OAuth token (token calls=${tokenCalls})`, tokenCalls === 1);
  await paypalProvider.verifyWebhook(body, headers, ctx({ ...env, PAYPAL_CLIENT_SECRET: 'secret-b' }));
  check(`S4.11: other credentials get their own token (token calls=${tokenCalls})`, tokenCalls === 2);
  clock += 10 * 3_600_000;
  await paypalProvider.verifyWebhook(body, headers, ctx());
  check(`S4.11: an expired token is fetched again (token calls=${tokenCalls})`, tokenCalls === 3);
});

/* ================= per driver ================= */

const tmpRoot = path.join(os.tmpdir(), `astrobaas-checkout-abuse-${process.pid}`);
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
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env, CHECKOUT_ABUSE_CHILD: '1', NODE_ENV: 'test',
      AUTH_SECRET: SECRET, CAPTCHA_BITS: '8',
      PAYMENTS_ENABLED: 'stripe,paypal,hold-stub',
      STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_x',
      PAYPAL_CLIENT_ID: 'pp-id', PAYPAL_CLIENT_SECRET: 'pp-secret', PAYPAL_WEBHOOK_ID: 'pp-wh',
      STAGING: '', ASTROBAAS_STAGING: '', RATE_LIMIT_STORE: '', SITE_URL: '', EMAIL_TRANSPORT: '', SMTP_HOST: '',
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
}

for (const driver of DRIVERS) {
  const r = await runChild(driver);
  if (!r) continue;
  const t = (n, c) => check(`[${driver.name}] ${n}`, c);
  for (const [k, v] of Object.entries(r)) {
    if (v && v.error) t(`${k}: scenario threw — ${v.error}`, false);
  }

  /* S4.1 cap */
  if (r.cap && !r.cap.error) {
    const c = r.cap;
    t(`S4.1: five unpaid orders from one email are accepted (${j(c.email.slice(0, 5).map((x) => x.code))})`,
      c.email.slice(0, 5).every((x) => x.code === 201));
    t(`S4.1: the sixth is refused with 429 and a stable code, whatever the network (${j(c.email[5])})`,
      c.email[5]?.code === 429 && c.email[5]?.errCode === 'checkout.too_many_unpaid');
    t(`S4.1: ...and tells the client when to come back (${c.email[5]?.retry})`, Number(c.email[5]?.retry) > 0);
    t(`S4.1: the email is compared normalised (${c.emailCase})`, c.emailCase === 429);
    t(`S4.1: a cancelled order frees a slot (${c.afterCancel})`, c.afterCancel === 201);
    t(`S4.1: a paid order frees a slot (${c.afterPaid})`, c.afterPaid === 201);
    t(`S4.1: five emails from one network are accepted, the sixth refused (${j(c.ip)})`,
      j(c.ip) === j([201, 201, 201, 201, 201, 429]) && c.ipErr === 'checkout.too_many_unpaid');
    t(`S4.1: a loopback address is never capped by address (${j(c.loopback)})`, c.loopback.every((x) => x === 201));
    t(`S4.1: nor is a private one (${j(c.private)})`, c.private.every((x) => x === 201));
    t(`S4.1: ...while the email cap still holds behind them (${j(c.loopbackEmail)})`,
      j(c.loopbackEmail) === j([201, 201, 201, 201, 201, 429]));
    t(`S4.1: orders older than the hold no longer count against their address (${c.afterWindow})`, c.afterWindow === 201);
    t(`S4.1: staff placing orders are never capped (${j(c.staff)})`, c.staff.every((x) => x === 201));
    t(`S4.1: an API key is not capped by its own address (${j(c.keyIp)})`, c.keyIp.every((x) => x === 201));
    t(`S4.1: ...but is capped by the shopper's email (${j(c.keyEmail)})`, j(c.keyEmail) === j([201, 201, 201, 201, 201, 429]));
    t(`S4.1: 0 switches the cap off (${j(c.off)})`, c.off.every((x) => x === 201));
    t(`S4.1: a refused checkout reserves nothing (stock=${c.stock}, orders=${c.orders})`, c.stock === 100 - c.orders);
  }

  /* S4.1 hold */
  if (r.hold && !r.hold.error) {
    const h = r.hold;
    t(`S4.1: the hold sweep exists (${h.fn})`, h.fn === 'function');
    if (h.fn === 'function') {
      t(`S4.1: nothing expires before the hold is over (${h.early})`, h.early === 0);
      t(`S4.1: unpaid online orders past the hold are cancelled, with the reason (${j(h.states)})`,
        h.states.online === 'cancelled/hold-expired' && h.states.onlinePending === 'cancelled/hold-expired');
      t('S4.1: ...and a risk-held one waiting for payment too', h.states.riskHeld === 'cancelled/hold-expired');
      t('S4.1: a paid order is never touched', h.states.paid === 'processing/-');
      t('S4.1: bank transfer and cash on delivery keep the day-based sweep', h.states.manual === 'pending/-' && h.states.cod === 'pending/-');
      t('S4.1: an imported order is never touched', h.states.imported === 'pending/-');
      t('S4.1: an order whose provider session is still open is left until it closes', h.states.lateSession === 'pending/-');
      t(`S4.1: exactly those three were expired, and their stock returned once (expired=${h.expired}, released=${h.released})`,
        h.expired === 3 && h.released === 3);
      t(`S4.1: a second sweep does nothing (${h.again}, released=${h.releasedAfterAgain})`, h.again === 0 && h.releasedAfterAgain === 3);
      t(`S4.1: the open session expires after its own deadline (${h.lateExpired})`, h.lateExpired === 1);
      t(`S4.1: hold 0 leaves online orders alone (${h.offExpired}, ${h.offState})`, h.offExpired === 0 && h.offState === 'pending/-');
      t(`S4.1: each expiry is audited (${h.audits})`, h.audits === 4);
    }
  }

  /* S4.1 / S4.13 start */
  if (r.start && !r.start.error) {
    const s = r.start;
    t(`S4.13: the order was placed and the payment started (${s.placed}, ${s.started})`, s.placed === 201 && s.started === 200);
    t(`S4.13: return URLs use the configured site, not the request's Host (${s.siteUrl})`, s.siteUrl === 'https://shop.example.com');
    t(`S4.13: ...and fall back to the request origin when none is set (${s.fallbackSiteUrl})`, s.fallbackSiteUrl === 'http://cms.example.net');
    t(`S4.13: the order is found by its number, without listing every order (getOrders calls=${s.listCalls})`, s.listCalls === 0);
    t(`S4.1: the provider is told when the hold ends (${s.holdUntil} ms after the order)`, s.holdUntil === 120 * 60_000);
    t('S4.1: the session\'s own expiry is remembered on the order', s.expiresStored === true);
    t(`S4.1: no session is opened once the hold is over (${j(s.late)})`,
      s.late.code === 409 && s.late.errCode === 'payment.window_closed' && s.late.sessions === 2);
    t(`S4.13: a wrong email and an unknown number still answer alike (${j(s.oracle)})`,
      s.oracle[0] === 404 && s.oracle[1] === 404 && s.oracle[2] === true);
  }

  /* S4.2 */
  if (r.decline && !r.decline.error) {
    const d = r.decline;
    t(`S4.2: a declined card leaves the order open and its stock held (${j(d)})`,
      d.action === 'decline' && d.status === 'pending' && d.stock === 3);
    t(`S4.2: ...the payment is still pending — the buyer can retry (${d.payment})`, d.payment === 'pending');
    t(`S4.2: ...and the attempt is counted (${d.declines})`, d.declines === 1);
    t(`S4.2: five declines are five, a replay adds none (${d.after5.declines})`, d.after5.declines === 5);
    t(`S4.2: ...and look like card testing to staff (${j(d.after5)})`,
      d.after5.flagged && d.after5.signals.includes('card_testing') && d.after5.status === 'pending');
    t(`S4.2: the session expiring still cancels and returns the stock (${j(d.expired)})`,
      d.expired.status === 'cancelled' && d.expired.payment === 'failed' && d.expired.stock === 5);
  }

  /* S4.3 */
  if (r.late && !r.late.error) {
    const l = r.late;
    t(`S4.3: a late payment with the stock still there reopens the order and re-reserves (${j(l.a)})`,
      l.a.status === 'processing' && l.a.payment === 'paid' && l.a.stock === l.a.before - 2 && !l.a.flag);
    t(`S4.3: a late payment with the stock gone keeps the order cancelled (${j(l.b)})`,
      l.b.status === 'cancelled' && l.b.payment === 'paid' && l.b.stock === 0);
    t('S4.3: ...flags it for a refund', l.b.flag === true);
    t(`S4.3: ...audits it once (${l.b.audits})`, l.b.audits === 1);
    t('S4.3: ...and tells the owner', l.b.ownerMailed === true);
    t(`S4.3: a replayed success does not flag twice (${l.b.auditsAfterReplay})`, l.b.auditsAfterReplay === 1);
  }

  /* S4.4 */
  if (r.idem && !r.idem.error) {
    const i = r.idem;
    t(`S4.4: a keyed order is placed (${j(i.first)})`, i.first.code === 201 && !!i.first.number);
    t(`S4.4: a retry with the key gets the SAME answer, marked as a replay (${j(i.replay)})`,
      i.replay.code === 201 && i.replay.number === i.first.number && i.replay.same && i.replay.replayed === 'true');
    t(`S4.4: the key with a different body is a 422 (${j(i.mismatch)})`,
      i.mismatch.code === 422 && i.mismatch.errCode === 'IDEMPOTENCY_KEY_REUSED');
    t(`S4.4: keys belong to their caller (${i.otherCaller})`, i.otherCaller === 201);
    t(`S4.4: a malformed key is a 400 (${j(i.badKey)})`, i.badKey.code === 400 && i.badKey.errCode === 'IDEMPOTENCY_KEY_INVALID');
    t(`S4.4: a refused request does not burn its key (${j(i.retryAfterRefusal)})`, j(i.retryAfterRefusal) === j([409, 201]));
    t(`S4.4: one order for the replayed key (${i.count})`, i.count === 1);
    t(`S4.4: without a key nothing changes (${j(i.noKey)})`, j(i.noKey) === j([201, 201, true]));
  }

  /* S4.5 */
  if (r.pow && !r.pow.error) {
    const p = r.pow;
    t(`S4.5: checkout without a token works while the surface is off (${p.offByDefault})`, p.offByDefault === 201);
    t(`S4.5: with it on, a checkout without a proof is refused (${j(p.missing)})`,
      p.missing.code === 403 && p.missing.errCode === 'checkout.captcha_failed');
    t(`S4.5: ...a solved proof is accepted (${p.solved})`, p.solved === 201);
    t(`S4.5: ...once (${p.replay})`, p.replay === 403);
    t(`S4.5: ...and only for its own surface (${p.wrongSurface})`, p.wrongSurface === 403);
    t(`S4.5: staff and API keys are not asked (${p.staff}, ${p.key})`, p.staff === 201 && p.key === 201);
    t(`S4.5: magic-link without a proof is refused (${p.magicMissing})`, p.magicMissing === 403);
    t(`S4.5: ...the login form hears why (${j(p.magicFormMissing)})`,
      p.magicFormMissing.code === 303 && /error=captcha/.test(p.magicFormMissing.location ?? ''));
    t(`S4.5: ...a solved proof gets the usual generic answer (${p.magicSolved})`, p.magicSolved === 200);
    t(`S4.5: ...and with the surface off nothing is asked (${p.magicOff})`, p.magicOff === 200);
  }

  /* S4.6 */
  if (r.coupon && !r.coupon.error) {
    const c = r.coupon;
    const generic = (v) => v && v.ok === false && v.reason === 'invalid' && v.shortfall_cents === undefined;
    t(`S4.6: a stranger's quote does not say a code EXPIRED (${j(c.anonExpired)})`, generic(c.anonExpired));
    t(`S4.6: ...or is used up (${j(c.anonSpent)})`, generic(c.anonSpent));
    t(`S4.6: ...and says the same for a code that never existed (${j(c.anonMissing)})`,
      generic(c.anonMissing) && c.anonMissing.message === c.anonExpired?.message);
    t(`S4.6: the minimum-spend shortfall is still shown (${j(c.anonMinimum)})`,
      c.anonMinimum?.reason === 'minimum-not-met' && c.anonMinimum?.shortfall_cents > 0);
    t(`S4.6: staff previewing a basket still see the real reason (${j(c.staffExpired)})`, c.staffExpired?.reason === 'expired');
    t(`S4.6: an API key is a stranger for this purpose (${j(c.keyExpired)})`, generic(c.keyExpired));
    t(`S4.6: a stranger's order with a used-up code gets the generic sentence and code (${j(c.anonOrder)})`,
      c.anonOrder.code === 400 && c.anonOrder.errCode === 'checkout.coupon_invalid'
        && !/limit/i.test(c.anonOrder.message ?? '') && c.anonOrder.message === c.anonMissing?.message
        && !c.anonOrder.params?.reason);
    t(`S4.6: ...the shortfall survives on the order path too (${j(c.anonMinOrder)})`,
      c.anonMinOrder.code === 400 && c.anonMinOrder.params?.shortfall_cents > 0);
    t(`S4.6: staff get the specific sentence (${j(c.staffOrder)})`, c.staffOrder.code === 400 && /limit/i.test(c.staffOrder.message ?? ''));
    t(`S4.6: refused coupon orders reserved nothing (stock=${c.stock})`, c.stock === 50);
  }

  /* S4.8 */
  if (r.email && !r.email.error) {
    const e = r.email;
    t(`S4.8: malformed addresses are refused at checkout, with the usual 422 (${j(e.bad)})`, e.bad.every((x) => x === 422));
    t(`S4.8: real ones, including Greek, are accepted (${j(e.good)})`, e.good.every((x) => x === 201));
    t(`S4.8: one inbox gets at most five confirmations an hour (${e.confirmations} for ${e.placed} orders)`,
      e.placed === 8 && e.confirmations === 5);
  }

  /* S4.12 */
  if (r.webhook && !r.webhook.error) {
    const w = r.webhook;
    t(`S4.12: forged webhooks are refused with 401, then throttled with 429 (${j(w.codes)})`,
      w.codes.slice(0, 20).every((x) => x === 401) && w.codes.slice(20).every((x) => x === 429));
    t(`S4.12: ...and once throttled, no outbound call is made (${w.outboundAfterBlock})`, w.outboundAfterBlock === 0);
    t(`S4.12: ...the 429 says when to retry (${w.retryAfter})`, Number(w.retryAfter) > 0);
    t(`S4.12: another address is unaffected (${w.otherIp})`, w.otherIp === 401);
    t(`S4.12: a loopback (untrusted-proxy) address is never throttled (${j(w.loopbackCodes)})`,
      w.loopbackCodes.every((x) => x === 401));
    t(`S4.12: ...but its failures are still ONE audit entry (${w.loopbackAudits})`, w.loopbackAudits === 1);
    t(`S4.12: 27 failed attempts from one address are TWO audit entries — the first, and the throttle — not 27 (${w.audits})`,
      w.audits === 2);
    t(`S4.12: ...and the throttle entry carries the count (${j(w.throttleAudit)})`, w.throttleAudit?.failures === 20);
  }

  /* S4.14 */
  if (r.velocity && !r.velocity.error) {
    const v = r.velocity;
    t(`S4.14: velocity sees orders from the last 30 minutes past the 200 newest (${j(v)})`,
      v.code === 201 && v.signals.includes('velocity_email') && v.signals.includes('velocity_ip'));
  }

  /* S4.15 */
  if (r.riskHold && !r.riskHold.error) {
    const h = r.riskHold;
    t(`S4.15: with the switch on, a high-risk order is PLACED on hold (${j(h)})`,
      h.code === 201 && h.status === 'on-hold' && h.held && h.bodyStatus === 'on-hold');
    t(`S4.15: ...its stock is held like any other order's (stock=${h.stock})`, h.stock === 9);
    t(`S4.15: ...and paying does not skip the review (${j(h.afterPay)})`,
      h.afterPay?.status === 'on-hold' && h.afterPay?.payment === 'paid');
    t(`S4.15: an ordinary order is untouched (${h.plain})`, h.plain === 'pending');
    t(`S4.15: with the switch off a flagged order is only flagged (${j(h.off)})`, h.off.status === 'pending' && h.off.flagged);
  }
}

await fs.rm(tmpRoot, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
