import { definePlugin, PLUGIN_HOOKS } from 'astrobaas/core';

/**
 * Popups — one opt-in overlay, on the operator's terms.
 *
 * A plugin rather than a core feature, deliberately: a popup exists to
 * interrupt the reader, and an install that has not asked for one should not
 * carry the code. Deactivating this does not set a flag — `/popup.js` stops
 * being served at all.
 *
 * The behaviour lives in that served file, for the same reason the consent
 * banner's does: the production CSP is hash-based with no `'unsafe-inline'`,
 * so a plugin cannot ship executable code to the browser. What the plugin owns
 * is the styling and the activation.
 *
 * The CSS below is the part that decides whether this is usable or hostile:
 *
 *  - It does NOT cover the page. `inset: auto` with a corner position on
 *    desktop, a bottom sheet on mobile. A reader can keep reading.
 *  - The close control is a real button, full size, with a visible focus ring —
 *    not a 12-pixel grey × in a corner.
 *  - `prefers-reduced-motion` removes the entrance animation, and
 *    `prefers-color-scheme` is honoured, like every other overlay here.
 */
const POPUP_CSS = `/* astrobaas:popups */
.abp{position:fixed;right:1rem;bottom:1rem;left:auto;z-index:9000;
  width:min(24rem,calc(100vw - 2rem));background:#fff;color:#111827;
  border:1px solid #e5e7eb;border-radius:.75rem;
  box-shadow:0 10px 30px rgba(0,0,0,.15);animation:abp-in .18s ease-out}
@keyframes abp-in{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.abp{animation:none}}
.abp-body{padding:1.25rem}
.abp-title{margin:0 0 .35rem;font-size:1.05rem;font-weight:700}
.abp-text{margin:0 0 1rem;font-size:.9rem;line-height:1.5;color:#4b5563}
.abp-actions{display:flex;flex-wrap:wrap;gap:.5rem}
.abp-btn{flex:1 1 auto;min-width:8rem;padding:.6rem 1rem;border-radius:.5rem;
  border:1px solid #d1d5db;background:#fff;color:#111827;
  font-size:.9rem;font-weight:600;cursor:pointer;font-family:inherit;
  text-align:center;text-decoration:none;display:inline-block}
.abp-btn:hover{background:#f9fafb}
.abp-btn:focus-visible{outline:2px solid #2563eb;outline-offset:2px}
.abp-btn-primary{background:#2563eb;border-color:#2563eb;color:#fff}
.abp-btn-primary:hover{background:#1d4ed8}
.abp-input{width:100%;padding:.6rem .75rem;margin:0 0 .6rem;border-radius:.5rem;
  border:1px solid #d1d5db;font-size:.9rem;font-family:inherit}
.abp-note{margin:.6rem 0 0;font-size:.75rem;color:#6b7280}
/* The close control is a full-size button with a focus ring, not a grey speck. */
.abp-close{position:absolute;top:.5rem;right:.5rem;width:2rem;height:2rem;
  border:0;border-radius:.5rem;background:transparent;color:#6b7280;
  font-size:1.1rem;line-height:1;cursor:pointer;font-family:inherit}
.abp-close:hover{background:#f3f4f6;color:#111827}
.abp-close:focus-visible{outline:2px solid #2563eb;outline-offset:2px}
@media (prefers-color-scheme:dark){
  .abp{background:#111827;color:#f9fafb;border-color:#374151}
  .abp-text,.abp-note{color:#9ca3af}
  .abp-btn{background:#1f2937;color:#f9fafb;border-color:#374151}
  .abp-btn:hover{background:#374151}
  .abp-btn-primary{background:#2563eb;border-color:#2563eb;color:#fff}
  .abp-input{background:#1f2937;color:#f9fafb;border-color:#374151}
  .abp-close:hover{background:#1f2937;color:#f9fafb}
}
/* On a phone there is no corner to sit in, so it becomes a bottom sheet —
   still not a full-screen wall. */
@media (max-width:480px){
  .abp{left:.5rem;right:.5rem;bottom:.5rem;width:auto}
  .abp-btn{flex:1 1 100%}
}`;

export default definePlugin({
  id: 'popups',
  name: 'Popups',
  version: '1.0.0',
  description:
    'One opt-in overlay, frequency-capped per browser, never shown to somebody who already signed up or said no. Waits for a consent decision before appearing, never covers the page, and closes on Escape.',
  author: 'AstroBaaS',
  filters: {
    [PLUGIN_HOOKS.PLUGIN_STYLES]: (css: string) => `${css}\n${POPUP_CSS}`,
  },
});
