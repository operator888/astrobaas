/**
 * Child themes (C-170).
 *
 * ## What a child theme is for
 *
 * "Marquee, but our colours and our own footer." Today that means copying the
 * whole theme, and the copy stops receiving every later fix to the original —
 * which is the failure WordPress child themes were invented to solve twenty
 * years ago and the reason this row exists.
 *
 * A child declares `extends: 'marquee'` and supplies only what differs. Every
 * slot, token, pattern and rule it does not mention comes from the parent, so
 * an improvement to the parent reaches the child.
 *
 * ## The rules, and why each is the way it is
 *
 * **Components: child wins per slot.** A child overriding `Footer` keeps the
 * parent's `Header`. Merging component-by-component rather than wholesale is
 * the entire feature.
 *
 * **Tokens: child wins per LEAF.** `ThemeConfig` is nested — `colors`,
 * `typography` — so a top-level merge would let a child that sets one colour
 * replace the parent's entire palette and blank its type scale. Merged
 * recursively, so a child overriding `colors.primary` keeps everything else the
 * parent chose. This is the same "blank is not a translation" rule the
 * per-locale settings needed, and the same mistake would look like a theme
 * half-losing its design.
 *
 * **CSS: parent first, then child.** Concatenated rather than replaced, so a
 * child's rule wins by ordinary cascade order without needing `!important`. A
 * child that genuinely wants to drop a parent rule can override the property.
 *
 * **A blank is not a value.** `''`, `null` and `undefined` in a child are
 * "inherit", not "clear" — the same rule the per-locale settings use, and for
 * the same reason: a half-filled override must not blank what it did not fill.
 * `false` and `0` ARE values and do replace. A child that wants a parent's
 * token gone sets it to something, because "no colour" is not a colour and the
 * downstream `|| '#ffffff'` fallbacks would put the default back anyway.
 *
 * **Patterns: parent's, then the child's, child wins on a duplicate name.**
 * Losing the parent's patterns would leave an editor's inserter mysteriously
 * shorter after switching to a child theme.
 *
 * ## A broken chain never takes the site down
 *
 * A missing parent, or a cycle, resolves to the child plus WHATEVER ANCESTORS
 * WERE REACHED before the chain broke, with a loud log — not to a blank page,
 * and not to a silent stock look that leaves an operator wondering where their
 * theme went. Theming is decoration; a site that will not render is an outage.
 *
 * (An earlier version of this note said "the child ALONE". That was wrong, and
 * the behaviour is the better of the two: a three-level chain whose GRANDparent
 * is missing still gets its parent's design rather than losing both.)
 */
import type { ThemeDefinition } from '../core/define';
import type { ThemeConfig } from '../core/models';

/**
 * Deep-merge `source` over `target`, per leaf.
 *
 * Plain objects recurse; everything else replaces. `__proto__` and friends are
 * skipped — a theme definition can come from an external npm package, and a key
 * that reparents the merge target is not a token.
 */
function mergeDeep(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source ?? {})) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (value === undefined || value === null || value === '') continue;
    const existing = target[key];
    if (isPlainObject(value) && isPlainObject(existing)) {
      const next = { ...(existing as Record<string, unknown>) };
      mergeDeep(next, value as Record<string, unknown>);
      target[key] = next;
    } else if (isPlainObject(value)) {
      const next: Record<string, unknown> = {};
      mergeDeep(next, value as Record<string, unknown>);
      target[key] = next;
    } else if (Array.isArray(value)) {
      // Same reasoning as the patterns above: a shallow copy, so the flattened
      // definition never shares an array with a theme module.
      target[key] = [...value];
    } else {
      target[key] = value;
    }
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Overlay one settings object on another, per leaf.
 *
 * Exported because the STORED theme row and the INHERITED defaults have to be
 * combined, and combining them wholesale was the bug: `/theme.css` read the DB
 * row alone, which is seeded from a child theme's OWN settings — so a child
 * that set one colour rendered with no secondary colour, no type scale and no
 * radius, and the per-leaf merge this module exists for had no runtime effect
 * whatsoever.
 *
 * Base is the inherited default; overlay is what the operator customised.
 */
export function mergeThemeSettings<T>(base: unknown, overlay: unknown): T {
  const out: Record<string, unknown> = {};
  if (isPlainObject(base)) mergeDeep(out, base);
  if (isPlainObject(overlay)) mergeDeep(out, overlay);
  return out as T;
}

/** How deep a chain may go. Beyond this it is a mistake, not a design. */
export const MAX_THEME_DEPTH = 5;

export interface ThemeChain {
  /** Root first, the theme itself last. Always at least one entry. */
  chain: ThemeDefinition[];
  /** Why the chain stopped short, for the log and the admin screen. */
  problem?: string;
}

