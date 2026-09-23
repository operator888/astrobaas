#!/usr/bin/env node
/**
 * Payments: webhook verification, capture decisions, provider enablement.
 *
 * This is the money path, so it gets adversarial coverage. Everything here is
 * offline — the security-critical parts were deliberately written as pure
 * functions so they can be attacked in a unit test rather than only in
 * production:
 *
 *   - forged and replayed webhook signatures
 *   - a genuinely-signed event about the WRONG order or the wrong amount
 *   - duplicate delivery (providers retry; at-least-once is the contract)
 *   - refunds for orders that were never paid
 *   - half-configured providers being offered at checkout
 *
 * Run with:  node tests/payments.test.mjs
 */
import { build } from 'esbuild';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cacheDir = path.join(here, '..', 'node_modules', '.cache');
await fs.mkdir(cacheDir, { recursive: true });

async function load(rel, tag) {
  const out = path.join(cacheDir, `astrobaas-${tag}-${process.pid}.mjs`);
  await build({
    entryPoints: [path.join(here, '..', rel)],
    bundle: true, format: 'esm', platform: 'node', packages: 'external',
    outfile: out, logLevel: 'silent',
  });
  const mod = await import(pathToFileURL(out).href);
  await fs.rm(out, { force: true });
  return mod;
}

const sig = await load('src/lib/payments/signatures.ts', 'pay-sig');
const cap = await load('src/lib/payments/capture.ts', 'pay-cap');
const reg = await load('src/lib/payments/registry.ts', 'pay-reg');
const ref = await load('src/lib/payments/refunds.ts', 'pay-ref');

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) pass++;
  else {
    fail++;
    console.error(`✗ ${name}`);
  }
}

/* ------------------------------------------------------------------ *
 * Stripe signature verification
 * ------------------------------------------------------------------ */
const SECRET = 'whsec_test_secret';
const BODY = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });
const NOW = 1_700_000_000_000; // fixed clock; nothing here reads the real one

function signed(body, secret, tsSeconds) {
  const mac = crypto.createHmac('sha256', secret).update(`${tsSeconds}.${body}`, 'utf8').digest('hex');
  return `t=${tsSeconds},v1=${mac}`;
}

{
  const ts = Math.floor(NOW / 1000);
  const good = signed(BODY, SECRET, ts);

  check('a correctly signed payload verifies',
    sig.verifyStripeSignature({ rawBody: BODY, header: good, secret: SECRET, nowMs: NOW }));

  // --- forgery ---
  check('a wrong secret is rejected',
    !sig.verifyStripeSignature({ rawBody: BODY, header: good, secret: 'whsec_other', nowMs: NOW }));
  check('a tampered body is rejected (this is the whole point)',
    !sig.verifyStripeSignature({ rawBody: BODY.replace('evt_1', 'evt_2'), header: good, secret: SECRET, nowMs: NOW }));
  check('a body re-serialised differently fails — routes must pass raw bytes',
    !sig.verifyStripeSignature({ rawBody: JSON.stringify(JSON.parse(BODY), null, 2), header: good, secret: SECRET, nowMs: NOW }));
  check('an empty/absent header is rejected',
    !sig.verifyStripeSignature({ rawBody: BODY, header: null, secret: SECRET, nowMs: NOW }) &&
    !sig.verifyStripeSignature({ rawBody: BODY, header: '', secret: SECRET, nowMs: NOW }));
  check('a header with no v1 is rejected',
    !sig.verifyStripeSignature({ rawBody: BODY, header: `t=${ts}`, secret: SECRET, nowMs: NOW }));
  check('a non-hex / wrong-length signature is rejected',
    !sig.verifyStripeSignature({ rawBody: BODY, header: `t=${ts},v1=zzzz`, secret: SECRET, nowMs: NOW }));
  check('an EMPTY secret never verifies (missing config must not pass everything)',
    !sig.verifyStripeSignature({ rawBody: BODY, header: good, secret: '', nowMs: NOW }));

  // --- replay ---
  check('a signature older than the tolerance is rejected',
    !sig.verifyStripeSignature({ rawBody: BODY, header: signed(BODY, SECRET, ts - 3600), secret: SECRET, nowMs: NOW }));
  check('a FUTURE-dated signature is rejected too (no extended window via clock skew)',
    !sig.verifyStripeSignature({ rawBody: BODY, header: signed(BODY, SECRET, ts + 3600), secret: SECRET, nowMs: NOW }));
  check('inside the tolerance still verifies',
    sig.verifyStripeSignature({ rawBody: BODY, header: signed(BODY, SECRET, ts - 60), secret: SECRET, nowMs: NOW }));
  check('a non-integer timestamp cannot smuggle past the window',
    !sig.verifyStripeSignature({ rawBody: BODY, header: `t=NaN,v1=${'a'.repeat(64)}`, secret: SECRET, nowMs: NOW }) &&
    !sig.verifyStripeSignature({ rawBody: BODY, header: `t=1e99,v1=${'a'.repeat(64)}`, secret: SECRET, nowMs: NOW }));

  // --- secret rotation: Stripe sends several v1s ---
  const rotating = `${signed(BODY, 'whsec_old', ts)},v1=${crypto.createHmac('sha256', SECRET).update(`${ts}.${BODY}`).digest('hex')}`;
  check('any matching v1 verifies, so a secret roll does not drop events',
    sig.verifyStripeSignature({ rawBody: BODY, header: rotating, secret: SECRET, nowMs: NOW }));

  check('parse returns null for junk', sig.parseStripeSignature('garbage') === null);
  check('timingSafeEqual is still correct', sig.timingSafeEqual('abc', 'abc') && !sig.timingSafeEqual('abc', 'abd'));
  check('timingSafeEqual tolerates unequal lengths without throwing', sig.timingSafeEqual('a', 'bbbbbbbb') === false);
}

