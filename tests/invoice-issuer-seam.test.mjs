#!/usr/bin/env node
/**
 * The invoice ISSUER seam, version 2 (lib/commerce/invoice-records*.ts).
 *
 * The first real issuer (the paid myDATA pack) needed five things #144's hook
 * did not give it. Each is proved here, and each scenario fails without its
 * change:
 *
 *  - D: an issuer can DECLINE a record ("not mine") — the record is then not
 *    "issue failed", falls back to the no-issuer behaviour (the internal
 *    reference), and with a chosen issuer the next active one is asked. A
 *    failure is never passed on; a credit goes to the issuer of its sale.
 *  - C: the INVOICE_ISSUERS filter and the issue call receive the settings,
 *    so an issuer's own switch needs no cache.
 *  - L: a LATE success is accepted only while the record is unissued and held
 *    by that issuer under that key — compare-and-set, raced on purpose.
 *  - R: a RETRYABLE failure (or a timeout) is retried by the background sweep
 *    with backoff, under the same key, capped, once per record however many
 *    sweeps run at once, and always by the issuer that may already have it.
 *  - T: each record line carries its TAX TREATMENT, frozen from the priced
 *    order (standard, reverse-charge, export, exempt; absent when unknown),
 *    through the real writers — placeOrder, the tax-override route, refunds.
 *
 * The write path runs on ALL THREE drivers, each in its own child process
 * and database, like invoice-records.test.mjs.
 *
 * Run with:  node tests/invoice-issuer-seam.test.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, loadTs } from './lib/load.mjs';

const j = JSON.stringify;
const same = (a, b) => j(a) === j(b);
const MIN = 60_000;

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
const recordWrite = (id) => (name, args) => args[0] === id
  && (name === 'compareAndSetOrderInvoiceRecords' || (name === 'updateOrder' && !!args[1] && 'invoice_records' in args[1]));

async function child(M) {
  const { LocalDB, inv, rules } = M;
  const hook = installHook(LocalDB);
  const out = {};
  const set = (k, v) => LocalDB.updateSetting(k, v);

  // Core's issuer timeout is 30 s. While `shrink` is on, that one timer runs
  // in 150 ms, so the timeout path is exercised without a 30 s test.
  const realSetTimeout = globalThis.setTimeout;
  let shrink = false;
  globalThis.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, shrink && ms === 30_000 ? 150 : ms, ...a);

  // A Greek shop: VAT on, prices include it, a reduced rate, a flat courier.
  await set('tax_enabled', true);
  await set('tax_prices_include_tax', true);
  await set('shop_country', 'GR');
  await set('trader_legal_name', 'Δοκιμή ΙΚΕ');
  await set('trader_vat_number', 'EL999999999');
  const ship = await LocalDB.createShippingMethod({ name: 'Courier', enabled: true, zone: { countries: ['GR'] }, rate: { kind: 'flat', amount_cents: 350 } });
  const shipUs = await LocalDB.createShippingMethod({ name: 'World', enabled: true, zone: { countries: ['US'] }, rate: { kind: 'flat', amount_cents: 900 } });
  let n = 0;
  const product = (price, taxClass) => {
    n += 1;
    return LocalDB.createProduct({
      status: 'active', price_cents: price, categories: [], images: [], on_sale: false,
      name: `Item ${n}`, slug: `seam-item-${process.pid}-${n}`, stock: 100000, in_stock: true,
      requires_shipping: true, tax_class: taxClass,
    });
  };
  const A = await product(1240, 'standard');
  const B = await product(1130, 'reduced');

  const refunds = new Map();
  M.registry.setPluginProviders([{
    id: 'seam-stub', label: 'Seam stub', requiredEnv: [],
    createSession: async () => ({ reference: 'x', redirectUrl: 'https://example.invalid' }),
    verifyWebhook: async () => { throw new Error('unused'); },
    refund: async (_o, amountCents, key) => {
      if (!refunds.has(key)) refunds.set(key, { refundId: `re_${refunds.size + 1}`, amountCents });
      return refunds.get(key);
    },
  }]);

  let buyerN = 0;
  const place = async (over = {}) => {
    buyerN += 1;
    const country = over.country ?? 'GR';
    const r = await M.placeOrder({
      email: `seam${buyerN}@example.com`, name: 'Buyer',
      items: [{ product_id: A.id, qty: 2 }, { product_id: B.id, qty: 1 }],
      shipping_country: country, shipping_postcode: country === 'US' ? '10001' : '10431',
      shipping_method_id: country === 'US' ? shipUs.id : ship.id,
      shipping_address: { name: 'Buyer', line1: 'Street 1', city: 'City', postcode: country === 'US' ? '10001' : '10431', country },
      payment_method: 'card',
    });
    if (!r.ok) throw new Error(`placeOrder failed: ${r.message}`);
    await LocalDB.updateOrder(r.value.id, { payment_provider: 'seam-stub', payment_reference: 'x' });
    return r.value;
  };
  const pay = async (o) => {
    const r = await M.applyVerifiedEvent({
      eventId: `evt_${o.id}`, reference: o.id, outcome: 'paid', amountCents: o.total_cents, currency: o.currency, rawType: 'seam.paid',
    });
    await inv.whenInvoiceIssuesSettled();
    return r;
  };
  const refund = async (...a) => { const r = await M.refundOrder(...a); await inv.whenInvoiceIssuesSettled(); return r; };
  const docsOf = async (id) => rules.invoiceDocumentsOf(await LocalDB.getOrder(id));
  const recOf = async (id) => (await docsOf(id)).find((d) => d.kind === 'invoice');
  const memoOf = async (id) => (await docsOf(id)).find((d) => d.kind === 'credit_memo');

  // Two test issuers, each switched and scripted per scenario.
  const ctl = {
    alpha: { on: false, needsSetting: false, behave: null, calls: [] },
    beta: { on: false, behave: null, calls: [] },
  };
  const filterSeen = [];
  let numbered = 0;
  const mk = (id) => ({
    id, label: id === 'alpha' ? 'Alpha' : 'Beta',
    issue: async (doc, ctx) => {
      ctl[id].calls.push({ doc: doc.id, kind: doc.kind, key: ctx?.key, attempt: ctx?.attempt, settingsCountry: ctx?.settings?.shop_country, ctx });
      await new Promise((r) => realSetTimeout(r, 3));
      if (ctl[id].behave) return ctl[id].behave(doc, ctx);
      numbered += 1;
      return { ok: true, number: `${id.toUpperCase()}-${numbered}` };
    },
  });
  M.pluginManager.registerPlugin({
    id: 'seam-alpha', name: 'Alpha', version: '1.0.0', description: 'test', author: 'test',
    filters: {
      [M.PLUGIN_HOOKS.INVOICE_ISSUERS]: (list, ctx) => {
        filterSeen.push(ctx);
        if (!ctl.alpha.on) return list;
        if (ctl.alpha.needsSetting && ctx?.settings?.seam_alpha_enabled !== true) return list;
        return [...list, mk('alpha')];
      },
    },
  });
  M.pluginManager.registerPlugin({
    id: 'seam-beta', name: 'Beta', version: '1.0.0', description: 'test', author: 'test',
    filters: { [M.PLUGIN_HOOKS.INVOICE_ISSUERS]: (list) => (ctl.beta.on ? [...list, mk('beta')] : list) },
  });
  M.pluginManager.activatePlugin('seam-alpha');
  M.pluginManager.activatePlugin('seam-beta');
  const reset = async () => {
    ctl.alpha = { on: false, needsSetting: false, behave: null, calls: [] };
    ctl.beta = { on: false, behave: null, calls: [] };
    await set('invoice_issuer', '');
    await set('invoice_internal_reference_format', '');
    await set('invoice_record_on', 'paid');
  };
  const declines = (reason) => () => ({ ok: false, declined: true, reason });

  /* ---- D1: one issuer declines → not failed; the internal reference applies ---- */
  {
    await reset();
    ctl.alpha.on = true;
    ctl.alpha.behave = declines('retail is switched off');
    await set('invoice_internal_reference_format', 'REF-{n}');
    const o = await place();
    await pay(o);
    const rec = await recOf(o.id);
    out.d1 = {
      state: rules.documentState(rec), status: rec.issuer?.status ?? null, declined: rec.issuer?.declined ?? null,
      ref: rec.internal_reference ?? null, error: rec.issuer?.error ?? null, calls: ctl.alpha.calls.length,
    };
    // Its refund: the credit of a sale nobody here issued is nobody's either.
    await refund(o.id, 100, 'admin-a', 'http://localhost');
    const memo = await memoOf(o.id);
    out.d1.memo = {
      state: memo ? rules.documentState(memo) : null, status: memo?.issuer?.status ?? null,
      ref: memo?.internal_reference ?? null, calls: ctl.alpha.calls.length,
    };
    // "Issue again" on a declined record asks again — the switch may be on now.
    ctl.alpha.behave = null;
    const again = await inv.issueInvoiceDocument(o.id, rec.id);
    const after = await recOf(o.id);
    out.d1.again = { called: again.ok && again.called, state: rules.documentState(after), number: after.issuer?.number ?? null, calls: ctl.alpha.calls.length };
  }

  /* ---- D2: the chosen issuer declines → the next active one is asked ---- */
  {
    await reset();
    ctl.alpha.on = true;
    ctl.beta.on = true;
    await set('invoice_issuer', 'alpha');
    ctl.alpha.behave = declines('not a Greek sale');
    const o = await place();
    await pay(o);
    const rec = await recOf(o.id);
    out.d2 = {
      state: rules.documentState(rec), id: rec.issuer?.id, number: rec.issuer?.number ?? null,
      declined: rec.issuer?.declined ?? null, alpha: ctl.alpha.calls.length, beta: ctl.beta.calls.length,
      keys: [...new Set([...ctl.alpha.calls, ...ctl.beta.calls].map((c) => c.key))],
      recId: rec.id,
    };
    // The credit goes to the issuer of the SALE (beta), never down the chain.
    const a0 = ctl.alpha.calls.length;
    const b0 = ctl.beta.calls.length;
    await refund(o.id, 200, 'admin-a', 'http://localhost');
    const memo = await memoOf(o.id);
    out.d2.memo = { state: memo ? rules.documentState(memo) : null, id: memo?.issuer?.id ?? null, alpha: ctl.alpha.calls.length - a0, beta: ctl.beta.calls.length - b0 };

    // A FAILURE is not passed on: it may have reached the authority.
    ctl.alpha.calls = []; ctl.beta.calls = [];
    ctl.alpha.behave = () => ({ ok: false, error: 'boom' });
    const o2 = await place();
    await pay(o2);
    const r2 = await recOf(o2.id);
    out.d2.fail = { state: rules.documentState(r2), id: r2.issuer?.id, beta: ctl.beta.calls.length };

    // Both decline → nobody's: the internal reference, both reasons kept.
    ctl.alpha.calls = []; ctl.beta.calls = [];
    ctl.alpha.behave = declines('a');
    ctl.beta.behave = declines('b');
    await set('invoice_internal_reference_format', 'REF-{n}');
    const o3 = await place();
    await pay(o3);
    const r3 = await recOf(o3.id);
    out.d2.both = { state: rules.documentState(r3), status: r3.issuer?.status, declined: r3.issuer?.declined, ref: !!r3.internal_reference };

    // The precedence: the CHOSEN one first.
    ctl.alpha.calls = []; ctl.beta.calls = [];
    ctl.alpha.behave = null;
    ctl.beta.behave = null;
    await set('invoice_issuer', 'beta');
    const o4 = await place();
    await pay(o4);
    const r4 = await recOf(o4.id);
    out.d2.chosenBeta = { id: r4.issuer?.id, alpha: ctl.alpha.calls.length, beta: ctl.beta.calls.length };

    // Two active, none chosen: nobody is called (load order never decides).
    ctl.alpha.calls = []; ctl.beta.calls = [];
    await set('invoice_issuer', '');
    const o5 = await place();
    await pay(o5);
    const r5 = await recOf(o5.id);
    out.d2.unchosen = { state: rules.documentState(r5), calls: ctl.alpha.calls.length + ctl.beta.calls.length };
  }

  /* ---- C: the filter and the issue call get the settings ---- */
  {
    await reset();
    ctl.alpha.on = true;
    ctl.alpha.needsSetting = true;
    await set('invoice_internal_reference_format', 'REF-{n}');
    await set('seam_alpha_enabled', false);
    filterSeen.length = 0;
    const o = await place();
    await pay(o);
    const off = await recOf(o.id);
    out.c = {
      offIssuer: off.issuer ?? null, offRef: !!off.internal_reference, offCalls: ctl.alpha.calls.length,
      filterCtx: filterSeen.some((c) => c?.settings?.shop_country === 'GR'),
    };
    await set('seam_alpha_enabled', true);
    const o2 = await place();
    await pay(o2);
    const on = await recOf(o2.id);
    const call = ctl.alpha.calls[0];
    out.c.on = {
      state: rules.documentState(on), calls: ctl.alpha.calls.length,
      ctxSettings: call?.settingsCountry, key: call?.key, expectedKey: `astrobaas:${on.id}`, storedKey: on.issuer?.key, attempt: call?.attempt,
    };
  }

  /* ---- L: a late success ---- */
  {
    await reset();
    ctl.alpha.on = true;
    // L1: core times out (the provider is slow) → failed, RETRYABLE.
    let release;
    ctl.alpha.behave = () => new Promise((r) => { release = r; });
    shrink = true;
    const o = await place();
    await pay(o);
    shrink = false;
    const timedOut = await recOf(o.id);
    const ctx = ctl.alpha.calls.at(-1)?.ctx;
    out.l1 = {
      state: rules.documentState(timedOut), retryable: timedOut.issuer?.retryable ?? null, next: !!timedOut.issuer?.next_attempt_at,
      error: timedOut.issuer?.error ?? '', hasReport: typeof ctx?.reportLateSuccess === 'function',
    };
    // ...then the issuer's answer lands, and it tells core.
    const late = typeof ctx?.reportLateSuccess === 'function'
      ? await ctx.reportLateSuccess({ number: 'LATE-1', identifiers: { mark: '900001' } }) : null;
    const issued = await recOf(o.id);
    const lateAgain = typeof ctx?.reportLateSuccess === 'function' ? await ctx.reportLateSuccess({ number: 'LATE-1' }) : null;
    release?.({ ok: true, number: 'LATE-1' });
    out.l1.late = late && { ok: late.ok, accepted: late.accepted };
    out.l1.after = { state: rules.documentState(issued), number: issued.issuer?.number, mark: issued.issuer?.identifiers?.mark, late: issued.issuer?.late ?? null, next: issued.issuer?.next_attempt_at ?? null };
    out.l1.again = lateAgain && { ok: lateAgain.ok, accepted: lateAgain.accepted };

    // L2: the wrong key, the wrong issuer → refused, nothing written.
    ctl.alpha.behave = () => ({ ok: false, error: 'deadline', retryable: true });
    const o2 = await place();
    await pay(o2);
    const r2 = await recOf(o2.id);
    const wrongKey = await inv.reportLateInvoiceIssue(r2.id, { issuer: 'alpha', key: 'astrobaas:someone-else', number: 'X' });
    const wrongIssuer = await inv.reportLateInvoiceIssue(r2.id, { issuer: 'beta', key: `astrobaas:${r2.id}`, number: 'X' });
    out.l2 = { wrongKey: wrongKey.ok ? 'accepted' : wrongKey.code, wrongIssuer: wrongIssuer.ok ? 'accepted' : wrongIssuer.code, state: rules.documentState(await recOf(o2.id)) };

    // L3: compare-and-set. A person marks the record issued elsewhere in the
    // instant between the late report's read and its write.
    const ctx2 = ctl.alpha.calls.at(-1)?.ctx;
    let marked = null;
    const fired = hook.before(recordWrite(o2.id), async () => { marked = await inv.markIssuedExternally(o2.id, r2.id, 'u-admin', 'POS-9'); });
    const raced = await ctx2.reportLateSuccess({ number: 'LATE-2' });
    hook.disarm();
    const r3 = await recOf(o2.id);
    out.l3 = {
      fired: fired(), marked: marked?.ok ?? null, late: raced.ok ? 'accepted' : raced.code,
      state: rules.documentState(r3), issuerStatus: r3.issuer?.status, number: r3.issuer?.number ?? null,
    };
  }

  /* ---- R: retryable failures and the background sweep ---- */
  {
    await reset();
    ctl.alpha.on = true;
    ctl.alpha.behave = () => ({ ok: false, error: 'provider down', retryable: true });
    const o = await place();
    await pay(o);
    let rec = await recOf(o.id);
    const first = { attempts: rec.issuer?.attempts, retryable: rec.issuer?.retryable, wait: Date.parse(rec.issuer?.next_attempt_at) - Date.parse(rec.issuer?.attempted_at) };
    const early = await inv.sweepInvoiceIssueRetries(Date.now());
    const due1 = Date.parse(rec.issuer.next_attempt_at) + 1;
    const s1 = await inv.sweepInvoiceIssueRetries(due1);
    rec = await recOf(o.id);
    const second = { attempts: rec.issuer?.attempts, wait: Date.parse(rec.issuer?.next_attempt_at) - due1, attempt: ctl.alpha.calls.at(-1)?.attempt };
    ctl.alpha.behave = null;
    const s2 = await inv.sweepInvoiceIssueRetries(Date.parse(rec.issuer.next_attempt_at) + 1);
    rec = await recOf(o.id);
    const callsBefore = ctl.alpha.calls.length;
    const s3 = await inv.sweepInvoiceIssueRetries(Date.now() + 24 * 60 * MIN);
    out.r1 = {
      first, earlyRetried: early.retried, s1: s1.retried, second, s2, state: rules.documentState(rec),
      number: rec.issuer?.number ?? null, s3: s3.retried, callsAfterIssued: ctl.alpha.calls.length - callsBefore,
      keys: [...new Set(ctl.alpha.calls.filter((c) => c.doc === rec.id).map((c) => c.key))], recId: rec.id,
      totalCalls: ctl.alpha.calls.filter((c) => c.doc === rec.id).length,
    };

    // R2: two sweeps at once → one call.
    ctl.alpha.calls = [];
    ctl.alpha.behave = () => ({ ok: false, error: 'provider down', retryable: true });
    const o2 = await place();
    await pay(o2);
    let r2 = await recOf(o2.id);
    ctl.alpha.behave = async () => { await new Promise((r) => realSetTimeout(r, 40)); return { ok: true, number: 'ONCE-1' }; };
    const due2 = Date.parse(r2.issuer.next_attempt_at) + 1;
    const both = await Promise.all([inv.sweepInvoiceIssueRetries(due2), inv.sweepInvoiceIssueRetries(due2), inv.issueInvoiceDocument(o2.id, r2.id)]);
    r2 = await recOf(o2.id);
    out.r2 = { calls: ctl.alpha.calls.filter((c) => c.doc === r2.id).length, state: rules.documentState(r2), number: r2.issuer?.number, retried: both[0].retried + both[1].retried };

    // R3: a plain failure is never retried automatically.
    ctl.alpha.calls = [];
    ctl.alpha.behave = () => ({ ok: false, error: 'ΑΦΜ rejected' });
    const o3 = await place();
    await pay(o3);
    const s3b = await inv.sweepInvoiceIssueRetries(Date.now() + 24 * 60 * MIN);
    const r3 = await recOf(o3.id);
    out.r3 = { calls: ctl.alpha.calls.length, retried: s3b.retried, retryable: r3.issuer?.retryable ?? null, next: r3.issuer?.next_attempt_at ?? null };

    // R4: the cap.
    ctl.alpha.calls = [];
    ctl.alpha.behave = () => ({ ok: false, error: 'provider down', retryable: true });
    const o4 = await place();
    await pay(o4);
    let r4 = await recOf(o4.id);
    for (let i = 0; i < 20 && r4.issuer?.next_attempt_at; i++) {
      await inv.sweepInvoiceIssueRetries(Date.parse(r4.issuer.next_attempt_at) + 1);
      r4 = await recOf(o4.id);
    }
    const c4 = ctl.alpha.calls.length;
    const s4 = await inv.sweepInvoiceIssueRetries(Date.parse(r4.issuer.attempted_at) + 24 * 60 * MIN);
    out.r4 = { calls: c4, attempts: r4.issuer?.attempts, next: r4.issuer?.next_attempt_at ?? null, retryable: r4.issuer?.retryable ?? null, after: s4.retried, max: inv.MAX_AUTO_ISSUE_ATTEMPTS };

    // R5: pinned to the issuer that may already have it.
    ctl.alpha.calls = [];
    ctl.beta.on = true;
    await set('invoice_issuer', 'alpha');
    ctl.alpha.behave = () => ({ ok: false, error: 'provider down', retryable: true });
    const o5 = await place();
    await pay(o5);
    let r5 = await recOf(o5.id);
    await set('invoice_issuer', 'beta');
    ctl.alpha.behave = null;
    ctl.alpha.on = false; // alpha switched off: nobody may take its record over
    const manualOff = await inv.issueInvoiceDocument(o5.id, r5.id);
    const sweepOff = await inv.sweepInvoiceIssueRetries(Date.parse(r5.issuer.next_attempt_at) + 1);
    ctl.alpha.on = true;
    const sweepOn = await inv.sweepInvoiceIssueRetries(Date.parse(r5.issuer.next_attempt_at) + 1);
    r5 = await recOf(o5.id);
    out.r5 = {
      manualOff: manualOff.ok ? 'ok' : manualOff.code, manualMsg: manualOff.ok ? '' : manualOff.message,
      sweepOff: sweepOff.retried, sweepOn: sweepOn.retried, id: r5.issuer?.id, state: rules.documentState(r5), beta: ctl.beta.calls.length,
    };

    // R6: a claim left `issuing` by a crash is retried, same issuer, same key.
    await reset();
    ctl.alpha.on = true;
    ctl.alpha.behave = () => ({ ok: false, error: 'provider down', retryable: true });
    const o6 = await place();
    await pay(o6);
    const stored = (await LocalDB.getOrder(o6.id)).invoice_records;
    const docs6 = await docsOf(o6.id);
    const crashed = docs6.map((d) => (d.kind === 'invoice'
      ? { ...d, issuer: { id: 'alpha', status: 'issuing', attempted_at: new Date(Date.now() - 11 * MIN).toISOString(), key: `astrobaas:${d.id}`, attempts: 1 } }
      : d));
    await LocalDB.compareAndSetOrderInvoiceRecords(o6.id, stored, crashed);
    ctl.alpha.calls = [];
    ctl.alpha.behave = null;
    const s6 = await M.schedulerSweepInvoiceIssueRetries(Date.now());
    const r6 = await recOf(o6.id);
    out.r6 = { retried: s6.retried, state: rules.documentState(r6), key: ctl.alpha.calls[0]?.key, expectedKey: `astrobaas:${r6.id}`, attempt: ctl.alpha.calls[0]?.attempt };
  }

  /* ---- F: what the independent review found ---- */
  {
    // F1: records whose issuer is switched off must not fill every batch.
    await reset();
    ctl.alpha.on = true;
    ctl.beta.on = true;
    await set('invoice_issuer', 'alpha');
    ctl.alpha.behave = () => ({ ok: false, error: 'alpha down', retryable: true });
    const stuck = [];
    for (let i = 0; i < inv.ISSUE_RETRY_BATCH + 1; i++) { const o = await place(); await pay(o); stuck.push(o.id); }
    await set('invoice_issuer', 'beta');
    ctl.beta.behave = () => ({ ok: false, error: 'beta down', retryable: true });
    const ob = await place();
    await pay(ob);
    ctl.alpha.on = false; // alpha switched off: its records cannot be retried
    ctl.beta.behave = null;
    ctl.beta.calls = [];
    const s = await inv.sweepInvoiceIssueRetries(Date.now() + 3 * MIN);
    const rb = await recOf(ob.id);
    out.f1 = { retried: s.retried, beta: ctl.beta.calls.length, state: rules.documentState(rb), id: rb.issuer?.id };

    // F2: a PLAIN failure is not passed on by "Issue again" after the choice changes.
    await reset();
    ctl.alpha.on = true;
    ctl.beta.on = true;
    await set('invoice_issuer', 'alpha');
    ctl.alpha.behave = declines('retail off');
    ctl.beta.behave = () => ({ ok: false, error: 'beta said no' });
    const o2 = await place();
    await pay(o2);
    const r2a = await recOf(o2.id);
    ctl.alpha.behave = null; // retail switched on at alpha
    ctl.alpha.calls = [];
    ctl.beta.calls = [];
    ctl.beta.behave = null;
    const again = await inv.issueInvoiceDocument(o2.id, r2a.id);
    const r2b = await recOf(o2.id);
    out.f2 = { firstId: r2a.issuer?.id, firstState: rules.documentState(r2a), called: again.ok && again.called, alpha: ctl.alpha.calls.length, beta: ctl.beta.calls.length, id: r2b.issuer?.id, state: rules.documentState(r2b) };

    // F3: a throw is an unknown outcome → retryable.
    await reset();
    ctl.alpha.on = true;
    ctl.alpha.behave = () => { throw new Error('socket reset after the request'); };
    const o3 = await place();
    await pay(o3);
    const r3 = await recOf(o3.id);
    out.f3 = { state: rules.documentState(r3), retryable: r3.issuer?.retryable ?? null, next: !!r3.issuer?.next_attempt_at };

    // F4: the issuer of the sale declining its credit is a failure, not a quiet "final".
    ctl.alpha.behave = null;
    const o4 = await place();
    await pay(o4);
    ctl.alpha.behave = (doc) => (doc.kind === 'credit_memo' ? { ok: false, declined: true, reason: 'credits not supported' } : { ok: true, number: 'X' });
    await refund(o4.id, 100, 'admin-a', 'http://localhost');
    const m4 = await memoOf(o4.id);
    out.f4 = { state: m4 ? rules.documentState(m4) : null, error: m4?.issuer?.error ?? '', ref: m4?.internal_reference ?? null };

    // F5: a stale claim can be marked issued elsewhere; a live one cannot.
    ctl.alpha.behave = () => ({ ok: false, error: 'x', retryable: true });
    const o5 = await place();
    await pay(o5);
    const write = async (minutesAgo) => {
      const stored = (await LocalDB.getOrder(o5.id)).invoice_records;
      const docs = await docsOf(o5.id);
      await LocalDB.compareAndSetOrderInvoiceRecords(o5.id, stored, docs.map((d) => (d.kind === 'invoice'
        ? { ...d, issuer: { id: 'alpha', status: 'issuing', attempted_at: new Date(Date.now() - minutesAgo * MIN).toISOString(), key: `astrobaas:${d.id}`, attempts: 1 } }
        : d)));
    };
    const r5 = await recOf(o5.id);
    await write(1);
    const live = await inv.markIssuedExternally(o5.id, r5.id, 'u-admin', 'POS-1');
    await write(11);
    const stale = await inv.markIssuedExternally(o5.id, r5.id, 'u-admin', 'POS-1');
    out.f5 = { live: live.ok ? 'ok' : live.code, stale: stale.ok ? 'ok' : stale.code, state: rules.documentState(await recOf(o5.id)) };
  }

  /* ---- T: frozen tax treatment, through the real writers ---- */
  {
    await reset();
    // T1: a domestic sale — VAT charged under the normal rules.
    const o = await place();
    await pay(o);
    const rec = await recOf(o.id);
    out.t1 = rec.lines.map((l) => [l.kind, l.tax_rate_bp, l.tax_treatment ?? null]);

    // T2: an export — destination taxation on, shipped to the US.
    await set('tax_destination_mode', 'oss');
    const ox = await place({ country: 'US' });
    await pay(ox);
    const rx = await recOf(ox.id);
    out.t2 = { lines: rx.lines.map((l) => [l.kind, l.tax_rate_bp, l.tax_treatment ?? null]), tax: rx.tax_cents };
    await set('tax_destination_mode', 'off');

    // T3: a person exempts line 0 (the tax-override route), THEN the record is made.
    await set('invoice_record_on', 'manual');
    const oe = await place();
    await pay(oe);
    const res = await M.postTaxOverride({
      params: { id: oe.id }, url: new URL('http://localhost/x'), locals: { user: { id: 'u-admin', role: 'admin' } },
      request: new Request('http://localhost/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope: 'line', line_index: 0, exempt: true, reason: 'charity, letter on file' }) }),
    });
    const made = await inv.createInvoiceRecord(oe.id, { finalise: true });
    const re = made.ok ? made.value.record : null;
    out.t3 = { override: res.status, lines: re ? re.lines.map((l) => [l.kind, l.tax_rate_bp, l.tax_treatment ?? null]) : null };

    // T4: its refund's memo carries each credited line's treatment.
    await refund(oe.id, 300, 'admin-a', 'http://localhost');
    const memo = await memoOf(oe.id);
    out.t4 = memo ? memo.lines.map((l) => [l.invoice_line, l.tax_treatment ?? null]) : null;
    out.t4inv = re ? re.lines.map((l) => l.tax_treatment ?? null) : null;
  }

  return out;
}

