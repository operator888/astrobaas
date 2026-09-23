/**
 * Declarative plugin manifests — the runtime-installable plugin tier.
 *
 * A manifest is **data, not code**. It is validated against this schema and then
 * interpreted by subsystems that already exist (the `head_tags` and
 * `plugin_styles` hooks, the content-type registry, the webhook engine). Nothing
 * is ever `eval`'d, `vm`'d, or dynamically imported, so installing one from the
 * admin UI does not hand the server arbitrary code — which is the whole point:
 * it keeps the "no arbitrary-code-upload surface" property while still letting an
 * operator add capability without a rebuild. Code plugins remain build-time only
 * (see PLUGIN_DEVELOPMENT.md).
 *
 * Because manifests arrive from outside the trust boundary, every field is
 * validated here — including URL schemes and SSRF-unsafe webhook targets — and
 * `headTags` deliberately takes STRUCTURED descriptors rather than raw HTML, so
 * a manifest cannot inject markup even before sanitization.
 *
 * @alpha
 */
import type { ContentTypeDefinition, ContentTypeField } from './content-types';
import type { FieldRule } from '../lib/validate';
import { isValidRange } from './semver-range';
import { escapeHtml as escapeAttr } from '../lib/escape-html';
import { buildFieldRule, buildFieldPresentation, buildSteps } from './field-rule-build';

/**
 * Manifest API version implemented by this host. Manifests declare the range
 * they work with via `astrobaasApi`; a mismatched major is refused rather than
 * silently half-working.
 */
export const MANIFEST_API_VERSION = '1.0.0';

/** A `<meta>` or `<link>` tag contributed to <head> on public pages. */
export interface ManifestHeadTag {
  tag: 'meta' | 'link';
  attrs: Record<string, string>;
}

export interface ManifestWebhook {
  /** A WEBHOOK_EVENTS name, or "*" for all. */
  event: string;
  url: string;
}

/**
 * A section contributed by an installed plugin.
 *
 * The class is not the plugin's to choose: the host derives it as
 * `ab-x-<pluginId>-<name>`, so a plugin cannot shadow a core section or another
 * plugin's, and stored content always names its origin.
 */
export interface ManifestSection {
  /** kebab-case, unique within the plugin. */
  name: string;
  label: string;
  description?: string;
  /**
   * The markup inserted into the editor.
   *
   * Must use ONLY the plugin's own namespaced classes and must survive the
   * sanitizer byte-for-byte — enforced at install, with the stripped markup
   * shown in the rejection so the author can see exactly what was removed.
   */
  template: string;
  /**
   * Styles for this section. Every selector must begin with the plugin's own
   * namespace, which is what bounds a plugin's CSS to the markup it
   * contributed rather than the whole document.
   */
  css?: string;
  /**
   * Variants the editor offers for this section, as `{ group: [values] }`.
   *
   * The editor renders one `<select>` per group and applies a class. That
   * class is NAMESPACED TO THE PLUGIN — `ab-x-<plugin>-<group>-<value>` — and
   * that is the whole reason this needs validating rather than trusting.
   * Core's own sections produce `ab-align-center` from `{ align: ['center'] }`;
   * a plugin declaring the same group must NOT be able to emit that class,
   * because it is styled by core CSS the plugin does not control. Same rule
   * the template and the stylesheet already obey, applied to the third place a
   * class can come from.
   */
  modifiers?: Record<string, string[]>;
}

export interface ManifestCapabilities {
  /** Structured <meta>/<link> tags for public pages. */
  headTags?: ManifestHeadTag[];
  /** CSS appended to /plugins.css. */
  css?: string;
  /** Custom collections, registered exactly like a code plugin's. */
  contentTypes?: ContentTypeDefinition[];
  /** Outbound webhook subscriptions. */
  webhooks?: ManifestWebhook[];
  /** Editor sections, namespaced to this plugin. */
  sections?: ManifestSection[];
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  homepage?: string;
  /** Semver range of the manifest API this plugin targets, e.g. "^1.0.0". */
  astrobaasApi?: string;
  /**
   * Other plugins this one needs, as `{ pluginId: semverRange }`.
   *
   * The point of the whole feature: a vertical pack ("optical prescriptions")
   * declaring that it needs a general one ("commerce") at a compatible version.
   *
   * Installing with a dependency unmet is ALLOWED — an operator cannot be made
   * to install in topological order — but ACTIVATING is refused until every
   * dependency is installed, active and in range, and the dependency itself
   * cannot then be deactivated or uninstalled while a dependent is running.
   * See `src/lib/plugin-dependencies.ts`.
   *
   * Ranges use the subset in `src/core/semver-range.ts`. One that this host
   * cannot parse is a validation error rather than a range that silently never
   * matches.
   */
  dependencies?: Record<string, string>;
  capabilities: ManifestCapabilities;
}

