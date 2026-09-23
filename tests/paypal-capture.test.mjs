#!/usr/bin/env node
/**
 * PayPal approvals are CAPTURED — and only for an order that can still ship.
 *
 * ## The bug (S4.16)
 *
 * paypal.ts creates orders with `intent: 'CAPTURE'`, which in PayPal's Orders
 * v2 means: the buyer approves on PayPal, and then the MERCHANT must call
 * `POST /v2/checkout/orders/{id}/capture` to take the money. Nothing here ever
 * made that call. The approval webhook's fetch-back read `APPROVED`, which
 * mapped to "ignored", so a PayPal order was never paid — and with the payment
 * hold it was then cancelled, stock returned, while the buyer believed they
 * had paid.
 *
 * ## What is asserted
 *
 * Provider level (mocked fetch, as tests/payments.test.mjs does it): what the
 * capture request looks like, where the amount comes from, the
 * ORDER_ALREADY_CAPTURED fallback, and which failures are retryable.
 *
 * Order level (every driver, the real webhook route, a stateful fake PayPal
 * standing in for the network):
 *   A  an approval is captured once and the order becomes paid
 *   B  the same approval delivered again captures nothing more
 *   C  a capture PayPal refuses, or cannot answer, leaves the order unpaid
 *   D  an order cancelled with its stock gone is NOT captured
 *   E  a capture whose amount does not match is rejected
 *   F  an approval for the wrong amount is not captured at all
 *   G  a capture PayPal says already happened is read back and applied
 *   H  an order the hold cancelled, whose stock is still there, is reopened
 *      FIRST and only then captured — and put back if the capture fails
 *   I  an order STAFF cancelled is never captured
 *
 * Run with:  node tests/paypal-capture.test.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, loadTs } from './lib/load.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = JSON.stringify;

/**
 * A stateful stand-in for PayPal's REST API. Each PayPal order has a status,
 * an amount and a capture behaviour; every call is recorded.
 */
function fakePayPal() {
  const orders = new Map();
  const calls = { token: 0, verify: 0, get: [], capture: [] };
  const reply = (status, body) => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  });
  const captureBody = (id, o) => ({
    id,
    status: 'COMPLETED',
    purchase_units: [{
      reference_id: 'default',
      payments: {
        captures: [{
          id: `CAP-${id}`,
          status: o.captureStatus ?? 'COMPLETED',
          amount: { currency_code: o.currency, value: o.captureAmount ?? o.amount },
          custom_id: o.customId,
        }],
      },
    }],
  });
  const fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith('/v1/oauth2/token')) {
      calls.token += 1;
      return reply(200, { access_token: 'fake-token', expires_in: 32400 });
    }
    if (u.endsWith('/v1/notifications/verify-webhook-signature')) {
      calls.verify += 1;
      return reply(200, { verification_status: 'SUCCESS' });
    }
    let m = /\/v2\/checkout\/orders\/([^/?]+)\/capture$/.exec(u);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const o = orders.get(id);
      calls.capture.push({ id, method: init.method, headers: { ...(init.headers ?? {}) }, body: init.body });
      if (!o) return reply(404, { name: 'RESOURCE_NOT_FOUND' });
      if (o.onCapture === '500') return reply(500, { name: 'INTERNAL_SERVER_ERROR' });
      if (o.onCapture === 'declined') {
        return reply(422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'INSTRUMENT_DECLINED' }] });
      }
      if (o.onCapture === 'already') {
        o.status = 'COMPLETED';
        return reply(422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_ALREADY_CAPTURED' }] });
      }
      // `stateless` keeps answering APPROVED on read-back even after a capture,
      // so a duplicate delivery cannot be stopped by PayPal's state alone.
      if (!o.stateless) o.status = 'COMPLETED';
      return reply(201, captureBody(id, o));
    }
    m = /\/v2\/checkout\/orders\/([^/?]+)$/.exec(u);
    if (m) {
      const id = decodeURIComponent(m[1]);
      calls.get.push(id);
      const o = orders.get(id);
      if (!o) return reply(404, {});
      const unit = { custom_id: o.customId, amount: { currency_code: o.currency, value: o.amount } };
      if (o.status === 'COMPLETED') unit.payments = captureBody(id, o).purchase_units[0].payments;
      return reply(200, { id, status: o.status, purchase_units: [unit] });
    }
    return reply(404, {});
  };
  return { orders, calls, fetch, captures: (id) => calls.capture.filter((c) => c.id === id).length };
}

