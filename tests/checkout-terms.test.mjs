#!/usr/bin/env node
/**
 * Checkout consent: "I agree to the Terms & Conditions".
 *
 * The pure half (resolver, parser, validator, visibility) runs in this
 * process. Everything that needs storage runs once per driver in a child
 * process with its own database, through the REAL POST /api/orders handler:
 * what a storefront sees — status, reason code, response body — is the
 * contract, and the order is read back from storage to prove what was kept.
 *
 *  T1  off by default: nothing is refused, an unanswered box stores nothing
 *  T2  an acceptance is stored, with the SERVER's timestamp
 *  T3  required: missing or false is a 400 with a stable code, and reserves nothing
 *  T4  only a real boolean is a consent record
 *  T5  staff are never refused; an API key is
 *  T6  a client cannot supply the timestamp
 *  T7  an explicit "no" is stored as false while the requirement is off
 *  T8  idempotency: a refusal does not burn the key; a replay returns the answer
 *  T9  privacy_accepted is recorded and never required
 *  T10 internal callers of placeOrder (importers, plugins) are unaffected
 *  T11 quoting is unaffected; the public settings expose the box, nothing else
 *
 * Run with:  node tests/checkout-terms.test.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, loadTs } from './lib/load.mjs';

const SECRET = 'checkout-terms-secret-0123456789abcdef';

/* ---------------------------------------------------------------- child --- */

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
  let ipSeq = 0;
  const nextIp = () => `100.64.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`;

  const call = async (handler, { url = 'http://localhost/api/x', body, headers = {}, locals = {}, method = 'POST' } = {}) => {
    const res = await handler({
      request: new Request(url, {
        method,
        headers: { 'content-type': 'application/json', ...headers },
        ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
      }),
      locals: { user: null, ip: nextIp(), ...locals },
      url: new URL(url),
      params: {},
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return {
      code: res.status, json, data: json?.data,
      errCode: json?.error?.reason ?? json?.error?.code ?? null,
      details: json?.error?.details ?? null,
      headers: Object.fromEntries(res.headers),
    };
  };
  const order = (body, opts = {}) => call(M.postOrder, { url: 'http://localhost/api/orders', body, ...opts });
  const stored = async (number) => (await LocalDB.getOrders()).find((o) => o.number === number);
  const staff = { user: { id: 'staff-1', role: 'admin' } };
  const apiKey = { user: { id: 'apikey:k1', role: 'editor' } };
  let mail = 0;
  const email = () => `buyer${++mail}@example.com`;

  /* T1, T2, T6, T7, T9: the requirement is off */
  await guard('off', async () => {
    const p = await product('off', 50);
    const item = [{ product_id: p.id, qty: 1 }];
    const r = {};
    const bare = await order({ email: email(), items: item });
    const bareStored = await stored(bare.data?.number);
    r.bare = {
      code: bare.code, hasKey: 'terms_accepted' in (bare.data ?? {}),
      stored: bareStored ? Object.keys(bareStored).filter((k) => /terms|privacy/.test(k)) : null,
    };
    const before = Date.now();
    const yes = await order({ email: email(), items: item, terms_accepted: true });
    const after = Date.now();
    const yesStored = await stored(yes.data?.number);
    r.yes = {
      code: yes.code, body: yes.data?.terms_accepted, bodyAt: yes.data?.terms_accepted_at,
      stored: yesStored?.terms_accepted, at: yesStored?.terms_accepted_at,
      inWindow: Date.parse(yesStored?.terms_accepted_at) >= before - 1 && Date.parse(yesStored?.terms_accepted_at) <= after + 1,
      sameAsBody: yesStored?.terms_accepted_at === yes.data?.terms_accepted_at,
    };
    // T6: a timestamp the client names is not read.
    const forged = await order({ email: email(), items: item, terms_accepted: true, terms_accepted_at: '2001-01-01T00:00:00.000Z' });
    r.forgedAt = (await stored(forged.data?.number))?.terms_accepted_at;
    // T7: an explicit no is kept, with no timestamp.
    const no = await order({ email: email(), items: item, terms_accepted: false });
    const noStored = await stored(no.data?.number);
    r.no = { code: no.code, stored: noStored?.terms_accepted, hasAt: 'terms_accepted_at' in (noStored ?? {}) };
    // T9: privacy is recorded, never required.
    const priv = await order({ email: email(), items: item, privacy_accepted: true });
    const privStored = await stored(priv.data?.number);
    r.privacy = { code: priv.code, stored: privStored?.privacy_accepted, at: typeof privStored?.privacy_accepted_at, terms: 'terms_accepted' in (privStored ?? {}) };
    return r;
  });

  /* T3, T4, T5, T6, T8: the requirement is on */
  await guard('required', async () => {
    await setting('checkout_terms_required', true);
    const p = await product('req', 20);
    const item = [{ product_id: p.id, qty: 1 }];
    const r = {};
    const ordersBefore = (await LocalDB.getOrders()).length;
    const stockBefore = await stockOf(p.id);
    const missing = await order({ email: email(), items: item });
    const falsy = await order({ email: email(), items: item, terms_accepted: false });
    r.missing = { code: missing.code, errCode: missing.errCode };
    r.falsy = { code: falsy.code, errCode: falsy.errCode };
    r.reserved = { orders: (await LocalDB.getOrders()).length - ordersBefore, stock: (await stockOf(p.id)) - stockBefore };
    // T4: only a boolean.
    const asString = await order({ email: email(), items: item, terms_accepted: 'true' });
    const asNumber = await order({ email: email(), items: item, terms_accepted: 1 });
    const badPrivacy = await order({ email: email(), items: item, terms_accepted: true, privacy_accepted: 'yes' });
    r.notBoolean = [asString, asNumber, badPrivacy].map((x) => ({ code: x.code, code2: x.errCode, fields: Object.keys(x.details ?? {}) }));
    const ok = await order({ email: email(), items: item, terms_accepted: true });
    const okStored = await stored(ok.data?.number);
    r.ok = { code: ok.code, stored: okStored?.terms_accepted, hasAt: !!okStored?.terms_accepted_at };
    // T5: staff exempt, API key not.
    const st = await order({ email: email(), items: item }, { locals: staff });
    const stStored = await stored(st.data?.number);
    r.staff = { code: st.code, stored: stStored ? 'terms_accepted' in stStored : null };
    const keyMissing = await order({ email: email(), items: item }, { locals: apiKey });
    const keyYes = await order({ email: email(), items: item, terms_accepted: true }, { locals: apiKey });
    r.key = { missing: keyMissing.code, missingCode: keyMissing.errCode, yes: keyYes.code };
    // A stored string "false" reads as off.
    await setting('checkout_terms_required', 'false');
    r.stringFalse = (await order({ email: email(), items: item })).code;
    await setting('checkout_terms_required', true);
    // T8: a refusal does not burn the key; a replay returns the same answer.
    const key = 'terms-key-0001';
    const first = await order({ email: 'idem@example.com', items: item }, { headers: { 'idempotency-key': key } });
    const retry = await order({ email: 'idem@example.com', items: item, terms_accepted: true }, { headers: { 'idempotency-key': key } });
    const replay = await order({ email: 'idem@example.com', items: item, terms_accepted: true }, { headers: { 'idempotency-key': key } });
    r.idem = {
      first: first.code, firstCode: first.errCode, retry: retry.code,
      replay: replay.code, replayed: replay.headers['idempotent-replayed'],
      same: replay.data?.number === retry.data?.number, replayAnswer: replay.data?.terms_accepted,
    };
    // T11: quoting is not gated.
    const q = await call(M.postQuote, { url: 'http://localhost/api/orders/quote', body: { items: item } });
    r.quote = q.code;
    // Switch it off again: unanswered checkouts work.
    await setting('checkout_terms_required', false);
    r.offAgain = (await order({ email: email(), items: item })).code;
    return r;
  });

  /* T10: an internal caller never names the field */
  await guard('internal', async () => {
    await setting('checkout_terms_required', true);
    const p = await product('int', 5);
    const placed = await M.placeOrder({ email: email(), items: [{ product_id: p.id, qty: 1 }] });
    const o = placed.ok ? placed.value : null;
    const refused = await M.placeOrder({ email: email(), items: [{ product_id: p.id, qty: 1 }], require_terms: true });
    const accepted = await M.placeOrder({ email: email(), items: [{ product_id: p.id, qty: 1 }], require_terms: true, terms_accepted: true });
    await setting('checkout_terms_required', false);
    return {
      ok: placed.ok, hasTerms: o ? 'terms_accepted' in o : null,
      refused: refused.ok ? 'placed' : `${refused.status}/${refused.code}`,
      accepted: accepted.ok && accepted.value.terms_accepted === true,
    };
  });

  /* T11: what the public settings read says */
  await guard('settings', async () => {
    await setting('checkout_terms_required', true);
    await setting('checkout_terms_label', 'I agree to the Store Terms');
    await setting('checkout_terms_url', '/terms');
    await setting('orders_risk_hold_score', 7);
    const res = await call(M.getPublicSettings, { url: 'http://localhost/api/settings/get', method: 'GET' });
    return {
      code: res.code,
      required: res.data?.checkout_terms_required,
      label: res.data?.checkout_terms_label,
      url: res.data?.checkout_terms_url,
      leaksUnrelated: 'orders_risk_hold_score' in (res.data ?? {}),
    };
  });

  return out;
}

if (process.env.CHECKOUT_TERMS_CHILD) {
  const M = await loadTs('tests/fixtures/checkout-entry.ts', 'checkoutterms');
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

await safe('resolver', async () => {
  const T = await loadTs('src/lib/commerce/checkout-terms.ts');
  const d = T.resolveCheckoutTermsSettings({});
  check(`T1: nothing is required by default (${j(d)})`, d.required === false);
  check('T1: ...the label falls back to the stock sentence and there is no link',
    d.label === 'I agree to the Terms & Conditions' && d.url === null);
  check('T1: a missing settings map is the default too', T.resolveCheckoutTermsSettings(null).required === false);
  check('T3: true, "true" and 1 switch it on',
    [true, 'true', 1, '1'].every((v) => T.resolveCheckoutTermsSettings({ checkout_terms_required: v }).required === true));
  check('T3: "false" and junk read as off',
    ['false', 0, '', 'maybe', null].every((v) => T.resolveCheckoutTermsSettings({ checkout_terms_required: v }).required === false));
  check('the merchant\'s label is used, trimmed',
    T.resolveCheckoutTermsSettings({ checkout_terms_label: '  I agree to the Store Terms ' }).label === 'I agree to the Store Terms');
  check('a label that is blank or not text falls back',
    ['   ', 5, {}].every((v) => T.resolveCheckoutTermsSettings({ checkout_terms_label: v }).label === T.DEFAULT_TERMS_LABEL));
  for (const ok of ['/terms', '/legal/terms-and-conditions', 'https://shop.example.com/terms', 'http://localhost:3000/t']) {
    check(`the link ${ok} is accepted`, T.isTermsUrl(ok));
  }
  for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,x', '//evil.example/terms', '/\\evil.example',
    'terms', 'ftp://x.example/t', 'https://a b.example', '/a\nb', '', '   ', 5, null, `/${'a'.repeat(600)}`]) {
    check(`the link ${j(bad)} is refused`, !T.isTermsUrl(bad));
  }
  check('a refused link resolves to none, not to the bad value',
    T.resolveCheckoutTermsSettings({ checkout_terms_url: 'javascript:alert(1)' }).url === null);
});

