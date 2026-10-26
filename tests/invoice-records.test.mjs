#!/usr/bin/env node
/**
 * Invoice and credit-memo RECORDS (lib/commerce/invoice-records*.ts, the
 * routes over them, the PDF).
 *
 * What is proved, and how:
 *
 *  - P: the pure rules — settings, the VAT analysis of a basket priced by the
 *    REAL calculator (totals.ts), the credit-memo split, the triggers, the id
 *    shape. One process, no storage.
 *  - D: the PDF says what the record's state allows it to say. A PDF's text is
 *    glyph ids in a subsetted font (see receipt-pdf.test.mjs), so the
 *    renderer's `trace` seam records every string it draws, and the test reads
 *    that: with no issuer the "not a tax document" line is there and no
 *    document number is; an internal reference is labelled as not an invoice
 *    number; Greek renders.
 *  - S: the write path on ALL THREE drivers, each in its own child process and
 *    database, driven through the real writers: `placeOrder` makes the order,
 *    `applyVerifiedEvent` pays it, `refundOrder` refunds it. The races FORCE
 *    the interleaving the way order-tags.test.mjs does — the interfering call
 *    runs to completion immediately before the first one's decisive write —
 *    and each scenario first proves its hook FIRED.
 *  - R: the routes — roles, validation, conflicts, and the PDF's two doors
 *    (staff, or the buyer's receipt token).
 *
 * Run with:  node tests/invoice-records.test.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, loadTs } from './lib/load.mjs';

const j = JSON.stringify;
const same = (a, b) => j(a) === j(b);

/* ---------------------------------------------------------------- child --- */