/* ---------------------------------------------------------------- child --- */

async function child(M) {
  const { LocalDB, setOrderStatus } = M;
  const pp = fakePayPal();
  globalThis.fetch = pp.fetch;
  const out = {};
  let seq = 0;

  const product = (slug, stock) => LocalDB.createProduct({
    status: 'active', price_cents: 1200, categories: [], images: [], on_sale: false,
    name: slug, slug: `${slug}-${++seq}`, stock, in_stock: stock > 0, requires_shipping: false,
  });
  const stockOf = async (id) => (await LocalDB.getProduct(id))?.stock;

  /** An order sent to PayPal: 2 units reserved, 24.00 EUR, PayPal order PP-<n>. */
  async function paypalOrder(tag, { stock = 5, pp: over = {} } = {}) {
    const p = await product(tag, stock);
    await LocalDB.reserveStock(p.id, 2);
    const ppId = `PP-${tag}-${++seq}`;
    const o = await LocalDB.createOrder({
      number: `PPC-${seq}`, status: 'pending', payment_status: 'pending', email: `${tag}@example.com`,
      currency: 'EUR', items: [{ product_id: p.id, name: 'PayPal line', qty: 2, total_cents: 2400 }],
      total_cents: 2400, payment_method: 'paypal', payment_provider: 'paypal', payment_reference: ppId,
    });
    pp.orders.set(ppId, { status: 'APPROVED', amount: '24.00', currency: 'EUR', customId: o.id, ...over });
    return { p, o, ppId };
  }

  let ip = 0;
  async function deliver(ppId, eventId, eventType = 'CHECKOUT.ORDER.APPROVED') {
    const res = await M.postWebhook({
      request: new Request('http://localhost/api/payments/webhook/paypal', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'paypal-cert-url': 'https://api.paypal.com/v1/notifications/certs/CERT-1',
          'paypal-transmission-id': eventId,
        },
        body: JSON.stringify({ id: eventId, event_type: eventType, resource: { id: ppId } }),
      }),
      params: { provider: 'paypal' },
      locals: { user: null, ip: `198.51.100.${(++ip % 200) + 20}` },
      url: new URL('http://localhost/api/payments/webhook/paypal'),
    });
    const body = await res.json().catch(() => null);
    return { code: res.status, applied: body?.applied ?? null, action: body?.action ?? null };
  }
  const state = async (o, p) => {
    const x = await LocalDB.getOrder(o.id);
    return {
      status: x?.status, payment: x?.payment_status, stock: await stockOf(p.id), declines: x?.payment_declines ?? 0,
      reason: x?.cancelled_reason ?? null,
    };
  };
  /** Cancel the way the hold sweep did before S4.18: the move, then the reason. */
  const holdCancel = async (o) => {
    await setOrderStatus(o.id, 'cancelled', 'system:payment-hold');
    await LocalDB.updateOrder(o.id, { cancelled_reason: 'hold-expired' });
  };
  const audits = async (action, id) => {
    await sleep(250);
    return (await LocalDB.getAuditEvents({ action })).filter((e) => e.target === id).length;
  };
  const guard = async (key, fn) => {
    try { out[key] = await fn(); } catch (err) { out[key] = { error: String(err?.stack || err).slice(0, 500) }; }
  };

  // A. approved → captured once → paid.
  await guard('a', async () => {
    const { p, o, ppId } = await paypalOrder('a');
    const hook = await deliver(ppId, `WH-A-${ppId}`);
    return { hook, captures: pp.captures(ppId), ...(await state(o, p)), captured: await audits('payment.captured', o.id) };
  });

  // B. the same approval again, and a stateless PayPal that still says APPROVED.
  await guard('b', async () => {
    const { p, o, ppId } = await paypalOrder('b', { pp: { stateless: true } });
    const first = await deliver(ppId, `WH-B-${ppId}`);
    const again = await deliver(ppId, `WH-B-${ppId}`);
    const other = await deliver(ppId, `WH-B2-${ppId}`);
    return { first, again, other, captures: pp.captures(ppId), ...(await state(o, p)), captured: await audits('payment.captured', o.id) };
  });

  // C. PayPal cannot answer (500): the provider should retry, nothing moves.
  await guard('c', async () => {
    const { p, o, ppId } = await paypalOrder('c', { pp: { onCapture: '500' } });
    const hook = await deliver(ppId, `WH-C-${ppId}`);
    return { hook, captures: pp.captures(ppId), ...(await state(o, p)) };
  });

  // C2. PayPal refuses the funding source: answered, counted, unpaid.
  await guard('c2', async () => {
    const { p, o, ppId } = await paypalOrder('c2', { pp: { onCapture: 'declined' } });
    const hook = await deliver(ppId, `WH-C2-${ppId}`);
    return { hook, captures: pp.captures(ppId), ...(await state(o, p)) };
  });

  // D. cancelled by the hold, and the stock has gone to someone else.
  await guard('d', async () => {
    const { p, o, ppId } = await paypalOrder('d', { stock: 2 });
    await setOrderStatus(o.id, 'cancelled', 'system:payment-hold');
    await LocalDB.updateOrder(o.id, { cancelled_reason: 'hold-expired' });
    await LocalDB.reserveStock(p.id, 2); // another buyer took both
    const hook = await deliver(ppId, `WH-D-${ppId}`);
    return {
      hook, captures: pp.captures(ppId), ...(await state(o, p)),
      notCaptured: await audits('payment.approval_not_captured', o.id),
    };
  });

  // E. the capture reports a different amount from the order.
  await guard('e', async () => {
    const { p, o, ppId } = await paypalOrder('e', { pp: { captureAmount: '0.01' } });
    const hook = await deliver(ppId, `WH-E-${ppId}`);
    return { hook, captures: pp.captures(ppId), ...(await state(o, p)), rejected: await audits('payment.rejected', o.id) };
  });

  // F. the APPROVAL is for a different amount: do not take the money at all.
  await guard('f', async () => {
    const { p, o, ppId } = await paypalOrder('f', { pp: { amount: '1.00' } });
    const hook = await deliver(ppId, `WH-F-${ppId}`);
    return { hook, captures: pp.captures(ppId), ...(await state(o, p)), rejected: await audits('payment.rejected', o.id) };
  });

  // G. PayPal says it was already captured: read it back and apply that.
  await guard('g', async () => {
    const { p, o, ppId } = await paypalOrder('g', { pp: { onCapture: 'already' } });
    const hook = await deliver(ppId, `WH-G-${ppId}`);
    return { hook, captures: pp.captures(ppId), ...(await state(o, p)) };
  });

  // H. cancelled by the hold, stock still there: reopened, then captured.
  await guard('h', async () => {
    const { p, o, ppId } = await paypalOrder('h', { stock: 5 });
    await setOrderStatus(o.id, 'cancelled', 'system:payment-hold');
    await LocalDB.updateOrder(o.id, { cancelled_reason: 'hold-expired' });
    const before = await stockOf(p.id);
    const hook = await deliver(ppId, `WH-H-${ppId}`);
    return { hook, before, captures: pp.captures(ppId), ...(await state(o, p)) };
  });

  // H2. the same, but the capture fails: the order goes back to cancelled
  //     and the stock back on the shelf.
  await guard('h2', async () => {
    const { p, o, ppId } = await paypalOrder('h2', { stock: 5, pp: { onCapture: '500' } });
    await setOrderStatus(o.id, 'cancelled', 'system:payment-hold');
    await LocalDB.updateOrder(o.id, { cancelled_reason: 'hold-expired' });
    const before = await stockOf(p.id);
    const hook = await deliver(ppId, `WH-H2-${ppId}`);
    const first = { hook, before, captures: pp.captures(ppId), ...(await state(o, p)) };
    // PayPal recovers and redelivers the same approval (it was answered 500).
    // The put-back must have left the order exactly as the hold did —
    // reason included — or the redelivery would no longer be captured.
    pp.orders.get(ppId).onCapture = undefined;
    const redelivered = await deliver(ppId, `WH-H2-${ppId}`);
    return { ...first, redelivered: { hook: redelivered, captures: pp.captures(ppId), ...(await state(o, p)) } };
  });

  // L. S4.18: an order the hold cancelled is REOPENED by staff, then
  //    cancelled by staff. The hold's reason must not survive into the staff
  //    cancellation, or an approval would reopen and capture it.
  await guard('l', async () => {
    const { p, o, ppId } = await paypalOrder('l', { stock: 5 });
    await holdCancel(o);
    const reopened = await setOrderStatus(o.id, 'pending', 'admin-1');
    const afterReopen = (await LocalDB.getOrder(o.id))?.cancelled_reason ?? null;
    const cancelled = await setOrderStatus(o.id, 'cancelled', 'admin-1');
    const before = await stockOf(p.id);
    const hook = await deliver(ppId, `WH-L-${ppId}`);
    return {
      reopened: reopened.ok, cancelled: cancelled.ok, afterReopen, hook, before,
      captures: pp.captures(ppId), ...(await state(o, p)),
      notCaptured: await audits('payment.approval_not_captured', o.id),
    };
  });

  // L2. The same with data an earlier version left behind: an order that was
  //     abandoned and reopened by an admin before S4.18 still says
  //     "abandoned" while open. Staff cancelling it must clear that.
  await guard('l2', async () => {
    const { p, o, ppId } = await paypalOrder('l2', { stock: 5 });
    await LocalDB.updateOrder(o.id, { cancelled_reason: 'abandoned' });
    await setOrderStatus(o.id, 'cancelled', 'admin-1');
    const before = await stockOf(p.id);
    const hook = await deliver(ppId, `WH-L2-${ppId}`);
    return {
      hook, before, captures: pp.captures(ppId), ...(await state(o, p)),
      notCaptured: await audits('payment.approval_not_captured', o.id),
    };
  });

  // L3. The coordinator's path: the capture path itself reopens a
  //     hold-cancelled order, PayPal's capture is for the wrong amount
  //     (rejected, order left open and unpaid), staff cancel it, and PayPal
  //     redelivers the approval. `stateless`: PayPal's read-back still says
  //     APPROVED, so the redelivery reaches the approval path again (a live
  //     PayPal usually reports COMPLETED by then, and the wrong amount is
  //     rejected as a payment instead — the approval path is the hole).
  await guard('l3', async () => {
    const { p, o, ppId } = await paypalOrder('l3', { stock: 5, pp: { captureAmount: '0.01', stateless: true } });
    await holdCancel(o);
    const first = await deliver(ppId, `WH-L3-${ppId}`);
    const afterFirst = await state(o, p);
    await setOrderStatus(o.id, 'cancelled', 'admin-1');
    const before = await stockOf(p.id);
    const again = await deliver(ppId, `WH-L3-${ppId}`);
    return {
      first, afterFirst, again, before, captures: pp.captures(ppId), ...(await state(o, p)),
      notCaptured: await audits('payment.approval_not_captured', o.id),
    };
  });

  // H3. the same, but PayPal REFUSES the funding source: nothing was taken,
  //     so the order goes back too.
  await guard('h3', async () => {
    const { p, o, ppId } = await paypalOrder('h3', { stock: 5, pp: { onCapture: 'declined' } });
    await setOrderStatus(o.id, 'cancelled', 'system:payment-hold');
    await LocalDB.updateOrder(o.id, { cancelled_reason: 'hold-expired' });
    const before = await stockOf(p.id);
    const hook = await deliver(ppId, `WH-H3-${ppId}`);
    return { hook, before, captures: pp.captures(ppId), ...(await state(o, p)) };
  });

  // I. cancelled by STAFF, stock available: never captured.
  await guard('i', async () => {
    const { p, o, ppId } = await paypalOrder('i', { stock: 5 });
    await setOrderStatus(o.id, 'cancelled', 'admin-1');
    const before = await stockOf(p.id);
    const hook = await deliver(ppId, `WH-I-${ppId}`);
    return {
      hook, before, captures: pp.captures(ppId), ...(await state(o, p)),
      notCaptured: await audits('payment.approval_not_captured', o.id),
    };
  });

  // K. a provider whose "capture" hands back another approval is not asked
  //    again and again: a capture's own result is never captured.
  await guard('k', async () => {
    const { p, o, ppId } = await paypalOrder('k', { stock: 5 });
    let calls = 0;
    const loopy = {
      id: 'loopy', label: 'Loopy', requiredEnv: [],
      createSession: async () => ({ reference: 'x', redirectUrl: 'https://x' }),
      verifyWebhook: async () => { throw new Error('unused'); },
      captureApproved: async (evt) => { calls += 1; if (calls > 3) throw new Error('capture loop'); return { ...evt }; },
    };
    const approval = {
      eventId: `WH-K-${ppId}`, reference: o.id, outcome: 'approved', amountCents: 2400, currency: 'EUR',
      rawType: 'CHECKOUT.ORDER.APPROVED', providerReference: ppId,
    };
    let res = null;
    let threw = null;
    try {
      res = await M.applyVerifiedEvent(approval, { provider: loopy, ctx: M.registry.providerContext({ env: {}, siteUrl: 'https://x' }) });
    } catch (err) { threw = String(err?.message || err); }
    return { calls, threw, action: res?.decision?.action ?? null, ...(await state(o, p)) };
  });

  // J. a capture in progress keeps the hold sweep away from the order.
  await guard('j', async () => {
    const { p, o } = await paypalOrder('j', { stock: 5 });
    // The sweep runs 3 h after the order (well past the 2 h hold), one minute
    // after a capture was started.
    const at = Date.now() + 3 * 3_600_000;
    await LocalDB.updateOrder(o.id, { payment_capture_started_at: new Date(at - 60_000).toISOString() });
    const swept = await M.scheduler.sweepPaymentHolds(at);
    return { swept: swept.expired, ...(await state(o, p)) };
  });

  // M. LAST — the day-based sweep cancels every stale unpaid order in this
  //    database. The real sweeps write their reason with the cancel, and a
  //    late approval for an order the SWEEP cancelled is still captured.
  await guard('m', async () => {
    const { p, o, ppId } = await paypalOrder('m', { stock: 5 });
    await M.scheduler.sweepAbandonedOrders(Date.now() + 120 * 86_400_000);
    const swept = await state(o, p);
    const hook = await deliver(ppId, `WH-M-${ppId}`);
    return { swept, hook, captures: pp.captures(ppId), ...(await state(o, p)) };
  });

  return out;
}