/* ------------------------------------------------------------------ *
 * Amount matching — a valid signature proves provenance, not relevance
 * ------------------------------------------------------------------ */
{
  const m = sig.amountMatches;
  check('exact match passes', m(5000, 'EUR', 5000, 'EUR'));
  check('currency case is ignored', m(5000, 'eur', 5000, 'EUR'));
  check('UNDERPAYMENT is refused (the "1 cent for a laptop" case)', !m(50000, 'EUR', 1, 'EUR'));
  check('overpayment is refused too', !m(5000, 'EUR', 9999, 'EUR'));
  check('a different currency is refused', !m(5000, 'EUR', 5000, 'USD'));
  check('missing amount/currency is refused', !m(5000, 'EUR', null, 'EUR') && !m(5000, 'EUR', 5000, null));
  check('a non-integer amount is refused', !m(5000, 'EUR', 50.5, 'EUR'));
}

/* ------------------------------------------------------------------ *
 * Capture decisions
 * ------------------------------------------------------------------ */
const order = (over = {}) => ({ total_cents: 5000, currency: 'EUR', payment_status: 'pending', payment_events: [], ...over });
const evt = (over = {}) => ({ eventId: 'evt_1', reference: 'order-1', outcome: 'paid', amountCents: 5000, currency: 'EUR', rawType: 'checkout.session.completed', ...over });

{
  const d = (o, e) => cap.decidePaymentEvent(o, e);

  check('a matching success captures', (() => {
    const r = d(order(), evt());
    return r.action === 'capture' && r.paymentStatus === 'paid' && r.orderStatus === 'processing';
  })());
  check('capture never jumps an order to completed', d(order(), evt()).orderStatus !== 'completed');

  // --- idempotency: providers deliver at least once ---
  check('a replayed event id is ignored',
    d(order({ payment_events: ['evt_1'] }), evt()).action === 'ignore');
  check('a success on an already-paid order is ignored',
    d(order({ payment_status: 'paid' }), evt({ eventId: 'evt_2' })).action === 'ignore');
  check('recordEvent appends and stays bounded', (() => {
    let list = [];
    for (let i = 0; i < cap.PAYMENT_EVENT_HISTORY + 20; i++) list = cap.recordEvent(list, `e${i}`);
    return list.length === cap.PAYMENT_EVENT_HISTORY && list[list.length - 1] === `e${cap.PAYMENT_EVENT_HISTORY + 19}`;
  })());
  check('recordEvent ignores an empty id', cap.recordEvent(['a'], '').length === 1);

  // --- the amount gate ---
  check('a signed event with the WRONG amount is rejected, not captured', (() => {
    const r = d(order(), evt({ amountCents: 1 }));
    return r.action === 'reject' && r.suspicious === true;
  })());
  check('a signed event in the wrong currency is rejected',
    d(order(), evt({ currency: 'USD' })).action === 'reject');
  check('a rejection explains the mismatch', /Amount mismatch/.test(d(order(), evt({ amountCents: 1 })).reason));

  // --- failure handling ---
  check('a failure cancels (which returns stock)', (() => {
    const r = d(order(), evt({ outcome: 'failed', rawType: 'checkout.session.expired' }));
    return r.action === 'fail' && r.paymentStatus === 'failed' && r.orderStatus === 'cancelled';
  })());
  check('a LATE failure on a paid order is ignored — never cancel a paid order',
    d(order({ payment_status: 'paid' }), evt({ outcome: 'failed', eventId: 'evt_9' })).action === 'ignore');
  check('a repeat failure is ignored',
    d(order({ payment_status: 'failed' }), evt({ outcome: 'failed', eventId: 'evt_9' })).action === 'ignore');

  // --- refunds ---
  check('a refund of a paid order refunds it', (() => {
    const r = d(order({ payment_status: 'paid' }), evt({ outcome: 'refunded', eventId: 'evt_r' }));
    return r.action === 'refund' && r.orderStatus === 'refunded';
  })());
  check('a refund of an order that was never paid is REJECTED (free stock release)', (() => {
    const r = d(order({ payment_status: 'unpaid' }), evt({ outcome: 'refunded', eventId: 'evt_r' }));
    return r.action === 'reject' && r.suspicious === true;
  })());
  check('a late success after a refund is ignored',
    d(order({ payment_status: 'refunded' }), evt({ eventId: 'evt_l' })).action === 'ignore');

  // --- unknown events change nothing ---
  check('an ignored outcome does nothing',
    d(order(), evt({ outcome: 'ignored', rawType: 'invoice.upcoming' })).action === 'ignore');
  check('an order with no payment_status is treated as unpaid, not as paid',
    d(order({ payment_status: undefined }), evt()).action === 'capture');
}

