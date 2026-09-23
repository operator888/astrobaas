/**
 * Themes installed from npm, or from a path (C-168).
 *
 * ## What the row asked for, and what it did not
 *
 * "npm-distributed theme packages." NOT a marketplace this project runs: an
 * index of themes is a curated list somebody maintains, and the owner has said
 * they will curate it. What has to exist in the code is the INSTALL mechanism —
 * a way for `npm i @someone/theme-x` plus one environment variable to put a
 * theme on a site.
 *
 * ## Deliberately the same shape as external plugins
 *
 * `ASTROBAAS_THEMES` is a comma-separated list of module specifiers, each
 * default-exporting either a theme, an array of themes, or a FACTORY taking the
 * host API. Every reason `plugins/external.ts` gives for that design applies
 * here unchanged, and the important one bears repeating: an external module
 * cannot resolve `astrobaas/core`, because inside this repo that is a tsconfig
 * path alias and in a deployed install there is no such package at all. A theme
 * that imports the host fails to load in exactly the deployments it is sold to.
 * The factory is handed `defineTheme`, so it gets THIS host's definition.
 *
 * ## Why themes CAN ship components and declarative manifests cannot
 *
 * A manifest is data installed at runtime by an admin, so it must not be able
 * to carry templates. A module named in the environment is code the operator
 * installed on the server on purpose, with the same trust as a compiled-in
 * theme. That is the same line `ASTROBAAS_PLUGINS` already draws.
 *
 * ## Failure is loud, and boot continues
 *
 * A theme that will not load leaves the site looking wrong, not broken. So the
 * failure is logged with the specifier and the reason, and the site renders
 * with the stock look — a shop that will not start sells nothing, which is
 * strictly worse.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ThemeDefinition } from '../core/define';
import { defineTheme } from '../core/define';
import { apiRangeSatisfied, MANIFEST_API_VERSION } from '../core/manifest';

/** What a factory-style external theme is handed. */
export interface ThemeHost {
  defineTheme: typeof defineTheme;
  /** The host's plugin/theme API version, for a module that wants to branch. */
  apiVersion: string;
}

export interface ExternalThemeResult {
  themes: ThemeDefinition[];
  failed: { specifier: string; reason: string }[];
}

/** Split the env value; blank entries and stray whitespace are ignored. */
export function parseThemeSpecifiers(raw: string | undefined): string[] {
  return (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Is this a usable theme definition?
 *
 * An id and a name, because those are what the admin screen and the activation
 * row need. `settings` is NOT required: a pure child theme that only overrides
 * a component legitimately has no tokens of its own.
 */
export function looksLikeTheme(v: unknown): v is ThemeDefinition {
  return !!v && typeof v === 'object'
    && typeof (v as { id?: unknown }).id === 'string'
    && (v as { id: string }).id.length > 0
    && typeof (v as { name?: unknown }).name === 'string';
}

/**
 * Ids a module may not claim.
 *
 * A package that exports a theme called `default` would silently replace the
 * stock look on every install that loaded it — including as a side effect of
 * installing something else from the same package. Bundled ids belong to this
 * repository.
 */
export function themeIdIsReserved(id: string, bundledIds: readonly string[]): boolean {
  return bundledIds.includes(id);
}

export async function loadExternalThemes(
  env: NodeJS.ProcessEnv = process.env,
  bundledIds: readonly string[] = [],
): Promise<ExternalThemeResult> {
  const specifiers = parseThemeSpecifiers(env.ASTROBAAS_THEMES);
  const themes: ThemeDefinition[] = [];
  const failed: { specifier: string; reason: string }[] = [];
  const claimed = new Set<string>(bundledIds);

  for (const specifier of specifiers) {
    try {
      // A PATH resolves against the project root, not against this file — which
      // after bundling lives somewhere the operator has never heard of.
      const isPath = specifier.startsWith('.') || specifier.startsWith('/');
      const target = isPath
        ? pathToFileURL(path.resolve(process.cwd(), specifier)).href
        : specifier;

      // `@vite-ignore`: the specifier is only known at run time, which is the
      // entire point of loading from outside the build.
      const mod: unknown = await import(/* @vite-ignore */ target);
      const entry = (mod as { default?: unknown })?.default ?? mod;

      const resolved = typeof entry === 'function'
        ? (entry as (host: ThemeHost) => unknown)({ defineTheme, apiVersion: MANIFEST_API_VERSION })
        : entry;

      // One package may carry several themes — a family with a shared parent is
      // the obvious case, and it is exactly what child themes are for.
      const candidates = Array.isArray(resolved) ? resolved : [resolved];
      const usable: ThemeDefinition[] = [];

      for (const candidate of candidates) {
        if (!looksLikeTheme(candidate)) {
          failed.push({ specifier, reason: 'export is not a theme, an array of themes, or a factory returning either' });
          continue;
        }
        const range = (candidate as { requiresCore?: unknown }).requiresCore;
        if (typeof range === 'string' && range.trim() !== '' && !apiRangeSatisfied(range)) {
          // Refused at the door rather than deep at render time, where the
          // symptom is a stack trace instead of a sentence.
          failed.push({
            specifier,
            reason: `theme "${candidate.id}" requires core "${range}", but this host provides API ${MANIFEST_API_VERSION}`,
          });
          continue;
        }
        if (themeIdIsReserved(candidate.id, bundledIds)) {
          failed.push({ specifier, reason: `theme id "${candidate.id}" is a built-in theme's and cannot be replaced` });
          continue;
        }
        if (claimed.has(candidate.id)) {
          // Two packages claiming one id means whichever loaded last silently
          // wins, and the operator has no way to tell which they are looking at.
          failed.push({ specifier, reason: `theme id "${candidate.id}" was already provided by another package` });
          continue;
        }
        claimed.add(candidate.id);
        usable.push(candidate);
      }

      themes.push(...usable);
    } catch (err) {
      failed.push({ specifier, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  return { themes, failed };
}
