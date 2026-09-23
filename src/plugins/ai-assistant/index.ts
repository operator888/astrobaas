import { definePlugin, PLUGIN_HOOKS } from 'astrobaas/core';

/**
 * AI Assistant — a chat bubble on every public page, backed by the operator's
 * own AI provider.
 *
 * Configure under **Settings → AI assistant**: provider, API key, model, and
 * optionally an OpenAI Assistant id, a title, a greeting, and a system prompt.
 *
 * Architecture, and why it is not the obvious one:
 *
 *  - The widget NEVER holds the API key. It posts to `/api/assistant/chat` on
 *    this origin and the server forwards the request. A widget that called the
 *    provider directly would ship the operator's key to every visitor, and a
 *    leaked key bills the operator until somebody notices.
 *  - The behaviour lives in the served `/assistant.js`, not in this plugin,
 *    because a plugin cannot ship executable script under the hash-based CSP.
 *  - The bubble waits for **preferences** consent, so it does not store a
 *    conversation before the visitor has agreed to anything. If the consent
 *    script is missing entirely it fails closed and never renders.
 *
 * The CSS below is the plugin's actual contribution: it is served through
 * `/plugins.css`, which satisfies `style-src 'self'`.
 */
const ASSISTANT_CSS = `/* astrobaas:ai-assistant */
.aba-root{position:fixed;right:1rem;bottom:1rem;z-index:9997;
  font-family:inherit;display:flex;flex-direction:column;align-items:flex-end;gap:.6rem}
.aba-bubble{width:3.25rem;height:3.25rem;border-radius:999px;border:none;cursor:pointer;
  background:var(--primary-color,#2563eb);color:#fff;font-size:1.4rem;line-height:1;
  box-shadow:0 6px 20px rgba(0,0,0,.22);transition:transform .15s ease}
.aba-bubble:hover{transform:scale(1.06)}
.aba-bubble:focus-visible{outline:2px solid #111827;outline-offset:3px}
.aba-panel{display:none;flex-direction:column;width:min(23rem,calc(100vw - 2rem));
  height:min(30rem,calc(100vh - 8rem));background:#fff;color:#111827;
  border:1px solid #e5e7eb;border-radius:.9rem;overflow:hidden;
  box-shadow:0 16px 44px rgba(0,0,0,.2)}
.aba-panel.aba-open{display:flex}
.aba-head{display:flex;align-items:center;justify-content:space-between;gap:.5rem;
  padding:.75rem 1rem;border-bottom:1px solid #f3f4f6}
.aba-title{font-weight:650;font-size:.95rem}
.aba-close{border:none;background:none;font-size:1.35rem;line-height:1;cursor:pointer;
  color:#6b7280;padding:0 .25rem}
.aba-close:hover{color:#111827}
.aba-list{flex:1;overflow-y:auto;padding:1rem;display:flex;flex-direction:column;gap:.6rem}
.aba-row{display:flex;max-width:85%}
/* sent / received, the standard chat-bubble split */
.aba-sent{align-self:flex-end;justify-content:flex-end}
.aba-received{align-self:flex-start}
.aba-msg{padding:.55rem .85rem;border-radius:.85rem;font-size:.88rem;line-height:1.45;
  white-space:pre-wrap;overflow-wrap:anywhere}
.aba-sent .aba-msg{background:var(--primary-color,#2563eb);color:#fff;border-bottom-right-radius:.25rem}
.aba-received .aba-msg{background:#f3f4f6;color:#111827;border-bottom-left-radius:.25rem}
.aba-loading{display:flex;gap:.25rem;align-items:center}
.aba-dot{width:.4rem;height:.4rem;border-radius:999px;background:#9ca3af;
  animation:aba-blink 1.2s infinite ease-in-out}
.aba-dot:nth-child(2){animation-delay:.18s}
.aba-dot:nth-child(3){animation-delay:.36s}
@keyframes aba-blink{0%,80%,100%{opacity:.3}40%{opacity:1}}
@media (prefers-reduced-motion:reduce){.aba-dot{animation:none;opacity:.6}.aba-bubble{transition:none}}
.aba-form{display:flex;gap:.5rem;padding:.75rem;border-top:1px solid #f3f4f6}
.aba-input{flex:1;padding:.55rem .75rem;border:1px solid #d1d5db;border-radius:.6rem;
  font-size:.88rem;font-family:inherit;color:inherit;background:#fff}
.aba-input:focus-visible{outline:2px solid var(--primary-color,#2563eb);outline-offset:-1px}
.aba-send{padding:.55rem .9rem;border-radius:.6rem;border:none;cursor:pointer;
  background:var(--primary-color,#2563eb);color:#fff;font-size:.85rem;font-weight:600;font-family:inherit}
.aba-send:disabled{opacity:.55;cursor:default}
@media (prefers-color-scheme:dark){
  .aba-panel{background:#111827;color:#f9fafb;border-color:#374151}
  .aba-head,.aba-form{border-color:#1f2937}
  .aba-received .aba-msg{background:#1f2937;color:#f9fafb}
  .aba-input{background:#1f2937;border-color:#374151;color:#f9fafb}
  .aba-close{color:#9ca3af}
}`;

export default definePlugin({
  id: 'ai-assistant',
  name: 'AI Assistant',
  version: '1.0.0',
  description:
    'A chat bubble on every public page, backed by your own OpenAI/Anthropic/compatible key. The key stays server-side; the widget talks to a proxy on your own origin.',
  author: 'AstroBaaS',
  filters: {
    [PLUGIN_HOOKS.PLUGIN_STYLES]: (css: string) => `${css}\n${ASSISTANT_CSS}`,
  },
});