if (process.env.PAYPAL_CAPTURE_CHILD) {
  const M = await loadTs('tests/fixtures/checkout-entry.ts', 'ppcapture');
  await M.LocalDB.init();
  const result = await child(M);
  console.log('__RESULT__' + JSON.stringify(result));
  process.exit(0);
}

/* --------------------------------------------------------------- parent --- */
let pass = 0;
let fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };
const safe = async (label, fn) => {
  try { await fn(); } catch (err) { check(`${label} (threw: ${String(err?.message || err).slice(0, 200)})`, false); }
};

/* ---- provider level: mocked fetch ---- */
await safe('provider', async () => {
  const { paypalProvider } = await loadTs('src/lib/payments/paypal.ts');
  const reg = await loadTs('src/lib/payments/registry.ts');
  const env = { PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret', PAYPAL_WEBHOOK_ID: 'wh', PAYPAL_ENV: 'live' };
  const headers = new Headers({ 'paypal-cert-url': 'https://api.paypal.com/cert.pem' });

  const setup = (over = {}) => {
    const pp = fakePayPal();
    pp.orders.set('PP1', { status: 'APPROVED', amount: '24.00', currency: 'EUR', customId: 'order-1', captureAmount: '24.00', ...over });
    return { pp, ctx: reg.providerContext({ env, siteUrl: 'https://shop.example', fetch: pp.fetch }) };
  };
  const approvalBody = JSON.stringify({ id: 'WH-1', event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: 'PP1' } });

  {
    const { pp, ctx } = setup();
    const evt = await paypalProvider.verifyWebhook(approvalBody, headers, ctx);
    check(`an APPROVED PayPal order is an approval to capture, not "ignored" (${evt.outcome})`, evt.outcome === 'approved');
    check(`...carrying our order id and PayPal's (${evt.reference}, ${evt.providerReference})`,
      evt.reference === 'order-1' && evt.providerReference === 'PP1');
    check(`...and the approved amount (${evt.amountCents} ${evt.currency})`, evt.amountCents === 2400 && evt.currency === 'EUR');
    check('verification makes no capture on its own', pp.calls.capture.length === 0);

    check('the PayPal provider can capture an approval', typeof paypalProvider.captureApproved === 'function');
    if (typeof paypalProvider.captureApproved === 'function') {
      pp.orders.get('PP1').captureAmount = '24.00';
      pp.orders.get('PP1').amount = '99.00'; // the capture RESPONSE is the source, not the order read
      const captured = await paypalProvider.captureApproved(evt, ctx);
      const call = pp.calls.capture[0];
      check(`capture is POST /v2/checkout/orders/{id}/capture on the configured environment (${call?.method})`,
        pp.calls.capture.length === 1 && call.method === 'POST');
      check(`...with a bearer token and a JSON body of {} (${j(call?.headers)} ${call?.body})`,
        call?.headers?.Authorization === 'Bearer fake-token' && call?.headers?.['Content-Type'] === 'application/json' && call?.body === '{}');
      const rid = call?.headers?.['PayPal-Request-Id'];
      check(`...and a PayPal-Request-Id derived from the order (${rid})`,
        typeof rid === 'string' && rid.includes('PP1') && rid.includes('order-1') && rid.length <= 108);
      check(`the result is PAID with the amount from the capture response (${j(captured)})`,
        captured.outcome === 'paid' && captured.amountCents === 2400 && captured.currency === 'EUR' && captured.reference === 'order-1');
      check(`...under the capture's own id, so a repeat is recognisable (${captured.eventId})`,
        captured.eventId === 'paypal-capture:CAP-PP1');

      await paypalProvider.captureApproved(evt, ctx);
      check('the same approval captured twice sends the SAME PayPal-Request-Id',
        pp.calls.capture[1]?.headers?.['PayPal-Request-Id'] === rid);
    }
  }

  if (typeof paypalProvider.captureApproved === 'function') {
    {
      const { pp, ctx } = setup({ onCapture: 'already' });
      const evt = await paypalProvider.verifyWebhook(approvalBody, headers, ctx);
      const gets = pp.calls.get.length;
      const r = await paypalProvider.captureApproved(evt, ctx);
      check(`ORDER_ALREADY_CAPTURED falls back to a fresh read of the order (${j(r)})`,
        pp.calls.get.length === gets + 1 && r.outcome === 'paid' && r.amountCents === 2400 && r.eventId === 'paypal-capture:CAP-PP1');
    }
    {
      const { ctx } = setup({ onCapture: 'declined' });
      const evt = await paypalProvider.verifyWebhook(approvalBody, headers, ctx);
      let r = null;
      let threw = null;
      try { r = await paypalProvider.captureApproved(evt, ctx); } catch (err) { threw = String(err?.message || err); }
      check(`a funding source PayPal refuses is a DECLINED attempt, not an exception (${r?.outcome ?? `threw: ${threw}`})`,
        threw === null && r?.outcome === 'declined');
    }
    {
      const { ctx } = setup({ onCapture: '500' });
      const evt = await paypalProvider.verifyWebhook(approvalBody, headers, ctx);
      let threw = false;
      try { await paypalProvider.captureApproved(evt, ctx); } catch { threw = true; }
      check('a PayPal outage THROWS, so the webhook is retried', threw);
    }
    {
      const { ctx } = setup({ captureStatus: 'PENDING' });
      const evt = await paypalProvider.verifyWebhook(approvalBody, headers, ctx);
      const r = await paypalProvider.captureApproved(evt, ctx);
      check(`a capture PayPal holds as PENDING is not money yet (${r.outcome})`, r.outcome === 'ignored');
    }
    {
      const { ctx } = setup({ captureAmount: '1.00' });
      const evt = await paypalProvider.verifyWebhook(approvalBody, headers, ctx);
      const r = await paypalProvider.captureApproved(evt, ctx);
      check(`the amount reported is the CAPTURED one (${r.amountCents})`, r.amountCents === 100);
    }
  }

  // The decision.
  const cap = await loadTs('src/lib/payments/capture.ts');
  const base = { total_cents: 2400, currency: 'EUR', payment_status: 'pending', payment_events: [] };
  const approved = { eventId: 'WH-1', reference: 'o', outcome: 'approved', amountCents: 2400, currency: 'EUR', rawType: 'CHECKOUT.ORDER.APPROVED', providerReference: 'PP1' };
  check(`an approval on an unpaid order is to be captured (${cap.decidePaymentEvent(base, approved).action})`,
    cap.decidePaymentEvent(base, approved).action === 'approve');
  check('...and changes no status by itself', cap.decidePaymentEvent(base, approved).paymentStatus === undefined);
  check('an approval on a paid order is ignored', cap.decidePaymentEvent({ ...base, payment_status: 'paid' }, approved).action === 'ignore');
  const wrong = cap.decidePaymentEvent(base, { ...approved, amountCents: 100 });
  check(`an approval for the wrong amount is rejected as suspicious (${j(wrong)})`, wrong.action === 'reject' && wrong.suspicious === true);
});

