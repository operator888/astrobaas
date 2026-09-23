import type { APIRoute } from 'astro';
import { jsonForScript } from '../lib/json-in-html';
import { LocalDB } from '../lib/localdb';
import { corsAllowOrigin } from '../lib/security-headers';
import { publicAssistantConfig, ASSISTANT_LIMITS } from '../lib/ai-assistant';
import { liveAssistantConfig } from '../lib/assistant-runtime';
import { ensurePluginsBootstrapped } from '../plugins';

/**
 * `/assistant-widget.js` — the EMBEDDABLE chat widget for third-party sites.
 *
 * One script tag on any site an operator has allow-listed:
 *
 *   <script src="https://cms.example.com/assistant-widget.js"
 *           data-color="#e11d48" data-position="bottom-left"
 *           data-title="Ask us" data-greeting="Hi there!" defer></script>
 *
 * ## How this differs from /assistant.js
 *
 * `/assistant.js` is the FIRST-PARTY widget for this install's own pages: it
 * shares `/plugins.css` and honours the consent banner. Both are gated on the
 * same switch — the ai-assistant plugin being active — because the endpoint
 * they both talk to is, and a widget that renders while its endpoint refuses
 * is worse than no widget.
 *
 * This one runs on somebody else's site, so none of that is available:
 *
 *  - **Styles are injected, not linked.** An external page never loads
 *    `/plugins.css`. Everything is written into one `<style>` element scoped
 *    under `.abw-*`, so it cannot collide with the host page's CSS.
 *  - **Configuration comes from the script tag**, because the host page has no
 *    other channel. `data-*` attributes are read from `document.currentScript`.
 *  - **The API origin is derived from the script's own src**, so a host page
 *    cannot be tricked into pointing the widget somewhere else by markup alone.
 *  - **Consent is the host site's job.** We do not render a banner on someone
 *    else's domain — that would be presumptuous and would collide with theirs.
 *    `data-require-consent` lets a host defer the widget until their own
 *    consent tool says so.
 *
 * ## CSP friendliness
 *
 * No inline script and no inline style attributes: the file is external, and its
 * CSS goes into a single `<style>` element it creates. A host site with a strict
 * policy needs only `script-src https://cms.example.com` and, for the injected
 * stylesheet, either `style-src 'unsafe-inline'` (common) or the hash printed in
 * the docs. Nothing here uses `eval` or inline handlers.
 *
 * The response carries CORS headers so an allow-listed host can also fetch it
 * with a strict `crossorigin` attribute or from a service worker.
 */
export const prerender = false;

function safeJson(value: unknown): string {
  return jsonForScript(value);
}

