/**
 * Validating a declarative theme before it is allowed near a live site.
 *
 * A theme manifest is pure data — no code runs — so the risk is not execution.
 * It is three quieter things, and each has its own check here:
 *
 *  1. **A token value that is not a token.** Stored values reach `/theme.css` as
 *     `--primary-color: <value>`. A value carrying `;` or `}` escapes the
 *     declaration and becomes arbitrary CSS. Colours are matched against a
 *     strict pattern and enum scales resolve through an allow-list, so a stored
 *     value can SELECT css but never BE css.
 *  2. **A pattern the sanitizer would rewrite.** Same rule as everywhere else in
 *     this subsystem: what the editor offers must be exactly what the save path
 *     keeps. A pattern that does not survive byte-for-byte is refused with the
 *     sanitized output beside the submitted markup, because "rejected" is not
 *     actionable and a diff is.
 *  3. **Shadowing a bundled theme.** A manifest that claimed `default` would
 *     make the admin show one thing and the renderer resolve another.
 *
 * Everything is returned as errors rather than thrown. Installing is an
 * operator action with a form behind it; a list of what is wrong is worth more
 * than the first failure.
 */
import type { ThemeConfig } from '../core/models';
import {
  THEME_MANIFEST_LIMITS, THEME_MANIFEST_API_VERSION,
  type ThemeManifest,
} from '../core/theme-manifest';
import type { SectionPattern } from '../core/patterns';
import { isWellFormedPattern, unknownSectionsIn } from '../core/patterns';
import { sanitizeHtml, sanitizeThemeCss, MAX_THEME_CSS } from './sanitize';
import { isTokenKey, TOKEN_SCALE_NAMES, type TokenScaleName } from './theme-tokens';

const ID_RE = /^[a-z][a-z0-9-]{1,40}$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
/** #rgb, #rrggbb, #rrggbbaa — nothing that could carry a `;` or `}`. */
const HEX_RE = /^#[0-9a-fA-F]{3,8}$/;
/**
 * A font stack. Letters, digits, spaces, quotes, commas, hyphens — enough for
 * `"Inter", system-ui, sans-serif` and nothing that closes a declaration.
 */
