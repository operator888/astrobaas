import type { APIRoute } from 'astro';
import { jsonForScript } from '../lib/json-in-html';
import { LocalDB } from '../lib/localdb';
import { pluginManager } from '../lib/plugin-system';
import { ensurePluginsBootstrapped } from '../plugins';
import { configuredAnalytics } from '../lib/analytics';
import {
  CONSENT_COOKIE, CONSENT_VERSION, CONSENT_MAX_AGE_DAYS, CONSENT_DESCRIPTORS, OPTIONAL_CATEGORIES,
  CONSENT_STRINGS,
  CONSENT_MODE_SIGNALS,
  CONSENT_MODE_CATEGORY,
} from '../lib/consent';

/**
 * `/consent.js` — the consent banner and the analytics loader, as ONE served
 * same-origin script.
 *
 * Why a served file rather than an inline snippet: the production CSP is
 * hash-based with no `'unsafe-inline'`, and per-request markup has no
 * build-time hash, so an inline `<script>` is silently dropped — tag in the
 * DOM, nothing runs, no console error. Serving from our own origin satisfies
 * `script-src 'self'`. The vendor tags this file injects are `<script src=…>`
 * pointing at origins that were added to the policy at BUILD time from the same
 * connector catalogue (see csp-config.ts), so the policy stays exact.
 *
 * Why banner and loader together: the ordering guarantee is the whole point.
 * Two files would race, and the failure mode of that race is firing a tracker
 * before consent — the exact thing this is supposed to prevent.
 *
 * The file is generated per request from settings, but contains no secrets:
 * tracking IDs are public by nature (they ship in the page on every site that
 * uses them).
 */
export const prerender = false;

/** JSON for embedding in a script. `<` is escaped so nothing can close the tag. */
function safeJson(value: unknown): string {
  return jsonForScript(value);
}