function installHook(LocalDB) {
  let pending = null;
  let fired = 0;
  for (const name of ['compareAndSetOrderInvoiceRecords', 'updateOrder']) {
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
/** The write that decides a record change — the CAS under the fix, a blind updateOrder without it. */
const recordWrite = (id) => (name, args) => args[0] === id
  && (name === 'compareAndSetOrderInvoiceRecords' || (name === 'updateOrder' && !!args[1] && 'invoice_records' in args[1]));

async function child(M) {
  const { LocalDB, inv, rules } = M;
  const hook = installHook(LocalDB);
  const out = {};
  const set = (k, v) => LocalDB.updateSetting(k, v);

  // A Greek shop: VAT on, prices include it, a reduced rate, a flat courier.
  await set('tax_enabled', true);
  await set('tax_prices_include_tax', true);
  await set('shop_country', 'GR');
  await set('trader_legal_name', 'Οπτικά Δοκιμή ΙΚΕ');
  await set('trader_vat_number', 'EL999999999');
  const ship = await LocalDB.createShippingMethod({ name: 'Courier', enabled: true, zone: { countries: ['GR'] }, rate: { kind: 'flat', amount_cents: 350 } });
  let n = 0;
  const product = (price, taxClass) => {
    n += 1;
    return LocalDB.createProduct({
      status: 'active', price_cents: price, categories: [], images: [], on_sale: false,
      name: `Item ${n}`, slug: `inv-item-${process.pid}-${n}`, stock: 1000, in_stock: true,
      requires_shipping: true, tax_class: taxClass,
    });
  };
  const A = await product(1240, 'standard');
  const B = await product(1130, 'reduced');
  await LocalDB.createCoupon({ code: 'INV10', kind: 'percent', value: 1000, enabled: true, used_count: 0 });

  // The stub payment provider: refunds by idempotency key, as real ones do.
  const issued = new Map();
  M.registry.setPluginProviders([{
    id: 'inv-stub', label: 'Inv stub', requiredEnv: [],
    createSession: async () => ({ reference: 'x', redirectUrl: 'https://example.invalid' }),
    verifyWebhook: async () => { throw new Error('unused'); },
    refund: async (_o, amountCents, key) => {
      if (!issued.has(key)) issued.set(key, { refundId: `re_${issued.size + 1}`, amountCents });
      return issued.get(key);
    },
  }]);

  let buyerN = 0;
  const place = async (over = {}) => {
    buyerN += 1;
    const r = await M.placeOrder({
      email: `inv${buyerN}@example.com`, name: 'Γιώργος Πελάτης',
      items: [{ product_id: A.id, qty: 2 }, { product_id: B.id, qty: 1 }],
      shipping_country: 'GR', shipping_postcode: '10431', shipping_method_id: ship.id,
      coupon_code: 'INV10',
      shipping_address: { name: 'Γιώργος Πελάτης', line1: 'Οδός 1', city: 'Αθήνα', postcode: '10431', country: 'GR', tax_id: over.tax_id ?? 'EL000000000' },
      payment_method: 'card',
    });
    if (!r.ok) throw new Error(`placeOrder failed: ${r.message}`);
    await LocalDB.updateOrder(r.value.id, { payment_provider: 'inv-stub', payment_reference: 'x' });
    return r.value;
  };
  // The automatic paths issue in the background (an issuer must not hold up a
  // webhook); these helpers wait for that, so what is read next is settled.
  const payNow = (o, evt) => M.applyVerifiedEvent({
    eventId: evt ?? `evt_${o.id}`, reference: o.id, outcome: "paid", amountCents: o.total_cents, currency: o.currency, rawType: "inv.paid",
  });
  const pay = async (o, evt) => { const r = await payNow(o, evt); await inv.whenInvoiceIssuesSettled(); return r; };
  const refund = async (...a) => { const r = await M.refundOrder(...a); await inv.whenInvoiceIssuesSettled(); return r; };
  const docsOf = async (id) => rules.invoiceDocumentsOf(await LocalDB.getOrder(id));

  // The test issuer, switched on per scenario.
  const issuer = { calls: [], mode: 'off', answer: { ok: true, number: 'TST-1', identifiers: { mark: '400001', qr: 'https://example.invalid/qr' } } };
  M.pluginManager.registerPlugin({
    id: 'inv-test-issuer', name: 'Test issuer', version: '1.0.0', description: 'test', author: 'test',
    filters: {
      [M.PLUGIN_HOOKS.INVOICE_ISSUERS]: (list) => (issuer.mode === 'off' ? list : [...list, {
        id: 'test-issuer', label: 'Test Issuer',
        issue: async (doc, ctx) => {
          issuer.calls.push({ id: doc.id, kind: doc.kind, order: ctx.order?.id, invoice: ctx.invoice?.id ?? null });
          await new Promise((r) => setTimeout(r, 5));
          return typeof issuer.answer === 'function' ? issuer.answer(doc) : issuer.answer;
        },
      }]),
    },
  });
  M.pluginManager.activatePlugin('inv-test-issuer');
  // A checkout filter that tries to plant a record on a new order.
  const plant = { on: false };
  M.pluginManager.registerPlugin({
    id: 'inv-test-planter', name: 'Planter', version: '1.0.0', description: 'test', author: 'test',
    filters: {
      [M.PLUGIN_HOOKS.BEFORE_ORDER_SAVE]: (draft) => (plant.on
        ? { ...draft, invoice_records: [{ id: 'x.inv-1', kind: 'invoice', status: 'final', total_cents: 1 }] }
        : draft),
    },
  });
  M.pluginManager.activatePlugin('inv-test-planter');

  /* ---- S0: a checkout filter cannot plant a record on a new order ---- */
  {
    plant.on = true;
    const o = await place();
    plant.on = false;
    out.s0 = { planted: (await docsOf(o.id)).length };
  }

  /* ---- S1: a paid order gets ONE final record, VAT per rate as charged ---- */
  {
    const o = await place({ tax_id: 'not-a-real-ΑΦΜ 123' });
    const placed = await LocalDB.getOrder(o.id);
    const before = await docsOf(o.id);
    await pay(o);
    const docs = await docsOf(o.id);
    const rec = docs[0];
    const expect = {};
    for (const l of placed.line_totals) {
      const k = l.tax_rate_bp;
      expect[k] = expect[k] ?? { base: 0, tax: 0 };
      expect[k].base += l.net_cents;
      expect[k].tax += l.tax_cents;
    }
    out.s1 = {
      placedOk: !!placed, recordsBefore: before.length, count: docs.length,
      kind: rec?.kind, status: rec?.status, trigger: rec?.trigger, vatComplete: rec?.vat_complete,
      total: rec?.total_cents, orderTotal: placed.total_cents,
      tax: rec?.tax_cents, orderTax: placed.tax_cents,
      vat: rec?.vat, goodsVat: expect, shippingTax: placed.shipping_tax_cents,
      rates: (rec?.vat ?? []).map((v) => v.rate_bp),
      vatSum: (rec?.vat ?? []).reduce((s, v) => s + v.tax_cents, 0),
      buyerTaxId: rec?.buyer?.tax_id, seller: rec?.seller?.name, sellerVat: rec?.seller?.tax_id,
      currency: rec?.currency, id: rec?.id, idParses: rules.orderIdOfDocument(rec?.id) === o.id,
      payment: (await LocalDB.getOrder(o.id)).payment_status,
    };

    // A second payment event / a second sync / a create: still one record.
    await pay(o, `evt_again_${o.id}`);
    await inv.syncInvoiceRecords(o.id);
    const again = await inv.createInvoiceRecord(o.id, { finalise: true });

    // Changing the tax table afterwards changes nothing on the record.
    const frozen = j((await docsOf(o.id))[0]);
    await set('tax_rates', [{ class: 'standard', label: 'Std', rate_bp: 2700 }, { class: 'reduced', label: 'Red', rate_bp: 500 }]);
    await LocalDB.updateOrder(o.id, { line_totals: placed.line_totals.map((l) => ({ ...l, tax_rate_bp: 2700 })) });
    await inv.syncInvoiceRecords(o.id);
    out.s1b = {
      count: (await docsOf(o.id)).length, createdAgain: again.ok && again.value.created,
      unchanged: j((await docsOf(o.id))[0]) === frozen,
    };
    await set('tax_rates', null);
    out.s1Order = o.id;
  }

  /* ---- S2: a 50% refund → a credit memo against the record; the rest → nets to zero ---- */
  {
    const o = await place();
    await pay(o);
    const half = Math.floor(o.total_cents / 2);
    const r1 = await refund(o.id, half, 'admin-a', 'http://localhost');
    const d1 = await docsOf(o.id);
    const r2 = await refund(o.id, null, 'admin-a', 'http://localhost');
    const d2 = await docsOf(o.id);
    const invRec = d2.find((d) => d.kind === 'invoice');
    const memos = d2.filter((d) => d.kind === 'credit_memo');
    const perLine = invRec.lines.map((l, i) => {
      const c = memos.flatMap((m) => m.lines).filter((x) => x.invoice_line === i);
      return [l.net_cents - c.reduce((s, x) => s + x.net_cents, 0), l.tax_cents - c.reduce((s, x) => s + x.tax_cents, 0)];
    });
    const m1 = d1.find((d) => d.kind === 'credit_memo');
    out.s2 = {
      refunded: r1.ok && r2.ok, half,
      memo: m1 ? { total: m1.total_cents, refs: m1.invoice_record_id === invRec.id, refund: m1.refund_id, lines: m1.lines.length, vat: m1.vat.map((v) => v.rate_bp), status: m1.status } : null,
      memo1VatSum: m1 ? m1.vat.reduce((s, v) => s + v.tax_cents, 0) : null,
      invoiceTax: invRec.tax_cents,
      memoCount: memos.length,
      creditedTotal: memos.reduce((s, m) => s + m.total_cents, 0), invoiceTotal: invRec.total_cents,
      perLineLeft: perLine,
      refundIds: memos.map((m) => m.refund_id).sort(),
      ledger: ((await LocalDB.getOrder(o.id)).refunds ?? []).map((x) => x.id).sort(),
    };
    // Syncing again adds no memo for a refund that has one.
    await inv.syncInvoiceRecords(o.id);
    out.s2.memoCountAfterSync = (await docsOf(o.id)).filter((d) => d.kind === 'credit_memo').length;
    // A fully REFUNDED order is not re-invoiced by "create".
    const again = await inv.createInvoiceRecord(o.id, { finalise: true });
    out.s2.recreate = again.ok ? 'created' : again.code;
    out.s2.invoicesAfter = (await docsOf(o.id)).filter((d) => d.kind === 'invoice').length;
  }

  /* ---- S2b: a refund made at the PROVIDER (dashboard) is credited from its webhook ---- */
  {
    const o = await place();
    await pay(o);
    await refund(o.id, 300, 'admin-a', 'http://localhost');
    await M.applyVerifiedEvent({ eventId: `evt_ref_${o.id}`, reference: o.id, outcome: 'refunded', amountCents: o.total_cents, currency: o.currency, rawType: 'inv.refunded' });
    await inv.whenInvoiceIssuesSettled();
    const docs = await docsOf(o.id);
    const memos = docs.filter((d) => d.kind === 'credit_memo');
    const invRec = docs.find((d) => d.kind === 'invoice');
    out.s2b = {
      payment: (await LocalDB.getOrder(o.id)).payment_status,
      memos: memos.map((m) => [m.refund_id === 're_1' || /^re_/.test(m.refund_id) ? 'ledger' : m.refund_id, m.total_cents]),
      net: invRec.total_cents - memos.reduce((s, m) => s + m.total_cents, 0),
      expectedProvider: o.total_cents - 300,
    };
  }

  /* ---- S3: two concurrent "create final" → one final record ---- */
  {
    await set('invoice_record_on', 'manual');
    const o = await place();
    await pay(o);
    let second = null;
    const fired = hook.before(recordWrite(o.id), async () => { second = await inv.createInvoiceRecord(o.id, { finalise: true }); });
    const first = await inv.createInvoiceRecord(o.id, { finalise: true });
    hook.disarm();
    const docs = await docsOf(o.id);
    out.s3 = {
      fired: fired(), firstOk: first.ok, secondOk: second?.ok,
      created: [first.ok && first.value.created, second?.ok && second.value.created].sort(),
      invoices: docs.filter((d) => d.kind === 'invoice').length,
      sameId: first.ok && second?.ok && first.value.record.id === second.value.record.id,
    };
    // Five at once, no forced order.
    const o2 = await place();
    await pay(o2);
    const many = await Promise.all(Array.from({ length: 5 }, () => inv.createInvoiceRecord(o2.id, { finalise: true })));
    out.s3b = { ok: many.filter((r) => r.ok).length, invoices: (await docsOf(o2.id)).filter((d) => d.kind === 'invoice').length };
  }

  /* ---- S4: two concurrent FINALISE of one draft → one final record, issuer called once ---- */
  {
    issuer.mode = 'on';
    issuer.calls = [];
    issuer.answer = { ok: true, number: 'TST-1', identifiers: { mark: '400001', qr: 'https://example.invalid/qr' } };
    const o = await place();
    await pay(o);
    const draft = await inv.createInvoiceRecord(o.id, { finalise: false });
    const draftId = draft.ok ? draft.value.record.id : null;
    let second = null;
    const fired = hook.before(recordWrite(o.id), async () => { second = await inv.finaliseInvoiceRecord(o.id, draftId); });
    const first = await inv.finaliseInvoiceRecord(o.id, draftId);
    hook.disarm();
    const docs = await docsOf(o.id);
    const rec = docs.find((d) => d.id === draftId);
    out.s4 = {
      fired: fired(), draftStatus: draft.ok ? draft.value.record.status : null,
      firstOk: first.ok, secondOk: second?.ok, invoices: docs.filter((d) => d.kind === 'invoice').length,
      status: rec?.status, issuerCalls: issuer.calls.filter((c) => c.id === draftId).length,
      issuer: rec?.issuer ? { id: rec.issuer.id, status: rec.issuer.status, number: rec.issuer.number, mark: rec.issuer.identifiers?.mark } : null,
      state: rec ? rules.documentState(rec) : null,
    };

    // A refund now → its memo goes to the issuer too, once, with the invoice in context.
    const before = issuer.calls.length;
    await refund(o.id, 500, 'admin-a', 'http://localhost');
    const memo = (await docsOf(o.id)).find((d) => d.kind === 'credit_memo');
    const memoCalls = issuer.calls.slice(before);
    out.s4b = {
      memo: !!memo, calls: memoCalls.length, kind: memoCalls[0]?.kind, ctxInvoice: memoCalls[0]?.invoice === draftId,
      state: memo ? rules.documentState(memo) : null,
    };

    // A record marked issued elsewhere is never sent to the issuer.
    const o2 = await place();
    await pay(o2);
    const d2 = await inv.createInvoiceRecord(o2.id, { finalise: false });
    const marked = await inv.markIssuedExternally(o2.id, d2.value.record.id, 'u-admin', 'ΑΠΥ 77');
    const callsBefore = issuer.calls.length;
    const fin = await inv.finaliseInvoiceRecord(o2.id, d2.value.record.id);
    const retry = await inv.issueInvoiceDocument(o2.id, d2.value.record.id);
    const r2 = (await docsOf(o2.id)).find((d) => d.kind === 'invoice');
    out.s4c = {
      marked: marked.ok, finalised: fin.ok, retryRefused: !retry.ok && retry.code,
      calls: issuer.calls.length - callsBefore, state: rules.documentState(r2), number: r2.issued_externally?.number, issuer: r2.issuer ?? null,
    };

    // An order that already carries the POS document number → issued elsewhere by itself.
    await set('invoice_record_on', 'paid');
    const o3 = await place();
    await LocalDB.updateOrder(o3.id, { external_receipt_no: 'POS-123' });
    const callsBefore3 = issuer.calls.length;
    await pay(o3);
    const r3 = (await docsOf(o3.id)).find((d) => d.kind === 'invoice');
    // ...and its refund's credit memo is issued elsewhere too, never sent here.
    await refund(o3.id, 400, 'admin-a', 'http://localhost');
    const m3 = (await docsOf(o3.id)).find((d) => d.kind === 'credit_memo');
    out.s4d = {
      state: r3 ? rules.documentState(r3) : null, number: r3?.issued_externally?.number, calls: issuer.calls.length - callsBefore3,
      memoState: m3 ? rules.documentState(m3) : null, memoIssuer: m3?.issuer ?? null,
    };

    // B4: the issuer runs AFTER the payment path returns, not inside it.
    issuer.answer = async () => { await new Promise((r) => setTimeout(r, 400)); return { ok: true, number: 'SLOW-1' }; };
    const o4 = await place();
    const t0 = Date.now();
    await payNow(o4);
    const took = Date.now() - t0;
    const mid = (await docsOf(o4.id)).find((d) => d.kind === 'invoice');
    await inv.whenInvoiceIssuesSettled();
    const end = (await docsOf(o4.id)).find((d) => d.kind === 'invoice');
    out.s4e = { took, midState: mid ? rules.documentState(mid) : null, endState: end ? rules.documentState(end) : null, number: end?.issuer?.number };
    issuer.answer = { ok: true, number: 'TST-1' };
  }

  /* ---- S5: an issuer that rejects the tax id → shown on the record, never blocks ---- */
  {
    issuer.answer = { ok: false, error: 'ΑΦΜ not valid at the authority' };
    const o = await place({ tax_id: '123' });
    const placedOk = !!o?.id;
    await pay(o);
    let rec = (await docsOf(o.id)).find((d) => d.kind === 'invoice');
    const failed = { state: rules.documentState(rec), error: rec.issuer?.error, status: rec.status };
    const order = await LocalDB.getOrder(o.id);
    // A refund against that UNISSUED record: its memo is not sent to the issuer.
    issuer.answer = { ok: true, number: 'TST-2' };
    const nm = issuer.calls.length;
    await refund(o.id, 100, 'admin-a', 'http://localhost');
    let memo = (await docsOf(o.id)).find((d) => d.kind === 'credit_memo');
    const memoBefore = { state: rules.documentState(memo), calls: issuer.calls.length - nm, error: memo.issuer?.error ?? '' };
    const retry = await inv.issueInvoiceDocument(o.id, rec.id);
    rec = (await docsOf(o.id)).find((d) => d.kind === 'invoice');
    // Once the invoice is issued, the memo can be sent by hand.
    const memoRetry = await inv.issueInvoiceDocument(o.id, memo.id);
    memo = (await docsOf(o.id)).find((d) => d.kind === 'credit_memo');
    const memoAfter = { called: memoRetry.ok && memoRetry.called, state: rules.documentState(memo) };
    // A second retry once issued: nothing is sent.
    const n0 = issuer.calls.length;
    const again = await inv.issueInvoiceDocument(o.id, rec.id);
    out.s5 = {
      placedOk, failed, payment: order.payment_status, orderStatus: order.status,
      retried: retry.ok && retry.called, state: rules.documentState(rec), number: rec.issuer?.number,
      againCalled: again.ok ? again.called : 'err', callsAfter: issuer.calls.length - n0,
      memoBefore, memoAfter,
    };
    issuer.mode = 'off';
  }

  /* ---- S6: no issuer, an internal reference: sequential, labelled, only once ---- */
  {
    await set('invoice_internal_reference_format', 'REF-{year}-{n}');
    const a = await place();
    await pay(a);
    const b = await place();
    await pay(b);
    const ra = (await docsOf(a.id)).find((d) => d.kind === 'invoice');
    const rb = (await docsOf(b.id)).find((d) => d.kind === 'invoice');
    const na = Number(/-(\d+)$/.exec(ra?.internal_reference ?? '')?.[1]);
    const nb = Number(/-(\d+)$/.exec(rb?.internal_reference ?? '')?.[1]);
    out.s6 = { a: ra?.internal_reference, b: rb?.internal_reference, next: nb === na + 1, issuer: ra?.issuer ?? null, year: String(ra?.internal_reference).includes(String(new Date().getFullYear())) };
    await set('invoice_internal_reference_format', '');
  }

  /* ---- S7: the triggers — completed (bank transfer), manual, shipped ---- */
  {
    const bt = await place();
    await LocalDB.updateOrder(bt.id, { payment_provider: undefined, payment_method: 'bank-transfer' });
    const beforeDone = (await docsOf(bt.id)).length;
    await M.setOrderStatus(bt.id, 'processing', 'u-admin');
    await M.setOrderStatus(bt.id, 'completed', 'u-admin');
    const afterDone = (await docsOf(bt.id)).length;

    await set('invoice_record_on', 'manual');
    const man = await place();
    await pay(man);
    const manual = (await docsOf(man.id)).length;

    await set('invoice_record_on', 'shipped');
    const sh = await place();
    await pay(sh);
    const paidOnly = (await docsOf(sh.id)).length;
    await LocalDB.updateOrder(sh.id, { shipped_at: new Date().toISOString() });
    await inv.syncInvoiceRecords(sh.id);
    const shipped = (await docsOf(sh.id)).find((d) => d.kind === 'invoice');
    out.s7 = { beforeDone, afterDone, manual, paidOnly, shippedTrigger: shipped?.trigger };
    await set('invoice_record_on', 'paid');
  }

  /* ---- S8: a correction — credit in full, then a corrected record; the earlier refund is credited again ---- */
  {
    const o = await place();
    await pay(o);
    await refund(o.id, 300, 'admin-a', 'http://localhost');
    const first = (await docsOf(o.id)).find((d) => d.kind === 'invoice');
    const cancelFinal = await inv.cancelInvoiceRecord(o.id, first.id);
    const credit = await inv.creditInvoiceInFull(o.id, first.id);
    const creditAgain = await inv.creditInvoiceInFull(o.id, first.id);
    const fresh = await inv.createInvoiceRecord(o.id, { finalise: true });
    const docs = await docsOf(o.id);
    const invoices = docs.filter((d) => d.kind === 'invoice');
    const memos = docs.filter((d) => d.kind === 'credit_memo');
    const net = invoices.reduce((s, d) => s + d.total_cents, 0) - memos.reduce((s, d) => s + d.total_cents, 0);
    out.s8 = {
      cancelFinal: cancelFinal.ok ? 'ok' : cancelFinal.code,
      credit: credit.ok && !credit.value.refund_id, creditAgainSame: creditAgain.ok && !creditAgain.changed,
      fresh: fresh.ok && fresh.value.created, invoices: invoices.length,
      memosForRefund: memos.filter((m) => m.refund_id).map((m) => m.invoice_record_id === first.id ? 'old' : 'new').sort(),
      netOfBooks: net, charged: o.total_cents - 300,
    };
  }

  /* ---- R: routes ---- */
  {
    const admin = { id: 'u-admin', role: 'admin' };
    const manager = { id: 'u-man', role: 'manager' };
    const call = async (fn, { user = admin, params = {}, url = 'http://localhost/api/x', method = 'GET', body } = {}) => {
      const res = await fn({
        params, url: new URL(url), locals: { user, ip: '203.0.113.7' },
        request: new Request(url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }),
      });
      const type = res.headers.get('content-type') ?? '';
      const json = type.includes('json') ? await res.json().catch(() => null) : null;
      const bytes = type.includes('pdf') ? new Uint8Array(await res.arrayBuffer()) : null;
      return { status: res.status, json, type, bytes, disposition: res.headers.get('content-disposition') };
    };
    await set('invoice_record_on', 'manual');
    const o = await place();
    const other = await place();
    const p = { id: o.id };
    const list0 = await call(M.getRecords, { params: p });
    const mgrRead = await call(M.getRecords, { params: p, user: manager });
    const anonRead = await call(M.getRecords, { params: p, user: null });
    const mgrWrite = await call(M.postRecords, { params: p, method: 'POST', body: { action: 'create' }, user: manager });
    const editorWrite = await call(M.postRecords, { params: p, method: 'POST', body: { action: 'create' }, user: { id: 'u-ed', role: 'editor' } });
    const bad = await call(M.postRecords, { params: p, method: 'POST', body: { action: 'edit' } });
    const noId = await call(M.postRecords, { params: p, method: 'POST', body: { action: 'finalise' } });
    const badNum = await call(M.postRecords, { params: p, method: 'POST', body: { action: 'create', finalise: 'yes' } });
    const created = await call(M.postRecords, { params: p, method: 'POST', body: { action: 'create' } });
    const draftId = created.json?.data?.record?.id;
    const createdAgain = await call(M.postRecords, { params: p, method: 'POST', body: { action: 'create' } });
    const markup = await call(M.postRecords, { params: p, method: 'POST', body: { action: 'issued_externally', record_id: draftId, number: '<b>' } });

    // The PDF's doors, on a DRAFT: staff yes, the buyer's token no.
    const token = M.makeReceiptToken(o.id);
    const pdfUrl = (id, q = '') => `http://localhost/api/invoice-records/${encodeURIComponent(id)}/pdf${q}`;
    const staffDraft = await call(M.getRecordPdf, { params: { id: draftId }, url: pdfUrl(draftId) });
    const buyerDraft = await call(M.getRecordPdf, { params: { id: draftId }, url: pdfUrl(draftId, `?token=${encodeURIComponent(token)}`), user: null });

    const fin = await call(M.postRecords, { params: p, method: 'POST', body: { action: 'finalise', record_id: draftId } });
    const finAgain = await call(M.postRecords, { params: p, method: 'POST', body: { action: 'finalise', record_id: draftId } });
    const cancelFinal = await call(M.postRecords, { params: p, method: 'POST', body: { action: 'cancel', record_id: draftId } });
    const missing = await call(M.postRecords, { params: p, method: 'POST', body: { action: 'finalise', record_id: `${o.id}.inv-99` } });
    const missingOrder = await call(M.getRecords, { params: { id: 'nope' } });

    const buyer = await call(M.getRecordPdf, { params: { id: draftId }, url: pdfUrl(draftId, `?token=${encodeURIComponent(token)}`), user: null });
    const wrongToken = await call(M.getRecordPdf, { params: { id: draftId }, url: pdfUrl(draftId, `?token=${encodeURIComponent(M.makeReceiptToken(other.id))}`), user: null });
    const noToken = await call(M.getRecordPdf, { params: { id: draftId }, url: pdfUrl(draftId), user: null });
    const junkId = await call(M.getRecordPdf, { params: { id: 'junk' }, url: pdfUrl('junk') });

    // PUT /api/orders/{id} cannot write records.
    const put = await call(M.putOrder, { params: p, method: 'PUT', body: { note: 'n', invoice_records: [] } });
    const afterPut = await docsOf(o.id);

    out.r = {
      list0: [list0.status, list0.json?.data?.records?.length, list0.json?.data?.record_on, list0.json?.data?.issuer],
      mgrRead: mgrRead.status, anonRead: anonRead.status, mgrWrite: mgrWrite.status, editorWrite: editorWrite.status,
      bad: [bad.status, noId.status, badNum.status, markup.status], badReason: bad.json?.error?.reason,
      created: [created.status, created.json?.data?.record?.status, created.json?.data?.record?.state],
      createdAgain: [createdAgain.status, createdAgain.json?.data?.records?.length],
      staffDraft: [staffDraft.status, staffDraft.type, staffDraft.bytes ? Buffer.from(staffDraft.bytes.slice(0, 5)).toString('latin1') : null],
      buyerDraft: buyerDraft.status,
      fin: [fin.status, fin.json?.data?.record?.status], finAgain: finAgain.status,
      cancelFinal: [cancelFinal.status, cancelFinal.json?.error?.reason],
      missing: missing.status, missingOrder: missingOrder.status,
      buyer: [buyer.status, buyer.type], wrongToken: wrongToken.status, noToken: noToken.status, junkId: junkId.status,
      disposition: staffDraft.disposition,
      put: put.status, afterPut: afterPut.length,
    };
    await set('invoice_record_on', 'paid');
  }

  /* ---- G: an erasure removes the buyer from the record and keeps the figures ---- */
  {
    const o = await place();
    await pay(o);
    const before = (await docsOf(o.id)).find((d) => d.kind === 'invoice');
    await M.eraseSubject(o.email);
    const after = (await docsOf(o.id)).find((d) => d.kind === 'invoice');
    out.g = {
      had: !!before?.buyer?.tax_id && !!before?.buyer?.name,
      buyer: after?.buyer, total: after?.total_cents === before?.total_cents, vat: same(after?.vat, before?.vat),
      leaks: j(after).includes('Γιώργος') || j(after).includes(o.email),
    };
  }

  /* ---- G2: a record decided just BEFORE an erasure does not land on the erased order ---- */
  {
    await set('invoice_record_on', 'manual');
    const o = await place();
    await pay(o);
    const fired = hook.before(recordWrite(o.id), async () => { await M.eraseSubject(o.email); });
    const r = await inv.createInvoiceRecord(o.id, { finalise: true });
    hook.disarm();
    const after = await LocalDB.getOrder(o.id);
    out.g2 = {
      fired: fired(), erased: typeof after.erased_at === 'string', result: r.ok ? 'ok' : r.code,
      records: rules.invoiceDocumentsOf(after).length, leaks: j(after.invoice_records ?? null).includes('Γιώργος'),
    };
    await set('invoice_record_on', 'paid');
  }

  return out;
}

if (process.env.INVOICE_RECORDS_CHILD) {
  const M = await loadTs('tests/fixtures/invoice-records-entry.ts', 'invrec');
  await M.LocalDB.init();
  const result = await child(M);
  console.log('__RESULT__' + JSON.stringify(result));
  process.exit(0);
}

/* --------------------------------------------------------------- parent --- */
let pass = 0;
let fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };

/* ---- P: pure rules ---- */
const R = await loadTs('src/lib/commerce/invoice-records-rules.ts', 'invrules');
const T = await loadTs('src/lib/commerce/totals.ts', 'invtotals');
const SV = await loadTs('src/lib/settings-validate.ts', 'invsv');
const SC = await loadTs('src/lib/api-key-scopes.ts', 'invscope');
{
  check('P0: an API key needs the ORDERS scope for a record PDF', SC.requiredScopeFor('GET', '/api/invoice-records/o.inv-1/pdf') === 'orders:read'
    && SC.requiredScopeFor('POST', '/api/orders/o/invoice-records') === 'orders:write');
  check('P1: defaults — paid, no reference, no issuer', same(R.resolveInvoiceSettings({}), { recordOn: 'paid', referenceFormat: null, issuerId: null }));
  check('P1: junk reads as the default', same(R.resolveInvoiceSettings({ invoice_record_on: 'sometimes', invoice_internal_reference_format: 'no-n', invoice_issuer: 'Bad Id!' }),
    { recordOn: 'paid', referenceFormat: null, issuerId: null }));
  check('P1: the real keys are read (keys come from the module that owns them)', same(R.resolveInvoiceSettings({
    [R.INVOICE_SETTING_KEYS.recordOn]: 'shipped', [R.INVOICE_SETTING_KEYS.referenceFormat]: ' R-{n} ', [R.INVOICE_SETTING_KEYS.issuer]: 'mydata-x',
  }), { recordOn: 'shipped', referenceFormat: 'R-{n}', issuerId: 'mydata-x' }));
  const v = (k, x) => SV.validateSetting(k, x);
  check('P2: settings-validate refuses a bad trigger, format and issuer', !!v('invoice_record_on', 'often') && !!v('invoice_internal_reference_format', 'REF') && !!v('invoice_internal_reference_format', '<b>{n}') && !!v('invoice_issuer', 'Has Space'));
  check('P2: ...accepts good ones and empty', v('invoice_record_on', 'manual') === null && v('invoice_internal_reference_format', 'INT/{year}/{n}') === null && v('invoice_internal_reference_format', '') === null && v('invoice_issuer', '') === null);
  check('P2: only {n} and {year} are placeholders', !!R.referenceFormatProblem('{n}-{x}'));
  check('P2: formatting', R.formatInternalReference('REF-{year}-{n}', 7, '2026-10-12T00:00:00Z') === 'REF-2026-7');

  check('P3: triggers', R.triggerReached({ payment_status: 'paid' }, 'paid') && R.triggerReached({ payment_status: 'refunded' }, 'paid')
    && !R.triggerReached({ payment_status: 'pending' }, 'paid') && R.triggerReached({ status: 'completed' }, 'paid')
    && !R.triggerReached({ payment_status: 'paid' }, 'shipped') && R.triggerReached({ shipped_at: '2026-01-01' }, 'shipped')
    && !R.triggerReached({ status: 'completed', payment_status: 'paid' }, 'manual'));
  check('P4: a record id names its order, dots and all', R.orderIdOfDocument('a.b.c.inv-12') === 'a.b.c' && R.orderIdOfDocument('x.cm-1') === 'x'
    && R.orderIdOfDocument('x.inv-') === null && R.orderIdOfDocument('plain') === null && R.orderIdOfDocument(7) === null);
  check('P4: ids count per kind', R.nextDocumentId('o1', [{ id: 'o1.inv-1', kind: 'invoice' }, { id: 'o1.cm-3', kind: 'credit_memo' }], 'credit_memo') === 'o1.cm-4');

  // A basket priced by the REAL calculator: two rates, a discount, taxed shipping.
  for (const inclusive of [true, false]) {
    const tax = { enabled: true, pricesIncludeTax: inclusive, defaultClass: 'standard', shippingClass: 'standard', originCountry: 'GR',
      rates: [{ class: 'standard', label: 'S', rate_bp: 2400 }, { class: 'reduced', label: 'R', rate_bp: 1300 }] };
    const t = T.calculateTotals({
      lines: [
        { product_id: 'a', name: 'Frames', qty: 3, unit_price_cents: 3333, tax_class: 'standard' },
        { product_id: 'b', name: 'Lens cleaner', qty: 1, unit_price_cents: 777, tax_class: 'reduced' },
      ],
      discount_cents: 1001, shipping_cents: 499, tax,
    });
    check(`P5[${inclusive ? 'incl' : 'excl'}]: the calculator reconciles (precondition)`, T.totalsReconcile(t));
    const order = {
      id: 'o', number: 'OG-1', currency: 'EUR', status: 'processing', payment_status: 'paid', email: 'b@x',
      items: [{ product_id: 'a', name: 'Frames', qty: 3, total_cents: 0 }, { product_id: 'b', name: 'Lens cleaner', qty: 1, total_cents: 0 }],
      line_totals: t.lines, total_cents: t.total_cents, tax_cents: t.tax_cents, subtotal_cents: t.subtotal_cents,
      discount_cents: t.discount_cents, shipping_cents: t.shipping_cents, shipping_tax_cents: t.shipping_tax_cents,
      prices_include_tax: t.prices_include_tax, shipping_method_name: 'Courier',
      billing_address: { name: 'Β', country: 'gr', tax_id: '  EL 12 3  ' },
      created_at: '', updated_at: '',
    };
    const rec = R.buildInvoiceRecord({ id: 'o.inv-1', order, seller: { name: 'S' }, buyer: R.buyerOf(order, () => 'addr'), trigger: 'paid', status: 'final', now: '2026-10-12T00:00:00Z' });
    const by = Object.fromEntries(rec.vat.map((v) => [v.rate_bp, v]));
    const goods24 = t.lines.filter((l) => l.tax_rate_bp === 2400);
    check(`P5[${inclusive ? 'incl' : 'excl'}]: total and VAT equal what was charged (${rec.total_cents}/${t.total_cents}, ${rec.tax_cents}/${t.tax_cents})`,
      rec.total_cents === t.total_cents && rec.tax_cents === t.tax_cents && rec.vat_complete === true);
    check(`P5[${inclusive ? 'incl' : 'excl'}]: VAT per rate — 24% carries goods AND shipping, 13% the reduced line`,
      by[2400].tax_cents === goods24.reduce((s, l) => s + l.tax_cents, 0) + t.shipping_tax_cents
      && by[1300].tax_cents === t.lines.find((l) => l.tax_rate_bp === 1300).tax_cents && rec.vat.length === 2);
    check(`P5[${inclusive ? 'incl' : 'excl'}]: the shipping line's rate is the one that reproduces its tax`, rec.lines.find((l) => l.kind === 'shipping').tax_rate_bp === 2400);
    check(`P5[${inclusive ? 'incl' : 'excl'}]: each line adds up`, rec.lines.every((l) => l.total_cents === l.net_cents + l.tax_cents));
    check('P5: the buyer tax id is kept as typed (trimmed), never validated', rec.buyer.tax_id === 'EL 12 3' && rec.buyer.country === 'GR');

    // Credit memos over that record: 37% then the rest.
    const part = Math.round(rec.total_cents * 0.37);
    const m1 = R.buildCreditMemo({ id: 'o.cm-1', invoice: rec, docs: [rec], amount_cents: part, refund_id: 'r1', now: 'x' });
    const m2 = R.buildCreditMemo({ id: 'o.cm-2', invoice: rec, docs: [rec, m1], amount_cents: rec.total_cents, refund_id: 'r2', now: 'x' });
    const m3 = R.buildCreditMemo({ id: 'o.cm-3', invoice: rec, docs: [rec, m1, m2], amount_cents: 100, now: 'x' });
    check(`P6[${inclusive ? 'incl' : 'excl'}]: a partial memo is exactly the refund (${m1.total_cents}/${part})`, m1.total_cents === part && m1.lines.every((l) => l.qty === undefined));
    check(`P6[${inclusive ? 'incl' : 'excl'}]: its VAT is split per rate in proportion`, m1.vat.length === 2
      && Math.abs(m1.tax_cents - Math.round(rec.tax_cents * 0.37)) <= rec.lines.length);
    check(`P6[${inclusive ? 'incl' : 'excl'}]: the second memo is the exact remainder — every line nets to zero, net and VAT`,
      rec.lines.every((l, i) => {
        const c = [m1, m2].flatMap((m) => m.lines).filter((x) => x.invoice_line === i);
        return c.reduce((s, x) => s + x.net_cents, 0) === l.net_cents && c.reduce((s, x) => s + x.tax_cents, 0) === l.tax_cents;
      }));
    check('P6: nothing left → no memo', m3 === null);
  }
  const full = R.buildCreditMemo({
    id: 'o.cm-1', docs: [], amount_cents: 9999, refund_id: 'r', now: 'x',
    invoice: { id: 'o.inv-1', order_id: 'o', currency: 'EUR', prices_include_tax: true, vat: [{ rate_bp: 2400, base_cents: 100, tax_cents: 24 }],
      lines: [{ kind: 'goods', description: 'x', qty: 2, net_cents: 100, tax_rate_bp: 2400, tax_cents: 24, total_cents: 124 }], total_cents: 124 },
  });
  check('P6: a refund above what is left is capped, and a whole line keeps its quantity', full.total_cents === 124 && full.lines[0].qty === 2);

  // An order from before the breakdown was stored: no rates are invented.
  const legacy = R.buildInvoiceRecord({ id: 'l.inv-1', order: { id: 'l', currency: 'EUR', items: [{ name: 'Old', qty: 1, total_cents: 1000 }], total_cents: 1000, email: '' },
    seller: {}, buyer: {}, trigger: 'manual', status: 'draft', now: 'x' });
  check('P7: a legacy order gets lines, no VAT table and vat_complete=false', legacy.vat.length === 0 && legacy.vat_complete === false && legacy.total_cents === 1000 && !legacy.finalised_at);
  const pos = R.buildInvoiceRecord({ id: 'p.inv-1', order: { id: 'p', currency: 'EUR', items: [], total_cents: 0, email: '', external_receipt_no: ' POS-9 ' },
    seller: {}, buyer: {}, trigger: 'paid', status: 'final', now: 'x' });
  check('P7: a POS document number on the order marks the record issued elsewhere', pos.issued_externally?.number === 'POS-9' && pos.issued_externally?.actor === 'order');

  {
    const zero = { id: 'z.inv-1', kind: 'invoice', status: 'final', total_cents: 0, lines: [], vat: [] };
    check('P7: a record of 0 is never "fully credited", so no second one can be made', !R.isFullyCredited([zero], zero) && !R.canCreateInvoice([zero]));
    const paid = { id: 'p.inv-1', kind: 'invoice', status: 'final', total_cents: 100 };
    const byRefund = { id: 'p.cm-1', kind: 'credit_memo', invoice_record_id: 'p.inv-1', refund_id: 'r', total_cents: 100 };
    const byStaff = { id: 'p.cm-1', kind: 'credit_memo', invoice_record_id: 'p.inv-1', total_cents: 100 };
    check('P7: credited by refunds → no new record; corrected by staff → a new one may be made', !R.canCreateInvoice([paid, byRefund]) && R.canCreateInvoice([paid, byStaff]) && R.canCreateInvoice([]));
    const extInv = { id: 'e.inv-1', kind: 'invoice', order_id: 'e', currency: 'EUR', prices_include_tax: true, vat: [], issued_externally: { at: 'x', actor: 'order', number: 'POS-1' },
      lines: [{ kind: 'goods', description: 'x', qty: 1, net_cents: 100, tax_rate_bp: 0, tax_cents: 0, total_cents: 100 }], total_cents: 100 };
    const extMemo = R.buildCreditMemo({ id: 'e.cm-1', invoice: extInv, docs: [extInv], amount_cents: 50, refund_id: 'r', now: 'x' });
    check('P7: a memo against a record issued elsewhere is issued elsewhere too', extMemo.issued_externally?.actor === 'invoice' && extMemo.issued_externally?.number === 'POS-1');
  }
  check('P8: states', R.documentState({ status: 'draft' }) === 'draft' && R.documentState({ status: 'final' }) === 'final'
    && R.documentState({ status: 'final', issuer: { status: 'issued' } }) === 'issued'
    && R.documentState({ status: 'final', issuer: { status: 'failed' } }) === 'issue_failed'
    && R.documentState({ status: 'final', issued_externally: { at: 'x', actor: 'u' }, issuer: { status: 'failed' } }) === 'issued_elsewhere');
}

