#!/usr/bin/env node
/**
 * Conversion attribution: UTM tags and ad click ids, first-party, ONLY with
 * marketing consent, onto the order; the report; the Google Ads tag.
 *
 * The pure half runs in this process. Everything that needs storage runs once
 * per driver in a child process with its own database, through the REAL
 * POST /api/orders and GET /api/orders/attribution handlers and the REAL served
 * /consent.js (executed in a sandbox with a fake document).
 *
 *  A1  a landing URL's parameters: known keys only, cleaned, lenient
 *  A2  the API body: strict — unknown keys, caps, times, order of touches
 *  A3  the cookie round-trips; a stale first touch gives way to the last
 *  A4  the server reads the cookie ONLY with marketing consent in the consent cookie
 *  A5  the switch: commerce on and not switched off
 *  A6  the report: paid only, inclusive range, first vs last, base currency
 *  A7  cookie declaration and the Google Ads tag: marketing, exact CSP origins
 *  D1  per driver: body attribution is stored, normalised
 *  D2  ...a bad one is a 422 that places nothing
 *  D3  ...the cookie path with consent is stored; without consent nothing
 *  D4  ...staff and the switched-off shop keep nothing
 *  D5  ...GDPR: export carries it, erasure removes it
 *  D6  ...the report route: staff only, JSON and CSV agree, CSV is formula-safe
 *  D7  ...the served /consent.js keeps a touch only with marketing consent,
 *       deletes it on withdrawal, and applies the same rules as the server
 *
 * Run with:  node tests/conversion-attribution.test.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { ROOT, loadTs, loadTogether } from './lib/load.mjs';

const SECRET = 'conversion-attribution-secret-0123456789abcdef';
const DAY = 86_400_000;

/** URLs a landing page might carry, and what both the browser and the server must keep. */
const LANDING_TABLE = [
  '?utm_source=Google&utm_medium=CPC&utm_campaign=Summer-Sale&gclid=Cj0KCQ_abc-123',
  '?utm_source=newsletter',
  '?fbclid=IwAR0abc_DEF.123',
  '?utm_source=%20%20&utm_medium=email',
  '?utm_campaign=%3Cscript%3E&utm_source=x',
  '?gclid=has%20space&msclkid=0123abcd',
  `?utm_term=${'a'.repeat(101)}&utm_content=ok`,
  `?gclid=${'b'.repeat(201)}`,
  '?utm_campaign=%CE%BA%CE%B1%CE%BB%CE%BF%CE%BA%CE%B1%CE%AF%CF%81%CE%B9',
  '?email=a%40b.example&ref=x&page=2',
  '',
];

/* ---------------------------------------------------------------- child --- */

/** A cookie jar that behaves like `document.cookie` for what the loader does. */
function cookieJar(initial = {}) {
  const jar = new Map(Object.entries(initial));
  return {
    jar,
    get cookie() { return [...jar].map(([k, v]) => `${k}=${v}`).join('; '); },
    set cookie(str) {
      const [pair, ...attrs] = String(str).split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1);
      if (attrs.some((a) => /^\s*max-age=0\s*$/i.test(a))) jar.delete(name);
      else jar.set(name, value);
    },
  };
}

function fakeEl() {
  const el = {
    style: {}, hidden: false, className: '', textContent: '', type: '', checked: false, disabled: false,
    setAttribute() {}, appendChild() {}, addEventListener() {}, remove() {},
  };
  return el;
}