/* ------------------------------------------------------------------ *
 * Provider registry / enablement
 * ------------------------------------------------------------------ */
{
  const full = {
    PAYMENTS_ENABLED: 'stripe,paypal,klarna',
    STRIPE_SECRET_KEY: 'sk_test', STRIPE_WEBHOOK_SECRET: 'whsec',
    PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'sec', PAYPAL_WEBHOOK_ID: 'wh',
    KLARNA_USERNAME: 'u', KLARNA_PASSWORD: 'p',
  };

  check('the three launch providers are registered',
    ['stripe', 'paypal', 'klarna'].every((id) => reg.getProvider(id)));
  check('fully configured + requested → all enabled', reg.enabledProviders(full).length === 3);
  check('nothing is enabled by default (no PAYMENTS_ENABLED)', reg.enabledProviders({}).length === 0);

  // Half-configured is the dangerous state: it must NOT be offered.
  const half = { ...full, STRIPE_WEBHOOK_SECRET: '' };
  check('a provider missing a credential is NOT offered',
    !reg.enabledProviders(half).some((p) => p.id === 'stripe'));
  check('a blank (whitespace) credential counts as missing',
    !reg.enabledProviders({ ...full, KLARNA_PASSWORD: '   ' }).some((p) => p.id === 'klarna'));
  check('configured but not requested → not offered',
    !reg.enabledProviders({ ...full, PAYMENTS_ENABLED: 'stripe' }).some((p) => p.id === 'paypal'));

  const report = reg.paymentConfigReport(half);
  const stripeRow = report.find((r) => r.id === 'stripe');
  check('the report names the missing variable', stripeRow.missingEnv.includes('STRIPE_WEBHOOK_SECRET'));
  check('the report flags requested-but-broken', stripeRow.requested === true && stripeRow.enabled === false);
  check('the report NEVER contains a credential value',
    !JSON.stringify(report).includes('sk_test') && !JSON.stringify(report).includes('whsec'));

  // Accepted methods at checkout.
  check('manual methods are always accepted', reg.isAcceptedMethod('bank-transfer', {}) && reg.isAcceptedMethod('cod', {}));
  check('an enabled provider is accepted', reg.isAcceptedMethod('stripe', full));
  check('a DISABLED provider is refused at checkout', !reg.isAcceptedMethod('stripe', half));
  check('an unknown method is refused', !reg.isAcceptedMethod('bitcoin', full));

  // providerContext must fail loudly rather than send a blank credential.
  const ctx = reg.providerContext({ env: { A: 'x', B: '  ' }, siteUrl: 'https://shop.example/' });
  check('context strips a trailing slash from siteUrl', ctx.siteUrl === 'https://shop.example');
  check('env() returns a present value', ctx.env('A') === 'x');
  check('env() THROWS on a blank value instead of returning ""', (() => {
    try { ctx.env('B'); return false; } catch { return true; }
  })());
  check('env() throws on a missing value', (() => {
    try { ctx.env('NOPE'); return false; } catch { return true; }
  })());

  /* ---- validateEnv: credentials that are PRESENT and cannot work ---- */
  // `requiredEnv` answers "is it there?". It cannot answer "is it usable?", and
  // a gateway addressed by a checksummed identifier — a Greek ΑΦΜ, an IBAN —
  // fails that second question with a value sitting right there in the .env.
  const good = { PAYMENTS_ENABLED: 'demo', DEMO_KEY: 'k' };
  const demo = (validateEnv) => ({
    id: 'demo', label: 'Demo', requiredEnv: ['DEMO_KEY'],
    createSession: async () => ({ reference: 'r', redirectUrl: 'https://x' }),
    verifyWebhook: async () => ({ eventId: 'e', reference: 'r', outcome: 'ignored', amountCents: null, currency: null, rawType: 't' }),
    ...(validateEnv ? { validateEnv } : {}),
  });

  reg.setPluginProviders([demo()]);
  check('a provider WITHOUT validateEnv is unaffected', reg.enabledProviders(good).length === 1);
  check('and reports an empty problems array',
    Array.isArray(reg.paymentConfigReport(good).find((r) => r.id === 'demo').problems));

  reg.setPluginProviders([demo(() => ['DEMO_KEY failed its check digit'])]);
  const broken = reg.paymentConfigReport(good).find((r) => r.id === 'demo');
  check('a reported problem DISABLES the provider', broken.enabled === false);
  check('it is not offered at checkout', !reg.isAcceptedMethod('demo', good));
  check('the problem is separate from missingEnv — the fix is different',
    broken.missingEnv.length === 0 && broken.problems.length === 1);

  reg.setPluginProviders([demo(() => { throw new Error('boom'); })]);
  const threw = reg.paymentConfigReport(good).find((r) => r.id === 'demo');
  // A provider whose own check throws must not take the admin screen down with
  // it, and must certainly not end up enabled by default.
  check("a validateEnv that THROWS fails closed", threw.enabled === false && threw.problems.length === 1);

  reg.setPluginProviders([demo(() => ['x'])]);
  check('validateEnv is not consulted while a variable is still MISSING',
    reg.paymentConfigReport({ PAYMENTS_ENABLED: 'demo' }).find((r) => r.id === 'demo').problems.length === 0);

  reg.setPluginProviders([demo(() => ['  ', '', 'real problem'])]);
  check('blank problem strings are dropped',
    reg.paymentConfigReport(good).find((r) => r.id === 'demo').problems.length === 1);

  reg.setPluginProviders([]);
  check('clearing plugin providers restores the built-in set', reg.allProviders().length === 3);

  /* ---- manual methods: no credentials, no API, a buyer told what to do ---- */
  check('the built-in manual methods are there',
    reg.allManualMethods().map((m) => m.id).sort().join() === 'bank-transfer,cod');
  check('and are always accepted at checkout',
    reg.isManualMethod('bank-transfer') && reg.isManualMethod('cod'));
  check('an unknown method is not manual', !reg.isManualMethod('iris-direct'));

  reg.setPluginManualMethods([
    { id: 'iris-direct', label: 'IRIS', instructions: { el: 'Πληρώστε…', en: 'Pay…' } },
  ]);
  check('a plugin can add one', reg.isManualMethod('iris-direct'));
  check('it is accepted at checkout with no PAYMENTS_ENABLED at all',
    reg.isAcceptedMethod('iris-direct', {}));
  check('instructions survive for the storefront to render',
    reg.allManualMethods().find((m) => m.id === 'iris-direct').instructions.el === 'Πληρώστε…');

  // The dangerous collision: isAcceptedMethod asks about manual methods FIRST,
  // so a manual method shadowing a gateway id would make checkout accept as
  // "pay us later" an order the shop believes went through a gateway.
  reg.setPluginProviders([demo()]);
  reg.setPluginManualMethods([{ id: 'demo', label: 'Impostor' }]);
  check('a manual method may NOT shadow a PROVIDER id', !reg.isManualMethod('demo'));
  reg.setPluginManualMethods([{ id: 'cod', label: 'Impostor' }]);
  check('nor a built-in manual id', reg.allManualMethods().filter((m) => m.id === 'cod').length === 1);

  for (const bad of [{ id: '', label: 'x' }, { id: 'x' }, { id: 'x', label: '' }, null]) {
    reg.setPluginManualMethods([bad]);
    check(`a malformed manual method ${JSON.stringify(bad)} is ignored without throwing`,
      reg.allManualMethods().length === 2);
  }

  reg.setPluginManualMethods([]);
  reg.setPluginProviders([]);
  check('clearing restores the built-in manual set', reg.allManualMethods().length === 2);
}