const FONT_RE = /^[a-zA-Z0-9 ,'"\-]{1,120}$/;
/** A length: `16px`, `1.05rem`, `normal`, `0.02em`. */
const LENGTH_RE = /^(normal|[0-9]{1,4}(\.[0-9]{1,3})?(px|rem|em|%)?)$/;

export interface ThemeValidationResult {
  ok: boolean;
  errors: string[];
  /** Present only when ok — normalized and safe to persist. */
  manifest?: ThemeManifest;
  /** Patterns that were dropped, with the sanitizer diff. */
  rejectedPatterns?: { name: string; reason: string; submitted: string; sanitized: string }[];
}

export interface ThemeValidateOptions {
  /**
   * Ids that already exist as compiled-in themes. Passed in rather than
   * imported so this module does not drag the theme registry (and every theme
   * module with it) into the CLI and the tests.
   */
  reservedIds?: readonly string[];
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/** Enum scales resolve through an allow-list; free-form values through a pattern. */
function checkTokens(tokens: unknown, push: (m: string) => void): Partial<ThemeConfig> | undefined {
  if (tokens === undefined) return undefined;
  if (!isPlainObject(tokens)) {
    push('`tokens` must be an object.');
    return undefined;
  }

  const out: Record<string, unknown> = {};

  if (tokens.colors !== undefined) {
    if (!isPlainObject(tokens.colors)) push('`tokens.colors` must be an object.');
    else {
      const colors: Record<string, string> = {};
      for (const [key, value] of Object.entries(tokens.colors)) {
        if (typeof value !== 'string' || !HEX_RE.test(value.trim())) {
          push(`tokens.colors.${key} must be a hex colour like #1a2b3c.`);
          continue;
        }
        colors[key] = value.trim();
      }
      out.colors = colors;
    }
  }

  if (tokens.typography !== undefined) {
    if (!isPlainObject(tokens.typography)) push('`tokens.typography` must be an object.');
    else {
      const typo: Record<string, string> = {};
      for (const [key, value] of Object.entries(tokens.typography)) {
        if (typeof value !== 'string') { push(`tokens.typography.${key} must be a string.`); continue; }
        const v = value.trim();
        const ok = key.toLowerCase().includes('font') && !key.toLowerCase().includes('size')
          ? FONT_RE.test(v)
          : LENGTH_RE.test(v);
        if (!ok) { push(`tokens.typography.${key} is not a valid value ("${v}").`); continue; }
        typo[key] = v;
      }
      out.typography = typo;
    }
  }

  if (tokens.style !== undefined) {
    if (!isPlainObject(tokens.style)) push('`tokens.style` must be an object.');
    else {
      const style: Record<string, string> = {};
      for (const [key, value] of Object.entries(tokens.style)) {
        if (typeof value !== 'string') { push(`tokens.style.${key} must be a string.`); continue; }
        // Check the scale EXISTS before asking what it allows: `isTokenKey`
        // indexes TOKEN_SCALES directly and throws on an unknown name, which
        // would turn a typo in an uploaded manifest into a 500.
        if (!TOKEN_SCALE_NAMES.includes(key as TokenScaleName)) {
          push(`tokens.style.${key} is not a design token (expected one of: ${TOKEN_SCALE_NAMES.join(', ')}).`);
          continue;
        }
        // The decisive guard: an enum scale may only NAME a pre-authored block.
        // A stored value can select CSS; it can never be CSS.
        if (!isTokenKey(key as TokenScaleName, value)) {
          push(`tokens.style.${key} must be one of the allowed values (got "${value}").`);
          continue;
        }
        style[key] = value;
      }
      out.style = style;
    }
  }

  if (tokens.colorScheme !== undefined) {
    if (!['light', 'dark', 'auto'].includes(String(tokens.colorScheme))) {
      push('`tokens.colorScheme` must be light, dark or auto.');
    } else {
      out.colorScheme = tokens.colorScheme;
    }
  }

  // customCSS belongs to the OPERATOR, not the theme. A theme that could write
  // it would overwrite whatever the site owner had typed into that box.
  if ('customCSS' in tokens) {
    push('`tokens.customCSS` is not settable by a theme — use `css` instead.');
  }

  return out as Partial<ThemeConfig>;
}

export function validateThemeManifest(
  input: unknown,
  opts: ThemeValidateOptions = {},
): ThemeValidationResult {
  const errors: string[] = [];
  const push = (m: string) => errors.push(m);
  const rejectedPatterns: NonNullable<ThemeValidationResult['rejectedPatterns']> = [];

  if (!isPlainObject(input)) return { ok: false, errors: ['Manifest must be a JSON object.'] };

  const { id, name, version, description, author, homepage, astrobaasApi, screenshot } = input;

  if (typeof id !== 'string' || !ID_RE.test(id)) {
    push('`id` must be kebab-case, 2–41 chars, starting with a letter.');
  } else if (opts.reservedIds?.includes(id)) {
    // A declarative row claiming a bundled id would make the admin list one
    // theme and the renderer resolve the other.
    push(`\`id\` "${id}" is a built-in theme and cannot be replaced by a manifest.`);
  }
  if (typeof name !== 'string' || !name.trim()) push('`name` is required.');
  else if (name.length > THEME_MANIFEST_LIMITS.stringField) push('`name` is too long.');
  if (typeof version !== 'string' || !VERSION_RE.test(version)) push('`version` must be semver (e.g. 1.0.0).');

  for (const [key, value] of Object.entries({ description, author })) {
    if (value !== undefined && (typeof value !== 'string' || value.length > THEME_MANIFEST_LIMITS.stringField)) {
      push(`\`${key}\` must be a string ≤${THEME_MANIFEST_LIMITS.stringField} chars.`);
    }
  }
  if (homepage !== undefined && (typeof homepage !== 'string' || !/^https:\/\//.test(homepage))) {
    push('`homepage` must be an https URL.');
  }
  if (astrobaasApi !== undefined) {
    if (typeof astrobaasApi !== 'string') push('`astrobaasApi` must be a string.');
    else {
      // Major-only compatibility, same rule the plugin manifest uses: a
      // mismatched major is refused rather than left to half-work.
      const wanted = astrobaasApi.replace(/^[^\d]*/, '').split('.')[0];
      const have = THEME_MANIFEST_API_VERSION.split('.')[0];
      if (wanted && wanted !== have) {
        push(`\`astrobaasApi\` targets v${wanted}; this host implements v${have}.`);
      }
    }
  }
  if (screenshot !== undefined) {
    if (typeof screenshot !== 'string') push('`screenshot` must be a string.');
    else if (screenshot.length > THEME_MANIFEST_LIMITS.screenshot) push('`screenshot` is too large.');
    else if (!/^data:image\/(png|jpeg|webp|svg\+xml);base64,/.test(screenshot) && !/^\/[^/]/.test(screenshot)) {
      // No remote URL: it would be a third-party request from the admin, and
      // the CSP's img-src does not allow arbitrary hosts anyway.
      push('`screenshot` must be a data: image URI or a root-relative path.');
    }
  }

  const tokens = checkTokens(input.tokens, push);

  let css: string | undefined;
  if (input.css !== undefined) {
    if (typeof input.css !== 'string') push('`css` must be a string.');
    else if (input.css.length > THEME_MANIFEST_LIMITS.css) {
      push(`\`css\` exceeds ${THEME_MANIFEST_LIMITS.css} chars.`);
    } else {
      // Refused rather than silently rewritten, so what is stored is what was
      // reviewed. (`sanitizeThemeCss` also refuses oversize rather than
      // truncating — a cut inside `@media (…) {` swallows every later rule.)
      let oversize = '';
      const scrubbed = sanitizeThemeCss(input.css, (r) => { oversize = r; });
      if (oversize) push(`\`css\` ${oversize} (limit ${MAX_THEME_CSS}).`);
      else if (scrubbed !== input.css) {
        push('`css` contains something the stylesheet filter removes (@import, a </style> escape, or a javascript: URL).');
      } else css = scrubbed;
    }
  }

  let patterns: SectionPattern[] | undefined;
  if (input.patterns !== undefined) {
    if (!Array.isArray(input.patterns)) push('`patterns` must be an array.');
    else if (input.patterns.length > THEME_MANIFEST_LIMITS.patterns) {
      push(`Too many patterns (max ${THEME_MANIFEST_LIMITS.patterns}).`);
    } else {
      const kept: SectionPattern[] = [];
      const seen = new Set<string>();
      input.patterns.forEach((p, i) => {
        if (!isWellFormedPattern(p)) return push(`patterns[${i}] must have name, label, description and html.`);
        if (p.html.length > THEME_MANIFEST_LIMITS.patternHtml) {
          return push(`patterns[${i}].html exceeds ${THEME_MANIFEST_LIMITS.patternHtml} chars.`);
        }
        if (seen.has(p.name)) return push(`patterns[${i}].name "${p.name}" is declared twice.`);
        seen.add(p.name);
        const cleaned = sanitizeHtml(p.html);
        if (cleaned !== p.html) {
          const missing = unknownSectionsIn(p.html);
          rejectedPatterns.push({
            name: p.name,
            reason: missing.length
              ? `uses ${missing.join(', ')}, which this build's section vocabulary does not define`
              : 'contains markup the sanitizer rewrites, so it would not be stored as written',
            submitted: p.html,
            sanitized: cleaned,
          });
          return push(`patterns[${i}] ("${p.name}") does not survive the content sanitizer unchanged.`);
        }
        kept.push({ name: p.name, label: p.label, description: p.description, html: p.html });
      });
      patterns = kept;
    }
  }

  if (errors.length) return { ok: false, errors, rejectedPatterns };

  return {
    ok: true,
    errors: [],
    manifest: {
      id: id as string,
      name: (name as string).trim(),
      version: version as string,
      ...(description ? { description: description as string } : {}),
      ...(author ? { author: author as string } : {}),
      ...(homepage ? { homepage: homepage as string } : {}),
      ...(astrobaasApi ? { astrobaasApi: astrobaasApi as string } : {}),
      ...(screenshot ? { screenshot: screenshot as string } : {}),
      ...(tokens && Object.keys(tokens).length ? { tokens } : {}),
      ...(css !== undefined ? { css } : {}),
      ...(patterns?.length ? { patterns } : {}),
    },
  };
}