/** Run the served loader once against a URL and a cookie jar. */
function runLoader(js, { search = '', cookies = {} } = {}) {
  const c = cookieJar(cookies);
  const head = { appendChild: (s) => { loaded.push(s.src); } };
  const loaded = [];
  const document = {
    readyState: 'complete',
    documentElement: { lang: 'en' },
    head,
    body: { appendChild() {} },
    createElement: () => fakeEl(),
    querySelector: () => null,
    addEventListener() {},
    get cookie() { return c.cookie; },
    set cookie(v) { c.cookie = v; },
  };
  const sandbox = {
    document,
    location: { search, protocol: 'http:' },
    navigator: {},
    URLSearchParams,
    Date, JSON, RegExp, Math, Array, Object, String, Number, isFinite, encodeURIComponent, decodeURIComponent,
    Blob: class {},
    fetch: () => Promise.resolve(),
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(js, sandbox);
  return { jar: c.jar, loaded };
}

async function child(M) {
  const { LocalDB, attribution: A, consent: C } = M;
  const out = {};
  const guard = async (key, fn) => {
    try { out[key] = await fn(); } catch (err) { out[key] = { error: String(err?.stack || err).slice(0, 600) }; }
  };
  await LocalDB.updateSetting('commerce_enabled', true);
  const product = await LocalDB.createProduct({
    status: 'active', price_cents: 1000, categories: [], images: [], on_sale: false,
    name: 'Attr', slug: 'attr-product', stock: 500, in_stock: true, requires_shipping: false,
  });
  const item = [{ product_id: product.id, qty: 1 }];
  let ipSeq = 0;
  const nextIp = () => `100.65.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`;
  const call = async (handler, { url = 'http://localhost/api/orders', body, headers = {}, locals = {}, method = 'POST' } = {}) => {
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
    try { json = JSON.parse(text); } catch { /* csv or js */ }
    return { code: res.status, json, data: json?.data, text, type: res.headers.get('content-type') };
  };
  let mail = 0;
  const email = () => `buyer${++mail}@example.com`;
  const order = (body, opts = {}) => call(M.postOrder, { body: { email: email(), items: item, ...body }, ...opts });
  const stored = async (number) => (await LocalDB.getOrders()).find((o) => o.number === number);
  const staff = { user: { id: 'staff-1', role: 'admin' } };
  const now = Date.now();
  const iso = (msAgo) => new Date(now - msAgo).toISOString();
  const consentCookie = (granted, v = C.CONSENT_VERSION, t = now) =>
    `${C.CONSENT_COOKIE}=${encodeURIComponent(JSON.stringify({ v, t, granted }))}`;
  const attrCookie = (rec) => `${A.ATTRIBUTION_COOKIE}=${A.encodeAttributionCookie(rec)}`;
  const rec = {
    first: { utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'spring', gclid: 'G1-abc', at: iso(10 * DAY) },
    last: { utm_source: 'newsletter', utm_medium: 'email', utm_campaign: 'october', at: iso(DAY) },
  };

  await guard('body', async () => {
    const ok = await order({ attribution: {
      first: { utm_source: '  Google ', utm_medium: 'CPC', utm_campaign: 'Summer-Sale', gclid: 'abc_123', at: iso(5 * DAY) },
      last: { utm_source: 'facebook', utm_medium: 'paid_social', fbclid: 'IwAR0x', at: iso(DAY) },
    } });
    const one = await order({ attribution: { last: { utm_source: 'bing', msclkid: 'ff00', at: iso(1000) } } });
    const none = await order({});
    return {
      ok: { code: ok.code, stored: (await stored(ok.data?.number))?.attribution, responseHas: 'attribution' in (ok.data ?? {}) },
      one: { code: one.code, stored: (await stored(one.data?.number))?.attribution },
      none: { code: none.code, has: 'attribution' in ((await stored(none.data?.number)) ?? {}) },
    };
  });

  await guard('invalid', async () => {
    const before = (await LocalDB.getOrders()).length;
    const cases = [
      { first: { utm_source: 'x', email: 'a@b.example', at: iso(DAY) } },
      { first: { utm_source: 'x', at: iso(DAY) }, referrer: 'https://x' },
      { last: { utm_source: 'x'.repeat(101), at: iso(DAY) } },
      { last: { utm_source: 42, at: iso(DAY) } },
      { last: { gclid: 'has space', at: iso(DAY) } },
      { last: { utm_source: 'x', at: 'yesterday' } },
      { last: { at: iso(DAY) } },
      'google',
      [],
      {},
    ];
    const res = [];
    for (const attribution of cases) {
      const r = await order({ attribution });
      res.push({ code: r.code, fields: Object.keys(r.json?.error?.details ?? {}) });
    }
    return { res, placed: (await LocalDB.getOrders()).length - before };
  });

  /* The shopper's device clock stamps `at`: a wrong clock never costs the sale. */
  await guard('clock', async () => {
    const before = Date.now();
    const fast = await order({ attribution: { last: { utm_source: 'fast', at: new Date(now + 2 * 3600_000).toISOString() } } });
    const after = Date.now();
    const old = await order({ attribution: { last: { utm_source: 'old', at: iso(91 * DAY) } } });
    const oldFirst = await order({ attribution: { first: { utm_source: 'ancient', at: iso(120 * DAY) }, last: { utm_source: 'recent', at: iso(DAY) } } });
    const swapped = await order({ attribution: { first: { utm_source: 'a', at: iso(DAY) }, last: { utm_source: 'b', at: iso(2 * DAY) } } });
    const fastStored = (await stored(fast.data?.number))?.attribution;
    return {
      fast: { code: fast.code, src: fastStored?.last?.utm_source, clamped: Date.parse(fastStored?.last?.at) >= before - 1 && Date.parse(fastStored?.last?.at) <= after + 1 },
      old: { code: old.code, has: 'attribution' in ((await stored(old.data?.number)) ?? {}) },
      oldFirst: { code: oldFirst.code, a: (await stored(oldFirst.data?.number))?.attribution },
      swapped: { code: swapped.code, a: (await stored(swapped.data?.number))?.attribution },
    };
  });

  await guard('cookie', async () => {
    const withConsent = await order({}, { headers: { cookie: `${consentCookie(['necessary', 'marketing'])}; ${attrCookie(rec)}` } });
    const noConsent = await order({}, { headers: { cookie: attrCookie(rec) } });
    const analyticsOnly = await order({}, { headers: { cookie: `${consentCookie(['necessary', 'analytics'])}; ${attrCookie(rec)}` } });
    const oldVersion = await order({}, { headers: { cookie: `${consentCookie(['necessary', 'marketing'], C.CONSENT_VERSION - 1)}; ${attrCookie(rec)}` } });
    const expired = await order({}, { headers: { cookie: `${consentCookie(['necessary', 'marketing'], C.CONSENT_VERSION, now - 200 * DAY)}; ${attrCookie(rec)}` } });
    const garbage = await order({}, { headers: { cookie: `${consentCookie(['necessary', 'marketing'])}; ${A.ATTRIBUTION_COOKIE}=%7Bnot-json` } });
    // The body wins over the cookie: a storefront that sends one means it.
    const bodyWins = await order({ attribution: { last: { utm_source: 'body', at: iso(1000) } } },
      { headers: { cookie: `${consentCookie(['necessary', 'marketing'])}; ${attrCookie(rec)}` } });
    // A browser whose own consent cookie here says "no marketing" keeps
    // nothing, even if the request body claims a campaign.
    const bodyRefused = await order({ attribution: { last: { utm_source: 'body', at: iso(1000) } } },
      { headers: { cookie: consentCookie(['necessary', 'analytics']) } });
    // ...while an API key (a storefront's server) is not judged by a cookie.
    const keyBody = await order({ attribution: { last: { utm_source: 'key', at: iso(1000) } } },
      { locals: { user: { id: 'apikey:k1', role: 'editor' } }, headers: { cookie: consentCookie(['necessary']) } });
    const s = async (r) => ({ code: r.code, a: (await stored(r.data?.number))?.attribution ?? null });
    return {
      bodyRefused: await s(bodyRefused), keyBody: await s(keyBody),
      withConsent: await s(withConsent), noConsent: await s(noConsent), analyticsOnly: await s(analyticsOnly),
      oldVersion: await s(oldVersion), expired: await s(expired), garbage: await s(garbage), bodyWins: await s(bodyWins),
    };
  });

  await guard('gates', async () => {
    const body = { attribution: { last: { utm_source: 'phone', at: iso(1000) } } };
    const st = await order(body, { locals: staff, headers: { cookie: `${consentCookie(['necessary', 'marketing'])}; ${attrCookie(rec)}` } });
    await LocalDB.updateSetting('attribution_enabled', false);
    const off = await order(body);
    const offCookie = await order({}, { headers: { cookie: `${consentCookie(['necessary', 'marketing'])}; ${attrCookie(rec)}` } });
    await LocalDB.updateSetting('attribution_enabled', 'false');
    const offString = await order(body);
    await LocalDB.updateSetting('attribution_enabled', true);
    const on = await order(body);
    const has = async (r) => ({ code: r.code, has: 'attribution' in ((await stored(r.data?.number)) ?? {}) });
    return { staff: await has(st), off: await has(off), offCookie: await has(offCookie), offString: await has(offString), on: await has(on) };
  });

  await guard('gdpr', async () => {
    const who = 'subject@example.com';
    const r = await order({ email: who, attribution: { last: { utm_source: 'google', gclid: 'gdpr-click', at: iso(1000) } } });
    const exported = await M.collectSubjectData(who);
    const exportedAttr = exported.orders.find((o) => o.number === r.data?.number)?.attribution ?? null;
    await M.eraseSubject(who);
    const after = await stored(r.data?.number);
    return {
      exported: exportedAttr,
      exportJson: JSON.stringify(exported).includes('gdpr-click'),
      // `undefined` is how an erasure removes a key on every driver; lowdb's
      // in-memory record may still list the key with no value until saved.
      afterHas: after ? after.attribution !== undefined : null,
      afterJson: JSON.stringify(after ?? {}).includes('gdpr-click'),
      kept: after?.total_cents,
    };
  });

  await guard('report', async () => {
    // A fresh set of paid orders, so the counts below are exact.
    for (const o of await LocalDB.getOrders()) await LocalDB.updateOrder(o.id, { payment_status: 'unpaid' });
    const mk = async (attribution, paid = true) => {
      const r = await order(attribution ? { attribution } : {});
      const o = await stored(r.data?.number);
      if (paid) await LocalDB.updateOrder(o.id, { payment_status: 'paid' });
      return o;
    };
    const g = (src, med, camp, ago) => ({ utm_source: src, utm_medium: med, utm_campaign: camp, at: iso(ago) });
    await mk({ first: g('google', 'cpc', 'spring', 5 * DAY), last: g('newsletter', 'email', 'oct', DAY) });
    await mk({ first: g('google', 'cpc', 'spring', 4 * DAY), last: g('google', 'cpc', 'spring', 1000) });
    await mk({ last: { utm_source: 'facebook', utm_medium: 'paid_social', utm_campaign: '=SUM(1+1)', at: iso(1000) } });
    await mk(null);
    await mk({ last: g('unpaid', 'cpc', 'x', 1000) }, false);
    const today = new Date(now).toISOString().slice(0, 10);
    const q = (s) => call(M.getAttributionReport, { url: `http://localhost/api/orders/attribution${s}`, method: 'GET', locals: staff });
    const last = await q(`?from=${today}&to=${today}`);
    const first = await q(`?from=${today}&to=${today}&model=first`);
    const csv = await q(`?from=${today}&to=${today}&format=csv`);
    const anon = await call(M.getAttributionReport, { url: 'http://localhost/api/orders/attribution', method: 'GET' });
    const editor = await call(M.getAttributionReport, { url: 'http://localhost/api/orders/attribution', method: 'GET', locals: { user: { id: 'a1', role: 'author' } } });
    const bad = await Promise.all(['?from=2026-13-01', '?from=2026-10-12&to=2026-10-01', '?model=linear', '?format=xml', '?from=2020-01-01&to=2026-01-01']
      .map(async (s) => (await q(s)).code));
    // Yesterday only: nothing placed then.
    const y = new Date(now - DAY).toISOString().slice(0, 10);
    const empty = await q(`?from=${y}&to=${y}`);
    return {
      last: last.data, first: first.data, csv: { code: csv.code, type: csv.type, text: csv.text },
      anon: anon.code, editor: editor.code, bad, empty: empty.data?.orders,
    };
  });

  await guard('loader', async () => {
    const js = await (await M.getConsentJs({})).text();
    const marketing = { [C.CONSENT_COOKIE]: encodeURIComponent(JSON.stringify({ v: C.CONSENT_VERSION, t: now, granted: ['necessary', 'marketing'] })) };
    const analyticsOnly = { [C.CONSENT_COOKIE]: encodeURIComponent(JSON.stringify({ v: C.CONSENT_VERSION, t: now, granted: ['necessary', 'analytics'] })) };
    const read = (jar) => {
      const raw = jar.get(A.ATTRIBUTION_COOKIE);
      return raw === undefined ? null : JSON.parse(decodeURIComponent(raw));
    };
    // The browser and the server apply the same rules to the same URLs.
    const table = LANDING_TABLE.map((search) => {
      const { jar } = runLoader(js, { search, cookies: marketing });
      const got = read(jar)?.last ?? null;
      const want = A.touchFromParams(new URLSearchParams(search), 'X');
      const strip = (t) => (t ? Object.fromEntries(Object.entries(t).filter(([k]) => k !== 'at')) : null);
      return { search, browser: strip(got), server: strip(want) };
    });
    const kept = read(runLoader(js, { search: '?utm_source=google&gclid=abc', cookies: marketing }).jar);
    const noDecision = read(runLoader(js, { search: '?utm_source=google&gclid=abc' }).jar);
    const analyticsOnlyRes = read(runLoader(js, { search: '?utm_source=google', cookies: analyticsOnly }).jar);
    // Withdrawal: a cookie from before, and consent now without marketing → deleted.
    const existing = A.encodeAttributionCookie(rec);
    const withdrawn = read(runLoader(js, { search: '', cookies: { ...analyticsOnly, [A.ATTRIBUTION_COOKIE]: existing } }).jar);
    // A new visit keeps the first touch and moves the last.
    const second = read(runLoader(js, { search: '?utm_source=bing&utm_medium=cpc', cookies: { ...marketing, [A.ATTRIBUTION_COOKIE]: existing } }).jar);
    // A plain visit leaves what is there alone.
    const plain = read(runLoader(js, { search: '?page=2', cookies: { ...marketing, [A.ATTRIBUTION_COOKIE]: existing } }).jar);
    // What the browser wrote, the server reads back.
    const roundTrip = A.decodeAttributionCookie(A.encodeAttributionCookie(second), Date.now());
    // Merchant switches it off: the loader ships null and deletes the cookie.
    await LocalDB.updateSetting('attribution_enabled', false);
    const jsOff = await (await M.getConsentJs({})).text();
    const off = read(runLoader(jsOff, { search: '?utm_source=google', cookies: { ...marketing, [A.ATTRIBUTION_COOKIE]: existing } }).jar);
    await LocalDB.updateSetting('attribution_enabled', true);
    // Google Ads loads only with marketing consent.
    await LocalDB.updateSetting('analytics_google-ads_id', 'AW-123456789');
    const jsAds = await (await M.getConsentJs({})).text();
    const adsYes = runLoader(jsAds, { cookies: marketing }).loaded;
    const adsNo = runLoader(jsAds, { cookies: analyticsOnly }).loaded;
    await LocalDB.updateSetting('analytics_google-ads_id', '');
    return {
      table, kept, noDecision, analyticsOnly: analyticsOnlyRes, withdrawn, second, plain,
      roundTrip: !!roundTrip, off, offShipsNull: /"attribution":null/.test(jsOff),
      adsYes, adsNo,
    };
  });

  return out;
}

if (process.env.CONVERSION_ATTRIBUTION_CHILD) {
  const M = await loadTs('tests/fixtures/attribution-entry.ts', 'attribution');
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
  try { await fn(); } catch (err) { check(`${label} (threw: ${String(err?.stack || err).slice(0, 300)})`, false); }
};

const A = await loadTs('src/lib/commerce/attribution.ts', 'attr-pure');
const NOW = Date.parse('2026-10-12T12:00:00.000Z');
const ago = (ms) => new Date(NOW - ms).toISOString();

await safe('A1', async () => {
  const t = A.touchFromParams(new URLSearchParams('?utm_source=Google&utm_medium=CPC&utm_campaign=Summer-Sale&gclid=Cj0_x&ref=x&email=a%40b'), 'T');
  check(`A1: known keys kept, source/medium lower-cased, campaign as written (${j(t)})`,
    j(t) === j({ utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'Summer-Sale', gclid: 'Cj0_x', at: 'T' }));
  check('A1: no campaign parameter means no touch', A.touchFromParams(new URLSearchParams('?page=2&email=a%40b'), 'T') === null);
  check('A1: blank values are not a touch', A.touchFromParams(new URLSearchParams('?utm_source=%20'), 'T') === null);
  const bad = A.touchFromParams(new URLSearchParams(`?utm_campaign=%3Cb%3E&utm_term=${'x'.repeat(101)}&gclid=a%20b&utm_source=ok`), 'T');
  check(`A1: markup, over-long and malformed values are dropped, the good ones kept (${j(bad)})`, j(bad) === j({ utm_source: 'ok', at: 'T' }));
  check('A1: a campaign in Greek is a campaign', A.touchFromParams({ utm_campaign: 'καλοκαίρι' }, 'T')?.utm_campaign === 'καλοκαίρι');
  check('A1: exactly the eight documented keys',
    j([...A.ATTRIBUTION_KEYS]) === j(['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid', 'msclkid']));
  const merged = A.mergeTouch({ first: { utm_source: 'a', at: 'x' }, last: { utm_source: 'b', at: 'y' } }, { utm_source: 'c', at: 'z' });
  check('A1: a new visit keeps the first touch and replaces the last', merged.first.utm_source === 'a' && merged.last.utm_source === 'c');
});

await safe('A2', async () => {
  const p = (raw) => A.parseAttribution(raw, NOW);
  const ok = p({ first: { utm_source: 'Google', at: ago(DAY) }, last: { utm_source: 'x', fbclid: 'a.b', at: ago(1000) } });
  check(`A2: a valid body parses and is normalised (${j(ok)})`, ok.ok && ok.value.first.utm_source === 'google' && ok.value.last.fbclid === 'a.b');
  check('A2: the time is re-serialised by the server', ok.ok && ok.value.first.at === new Date(NOW - DAY).toISOString());
  const one = p({ last: { utm_source: 'x', at: ago(1000) } });
  check('A2: one touch stands for both', one.ok && j(one.value.first) === j(one.value.last));
  check('A2: absent is "no attribution", not an error', p(undefined).ok && p(undefined).value === undefined && p(null).ok);
  const refuse = (raw, field, why) => {
    const r = p(raw);
    check(`A2: ${why} is refused on ${field} (${j(r)})`, r.ok === false && Object.keys(r.errors).includes(field));
  };
  refuse({ first: { utm_source: 'x', email: 'a@b', at: ago(DAY) } }, 'attribution.first.email', 'an unknown key in a touch');
  refuse({ last: { utm_source: 'x', at: ago(DAY) }, referrer: 'x' }, 'attribution.referrer', 'an unknown top-level key');
  refuse({ last: { utm_source: 'x'.repeat(101), at: ago(DAY) } }, 'attribution.last.utm_source', 'an over-long tag');
  refuse({ last: { gclid: 'g'.repeat(201), at: ago(DAY) } }, 'attribution.last.gclid', 'an over-long click id');
  refuse({ last: { utm_source: 5, at: ago(DAY) } }, 'attribution.last.utm_source', 'a number');
  refuse({ last: { utm_source: { $gt: '' }, at: ago(DAY) } }, 'attribution.last.utm_source', 'an object');
  refuse({ last: { utm_source: 'a"b', at: ago(DAY) } }, 'attribution.last.utm_source', 'a quote');
  refuse({ last: { utm_source: 'a\nb', at: ago(DAY) } }, 'attribution.last.utm_source', 'a control character');
  refuse({ last: { gclid: 'a/b', at: ago(DAY) } }, 'attribution.last.gclid', 'a click id with a slash');
  refuse({ last: { utm_source: 'x', at: new Date(NOW + 3600_000).toISOString() } }, 'attribution.last.at', 'a future time');
  refuse({ last: { utm_source: 'x', at: ago(91 * DAY) } }, 'attribution.last.at', 'a touch older than 90 days');
  refuse({ last: { utm_source: 'x', at: 'last tuesday' } }, 'attribution.last.at', 'a time that is not a time');
  refuse({ last: { utm_source: 'x' } }, 'attribution.last.at', 'a missing time');
  refuse({ last: { at: ago(DAY) } }, 'attribution.last', 'a touch with no parameter');
  refuse({ first: { utm_source: 'a', at: ago(1000) }, last: { utm_source: 'b', at: ago(DAY) } }, 'attribution.first.at', 'a first touch after the last');
  refuse({}, 'attribution', 'an empty object');
  refuse([], 'attribution', 'an array');
  refuse('google', 'attribution', 'a string');
  const len = (raw) => A.parseAttribution(raw, NOW, { lenientClock: true });
  check('A2: a lenient clock still refuses an unknown key', len({ last: { utm_source: 'x', email: 'a@b', at: ago(DAY) } }).ok === false);
  check('A2: ...and an unparseable time', len({ last: { utm_source: 'x', at: 'soon' } }).ok === false);
  check('A2: ...but clamps a future time to now',
    len({ last: { utm_source: 'x', at: new Date(NOW + 3600_000).toISOString() } }).value?.last.at === new Date(NOW).toISOString());
  check('A2: ...and drops an aged-out touch', len({ last: { utm_source: 'x', at: ago(91 * DAY) } }).ok === true
    && len({ last: { utm_source: 'x', at: ago(91 * DAY) } }).value === undefined);
  check('A2: the edge of the window is accepted', p({ last: { utm_source: 'x', at: ago(90 * DAY - 1000) } }).ok);
  check('A2: a few seconds of clock skew is accepted', p({ last: { utm_source: 'x', at: new Date(NOW + 60_000).toISOString() } }).ok);
});

await safe('A3', async () => {
  const rec = { first: { utm_source: 'a', at: ago(10 * DAY) }, last: { utm_source: 'b', at: ago(DAY) } };
  const back = A.decodeAttributionCookie(A.encodeAttributionCookie(rec), NOW);
  check(`A3: the cookie round-trips (${j(back)})`, j(back) === j(rec));
  const staleFirst = { first: { utm_source: 'a', at: ago(100 * DAY) }, last: { utm_source: 'b', at: ago(DAY) } };
  const s = A.decodeAttributionCookie(A.encodeAttributionCookie(staleFirst), NOW);
  check(`A3: an aged-out first touch gives way to the last (${j(s)})`, s && s.first.utm_source === 'b' && s.last.utm_source === 'b');
  const staleBoth = { first: { utm_source: 'a', at: ago(100 * DAY) }, last: { utm_source: 'b', at: ago(95 * DAY) } };
  check('A3: nothing fresh means nothing', A.decodeAttributionCookie(A.encodeAttributionCookie(staleBoth), NOW) === null);
  check('A3: another version is ignored',
    A.decodeAttributionCookie(encodeURIComponent(JSON.stringify({ v: 99, ...rec })), NOW) === null);
  for (const g of ['', '%7B', 'null', encodeURIComponent('{"v":1,"first":"x"}'), '%E0%A4%A']) {
    check(`A3: ${j(g)} is ignored, never thrown`, A.decodeAttributionCookie(g, NOW) === null);
  }
});

await safe('A4', async () => {
  const C = await loadTs('src/lib/consent.ts', 'attr-consent');
  const rec = { first: { utm_source: 'a', at: ago(DAY) }, last: { utm_source: 'b', at: ago(1000) } };
  const attr = `${A.ATTRIBUTION_COOKIE}=${A.encodeAttributionCookie(rec)}`;
  const consent = (granted, v = C.CONSENT_VERSION, t = NOW) => `${C.CONSENT_COOKIE}=${encodeURIComponent(JSON.stringify({ v, t, granted }))}`;
  check('A4: with marketing consent the cookie is read',
    j(A.attributionFromCookies(`x=1; ${consent(['necessary', 'marketing'])}; ${attr}`, NOW)) === j(rec));
  check('A4: no consent cookie: nothing', A.attributionFromCookies(attr, NOW) === null);
  check('A4: analytics is not marketing', A.attributionFromCookies(`${consent(['necessary', 'analytics', 'preferences'])}; ${attr}`, NOW) === null);
  check('A4: consent under an older version is not consent', A.attributionFromCookies(`${consent(['marketing'], C.CONSENT_VERSION - 1)}; ${attr}`, NOW) === null);
  check('A4: expired consent is not consent', A.attributionFromCookies(`${consent(['marketing'], C.CONSENT_VERSION, NOW - 200 * DAY)}; ${attr}`, NOW) === null);
  check('A4: a malformed consent cookie is not consent', A.attributionFromCookies(`${C.CONSENT_COOKIE}=%E0%A4%A; ${attr}`, NOW) === null);
  check('A4: no Cookie header at all', A.attributionFromCookies(null, NOW) === null);
  check('A4: the consent version moved when marketing grew a purpose', C.CONSENT_VERSION >= 2);
  for (const loc of Object.keys(C.CONSENT_STRINGS)) {
    check(`A4: the ${loc} marketing description names the shop's own campaign memory`,
      /campaign|καμπάνια|Kampagne/i.test(C.CONSENT_STRINGS[loc].categories.marketing.description));
  }
});

await safe('A5', async () => {
  check('A5: shop off: off', A.resolveAttributionEnabled({}) === false);
  check('A5: shop on: on by default', A.resolveAttributionEnabled({ commerce_enabled: true }) === true);
  for (const v of [false, 'false', '0', 0, 'off']) {
    check(`A5: ${j(v)} switches it off`, A.resolveAttributionEnabled({ commerce_enabled: true, attribution_enabled: v }) === false);
  }
  const V = await loadTs('src/lib/settings-validate.ts', 'attr-settings');
  check('A5: the switch is a boolean setting ("yes" refused)', V.validateSetting('attribution_enabled', 'yes') !== null);
  check('A5: ...and "false" is stored as a real false', V.normaliseSettingValue('attribution_enabled', 'false') === false);
});

await safe('A6', async () => {
  const paid = (created_at, attribution, extra = {}) => ({ created_at, payment_status: 'paid', currency: 'EUR', total_cents: 1000, attribution, ...extra });
  const t = (src, med, camp) => ({ utm_source: src, utm_medium: med, utm_campaign: camp, at: '2026-10-01T00:00:00.000Z' });
  const orders = [
    paid('2026-10-01T00:00:00.000Z', { first: t('google', 'cpc', 'spring'), last: t('newsletter', 'email', 'oct') }),
    paid('2026-10-05T23:59:59.999Z', { first: t('google', 'cpc', 'spring'), last: t('google', 'cpc', 'spring') }, { total_cents: 3000 }),
    paid('2026-10-06T00:00:00.000Z', { first: t('google', 'cpc', 'spring'), last: t('google', 'cpc', 'spring') }), // after range
    paid('2026-09-30T23:59:59.999Z', { first: t('google', 'cpc', 'spring'), last: t('google', 'cpc', 'spring') }), // before
    { ...paid('2026-10-02T00:00:00.000Z', { first: t('google', 'cpc', 'spring'), last: t('google', 'cpc', 'spring') }), payment_status: 'unpaid' },
    paid('2026-10-03T00:00:00.000Z', undefined, { total_cents: 700 }),
    paid('2026-10-04T00:00:00.000Z', { first: { utm_source: 'bing', at: 'x' }, last: { gclid: 'g', at: 'x' } },
      { currency: 'USD', base_currency: 'EUR', total_cents: 1100, base_total_cents: 1000 }),
  ];
  const last = A.attributionReport(orders, { from: '2026-10-01', to: '2026-10-05', model: 'last' });
  check(`A6: paid orders inside the inclusive range only (${last.orders})`, last.orders === 4);
  check(`A6: unattributed counted with its revenue (${j(last.unattributed_revenue)})`, last.unattributed === 1 && last.unattributed_revenue.EUR === 700);
  check(`A6: last touch rows (${j(last.rows)})`, j(last.rows.map((r) => [r.source, r.medium, r.campaign, r.orders, r.revenue_cents])) === j([
    ['google', 'cpc', 'spring', 1, 3000],
    ['(not set)', '(not set)', '(not set)', 1, 1000],
    ['newsletter', 'email', 'oct', 1, 1000],
  ]));
  check('A6: revenue is in the BASE currency', last.rows.every((r) => r.currency === 'EUR'));
  const first = A.attributionReport(orders, { from: '2026-10-01', to: '2026-10-05', model: 'first' });
  check(`A6: first touch credits differently (${j(first.rows)})`, j(first.rows.map((r) => [r.source, r.orders, r.revenue_cents])) === j([
    ['google', 2, 4000], ['bing', 1, 1000],
  ]));
  const q = (s) => A.parseReportQuery(new URLSearchParams(s), NOW);
  const d = q('');
  check(`A6: the default is the last 30 days, last touch (${j(d)})`, d.ok && d.value.to === '2026-10-12' && d.value.from === '2026-09-13' && d.value.model === 'last');
  for (const bad of ['from=2026-02-30', 'to=12/10/2026', 'from=2026-10-10&to=2026-10-01', 'model=linear', 'from=2020-01-01&to=2026-01-01']) {
    check(`A6: ${bad} is refused`, q(bad).ok === false);
  }
});

await safe('A7', async () => {
  const [D, N, csp] = await loadTogether(['src/lib/cookie-declaration.ts', 'src/lib/analytics.ts', 'src/lib/csp-config.ts'], 'attr-a7');
  const names = (s) => D.buildCookieDeclaration(Object.entries(s).map(([key, value]) => ({ key, value }))).all;
  const row = names({ commerce_enabled: true }).find((c) => c.name === A.ATTRIBUTION_COOKIE);
  check(`A7: the attribution cookie is declared while it can be set (${j(row)})`, !!row && row.category === 'marketing' && row.firstParty === true);
  check(`A7: its lifetime is derived from the constant (${row?.lifetime})`, row?.lifetime === `${Math.round(A.ATTRIBUTION_MAX_AGE_DAYS / 30)} months`);
  check('A7: ...and not declared when the shop is off', !names({}).some((c) => c.name === A.ATTRIBUTION_COOKIE));
  check('A7: ...or when the merchant switched it off', !names({ commerce_enabled: true, attribution_enabled: false }).some((c) => c.name === A.ATTRIBUTION_COOKIE));
  const ads = names({ 'analytics_google-ads_id': 'AW-123456789' }).find((c) => c.name === '_gcl_au');
  check(`A7: Google Ads brings its cookie, under MARKETING (${j(ads)})`, ads?.category === 'marketing');

  const p = N.getAnalyticsProvider('google-ads');
  check('A7: Google Ads waits for marketing consent, not analytics', p?.category === 'marketing');
  check('A7: GA4 stays an analytics tag', N.getAnalyticsProvider('ga4')?.category === 'analytics');
  check('A7: a Google Ads id is normalised', j(N.validateAnalyticsId('google-ads', ' aw-123456789 ')) === j({ ok: true, value: 'AW-123456789' }));
  for (const bad of ['AW-12', 'AW-abc123456', 'G-ABCDEF', 'AW-123456789"><script>', '123456789']) {
    check(`A7: ${j(bad)} is not a Google Ads id`, N.validateAnalyticsId('google-ads', bad).ok === false);
  }
  check('A7: no Google Ads origin in the CSP unless it is named at build',
    !csp.cspDirectives({}).join(' ').includes('doubleclick') && csp.cspScriptResources({}) === undefined);
  const named = csp.cspDirectives({ ANALYTICS_PROVIDERS: 'google-ads' }).join(' | ');
  check(`A7: naming it adds exactly its origins (${named.slice(0, 200)})`,
    named.includes('https://googleads.g.doubleclick.net') && named.includes('https://td.doubleclick.net')
    && (csp.cspScriptResources({ ANALYTICS_PROVIDERS: 'google-ads' }) ?? []).includes('https://www.googletagmanager.com')
    && !(csp.cspScriptResources({ ANALYTICS_PROVIDERS: 'google-ads' }) ?? []).includes('https:'));
});

await safe('starter', async () => {
  const S = await loadTs('examples/storefront/src/lib/attribution.ts', 'attr-starter');
  const mem = () => { const m = new Map(); return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) }; };
  const s = mem();
  check('starter: without consent nothing is kept', S.captureAttribution(s, '?utm_source=google', () => false, NOW) === null && s.m.size === 0);
  check('starter: by default (no CMS consent API on the page) nothing is kept', S.captureAttribution(s, '?utm_source=google', undefined, NOW) === null && s.m.size === 0);
  const kept = S.captureAttribution(s, '?utm_source=Google&gclid=abc&email=a%40b', () => true, NOW);
  check(`starter: with consent the touch is kept (${j(kept)})`, kept?.last.utm_source === 'google' && kept?.last.gclid === 'abc' && !('email' in kept.last));
  S.captureAttribution(s, '?utm_source=bing', () => true, NOW + 1000);
  const forOrder = S.attributionForOrder(s, () => true, NOW + 2000);
  check(`starter: the order gets first and last (${j(forOrder)})`, forOrder.attribution?.first.utm_source === 'google' && forOrder.attribution?.last.utm_source === 'bing');
  check('starter: what it sends, the CMS accepts', A.parseAttribution(forOrder.attribution, NOW + 2000).ok === true);
  const staleStore = mem();
  S.captureAttribution(staleStore, '?gclid=old-click', () => true, NOW - 100 * DAY);
  S.captureAttribution(staleStore, '?page=2', () => true, NOW);
  check('starter: a record past its 90 days is removed, not kept forever', staleStore.m.size === 0);
  check('starter: consent withdrawn at checkout sends nothing and forgets', j(S.attributionForOrder(s, () => false, NOW)) === '{}' && s.m.size === 0);
  // The same landing table, both sides.
  for (const search of LANDING_TABLE) {
    const st = mem();
    const got = S.captureAttribution(st, search, () => true, NOW)?.last ?? null;
    const want = A.touchFromParams(new URLSearchParams(search), new Date(NOW).toISOString());
    check(`starter: ${j(search.slice(0, 50))} is read the way the CMS reads it`, j(got) === j(want));
  }
});