if (process.env.ISSUER_SEAM_CHILD) {
  const M = await loadTs('tests/fixtures/invoice-issuer-seam-entry.ts', 'seam');
  await M.LocalDB.init();
  const result = await child(M);
  console.log('__RESULT__' + JSON.stringify(result));
  process.exit(0);
}

/* --------------------------------------------------------------- parent --- */
let pass = 0;
let fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };

/* ---- P: pure ---- */
const R = await loadTs('src/lib/commerce/invoice-records-rules.ts', 'seamrules');
const T = await loadTs('src/lib/commerce/totals.ts', 'seamtotals');
const O = await loadTs('src/lib/commerce/tax-override.ts', 'seamoverride');
const I = await loadTs('src/lib/commerce/invoice-records.ts', 'seaminv');
{
  const tax = {
    enabled: true, pricesIncludeTax: true, defaultClass: 'standard', shippingClass: 'standard', originCountry: 'GR',
    destinationMode: 'oss', reverseCharge: true, euCountries: ['GR', 'DE'],
    rates: [{ class: 'standard', label: 'S', rate_bp: 2400 }, { class: 'reduced', label: 'R', rate_bp: 1300 }, { class: 'standard', label: 'DE', rate_bp: 1900, country: 'DE' }],
  };
  const lines = [
    { product_id: 'a', name: 'Frames', qty: 2, unit_price_cents: 5000, tax_class: 'standard' },
    { product_id: 'b', name: 'Cleaner', qty: 1, unit_price_cents: 700, tax_class: 'reduced' },
  ];
  const orderOf = (t, extra = {}) => ({ line_totals: t.lines, shipping_tax_cents: t.shipping_tax_cents, ...extra });

  const rc = T.calculateTotals({ lines, shipping_cents: 500, tax, treatment: { kind: 'reverse-charge' } });
  check(`P1: reverse charge → every line reverse-charge, shipping too (${j(R.lineTaxTreatments(orderOf(rc)))})`,
    same(R.lineTaxTreatments(orderOf(rc)), { goods: ['reverse-charge', 'reverse-charge'], shipping: 'reverse-charge' }));
  const ex = T.calculateTotals({ lines, shipping_cents: 500, tax, treatment: { kind: 'export' } });
  check('P1: export → export', same(R.lineTaxTreatments(orderOf(ex)), { goods: ['export', 'export'], shipping: 'export' }));
  const dom = T.calculateTotals({ lines, shipping_cents: 500, tax });
  check('P1: domestic VAT charged → standard', same(R.lineTaxTreatments(orderOf(dom)), { goods: ['standard', 'standard'], shipping: 'standard' }));
  const dest = T.calculateTotals({ lines: [lines[0]], shipping_cents: 500, tax, treatment: { kind: 'destination', jurisdiction: 'DE' } });
  check(`P1: OSS destination VAT → standard, with its jurisdiction stamped on the order line (${dest.lines[0].tax_jurisdiction})`,
    same(R.lineTaxTreatments(orderOf(dest)).goods, ['standard']) && dest.lines[0].tax_jurisdiction === 'DE');
  const off = T.calculateTotals({ lines, shipping_cents: 500, tax: { ...tax, enabled: false } });
  check(`P1: tax switched off → UNKNOWN, never "standard" (${j(R.lineTaxTreatments(orderOf(off)))})`,
    same(R.lineTaxTreatments(orderOf(off)), { goods: [undefined, undefined], shipping: undefined }));
  check('P1: a stored value this version does not know → unknown',
    R.lineTaxTreatments({ line_totals: [{ ...dom.lines[0], tax_treatment: 'zero-rated-someday' }], shipping_tax_cents: 0 }).goods[0] === undefined);

  // Overrides through the REAL override function.
  const ex1 = O.applyTaxOverride(rc.lines, tax, { scope: 'line', line_index: 1, exempt: true, reason: 'charity' }, 'u');
  const ovOrder = orderOf(rc, { line_totals: ex1.lines, tax_overrides: [ex1.record], line_totals_original: rc.lines });
  check(`P2: an exempt override → exempt on that line only; shipping keeps the engine's (${j(R.lineTaxTreatments(ovOrder))})`,
    same(R.lineTaxTreatments(ovOrder), { goods: ['reverse-charge', 'exempt'], shipping: 'reverse-charge' }));
  // A CLASS override is refused on a reverse-charge (or export, or
  // destination) line since #148: it would charge the home rate on a sale the
  // engine decided is not domestic. So "last override wins" is shown on a
  // DOMESTIC order, the only kind a class override can reach.
  const clsRc = O.applyTaxOverride(ex1.lines, tax, { scope: 'order', tax_class: 'reduced', reason: 'reverse charge did not apply' }, 'u');
  check('P2: a class override on reverse-charge lines is refused (#148), so no record can claim one',
    clsRc.ok === false && /reverse-charge/.test(clsRc.error ?? ''));
  const exDom = O.applyTaxOverride(dom.lines, tax, { scope: 'line', line_index: 1, exempt: true, reason: 'charity' }, 'u');
  const cls = O.applyTaxOverride(exDom.lines, tax, { scope: 'order', tax_class: 'reduced', reason: 'reduced rate applies' }, 'u');
  const clsOrder = orderOf(dom, { line_totals: cls.lines, tax_overrides: [exDom.record, cls.record], line_totals_original: dom.lines });
  check(`P2: a later class override reaches both lines → standard; the LAST override wins (${j(R.lineTaxTreatments(clsOrder).goods)})`,
    exDom.ok && cls.ok && same(R.lineTaxTreatments(clsOrder).goods, ['standard', 'standard']));
  // LEGACY rows: before #148 a class override WAS accepted on reverse-charge
  // lines, so stored orders on deployed shops can hold one. applyTaxOverride
  // can no longer produce them, so they are built by hand, the shape the old
  // function wrote: re-rated lines marked `override`, and the class record.
  const reRated = (l) => ({ ...l, tax_rate_bp: 1300, tax_cents: Math.round(l.net_cents * 0.13), total_cents: l.net_cents + Math.round(l.net_cents * 0.13), tax_rate_source: 'override' });
  const legacyCls = { scope: 'order', tax_class: 'reduced', reason: 'reverse charge did not apply', actor: 'u', at: 'x', was_rate_bp: 0, now_rate_bp: 1300 };
  const legacyOrder = orderOf(rc, { line_totals: rc.lines.map(reRated), tax_overrides: [ex1.record, legacyCls], line_totals_original: rc.lines });
  check(`P2 (legacy row): a stored class override over reverse-charge lines → standard; the LAST override wins (${j(R.lineTaxTreatments(legacyOrder).goods)})`,
    same(R.lineTaxTreatments(legacyOrder).goods, ['standard', 'standard']));
  check('P2: an override with its decision missing → unknown',
    R.lineTaxTreatments({ line_totals: [{ ...dom.lines[0], tax_rate_source: 'override' }], tax_overrides: [] }).goods[0] === undefined);

  // On the record itself, and on a memo.
  const order = {
    id: 'o', number: 'N', currency: 'EUR', status: 'processing', payment_status: 'paid', email: 'b@x',
    items: lines.map((l) => ({ product_id: l.product_id, name: l.name, qty: l.qty, total_cents: 0 })),
    line_totals: rc.lines, total_cents: rc.total_cents, tax_cents: rc.tax_cents, shipping_cents: rc.shipping_cents,
    shipping_tax_cents: rc.shipping_tax_cents, prices_include_tax: true, created_at: '', updated_at: '',
  };
  const rec = R.buildInvoiceRecord({ id: 'o.inv-1', order, seller: {}, buyer: {}, trigger: 'paid', status: 'final', now: 'x' });
  check(`P3: the record's lines carry it (${j(rec.lines.map((l) => l.tax_treatment))})`, same(rec.lines.map((l) => l.tax_treatment), ['reverse-charge', 'reverse-charge', 'reverse-charge']));
  const memo = R.buildCreditMemo({ id: 'o.cm-1', invoice: rec, docs: [rec], amount_cents: 1000, refund_id: 'r', now: 'x' });
  check('P3: a credit memo copies each credited line\'s', memo.lines.every((l) => l.tax_treatment === rec.lines[l.invoice_line].tax_treatment));
  const bare = R.buildInvoiceRecord({ id: 'o.inv-1', order: { ...order, line_totals: undefined, shipping_tax_cents: undefined }, seller: {}, buyer: {}, trigger: 'paid', status: 'final', now: 'x' });
  check('P3: an order with no breakdown → no treatment claimed on any line', bare.lines.every((l) => l.tax_treatment === undefined));

  // Retry arithmetic.
  check('P4: backoff doubles from 2 min to at most 6 h', R.issueRetryDelayMs(1) === 2 * MIN && R.issueRetryDelayMs(2) === 4 * MIN
    && R.issueRetryDelayMs(8) === 256 * MIN && R.issueRetryDelayMs(9) === 360 * MIN && R.issueRetryDelayMs(40) === 360 * MIN);
  check('P4: no next attempt at the cap', R.nextIssueAttemptAt(R.MAX_AUTO_ISSUE_ATTEMPTS, 0) === null && R.nextIssueAttemptAt(1, 0) === new Date(2 * MIN).toISOString());
  const due = (issuer, extra = {}) => R.issueRetryDue({ status: 'final', ...extra, issuer }, 10 * MIN + 1);
  check('P4: due — a retryable failure at its time; a stale claim',
    due({ id: 'a', status: 'failed', retryable: true, next_attempt_at: new Date(10 * MIN).toISOString(), attempted_at: 'x', attempts: 1 })
    && due({ id: 'a', status: 'issuing', attempted_at: new Date(0).toISOString() }));
  check('P4: not due — early, plain failure, capped, declined, issued elsewhere, no issuer id',
    !due({ id: 'a', status: 'failed', retryable: true, next_attempt_at: new Date(11 * MIN).toISOString(), attempted_at: 'x' })
    && !due({ id: 'a', status: 'failed', attempted_at: 'x', next_attempt_at: new Date(0).toISOString() })
    && !due({ id: 'a', status: 'failed', retryable: true, next_attempt_at: new Date(0).toISOString(), attempted_at: 'x', attempts: R.MAX_AUTO_ISSUE_ATTEMPTS })
    && !due({ id: '', status: 'declined', attempted_at: 'x' })
    && !due({ id: 'a', status: 'failed', retryable: true, next_attempt_at: new Date(0).toISOString(), attempted_at: 'x' }, { issued_externally: { at: 'x', actor: 'u' } })
    && !due({ id: '', status: 'failed', retryable: true, next_attempt_at: new Date(0).toISOString(), attempted_at: 'x' }));
  check('P4: a stale claim is capped too',
    due({ id: 'a', status: 'issuing', attempted_at: new Date(0).toISOString(), attempts: R.MAX_AUTO_ISSUE_ATTEMPTS - 1 })
    && !due({ id: 'a', status: 'issuing', attempted_at: new Date(0).toISOString(), attempts: R.MAX_AUTO_ISSUE_ATTEMPTS }));
  {
    // Re-rating a destination (OSS) line from the shop's own table is refused
    // since #148; exempt is the one override such a line still takes.
    const reRate = O.applyTaxOverride(dest.lines, tax, { scope: 'line', line_index: 0, tax_class: 'reduced', reason: 'r' }, 'u');
    const ov = O.applyTaxOverride(dest.lines, tax, { scope: 'line', line_index: 0, exempt: true, reason: 'r' }, 'u');
    const o2 = { ...order, items: [order.items[0]], line_totals: ov.lines, tax_overrides: [ov.record], line_totals_original: dest.lines, total_cents: 0 };
    const recDe = R.buildInvoiceRecord({ id: 'o.inv-1', order: { ...order, items: [order.items[0]], line_totals: dest.lines, total_cents: 0 }, seller: {}, buyer: {}, trigger: 'paid', status: 'final', now: 'x' });
    const recOv = R.buildInvoiceRecord({ id: 'o.inv-1', order: o2, seller: {}, buyer: {}, trigger: 'paid', status: 'final', now: 'x' });
    check(`P3: the jurisdiction is frozen on a destination line (${recDe.lines[0].tax_jurisdiction}); a class re-rate of it is refused`,
      recDe.lines[0].tax_jurisdiction === 'DE' && recDe.lines[0].tax_treatment === 'standard'
      && reRate.ok === false && /destination/.test(reRate.error ?? ''));
    // Pins CURRENT behaviour, not a settled rule: any override drops the
    // jurisdiction (invoice-records-rules.ts, `tax_rate_source !== 'override'`),
    // including exempt, whose place of supply arguably stays DE for OSS.
    // That is an owner/tax decision; change this assertion with it.
    check(`P3: an exempt override on it reads as exempt, and (today) drops the jurisdiction (${recOv.lines[0].tax_treatment}/${recOv.lines[0].tax_jurisdiction})`,
      ov.ok && recOv.lines[0].tax_treatment === 'exempt' && recOv.lines[0].tax_jurisdiction === undefined);
    // LEGACY row: a destination line re-rated by class before #148 refused it.
    const legacy = { ...order, items: [order.items[0]], line_totals: dest.lines.map(reRated),
      tax_overrides: [{ scope: 'line', line_index: 0, tax_class: 'reduced', reason: 'r', actor: 'u', at: 'x', was_rate_bp: 1900, now_rate_bp: 1300 }],
      line_totals_original: dest.lines, total_cents: 0 };
    const recLegacy = R.buildInvoiceRecord({ id: 'o.inv-1', order: legacy, seller: {}, buyer: {}, trigger: 'paid', status: 'final', now: 'x' });
    check(`P3 (legacy row): a stored class re-rate of a DE line drops the jurisdiction and reads standard (${recLegacy.lines[0].tax_jurisdiction}/${recLegacy.lines[0].tax_treatment})`,
      recLegacy.lines[0].tax_jurisdiction === undefined && recLegacy.lines[0].tax_treatment === 'standard');
  }
  check('P4: one key per record', R.issueKeyOf('o.inv-1') === 'astrobaas:o.inv-1');
  check('P5: a declined record reads as plain final, never as a failure', R.documentState({ status: 'final', issuer: { id: '', status: 'declined' } }) === 'final');

  // The precedence, as a pure function.
  const a = { id: 'alpha' }; const b = { id: 'beta' }; const c = { id: 'gamma' };
  const S = (issuerId) => ({ recordOn: 'paid', referenceFormat: null, issuerId });
  const ids = (x) => (x.kind === 'chain' ? x.issuers.map((i) => i.id) : x.kind);
  check('P6: precedence — chosen first, then hook order', same(ids(I.issuerChain(S('beta'), [a, b, c])), ['beta', 'alpha', 'gamma']));
  check('P6: none / one / several unchosen / chosen inactive',
    ids(I.issuerChain(S(null), [])) === 'none' && same(ids(I.issuerChain(S(null), [a])), ['alpha'])
    && ids(I.issuerChain(S(null), [a, b])) === 'problem' && ids(I.issuerChain(S('zeta'), [a])) === 'problem');

  // Wired into the scheduler's sweep, not just exported.
  const sched = await fs.readFile(path.join(ROOT, 'src/lib/scheduler.ts'), 'utf8');
  const body = sched.slice(sched.indexOf('export function startScheduler'), sched.indexOf('export function stopScheduler'));
  check('P7: the scheduler sweep calls the invoice retry sweep', /await sweepInvoiceIssueRetries\(\)/.test(body));
}