export interface ManifestValidationResult {
  ok: boolean;
  errors: string[];
  /** Present only when ok — normalized/frozen copy safe to persist. */
  manifest?: PluginManifest;
}

/* ---------- limits ---------- */

export const MANIFEST_LIMITS = {
  css: 20_000,
  headTags: 20,
  contentTypes: 10,
  fieldsPerType: 40,
  webhooks: 10,
  stringAttr: 500,
  sections: 12,
  /** A plugin that needs a dozen others is an architecture problem, not a manifest. */
  dependencies: 12,
  /** Per section. Small on purpose: a section is a skeleton, not a page. */
  sectionTemplate: 4_000,
  sectionCss: 8_000,
} as const;

/**
 * Every capability key, in one place.
 *
 * Adding a capability means adding it here and writing its validation; the
 * normalized manifest then carries it automatically.
 */
export const KNOWN_CAPABILITIES = [
  'headTags', 'css', 'contentTypes', 'webhooks', 'sections',
] as const satisfies readonly (keyof ManifestCapabilities)[];

const ID_RE = /^[a-z][a-z0-9-]{1,40}$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const TYPE_NAME_RE = /^[a-z][a-z0-9-]{1,40}$/;

/** Content-type names reserved by built-in collections/routes. */
const RESERVED_TYPES = new Set([
  'post', 'posts', 'category', 'categories', 'user', 'users', 'media', 'theme',
  'themes', 'setting', 'settings', 'plugin', 'plugins', 'auth', 'backup',
  'content', 'search', 'newsletter', 'contact', 'messages', 'changes',
]);


/* ---------- section helpers (string work only — no DOM, no CSS parser) ---------- */

/** Every class named in a template's `class="..."` attributes. */
function classesInTemplate(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/\sclass\s*=\s*"([^"]*)"/g)) {
    for (const cls of m[1].split(/\s+/)) if (cls) out.push(cls);
  }
  return out;
}

/**
 * Selectors in `css` that are not scoped under `prefix`.
 *
 * A single-pass state machine rather than a regex, and that is the whole point.
 * The previous version stripped comments with `/\/\*[\s\S]*?\*\//g` before
 * counting braces, which is blind to CSS strings — so this got through:
 *
 *     .ab-x-evil-hero { content: "/*" }
 *     body { display: none !important }
 *     .ab-x-evil-hero { content: "* / " }     // (without the spaces)
 *
 * The regex treated everything between the two quoted fragments as one comment
 * and deleted it, leaving a single scoped rule and zero errors. A browser parses
 * `/*` inside a string as data, so it saw three rules and `body{display:none}`
 * was live — on `/plugins.css`, which `BaseLayout` links from the ADMIN as well
 * as the public site. Defacement, and a UI-redress surface over CSRF-bearing
 * forms.
 *
 * So strings are tracked as first-class state: inside `"…"` or `'…'` (with
 * backslash escapes) nothing is punctuation. Comments are recognised only
 * outside strings, and braces only outside both.
 *
 * Depth matters too. A block opened by a SELECTOR contains declarations, and any
 * nested rule inside it inherits the parent's scoping, so its contents are not
 * re-checked. A block opened by a conditional at-rule (`@media` and friends)
 * contains ordinary rules that are NOT otherwise scoped, so those are checked.
 *
 * It errs toward REPORTING: anything it cannot confidently classify is returned
 * as unscoped, so the failure mode is "a valid plugin is asked to be more
 * explicit", not "an unscoped selector restyles the admin".
 */