export const GET: APIRoute = async () => {
  let payload = { enabled: false, providers: [] as any[], descriptors: [] as any[] };

  try {
    await LocalDB.init();
    await ensurePluginsBootstrapped();

    const rows = await LocalDB.getSettings();
    const map: Record<string, unknown> = {};
    for (const r of rows) map[r.key] = r.value;

    // The banner is a plugin: no plugin, no banner. The analytics loader still
    // runs, but with nothing consented it will not fire anything — failing
    // closed rather than falling back to "no banner means allow".
    const bannerActive = pluginManager.getActivePlugins?.().some?.((p: any) => p.id === 'consent-banner') ?? false;

    payload = {
      enabled: bannerActive,
      providers: configuredAnalytics(map).map((c) => ({
        id: c.provider.id,
        category: c.provider.category,
        trackingId: c.trackingId,
      })),
      descriptors: CONSENT_DESCRIPTORS.map((d) => ({ id: d.id, required: d.required })),
    };
  } catch (err) {
    // A failure here must not fire trackers by accident. Empty config = nothing
    // loads, banner absent — the safe direction.
    console.error('consent.js build error:', err);
  }

  const js = `/* AstroBaaS consent + analytics loader */
(function () {
  'use strict';
  var CONFIG = ${safeJson(payload)};
  /*
   * Every locale's strings ship in the one served file, and the page's own
   * <html lang> picks at runtime. One URL covers a multilingual site with no
   * extra request — and consent a visitor cannot read is not consent, which is
   * why this is not "English with a TODO".
   */
  var STRINGS = ${safeJson(CONSENT_STRINGS)};
  var LANG = (document.documentElement.lang || 'en').split('-')[0];
  var T = STRINGS[LANG] || STRINGS.en;
  var COOKIE = ${safeJson(CONSENT_COOKIE)};
  var VERSION = ${CONSENT_VERSION};
  var MAX_AGE_DAYS = ${CONSENT_MAX_AGE_DAYS};
  var OPTIONAL = ${safeJson(OPTIONAL_CATEGORIES)};
  var CM_SIGNALS = ${safeJson(CONSENT_MODE_SIGNALS)};
  /*
   * Which category each Google signal follows. Shipped from lib/consent.ts
   * rather than restated here, because a signal mapped to the wrong category
   * is invisible in a browser: the tag loads, the page works, and either the
   * measurement is silently wrong or the ad account is silently non-compliant.
   */
  var CM_CATEGORY = ${safeJson(CONSENT_MODE_CATEGORY)};

  /* ---------- dataLayer ---------- */
  /*
   * Defined before anything else and used by the Consent Mode pushes below,
   * so the default state is the FIRST thing in the queue whatever else
   * happens. gtag is a dataLayer push and nothing more — no network, no
   * storage — so this is safe to run before any decision.
   */
  function gtag() { window.dataLayer = window.dataLayer || []; window.dataLayer.push(arguments); }

  /* ---------- storage ---------- */
  function readCookie() {
    var m = document.cookie.match(new RegExp('(?:^|; )' + COOKIE + '=([^;]*)'));
    if (!m) return null;
    try { return JSON.parse(decodeURIComponent(m[1])); } catch (e) { return null; }
  }
  function readConsent() {
    var raw = readCookie();
    if (!raw || raw.v !== VERSION) return null;         // superseded -> re-ask
    var t = Number(raw.t);
    if (!isFinite(t) || t <= 0) return null;
    var ageDays = (Date.now() - t) / 86400000;
    if (ageDays < 0 || ageDays > MAX_AGE_DAYS) return null;
    return {
      v: VERSION,
      t: t,
      granted: Array.isArray(raw.granted) ? raw.granted : [],
      // Carried through so a visitor can quote their own receipt, and so the
      // public API below can show it to them.
      r: typeof raw.r === 'string' ? raw.r : null,
    };
  }
  /*
   * An opaque receipt id, generated HERE and nowhere else.
   *
   * It goes into the visitor's own cookie and into the server's record of the
   * decision, and it is derived from nothing — not the address, not the user
   * agent, not the time. That is what lets the shop demonstrate a decision was
   * made (Article 7(1)) while holding nothing that identifies who made it: the
   * only copy of the link is in the browser of the person who made it.
   */
  function newReceiptId() {
    try {
      if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    } catch (e) { /* fall through */ }
    return null;
  }

  function recordReceipt(rec) {
    if (!rec.r) return;
    try {
      var body = JSON.stringify({ id: rec.r, granted: rec.granted, version: rec.v });
      // Fire-and-forget, and failures are ignored on purpose: the decision is
      // already in the visitor's cookie and that is what governs what loads.
      // A banner that showed an error because the shop's bookkeeping failed
      // would be a worse outcome than a missing row.
      // sendBeacon is the right tool — it survives the page unload that
      // "reject and navigate away" causes — but it cannot set headers, so the
      // receipt route is CSRF-exempt (it carries no ambient authority: an
      // opaque browser-generated id, rate-limited, granting nothing). The
      // fetch fallback is deliberately header-free too, so both paths hit the
      // same exempt route identically.
      if (navigator.sendBeacon) {
        navigator.sendBeacon('/api/consent/receipt', new Blob([body], { type: 'application/json' }));
        return;
      }
      fetch('/api/consent/receipt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body,
        keepalive: true,
      }).catch(function () {});
    } catch (e) { /* never let bookkeeping break the banner */ }
  }

  function writeConsent(granted) {
    var rec = { v: VERSION, t: Date.now(), granted: granted.indexOf('necessary') < 0 ? ['necessary'].concat(granted) : granted };
    rec.r = newReceiptId();
    var maxAge = MAX_AGE_DAYS * 86400;
    // SameSite=Lax + Secure on https. Not HttpOnly: the banner has to read it.
    // It holds a preference, not a credential.
    document.cookie = COOKIE + '=' + encodeURIComponent(JSON.stringify(rec)) +
      ';path=/;max-age=' + maxAge + ';SameSite=Lax' + (location.protocol === 'https:' ? ';Secure' : '');
    // One place writes a decision, so one place tells Google about it AND one
    // place records the receipt. A second call site is how "reject" ends up
    // updating the signals and "save my choices" does not.
    pushConsentMode('update', rec);
    recordReceipt(rec);
    return rec;
  }
  function granted(cat) {
    if (cat === 'necessary') return true;
    var c = readConsent();
    // No record -> nothing is consented. This is what makes consent PRIOR.
    return !!c && c.granted.indexOf(cat) >= 0;
  }

  /* ---------- Google Consent Mode v2 ---------- */
  /*
   * A DELIBERATE DIFFERENCE from the way Google documents this.
   *
   * Google's own guidance is to load gtag.js unconditionally and let the
   * consent signals decide what it does, so that it can model the traffic it
   * is not allowed to measure. This site does not do that: nothing loads from
   * a third party until a visitor has said yes, which is the stricter reading
   * of ePrivacy and the promise the banner already makes.
   *
   * So the signals are emitted, correctly and in the right order, into a
   * dataLayer that exists from the start — pushing to an array sets no
   * cookies, contacts nobody and costs nothing — and the tag reads the whole
   * history the moment it is allowed to load. What is given up is Google's
   * modelling of un-consented traffic. What is kept is that a visitor who
   * rejects has no request made on their behalf at all.
   */
  function signalState(record) {
    var out = {};
    for (var i = 0; i < CM_SIGNALS.length; i++) {
      var sig = CM_SIGNALS[i];
      var cat = CM_CATEGORY[sig];
      out[sig] = (cat === 'necessary' || (record && record.granted.indexOf(cat) >= 0))
        ? 'granted' : 'denied';
    }
    return out;
  }
  function pushConsentMode(mode, record) {
    var state = signalState(record);
    if (mode === 'default') {
      // "wait_for_update" tells a tag that loads later to hold its first hits
      // briefly rather than sending them with the default denials.
      state.wait_for_update = 500;
    }
    gtag('consent', mode, state);
  }

  /* ---------- vendor loaders ---------- */
  function addScript(src, attrs) {
    var s = document.createElement('script');
    s.async = true;
    s.src = src;
    if (attrs) for (var k in attrs) s.setAttribute(k, attrs[k]);
    document.head.appendChild(s);
    return s;
  }

  var LOADERS = {
    ga4: function (id) {
      addScript('https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(id));
      window.dataLayer = window.dataLayer || [];
      gtag('js', new Date());
      // No cookies until consent, and consent is why we are here at all.
      gtag('config', id, { anonymize_ip: true });
    },
    gtm: function (id) {
      window.dataLayer = window.dataLayer || [];
      window.dataLayer.push({ 'gtm.start': Date.now(), event: 'gtm.js' });
      addScript('https://www.googletagmanager.com/gtm.js?id=' + encodeURIComponent(id));
    },
    'meta-pixel': function (id) {
      if (!window.fbq) {
        var n = (window.fbq = function () {
          n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
        });
        n.queue = []; n.loaded = true; n.version = '2.0';
        window._fbq = window._fbq || n;
        addScript('https://connect.facebook.net/en_US/fbevents.js');
      }
      window.fbq('init', id);
      window.fbq('track', 'PageView');
    },
    linkedin: function (id) {
      window._linkedin_partner_id = String(id);
      window._linkedin_data_partner_ids = window._linkedin_data_partner_ids || [];
      window._linkedin_data_partner_ids.push(String(id));
      addScript('https://snap.licdn.com/li.lms-analytics/insight.min.js');
    },
    tiktok: function (id) {
      var w = window; w.TiktokAnalyticsObject = 'ttq';
      var ttq = (w.ttq = w.ttq || []);
      ttq.methods = ['page', 'track', 'identify', 'instances', 'debug', 'on', 'off', 'once', 'ready', 'alias', 'group', 'enableCookie', 'disableCookie'];
      ttq.setAndDefer = function (t, e) { t[e] = function () { t.push([e].concat(Array.prototype.slice.call(arguments, 0))); }; };
      for (var i = 0; i < ttq.methods.length; i++) ttq.setAndDefer(ttq, ttq.methods[i]);
      ttq._i = ttq._i || {}; ttq._i[id] = []; ttq._t = ttq._t || {}; ttq._t[id] = +new Date();
      addScript('https://analytics.tiktok.com/i18n/pixel/events.js?sdkid=' + encodeURIComponent(id) + '&lib=ttq');
      ttq.page && ttq.page();
    },
    pinterest: function (id) {
      if (!window.pintrk) {
        window.pintrk = function () { window.pintrk.queue.push(Array.prototype.slice.call(arguments)); };
        window.pintrk.queue = []; window.pintrk.version = '3.0';
        addScript('https://s.pinimg.com/ct/core.js');
      }
      window.pintrk('load', String(id));
      window.pintrk('page');
    },
    clarity: function (id) {
      window.clarity = window.clarity || function () { (window.clarity.q = window.clarity.q || []).push(arguments); };
      addScript('https://www.clarity.ms/tag/' + encodeURIComponent(id));
    },
    hotjar: function (id) {
      window._hjSettings = { hjid: Number(id), hjsv: 6 };
      window.hj = window.hj || function () { (window.hj.q = window.hj.q || []).push(arguments); };
      addScript('https://static.hotjar.com/c/hotjar-' + encodeURIComponent(id) + '.js?sv=6');
    },
    plausible: function (domain) {
      addScript('https://plausible.io/js/script.js', { 'data-domain': domain, defer: 'defer' });
    },
    fathom: function (id) {
      addScript('https://cdn.usefathom.com/script.js', { 'data-site': id, defer: 'defer' });
    },
    umami: function (id) {
      var host = CONFIG.umamiHost || '';
      if (!host) return; // self-hosted: no host configured, nothing to load
      addScript(host.replace(/\\/+$/, '') + '/script.js', { 'data-website-id': id, defer: 'defer' });
    }
  };

  var fired = {};
  function loadConsented() {
    for (var i = 0; i < CONFIG.providers.length; i++) {
      var p = CONFIG.providers[i];
      if (fired[p.id]) continue;
      if (!granted(p.category)) continue;
      var fn = LOADERS[p.id];
      if (!fn) continue;
      fired[p.id] = true;
      try { fn(p.trackingId); } catch (e) { /* one broken vendor must not stop the rest */ }
    }
  }

  /* ---------- banner ---------- */
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    // textContent, never innerHTML: descriptions are operator-configurable.
    if (text != null) e.textContent = text;
    return e;
  }

  function renderBanner() {
    var wrap = el('div', 'abc-banner');
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'false');
    wrap.setAttribute('aria-label', T.title);

    var body = el('div', 'abc-body');
    body.appendChild(el('h2', 'abc-title', T.title));
    body.appendChild(el('p', 'abc-text', T.body));

    var detail = el('div', 'abc-detail');
    detail.hidden = true;
    var boxes = {};
    CONFIG.descriptors.forEach(function (d) {
      var row = el('label', 'abc-row');
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'abc-check';
      // No pre-ticked optional boxes — that is not consent.
      cb.checked = !!d.required;
      cb.disabled = !!d.required;
      boxes[d.id] = cb;
      var txt = el('span', 'abc-rowtext');
      var cat = T.categories[d.id] || { label: d.id, description: '' };
      txt.appendChild(el('strong', null, cat.label + (d.required ? ' (' + T.alwaysOn + ')' : '')));
      txt.appendChild(el('span', 'abc-desc', cat.description));
      row.appendChild(cb);
      row.appendChild(txt);
      detail.appendChild(row);
    });

    var actions = el('div', 'abc-actions');
    // Reject and Accept are siblings with the SAME weight and one click each.
    var reject = el('button', 'abc-btn', T.rejectOptional);
    var customise = el('button', 'abc-btn abc-btn-ghost', T.choose);
    var accept = el('button', 'abc-btn abc-btn-primary', T.acceptAll);
    var save = el('button', 'abc-btn abc-btn-primary', T.save);
    save.hidden = true;

    reject.type = customise.type = accept.type = save.type = 'button';

    function close() {
      wrap.remove();
      loadConsented();
      showReopener();
    }
    reject.addEventListener('click', function () { writeConsent([]); close(); });
    accept.addEventListener('click', function () {
      writeConsent(OPTIONAL.slice());
      close();
    });
    customise.addEventListener('click', function () {
      detail.hidden = !detail.hidden;
      save.hidden = detail.hidden;
      customise.setAttribute('aria-expanded', String(!detail.hidden));
    });
    save.addEventListener('click', function () {
      var picked = [];
      OPTIONAL.forEach(function (c) { if (boxes[c] && boxes[c].checked) picked.push(c); });
      writeConsent(picked);
      close();
    });

    actions.appendChild(reject);
    actions.appendChild(customise);
    actions.appendChild(accept);
    actions.appendChild(save);

    body.appendChild(detail);
    body.appendChild(actions);
    wrap.appendChild(body);
    document.body.appendChild(wrap);
  }

  /** Withdrawal has to be as easy as granting, so leave a way back in. */
  function showReopener() {
    if (document.querySelector('.abc-reopen')) return;
    var b = el('button', 'abc-reopen', T.reopen);
    b.type = 'button';
    b.addEventListener('click', function () {
      b.remove();
      renderBanner();
    });
    document.body.appendChild(b);
  }

  function start() {
    /*
     * The default goes first, ALWAYS denied, whatever this visitor decided
     * before. That is the order Google's Consent Mode requires: a "default"
     * describing the state before any decision, then an "update" carrying the
     * decision itself. Skipping the default for a returning visitor — which
     * looks like a harmless optimisation — leaves a tag that arrives late with
     * no baseline to compare against.
     */
    pushConsentMode('default', null);
    var stored = readConsent();
    if (stored) pushConsentMode('update', stored);

    // Load anything already consented FIRST so a returning visitor is not made
    // to wait on UI, then decide whether to ask.
    loadConsented();
    if (!CONFIG.enabled) return;          // banner plugin inactive
    if (readConsent()) { showReopener(); return; }
    renderBanner();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  // Small public API so a storefront can offer its own "cookie settings" link.
  window.astrobaasConsent = {
    get: readConsent,
    has: granted,
    open: function () {
      var r = document.querySelector('.abc-reopen');
      if (r) r.remove();
      if (!document.querySelector('.abc-banner')) renderBanner();
    }
  };
})();
`;

  return new Response(js, {
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      // Per-visitor settings-driven content: never let a proxy share it.
      'Cache-Control': 'no-store',
    },
  });
};