/* ---- order level: every driver ---- */
const tmpRoot = path.join(os.tmpdir(), `astrobaas-paypal-capture-${process.pid}`);
await fs.mkdir(tmpRoot, { recursive: true });
const DRIVERS = [
  { name: 'lowdb', env: (d) => ({ DB_PATH: path.join(d, 'db.json') }) },
  { name: 'libsql', env: (d) => ({ DATABASE_URL: `file:${path.join(d, 'db.sqlite')}` }) },
  { name: 'relational', env: (d) => ({ DATABASE_URL: `file:${path.join(d, 'db.sqlite')}`, DATABASE_DRIVER: 'relational' }) },
];

for (const driver of DRIVERS) {
  const dir = path.join(tmpRoot, driver.name);
  await fs.mkdir(path.join(dir, 'uploads'), { recursive: true });
  const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    env: {
      ...process.env, PAYPAL_CAPTURE_CHILD: '1', NODE_ENV: 'test',
      AUTH_SECRET: 'paypal-capture-secret-0123456789abcdef',
      PAYMENTS_ENABLED: 'paypal', PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret',
      PAYPAL_WEBHOOK_ID: 'wh', PAYPAL_ENV: 'sandbox',
      STAGING: '', ASTROBAAS_STAGING: '', RATE_LIMIT_STORE: '', SITE_URL: '',
      UPLOADS_DIR: path.join(dir, 'uploads'), ...driver.env(dir),
    },
  });
  const line = (run.stdout || '').split('\n').find((l) => l.startsWith('__RESULT__'));
  if (!line) {
    check(`[${driver.name}] child produced no result\n${(run.stderr || '').slice(-2000)}`, false);
    continue;
  }
  const r = JSON.parse(line.slice('__RESULT__'.length));
  const t = (n, c) => check(`[${driver.name}] ${n}`, c);
  for (const [k, v] of Object.entries(r)) if (v?.error) t(`${k}: scenario threw — ${v.error}`, false);

  const { a, b, c, c2, d, e, f, g, h, h2, i } = r;
  if (a && !a.error) {
    t(`A: an approval is captured ONCE (${a.captures})`, a.captures === 1);
    t(`A: ...and the order is paid and in processing, its stock still held (${j(a)})`,
      a.payment === 'paid' && a.status === 'processing' && a.stock === 3 && a.hook.code === 200);
    t(`A: ...recorded as one capture (${a.captured})`, a.captured === 1);
  }
  if (b && !b.error) {
    t(`B: the same approval delivered again captures nothing more (${b.captures}; ${j([b.first, b.again, b.other])})`,
      b.captures === 1);
    t(`B: ...the order is paid once (${j(b)})`, b.payment === 'paid' && b.status === 'processing' && b.captured === 1 && b.stock === 3);
  }
  if (c && !c.error) {
    t(`C: a capture PayPal cannot answer is retried by PayPal — 500 (${c.hook.code})`, c.hook.code === 500);
    t(`C: ...and the order stays unpaid and open, with its stock (${j(c)})`,
      c.payment !== 'paid' && c.status === 'pending' && c.stock === 3 && c.captures === 1);
  }
  if (c2 && !c2.error) {
    t(`C2: a refused funding source is answered 200, left unpaid, and counted (${j(c2)})`,
      c2.hook.code === 200 && c2.payment !== 'paid' && c2.status === 'pending' && c2.declines === 1 && c2.stock === 3);
  }
  if (d && !d.error) {
    t(`D: an order cancelled with its stock gone is NOT captured (${d.captures})`, d.captures === 0);
    t(`D: ...stays cancelled and unpaid, and nothing is taken from the new buyer (${j(d)})`,
      d.status === 'cancelled' && d.payment !== 'paid' && d.stock === 0 && d.hook.code === 200);
    t(`D: ...and the reason is recorded (${d.notCaptured})`, d.notCaptured === 1);
  }
  if (e && !e.error) {
    t(`E: a capture reporting a different amount is rejected, not applied (${j(e)})`,
      e.captures === 1 && e.payment !== 'paid' && e.rejected === 1);
  }
  if (f && !f.error) {
    t(`F: an approval for the wrong amount is never captured (${f.captures})`, f.captures === 0);
    t(`F: ...and is recorded as suspicious (${j(f)})`, f.rejected === 1 && f.payment !== 'paid');
  }
  if (g && !g.error) {
    t(`G: ORDER_ALREADY_CAPTURED is read back and the order becomes paid (${j(g)})`,
      g.payment === 'paid' && g.status === 'processing' && g.captures === 1);
  }
  if (h && !h.error) {
    t(`H: an order the hold cancelled is reopened and captured when its stock is still there (${j(h)})`,
      h.captures === 1 && h.payment === 'paid' && h.status === 'processing' && h.stock === h.before - 2);
  }
  if (h2 && !h2.error) {
    t(`H2: ...and put back, stock and all, when the capture then fails (${j({ ...h2, redelivered: undefined })})`,
      h2.captures === 1 && h2.status === 'cancelled' && h2.payment !== 'paid' && h2.stock === h2.before);
    t(`H2: ...with the hold's reason restored (${h2.reason})`, h2.reason === 'hold-expired');
    t(`H2: PayPal's redelivery after the outage IS captured, and the order paid (${j(h2.redelivered)})`,
      h2.redelivered.captures === 2 && h2.redelivered.payment === 'paid' && h2.redelivered.status === 'processing'
        && h2.redelivered.stock === h2.before - 2 && h2.redelivered.hook.code === 200);
  }
  const { l, l2, l3 } = r;
  if (l && !l.error) {
    t(`L: the fixture reopened and then cancelled the order as staff (${j({ reopened: l.reopened, cancelled: l.cancelled })})`,
      l.reopened === true && l.cancelled === true);
    t(`L: a reopened order no longer carries the hold's reason (${l.afterReopen})`, l.afterReopen === null);
    t(`L: an order STAFF cancelled after a hold reopen is never captured (${j(l)})`,
      l.captures === 0 && l.status === 'cancelled' && l.payment !== 'paid' && l.stock === l.before && l.hook.code === 200);
    t(`L: ...its cancellation reads as staff's (${l.reason}), and the refusal is recorded (${l.notCaptured})`,
      l.reason === null && l.notCaptured === 1);
  }
  if (l2 && !l2.error) {
    t(`L2: a stale "abandoned" left on an open order does not survive a staff cancel (${j(l2)})`,
      l2.captures === 0 && l2.status === 'cancelled' && l2.stock === l2.before && l2.reason === null && l2.notCaptured === 1);
  }
  if (l3 && !l3.error) {
    t(`L3: the capture path reopened the hold-cancelled order and the wrong-amount capture left it open (${j({ first: l3.first, after: l3.afterFirst })})`,
      l3.first.action === 'reject' && l3.afterFirst.status === 'pending' && l3.afterFirst.payment !== 'paid');
    t(`L3: after staff cancel it, the redelivered approval is NOT captured again (${j(l3)})`,
      l3.captures === 1 && l3.status === 'cancelled' && l3.stock === l3.before && l3.notCaptured === 1 && l3.reason === null);
  }
  if (r.h3 && !r.h3.error) {
    t(`H3: ...and put back when PayPal refuses the funding source (${j(r.h3)})`,
      r.h3.hook.code === 200 && r.h3.captures === 1 && r.h3.status === 'cancelled'
        && r.h3.payment !== 'paid' && r.h3.stock === r.h3.before);
  }
  if (i && !i.error) {
    t(`I: an order STAFF cancelled is never captured, even with stock (${j(i)})`,
      i.captures === 0 && i.status === 'cancelled' && i.stock === i.before && i.notCaptured === 1);
  }
  if (r.m && !r.m.error) {
    t(`M: the abandonment sweep records its reason with the cancel (${j(r.m.swept)})`,
      r.m.swept.status === 'cancelled' && r.m.swept.reason === 'abandoned' && r.m.swept.stock === 5);
    t(`M: ...so a late approval for it is still captured, and the reason goes with the reopen (${j(r.m)})`,
      r.m.captures === 1 && r.m.status === 'processing' && r.m.payment === 'paid' && r.m.stock === 3 && r.m.reason === null);
  }
  if (r.k && !r.k.error) {
    t(`K: a capture that returns another approval is not captured again (${j(r.k)})`,
      r.k.calls === 1 && r.k.threw === null && r.k.action === 'ignore' && r.k.payment !== 'paid');
  }
  if (r.j && !r.j.error) {
    // Only this order's own state: the sweep also expires the earlier
    // scenarios' unpaid orders, which is right.
    t(`J: the hold sweep leaves an order alone while its capture is in progress (${j(r.j)})`,
      r.j.status === 'pending' && r.j.stock === 3);
  }
}

await fs.rm(tmpRoot, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