/**
 * Walk a theme's ancestors, root first.
 *
 * `lookup` is injected so this is pure and testable, and so the same function
 * serves bundled themes, externally loaded ones, and a test's fixtures.
 */
export function themeChain(
  theme: ThemeDefinition | undefined,
  lookup: (id: string) => ThemeDefinition | undefined,
): ThemeChain {
  if (!theme) return { chain: [] };

  const chain: ThemeDefinition[] = [theme];
  const seen = new Set<string>([theme.id]);
  let problem: string | undefined;
  let current = theme;

  while (current.extends) {
    const parentId = String(current.extends);
    if (seen.has(parentId)) {
      // A cycle. Stopping here rather than throwing means the child still
      // renders — with its own definition and whatever ancestors were reached
      // before the loop closed.
      problem = `theme "${current.id}" extends "${parentId}", which is already in its own ancestry`;
      break;
    }
    if (chain.length >= MAX_THEME_DEPTH) {
      // `chain` already holds the theme itself, so this is MAX_THEME_DEPTH
      // levels in total — the theme plus MAX_THEME_DEPTH - 1 ancestors. Saying
      // "more than 5 ancestors" was off by one and sent anybody counting their
      // own chain looking for a sixth that was never read.
      problem = `theme "${theme.id}" has more than ${MAX_THEME_DEPTH - 1} ancestors`;
      break;
    }
    const parent = lookup(parentId);
    if (!parent) {
      // The common real failure: a child installed without its parent. Named
      // precisely, because "the theme looks wrong" is not a debuggable report.
      problem = `theme "${current.id}" extends "${parentId}", which is not installed`;
      break;
    }
    seen.add(parentId);
    chain.push(parent);
    current = parent;
  }

  // Root first: later entries override earlier ones, which is the order every
  // merge below reads in.
  chain.reverse();
  return problem ? { chain, problem } : { chain };
}

/**
 * Flatten a chain into one definition.
 *
 * The result keeps the CHILD's identity — id, name, version, author — because
 * that is the theme the operator activated and the one whose name belongs on
 * the admin screen.
 */
export function flattenTheme(chain: readonly ThemeDefinition[]): ThemeDefinition | undefined {
  if (!chain.length) return undefined;
  const child = chain[chain.length - 1];

  const components: Record<string, unknown> = {};
  const settings: Record<string, unknown> = {};
  const cssParts: string[] = [];
  const patterns: any[] = [];
  const byName = new Map<string, number>();

  for (const level of chain) {
    // Per SLOT, not wholesale: a child overriding Footer keeps the parent's
    // Header, which is the entire point of a child theme.
    for (const [name, component] of Object.entries(level.components ?? {})) {
      if (component != null) components[name] = component;
    }
    // Per LEAF: ThemeConfig is nested, so a shallow merge would let a child
    // that sets one colour replace the parent's whole palette.
    mergeDeep(settings, (level.settings ?? {}) as unknown as Record<string, unknown>);
    if (level.css) cssParts.push(`/* astrobaas:theme ${level.id} */\n${level.css}`);
    for (const pattern of level.patterns ?? []) {
      // COPIED, not aliased. `flattenTheme` runs per resolution and its result
      // is handed to the editor's inserter; pushing the parent module's own
      // object means an in-place edit or sort downstream would corrupt the
      // theme module for the life of the process. Nothing does that today,
      // which is exactly why it would be found late.
      const copy = { ...pattern };
      const existing = byName.get(pattern.name);
      if (existing === undefined) { byName.set(pattern.name, patterns.length); patterns.push(copy); }
      else patterns[existing] = copy;
    }
  }

  return {
    ...child,
    // The flattened theme has no parent left: it carries the whole chain's
    // settings, which is exactly the root shape. Saying so keeps every reader
    // of a resolved theme (the admin swatches, /theme.css, the seed) typed
    // against a complete palette rather than a child's fragment.
    extends: undefined,
    components: components as ThemeDefinition['components'],
    settings: settings as unknown as ThemeConfig,
    // Parent first, so a child's rule wins by ordinary cascade order and does
    // not need `!important`.
    css: cssParts.join('\n\n'),
    patterns,
  };
}

/**
 * The one call a caller makes: resolve a theme with its ancestry applied.
 *
 * Returns the flattened definition plus any problem, so the caller can log it
 * once rather than every consumer re-deriving it.
 */
export function resolveInheritance(
  theme: ThemeDefinition | undefined,
  lookup: (id: string) => ThemeDefinition | undefined,
): { definition: ThemeDefinition | undefined; problem?: string; ancestry: string[] } {
  const { chain, problem } = themeChain(theme, lookup);
  return {
    definition: flattenTheme(chain),
    problem,
    // Root first, matching the chain — this is what the admin screen shows as
    // "based on".
    ancestry: chain.map((t) => t.id),
  };
}