await safe('parse', async () => {
  const T = await loadTs('src/lib/commerce/checkout-terms.ts');
  check('T4: true and false pass through', j(T.parseConsentFlag(true)) === j({ ok: true, value: true }) && T.parseConsentFlag(false).value === false);
  check('T4: absent and null are "no answer"', T.parseConsentFlag(undefined).value === undefined && T.parseConsentFlag(null).ok);
  for (const bad of ['true', 'false', 1, 0, [], {}, 'on']) {
    check(`T4: ${j(bad)} is not a consent record`, T.parseConsentFlag(bad).ok === false);
  }
  const now = '2026-10-12T10:00:00.000Z';
  check('T2: an acceptance gets the supplied time',
    j(T.consentFields({ terms_accepted: true }, now)) === j({ terms_accepted: true, terms_accepted_at: now }));
  check('T7: a refusal is stored without a time', j(T.consentFields({ terms_accepted: false }, now)) === j({ terms_accepted: false }));
  check('T1: no answer writes nothing', j(T.consentFields({}, now)) === '{}');
  check('T9: privacy is stamped the same way',
    j(T.consentFields({ privacy_accepted: true }, now)) === j({ privacy_accepted: true, privacy_accepted_at: now }));
  check('a non-boolean slipping past the route is not stored',
    j(T.consentFields({ terms_accepted: 'true' }, now)) === '{}');
});