export function unscopedSelectors(css: string, prefix: string): string[] {
  const bad: string[] = [];
  /** What opened each currently-open block: a conditional at-rule, or a selector. */
  const stack: Array<'conditional' | 'rule'> = [];
  let buf = '';
  let inComment = false;
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < css.length; i++) {
    const ch = css[i];

    if (inComment) {
      if (ch === '*' && css[i + 1] === '/') { inComment = false; i++; }
      continue;
    }

    if (quote) {
      // A backslash escapes the next character, so `"\""` does not end here.
      if (ch === '\\') { buf += ch + (css[i + 1] ?? ''); i++; continue; }
      if (ch === quote) quote = null;
      buf += ch;
      continue;
    }

    if (ch === '/' && css[i + 1] === '*') { inComment = true; i++; continue; }
    if (ch === '"' || ch === "'") { quote = ch; buf += ch; continue; }

    if (ch === '{') {
      const head = buf.trim();
      buf = '';
      // Inside a selector's own block we are looking at declarations; a nested
      // rule there is already scoped by its ancestor.
      if (stack.length && stack[stack.length - 1] === 'rule') { stack.push('rule'); continue; }
      if (!head) { stack.push('rule'); continue; }
      if (head.startsWith('@')) {
        // Conditional groups wrap ordinary rules, so their contents still get
        // checked. Anything else that takes a block — @font-face, @keyframes —
        // defines names rather than matching the document, and is refused
        // because it is not scopable.
        if (/^@(media|supports|container|layer)\b/i.test(head)) stack.push('conditional');
        else { bad.push(head); stack.push('rule'); }
        continue;
      }
      for (const sel of head.split(',')) {
        const one = sel.trim();
        if (one && !one.startsWith(prefix)) bad.push(one);
      }
      stack.push('rule');
      continue;
    }

    if (ch === '}') { stack.pop(); buf = ''; continue; }
    buf += ch;
  }

  // An unterminated string or comment means the author's CSS is malformed and
  // the browser will recover differently from this scanner. Refuse rather than
  // guess which of the two is right.
  if (quote || inComment) bad.push('(unterminated string or comment)');
  return bad;
}

/** Attributes allowed per head tag — mirrors the head sanitizer's allowlist. */
const HEAD_ATTRS: Record<ManifestHeadTag['tag'], Set<string>> = {
  meta: new Set(['name', 'property', 'content', 'charset']),
  link: new Set(['rel', 'href', 'type', 'sizes', 'as', 'crossorigin', 'media']),
};

// Field rule types accepted in a declarative content type — the SHARED list.
// This file used to keep its own, and it was missing `ref` and `media`, so a
// plugin could not declare the two kinds that make a collection real while the
// admin builder beside it could.

/* ---------- helpers ---------- */

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Minimal semver-range check: compares MAJOR only (plus an exact-match fast
 * path). Deliberately simple — the contract we care about is "same major".
 * Accepts "1", "1.2.3", "^1.0.0", "~1.2", "1.x".
 */
export function apiRangeSatisfied(range: string | undefined, hostVersion = MANIFEST_API_VERSION): boolean {
  if (!range || typeof range !== 'string') return true; // unspecified = assume current
  const cleaned = range.trim().replace(/^[\^~>=<\s]+/, '');
  const wantedMajor = Number.parseInt(cleaned.split('.')[0] ?? '', 10);
  if (!Number.isFinite(wantedMajor)) return false;
  const hostMajor = Number.parseInt(hostVersion.split('.')[0] ?? '', 10);
  return wantedMajor === hostMajor;
}

/** True when a URL is safe to store from a manifest (https, or same-origin relative). */
function isSafeUrl(v: string, { allowRelative = true } = {}): boolean {
  if (allowRelative && v.startsWith('/') && !v.startsWith('//')) return true;
  try {
    const u = new URL(v);
    return u.protocol === 'https:';
  } catch {
    return false;
  }
}

/* ---------- validation ---------- */