/* ------------------------------------------------------------------ *
 * Refund bounds — the arithmetic that decides how much money leaves
 * ------------------------------------------------------------------ */
{
  const { planRefund, refundedTotal, refundableRemaining, paymentStatusAfterRefund,
    refundIdempotencyKey } = ref;

  const paid = (over = {}) => ({
    total_cents: 5000, currency: 'EUR', payment_status: 'paid',
    payment_provider: 'stripe', refunds: [], ...over,
  });

  // --- the happy paths ---
  check('a full refund is planned when no amount is given', (() => {
    const p = planRefund(paid(), null);
    return p.ok && p.amountCents === 5000 && p.isFullRefund && p.remainingAfter === 0;
  })());
  check('a partial refund leaves a remainder', (() => {
    const p = planRefund(paid(), 2000);
    return p.ok && p.amountCents === 2000 && !p.isFullRefund && p.remainingAfter === 3000;
  })());
  check('refunding exactly the remainder is allowed', planRefund(paid(), 5000).ok);

  // --- the aggregate rule: each partial can look valid while the SUM is not ---
  const partly = paid({ refunds: [{ id: 'r1', amount_cents: 3000, at: '', actor: 'u' }] });
  check('remaining accounts for earlier refunds', refundableRemaining(partly) === 2000);
  check('a second refund is capped at what remains', planRefund(partly, 2000).ok);
  check('a second refund EXCEEDING the remainder is refused', !planRefund(partly, 2001).ok);
  check('"refund the rest" means the REMAINDER, not the order total', (() => {
    const p = planRefund(partly, null);
    return p.ok && p.amountCents === 2000;
  })());
  check('a fully refunded order refuses more', (() => {
    const done = paid({ refunds: [{ id: 'r1', amount_cents: 5000, at: '', actor: 'u' }] });
    const p = planRefund(done, 1);
    return !p.ok && p.reason === 'nothing-remaining';
  })());
  check('over-refunded records never yield a negative remaining',
    refundableRemaining(paid({ refunds: [{ id: 'r', amount_cents: 9999, at: '', actor: 'u' }] })) === 0);

  // --- only paid orders, only via a provider ---
  for (const st of ['unpaid', 'pending', 'failed', 'refunded']) {
    check(`a "${st}" order cannot be refunded`, (() => {
      const p = planRefund(paid({ payment_status: st }), 100);
      return !p.ok && p.reason === 'not-paid';
    })());
  }
  check('an order with no provider cannot be auto-refunded', (() => {
    const p = planRefund(paid({ payment_provider: undefined }), 100);
    return !p.ok && p.reason === 'no-provider';
  })());
  check('a missing payment_status is treated as unpaid',
    !planRefund(paid({ payment_status: undefined }), 100).ok);

  // --- money is integer minor units ---
  for (const bad of [0, -1, 19.99, NaN, Infinity, 2.5]) {
    check(`an amount of ${bad} is refused`, (() => {
      const p = planRefund(paid(), bad);
      return !p.ok && (p.reason === 'invalid-amount' || p.reason === 'exceeds-remaining');
    })());
  }

  // --- malformed stored rows must not poison the total ---
  const messy = paid({
    refunds: [
      { id: 'a', amount_cents: 1000, at: '', actor: 'u' },
      { id: 'b', amount_cents: 'lots', at: '', actor: 'u' },
      { id: 'c', amount_cents: -500, at: '', actor: 'u' },
      { id: 'd', amount_cents: 1.5, at: '', actor: 'u' },
      null,
    ],
  });
  check('malformed refund rows are ignored, not NaN-ed', refundedTotal(messy) === 1000);
  check('a plan still computes over messy history', planRefund(messy, 4000).ok);

  // --- status after ---
  check('a partial refund leaves the order PAID (money still held)',
    paymentStatusAfterRefund(3000) === 'paid');
  check('only a full refund flips to refunded', paymentStatusAfterRefund(0) === 'refunded');

  // --- idempotency keys ---
  const k1 = refundIdempotencyKey('o1', 0, 2000);
  check('the same refund attempt reuses its key', k1 === refundIdempotencyKey('o1', 0, 2000));
  check('a DIFFERENT amount gets a different key', k1 !== refundIdempotencyKey('o1', 0, 3000));
  check('a legitimate SECOND partial gets a different key (not a silent no-op)',
    k1 !== refundIdempotencyKey('o1', 2000, 2000));
  check('different orders never share a key', k1 !== refundIdempotencyKey('o2', 0, 2000));

  // --- every shipped provider can actually refund ---
  check('stripe, paypal and klarna all implement refund()',
    ['stripe', 'paypal', 'klarna'].every((id) => typeof reg.getProvider(id).refund === 'function'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
