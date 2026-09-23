# Building animated & 3D frontends on AstroBaaS

AstroBaaS is a **content backend**. Visual effects — parallax, scroll-float, 3D,
WebGL — live in your **Astro frontend/theme layer**, fed by CMS content. This
separation is deliberate: the CMS stays small and secure (post HTML is
allow-list-sanitized, so `<canvas>`/`<script>` can't live *in* content), while
the frontend has Astro's full power for islands and animation.

There's a working reference at **`/showcase`** (`src/pages/showcase.astro` +
`src/components/showcase/Spinner3D.tsx`): a scroll-parallax hero, float-on-scroll
cards built from published posts, and a React Three Fiber 3D island — every piece
driven by CMS data (settings, posts, active theme colour).

## The pattern

1. **Read content server-side** in a `.astro` page via `astrobaas/core`
   (`LocalDB`) or the REST API, exactly like the blog pages do. `Storage` is the
   *interface* `LocalDB` implements and is exported as a **type only** — import
   it for annotations, never call it.
2. **Render structure as HTML** (zero JS by default).
3. **Add effects in the frontend layer:**
   - **CSS / tiny vanilla JS** for parallax & scroll reveals — no dependencies,
     no integration. (The showcase uses `IntersectionObserver` + a scroll-driven
     CSS custom property.)
   - **Vanilla Three.js / GSAP / Lenis** in a `<script>` — also no integration.
   - **React Three Fiber / interactive React** as an Astro **island** with a
     `client:*` directive — needs the `@astrojs/react` integration (already
     installed).
4. **Pass CMS data into the effect** as props/attributes (e.g. the theme colour
   into the 3D mesh).

```astro
---
import { LocalDB } from 'astrobaas/core';
import Scene from '../components/Scene';     // a React Three Fiber island
const theme = await LocalDB.getActiveTheme();
---
<Scene client:visible color={theme?.settings.colors.primary} />
```

`client:visible` hydrates (and loads the Three.js bundle) only when the element
scrolls into view, so the rest of the page stays fast.

## Loading libraries from a CDN — the CSP

The Content-Security-Policy defaults to `'self'` and will **block** CDN scripts,
external assets, and WASM. Opt origins in per directive via env (see
`.env.example`). Typical 3D setup:

```bash
CSP_SCRIPT_SRC=https://cdn.jsdelivr.net https://unpkg.com
CSP_CONNECT_SRC=https://cdn.jsdelivr.net   # fetching .glb/.hdr/draco assets
CSP_IMG_SRC=https://cdn.example.com        # textures / equirect maps
CSP_ALLOW_WASM=1                           # draco/basis/physics WASM
```

`worker-src 'self' blob:` is already on by default (OffscreenCanvas, draco
workers). Use `CSP_REPORT_ONLY=1` while tuning so violations are logged, not
blocked. Bundling libraries through Vite (npm import) instead of a CDN needs no
CSP change at all — that's the simplest path.

## Accessibility & performance

- **Always honour `prefers-reduced-motion`.** The showcase disables parallax and
  shows content statically when it's set — do the same in every effect.
- **Lazy-hydrate** heavy islands with `client:visible`, not `client:load`.
- **Cap device pixel ratio** for WebGL (`dpr={[1, 2]}`) and dispose geometries
  when components unmount.
- Keep the 3D bundle out of the critical path — it's an island, not the page.

## What lives where

| Concern | Lives in |
| --- | --- |
| Content, structured data, theme tokens | AstroBaaS (this repo) |
| Page layout & markup | `.astro` pages / theme components |
| Parallax, scroll reveals | CSS + small vanilla JS |
| 3D / WebGL / complex interaction | Astro islands (React Three Fiber, or vanilla Three in a script) |
| Which CDNs/assets may load | CSP env vars |

A visual *page-builder* for composing animated sections in the admin is **not**
part of AstroBaaS today — you compose effects in code, the way the `/showcase`
page does.
