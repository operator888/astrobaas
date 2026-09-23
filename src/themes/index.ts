/**
 * Theme registry.
 *
 * Astro bundles the server at build time, so themes are explicit imports here
 * rather than runtime filesystem discovery — the same model as code plugins. To
 * add a theme: create `src/themes/<id>/index.ts` that default-exports
 * `defineTheme({...})`, then add one import + array entry below and rebuild.
 *
 * Markup is deliberately NOT installable at runtime. The runtime-installable
 * tier is declarative plugin manifests, which cannot contain templates by design
 * (see src/core/manifest.ts).
 *
 * A THIRD tier exists between those two (C-168): a theme installed from npm and
 * named in `ASTROBAAS_THEMES`. That is code an operator put on the server on
 * purpose, with the same trust as a compiled-in theme — the same line
 * `ASTROBAAS_PLUGINS` already draws — so it may carry components, unlike a
 * manifest an admin installs through the browser.
 */
import type { ThemeDefinition } from 'astrobaas/core';
import { LocalDB } from '../lib/localdb';
import defaultTheme from './default';
import editorialTheme from './editorial';
import marqueeTheme from './marquee';
import { loadExternalThemes } from './external';
import { invalidateThemeCache } from '../lib/theme-runtime';
import { resolveInheritance } from '../lib/theme-inherit';
import type { ThemeConfig } from '../core/models';

export const BUNDLED_THEMES: ThemeDefinition[] = [defaultTheme, editorialTheme, marqueeTheme];

/**
 * Themes loaded from `ASTROBAAS_THEMES`, once the loader has run.
 *
 * Separate from BUNDLED_THEMES so `getThemeDefinition` can prefer the bundled
 * one on a collision — though the loader refuses a bundled id outright, so the
 * preference is a second door rather than the only one.
 */
let externalThemes: ThemeDefinition[] = [];

/** Every theme this process can activate: bundled first, then external. */
export function allThemes(): ThemeDefinition[] {
  return [...BUNDLED_THEMES, ...externalThemes];
}

/** Look up a theme module by id, bundled or external. */
export function getThemeDefinition(id: string | undefined | null): ThemeDefinition | undefined {
  if (!id) return undefined;
  return BUNDLED_THEMES.find((t) => t.id === id) ?? externalThemes.find((t) => t.id === id);
}

/**
 * The in-flight (or completed) bootstrap.
 *
 * A PROMISE, not a boolean — the same fix `ensurePluginsBootstrapped` already
 * carries, and for the same reason. The boolean version set the flag before its
 * first `await`, so a concurrent request returned IMMEDIATELY into a registry
 * where `externalThemes` was still empty. `resolveActiveTheme` then found no
 * definition for the active theme, fell back to the stock look — and CACHED it
 * for five seconds, with no log, because an unknown id produces no inheritance
 * problem to report.
 *
 * On a cold start the browser asks for `/` and `/theme.css` in parallel, so
 * this was not a theoretical race: whichever lost it served an unthemed site.
 */
let themesBootstrap: Promise<void> | null = null;

/**
 * Ensure every bundled theme has a DB row so it can be activated and
 * customized. Idempotent and non-destructive: an existing row (with the
 * operator's customized tokens) is never overwritten. Runs once per process.
 */
export async function ensureThemesBootstrapped(): Promise<void> {
  if (!themesBootstrap) {
    const mine: Promise<void> = doThemeBootstrap().catch((err) => {
      // A failed bootstrap must not be cached as done: the next request should
      // try again rather than serve an empty registry for the process's life.
      if (themesBootstrap === mine) themesBootstrap = null;
      throw err;
    });
    themesBootstrap = mine;
  }
  return themesBootstrap;
}

async function doThemeBootstrap(): Promise<void> {
  try {
    // Themes from npm (C-168). Loaded BEFORE the rows are written, so an
    // installed theme is activatable on the first request rather than the
    // second — the alternative is an operator restarting, not seeing their
    // theme, and reasonably concluding the feature does not work.
    const external = await loadExternalThemes(process.env, BUNDLED_THEMES.map((t) => t.id));
    externalThemes = external.themes;
    for (const failure of external.failed) {
      // Loud, with the specifier and the reason. A theme that will not load
      // leaves the site looking wrong, and "looks wrong" is not a debuggable
      // report.
      console.error(`Theme "${failure.specifier}" was not loaded: ${failure.reason}`);
    }

    // A child theme may carry only what differs from its parent (or nothing at
    // all), so the row is seeded from the RESOLVED settings: a stored theme
    // record is what the admin's swatches and the first render read, and half a
    // palette there would show as half a theme. Resolution already handles a
    // missing parent and a cycle by falling back to the child alone.
    const byId = new Map(allThemes().map((t) => [t.id, t]));
    await LocalDB.ensureThemes(
      allThemes().map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        version: t.version,
        author: t.author,
        settings: (resolveInheritance(t, (id) => byId.get(id)).definition?.settings as ThemeConfig | undefined)
          // A child whose parent is missing resolves to itself, which may carry
          // only a fragment; the stock palette is what fills the rest.
          ?? (defaultTheme.settings as ThemeConfig),
      })),
    );
    // The theme cache may already hold a resolution made before the external
    // themes existed — on a cold start, a parallel request for `/theme.css`.
    // Dropping it here means the next render re-resolves rather than serving
    // five seconds of stock look.
    invalidateThemeCache();
  } catch (err) {
    // Theming must never take the site down; the stock look still renders.
    console.error('Theme bootstrap failed:', err instanceof Error ? err.message : err);
    throw err;
  }
}
