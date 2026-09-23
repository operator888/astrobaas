import type { APIRoute } from 'astro';

/**
 * `/captcha.js` — the proof-of-work widget, served same-origin.
 *
 * Served rather than inlined for the same reason as /consent.js: the
 * production CSP is hash-based with no 'unsafe-inline', so per-request
 * inline scripts silently do not run; a same-origin file satisfies
 * `script-src 'self'` with no policy change.
 *
 * Contract with markup: any `<form data-captcha="<surface>">` is picked up
 * automatically. The widget asks the server whether that surface is
 * protected; if not, it does nothing at all. If it is, it solves the
 * challenge in the background (WebCrypto SHA-256, yielding to the event
 * loop so typing stays smooth) and drops the proof into a hidden
 * `pow_token` input. A submit that races the solver is held politely —
 * preventDefault, finish, resubmit — so the visitor never sees a failure
 * they did not cause. Forms that submit via fetch() read the same hidden
 * input; the field name is the whole API.
 *
 * A form may also carry its own challenge in `data-captcha-token` and
 * `data-captcha-bits`; the widget solves that one first instead of asking the
 * endpoint. The sign-in page does, so an account that has started requiring
 * proof-of-work (lib/login-guard.ts) never blocks its owner.
 *
 * No third party is contacted, ever. That is the point of the feature.
 */
export const prerender = false;

const WIDGET = String.raw`(function () {
  'use strict';
  if (!window.crypto || !window.crypto.subtle || !window.TextEncoder) return;

  var enc = new TextEncoder();

  function leadingZeroBits(bytes, bits) {
    var remaining = bits;
    for (var i = 0; i < bytes.length && remaining > 0; i++) {
      var take = Math.min(8, remaining);
      if ((bytes[i] >>> (8 - take)) !== 0) return false;
      remaining -= take;
    }
    return remaining <= 0;
  }

  async function solve(token, bits) {
    var n = 0;
    for (;;) {
      // Batches keep the page responsive: hash a chunk, yield, repeat.
      for (var i = 0; i < 64; i++) {
        var digest = new Uint8Array(
          await crypto.subtle.digest('SHA-256', enc.encode(token + '.' + String(n)))
        );
        if (leadingZeroBits(digest, bits)) return String(n);
        n++;
      }
      await new Promise(function (r) { setTimeout(r, 0); });
      if (n > 40000000) return null; // give up rather than heat the laptop forever
    }
  }

  function arm(form) {
    var surface = form.getAttribute('data-captcha');
    if (!surface) return;

    var input = document.createElement('input');
    input.type = 'hidden';
    input.name = 'pow_token';
    form.appendChild(input);

    var ready = null; // null = not needed / not known yet; a promise once solving

    // A challenge the PAGE already carries (data-captcha-token/-bits), used
    // once, instead of asking the endpoint. The sign-in page mints one because
    // an account under attack requires a proof even when the operator has left
    // the login surface switched off, and the endpoint would answer "off".
    var embedded = form.getAttribute('data-captcha-token');
    var embeddedBits = Number(form.getAttribute('data-captcha-bits'));

    function refresh() {
      if (embedded && embeddedBits > 0) {
        var t = embedded;
        embedded = null;
        ready = solve(t, embeddedBits).then(function (nonce) {
          if (nonce !== null) input.value = t + '::' + nonce;
        });
        return ready;
      }
      ready = fetch('/api/captcha/challenge?surface=' + encodeURIComponent(surface))
        .then(function (r) { return r.json(); })
        .then(function (j) {
          var d = j && j.data;
          if (!d || !d.enabled) { ready = null; return; }
          return solve(d.token, d.bits).then(function (nonce) {
            if (nonce !== null) input.value = d.token + '::' + nonce;
          });
        })
        .catch(function () { /* offline etc. — the server will say no politely */ });
      return ready;
    }
    refresh();

    form.addEventListener('submit', function (e) {
      if (ready && !input.value) {
        // Solver still running: hold the submit until the proof is in.
        e.preventDefault();
        var f = e.target;
        ready.then(function () {
          if (typeof f.requestSubmit === 'function') f.requestSubmit();
          else f.submit();
        });
      }
      // A used challenge is dead; start on a fresh one for a possible retry.
      setTimeout(function () { input.value = ''; refresh(); }, 50);
    });
  }

  function init() {
    var forms = document.querySelectorAll('form[data-captcha]');
    for (var i = 0; i < forms.length; i++) arm(forms[i]);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
`;

export const GET: APIRoute = async () => new Response(WIDGET, {
  status: 200,
  headers: {
    'Content-Type': 'application/javascript; charset=utf-8',
    // The widget itself is static, but keep it honest with settings changes.
    'Cache-Control': 'no-store',
  },
});
