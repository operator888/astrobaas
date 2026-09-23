import type { APIRoute } from 'astro';
import { jsonForScript } from '../lib/json-in-html';
import { LocalDB } from '../lib/localdb';
import { ensurePluginsBootstrapped } from '../plugins';
import { publicAssistantConfig, ASSISTANT_LIMITS } from '../lib/ai-assistant';
import { liveAssistantConfig } from '../lib/assistant-runtime';

/**
 * `/assistant.js` — the chat-bubble widget.
 *
 * Served rather than inlined for the usual reason: the production CSP is
 * hash-based with no `'unsafe-inline'`, so per-request inline script is silently
 * dropped. Same-origin `script-src 'self'` covers this file.
 *
 * The payload contains ONLY what a visitor may see — title, greeting, and the
 * consent category. The API key, base URL, model and system prompt stay on the
 * server; `publicAssistantConfig()` is the single place that decides, so no
 * call site has to remember to strip anything.
 *
 * The bubble follows the sent/received pattern of a normal chat UI (the shape
 * of the reference implementation this was modelled on), rebuilt with plain DOM
 * because AstroBaaS ships no React on public pages and a widget is not worth a
 * hydration boundary.
 */
export const prerender = false;

function safeJson(value: unknown): string {
  return jsonForScript(value);
}

export const GET: APIRoute = async () => {
  let payload: any = { enabled: false };

  try {
    await LocalDB.init();
    await ensurePluginsBootstrapped();

    // Same rule BaseLayout uses to decide whether to link this file at all, so
    // the tag and the payload cannot disagree about whether the assistant is on.
    const cfg = await liveAssistantConfig();
    if (cfg) payload = publicAssistantConfig(cfg);
  } catch (err) {
    console.error('assistant.js build error:', err);
  }

  const js = `/* AstroBaaS AI assistant widget */
(function () {
  'use strict';
  var CFG = ${safeJson(payload)};
  if (!CFG.enabled) return;
  var MAX = ${ASSISTANT_LIMITS.message};

  /** Consent gate: the widget stores a conversation, so it waits like any
   *  other non-essential feature. If the consent script is absent entirely we
   *  fail CLOSED and never render. */
  function allowed() {
    var c = window.astrobaasConsent;
    if (!c || typeof c.has !== 'function') return false;
    return c.has(CFG.consentCategory);
  }

  var history = [];
  var open = false;
  var busy = false;
  var root, panel, list, input, sendBtn;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    // textContent throughout: replies are model output and must never be
    // parsed as HTML.
    if (text != null) e.textContent = text;
    return e;
  }

  function bubble(role, text, loading) {
    var row = el('div', 'aba-row aba-' + role);
    var msg = el('div', 'aba-msg');
    if (loading) {
      msg.classList.add('aba-loading');
      for (var i = 0; i < 3; i++) msg.appendChild(el('span', 'aba-dot'));
    } else {
      msg.textContent = text;
    }
    row.appendChild(msg);
    return row;
  }

  function scrollDown() { list.scrollTop = list.scrollHeight; }

  function addMessage(role, text) {
    list.appendChild(bubble(role, text));
    scrollDown();
  }

  async function send() {
    var text = input.value.trim();
    if (!text || busy) return;
    if (text.length > MAX) return alert('Message is too long.');

    input.value = '';
    addMessage('sent', text);
    busy = true;
    sendBtn.disabled = true;

    var pending = bubble('received', '', true);
    list.appendChild(pending);
    scrollDown();

    try {
      var res = await fetch('/api/assistant/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, history: history })
      });
      var json = await res.json().catch(function () { return null; });
      pending.remove();
      if (res.ok && json && json.success && json.data && json.data.reply) {
        addMessage('received', json.data.reply);
        history.push({ role: 'user', content: text });
        history.push({ role: 'assistant', content: json.data.reply });
        // Bound what we send back next turn; the server caps it too.
        if (history.length > 20) history = history.slice(-20);
      } else {
        addMessage('received', (json && json.error && json.error.message) || 'Sorry — I could not answer just now.');
      }
    } catch (e) {
      pending.remove();
      addMessage('received', 'Sorry — I could not reach the assistant.');
    } finally {
      busy = false;
      sendBtn.disabled = false;
      input.focus();
    }
  }

  function buildPanel() {
    panel = el('div', 'aba-panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', CFG.title);

    var head = el('div', 'aba-head');
    head.appendChild(el('span', 'aba-title', CFG.title));
    var close = el('button', 'aba-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close chat');
    close.addEventListener('click', toggle);
    head.appendChild(close);

    list = el('div', 'aba-list');
    list.setAttribute('aria-live', 'polite');

    var form = el('form', 'aba-form');
    input = el('input', 'aba-input');
    input.type = 'text';
    input.placeholder = 'Type a message…';
    input.maxLength = MAX;
    input.setAttribute('aria-label', 'Message');
    sendBtn = el('button', 'aba-send', 'Send');
    sendBtn.type = 'submit';
    form.addEventListener('submit', function (e) { e.preventDefault(); send(); });
    form.appendChild(input);
    form.appendChild(sendBtn);

    panel.appendChild(head);
    panel.appendChild(list);
    panel.appendChild(form);
    root.appendChild(panel);

    addMessage('received', CFG.greeting);
  }

  function toggle() {
    open = !open;
    if (open && !panel) buildPanel();
    if (panel) panel.classList.toggle('aba-open', open);
    root.querySelector('.aba-bubble').setAttribute('aria-expanded', String(open));
    if (open && input) input.focus();
  }

  function mount() {
    if (!allowed()) return;
    if (document.querySelector('.aba-root')) return;
    root = el('div', 'aba-root');
    var b = el('button', 'aba-bubble');
    b.type = 'button';
    b.setAttribute('aria-label', CFG.title);
    b.setAttribute('aria-expanded', 'false');
    b.textContent = '💬';
    b.addEventListener('click', toggle);
    root.appendChild(b);
    document.body.appendChild(root);
  }

  function start() {
    mount();
    // Consent may be granted after load; mount then without a reload.
    document.addEventListener('click', function () {
      if (!document.querySelector('.aba-root')) mount();
    }, { passive: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
`;

  return new Response(js, {
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
};
