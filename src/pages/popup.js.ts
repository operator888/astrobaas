import type { APIRoute } from 'astro';
import { jsonForScript } from '../lib/json-in-html';
import { LocalDB } from '../lib/localdb';
import { ensurePluginsBootstrapped } from '../plugins';
import { pluginManager } from '../lib/plugin-system';
import { popupsAreLive } from '../lib/popups-runtime';
import { resolvePopup, popupPayload, POPUP_STORAGE_KEY, CONSENT_WAIT_MS } from '../lib/popups';
import { CONSENT_COOKIE } from '../lib/consent';

export const prerender = false;

/**
 * `/popup.js` — the opt-in overlay (C-114).
 *
 * A served same-origin file rather than an inline snippet, for the reason every
 * browser-side feature here is: the production CSP is hash-based with no
 * `'unsafe-inline'`, so per-request inline script is silently dropped — tag in
 * the DOM, nothing runs, no console error.
 *
 * It answers 404 when the `popups` plugin is inactive or nothing is configured.
 * Not an empty script: a 404 is what tells a reader of the network panel that
 * the feature is OFF rather than broken, and it is the same shape
 * `/assistant.js` uses.
 *
 * The payload is public copy — a title, a sentence, a button label. There is
 * nothing here a visitor could not read off the page it renders.
 */
export const GET: APIRoute = async () => {
  try {
    await LocalDB.init();
    await ensurePluginsBootstrapped();

    // The SAME question BaseLayout asks before emitting the tag. Asking it
    // twice is how the two drift, and the drift is invisible either way.
    if (!(await popupsAreLive())) return new Response('Not found', { status: 404 });

    const rows = await LocalDB.getSettings();
    const map: Record<string, unknown> = {};
    for (const r of rows) map[r.key] = r.value;

    const payload = popupPayload(resolvePopup(map));
    if (!payload) return new Response('Not found', { status: 404 });

    // Is there a consent banner to wait BEHIND?
    //
    // The popup must not stack on top of one — a reader being asked about
    // cookies is already interrupted. But the cookie it waits for is written
    // ONLY by the banner, so on an install without the banner plugin the wait
    // never ended and the popup never appeared: no error, no 404, nothing to
    // diagnose. The feature was dead on every install that did not also run the
    // banner, which is most of them.
    //
    // Decided HERE, server-side, where the plugin list is known — the browser
    // cannot tell "no decision yet" from "nothing will ever ask".
    const bannerActive = pluginManager.getActivePlugins?.().some?.(
      (pl: { id?: string }) => pl.id === 'consent-banner',
    ) ?? false;

    return new Response(script(payload, bannerActive), {

      headers: {
        'Content-Type': 'application/javascript; charset=utf-8',
        // Per-visitor state is in the browser, not here, so this file is the
        // same for everyone — but it changes when the operator edits the copy,
        // so it is not cached hard.
        'Cache-Control': 'public, max-age=60',
      },
    });
  } catch (err) {
    console.error('Popup script error:', err);
    return new Response('Not found', { status: 404 });
  }
};