await safe('settings-validate', async () => {
  const V = await loadTs('src/lib/settings-validate.ts');
  check('the requirement is a boolean key: "yes" is refused', V.validateSetting('checkout_terms_required', 'yes') !== null);
  check('...and "false" is accepted and stored as a real false', V.validateSetting('checkout_terms_required', 'false') === null
    && V.normaliseSettingValue('checkout_terms_required', 'false') === false);
  check('a plain label is accepted', V.validateSetting('checkout_terms_label', 'I agree to the Store Terms') === null);
  check('a label with markup is refused', V.validateSetting('checkout_terms_label', 'I agree <b>now</b>') !== null);
  check('a label over 200 characters is refused', V.validateSetting('checkout_terms_label', 'x'.repeat(201)) !== null);
  check('a label can be cleared', V.validateSetting('checkout_terms_label', '') === null);
  check('a site path is an accepted link', V.validateSetting('checkout_terms_url', '/terms') === null);
  check('javascript: is not an accepted link', V.validateSetting('checkout_terms_url', 'javascript:alert(1)') !== null);
  check('a link can be cleared', V.validateSetting('checkout_terms_url', '') === null);
});

await safe('visibility', async () => {
  const V = await loadTs('src/lib/settings-visibility.ts');
  for (const k of ['checkout_terms_required', 'checkout_terms_label', 'checkout_terms_url']) {
    check(`${k} is readable by a storefront`, V.isPublicSetting(k));
  }
  check('a neighbouring checkout setting is still private', !V.isPublicSetting('orders_risk_hold_enabled'));
});