/* ---- per driver ---- */
const tmpRoot = path.join(os.tmpdir(), `astrobaas-issuer-seam-${process.pid}`);
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
      ...process.env, ISSUER_SEAM_CHILD: '1', NODE_ENV: 'test',
      AUTH_SECRET: 'issuer-seam-secret-0123456789abcdef',
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

for (const driver of DRIVERS) {
  const r = await runChild(driver);
  if (!r) continue;
  const t = (name, c) => check(`[${driver.name}] ${name}`, c);

  t(`D1: a decline is not a failure (${j(r.d1)})`, r.d1.state === 'final' && r.d1.status === 'declined' && r.d1.error === null && r.d1.calls === 1);
  t('D1: ...the reason is kept beside the record', same(r.d1.declined, [{ id: 'alpha', reason: 'retail is switched off' }]));
  t('D1: ...and the no-issuer behaviour applies: the internal reference', /^REF-\d+$/.test(r.d1.ref ?? ''));
  t(`D1: the credit of a declined sale is declined too, never sent, and gets its reference (${j(r.d1.memo)})`,
    r.d1.memo.state === 'final' && r.d1.memo.status === 'declined' && /^REF-\d+$/.test(r.d1.memo.ref ?? '') && r.d1.memo.calls === 1);
  t(`D1: "Issue again" asks a declined record again (${j(r.d1.again)})`, r.d1.again.called === true && r.d1.again.state === 'issued' && r.d1.again.calls === 2);

  t(`D2: the chosen issuer declines → the next active one issues it (${j(r.d2)})`,
    r.d2.state === 'issued' && r.d2.id === 'beta' && /^BETA-/.test(r.d2.number ?? '') && r.d2.alpha === 1 && r.d2.beta === 1
    && same(r.d2.declined, [{ id: 'alpha', reason: 'not a Greek sale' }]));
  t('D2: ...both were handed the same key', same(r.d2.keys, [`astrobaas:${r.d2.recId}`]));
  t(`D2: the credit goes to the issuer of its sale, not down the chain (${j(r.d2.memo)})`,
    r.d2.memo.state === 'issued' && r.d2.memo.id === 'beta' && r.d2.memo.alpha === 0 && r.d2.memo.beta === 1);
  t(`D2: a FAILURE is never passed on (${j(r.d2.fail)})`, r.d2.fail.state === 'issue_failed' && r.d2.fail.id === 'alpha' && r.d2.fail.beta === 0);
  t(`D2: every issuer declines → nobody's, both reasons, internal reference (${j(r.d2.both)})`,
    r.d2.both.state === 'final' && r.d2.both.status === 'declined' && r.d2.both.ref
    && same(r.d2.both.declined, [{ id: 'alpha', reason: 'a' }, { id: 'beta', reason: 'b' }]));
  t(`D2: precedence — the chosen issuer is asked first (${j(r.d2.chosenBeta)})`, r.d2.chosenBeta.id === 'beta' && r.d2.chosenBeta.alpha === 0 && r.d2.chosenBeta.beta === 1);
  t(`D2: two active and none chosen → nobody is called (${j(r.d2.unchosen)})`, r.d2.unchosen.state === 'issue_failed' && r.d2.unchosen.calls === 0);

  t(`C: the INVOICE_ISSUERS filter receives the settings (${r.c.filterCtx})`, r.c.filterCtx === true);
  t(`C: an issuer switched off in settings is not on the list — no state, internal reference (${j([r.c.offIssuer, r.c.offRef, r.c.offCalls])})`,
    r.c.offIssuer === null && r.c.offRef === true && r.c.offCalls === 0);
  t(`C: switched on, it issues; the call gets settings, the key and the attempt (${j(r.c.on)})`,
    r.c.on.state === 'issued' && r.c.on.calls === 1 && r.c.on.ctxSettings === 'GR'
    && r.c.on.key === r.c.on.expectedKey && r.c.on.storedKey === r.c.on.expectedKey && r.c.on.attempt === 1);

  t(`L1: a core timeout is a RETRYABLE failure, retried under the same key (${j(r.l1)})`,
    r.l1.state === 'issue_failed' && r.l1.retryable === true && r.l1.next === true && r.l1.error.includes('same key') && r.l1.hasReport);
  t(`L1: the issuer's late success is accepted (${j([r.l1.late, r.l1.after])})`,
    r.l1.late?.ok === true && r.l1.late.accepted === true && r.l1.after.state === 'issued' && r.l1.after.number === 'LATE-1'
    && r.l1.after.mark === '900001' && r.l1.after.late === true && r.l1.after.next === null);
  t(`L1: reported twice → the second is not accepted again (${j(r.l1.again)})`, r.l1.again?.ok === true && r.l1.again.accepted === false);
  t(`L2: the wrong key, the wrong issuer → refused, nothing written (${j(r.l2)})`,
    r.l2.wrongKey === 'conflict' && r.l2.wrongIssuer === 'conflict' && r.l2.state === 'issue_failed');
  t(`L3: compare-and-set — marked issued elsewhere in between, the late success does not overwrite it (${j(r.l3)})`,
    r.l3.fired === true && r.l3.marked === true && r.l3.late === 'conflict' && r.l3.state === 'issued_elsewhere'
    && r.l3.issuerStatus === 'failed' && r.l3.number === null);

  t(`R1: a retryable failure is scheduled 2 min out (${j(r.r1.first)})`, r.r1.first.attempts === 1 && r.r1.first.retryable === true && r.r1.first.wait === 2 * MIN);
  t(`R1: not before its time; at its time, retried with backoff 4 min (${j([r.r1.earlyRetried, r.r1.s1, r.r1.second])})`,
    r.r1.earlyRetried === 0 && r.r1.s1 === 1 && r.r1.second.attempts === 2 && r.r1.second.wait === 4 * MIN && r.r1.second.attempt === 2);
  t(`R1: the provider back → issued; nothing more is sent (${j([r.r1.s2, r.r1.state, r.r1.number, r.r1.s3, r.r1.callsAfterIssued])})`,
    r.r1.s2.retried === 1 && r.r1.s2.issued === 1 && r.r1.state === 'issued' && /^ALPHA-/.test(r.r1.number ?? '') && r.r1.s3 === 0 && r.r1.callsAfterIssued === 0);
  t(`R1: every call carried the SAME key (${j(r.r1.keys)}, ${r.r1.totalCalls} calls)`, same(r.r1.keys, [`astrobaas:${r.r1.recId}`]) && r.r1.totalCalls === 3);
  t(`R2: two sweeps and a person at once → ONE call (${j(r.r2)})`, r.r2.calls === 2 && r.r2.state === 'issued' && r.r2.number === 'ONCE-1');
  t(`R3: a plain failure is never retried automatically (${j(r.r3)})`, r.r3.calls === 1 && r.r3.retried === 0 && r.r3.retryable === null && r.r3.next === null);
  t(`R4: capped at ${r.r4.max} calls, then left for a person (${j(r.r4)})`,
    r.r4.calls === r.r4.max && r.r4.attempts === r.r4.max && r.r4.next === null && r.r4.retryable === true && r.r4.after === 0);
  t(`R5: an unknown outcome stays with its issuer — never handed to the newly chosen one (${j(r.r5)})`,
    r.r5.manualOff === 'conflict' && r.r5.manualMsg.includes('may already have issued') && r.r5.sweepOff === 0
    && r.r5.sweepOn === 1 && r.r5.id === 'alpha' && r.r5.state === 'issued' && r.r5.beta === 0);
  t(`R6: a claim left by a crash is retried by the scheduler's sweep, same issuer and key (${j(r.r6)})`,
    r.r6.retried === 1 && r.r6.state === 'issued' && r.r6.key === r.r6.expectedKey && r.r6.attempt === 2);

  t(`F1: records whose issuer is switched off do not starve the others (${j(r.f1)})`,
    r.f1.retried === 1 && r.f1.beta === 1 && r.f1.state === 'issued' && r.f1.id === 'beta');
  t(`F2: a plain failure stays with its issuer — "Issue again" never hands it down the chain (${j(r.f2)})`,
    r.f2.firstId === 'beta' && r.f2.firstState === 'issue_failed' && r.f2.called === true
    && r.f2.alpha === 0 && r.f2.beta === 1 && r.f2.id === 'beta' && r.f2.state === 'issued');
  t(`F3: a throw is an unknown outcome — retryable (${j(r.f3)})`, r.f3.state === 'issue_failed' && r.f3.retryable === true && r.f3.next === true);
  t(`F4: the sale's issuer declining its credit is shown as a failure (${j(r.f4)})`,
    r.f4.state === 'issue_failed' && r.f4.error.includes('declined this credit') && r.f4.ref === null);
  t(`F5: a stale claim may be marked issued elsewhere; a live one may not (${j(r.f5)})`,
    r.f5.live === 'conflict' && r.f5.stale === 'ok' && r.f5.state === 'issued_elsewhere');

  t(`T1: a domestic sale → standard on every line (${j(r.t1)})`,
    r.t1.length === 3 && r.t1.every(([, rate, tr]) => rate > 0 && tr === 'standard'));
  t(`T2: an export → export on goods and shipping, no VAT (${j(r.t2)})`,
    r.t2.tax === 0 && r.t2.lines.length === 3 && r.t2.lines.every(([, rate, tr]) => rate === 0 && tr === 'export'));
  t(`T3: an exemption recorded through the override route → exempt on that line only (${j(r.t3)})`,
    r.t3.override === 200 && same(r.t3.lines?.map((x) => x[2]), ['exempt', 'standard', 'standard']) && r.t3.lines[0][1] === 0);
  t(`T4: the refund's memo carries each credited line's treatment (${j(r.t4)})`,
    Array.isArray(r.t4) && r.t4.length > 0 && r.t4.every(([i, tr]) => tr === r.t4inv[i]));
}

await fs.rm(tmpRoot, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