function script(payload: Record<string, unknown>, bannerActive: boolean): string {
  return `(function () {
  'use strict';
  var cfg = ${jsonForScript(payload)};
  var KEY = ${JSON.stringify(POPUP_STORAGE_KEY)};
  var CONSENT_COOKIE = ${JSON.stringify(CONSENT_COOKIE)};
  /* Whether a consent banner exists to wait behind. With no banner there is no
     decision coming, and waiting for one means never showing at all. */
  var WAITS_FOR_CONSENT = ${bannerActive ? 'true' : 'false'};

  /* Storage can throw outright in a locked-down browser, and a popup must
     never be the thing that breaks a page. Every read and write is guarded,
     and an unreadable store is treated as "never seen" — which shows the
     popup once rather than never, and the frequency cap then does its job on
     the next visit if storage starts working. */
  function read() {
    try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; }
  }
  function write(value) {
    try { localStorage.setItem(KEY, JSON.stringify(value)); } catch (e) { /* private mode */ }
  }

  function shouldShow(stored, days, now) {
    if (!stored) return true;
    if (stored.done === true) return false;
    if (typeof stored.seen !== 'number' || !isFinite(stored.seen)) return true;
    if (stored.seen > now) return false;
    return now - stored.seen >= days * 86400000;
  }

  if (!shouldShow(read(), cfg.frequencyDays, Date.now())) return;

  /* Never on top of the consent banner. A reader being asked about cookies is
     already being interrupted; stacking a second overlay is how both get
     dismissed unread. If no decision exists yet, wait — and give up rather
     than queue forever behind a banner nobody answers. */
  function consentDecided() {
    if (!WAITS_FOR_CONSENT) return true;
    return document.cookie.indexOf(CONSENT_COOKIE + '=') !== -1;
  }

  var shown = false;
  var pending = false;

  /* A trigger fired. Show now if the reader has already answered the consent
     banner, otherwise mark it pending — the waiter below picks it up. */
  function trigger() {
    pending = true;
    if (consentDecided()) show();
    else waitForConsent();
  }

  function show() {
    if (shown) return;
    shown = true;
    teardown();

    var box = document.createElement('div');
    box.className = 'abp';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'false');
    box.setAttribute('aria-labelledby', 'abp-title');

    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'abp-close';
    close.setAttribute('aria-label', 'Close');
    close.textContent = '\\u00d7';

    var body = document.createElement('div');
    body.className = 'abp-body';

    var title = document.createElement('p');
    title.className = 'abp-title';
    title.id = 'abp-title';
    /* textContent everywhere: this is operator-authored copy, and building it
       with innerHTML would make the settings form an XSS vector on every
       public page. */
    title.textContent = cfg.title;

    var text = document.createElement('p');
    text.className = 'abp-text';
    text.textContent = cfg.text;

    var actions = document.createElement('div');
    actions.className = 'abp-actions';

    body.appendChild(title);
    body.appendChild(text);

    if (cfg.buttonUrl) {
      var link = document.createElement('a');
      link.className = 'abp-btn abp-btn-primary';
      /* Validated server-side (see popups.ts), and again here because this
         value reaches an href on every public page. */
      link.href = cfg.buttonUrl;
      link.textContent = cfg.buttonLabel;
      link.addEventListener('click', function () { remember(true); });
      actions.appendChild(link);
      body.appendChild(actions);
    } else {
      /* No URL means the built-in newsletter form, posting to the same
         double-opt-in endpoint the site's own form uses. */
      var form = document.createElement('form');
      var input = document.createElement('input');
      input.className = 'abp-input';
      input.type = 'email';
      input.required = true;
      input.placeholder = 'you@example.com';
      input.setAttribute('aria-label', 'Email address');
      var submit = document.createElement('button');
      submit.type = 'submit';
      submit.className = 'abp-btn abp-btn-primary';
      submit.textContent = cfg.buttonLabel;
      var note = document.createElement('p');
      note.className = 'abp-note';
      note.textContent = 'We will email you to confirm. You can leave at any time.';
      actions.appendChild(submit);
      form.appendChild(input);
      form.appendChild(actions);
      form.appendChild(note);
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        submit.disabled = true;
        /* The CSRF token. /api/newsletter accepts anonymous writes but is
           still CSRF-protected, so without this header every submission was
           refused with a 403 — and because the old code never checked res.ok,
           the reader was told "check your email", no address was captured, and
           that browser was permanently marked done. Both sibling forms on this
           site send the header and check the status; this one did neither. */
        var csrf = (document.cookie.match(/(?:^|; )astrobaas_csrf=([^;]*)/) || [])[1] || '';
        fetch('/api/newsletter', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': decodeURIComponent(csrf) },
          body: JSON.stringify({ email: input.value })
        }).then(function (res) {
          if (!res.ok) {
            submit.disabled = false;
            note.textContent = 'That did not work. Please try again.';
            return;
          }
          /* Remembered as DONE only on success. The endpoint gives the same
             answer whether or not the address was already on the list —
             deliberately, so it cannot be used to ask "is this person
             subscribed?" — so a 2xx is the only honest signal we have, and it
             means they must not be asked again. */
          remember(true);
          note.textContent = 'Check your email to confirm.';
          form.removeChild(actions);
          form.removeChild(input);
        }).catch(function () {
          submit.disabled = false;
          note.textContent = 'That did not work. Please try again.';
        });
      });
      body.appendChild(form);
    }

    box.appendChild(close);
    box.appendChild(body);
    document.body.appendChild(box);

    function dismiss() {
      remember(false);
      if (box.parentNode) box.parentNode.removeChild(box);
      document.removeEventListener('keydown', onKey);
    }
    function onKey(event) { if (event.key === 'Escape') dismiss(); }
    close.addEventListener('click', dismiss);
    document.addEventListener('keydown', onKey);

    /* Seen counts from the moment it appears, not from the dismissal — a
       reader who ignores it has still been interrupted once. */
    remember(false);
  }

  function remember(done) {
    var stored = read() || {};
    stored.seen = Date.now();
    if (done) stored.done = true;
    write(stored);
  }

  var timer = null;
  function onScroll() {
    var doc = document.documentElement;
    var max = doc.scrollHeight - doc.clientHeight;
    if (max <= 0) return;
    if ((doc.scrollTop / max) * 100 >= cfg.scrollPercent) trigger();
  }
  function onExit(event) { if (event.clientY <= 0) trigger(); }
  function teardown() {
    if (timer) clearTimeout(timer);
    window.removeEventListener('scroll', onScroll);
    document.removeEventListener('mouseout', onExit);
  }

  if (cfg.trigger === 'scroll') {
    window.addEventListener('scroll', onScroll, { passive: true });
  } else if (cfg.trigger === 'exit') {
    /* Exit intent needs a pointer that can leave the top of the window. On a
       touch screen there is none, so it falls back to the delay — otherwise
       the popup simply never appears on half the traffic and the operator has
       no way to find out why. */
    if (window.matchMedia && window.matchMedia('(hover: hover)').matches) {
      document.addEventListener('mouseout', onExit);
    } else {
      timer = setTimeout(trigger, cfg.delaySeconds * 1000);
    }
  } else {
    timer = setTimeout(trigger, cfg.delaySeconds * 1000);
  }

  /* The trigger may fire while the consent banner is still open, so the wait
     starts when the TRIGGER fires — not when the page loads.
     
     Bounded from page load, a scroll trigger at t=45s found the waiter already
     cleared and the popup never appeared. A reader who scrolls slowly is not a
     reader who declined. */
  var waiter = null;
  function waitForConsent() {
    if (waiter) return;
    var waits = 0;
    waiter = setInterval(function () {
      waits += 1;
      if (shown || waits > 20) { clearInterval(waiter); waiter = null; return; }
      if (pending && consentDecided()) { clearInterval(waiter); waiter = null; show(); }
    }, ${CONSENT_WAIT_MS});
  }
})();`;
}