/* ================= per driver ================= */

const tmpRoot = path.join(os.tmpdir(), `astrobaas-attribution-${process.pid}`);
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
      ...process.env, CONVERSION_ATTRIBUTION_CHILD: '1', NODE_ENV: 'test', AUTH_SECRET: SECRET,
      STAGING: '', ASTROBAAS_STAGING: '', RATE_LIMIT_STORE: '', SITE_URL: '', EMAIL_TRANSPORT: '', SMTP_HOST: '',
      DB_PATH: '', DATABASE_URL: '', DATABASE_DRIVER: '',
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

const perDriver = {};
for (const driver of DRIVERS) {
  const r = await runChild(driver);
  if (!r) continue;
  perDriver[driver.name] = r;
  const t = (n, c) => check(`[${driver.name}] ${n}`, c);
  for (const [k, v] of Object.entries(r)) if (v && v.error) t(`${k}: scenario threw — ${v.error}`, false);

  if (r.body && !r.body.error) {
    const b = r.body;
    t(`D1: a body attribution is stored, normalised (${j(b.ok)})`, b.ok.code === 201
      && b.ok.stored?.first?.utm_source === 'google' && b.ok.stored?.first?.utm_medium === 'cpc'
      && b.ok.stored?.first?.utm_campaign === 'Summer-Sale' && b.ok.stored?.first?.gclid === 'abc_123'
      && b.ok.stored?.last?.fbclid === 'IwAR0x');
    t('D1: ...and the buyer-facing response is unchanged', b.ok.responseHas === false);
    t(`D1: one touch is stored as both (${j(b.one)})`, b.one.code === 201 && j(b.one.stored?.first) === j(b.one.stored?.last) && b.one.stored?.last?.msclkid === 'ff00');
    t(`D1: no attribution means NO key, never {} (${j(b.none)})`, b.none.code === 201 && b.none.has === false);
  }
  if (r.invalid && !r.invalid.error) {
    const v = r.invalid;
    t(`D2: every malformed attribution is a 422 (${j(v.res.map((x) => x.code))})`, v.res.every((x) => x.code === 422));
    t(`D2: ...naming the field (${j(v.res.map((x) => x.fields))})`, v.res.every((x) => x.fields.some((f) => f.startsWith('attribution'))));
    t(`D2: ...and places nothing (${v.placed})`, v.placed === 0);
  }
  if (r.cookie && !r.cookie.error) {
    const c = r.cookie;
    t(`D3: the cookie WITH marketing consent is stored (${j(c.withConsent)})`, c.withConsent.code === 201
      && c.withConsent.a?.first?.utm_campaign === 'spring' && c.withConsent.a?.last?.utm_campaign === 'october' && c.withConsent.a?.first?.gclid === 'G1-abc');
    t(`D3: no consent cookie: nothing (${j(c.noConsent)})`, c.noConsent.code === 201 && c.noConsent.a === null);
    t(`D3: analytics consent only: nothing (${j(c.analyticsOnly)})`, c.analyticsOnly.code === 201 && c.analyticsOnly.a === null);
    t(`D3: consent under the old version: nothing (${j(c.oldVersion)})`, c.oldVersion.code === 201 && c.oldVersion.a === null);
    t(`D3: expired consent: nothing (${j(c.expired)})`, c.expired.code === 201 && c.expired.a === null);
    t(`D3: a garbage cookie never fails the order (${j(c.garbage)})`, c.garbage.code === 201 && c.garbage.a === null);
    t(`D3: a body attribution wins over the cookie (${j(c.bodyWins)})`, c.bodyWins.a?.last?.utm_source === 'body');
    t(`D3: a body attribution is ignored when this site's own consent cookie refuses marketing (${j(c.bodyRefused)})`,
      c.bodyRefused.code === 201 && c.bodyRefused.a === null);
    t(`D3: ...but an API key's body is not judged by a cookie (${j(c.keyBody)})`, c.keyBody.code === 201 && c.keyBody.a?.last?.utm_source === 'key');
  }
  if (r.clock && !r.clock.error) {
    const k = r.clock;
    t(`D8: a FAST device clock still places the order, time clamped to the server's (${j(k.fast)})`,
      k.fast.code === 201 && k.fast.src === 'fast' && k.fast.clamped === true);
    t(`D8: a touch aged out by the server's clock is dropped, the order placed (${j(k.old)})`, k.old.code === 201 && k.old.has === false);
    t(`D8: an aged-out first touch gives way to the last (${j(k.oldFirst)})`,
      k.oldFirst.code === 201 && k.oldFirst.a?.first?.utm_source === 'recent' && k.oldFirst.a?.last?.utm_source === 'recent');
    t(`D8: a first touch later than the last gives way to it (${j(k.swapped)})`,
      k.swapped.code === 201 && k.swapped.a?.first?.utm_source === 'b');
  }
  if (r.gates && !r.gates.error) {
    const g = r.gates;
    t(`D4: staff-placed orders keep nothing (${j(g.staff)})`, g.staff.code === 201 && g.staff.has === false);
    t(`D4: switched off: nothing from the body (${j(g.off)})`, g.off.code === 201 && g.off.has === false);
    t(`D4: switched off: nothing from the cookie (${j(g.offCookie)})`, g.offCookie.code === 201 && g.offCookie.has === false);
    t(`D4: the STRING "false" is off too (${j(g.offString)})`, g.offString.code === 201 && g.offString.has === false);
    t(`D4: switched back on, it is kept (${j(g.on)})`, g.on.has === true);
  }
  if (r.gdpr && !r.gdpr.error) {
    const g = r.gdpr;
    t(`D5: a data-subject export carries the attribution (${j(g.exported)})`, g.exported?.last?.gclid === 'gdpr-click' && g.exportJson === true);
    t(`D5: an erasure removes it entirely (${g.afterHas}/${g.afterJson})`, g.afterHas === false && g.afterJson === false);
    t('D5: ...and keeps the order\'s figures', typeof g.kept === 'number' && g.kept > 0);
  }
  if (r.report && !r.report.error) {
    const p = r.report;
    const rows = (rep) => (rep?.rows ?? []).map((x) => `${x.source}/${x.medium}/${x.campaign}:${x.orders}`);
    t(`D6: last-touch report (${j(rows(p.last))})`, p.last?.orders === 4 && p.last?.attributed === 3 && p.last?.unattributed === 1
      && rows(p.last).includes('google/cpc/spring:1') && rows(p.last).includes('newsletter/email/oct:1'));
    t(`D6: first-touch credits the first visit (${j(rows(p.first))})`, rows(p.first).includes('google/cpc/spring:2') && !rows(p.first).some((x) => x.startsWith('newsletter')));
    t('D6: unpaid orders are not revenue', !rows(p.last).some((x) => x.startsWith('unpaid')));
    t(`D6: CSV is served as a download (${p.csv.code} ${p.csv.type})`, p.csv.code === 200 && /text\/csv/.test(p.csv.type));
    const lines = p.csv.text.trim().split(/\r\n/);
    t(`D6: CSV header (${lines[0]})`, lines[0] === 'model,from,to,source,medium,campaign,orders,revenue,currency');
    t('D6: CSV has the same rows as JSON, plus the unattributed row', lines.length === 1 + p.last.rows.length + 1);
    t('D6: CSV revenue is a plain decimal', lines.some((l) => l.includes(',google,cpc,spring,1,10.00,EUR')));
    t('D6: a campaign that looks like a formula is defused', p.csv.text.includes(",'=SUM(1+1),"));
    t(`D6: anonymous callers are refused (${p.anon})`, p.anon === 401);
    t(`D6: a role that cannot read orders is refused (${p.editor})`, p.editor === 403);
    t(`D6: bad dates, a reversed or over-long range, unknown model or format are 400 (${j(p.bad)})`, p.bad.every((c) => c === 400));
    t(`D6: an empty range is zero, not an error (${p.empty})`, p.empty === 0);
  }
  if (r.loader && !r.loader.error) {
    const l = r.loader;
    for (const row of l.table) {
      t(`D7: browser and server agree on ${j(row.search.slice(0, 50))} (${j(row.browser)} vs ${j(row.server)})`, j(row.browser) === j(row.server));
    }
    t(`D7: with marketing consent the loader keeps the touch (${j(l.kept)})`, l.kept?.last?.utm_source === 'google' && l.kept?.last?.gclid === 'abc');
    t('D7: no decision yet: nothing is written', l.noDecision === null);
    t('D7: analytics consent alone: nothing is written', l.analyticsOnly === null);
    t('D7: consent withdrawn: an existing cookie is DELETED', l.withdrawn === null);
    t(`D7: a second campaign visit keeps the first touch (${j(l.second)})`, l.second?.first?.utm_source === 'google' && l.second?.last?.utm_source === 'bing');
    t('D7: an ordinary visit changes nothing', l.plain?.last?.utm_source === 'newsletter');
    t('D7: what the browser writes, the server reads', l.roundTrip === true);
    t('D7: switched off, the loader ships no rules and deletes the cookie', l.offShipsNull === true && l.off === null);
    t(`D7: Google Ads loads with marketing consent (${j(l.adsYes)})`, l.adsYes.some((s) => /googletagmanager\.com\/gtag\/js\?id=AW-123456789/.test(s)));
    t(`D7: ...and not without it (${j(l.adsNo)})`, l.adsNo.length === 0);
  }
}

// Results must agree on all three drivers.
const names = Object.keys(perDriver);
if (names.length === 3) {
  const shape = (r) => j({
    body: r.body?.ok?.stored && { ...r.body.ok.stored, first: { ...r.body.ok.stored.first, at: 0 }, last: { ...r.body.ok.stored.last, at: 0 } },
    invalid: r.invalid?.res, gates: r.gates, report: r.report?.last && { ...r.report.last, from: 0, to: 0 },
  });
  check('all three drivers give the same answers', shape(perDriver.lowdb) === shape(perDriver.libsql) && shape(perDriver.libsql) === shape(perDriver.relational));
} else {
  check(`all three drivers ran (${names.join(',')})`, false);
}

await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
