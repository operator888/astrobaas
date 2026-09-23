import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import node from '@astrojs/node';
import react from '@astrojs/react';
import { cspDirectives, cspScriptResources, cspStyleResources } from './src/lib/csp-config';
import { stripBuiltUploadsIntegration } from './src/lib/strip-built-uploads';

const scriptResources = cspScriptResources(process.env);

export default defineConfig({
  // React enables interactive islands for 3D (React Three Fiber) and other
  // client components. Vanilla Three.js/GSAP/Lenis need no integration — use a
  // plain <script> island. Astro stays zero-JS by default; only `client:*`
  // components ship JS.
  integrations: [react(), stripBuiltUploadsIntegration()],
  // Tailwind v4 ships as a Vite plugin (the old @astrojs/tailwind integration
  // was removed for Astro 6).
  vite: {
    plugins: [tailwindcss()],
  },
  output: 'server',
  adapter: node({
    mode: 'standalone',
  }),
  // Pinned, not defaulted. Astro 7 changed the default to 'jsx', which strips
  // whitespace BETWEEN inline elements — `<span>a</span> <em>b</em>` renders as
  // "ab". For a CMS that is a content corruption, not a formatting preference,
  // and it would have landed silently on two live shops. `true` is the Astro 6
  // behaviour: compress, but keep whitespace that is semantically meaningful.
  compressHTML: true,
  security: {
    // We enforce our own double-submit CSRF token in src/middleware.ts (covering
    // JSON, form, and the public contact/newsletter POSTs). Astro's built-in
    // Origin check (default-on since 4.9) is redundant and rejects legitimate
    // same-origin form/API posts that don't send an Origin header, so disable it.
    checkOrigin: false,
    // Hash-based Content-Security-Policy. With `output: 'server'` above, Astro
    // sends this as a real response HEADER on every on-demand page (the <meta>
    // form is only used for prerendered pages). An earlier comment here claimed
    // the opposite and that error cost us `frame-ancestors`; see
    // src/lib/security-headers.ts for the verification.
    //
    // Its
    // script-src/style-src carry the SHA-256 hashes of every script/style it
    // bundles — so script-src is `'self'` + hashes with NO 'unsafe-inline'
    // (removing the main XSS foothold) while Astro's own island-hydration inline
    // scripts still run. The remaining directives + extra sources come from
    // src/lib/csp-config.ts (env-configurable at build time). This replaces the
    // hand-written response-header CSP, which couldn't hash Astro's inlined scripts.
    csp: {
      directives: cspDirectives(process.env),
      styleDirective: { resources: cspStyleResources(process.env) },
      ...(scriptResources ? { scriptDirective: { resources: scriptResources } } : {}),
    },
  },
  markdown: {
    // Shiki (the default) highlights by emitting INLINE styles, which our
    // hash-based CSP blocks — Astro 7 warns about exactly this combination at
    // build time. Nothing renders through Astro's markdown pipeline today
    // (scripts/import-md.mjs converts to HTML at import time and stores HTML),
    // so this changes no current output. It is set so that the first person who
    // adds a .md page gets a code block that is styleable rather than one the
    // browser silently refuses to paint.
    syntaxHighlight: 'prism',
  },
  // Used for absolute URLs in sitemap.xml / rss.xml / OG tags. Set SITE_URL in
  // production (e.g. https://cms.example.com); falls back to localhost in dev.
  site: process.env.SITE_URL || 'http://localhost:4321',
});
