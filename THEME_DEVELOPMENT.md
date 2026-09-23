# Theme development

A theme controls how the public site **looks** and, since template slots landed,
how it is **structured**. Themes come in two strengths (and ship in three ways —
see below):

| | **Tokens-only theme** | **Template theme** |
|---|---|---|
| Changes | colors, typography, custom CSS | markup + colors + typography |
| Written as | a `defineTheme({...})` module with no `components` | the same, plus `.astro` overrides |
| Effort | minutes | as much as you want |

Both are **build-time modules**, like code plugins: Astro compiles the server, so
themes are explicit imports, not uploads. Markup is deliberately not installable
at runtime — see [the extensibility model](./README.md#extensibility-model).

---

## Three ways to ship a theme

|  | Declarative (`theme.json`) | External (`ASTROBAAS_THEMES`) | Bundled (`defineTheme`) |
| --- | --- | --- | --- |
| Install | Paste JSON into Admin → Themes, or `POST /api/themes/install`. No rebuild. | `npm i @someone/theme-x`, name it in `ASTROBAAS_THEMES`, restart. | Add `src/themes/<id>/`, one import in `src/themes/index.ts`, redeploy. |
| Tokens | ✅ | ✅ | ✅ |
| Stylesheet | ✅ | ✅ | ✅ |
| Patterns | ✅ | ✅ | ✅ |
| Replace slots (components) | ❌ | ✅ | ✅ |

Start declarative. It covers colour, type, shape, a stylesheet and ready-made
page layouts, which is most of what a theme is — and it installs on a running
site without a deploy. Reach for the other two when you need to change the page
*structure*, which needs real components and therefore a build.

### The external tier (`ASTROBAAS_THEMES`)

A comma-separated list of module specifiers, each default-exporting a theme, an
array of themes, or a **factory** `({ defineTheme, apiVersion }) => theme` —
deliberately the same shape as `ASTROBAAS_PLUGINS`, and for the same reason: an
external module cannot resolve `astrobaas/core` (inside this repo that is a
tsconfig path alias, and in a deployed install there is no such package), so the
factory hands it *this* host's `defineTheme`.

**An external theme may carry components, and a declarative manifest may not.**
That is not an inconsistency: a manifest is data an admin installs through the
browser at runtime, while a module named in the environment is code the operator
put on the server on purpose — the same line `ASTROBAAS_PLUGINS` already draws.

A theme that will not load is logged with its specifier and its reason and the
site renders with the stock look; boot continues. A module may not claim a
bundled id, so a package exporting a theme called `default` cannot quietly
replace the stock look. See [`src/themes/external.ts`](./src/themes/external.ts).

### A declarative theme

```json
{
  "id": "sunset",
  "name": "Sunset",
  "version": "1.0.0",
  "author": "You",
  "tokens": {
    "colors": { "primary": "#e2571e", "secondary": "#8b1e3f" },
    "style": { "radius": "lg", "density": "roomy" },
    "colorScheme": "auto"
  },
  "css": ".ab-hero { background: linear-gradient(var(--primary-color), var(--secondary-color)); }",
  "screenshot": "/uploads/sunset-preview.png",
  "patterns": [
    {
      "name": "splash",
      "label": "Splash",
      "description": "Full-bleed hero.",
      "html": "<div class=\"ab-hero ab-align-center\"><h2>Headline</h2></div>"
    }
  ]
}
```

Five rules, all enforced at install rather than discovered on a live site:

1. **Colours must be hex.** Token values are written into `/theme.css` as
   `--primary-color: <value>`, so a value carrying `;` or `}` would escape the
   declaration and become arbitrary CSS. A stored value may *select* CSS; it may
   never *be* CSS.
2. **`style` values must be token KEYS**, not CSS. `"radius": "lg"` — not
   `"14px"`. The key names a pre-authored block; the raw value is refused.
3. **Every pattern must survive the content sanitizer byte-for-byte.** One that
   does not is refused, and the response shows your markup next to what the
   sanitizer returned, so you can see exactly what was dropped.
4. **`css` is filtered but NOT namespace-scoped.** Unlike a plugin, restyling
   the whole site is your job. `@import`, `</style>` escapes and `javascript:`
   URLs are removed; anything over 100 KB is refused whole rather than truncated
   (a cut inside `@media (…) {` swallows every rule after it).
5. **`screenshot`, if present, must be a `data:` image URI (png, jpeg, webp or
   svg+xml) or a root-relative path**, and under 200 KB — it has to fit in a
   settings-sized value. Anything else is refused.

Your tokens are the theme's *defaults*. Once installed, the operator's
customizations win — and upgrading to a new version keeps them, because a
version bump silently reverting someone's colours is the theme equivalent of
overwriting their content.

Uninstalling is refused while the theme is active: activate something else
first, so the replacement is the operator's choice rather than ours.

## Anatomy

```
src/themes/<your-id>/
  index.ts          # defineTheme({...}) — required
  Header.astro      # optional slot overrides
  PostCard.astro
```

```ts
// src/themes/my-theme/index.ts
import { defineTheme } from 'astrobaas/core';
import Header from './Header.astro';
import PostCard from './PostCard.astro';

export default defineTheme({
  id: 'my-theme',                 // stable, kebab-case, unique
  name: 'My Theme',
  description: 'What it looks like.',
  version: '1.0.0',
  author: 'You',
  settings: {                     // DEFAULT tokens (operators can customize)
    colors: { primary: '#111827', secondary: '#6B7280', accent: '#B45309',
              background: '#FFFFFF', text: '#111827' },
    typography: { headingFont: 'Playfair Display', bodyFont: 'Inter', fontSize: '17px' },
  },
  components: { Header, PostCard },   // omit for a tokens-only theme
});
```

Register it in [`src/themes/index.ts`](./src/themes/index.ts) — one import, one
array entry — then rebuild. It appears in **Admin → Themes**, ready to activate.

## Slots

| Slot | Renders | Props |
| --- | --- | --- |
| `Header` | Site header on every public page | `siteTitle`, `locale`, `localeOptions?` — language-switcher entries for THIS page. Only a record route can build them (switching language on an article must land on that article's translation, which has its own slug); left undefined on static routes like `/blog` or `/`, where one template serves every language at the same path. |
| `Footer` | Site footer on every public page | `siteTitle`, `social?`, `locale`. `social` is `{ twitter?, github?, linkedin?, facebook?, instagram?, youtube? }` — six keys, each mapped from the matching `social_*` setting in `src/lib/site.ts`. Render the ones you want; `tests/theme-slots.test.mjs` enforces the contract **in both directions**, so a key here that `site.ts` does not populate fails the suite, and so does a theme reading a key that is not in the contract. |
| `PostCard` | One post in a listing (blog index) | `post` (with `author`, `category`, `image`, `date`, `readTime` resolved) |
| `PostArticle` | The whole single-post view | `post`, `contentHtml`, `author`, `category`, `date`, `readTime` |
| `Sidebar` | Optional aside; default renders nothing | `context: 'archive' \| 'post' \| 'page' \| 'home'`, `locale` |
| `Home` | The STOCK front page (shown while no CMS Page is the designated home). Owning it means owning the first screen: hero, latest posts, whatever the theme's identity calls for. | `siteTitle`, `siteTagline`, `posts: PostCardData[]` (recent, newest first), `locale` |
| `PageArticle` | A CMS Page at `/{slug}` — and at `/` when designated the home. Separate from `PostArticle` because a Page has no byline, date or category, and usually wants different typesetting. `isHome` lets a theme drop the title band when the Page is the front door. | `post`, `contentHtml` (sanitized — render with `set:html`), `isHome` |
| `Breadcrumbs` | The trail above the content on every public page. The array arrives already built by the route — a slot must never fetch — and the SAME array is serialized into the page's `BreadcrumbList` structured data, so a reader and a crawler can never be told different things. Render nothing below two items: a lone "Home" that links to the page you are on is noise. The last item is the current page and carries no `href`; mark it `aria-current="page"`. | `items: BreadcrumbItem[]` (`{ name, href? }`), `locale?` — every other chrome slot receives it, and without it a theme cannot translate the landmark label, which left a German page announcing its breadcrumb navigation with the English word. |
| `TableOfContents` | The contents list for the article being read. A slot because *where* a ToC belongs is a design decision: the default puts it above the article, a magazine theme would put it in the sidebar, an editorial one might want none. The items are computed by the content pipeline, not here, so the anchors it links to and the ids in the body are one list rather than two guesses at it. | `items: TocItem[]` (`{ id, text, level, depth }` — each already carrying its anchor), `label?` (localized heading for the block), `class?`. `TableOfContentsProps` and `TocItem` are **not** re-exported from `astrobaas/core` yet; type an override with `ThemeSlotProps['TableOfContents']`, which is. |

> **Colours come from classes, never from `style="..."`.** The production CSP is
> hash-based with no `'unsafe-inline'` and no `'unsafe-hashes'`, and hashes never
> cover style ATTRIBUTES — so `style="color: var(--text-color)"` is dropped
> silently by the browser. It looks right in `astro dev` (no CSP) and loses its
> colour in production, which is the worst shape a bug can take. Use the shared
> `ab-*` token utilities (`ab-ink`, `ab-muted`, `ab-accent`, `ab-on-accent`,
> `ab-surface`, `ab-bg-accent`, `ab-border-ink`, `ab-heading-font`) or a scoped
> `<style>` block in your own `.astro` file — Astro hashes those, so they work.

Prop types live in [`src/core/theme-slots.ts`](./src/core/theme-slots.ts) and are
exported from `astrobaas/core`, so you get full inference. `ThemeSlotProps` maps
every slot name to its props and is the one import that always has them —
reach for `ThemeSlotProps['<Slot>']` when a named interface is not exported:

```astro
---
import type { PostCardProps } from 'astrobaas/core';
const { post } = Astro.props as PostCardProps;
---
<article class="my-card">
  <a href={`/blog/${post.slug}`}>{post.title}</a>
  <p>{post.excerpt}</p>
</article>
```

### You override what you want; the rest is inherited

Every slot you don't declare falls back to the built-in component. That's what
keeps themes **forward-compatible**: when a new slot is added, your theme keeps
working and simply inherits the new default. A theme whose module is missing from
a build degrades to the stock look rather than erroring.

## Design tokens

`settings` are your theme's **defaults**. Operators can override colors,
typography, and custom CSS in the customizer, and their values win — so read
colors from the CSS custom properties rather than hard-coding hex values:

```css
.my-card a { color: var(--primary-color); }
.my-card   { font-family: var(--body-font), sans-serif; }
```

All tokens are served from `/theme.css` (an external stylesheet, so the strict
hash-based CSP applies unchanged — see below).

### Colour

`--primary-color`, `--secondary-color`, `--accent-color`, `--background-color`,
`--text-color`, `--surface-color`, `--muted-color`, `--border-color`,
`--on-primary`, `--success-color`, `--warning-color`, `--danger-color`.

`--on-primary` is derived from the primary colour's luminance when the operator
has not set it, so text on a brand-coloured button stays readable whether the
brand is navy or lemon.

### Typography

`--heading-font`, `--body-font`, `--font-size-base`, `--letter-spacing`,
`--line-height`, `--heading-line-height`, `--heading-weight`, `--h1`, `--h2`,
`--h3`.

The chosen families are also **fetched** — the layout emits a webfont `<link>`
for them. Do not assume a family is installed locally.

### Shape, space and layout

`--radius-sm|md|lg|pill`, `--space-1|2|3|4|6|8`, `--section-y`,
`--shadow-sm|md|lg`, `--container`, `--measure`,
`--btn-bg|fg|border|radius`, `--header-align|direction|pad|border`.

### Where these come from

Most are **enum scales**, not free-form values. The operator picks a key
(`radius: 'lg'`, `density: 'roomy'`, `shadow: 'strong'`, `containerWidth`,
`typeScale`, `headingWeight`, `buttonStyle`, `headerStyle`) and
`src/lib/theme-tokens.ts` maps that key to a pre-authored block of declarations.

This matters for a theme author in two ways:

1. **A stored value can never *be* CSS, only *select* CSS.** There is no
   sanitiser to get wrong. An unrecognised key falls back to the group default.
2. **Every key in a scale emits the same token names**, so you can rely on a
   token existing regardless of which key the operator picked. A test enforces
   that, and a token with no `var()` consumer anywhere in `src/` fails the
   suite — this project shipped four separate "setting that changes nothing"
   bugs before that check existed.

### Dark mode

`colorScheme` is `'light' | 'dark' | 'auto'`. Under `auto`, `/theme.css` emits
a `prefers-color-scheme` block **and** an explicit `[data-theme]` override, so a
visitor's toggle wins in both directions. The toggle persists to a cookie which
the server reads, stamping `data-theme` on `<html>` before the HTML is sent —
no flash, and no inline script, which the hash-based CSP would refuse anyway.

A theme may author its own `darkColors`; anything it leaves out is derived from
the light palette, so a partial dark palette is legal and useful.

### Presets

`src/themes/presets.ts` holds complete named bundles (colours + type + shape +
density + dark palette) surfaced as one-click options in the customizer. A
preset is expressed in the same flat payload the manual controls post, so there
is one write path and one validator.

## Styling sections

Authors build page layout from a palette of **sections** — hero, columns, card,
CTA, note, media + text, gallery, spacer, table, video link — which the editor
inserts as allow-listed CSS classes on ordinary tags
(`<div class="ab-hero ab-align-center">`). There is no
block tree: `content` is the same sanitized HTML string it has always been, so
sections arrive inside `contentHtml` and need nothing special to render.

The default styles live in `src/styles/sections.css` and are written **entirely
in design tokens** (`var(--primary-color)`, `var(--radius-md)`, `var(--space-6)`,
…), so changing a preset restyles every section without a theme writing any CSS.

One naming rule worth stating plainly, because an earlier draft of this document
got it wrong and the result is a **silent no-op**: the `ab-` prefix belongs to
section **classes** (`.ab-hero`, `.ab-columns`), never to custom **properties**.
There is no `--ab-*` token namespace — a rule written against
`var(--ab-radius-md)` resolves to nothing, applies nothing, and reports nothing.
The real token names are the ones `sections.css` itself uses: `--primary-color`,
`--background-color`, `--surface-color`, `--muted-color`, `--border-color`,
`--radius-md` / `--radius-lg`, `--space-3` / `--space-4` / `--space-6`, and
`--section-y`.

To go further, override the classes from your theme's stylesheet:

```css
.ab-hero { padding-block: 6rem; text-align: start; }
.ab-columns { gap: var(--space-6); }
```

Two constraints are load-bearing:

- **Never use a Tailwind utility in section CSS.** Tailwind's JIT scans source
  files, and stored post HTML is not one — a utility class named only in the
  database is never generated, so it silently does nothing.
- **Scope parts to their parent** (`.ab-columns > .ab-col`, not `.ab-col`). A
  section's parts can be orphaned by editing, and an orphan should degrade to
  plain readable content rather than broken layout.

A theme can *restyle* a section but cannot *restructure* it, because there is no
tree to walk. The full vocabulary — and the generated sanitizer allow-list that
guarantees the editor and the save path agree — is `src/core/sections.ts`.

## Shipping a stylesheet, patterns, a screenshot — or a parent

Beyond `id`/`name`/`version`/`author`/`settings`/`components`, `defineTheme`
takes four optional fields:

- **`extends`** — the id of a theme this one builds on. See below; it is the one
  worth reading before you copy a theme.
- **`screenshot`** — a preview image for the theme card in Admin → Themes,
  either a `data:` image URI or a root-relative path.
- **`css`** — a stylesheet appended to `/theme.css`, after the token
  declarations (so `var(--primary-color)` is already defined) and before the
  operator's custom CSS (so an operator can always override you). Serve-time
  filtering strips `@import` and escape attempts. If it exceeds 100 KB it is
  refused whole rather than truncated, because a cut inside `@media (...) {`
  swallows every rule after it — a stylesheet that breaks in a way that reads
  as a CSS bug is worse than one that is visibly missing.
- **`patterns`** — named arrangements of sections offered in the editor
  alongside the built-in ones:

```ts
patterns: [{
  name: 'split-hero',
  label: 'Split hero',
  description: 'Headline beside an image.',
  html: '<div class="ab-media ab-media-right">…</div>',
}]
```

Each is checked against the sanitizer at resolve time and **dropped if it does
not survive byte-for-byte**, with the reason shown in Admin → Tools. So a
pattern referencing a section this build does not define is reported by name
rather than silently losing a region on save. Your names are namespaced
(`<themeId>--<name>`), so you cannot shadow a built-in pattern.

## Child themes: `extends`

"Marquee, but our colours and our own footer." Without inheritance that means
copying the whole theme, and the copy stops receiving every later fix to the
original. A child declares a parent and overrides **only the slots it wants**;
everything else — components, tokens, CSS, patterns — comes from the parent.

**A child's `settings` are partial, and may be omitted entirely.** One colour is
a complete answer; so is nothing at all, for a child that only replaces a
component. A ROOT theme still owns a whole palette, because there is no parent
to fall back to — the type enforces exactly that difference, so a
components-only child compiles in TypeScript as readily as in JavaScript:

```ts
export default defineTheme({
  id: 'marquee-quiet',
  name: 'Marquee (Quiet)',
  description: 'Marquee with our own footer.',
  version: '1.0.0',
  author: 'Acme',
  extends: 'marquee',
  components: { Footer },      // and no settings at all
});
```

```ts
export default defineTheme({
  id: 'marquee-acme',
  name: 'Marquee (Acme)',
  description: 'Marquee in Acme blue.',
  version: '1.0.0',
  author: 'Acme',
  extends: 'marquee',
  settings: {
    colors: { primary: '#005b8f', secondary: '#0b1f2a', accent: '#f25c05',
              background: '#ffffff', text: '#0b1f2a' },
    typography: { headingFont: 'Bebas Neue', bodyFont: 'Inter', fontSize: '17px' },
  },
  components: { Footer },     // Marquee's Header, Home, PostCard… are all kept
});
```

**`settings` is still required, and complete.** `ThemeDefinition` types it as a
whole `ThemeConfig`, so a `.ts` child cannot declare `{ colors: { primary } }`
and let the rest arrive from the parent — `npm run build` refuses it. The merge
underneath is per-leaf and would accept a partial; the type is the constraint.
Worth knowing what that costs: a value you spell out is a value you now own, so
a later change to the parent's `secondary` will not reach this child.

The merge rules ([`src/lib/theme-inherit.ts`](./src/lib/theme-inherit.ts)) and
why each is the way it is:

- **Components: child wins per slot.** Overriding `Footer` keeps the parent's
  `Header`. Merging slot by slot rather than wholesale is the entire feature.
- **Tokens: child wins per LEAF.** `ThemeConfig` is nested, so a top-level merge
  would let a child that sets one colour replace the parent's whole palette and
  blank its type scale. Setting `colors.primary` keeps everything else.
- **CSS: parent first, then child.** Concatenated, not replaced, so a child's
  rule wins by ordinary cascade order without `!important`.
- **Patterns: parent's, then the child's**, child wins on a duplicate name.
- **A blank is not a value.** `''`, `null` and `undefined` in a child mean
  "inherit", not "clear"; `false` and `0` are values and do replace. A child
  that wants a parent's token gone sets it to something — "no colour" is not a
  colour, and the downstream fallbacks would put the default back anyway.

A missing parent or a cycle resolves to the child plus whatever ancestors were
reached before the chain broke, with a loud log — not to a blank page. Theming
is decoration; a site that will not render is an outage.

## Rules that keep the site safe and fast

- **No inline `<style>` or `<script>`.** The production CSP hashes what the build
  bundles and allows nothing else; a `style="..."` attribute or inline `<style>`
  is silently dropped by the browser. Use classes, a scoped `<style>` block in
  your `.astro` component (Astro hashes those), or CSS custom properties set via
  CSSOM in a bundled script.
- **`contentHtml` is already sanitized.** Render it with `set:html` and do not
  re-sanitize, unescape, or wrap it in another sink.
- **Escape nothing by hand.** Astro escapes interpolations; only `set:html`
  bypasses that, and the only value you should pass it is `contentHtml`.
- **Don't fetch in a slot.** Slots render per request; the page already resolved
  the data. Extra queries multiply per post.

## What themes deliberately cannot do (v1)

- **Add routes or pages.** A theme presents existing content; routing is the
  app's concern. Need a new page type? That's a code change or a custom content
  type (see [PLUGIN_DEVELOPMENT.md](./PLUGIN_DEVELOPMENT.md)).
- **Change the admin.** Slots cover the public site only.
- **Ship server logic.** That's what plugins are for.
- **Be installed at runtime.** Markup is code; code is build-time. The
  runtime-installable tier is declarative plugin manifests, which can add CSS but
  never templates.

Page-level layout slots (a full `ArchiveLayout`/`PostLayout`) are not in v1.
`PostArticle` already covers the single-post view; if you need more, open an
issue describing the case — adding a slot is additive and cheap.

## Testing your theme

```bash
npm run build          # type-checks your slots against the prop contracts
npm run dev            # activate it in Admin → Themes
npm test               # unit + smoke; smoke asserts theme switching works
```

The admin's theme card shows exactly which slots your theme overrides, which is
the quickest check that registration worked.

## Bundled examples

- **`default`** — overrides nothing. The stock site, and the reference for what
  each default slot renders.
- **`editorial`** — a serif magazine. Overrides seven of the nine slots
  (`Header`, `Footer`, `Home`, `PostCard`, `PostArticle`, `PageArticle`,
  `Breadcrumbs`) and inherits `Sidebar` and `TableOfContents`. The reference for
  a template theme.
- **`marquee`** — a street poster: display caps, four-pixel rules, one loud
  accent. The same seven overrides, as far from Editorial as the token system
  allows — the registry's proof that a theme change is not just a recolour.
The admin's theme card lists exactly which slots a theme overrides, so compare
against that rather than this paragraph if the two ever disagree.
