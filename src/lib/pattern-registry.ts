/**
 * Which patterns the editor offers, and why one might be missing.
 *
 * Built-in patterns plus whatever the active theme contributes, with every
 * candidate held to the same rule: **it must survive the sanitizer unchanged.**
 * A pattern that does not is not offered, because offering it would let an
 * author insert a layout, see it render, and lose part of it on save with no
 * error anywhere — the single most confusing failure this subsystem can have.
 *
 * Rejections are returned rather than thrown. A bad pattern in a theme should
 * cost that pattern, not the editor: the palette still opens, the other
 * patterns still work, and the reason is surfaced in Admin → Tools where
 * someone can act on it.
 */
import { sanitizeHtml } from './sanitize';
import {
  BUILTIN_PATTERNS, isWellFormedPattern, unknownSectionsIn,
  type SectionPattern,
} from '../core/patterns';

export interface RejectedPattern {
  /** Best-effort identifier; `'(unnamed)'` when the object had no usable name. */
  name: string;
  source: string;
  reason: string;
}

export interface ResolvedPatterns {
  patterns: SectionPattern[];
  rejected: RejectedPattern[];
}

/** Theme ids are kebab-case, so this cannot collide with a built-in name. */
const namespaced = (themeId: string, name: string) => `${themeId}--${name}`;

function vet(candidate: unknown, source: string): { ok: true; pattern: SectionPattern } | { ok: false; rejection: RejectedPattern } {
  if (!isWellFormedPattern(candidate)) {
    const name = (candidate as Partial<SectionPattern> | null)?.name;
    return {
      ok: false,
      rejection: {
        name: typeof name === 'string' && name ? name : '(unnamed)',
        source,
        reason: 'missing or malformed name/label/description/html',
      },
    };
  }

  // THE check. Byte-for-byte, not "close enough": a pattern whose markup the
  // sanitizer rewrites is not the markup that gets stored.
  const cleaned = sanitizeHtml(candidate.html);
  if (cleaned !== candidate.html) {
    const missing = unknownSectionsIn(candidate.html);
    return {
      ok: false,
      rejection: {
        name: candidate.name,
        source,
        reason: missing.length
          ? `uses ${missing.join(', ')}, which this build's section vocabulary does not define`
          : 'contains markup the sanitizer rewrites, so it would not be stored as written',
      },
    };
  }

  return { ok: true, pattern: candidate };
}

/**
 * @param themePatterns  Patterns declared by the active theme, if any.
 * @param themeId        Used to namespace them away from the built-ins.
 */
export function resolvePatterns(
  themePatterns?: readonly unknown[],
  themeId?: string,
): ResolvedPatterns {
  const patterns: SectionPattern[] = [];
  const rejected: RejectedPattern[] = [];

  // Built-ins are vetted too. They are ours, which is exactly why a mistake in
  // one would otherwise go unnoticed until an author hit it.
  for (const p of BUILTIN_PATTERNS) {
    const v = vet(p, 'built-in');
    if (v.ok) patterns.push(v.pattern);
    else rejected.push(v.rejection);
  }

  if (Array.isArray(themePatterns) && themePatterns.length) {
    const source = `theme:${themeId ?? 'active'}`;
    const seen = new Set(patterns.map((p) => p.name));
    for (const candidate of themePatterns) {
      const v = vet(candidate, source);
      if (!v.ok) { rejected.push(v.rejection); continue; }
      // Namespaced so a theme can never shadow a built-in — the author would
      // pick "Landing page" and silently get a different layout.
      const name = themeId ? namespaced(themeId, v.pattern.name) : v.pattern.name;
      if (seen.has(name)) {
        rejected.push({ name: v.pattern.name, source, reason: 'duplicate name' });
        continue;
      }
      seen.add(name);
      patterns.push({ ...v.pattern, name });
    }
  }

  return { patterns, rejected };
}