/* ---- D: the PDF says what the state allows ---- */
{
  const PDF = await loadTs('src/lib/commerce/invoice-pdf.ts', 'invpdf');
  const S = await loadTs('src/lib/i18n/public-strings.ts', 'invstr');
  const font = new Uint8Array(await fs.readFile(path.join(ROOT, 'public/fonts/DejaVuSans.ttf')));
  const base = {
    id: 'ord-1.inv-1', kind: 'invoice', order_id: 'ord-1', status: 'final', trigger: 'paid', created_at: '2026-10-12T10:00:00Z', finalised_at: '2026-10-12T10:00:00Z',
    currency: 'EUR', prices_include_tax: true, vat_complete: true,
    seller: { name: 'Οπτικά ΙΚΕ', tax_id: 'EL999' }, buyer: { name: 'Γιώργος', tax_id: '123' },
    lines: [{ kind: 'goods', description: 'Γυαλιά ηλίου', qty: 1, net_cents: 1000, tax_rate_bp: 2400, tax_cents: 240, total_cents: 1240 }],
    vat: [{ rate_bp: 2400, base_cents: 1000, tax_cents: 240 }], net_cents: 1000, tax_cents: 240, total_cents: 1240,
  };
  const render = async (doc, locale = 'en', extra = {}) => {
    const trace = [];
    const bytes = await PDF.invoicePdfBytes(doc, { strings: S.publicStrings(locale).invoice, orderNumber: 'OG-1', money: (c) => `${(c / 100).toFixed(2)} €`, trace, ...extra }, font);
    return { bytes, text: trace.join('\n'), flat: trace.join(' ') };
  };
  const en = S.publicStrings('en').invoice;
  const firstWords = (s) => s.split(' ').slice(0, 4).join(' ');

  const none = await render(base);
  check('D1: the output is a PDF', Buffer.from(none.bytes.slice(0, 5)).toString('latin1') === '%PDF-');
  check('D1: with no issuer it says it is NOT a tax document', none.text.includes(firstWords(en.notTaxDocument)) && none.flat.includes('not a tax document'));
  check('D1: ...is headed "Invoice record", not "Invoice"', none.text.split('\n')[0] === en.recordHeading);
  check('D1: ...and shows no document number', !none.text.includes(en.documentNo));

  const ref = await render({ ...base, internal_reference: 'REF-2026-4' });
  check('D2: an internal reference is labelled as not an invoice number', ref.flat.includes(`${en.internalReference}: REF-2026-4`) && en.internalReference.includes('not an invoice number')
    && !ref.text.includes(en.documentNo) && ref.flat.includes('not a tax document'));

  const issued = await render({ ...base, issuer: { id: 'mydata-x', status: 'issued', number: 'A-77', identifiers: { mark: '400001' }, attempted_at: 'x', issued_at: 'x' } }, 'en', { issuerLabel: 'Provider X' });
  check('D3: issued by an issuer → "Invoice", its number, its identifiers, no disclaimer',
    issued.text.split('\n')[0] === en.invoiceHeading && issued.flat.includes(`${en.documentNo}: A-77`) && issued.flat.includes('mark: 400001')
    && issued.flat.includes('Provider X') && !issued.flat.includes('not a tax document'));

  const failedIssue = await render({ ...base, issuer: { id: 'x', status: 'failed', error: 'bad', number: 'NOPE', attempted_at: 'x' } });
  check('D4: a FAILED issue prints no number and keeps the disclaimer', !failedIssue.flat.includes('NOPE') && failedIssue.flat.includes('not a tax document'));
  const elsewhere = await render({ ...base, issued_externally: { at: 'x', actor: 'u', number: 'POS-1' } });
  check('D4: issued elsewhere names the other number as such, and is not itself a tax document', elsewhere.flat.includes('POS-1') && elsewhere.flat.includes('not a tax document') && !elsewhere.text.includes(en.documentNo));
  const draft = await render({ ...base, status: 'draft', finalised_at: undefined });
  check('D5: a draft says so', draft.flat.includes(en.draft));

  const el = await render(base, 'el');
  check('D6: Greek renders (the embedded font is in use) and says it in Greek', el.bytes.length > 2000 && el.flat.includes('Δεν είναι φορολογικό παραστατικό'));
  const memo = await render({ ...base, id: 'ord-1.cm-1', kind: 'credit_memo', invoice_record_id: 'ord-1.inv-1', refund_id: 're_1' }, 'en');
  check('D7: a memo is a "Credit memo record" naming what it credits', memo.text.split('\n')[0] === en.memoRecordHeading && memo.flat.includes('ord-1.inv-1'));
  check('D8: the filename carries nothing that breaks a header', PDF.invoicePdfFilename({ id: 'o.cm-2', kind: 'credit_memo' }, 'OG-"1\n') === 'credit-memo-OG-1-cm-2.pdf');
  const many = await render({ ...base, lines: Array.from({ length: 70 }, (_, i) => ({ ...base.lines[0], description: `Line ${i}` })) });
  const doc = await (await import('pdf-lib')).PDFDocument.load(many.bytes);
  check('D9: a long record paginates', doc.getPageCount() >= 2);
}

