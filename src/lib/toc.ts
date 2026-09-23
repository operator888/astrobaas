/**
 * Heading anchors and the table of contents (C-46).
 *
 * Two jobs that have to be one function, because they must not disagree: giving
 * every heading a stable `id`, and listing those headings. A ToC built by a
 * separate pass would compute its own ids and every link in it would be a guess.
 *
 * ## Bare slugs, by decision
 *
 * The anchor for "How it works" is `#how-it-works` — not `#heading-how-it-works`
 * and not a hash. That was the owner's call and it is the right one: the anchor
 * is part of the URL a reader copies out of the address bar and pastes into a
 * message, so it should read like the heading it points at. The cost is that
 * ids can collide with each other and with ids elsewhere in the document, which
 * is what the deduplication below exists for.
 *
 * `slugify` transliterates rather than dropping non-Latin script, so a Greek
 * heading gets a usable Latin anchor instead of an empty one — the same bug
 * that once made every Greek product collide on the empty slug.
 *
 * ## An id the author wrote is never touched
 *
 * If a heading already carries an `id`, it survives untouched and is recorded as
 * taken. Links to it exist — in older posts, in emails, in other people's
 * bookmarks — and renaming an anchor breaks them silently: the page still loads,
 * it just lands in the wrong place, which nobody reports as a bug.
 *
 * ## Why h2–h4
 *
 * `h1` is the post title, which the theme renders outside the body. A body `h1`
 * is either a mistake or a second title, and listing it makes the ToC look like
 * it contains the article twice. `h5`/`h6` are below the granularity anyone
 * navigates by.
 *
 * ## Order in the pipeline
 *
 * Runs on ALREADY-SANITIZED html, like `lazyLoadContentImages` and for the same
 * reason: `id` is on the sanitizer's allow-list, so ids added before it would
 * survive, but running a rewriter before the sanitizer lets a plugin filter's
 * output be rewritten and then sanitized — reversing the order that keeps a
 * plugin from becoming an XSS vector.
 */
import { slugify } from './validate';
// plainText carries the ampersand-LAST entity ordering that was worked out here
// first: `&amp;lt;` is the text `&lt;`, not the character `<`.
import { plainText } from './html-text';
import { escapeHtml as attrEscape } from './escape-html';

/** One heading, as both an anchor target and a ToC entry. */
export interface TocItem {
  /** The `id` on the heading. Bare slug, deduplicated. */
  id: string;
  /** Visible text, tags stripped and entities decoded. Escape at render. */
  text: string;
  /** The original heading level, 2–4. */
  level: number;
  /**
   * Indentation level, 0-based, derived from the SEQUENCE rather than from
   * `level`. An article that jumps h2 → h4 (common, and not worth refusing to
   * render) indents by one step, not two, so the ToC reflects the structure the
   * author meant instead of leaving a visible hole where the h3 would have been.
   */
  depth: number;
}

export interface TocResult {
  /** The same html, with an `id` on every heading that lacked one. */
  html: string;
  /** The headings, in document order. */
  items: TocItem[];
}

/** Headings the ToC covers. See the note above for why h1 and h5/h6 are out. */
const HEADING_RE = /<(h[2-4])(\s[^>]*)?>([\s\S]*?)<\/\1\s*>/gi;
const ID_ATTR_RE = /\bid\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
/** Any id already in the document, heading or not — an anchor must be unique document-wide. */
const ANY_ID_RE = /\bid\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;


/**
 * Escape a value for an HTML attribute.
 *
 * The ids here come from `slugify`, whose output is `[a-z0-9-]` and needs no
 * escaping — but an id preserved from the author does not, and passing it back
 * out unescaped would let `id="a" onload="…"` through the one place in this
 * function that writes an attribute. It cannot happen with sanitized input;
 * this file should not be the reason that stays true.
 */

export interface TocOptions {
  /**
   * Ids already spoken for. Defaults to every `id` found in the html itself.
   * Exposed so a caller rendering two documents into one page can keep their
   * anchors from colliding.
   */
  taken?: Iterable<string>;
}