/**
 * Validate an untrusted manifest. Pure — no I/O, no DNS — so it runs in the CLI,
 * in tests, and on the install path identically.
 *
 * `checkWebhookUrl` is injected rather than imported so this module stays free of
 * server-only dependencies (the CLI and the browser can both call it).
 */
export function validateManifest(
  input: unknown,
  opts: { checkWebhookUrl?: (url: string) => { ok: boolean; reason?: string } } = {},
): ManifestValidationResult {
  const errors: string[] = [];
  const push = (m: string) => errors.push(m);

  if (!isPlainObject(input)) {
    return { ok: false, errors: ['Manifest must be a JSON object.'] };
  }

  const { id, name, version, description, author, homepage, astrobaasApi, dependencies, capabilities } = input as Record<string, unknown>;

  if (typeof id !== 'string' || !ID_RE.test(id)) push('`id` must be kebab-case, 2–41 chars, starting with a letter.');
  if (typeof name !== 'string' || !name.trim() || name.length > 100) push('`name` is required (1–100 chars).');
  if (typeof version !== 'string' || !VERSION_RE.test(version)) push('`version` must be semver (e.g. "1.0.0").');
  if (description !== undefined && (typeof description !== 'string' || description.length > 500)) push('`description` must be a string ≤500 chars.');
  if (author !== undefined && (typeof author !== 'string' || author.length > 100)) push('`author` must be a string ≤100 chars.');
  if (homepage !== undefined && (typeof homepage !== 'string' || !isSafeUrl(homepage, { allowRelative: false }))) push('`homepage` must be an https URL.');
  if (astrobaasApi !== undefined && typeof astrobaasApi !== 'string') push('`astrobaasApi` must be a semver range string.');
  else if (!apiRangeSatisfied(astrobaasApi as string | undefined)) {
    push(`\`astrobaasApi\` "${String(astrobaasApi)}" is incompatible with this host (manifest API ${MANIFEST_API_VERSION}).`);
  }

  // --- dependencies ---
  if (dependencies !== undefined) {
    if (!isPlainObject(dependencies)) push('`dependencies` must be an object of { pluginId: semverRange }.');
    else {
      const entries = Object.entries(dependencies);
      if (entries.length > MANIFEST_LIMITS.dependencies) {
        push(`Too many dependencies (max ${MANIFEST_LIMITS.dependencies}).`);
      }
      for (const [depId, range] of entries) {
        if (!ID_RE.test(depId)) {
          push(`dependencies: "${depId}" is not a valid plugin id.`);
          continue;
        }
        if (typeof id === 'string' && depId === id) {
          push('dependencies: a plugin cannot depend on itself.');
          continue;
        }
        if (typeof range !== 'string' || !isValidRange(range)) {
          // Reported rather than left to never match: a range this host cannot
          // parse would otherwise make the dependency permanently unsatisfiable
          // with no explanation anywhere.
          push(
            `dependencies.${depId}: "${String(range)}" is not a supported version range. `
            + 'Use ^1.2.3, ~1.2.3, >=1.2.3, 1.2.3 or *.',
          );
        }
      }
    }
  }

  if (!isPlainObject(capabilities)) {
    push('`capabilities` must be an object.');
    return { ok: false, errors };
  }

  const caps = capabilities as Record<string, unknown>;
  // The single list of capability keys. It drives BOTH the unknown-key check
  // and the normalized copy below, because keeping two such lists in step by
  // hand is how `sections` was validated and then silently dropped on the way
  // out — the same "schema names it, the copy forgets it" bug this codebase has
  // now hit four times.
  // Widened to `string[]` for the membership test below: `KNOWN_CAPABILITIES`
  // is a readonly tuple of literals, so `.includes(someString)` is a type error
  // — narrowing that the precise type gives the normalized copy, and that the
  // "is this arbitrary key known?" question does not want.
  const known: readonly string[] = KNOWN_CAPABILITIES;
  for (const key of Object.keys(caps)) {
    if (!known.includes(key)) push(`Unknown capability "${key}". Supported: ${known.join(', ')}.`);
  }
  if (!known.some((k) => caps[k] !== undefined)) push('`capabilities` must declare at least one of: ' + known.join(', ') + '.');

  // --- headTags ---
  if (caps.headTags !== undefined) {
    if (!Array.isArray(caps.headTags)) push('`capabilities.headTags` must be an array.');
    else if (caps.headTags.length > MANIFEST_LIMITS.headTags) push(`Too many headTags (max ${MANIFEST_LIMITS.headTags}).`);
    else {
      caps.headTags.forEach((t, i) => {
        if (!isPlainObject(t)) return push(`headTags[${i}] must be an object.`);
        const tag = t.tag;
        if (tag !== 'meta' && tag !== 'link') return push(`headTags[${i}].tag must be "meta" or "link".`);
        if (!isPlainObject(t.attrs)) return push(`headTags[${i}].attrs must be an object.`);
        for (const [k, v] of Object.entries(t.attrs)) {
          if (!HEAD_ATTRS[tag].has(k)) push(`headTags[${i}]: attribute "${k}" is not allowed on <${tag}>.`);
          else if (typeof v !== 'string' || v.length > MANIFEST_LIMITS.stringAttr) push(`headTags[${i}].attrs.${k} must be a string ≤${MANIFEST_LIMITS.stringAttr} chars.`);
          else if ((k === 'href' || k === 'src') && !isSafeUrl(v)) push(`headTags[${i}].attrs.${k} must be an https or root-relative URL.`);
        }
      });
    }
  }

  // --- css ---
  if (caps.css !== undefined) {
    if (typeof caps.css !== 'string') push('`capabilities.css` must be a string.');
    else if (caps.css.length > MANIFEST_LIMITS.css) push(`\`capabilities.css\` exceeds ${MANIFEST_LIMITS.css} chars.`);
  }

  // --- contentTypes ---
  if (caps.contentTypes !== undefined) {
    if (!Array.isArray(caps.contentTypes)) push('`capabilities.contentTypes` must be an array.');
    else if (caps.contentTypes.length > MANIFEST_LIMITS.contentTypes) push(`Too many contentTypes (max ${MANIFEST_LIMITS.contentTypes}).`);
    else {
      caps.contentTypes.forEach((ct, i) => {
        if (!isPlainObject(ct)) return push(`contentTypes[${i}] must be an object.`);
        const tname = ct.name;
        if (typeof tname !== 'string' || !TYPE_NAME_RE.test(tname)) return push(`contentTypes[${i}].name must be kebab-case, 2–41 chars.`);
        if (RESERVED_TYPES.has(tname)) push(`contentTypes[${i}].name "${tname}" is reserved.`);
        if (typeof ct.label !== 'string' || !ct.label.trim()) push(`contentTypes[${i}].label is required.`);
        // Read policy. Optional, and ABSENT MEANS PRIVATE — the same
        // deny-by-default the programmatic registerContentType() applies. An
        // unrecognised value is an error rather than a silent fallback, because
        // both possible fallbacks are wrong: to `public` it leaks, to `staff` a
        // storefront breaks with no message saying why.
        if (ct.visibility !== undefined && ct.visibility !== 'public' && ct.visibility !== 'staff') {
          push(`contentTypes[${i}].visibility must be "public" or "staff".`);
        }
        // Write policy. Absent means staff-only. An unrecognised value is an
        // error for the same reason `visibility` gets one, and more sharply:
        // the wrong fallback here opens an anonymous write endpoint on the
        // internet because somebody typed "publik".
        if (ct.writable !== undefined && ct.writable !== 'public' && ct.writable !== 'staff') {
          push(`contentTypes[${i}].writable must be "public" or "staff".`);
        }
        if (ct.notifyOnSubmission !== undefined && typeof ct.notifyOnSubmission !== 'boolean') {
          push(`contentTypes[${i}].notifyOnSubmission must be true or false.`);
        }
        if (ct.moderated !== undefined && typeof ct.moderated !== 'boolean') {
          push(`contentTypes[${i}].moderated must be true or false.`);
        }
        if (!Array.isArray(ct.fields) || ct.fields.length === 0) return push(`contentTypes[${i}].fields must be a non-empty array.`);
        if (ct.fields.length > MANIFEST_LIMITS.fieldsPerType) return push(`contentTypes[${i}] has too many fields (max ${MANIFEST_LIMITS.fieldsPerType}).`);
        const steps = buildSteps(ct.steps, `contentTypes[${i}]`, (m) => push(`${m}.`));
        const stepCountForType = Math.max(1, (steps ?? []).length || 1);
        const declared = new Set<string>();
        ct.fields.forEach((f: unknown, j: number) => {
          if (!isPlainObject(f)) return push(`contentTypes[${i}].fields[${j}] must be an object.`);
          if (typeof f.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(f.name)) push(`contentTypes[${i}].fields[${j}].name is invalid.`);
          // The FULL rule, through the same builder the admin door uses. This
          // check used to be `rule.type is a known string` and nothing else,
          // so an enum with a NUL in a value, a `ref` naming garbage, an
          // `array` with no `of` and a `min` above its `max` all passed here
          // and reached validate() unexamined.
          buildFieldRule(f.rule, `contentTypes[${i}].fields[${j}]`, (m) => push(`${m}.`));
          buildFieldPresentation(f, `contentTypes[${i}].fields[${j}]`, stepCountForType, declared, (m) => push(`${m}.`));
          if (typeof f.name === 'string') declared.add(f.name);
        });
      });
    }
  }

  // --- webhooks ---
  if (caps.webhooks !== undefined) {
    if (!Array.isArray(caps.webhooks)) push('`capabilities.webhooks` must be an array.');
    else if (caps.webhooks.length > MANIFEST_LIMITS.webhooks) push(`Too many webhooks (max ${MANIFEST_LIMITS.webhooks}).`);
    else {
      caps.webhooks.forEach((w, i) => {
        if (!isPlainObject(w)) return push(`webhooks[${i}] must be an object.`);
        if (typeof w.event !== 'string' || !w.event.trim()) push(`webhooks[${i}].event is required.`);
        if (typeof w.url !== 'string' || !isSafeUrl(w.url, { allowRelative: false })) {
          push(`webhooks[${i}].url must be an https URL.`);
        } else if (opts.checkWebhookUrl) {
          // SSRF: refuse internal delivery targets, same guard as the API.
          const guard = opts.checkWebhookUrl(w.url);
          if (!guard.ok) push(`webhooks[${i}].url rejected: ${guard.reason ?? 'not allowed'}`);
        }
      });
    }
  }

  // --- sections ---
  //
  // Shape only. The decisive check — that the template survives the sanitizer
  // byte-for-byte — needs `sanitize-html` and therefore lives in
  // lib/manifest-sections.ts, which the install path runs. Keeping it out of
  // here is what lets `astrobaas/core` stay dependency-free for plugin authors.
  if (caps.sections !== undefined) {
    if (!Array.isArray(caps.sections)) push('`capabilities.sections` must be an array.');
    else if (caps.sections.length > MANIFEST_LIMITS.sections) push(`Too many sections (max ${MANIFEST_LIMITS.sections}).`);
    else {
      const pluginId = typeof id === 'string' ? id : '';
      const seen = new Set<string>();
      caps.sections.forEach((sec, i) => {
        if (!isPlainObject(sec)) return push(`sections[${i}] must be an object.`);
        const sname = sec.name;
        if (typeof sname !== 'string' || !TYPE_NAME_RE.test(sname)) {
          return push(`sections[${i}].name must be kebab-case, 2-41 chars.`);
        }
        if (seen.has(sname)) push(`sections[${i}].name "${sname}" is declared twice.`);
        seen.add(sname);
        if (typeof sec.label !== 'string' || !sec.label.trim()) push(`sections[${i}].label is required.`);
        if (sec.description !== undefined && typeof sec.description !== 'string') {
          push(`sections[${i}].description must be a string.`);
        }
        // Variants. Bounded and charset-checked, because each one becomes a
        // class in somebody's stored content — and namespaced by the editor,
        // so a plugin cannot mint `ab-align-center` and inherit core styling
        // it does not control.
        if (sec.modifiers !== undefined) {
          if (!isPlainObject(sec.modifiers)) {
            push(`sections[${i}].modifiers must be an object of { group: [values] }.`);
          } else {
            const groups = Object.entries(sec.modifiers);
            if (groups.length > 6) push(`sections[${i}] has too many modifier groups (max 6).`);
            for (const [group, values] of groups) {
              // STRICT kebab-case: no leading, trailing or doubled hyphen.
              // The loose class [a-z0-9-]* accepted `tone-` and `da--rk`,
              // whose composed class the content sanitizer then STRIPS on save
              // — the variant silently vanishing, the editor-shows-it /
              // storage-drops-it split this codebase keeps finding.
              const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
              if (group.length > 21 || !KEBAB.test(group)) {
                push(`sections[${i}].modifiers key "${group}" must be kebab-case (no leading, trailing or doubled hyphen), 1-21 chars.`);
                continue;
              }
              if (!Array.isArray(values) || values.length === 0 || values.length > 12) {
                push(`sections[${i}].modifiers.${group} must be 1-12 values.`);
                continue;
              }
              for (const v of values) {
                if (typeof v !== 'string' || v.length > 21 || !KEBAB.test(v)) {
                  push(`sections[${i}].modifiers.${group} value ${JSON.stringify(v)} must be kebab-case (no leading, trailing or doubled hyphen), 1-21 chars.`);
                }
              }
            }
          }
        }
        if (typeof sec.template !== 'string' || !sec.template.trim()) {
          return push(`sections[${i}].template is required.`);
        }
        if (sec.template.length > MANIFEST_LIMITS.sectionTemplate) {
          push(`sections[${i}].template exceeds ${MANIFEST_LIMITS.sectionTemplate} chars.`);
        }
        // The root class is the host's to assign, not the plugin's to claim.
        const root = `ab-x-${pluginId}-${sname}`;
        if (!sec.template.includes(root)) {
          push(`sections[${i}].template must carry its own root class "${root}".`);
        }
        // Every ab- class in the template must belong to this plugin. A plugin
        // reusing `ab-hero` would inherit core styling it does not control and
        // would break the moment that section changed.
        for (const cls of classesInTemplate(sec.template)) {
          if (cls.startsWith('ab-') && !cls.startsWith(`ab-x-${pluginId}-`)) {
            push(`sections[${i}].template uses "${cls}"; a plugin may only use ab-x-${pluginId}-* classes.`);
          }
        }
        if (sec.css !== undefined) {
          if (typeof sec.css !== 'string') return push(`sections[${i}].css must be a string.`);
          if (sec.css.length > MANIFEST_LIMITS.sectionCss) {
            push(`sections[${i}].css exceeds ${MANIFEST_LIMITS.sectionCss} chars.`);
          }
          for (const bad of unscopedSelectors(sec.css, `.ab-x-${pluginId}-`)) {
            push(`sections[${i}].css selector "${bad}" must start with .ab-x-${pluginId}-.`);
          }
        }
      });
    }
  }

  if (errors.length) return { ok: false, errors };

  const manifest: PluginManifest = {
    id: id as string,
    name: (name as string).trim(),
    version: version as string,
    ...(description ? { description: description as string } : {}),
    ...(author ? { author: author as string } : {}),
    ...(homepage ? { homepage: homepage as string } : {}),
    ...(astrobaasApi ? { astrobaasApi: astrobaasApi as string } : {}),
    // Carried through deliberately. `sections` was validated and then dropped
    // here, so the install returned 201 with `capabilities: []` — the fourth
    // time this codebase has hit "the schema names it, the copy forgets it".
    // tests/plugin-dependencies.test.mjs asserts this round-trip.
    ...(dependencies && Object.keys(dependencies).length
      ? { dependencies: dependencies as Record<string, string> }
      : {}),
    // Copied from the same list the validator checked against, so a capability
    // can never be accepted and then dropped before anything can use it.
    capabilities: Object.fromEntries(
      KNOWN_CAPABILITIES.filter((k) => caps[k] !== undefined).map((k) => [k, caps[k]]),
    ) as ManifestCapabilities,
  };
  return { ok: true, errors: [], manifest };
}


