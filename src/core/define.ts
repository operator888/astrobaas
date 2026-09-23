/**
 * Author helpers. `definePlugin`/`defineTheme` are identity functions (like
 * Astro's `defineConfig`): they return their argument unchanged but give editors
 * full type inference and a single, stable call site to evolve later (e.g. to
 * add validation or defaults) without changing author code.
 *
 * @alpha
 */
import type { Plugin } from '../lib/plugin-system';
import type { Theme, ThemeConfig } from './models';
import type { ThemeComponents } from './theme-slots';
import type { SectionPattern } from './patterns';

/** Define a plugin with full type-checking of its hooks. */
export function definePlugin(plugin: Plugin): Plugin {
  return plugin;
}

/**
 * Define a theme: identity, default design tokens, and optional template
 * overrides.
 *
 * `settings` are the theme's DEFAULT tokens — what the site looks like before an
 * operator customizes anything. `components` optionally replaces built-in slots
 * (see core/theme-slots.ts); every omitted slot inherits the default, so a theme
 * stays forward-compatible when new slots are added.
 *
 * (Persisted Theme records add status/created_at; `id` here is the stable key
 * that links a bundled theme module to its DB row.)
 */
/**
 * Every leaf optional, all the way down.
 *
 * What a CHILD theme is allowed to say about settings: a palette's one colour,
 * a single token, nothing at all. `lib/theme-inherit.ts` merges per leaf, so
 * what the child does not mention comes from the parent — the type now says
 * the same thing the merge has always done.
 */
export type DeepPartial<T> = T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

type ThemeBase = Pick<Theme, 'name' | 'description' | 'version' | 'author'> & {
  /** Stable, kebab-case id. Must match the persisted Theme record's id. */
  id: string;
  /**
   * The id of a theme this one extends (C-170).
   *
   * A child supplies only what differs: every slot, token, pattern and CSS rule
   * it does not mention comes from the parent, so an improvement to the parent
   * reaches the child. That is the whole point — the alternative is copying a
   * theme and never receiving another fix to it.
   *
   * Merged by `lib/theme-inherit.ts`, which also handles the two ways a chain
   * breaks: a parent that is not installed, and a cycle. Both resolve to the
   * child alone with a loud log rather than to a blank page.
   */
  screenshot?: string;
  /** Partial template overrides. Omit for a tokens-only theme. */
  components?: ThemeComponents;
  /**
   * A stylesheet appended to `/theme.css`, after the design tokens.
   *
   * Tokens cover colour, type and shape; this is for the rest — restyling
   * sections, layout, anything a token cannot express. It is served as an
   * external stylesheet because the CSP has no `'unsafe-inline'`, so an inline
   * `<style>` would simply be dropped by the browser.
   *
   * Write it in terms of the token custom properties (`var(--primary-color)`)
   * rather than literal values, or switching preset will stop affecting the
   * theme's own rules. Never use a Tailwind utility class here: the JIT scans
   * source files, and stored post HTML is not one.
   */
  css?: string;
  /**
   * Named arrangements of sections offered in the editor's inserter.
   *
   * Each must survive `sanitizeHtml` byte-for-byte or it is dropped with a
   * reason (see `lib/pattern-registry.ts`) — a pattern the save path would
   * rewrite is worse than no pattern, because the author only finds out after
   * they have built a page on it.
   */
  patterns?: readonly SectionPattern[];
};

/**
 * A theme is either a ROOT — it stands alone, so it owns a complete palette —
 * or a CHILD of another, in which case it supplies only what differs.
 *
 * Written as a union rather than one optional field because the two cases have
 * genuinely different obligations: a root theme with half a palette renders
 * with half the site unstyled, while a child with half a palette is the normal
 * case. `extends` is what tells them apart, and the compiler now enforces it.
 */
export type ThemeDefinition = ThemeBase & (
  | {
    /** A root theme: no parent, so the palette here is the whole palette. */
    extends?: undefined;
    settings: ThemeConfig;
  }
  | {
    /**
     * The id of a theme this one extends (C-170).
     *
     * A child supplies only what differs: every slot, token, pattern and CSS
     * rule it does not mention comes from the parent, so an improvement to the
     * parent reaches the child. That is the whole point — the alternative is
     * copying a theme and never receiving another fix to it.
     *
     * Merged by `lib/theme-inherit.ts`, which also handles the two ways a
     * chain breaks: a parent that is not installed, and a cycle. Both resolve
     * to the child alone with a loud log rather than to a blank page.
     */
    extends: string;
    /** Only what differs from the parent. Omit it entirely for a components-only child. */
    settings?: DeepPartial<ThemeConfig>;
  }
);

export function defineTheme(theme: ThemeDefinition): ThemeDefinition {
  return theme;
}
