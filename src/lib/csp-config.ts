/**
 * Content-Security-Policy configuration for Astro's built-in, hash-based CSP
 * (`security.csp` in astro.config). Astro emits a per-page
 * `<meta http-equiv="content-security-policy">` whose `script-src` and
 * `style-src` list the SHA-256 hashes of every script/style it bundles — so we
 * can drop `'unsafe-inline'` for scripts entirely while Astro's own island
 * bootstrap scripts keep working. This module builds the *other* directives
 * (and the extra script/style sources) from the same env knobs we used before.
 *
 * Because Astro computes hashes at build time, this policy is assembled once at
 * build (astro.config reads these). The CSP_* env vars are therefore BUILD-time
 * knobs now (set them before `npm run build`); at runtime the meta tag is fixed.
 *
 * Env knobs (space/comma-separated origin lists, appended to safe defaults):
 *   CSP_IMG_SRC, CSP_FONT_SRC, CSP_CONNECT_SRC, CSP_WORKER_SRC, CSP_FRAME_SRC,
 *   CSP_CHILD_SRC, CSP_SCRIPT_SRC, CSP_STYLE_SRC
 *   CSP_ALLOW_WASM=1 → adds 'wasm-unsafe-eval' to script-src (WASM renderers)
 *
 * Analytics connectors are handled separately and by NAME:
 *
 *   ANALYTICS_PROVIDERS=ga4,meta-pixel
 *
 * That adds exactly the origins those connectors talk to, pulled from the same
 * catalogue the admin and the loader use (lib/analytics.ts). Naming providers
 * rather than pasting origins means the policy cannot drift from what the
 * loader actually requests, and it avoids the usual escape valve of widening
 * script-src to `https:` — which would surrender most of the benefit of having
 * a CSP at all.
 *
 * This is a BUILD-time knob while the tracking IDs are runtime settings, so the
 * two can disagree. The admin reports that case rather than leaving an operator
 * with a saved ID and a tag the browser silently blocks.
 */

import { analyticsCspOrigins } from './analytics';
import { embedFrameOrigins } from './embeds';

function tokens(envVal: string | undefined): string[] {
  if (!envVal) return [];
  return envVal.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
}

const truthy = (v: string | undefined) => v === '1' || v === 'true';

/**
 * Directives OTHER than script-src / style-src (Astro manages those two with
 * hashes). Returned in Astro's `directives` string form, e.g. "default-src 'self'".
 */
/** Provider ids named in ANALYTICS_PROVIDERS. */
export function enabledAnalyticsIds(env: NodeJS.ProcessEnv = process.env): string[] {
  return tokens(env.ANALYTICS_PROVIDERS).map((s) => s.toLowerCase());
}

export function cspDirectives(env: NodeJS.ProcessEnv = process.env): string[] {
  const d: Record<string, string[]> = {
    'default-src': ["'self'"],
    'img-src': ["'self'", 'data:', 'https:'],
    // Self-hosted video. Without this, `media-src` falls back to `default-src
    // 'self'` — which serves an install whose uploads sit on this origin, and
    // silently blocks one that points MEDIA_BASE at a CDN. `img-src` already
    // allows `https:` for exactly that reason, so the two now agree; a video
    // that plays in development and not in production is the worst version of
    // this bug. `blob:` is for a future in-browser preview before upload.
    'media-src': ["'self'", 'https:', 'blob:'],
    'font-src': ["'self'", 'https://fonts.gstatic.com', 'data:'],
    'connect-src': ["'self'"],
    'worker-src': ["'self'", 'blob:'],
    'frame-src': ["'self'"],
    // Who may frame US. Omitted for years on the false premise that Astro
    // emitted a <meta> CSP (where the directive is indeed ignored) — but this
    // project is `output: 'server'`, so the policy is a real header and
    // frame-ancestors is honoured. X-Frame-Options: DENY remains in
    // security-headers.ts for clients that do not read CSP; this is the modern
    // equivalent and is the one that supports an allow-list if a self-hoster
    // ever needs to embed the site.
    'frame-ancestors': ["'none'"],
    // Hardening: no plugins, and lock <base> so an injection can't repoint
    // relative URLs.
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
  };

  const envKey: Record<string, string> = {
    'img-src': 'CSP_IMG_SRC',
    'font-src': 'CSP_FONT_SRC',
    'connect-src': 'CSP_CONNECT_SRC',
    'worker-src': 'CSP_WORKER_SRC',
    'frame-src': 'CSP_FRAME_SRC',
  };
  for (const [name, key] of Object.entries(envKey)) {
    const extra = tokens(env[key]);
    if (extra.length) d[name] = [...(d[name] ?? []), ...extra];
  }

  // Exactly the origins the named connectors use — no wildcards.
  const analytics = analyticsCspOrigins(enabledAnalyticsIds(env));
  if (analytics.connect.length) d['connect-src'] = [...(d['connect-src'] ?? []), ...analytics.connect];
  if (analytics.img.length) d['img-src'] = [...(d['img-src'] ?? []), ...analytics.img];
  if (analytics.frame.length) d['frame-src'] = [...(d['frame-src'] ?? []), ...analytics.frame];
  // Embed providers (C-44). Listed unconditionally rather than only when a
  // post contains one: the header is computed per REQUEST and the content is
  // not known at that point, and a frame-src that appears only on some pages
  // would mean an embed that works on the article and is blocked in the search
  // results. These are three fixed origins, not a wildcard.
  d['frame-src'] = [...(d['frame-src'] ?? []), ...embedFrameOrigins()];

  const child = tokens(env.CSP_CHILD_SRC);
  if (child.length) d['child-src'] = ["'self'", ...child];

  return Object.entries(d).map(([name, srcs]) => `${name} ${Array.from(new Set(srcs)).join(' ')}`);
}

/**
 * Extra `script-src` sources for Astro's `scriptDirective.resources`. Astro
 * always appends its hashes; we must re-include `'self'`. Returns `undefined`
 * when nothing custom is needed, so the caller can omit `scriptDirective` and
 * let Astro use its default `'self'` + hashes.
 */
export function cspScriptResources(env: NodeJS.ProcessEnv = process.env): string[] | undefined {
  const extra = tokens(env.CSP_SCRIPT_SRC);
  if (truthy(env.CSP_ALLOW_WASM)) extra.push("'wasm-unsafe-eval'");
  extra.push(...analyticsCspOrigins(enabledAnalyticsIds(env)).script);
  if (!extra.length) return undefined;
  return Array.from(new Set(["'self'", ...extra]));
}

/**
 * `style-src` sources for Astro's `styleDirective.resources`. Always includes
 * `'self'` + Google Fonts (the default font stylesheet host); Astro appends the
 * style hashes.
 */
export function cspStyleResources(env: NodeJS.ProcessEnv = process.env): string[] {
  return Array.from(new Set(["'self'", 'https://fonts.googleapis.com', ...tokens(env.CSP_STYLE_SRC)]));
}