/**
 * Render validated head tags to HTML. Attribute values are escaped here; the
 * layout additionally runs the result through the head sanitizer, so this is
 * belt-and-braces rather than the only defence.
 */
export function renderHeadTags(tags: ManifestHeadTag[] | undefined): string {
  if (!tags?.length) return '';
  return tags
    .map((t) => {
      const attrs = Object.entries(t.attrs)
        .filter(([k]) => HEAD_ATTRS[t.tag]?.has(k))
        .map(([k, v]) => `${k}="${escapeAttr(String(v))}"`)
        .join(' ');
      return attrs ? `<${t.tag} ${attrs}>` : '';
    })
    .filter(Boolean)
    .join('');
}

/** Build the ContentTypeField[] a manifest declares (already validated). */
/**
 * Manifest capability → the definition `registerContentType()` actually gets.
 *
 * ## The copy is deliberate, and so is the type on it
 *
 * A manifest arrives from outside the trust boundary, so this rebuilds the
 * definition field by field rather than passing the parsed object through —
 * an unknown key in a hostile manifest never reaches the registry.
 *
 * That hand-written list is also how `visibility` was silently lost. It is
 * declared on `ContentTypeDefinition`, validated by `validateManifest` above
 * (with an explicit error for a bad value), carried correctly through
 * normalization — and then dropped HERE, one line before registration. A
 * manifest declaring `visibility: 'public'` installed cleanly and registered
 * PRIVATE, so the author's storefront got 404 with nothing anywhere to explain
 * it. The failure was silent in exactly the way the surrounding comments argue
 * against.
 *
 * This is the fifth instance of "the schema names it, the copy forgets it"
 * (audit §6), and optional fields are why it keeps happening: omitting one
 * from an object literal is perfectly legal TypeScript.
 *
 * So the local is annotated with a mapped type over `keyof Required<…>`. That
 * strips the `?` markers, which makes every key REQUIRED TO BE PRESENT while
 * leaving each value's type untouched (so `visibility: undefined` is still
 * fine). Adding a field to `ContentTypeDefinition` and forgetting it here is now
 * a compile error instead of a silent drop.
 */
