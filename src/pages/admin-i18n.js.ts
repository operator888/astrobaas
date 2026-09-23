import type { APIRoute } from 'astro';
import crypto from 'node:crypto';
import { registerBundledCatalogues, BUNDLED_CATALOGUES } from '../locales';
import { BASE_LOCALE } from '../lib/i18n/translate';
import { locales } from '../lib/i18n';

/**
 * The admin's message catalogue, for code that runs in the BROWSER.
 *
 * About a third of the admin's strings live inside `<script>` blocks — toasts,
 * `confirm()` text, labels for rows built in the DOM — so a server-only
 * translator would leave a third of the interface in English no matter how
 * complete the catalogues were.
 *
 * ## Why a separate request instead of inlining it
 *
 * Inlining ~30 KB of JSON into every admin page costs that on every navigation
 * and cannot be cached. This is served once per locale, immutable, and every
 * subsequent page load reads it from the browser cache.
 *
 * The URL carries a content HASH, so a deploy that changes a message busts the
 * cache exactly and nothing else does. Without that, `immutable` would mean a
 * staff member kept seeing last week's labels.
 *
 * ## Why it is public
 *
 * These are UI labels for a login screen and an admin shell — the same words
 * anyone sees in the product's screenshots. No shop data passes through here,
 * which is what lets it be cached by a CDN and shared between staff.
 */
export const prerender = false;

registerBundledCatalogues();

/** Only `admin.*`. A storefront string must not inflate an admin page. */
function adminSubset(locale: string): Record<string, string> {
  const cat = BUNDLED_CATALOGUES[locale] ?? {};
  const base = BUNDLED_CATALOGUES[BASE_LOCALE] ?? {};
  const out: Record<string, string> = {};
  // Base first, then the locale on top: a key the locale has not translated
  // falls back to English rather than vanishing from the browser bundle.
  for (const [k, v] of Object.entries(base)) if (k.startsWith('admin.')) out[k] = v;
  for (const [k, v] of Object.entries(cat)) if (k.startsWith('admin.')) out[k] = v;
  return out;
}

const hashes = new Map<string, string>();
export function catalogueHash(locale: string): string {
  const cached = hashes.get(locale);
  if (cached) return cached;
  const h = crypto.createHash('sha256')
    .update(JSON.stringify(adminSubset(locale)))
    .digest('base64url')
    .slice(0, 12);
  hashes.set(locale, h);
  return h;
}

export const GET: APIRoute = async ({ url }) => {
  const asked = String(url.searchParams.get('locale') ?? '').trim().toLowerCase();
  // Serve only a locale this site offers AND has a catalogue for. An arbitrary
  // query value must not decide what gets built and hashed.
  const locale = locales().includes(asked) && BUNDLED_CATALOGUES[asked] ? asked : BASE_LOCALE;

  const messages = adminSubset(locale);
  const body = `(function(){
var M=${JSON.stringify(messages)};
window.__ASTROBAAS_I18N__={locale:${JSON.stringify(locale)},messages:M};
window.t=function(k,p){
  var s=M[k];
  if(typeof s!=='string'){return k;}
  if(!p){return s;}
  return s.replace(/\\{(\\w+)\\}/g,function(w,n){return p[n]==null?w:String(p[n]);});
};
})();`;

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      // Safe because the URL carries a content hash — a changed message is a
      // different URL. Without the hash this would strand staff on old labels.
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
};
