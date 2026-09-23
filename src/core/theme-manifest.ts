/**
 * Declarative themes — the runtime-installable tier.
 *
 * ## Why this exists now and did not before
 *
 * A theme used to mean Astro components, and Astro bundles the server at build
 * time. Markup genuinely cannot be installed at runtime, so themes were
 * compiled in and the honest README said so.
 *
 * Sections changed that. The substance of a theme is now expressible as DATA:
 * design tokens were always data, a stylesheet is a string, and a pattern is
 * HTML the sanitizer validates byte-for-byte. None of that needs a bundler. So
 * there are two theme tiers, mirroring the plugin model exactly:
 *
 *  - **Bundled** (`defineTheme` in `src/themes/`) — full power. Can replace the
 *    Header/Footer/Sidebar slot COMPONENTS. Requires a rebuild.
 *  - **Declarative** (this file) — tokens, CSS, patterns. Installed from JSON at
 *    runtime, no rebuild, no code execution. Cannot replace components.
 *
 * The second tier covers what "custom theme" means for most people: colours,
 * type, shape, a stylesheet, and ready-made page layouts. The first stays for
 * anyone who needs to change the markup itself.
 *
 * ## Why a declarative theme's CSS is NOT namespace-scoped
 *
 * Plugin CSS is confined to `.ab-x-<pluginId>-` because a plugin is a guest: it
 * contributes one feature and has no business restyling the page around it. A
 * theme is the opposite — restyling the whole site IS the job. So theme CSS is
 * filtered (no `@import`, no context escapes) but not scoped.
 *
 * That is a real trust difference and worth stating plainly: installing a
 * declarative theme lets its author control how every page looks. It cannot run
 * code, read data, or make requests — but it can change what visitors see.
 * Install themes from sources you would take a stylesheet from.
 *
 * This file is TYPES AND LIMITS ONLY so that `astrobaas/core` stays
 * dependency-free for theme authors. The validator needs the token allow-lists
 * and the HTML sanitizer, so it lives in `src/lib/theme-manifest.ts`.
 */
import type { ThemeConfig } from './models';
import type { SectionPattern } from './patterns';

/**
 * Manifest API version implemented by this host.
 *
 * Separate from the PLUGIN manifest version on purpose: the two contracts
 * evolve independently, and pinning a theme to a plugin API revision would make
 * every plugin change a theme-compatibility question.
 */
export const THEME_MANIFEST_API_VERSION = '1.0.0';

export interface ThemeManifest {
  /** Stable kebab-case id. May not shadow a bundled theme. */
  id: string;
  name: string;
  /** semver. */
  version: string;
  description?: string;
  author?: string;
  /** https only. */
  homepage?: string;
  /** Semver range of the theme manifest API, e.g. "^1.0.0". */
  astrobaasApi?: string;
  /**
   * The theme's DEFAULT design tokens — what the site looks like before an
   * operator customizes anything.
   *
   * Partial: every omitted value falls back to the built-in default, so a theme
   * that only wants to change two colours does not have to restate the whole
   * token set (and does not silently reset the rest to zero).
   */
  tokens?: Partial<ThemeConfig>;
  /**
   * Stylesheet, appended to `/theme.css` after the token declarations.
   *
   * Write it against the token custom properties (`var(--primary-color)`)
   * rather than literal values, or switching preset stops affecting the theme's
   * own rules. Never use a Tailwind utility class: the JIT scans source files,
   * and a stored stylesheet is not one.
   */
  css?: string;
  /** Named section arrangements offered in the editor's inserter. */
  patterns?: SectionPattern[];
  /** Data URI or root-relative path shown in the theme picker. */
  screenshot?: string;
}

export const THEME_MANIFEST_LIMITS = {
  /** Generous: a theme legitimately styles an entire site. */
  css: 100_000,
  patterns: 24,
  patternHtml: 8_000,
  stringField: 500,
  /** A data: URI screenshot has to fit in a settings-sized value. */
  screenshot: 200_000,
} as const;

/** Marker distinguishing an installed declarative theme from a bundled row. */
export interface DeclarativeThemeRecord {
  manifest: ThemeManifest;
  /** "upload" or "registry:<name>". */
  source?: string;
  installed_at?: string;
}

/** True when a Theme row came from a manifest rather than a compiled-in module. */
export function isDeclarativeTheme(theme: unknown): theme is { manifest: ThemeManifest } {
  return (
    !!theme && typeof theme === 'object'
    && !!(theme as { manifest?: unknown }).manifest
    && typeof (theme as { manifest?: { id?: unknown } }).manifest?.id === 'string'
  );
}
