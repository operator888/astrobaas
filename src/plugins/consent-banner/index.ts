import { definePlugin, PLUGIN_HOOKS } from 'astrobaas/core';

/**
 * Consent Banner — granular, prior-consent cookie control.
 *
 * The plugin owns the *styling and activation*; the behaviour lives in the
 * served `/consent.js` (a plugin cannot ship executable code to the browser
 * under the hash-based CSP, and the consent logic must be one file with the
 * analytics loader so nothing can fire before a choice is made).
 *
 * Activate this plugin and the banner appears. Deactivate it and no banner
 * shows — and because the loader treats "no record" as consent to nothing,
 * turning the banner off does not silently switch trackers on. It switches
 * them off, which is the correct failing direction.
 *
 * The CSS below is the compliance-relevant part, not decoration:
 *
 *  - "Reject optional" and "Accept all" are the same size, weight, and
 *    prominence. Regulators have repeatedly fined banners where refusing was
 *    visually subordinate to accepting.
 *  - The banner does not cover the page or trap focus. A consent request that
 *    blocks access until you agree is not freely given consent.
 *  - The reopener stays available so withdrawing is as easy as granting.
 *  - Respects `prefers-reduced-motion` and `prefers-color-scheme`.
 */
const CONSENT_CSS = `/* astrobaas:consent-banner */
.abc-banner{position:fixed;left:1rem;right:1rem;bottom:1rem;z-index:9999;
  max-width:44rem;margin:0 auto;background:#fff;color:#111827;
  border:1px solid #e5e7eb;border-radius:.75rem;
  box-shadow:0 10px 30px rgba(0,0,0,.15);animation:abc-in .18s ease-out}
@keyframes abc-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.abc-banner{animation:none}}
.abc-body{padding:1.25rem}
.abc-title{margin:0 0 .35rem;font-size:1.05rem;font-weight:700}
.abc-text{margin:0 0 1rem;font-size:.9rem;line-height:1.5;color:#4b5563}
.abc-detail{margin:0 0 1rem;border-top:1px solid #f3f4f6;padding-top:.75rem}
.abc-row{display:flex;gap:.6rem;align-items:flex-start;padding:.5rem 0;cursor:pointer}
.abc-check{margin-top:.2rem;width:1rem;height:1rem;flex:0 0 auto}
.abc-rowtext{display:flex;flex-direction:column;gap:.15rem;font-size:.85rem}
.abc-desc{color:#6b7280;line-height:1.45}
.abc-actions{display:flex;flex-wrap:wrap;gap:.5rem}
/* Equal weight: refusing must be exactly as easy as accepting. */
.abc-btn{flex:1 1 auto;min-width:9rem;padding:.6rem 1rem;border-radius:.5rem;
  border:1px solid #d1d5db;background:#fff;color:#111827;
  font-size:.9rem;font-weight:600;cursor:pointer;font-family:inherit}
.abc-btn:hover{background:#f9fafb}
.abc-btn:focus-visible{outline:2px solid #2563eb;outline-offset:2px}
.abc-btn-primary{background:#2563eb;border-color:#2563eb;color:#fff}
.abc-btn-primary:hover{background:#1d4ed8}
.abc-btn-ghost{flex:0 1 auto;min-width:7rem}
.abc-reopen{position:fixed;left:1rem;bottom:1rem;z-index:9998;
  padding:.4rem .75rem;border-radius:999px;border:1px solid #d1d5db;
  background:#fff;color:#4b5563;font-size:.75rem;cursor:pointer;
  font-family:inherit;opacity:.75}
.abc-reopen:hover{opacity:1}
.abc-reopen:focus-visible{outline:2px solid #2563eb;outline-offset:2px}
@media (prefers-color-scheme:dark){
  .abc-banner{background:#111827;color:#f9fafb;border-color:#374151}
  .abc-text,.abc-desc{color:#9ca3af}
  .abc-detail{border-top-color:#1f2937}
  .abc-btn{background:#1f2937;color:#f9fafb;border-color:#374151}
  .abc-btn:hover{background:#374151}
  .abc-btn-primary{background:#2563eb;border-color:#2563eb;color:#fff}
  .abc-reopen{background:#1f2937;color:#9ca3af;border-color:#374151}
}
@media (max-width:480px){.abc-btn{flex:1 1 100%}}`;

export default definePlugin({
  id: 'consent-banner',
  name: 'Consent Banner',
  version: '1.0.0',
  description:
    'Granular GDPR/ePrivacy cookie consent: prior opt-in, per-category choice, refusing as easy as accepting, and withdrawable at any time. Gates the analytics connectors.',
  author: 'AstroBaaS',
  filters: {
    [PLUGIN_HOOKS.PLUGIN_STYLES]: (css: string) => `${css}\n${CONSENT_CSS}`,
  },
});
