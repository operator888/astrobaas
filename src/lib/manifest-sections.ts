/**
 * Plugin sections: the install-time check, and what the editor is offered.
 *
 * The manifest validator (core/manifest.ts) checks shape — names, sizes, that
 * every class is namespaced, that every selector is scoped. It cannot check the
 * one thing that actually matters, because that needs the sanitizer:
 *
 *   **does the template survive `sanitizeHtml` byte-for-byte?**
 *
 * If it does not, installing the plugin adds a section to the palette that
 * quietly loses part of itself on save. The author inserts it, sees it render,
 * and discovers the loss later on a published page. So the install refuses, and
 * refuses with the sanitized output alongside the original — "rejected" is not
 * actionable, "here is what came back and here is what you sent" is.
 *
 * Core stays dependency-free (it is published as `astrobaas/core`), which is
 * why this half lives in lib rather than beside the rest of the validator.
 */
import { sanitizeHtml, sanitizeCustomCss } from './sanitize';
import { pluginSectionClass, pluginSectionSelectorPrefix, pluginModifierPrefix } from '../core/sections';
import { unscopedSelectors } from '../core/manifest';
import type { ManifestSection, PluginManifest } from '../core/manifest';

export interface SectionRejection {
  section: string;
  reason: string;
  /** What was declared. */
  submitted: string;
  /** What the sanitizer returned — the diff, in the only form that helps. */
  sanitized: string;
}

/** A plugin section, resolved to the class the host actually assigned it. */
export interface InstalledSection {
  pluginId: string;
  name: string;
  /** `ab-x-<pluginId>-<name>`. */
  className: string;
  label: string;
  description: string;
  template: string;
  /**
   * Variants the editor offers, `{ group: [values] }`.
   *
   * Carried through so the toolbar can render them. The CLASS the toolbar
   * applies is namespaced with `modifierPrefix` below rather than assembled
   * from the group name alone — otherwise a plugin declaring
   * `{ align: ['center'] }` would emit `ab-align-center`, which is core's own
   * class with core's own styling attached to it.
   */
  modifiers: Record<string, string[]>;
  /** `ab-x-<pluginId>-`. What a modifier class is built from. */
  modifierPrefix: string;
}

/**
 * Check every section a manifest declares.
 *
 * Returns rejections rather than throwing: the install API turns a non-empty
 * list into a 400 naming each one, which is more useful than the first failure.
 */
export function checkManifestSections(
  pluginId: string,
  sections: readonly ManifestSection[] | undefined,
): SectionRejection[] {
  const rejections: SectionRejection[] = [];
  if (!sections?.length) return rejections;

  for (const sec of sections) {
    const cleaned = sanitizeHtml(sec.template);
    if (cleaned !== sec.template) {
      rejections.push({
        section: sec.name,
        reason:
          'the template does not survive the content sanitizer unchanged, so part of it '
          + 'would be discarded the first time an author saved a page using it',
        submitted: sec.template,
        sanitized: cleaned,
      });
      continue;
    }
    // An empty result means the whole thing was stripped — usually a template
    // built from tags the content sanitizer does not allow at all.
    if (!cleaned.trim()) {
      rejections.push({
        section: sec.name,
        reason: 'the template is empty after sanitization',
        submitted: sec.template,
        sanitized: cleaned,
      });
      continue;
    }
    if (sec.css) {
      const scrubbed = sanitizeCustomCss(sec.css);
      if (scrubbed !== sec.css) {
        rejections.push({
          section: sec.name,
          reason: 'the CSS contains something the stylesheet filter removes (@import, an escape attempt, or a javascript: URL)',
          submitted: sec.css,
          sanitized: scrubbed,
        });
      }
    }
  }
  return rejections;
}

/** The sections an installed manifest contributes, ready for the inserter. */
export function installedSections(manifest: PluginManifest): InstalledSection[] {
  return (manifest.capabilities.sections ?? []).map((s) => ({
    pluginId: manifest.id,
    name: s.name,
    className: pluginSectionClass(manifest.id, s.name),
    label: s.label,
    description: s.description ?? '',
    template: s.template,
    modifiers: s.modifiers ?? {},
    modifierPrefix: pluginModifierPrefix(manifest.id),
  }));
}

/**
 * The stylesheet for a manifest's sections.
 *
 * Re-scoped and re-filtered here rather than trusted from install: a row can be
 * edited in the database, and a manifest installed by an older build was
 * checked by an older set of rules. Serving is the last point at which this is
 * still cheap to get right.
 */
export function manifestSectionCss(manifest: PluginManifest): string {
  const prefix = pluginSectionSelectorPrefix(manifest.id);
  const parts: string[] = [];
  for (const sec of manifest.capabilities.sections ?? []) {
    if (!sec.css) continue;
    const scrubbed = sanitizeCustomCss(sec.css);
    // Actually re-run the scoping scanner. This used to be
    // `if (!scrubbed.includes(prefix)) continue`, which is a substring test, not
    // a scoping check: a block that mentioned the prefix once was served in
    // full, unscoped rules and all. So the "second layer" this docstring
    // promises did not exist, and a validator bypass reached the browser
    // unopposed.
    const unscoped = unscopedSelectors(scrubbed, prefix);
    if (unscoped.length) {
      console.warn(
        `[astrobaas] plugin "${manifest.id}" section "${sec.name}": stylesheet not served — `
        + `${unscoped.length} selector(s) outside ${prefix} (${unscoped.slice(0, 3).join(', ')})`,
      );
      continue;
    }
    parts.push(`/* ${manifest.id}: ${sec.name} */\n${scrubbed}`);
  }
  return parts.join('\n');
}