/* ================= per driver ================= */

const tmpRoot = path.join(os.tmpdir(), `astrobaas-checkout-terms-${process.pid}`);
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
      cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env, CHECKOUT_TERMS_CHILD: '1', NODE_ENV: 'test', AUTH_SECRET: SECRET,
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
  });
}

for (const driver of DRIVERS) {
  const r = await runChild(driver);
  if (!r) continue;
  const t = (n, c) => check(`[${driver.name}] ${n}`, c);
  for (const [k, v] of Object.entries(r)) {
    if (v && v.error) t(`${k}: scenario threw — ${v.error}`, false);
  }

  if (r.off && !r.off.error) {
    const o = r.off;
    t(`T1: an order that never mentions the box is placed (${j(o.bare)})`, o.bare.code === 201);
    t(`T1: ...and stores NO consent field at all — absent is unknown (${j(o.bare.stored)})`, j(o.bare.stored) === '[]');
    t('T1: ...and its response is the one it always was', o.bare.hasKey === false);
    t(`T2: an acceptance is stored as true (${j(o.yes)})`, o.yes.code === 201 && o.yes.stored === true);
    t('T2: ...with a timestamp from the server\'s clock', o.yes.inWindow === true);
    t('T2: ...echoed in the confirmation, identical to what was stored',
      o.yes.body === true && o.yes.sameAsBody === true);
    t(`T6: a timestamp the client names is ignored (${o.forgedAt})`, !!o.forgedAt && !o.forgedAt.startsWith('2001-'));
    t(`T7: an explicit "no" is stored as false, with no time (${j(o.no)})`,
      o.no.code === 201 && o.no.stored === false && o.no.hasAt === false);
    t(`T9: privacy consent is recorded and not required (${j(o.privacy)})`,
      o.privacy.code === 201 && o.privacy.stored === true && o.privacy.at === 'string' && o.privacy.terms === false);
  }

  if (r.required && !r.required.error) {
    const q = r.required;
    t(`T3: no answer is refused with 400 and a stable code (${j(q.missing)})`,
      q.missing.code === 400 && q.missing.errCode === 'checkout.terms_not_accepted');
    t(`T3: an explicit false is refused the same way (${j(q.falsy)})`,
      q.falsy.code === 400 && q.falsy.errCode === 'checkout.terms_not_accepted');
    t(`T3: a refusal places nothing and reserves nothing (${j(q.reserved)})`, q.reserved.orders === 0 && q.reserved.stock === 0);
    t(`T4: "true", 1 and a non-boolean privacy flag are 422 on their own field (${j(q.notBoolean)})`,
      q.notBoolean[0].code === 422 && q.notBoolean[0].fields.includes('terms_accepted')
      && q.notBoolean[1].code === 422 && q.notBoolean[2].code === 422 && q.notBoolean[2].fields.includes('privacy_accepted'));
    t(`T3: an acceptance places the order and stores it (${j(q.ok)})`, q.ok.code === 201 && q.ok.stored === true && q.ok.hasAt);
    t(`T5: staff placing an order are not refused, and nothing is invented for them (${j(q.staff)})`,
      q.staff.code === 201 && q.staff.stored === false);
    t(`T5: an API key IS refused without the shopper's answer (${j(q.key)})`,
      q.key.missing === 400 && q.key.missingCode === 'checkout.terms_not_accepted' && q.key.yes === 201);
    t(`T3: a stored string "false" reads as off (${q.stringFalse})`, q.stringFalse === 201);
    t(`T8: a refused order does not burn its idempotency key (${j(q.idem)})`,
      q.idem.first === 400 && q.idem.firstCode === 'checkout.terms_not_accepted' && q.idem.retry === 201);
    t(`T8: the replay returns the same order, and its answer (${j(q.idem)})`,
      q.idem.replay === 201 && q.idem.replayed === 'true' && q.idem.same && q.idem.replayAnswer === true);
    t(`T11: quoting is never gated (${q.quote})`, q.quote === 200);
    t(`T1: switching the requirement off again lets unanswered checkouts through (${q.offAgain})`, q.offAgain === 201);
  }

  if (r.internal && !r.internal.error) {
    const i = r.internal;
    t(`T10: placeOrder with no consent arguments places an order that carries none (${j(i)})`,
      i.ok === true && i.hasTerms === false);
    t(`T10: ...even while the shop setting is on — the setting is the route's to enforce (${i.refused})`,
      i.ok === true);
    t(`T10: the service refuses when asked to require it (${i.refused})`, i.refused === '400/checkout.terms_not_accepted');
    t(`T10: ...and accepts when it is given (${i.accepted})`, i.accepted === true);
  }

  if (r.settings && !r.settings.error) {
    const s = r.settings;
    t(`T11: an anonymous reader is told the requirement, the label and the link (${j(s)})`,
      s.code === 200 && s.required === true && s.label === 'I agree to the Store Terms' && s.url === '/terms');
    t(`T11: ...and nothing else about checkout (${s.leaksUnrelated})`, s.leaksUnrelated === false);
  }
}

await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
