/**
 * Patterns — named arrangements of sections.
 *
 * A section is one block. A pattern is a whole page region: "hero, then three
 * feature columns, then a call to action". It is the difference between giving
 * someone a box of parts and giving them a starting point, and it is most of
 * what people actually mean when they say a CMS has "templates".
 *
 * A pattern is **just HTML made of sections**. It is not a new storage concept,
 * not a reference, and nothing links a post back to the pattern it came from:
 * inserting one pastes its markup and the author edits from there. That is
 * deliberate — a live reference would mean a theme update could silently
 * rewrite published pages, and the whole point of storing sanitized HTML is
 * that what you saved is what you get.
 *
 * ## The one invariant
 *
 * `sanitizeHtml(pattern.html) === pattern.html`.
 *
 * A pattern that does not survive the sanitizer byte-for-byte is offering the
 * author something the save path will throw away — they insert a layout, watch
 * it work, and lose it on save with no error anywhere. That failure has already
 * shipped in this codebase once (the alignment buttons), so patterns are
 * validated rather than trusted, including the ones that ship in this file.
 *
 * Themes may contribute patterns. A theme is compiled-in code and therefore
 * trusted, but "trusted" does not mean "correct" — a theme author who invents a
 * class the vocabulary does not define produces exactly the silent-strip bug
 * above. So the same check runs on theme patterns, and a failing one is dropped
 * with a warning instead of being offered.
 */
import { SECTIONS } from './sections';

export interface SectionPattern {
  /** Stable, kebab-case. Namespaced by the theme that supplies it. */
  name: string;
  /** Shown in the inserter. */
  label: string;
  /** One line: what this arrangement is for. */
  description: string;
  /**
   * The markup, composed of section classes.
   *
   * Must be a build-time literal. Nothing may be interpolated into it — a
   * pattern carrying operator data or a URL would be an injection sink, and
   * there is no reason for one to be dynamic.
   */
  html: string;
}

/**
 * The patterns every install ships with.
 *
 * Kept few and genuinely different from one another. A long list of near
 * duplicates is how a pattern library becomes something people scroll past.
 */
export const BUILTIN_PATTERNS: readonly SectionPattern[] = [
  {
    name: 'landing',
    label: 'Landing page',
    description: 'Hero, three features, and a closing call to action.',
    html:
      '<div class="ab-hero ab-align-center">'
      + '<h2>A headline that says what this is</h2>'
      + '<p>One sentence explaining who it is for and why it matters.</p>'
      + '<p><a class="ab-btn ab-btn-primary" href="/">Get started</a></p>'
      + '</div>'
      + '<div class="ab-columns ab-cols-3">'
      + '<div class="ab-col"><h3>First thing</h3><p>Something short and concrete.</p></div>'
      + '<div class="ab-col"><h3>Second thing</h3><p>Something short and concrete.</p></div>'
      + '<div class="ab-col"><h3>Third thing</h3><p>Something short and concrete.</p></div>'
      + '</div>'
      + '<div class="ab-cta">'
      + '<h3>Ready when you are</h3>'
      + '<p><a class="ab-btn ab-btn-primary" href="/contact">Get in touch</a></p>'
      + '</div>',
  },
  {
    name: 'about',
    label: 'About page',
    description: 'A short introduction, a photo beside text, and contact details.',
    html:
      '<div class="ab-hero ab-align-left">'
      + '<h2>About us</h2>'
      + '<p>Who you are, in one or two sentences.</p>'
      + '</div>'
      + '<div class="ab-media ab-media-left">'
      + '<figure><img src="/default-cover.svg" alt="" /><figcaption>Caption</figcaption></figure>'
      + '<div><h3>Our story</h3><p>How this started and what you do now.</p></div>'
      + '</div>'
      + '<div class="ab-note ab-note-info"><p>Find us at — address, phone, opening hours.</p></div>',
  },
  {
    name: 'feature-grid',
    label: 'Feature grid',
    description: 'Four cards in a grid, for services or product highlights.',
    html:
      '<div class="ab-columns ab-cols-4">'
      + '<div class="ab-col"><div class="ab-card"><h3>One</h3><p>Body copy.</p></div></div>'
      + '<div class="ab-col"><div class="ab-card"><h3>Two</h3><p>Body copy.</p></div></div>'
      + '<div class="ab-col"><div class="ab-card"><h3>Three</h3><p>Body copy.</p></div></div>'
      + '<div class="ab-col"><div class="ab-card"><h3>Four</h3><p>Body copy.</p></div></div>'
      + '</div>',
  },
  {
    name: 'gallery-page',
    label: 'Gallery page',
    description: 'An intro followed by a responsive image grid.',
    html:
      '<div class="ab-hero ab-align-center">'
      + '<h2>Gallery</h2>'
      + '<p>A line about what these images show.</p>'
      + '</div>'
      + '<div class="ab-gallery">'
      + '<figure class="ab-gallery-item"><img src="/default-cover.svg" alt="" /></figure>'
      + '<figure class="ab-gallery-item"><img src="/default-cover.svg" alt="" /></figure>'
      + '<figure class="ab-gallery-item"><img src="/default-cover.svg" alt="" /></figure>'
      + '</div>',
  },
];

/** Shape check. Says nothing about whether the HTML survives the sanitizer. */
export function isWellFormedPattern(value: unknown): value is SectionPattern {
  if (!value || typeof value !== 'object') return false;
  const p = value as Partial<SectionPattern>;
  return (
    typeof p.name === 'string' && /^[a-z][a-z0-9-]*$/.test(p.name)
    && typeof p.label === 'string' && p.label.trim().length > 0
    && typeof p.description === 'string'
    && typeof p.html === 'string' && p.html.trim().length > 0
  );
}

/**
 * Every root section class a pattern uses.
 *
 * Used to report a pattern that references a section this build does not have —
 * which happens when a theme is written against a newer vocabulary. The class
 * is stripped on save, so the pattern silently loses a whole region; naming the
 * missing section is the difference between a fixable report and a mystery.
 */
export function unknownSectionsIn(html: string): string[] {
  const known = new Set(SECTIONS.map((s) => `ab-${s.name}`));
  const used = new Set<string>();
  for (const m of html.matchAll(/class="([^"]*)"/g)) {
    for (const cls of m[1].split(/\s+/)) {
      // Only root section names are checked. Modifiers and parts are covered by
      // the sanitizer round-trip assertion, which is stricter.
      if (cls.startsWith('ab-') && !cls.includes('-', 3) && !known.has(cls)) used.add(cls);
    }
  }
  return [...used].sort();
}