export const GET: APIRoute = async ({ request }) => {
  let payload: any = { enabled: false };

  try {
    await LocalDB.init();
    await ensurePluginsBootstrapped();
    // The SAME switch the first-party widget and the chat endpoint obey.
    //
    // This used to resolve the config itself and deliberately skip the
    // plugin-active check, on the reasoning that an embedded install is
    // configured by handing out the script tag and a first-party plugin would
    // be a confusing second switch. That reasoning does not survive the thing
    // it produced: /api/assistant/chat now refuses when the plugin is off — it
    // was proxying anonymous requests to the operator's PAID provider on a
    // feature they had switched off — so a widget served as `enabled: true`
    // here would render a chat box whose every message answers 404.
    //
    // A switch that stops one surface and not the others is worse than a
    // second switch. There is one, it lives in Admin → Plugins, and it governs
    // all three.
    const cfg = await liveAssistantConfig();
    if (cfg) payload = publicAssistantConfig(cfg);
  } catch (err) {
    console.error('[assistant] widget build error:', err);
  }

  const js = `/* AstroBaaS embeddable assistant widget */
(function () {
  'use strict';
  var CFG = ${safeJson(payload)};
  var MAX = ${ASSISTANT_LIMITS.message};

  // Read config + our own origin from the tag that loaded us. Deriving the API
  // base from the script src means the host page cannot repoint the widget at
  // another server through markup alone.
  var tag = document.currentScript;
  if (!tag) {
    var all = document.getElementsByTagName('script');
    for (var i = all.length - 1; i >= 0; i--) {
      if ((all[i].src || '').indexOf('assistant-widget.js') !== -1) { tag = all[i]; break; }
    }
  }
  if (!tag) return;

  var API;
  try { API = new URL(tag.src, location.href).origin; } catch (e) { return; }

  var d = tag.dataset || {};
  var opts = {
    color: d.color || '#2563eb',
    textColor: d.textColor || '#ffffff',
    position: d.position === 'bottom-left' ? 'bottom-left' : 'bottom-right',
    title: d.title || CFG.title || 'Ask us anything',
    greeting: d.greeting || CFG.greeting || 'Hi! How can I help?',
    launcher: d.launcher || '💬',
    zIndex: parseInt(d.zIndex, 10) || 2147483000,
    // Host sites with their own consent tool can defer us until it resolves.
    requireConsent: d.requireConsent === 'true'
  };

  if (!CFG.enabled) return;

  /* ---------------- styles ---------------- */
  // Injected, because an external page does not load our stylesheet. Scoped to
  // .abw-* so it cannot fight the host page's CSS.
  function injectStyles() {
    if (document.getElementById('abw-styles')) return;
    var css = [
      '.abw-root{position:fixed;z-index:' + opts.zIndex + ';display:flex;flex-direction:column;gap:.6rem;',
      '  font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;line-height:1.5}',
      '.abw-br{right:1rem;bottom:1rem;align-items:flex-end}',
      '.abw-bl{left:1rem;bottom:1rem;align-items:flex-start}',
      '.abw-launch{width:3.25rem;height:3.25rem;border-radius:999px;border:none;cursor:pointer;',
      '  font-size:1.4rem;line-height:1;box-shadow:0 6px 20px rgba(0,0,0,.22);',
      '  background:' + opts.color + ';color:' + opts.textColor + ';transition:transform .15s ease}',
      '.abw-launch:hover{transform:scale(1.06)}',
      '.abw-launch:focus-visible{outline:2px solid #111;outline-offset:3px}',
      '.abw-panel{display:none;flex-direction:column;width:min(23rem,calc(100vw - 2rem));',
      '  height:min(30rem,calc(100vh - 8rem));background:#fff;color:#111827;',
      '  border:1px solid #e5e7eb;border-radius:.9rem;overflow:hidden;box-shadow:0 16px 44px rgba(0,0,0,.2)}',
      '.abw-panel.abw-open{display:flex}',
      '.abw-head{display:flex;align-items:center;justify-content:space-between;gap:.5rem;',
      '  padding:.75rem 1rem;background:' + opts.color + ';color:' + opts.textColor + '}',
      '.abw-title{font-weight:650;font-size:.95rem}',
      '.abw-x{border:none;background:none;font-size:1.35rem;line-height:1;cursor:pointer;',
      '  color:inherit;opacity:.85;padding:0 .25rem}',
      '.abw-x:hover{opacity:1}',
      '.abw-list{flex:1;overflow-y:auto;padding:1rem;display:flex;flex-direction:column;gap:.6rem;background:#fff}',
      '.abw-row{display:flex;max-width:85%}',
      '.abw-sent{align-self:flex-end;justify-content:flex-end}',
      '.abw-received{align-self:flex-start}',
      '.abw-msg{padding:.55rem .85rem;border-radius:.85rem;font-size:.88rem;',
      '  white-space:pre-wrap;overflow-wrap:anywhere}',
      '.abw-sent .abw-msg{background:' + opts.color + ';color:' + opts.textColor + ';border-bottom-right-radius:.25rem}',
      '.abw-received .abw-msg{background:#f3f4f6;color:#111827;border-bottom-left-radius:.25rem}',
      '.abw-load{display:flex;gap:.25rem;align-items:center}',
      '.abw-dot{width:.4rem;height:.4rem;border-radius:999px;background:#9ca3af;animation:abw-b 1.2s infinite ease-in-out}',
      '.abw-dot:nth-child(2){animation-delay:.18s}.abw-dot:nth-child(3){animation-delay:.36s}',
      '@keyframes abw-b{0%,80%,100%{opacity:.3}40%{opacity:1}}',
      '@media (prefers-reduced-motion:reduce){.abw-dot{animation:none;opacity:.6}.abw-launch{transition:none}}',
      '.abw-form{display:flex;gap:.5rem;padding:.75rem;border-top:1px solid #f3f4f6;background:#fff}',
      '.abw-input{flex:1;padding:.55rem .75rem;border:1px solid #d1d5db;border-radius:.6rem;',
      '  font-size:.88rem;font-family:inherit;color:#111827;background:#fff}',
      '.abw-send{padding:.55rem .9rem;border-radius:.6rem;border:none;cursor:pointer;',
      '  font-size:.85rem;font-weight:600;font-family:inherit;',
      '  background:' + opts.color + ';color:' + opts.textColor + '}',
      '.abw-send:disabled{opacity:.55;cursor:default}'
    ].join('');
    var st = document.createElement('style');
    st.id = 'abw-styles';
    st.textContent = css;
    document.head.appendChild(st);
  }

  /* ---------------- widget ---------------- */
  var history = [], open = false, busy = false;
  var root, panel, list, input, sendBtn;

  function el(t, c, txt) {
    var e = document.createElement(t);
    if (c) e.className = c;
    // textContent everywhere: replies are model output, and this runs inside
    // somebody else's page.
    if (txt != null) e.textContent = txt;
    return e;
  }

  function bubble(kind, text, loading) {
    var row = el('div', 'abw-row abw-' + kind);
    var msg = el('div', 'abw-msg');
    if (loading) {
      msg.className += ' abw-load';
      for (var i = 0; i < 3; i++) msg.appendChild(el('span', 'abw-dot'));
    } else msg.textContent = text;
    row.appendChild(msg);
    return row;
  }

  function add(kind, text) { list.appendChild(bubble(kind, text)); list.scrollTop = list.scrollHeight; }

  async function send() {
    var text = input.value.trim();
    if (!text || busy) return;
    if (text.length > MAX) { alert('Message is too long.'); return; }
    input.value = '';
    add('sent', text);
    busy = true; sendBtn.disabled = true;
    var pending = bubble('received', '', true);
    list.appendChild(pending); list.scrollTop = list.scrollHeight;

    try {
      // credentials:'omit' is deliberate and load-bearing: a cookie-less
      // cross-origin POST carries no ambient authority, which is exactly why
      // the server may skip the CSRF check for an allow-listed origin.
      var res = await fetch(API + '/api/assistant/chat', {
        method: 'POST',
        mode: 'cors',
        credentials: 'omit',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, history: history })
      });
      var json = await res.json().catch(function () { return null; });
      pending.remove();
      if (res.ok && json && json.success && json.data && json.data.reply) {
        add('received', json.data.reply);
        history.push({ role: 'user', content: text });
        history.push({ role: 'assistant', content: json.data.reply });
        if (history.length > 20) history = history.slice(-20);
      } else {
        add('received', (json && json.error && json.error.message) || 'Sorry — I could not answer just now.');
      }
    } catch (e) {
      pending.remove();
      add('received', 'Sorry — I could not reach the assistant.');
    } finally {
      busy = false; sendBtn.disabled = false; input.focus();
    }
  }

  function build() {
    panel = el('div', 'abw-panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', opts.title);

    var head = el('div', 'abw-head');
    head.appendChild(el('span', 'abw-title', opts.title));
    var x = el('button', 'abw-x', '×');
    x.type = 'button';
    x.setAttribute('aria-label', 'Close chat');
    x.addEventListener('click', toggle);
    head.appendChild(x);

    list = el('div', 'abw-list');
    list.setAttribute('aria-live', 'polite');

    var form = el('form', 'abw-form');
    input = el('input', 'abw-input');
    input.type = 'text'; input.placeholder = 'Type a message…';
    input.maxLength = MAX; input.setAttribute('aria-label', 'Message');
    sendBtn = el('button', 'abw-send', 'Send');
    sendBtn.type = 'submit';
    form.addEventListener('submit', function (e) { e.preventDefault(); send(); });
    form.appendChild(input); form.appendChild(sendBtn);

    panel.appendChild(head); panel.appendChild(list); panel.appendChild(form);
    root.appendChild(panel);
    add('received', opts.greeting);
  }

  function toggle() {
    open = !open;
    if (open && !panel) build();
    if (panel) panel.classList.toggle('abw-open', open);
    root.querySelector('.abw-launch').setAttribute('aria-expanded', String(open));
    if (open && input) input.focus();
  }

  function mount() {
    if (document.querySelector('.abw-root')) return;
    injectStyles();
    root = el('div', 'abw-root ' + (opts.position === 'bottom-left' ? 'abw-bl' : 'abw-br'));
    var b = el('button', 'abw-launch', opts.launcher);
    b.type = 'button';
    b.setAttribute('aria-label', opts.title);
    b.setAttribute('aria-expanded', 'false');
    b.addEventListener('click', toggle);
    root.appendChild(b);
    document.body.appendChild(root);
  }

  // Public API so a host site can drive us from its own consent tool.
  window.AstroBaaSAssistant = {
    mount: mount,
    open: function () { if (!document.querySelector('.abw-root')) mount(); if (!open) toggle(); },
    close: function () { if (open) toggle(); },
    destroy: function () {
      var r = document.querySelector('.abw-root');
      if (r) r.remove();
      panel = null; open = false;
    }
  };

  function start() { if (!opts.requireConsent) mount(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
`;

  const origin = corsAllowOrigin(request.headers.get('origin'));
  return new Response(js, {
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      // Settings-driven, so never let a shared cache serve one site's config to
      // another. Hosts embed by URL, not by cached bundle.
      'Cache-Control': 'no-store',
      ...(origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}),
    },
  });
};