/**
 * Add ids to headings and return them as a list.
 *
 * Pure: same html in, same html and same ids out. No settings read and no
 * database, so the ids on the rendered page and the ids in the API's
 * `content_rendered` are identical by construction rather than by both calling
 * the same settings key correctly.
 */
export function buildToc(html: string, opts: TocOptions = {}): TocResult {
  if (!html) return { html: html ?? '', items: [] };

  // Seeded with EVERY id in the document, not only the headings'. An anchor
  // that collides with a figure's id scrolls to the figure — the reader is
  // simply taken to the wrong place, with nothing to indicate it went wrong.
  const taken = new Set<string>();
  if (opts.taken) {
    for (const id of opts.taken) if (id) taken.add(id);
  } else {
    for (const m of html.matchAll(ANY_ID_RE)) {
      const id = m[1] ?? m[2];
      if (id) taken.add(id);
    }
  }

  const items: TocItem[] = [];
  // Levels seen so far, as a stack, so `depth` counts STEPS rather than the
  // arithmetic difference between h-numbers.
  const stack: number[] = [];

  const out = html.replace(HEADING_RE, (whole, tag: string, attrs: string | undefined, inner: string) => {
    const text = plainText(inner);
    // A heading with no text is not a destination. Anchoring it would put an
    // entry in the ToC with no label, which reads as a rendering fault.
    if (!text) return whole;

    const level = Number(tag.slice(1));
    const existing = attrs ? ID_ATTR_RE.exec(attrs) : null;
    const authorId = existing ? (existing[1] ?? existing[2] ?? existing[3] ?? '') : '';

    let id: string;
    let rewritten = whole;
    if (authorId) {
      id = authorId;
    } else {
      const base = slugify(text);
      id = base;
      // `intro`, `intro-2`, `intro-3`. Two sections called "Examples" is
      // ordinary writing, and without this every anchor after the first points
      // at the first one.
      let n = 2;
      while (taken.has(id)) id = `${base}-${n++}`;
      rewritten = `<${tag}${attrs ?? ''} id="${attrEscape(id)}">${inner}</${tag}>`;
    }
    taken.add(id);

    while (stack.length && stack[stack.length - 1] >= level) stack.pop();
    stack.push(level);
    items.push({ id, text, level, depth: stack.length - 1 });

    return rewritten;
  });

  return { html: out, items };
}

/**
 * How many headings an article needs before a ToC is rendered — `0` for never.
 *
 * One number rather than a boolean plus a number, the same shape
 * `related_posts_count` already uses two doors over: a count whose zero means
 * off cannot get into the state where the feature is "enabled" with a threshold
 * nothing reaches, which is a bug report nobody can act on.
 *
 * The default is OFF. A ToC appearing on every post of an existing site after
 * an upgrade is a visible change to published pages that nobody asked for; the
 * admin screen offers it, and the operator turns it on.
 *
 * A ToC of one entry tells the reader nothing they cannot see by scrolling and
 * pushes the article below the fold, so `1` clamps UP to 2 rather than being
 * honoured — the only value that means "off" is one that looks like it.
 */
export function tocThreshold(raw: unknown, fallback = 0): number {
  // NOT SET is checked before NOT A NUMBER, because `Number(null)` and
  // `Number('')` are both 0 — which here happens to mean "off", but by
  // coincidence rather than by decision. An operator who never touched the
  // field and one who deliberately typed 0 must not be told apart by luck.
  if (raw === null || raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  if (i <= 0) return 0;
  return Math.min(20, Math.max(2, i));
}

/**
 * "Contents", in the READER's language.
 *
 * The public content language, not the admin one: using `locals.t` here would
 * label a Greek visitor's contents list in English because an English-speaking
 * admin happened to be signed in — the same distinction `lib/breadcrumbs.ts`
 * documents for the trail. Same three locales the rest of the public chrome
 * ships, falling back to English for anything else rather than showing a key.
 */
const TOC_LABELS: Record<string, string> = {
  en: 'Contents',
  el: 'Περιεχόμενα',
  de: 'Inhalt',
};

export function tocLabel(locale: string | undefined): string {
  const key = (locale ?? 'en').split('-')[0].toLowerCase();
  return TOC_LABELS[key] ?? TOC_LABELS.en;
}
