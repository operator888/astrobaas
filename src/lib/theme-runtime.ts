/**
 * Resolve which component renders each theme slot for the current request.
 *
 * Resolution is a two-step fallback:
 *   1. the ACTIVE theme's override, if it declares one for that slot;
 *   2. otherwise the built-in default component.
 *
 * That fallback is what makes the contract forward-compatible: adding a slot
 * later cannot break an existing theme, because a theme that doesn't know about
 * it simply inherits the default. It also means a theme whose module has been
 * removed from the build (stale DB row) degrades to the stock look rather than
 * erroring.
 */
import DefaultHeader from '../components/public/PublicHeader.astro';
import DefaultFooter from '../components/public/PublicFooter.astro';
import DefaultPostCard from '../components/public/PostCard.astro';
import DefaultPostArticle from '../components/public/PostArticle.astro';
import DefaultTableOfContents from '../components/public/TableOfContents.astro';
import DefaultSidebar from '../components/public/Sidebar.astro';
import DefaultHome from '../components/DefaultHome.astro';
import DefaultPageArticle from '../components/public/PageArticle.astro';
import DefaultBreadcrumbs from '../components/public/Breadcrumbs.astro';
import { LocalDB } from './localdb';
import { getThemeDefinition, ensureThemesBootstrapped } from '../themes';
import { THEME_SLOTS, overriddenSlots, type ThemeSlotName } from '../core/theme-slots';
import type { ThemeDefinition } from '../core/define';
import type { Theme } from '../core/models';
import type { SectionPattern } from '../core/patterns';
import { isDeclarativeTheme } from '../core/theme-manifest';
import { resolveInheritance } from './theme-inherit';

/** The built-in implementation of every slot. */
export const DEFAULT_SLOTS: Record<ThemeSlotName, unknown> = {
  Header: DefaultHeader,
  Footer: DefaultFooter,
  PostCard: DefaultPostCard,
  PostArticle: DefaultPostArticle,
  Sidebar: DefaultSidebar,
  Home: DefaultHome,
  PageArticle: DefaultPageArticle,
  Breadcrumbs: DefaultBreadcrumbs,
  TableOfContents: DefaultTableOfContents,
};

export interface ResolvedTheme {
  /** Active theme id from the DB, or 'default' when none/unknown. */
  id: string;
  /**
   * The inheritance chain, root first, ending in the active theme (C-170).
   *
   * One entry for a theme with no parent. Shown on the admin screen as "based
   * on", which is the only way an operator can tell why a child theme looks the
   * way it does.
   */
  ancestry: string[];
  /**
   * Why the chain stopped short, if it did — a parent that is not installed, or
   * a cycle. Surfaced rather than swallowed: "the theme looks wrong" is not a
   * debuggable report.
   */
  inheritanceProblem?: string;
  /** The bundled module, if this build actually ships that theme. */
  definition?: ThemeDefinition;
  /** Slot → component, overrides merged over defaults. Always complete. */
  slots: Record<ThemeSlotName, unknown>;
  /** Which slots the active theme overrides (for the admin UI + tests). */
  overrides: ThemeSlotName[];
  /**
   * Which tier this theme came from.
   *
   * 'bundled'     — a compiled-in module; may override slot components.
   * 'declarative' — installed from a manifest at runtime; data only, so every
   *                 slot is the built-in default and `overrides` is empty.
   */
  tier: 'bundled' | 'declarative';
  /**
   * The theme's own stylesheet, from whichever tier supplied it.
   *
   * Unified deliberately. `/theme.css` and the editor's inserter must not each
   * grow an `if bundled … else declarative …` branch: that is precisely the
   * shape of the sibling-gap bug this codebase keeps hitting, and here it would
   * mean a declarative theme's CSS shipping but its patterns not (or the
   * reverse) with nothing to notice.
   */
  css: string;
  /** The theme's patterns, from whichever tier supplied them. Never undefined. */
  patterns: readonly SectionPattern[];
}

/**
 * Merge a theme's overrides over the defaults. Pure — no I/O — so it is directly
 * unit-testable and usable anywhere the theme definition is already known.
 */
export function resolveSlots(definition: ThemeDefinition | undefined): Record<ThemeSlotName, unknown> {
  const slots = { ...DEFAULT_SLOTS };
  const components = definition?.components;
  if (components) {
    for (const name of THEME_SLOTS) {
      const override = components[name];
      // Only a real component replaces the default; null/undefined inherits.
      if (override != null) slots[name] = override;
    }
  }
  return slots;
}

/**
 * Which theme is active changes rarely, but resolveActiveTheme() is called by
 * every layout AND every page that renders a slot — so an uncached lookup costs
 * multiple DB round-trips per page render. Cache it, invalidated explicitly when
 * a theme is activated, with a short TTL as a backstop for writers we don't know
 * about (another replica, a direct DB edit).
 */
const THEME_CACHE_TTL_MS = 5_000;
let themeCache: { value: ResolvedTheme; at: number } | null = null;

/** Drop the cached theme so the next render re-reads it. Call after activation. */
export function invalidateThemeCache(): void {
  themeCache = null;
}

/**
 * Resolve the active theme for this request. Falls back to the stock look on any
 * failure (DB unavailable, no active theme, or a DB row naming a theme this
 * build doesn't include) — theming must never take the public site down.
 */
export async function resolveActiveTheme(): Promise<ResolvedTheme> {
  const now = Date.now();
  if (themeCache && now - themeCache.at < THEME_CACHE_TTL_MS) return themeCache.value;

  let id = 'default';
  let activeRow: Theme | undefined;
  try {
    await LocalDB.init();
    // Make sure every bundled theme has a row so it can be activated (idempotent).
    await ensureThemesBootstrapped();
    const active = await LocalDB.getActiveTheme();
    if (active?.id) { id = active.id; activeRow = active; }
  } catch {
    // Boot may be racing the DB seed — stock look is the right fallback.
    // Deliberately NOT cached, so the next request retries immediately.
    const fallback = getThemeDefinition('default');
    return {
      id: 'default',
      ancestry: fallback ? [fallback.id] : [],
      definition: fallback,
      slots: resolveSlots(fallback),
      overrides: overriddenSlots(fallback?.components),
      tier: 'bundled',
      css: fallback?.css ?? '',
      patterns: fallback?.patterns ?? [],
    };
  }

  const own = getThemeDefinition(id);
  // Child themes (C-170). Applied HERE, once, so every consumer — the layout,
  // /theme.css, the editor's inserter — sees one flattened definition and none
  // of them has to know inheritance exists. A caller that resolved it itself
  // would be the second implementation, and the first to drift.
  const inherited = resolveInheritance(own, (parentId) => getThemeDefinition(parentId));
  const definition = inherited.definition;
  if (inherited.problem) console.error(`Theme inheritance: ${inherited.problem}`);
  // A row with a `manifest` is a declarative theme. Bundled wins if both somehow
  // exist, because compiled-in code is the more trusted of the two and the
  // validator refuses a manifest that claims a bundled id in the first place.
  const declarative = !definition && isDeclarativeTheme(activeRow) ? activeRow.manifest : undefined;

  const resolved: ResolvedTheme = {
    id,
    ancestry: inherited.ancestry,
    inheritanceProblem: inherited.problem,
    definition,
    slots: resolveSlots(definition),
    overrides: overriddenSlots(definition?.components),
    tier: declarative ? 'declarative' : 'bundled',
    css: (declarative?.css ?? definition?.css ?? ''),
    patterns: (declarative?.patterns ?? definition?.patterns ?? []),
  };
  themeCache = { value: resolved, at: now };
  return resolved;
}