/* ---- per driver ---- */
const tmpRoot = path.join(os.tmpdir(), `astrobaas-invoice-records-${process.pid}`);
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
      ...process.env, INVOICE_RECORDS_CHILD: '1', NODE_ENV: 'test',
      AUTH_SECRET: 'invoice-records-secret-0123456789abcdef',
      STAGING: '', ASTROBAAS_STAGING: '', RATE_LIMIT_STORE: '', SITE_URL: '',
      UPLOADS_DIR: path.join(dir, 'uploads'), ...driver.env(dir),
    },
  });
  const line = (run.stdout || '').split('\n').find((l) => l.startsWith('__RESULT__'));
  if (!line) {
    fail++;
    console.error(`✗ [${driver.name}] child produced no result\n${(run.stderr || '').slice(-3000)}\n${(run.stdout || '').slice(-1500)}`);
    return null;
  }
  return JSON.parse(line.slice('__RESULT__'.length));
}

const results = {};
for (const driver of DRIVERS) {
  const r = await runChild(driver);
  if (!r) continue;
  results[driver.name] = r;
  const t = (n, c) => check(`[${driver.name}] ${n}`, c);

  for (const k of ['s3', 's4', 'g2']) t(`${k}: the interfering call really ran inside the first`, r[k]?.fired === true);

  t(`S0: a BEFORE_ORDER_SAVE filter cannot plant a record on a new order (${r.s0.planted})`, r.s0.planted === 0);
  t(`S1: placing an order with a nonsense tax id is not blocked, and makes no record before payment (${r.s1.recordsBefore})`, r.s1.placedOk && r.s1.recordsBefore === 0);
  t(`S1: paying it makes ONE final record, trigger paid (${j([r.s1.count, r.s1.kind, r.s1.status, r.s1.trigger])})`,
    r.s1.count === 1 && r.s1.kind === 'invoice' && r.s1.status === 'final' && r.s1.trigger === 'paid' && r.s1.payment === 'paid');
  t(`S1: total and VAT equal what was charged (${r.s1.total}/${r.s1.orderTotal}, ${r.s1.tax}/${r.s1.orderTax})`,
    r.s1.total === r.s1.orderTotal && r.s1.tax === r.s1.orderTax && r.s1.vatSum === r.s1.orderTax && r.s1.vatComplete === true);
  t(`S1: VAT per rate — 24% and 13% rows, 24% carrying the shipping tax (${j(r.s1.vat)})`,
    same(r.s1.rates, [2400, 1300])
    && r.s1.vat[0].tax_cents === r.s1.goodsVat['2400'].tax + r.s1.shippingTax
    && r.s1.vat[1].tax_cents === r.s1.goodsVat['1300'].tax && r.s1.vat[1].base_cents === r.s1.goodsVat['1300'].base);
  t(`S1: the buyer's tax id is frozen as typed; the seller from the trader settings (${j([r.s1.buyerTaxId, r.s1.seller, r.s1.sellerVat])})`,
    r.s1.buyerTaxId === 'not-a-real-ΑΦΜ 123' && r.s1.seller === 'Οπτικά Δοκιμή ΙΚΕ' && r.s1.sellerVat === 'EL999999999');
  t('S1: the record id names its order', r.s1.idParses);
  t(`S1: a second payment event, a sync and a create change nothing (${j(r.s1b)})`, r.s1b.count === 1 && r.s1b.createdAgain === false);
  t('S1: changing the tax rates and the order afterwards does not change the record', r.s1b.unchanged);

  t(`S2: a 50% refund makes a credit memo against the record (${j(r.s2.memo)})`,
    r.s2.refunded && r.s2.memo && r.s2.memo.total === r.s2.half && r.s2.memo.refs && r.s2.memo.status === 'final' && r.s2.memo.lines >= 3);
  t(`S2: ...with VAT per rate, about half the record's (${r.s2.memo1VatSum} of ${r.s2.invoiceTax})`,
    same(r.s2.memo?.vat, [2400, 1300]) && Math.abs(r.s2.memo1VatSum * 2 - r.s2.invoiceTax) <= 6);
  t(`S2: the rest makes a second memo; together they credit the record exactly, line by line (${j(r.s2.perLineLeft)})`,
    r.s2.memoCount === 2 && r.s2.creditedTotal === r.s2.invoiceTotal && r.s2.perLineLeft.every(([a, b]) => a === 0 && b === 0));
  t(`S2: a fully refunded order is not re-invoiced by "create" (${r.s2.recreate}, ${r.s2.invoicesAfter})`, r.s2.recreate === 'conflict' && r.s2.invoicesAfter === 1);
  t(`S2b: a refund made at the provider is credited from its webhook, for what the ledger does not cover (${j(r.s2b)})`,
    r.s2b.payment === 'refunded' && r.s2b.memos.length === 2 && r.s2b.memos[1][0] === 'provider-refund' && r.s2b.memos[1][1] === r.s2b.expectedProvider && r.s2b.net === 0);
  t(`S2: one memo per ledger refund, and a sync adds none (${j(r.s2.refundIds)})`, same(r.s2.refundIds, r.s2.ledger) && r.s2.memoCountAfterSync === 2);

  t(`S3: two concurrent "create final" → one record, both answered with it (${j(r.s3)})`,
    r.s3.firstOk && r.s3.secondOk && r.s3.invoices === 1 && r.s3.sameId && same(r.s3.created, [false, true]));
  t(`S3: five at once → one record (${j(r.s3b)})`, r.s3b.ok === 5 && r.s3b.invoices === 1);

  t(`S4: two concurrent finalisations of one draft → one final record (${j([r.s4.draftStatus, r.s4.status, r.s4.invoices])})`,
    r.s4.draftStatus === 'draft' && r.s4.firstOk && r.s4.secondOk && r.s4.invoices === 1 && r.s4.status === 'final');
  t(`S4: ...the issuer is called ONCE and its number stored (${j([r.s4.issuerCalls, r.s4.issuer])})`,
    r.s4.issuerCalls === 1 && r.s4.issuer?.status === 'issued' && r.s4.issuer?.number === 'TST-1' && r.s4.issuer?.mark === '400001' && r.s4.state === 'issued');
  t(`S4: a refund's memo goes to the issuer once, with its invoice (${j(r.s4b)})`,
    r.s4b.memo && r.s4b.calls === 1 && r.s4b.kind === 'credit_memo' && r.s4b.ctxInvoice && r.s4b.state === 'issued');
  t(`S4: a record marked issued elsewhere is NEVER sent to the issuer (${j(r.s4c)})`,
    r.s4c.marked && r.s4c.finalised && r.s4c.calls === 0 && r.s4c.state === 'issued_elsewhere' && r.s4c.number === 'ΑΠΥ 77'
    && r.s4c.issuer === null && r.s4c.retryRefused === 'conflict');
  t(`S4: the refund of a sale issued elsewhere is issued elsewhere too, never sent (${j([r.s4d.memoState, r.s4d.memoIssuer])})`,
    r.s4d.memoState === 'issued_elsewhere' && r.s4d.memoIssuer === null);
  t(`S4: the issuer runs after the payment returns, not inside it (${j(r.s4e)})`,
    r.s4e.took < 380 && r.s4e.midState !== 'issued' && r.s4e.endState === 'issued' && r.s4e.number === 'SLOW-1');
  t(`S4: an order carrying its POS number is issued elsewhere by itself (${j(r.s4d)})`,
    r.s4d.state === 'issued_elsewhere' && r.s4d.number === 'POS-123' && r.s4d.calls === 0);

  t(`S5: an issuer rejecting the tax id shows its error on the record; the sale stands (${j(r.s5.failed)})`,
    r.s5.placedOk && r.s5.failed.state === 'issue_failed' && r.s5.failed.error === 'ΑΦΜ not valid at the authority'
    && r.s5.failed.status === 'final' && r.s5.payment === 'paid' && r.s5.orderStatus === 'processing');
  t(`S5: a memo against an UNISSUED record is not sent to the issuer, and says why (${j(r.s5.memoBefore)})`,
    r.s5.memoBefore.state === 'issue_failed' && r.s5.memoBefore.calls === 0 && r.s5.memoBefore.error.includes('not issued through this issuer'));
  t(`S5: once its invoice is issued, the memo can be sent (${j(r.s5.memoAfter)})`, r.s5.memoAfter.called && r.s5.memoAfter.state === 'issued');
  t(`S5: a retry issues it; a retry once issued sends nothing (${j([r.s5.retried, r.s5.state, r.s5.number, r.s5.againCalled, r.s5.callsAfter])})`,
    r.s5.retried && r.s5.state === 'issued' && r.s5.number === 'TST-2' && r.s5.againCalled === false && r.s5.callsAfter === 0);

  t(`S6: with no issuer, the internal reference is sequential and takes this year (${j(r.s6)})`,
    /^REF-\d{4}-\d+$/.test(r.s6.a ?? '') && r.s6.next && r.s6.issuer === null && r.s6.year);

  t(`S7: a bank-transfer order gets its record when completed (${r.s7.beforeDone}→${r.s7.afterDone})`, r.s7.beforeDone === 0 && r.s7.afterDone === 1);
  t(`S7: "manual" makes none on payment (${r.s7.manual}); "shipped" waits for shipping (${r.s7.paidOnly}, ${r.s7.shippedTrigger})`,
    r.s7.manual === 0 && r.s7.paidOnly === 0 && r.s7.shippedTrigger === 'shipped');

  t(`S8: a final record cannot be cancelled (${r.s8.cancelFinal}); credit in full, then a corrected record (${j(r.s8)})`,
    r.s8.cancelFinal === 'conflict' && r.s8.credit && r.s8.creditAgainSame && r.s8.fresh && r.s8.invoices === 2);
  t(`S8: the earlier refund is credited against BOTH records, so the books net to what was kept (${r.s8.netOfBooks}/${r.s8.charged})`,
    same(r.s8.memosForRefund, ['new', 'old']) && r.s8.netOfBooks === r.s8.charged);

  t(`R1: list, roles (${j([r.r.list0, r.r.mgrRead, r.r.anonRead, r.r.mgrWrite])})`,
    r.r.list0[0] === 200 && r.r.list0[1] === 0 && r.r.list0[2] === 'manual' && r.r.list0[3] === null
    && r.r.mgrRead === 200 && r.r.anonRead === 401 && r.r.mgrWrite === 403 && r.r.editorWrite === 403);
  t(`R1: bad action, missing record id, non-boolean finalise, markup in a number → 422 (${j(r.r.bad)}, ${r.r.badReason})`,
    r.r.bad.every((s) => s === 422) && r.r.badReason === 'invoice_records.invalid');
  t(`R2: create → 201 draft; again → 200, still one (${j([r.r.created, r.r.createdAgain])})`,
    same(r.r.created, [201, 'draft', 'draft']) && same(r.r.createdAgain, [200, 1]));
  t(`R2: finalise → final; again → 200; cancelling a final record → 409 (${j([r.r.fin, r.r.finAgain, r.r.cancelFinal])})`,
    same(r.r.fin, [200, 'final']) && r.r.finAgain === 200 && same(r.r.cancelFinal, [409, 'invoice_records.conflict']));
  t(`R2: unknown record / order → 404 (${r.r.missing}/${r.r.missingOrder})`, r.r.missing === 404 && r.r.missingOrder === 404);
  t(`R3: staff open even a draft's PDF (${j(r.r.staffDraft)}); the buyer's token does not open a draft (${r.r.buyerDraft})`,
    r.r.staffDraft[0] === 200 && r.r.staffDraft[1] === 'application/pdf' && r.r.staffDraft[2] === '%PDF-' && r.r.buyerDraft === 404);
  t(`R3: the buyer's token opens the FINAL record (${j(r.r.buyer)}); another order's token, none, a junk id → 404 (${j([r.r.wrongToken, r.r.noToken, r.r.junkId])})`,
    r.r.buyer[0] === 200 && r.r.buyer[1] === 'application/pdf' && r.r.wrongToken === 404 && r.r.noToken === 404 && r.r.junkId === 404);
  t(`R3: a safe filename (${r.r.disposition})`, /^inline; filename="invoice-record-[A-Za-z0-9_-]+-inv-1\.pdf"$/.test(r.r.disposition ?? ''));
  t(`R4: PUT /api/orders/{id} cannot write records (${r.r.put}, still ${r.r.afterPut})`, r.r.put === 200 && r.r.afterPut === 1);

  t(`G2: a record decided just before an erasure does not land on the erased order (${j(r.g2)})`,
    r.g2.erased && r.g2.records === 0 && r.g2.leaks === false && r.g2.result === 'conflict');
  t(`G: an erasure keeps the figures and removes the buyer from the record (${j(r.g.buyer)})`,
    r.g.had && same(r.g.buyer, { country: 'GR' }) && r.g.total && r.g.vat && r.g.leaks === false);
}

/* ---- the three drivers agree ---- */
{
  const names = Object.keys(results);
  const shape = (r) => j({ vat: r.s1.vat, memo: r.s2.memo?.vat, credited: r.s2.perLineLeft, s3: r.s3.invoices, s4: r.s4.issuerCalls, s8: r.s8.netOfBooks - r.s8.charged });
  check(`the three drivers produce the same records (${names.join(', ')})`, names.length === 3 && names.every((n) => shape(results[n]) === shape(results[names[0]])));
}

await fs.rm(tmpRoot, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