export function manifestContentTypes(m: PluginManifest): ContentTypeDefinition[] {
  return (m.capabilities.contentTypes ?? []).map((ct) => {
    const def: { [K in keyof Required<ContentTypeDefinition>]: ContentTypeDefinition[K] } = {
      name: ct.name,
      label: ct.label,
      labelPlural: ct.labelPlural,
      // REBUILT, not cast. `(ct.fields ?? []) as ContentTypeField[]` was the
      // hole: validateManifest checked only the rule TYPE, so everything else
      // on a manifest's rule object — unknown keys included — travelled
      // straight into the registry and then into validate(). A manifest that
      // has already been validated cannot fail here, so the errors are
      // discarded; a field whose rule cannot be rebuilt is DROPPED rather
      // than passed through, which is the safe direction.
      fields: (() => {
        const declared = new Set<string>();
        const stepsForType = Math.max(1, (ct.steps ?? []).length || 1);
        return (ct.fields ?? []).flatMap((f, j) => {
          const field = f as ContentTypeField;
          const rule = buildFieldRule(field.rule, `contentTypes.fields[${j}]`, () => {});
          if (!rule) return [];
          const presentation = buildFieldPresentation(
            field as unknown as Record<string, unknown>,
            `contentTypes.fields[${j}]`, stepsForType, declared, () => {},
          ) ?? {};
          declared.add(field.name);
          return [{ name: field.name, rule, ...presentation }];
        });
      })(),
      steps: buildSteps(ct.steps, 'contentTypes', () => {}) ?? undefined,
      // Absent stays absent rather than defaulting to 'public' here: the
      // default lives in `contentTypeIsPublic()`, and a second copy of it in
      // this file is the same mistake one level up.
      visibility: ct.visibility,
      // Same reasoning for the write policy: absent means staff-only, and the
      // default belongs in `contentTypeAcceptsPublicWrites()`.
      writable: ct.writable,
      notifyOnSubmission: ct.notifyOnSubmission === true ? true : undefined,
      moderated: ct.moderated === true ? true : undefined,
    };
    return def;
  });
}

export type { ContentTypeDefinition, ContentTypeField, FieldRule };
