/**
 * WordPress WXR, parsed into something this CMS can act on.
 *
 * WXR is RSS 2.0 with WordPress's own namespaces bolted on. Nothing here uses
 * an XML library on purpose: the export files are large (a real shop's runs to
 * tens of megabytes), the shape is narrow and well known, and a DOM parse of
 * the whole document costs several times the file in memory. The trade is that
 * this must be careful about the two things a hand-rolled reader gets wrong —
 * CDATA and entities — so both are handled once, here, and every field goes
 * through them.
 *
 * PURE: text in, data out. No database, no network, no filesystem. That is
 * what lets the awkward cases — a `</item>` inside a CDATA block, an
 * entity-encoded category name, a post whose status WordPress spells four
 * different ways — be tested without an import ever running.
 *
 * What this deliberately does NOT do: decide anything. It does not skip
 * drafts, rewrite URLs, or choose which items to keep. It reports what the
 * file says, and the apply layer decides what to do about it — because "what
 * the export contains" and "what this install should import" are different
 * questions, and answering both in one pass is how importers become
 * un-reviewable.
 */

/** A WordPress author, as declared in the export's header. */
export interface WxrAuthor {
  login: string;
  email?: string;
  displayName?: string;
}

/** One taxonomy term attached to an item. */
export interface WxrTerm {
  slug: string;
  name: string;
}

export interface WxrItem {
  /** `post`, `page`, `attachment`, or whatever custom type the site had. */
  type: string;
  /** WordPress's own id — the join key for featured images. */
  wpId: string;
  title: string;
  /** `wp:post_name`; may be empty on drafts that were never published. */
  slug: string;
  content: string;
  excerpt: string;
  /** WordPress's status verbatim: publish | draft | pending | future | private | trash | inherit. */
  status: string;
  /** ISO date, or undefined when the export carries nothing usable. */
  publishedAt?: string;
  /** `dc:creator` — the author's LOGIN, not their display name. */
  authorLogin?: string;
  categories: WxrTerm[];
  tags: string[];
  /** The original public URL. This is what old links and search results point at. */
  link?: string;
  /** Attachments only: where the file lives on the old site. */
  attachmentUrl?: string;
  /** `_thumbnail_id` postmeta — the wpId of the featured image attachment. */
  thumbnailId?: string;
}

export interface WxrDocument {
  siteUrl?: string;
  siteTitle?: string;
  authors: WxrAuthor[];
  items: WxrItem[];
}

/**
 * Refuse a file large enough to be a denial of service against ourselves.
 *
 * 200 MB is far beyond any real export (the largest shop this was written for
 * is under 40 MB) and well inside what Node can hold, so the limit refuses
 * abuse without refusing anyone's actual site.
 */
export const MAX_WXR_BYTES = 200 * 1024 * 1024;

export class WxrParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WxrParseError';
  }
}

const NAMED_ENTITIES: Record<string, string> = {
  lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
};

function safeCodePoint(cp: number): string {
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return '';
  // Lone surrogates are not characters; String.fromCodePoint throws on them.
  if (cp >= 0xd800 && cp <= 0xdfff) return '';
  try {
    return String.fromCodePoint(cp);
  } catch {
    return '';
  }
}

/**
 * Decode XML entities in ONE pass.
 *
 * One pass is the whole trick, and the first version of this got it wrong by
 * running four sequential .replace() passes with `&amp;` last. That ordering
 * protects the NAMED spelling — `&amp;lt;` stays the literal text `&lt;` — but
 * not the numeric spellings of the same ampersand: `&#38;lt;` decoded to `&`
 * in pass two and then cascaded into `<` in pass three, turning author-inert
 * documented HTML into live markup. Per XML 1.0 a character reference resolves
 * to the character and is NOT re-scanned, so every entity form has to be
 * replaced in a single sweep whose output no later sweep reads.
 */
export function decodeXmlEntities(s: string): string {
  return s.replace(
    /&(?:#x([0-9a-fA-F]+)|#(\d+)|(lt|gt|quot|apos|nbsp|amp));/g,
    (_m, hex: string | undefined, dec: string | undefined, name: string | undefined) => {
      if (hex !== undefined) return safeCodePoint(parseInt(hex, 16));
      if (dec !== undefined) return safeCodePoint(parseInt(dec, 10));
      return name === 'amp' ? '&' : NAMED_ENTITIES[name as string];
    },
  );
}

/**
 * Unwrap a field's text: CDATA verbatim, everything else entity-decoded.
 *
 * A CDATA section is already literal — decoding it again would corrupt every
 * post that contains the text `&amp;`, which is every post that ever showed a
 * code sample.
 */
export function unwrapCdata(s: string): string {
  const trimmed = s.trim();
  const m = trimmed.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
  // XML forbids the literal sequence `]]>` inside a CDATA section, so
  // WordPress's exporter (wxr_cdata) writes it as `]]]]><![CDATA[>` — the
  // section is closed one bracket early and immediately reopened. A conforming
  // reader concatenates adjacent sections, which collapses the escape back to
  // `]]>`. The greedy wrapper match above already spans both halves; this
  // reverses the exporter's str_replace. Without it, the module's "CDATA is
  // literal" promise broke on precisely the post the splitter's own comment
  // names as its motivating case: a tutorial that SHOWS a CDATA example.
  if (m) return m[1].split(']]]]><![CDATA[>').join(']]>');
  return decodeXmlEntities(trimmed);
}

function escapeTag(tag: string): string {
  return tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** First `<tag>` inside `xml`, unwrapped. Empty string when absent. */
function pick(xml: string, tag: string): string {
  const t = escapeTag(tag);
  const m = xml.match(new RegExp(`<${t}(?:\\s[^>]*)?>([\\s\\S]*?)</${t}>`));
  return m ? unwrapCdata(m[1]) : '';
}

/** A placeholder that cannot appear in XML markup, used while masking CDATA. */
const MASK = '\u0000';

/**
 * Split the document into `<item>` blocks.
 *
 * Naive matching breaks on the one thing WordPress exports are full of: a post
 * whose CONTENT contains the literal text `</item>` — a tutorial about RSS, an
 * escaped snippet — inside a CDATA section. So CDATA blocks are lifted out
 * before the split and put back after, which is both correct and cheaper than
 * making the splitter itself CDATA-aware.
 */
function splitItems(xml: string): string[] {
  const cdata: string[] = [];
  const masked = xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, (block) => {
    cdata.push(block);
    return `${MASK}${cdata.length - 1}${MASK}`;
  });

  const out: string[] = [];
  const re = /<item>[\s\S]*?<\/item>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    out.push(m[0].replace(new RegExp(`${MASK}(\\d+)${MASK}`, 'g'), (_t, i: string) => cdata[Number(i)] ?? ''));
  }
  return out;
}

/** ISO 8601, or undefined when the export's date is unusable. */
function toIso(raw: string): string | undefined {
  if (!raw) return undefined;
  // WordPress writes `0000-00-00 00:00:00` for "never", and MySQL datetimes
  // with no zone. The GMT columns are UTC, so say so — otherwise every
  // imported post shifts by whatever offset the importing machine happens to
  // be in, which is a silent, plausible-looking corruption of publish dates.
  if (/^0000-00-00/.test(raw)) return undefined;
  const normalised = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)
    ? `${raw.replace(' ', 'T')}Z`
    : raw;
  const d = new Date(normalised);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** Terms of one taxonomy attached to an item. */
function pickTerms(item: string, domain: string): WxrTerm[] {
  // The attributes are captured SEPARATELY from the body. The first version
  // searched the whole matched element for `nicename="…"`, so a category with
  // no nicename attribute whose display text happened to contain that
  // substring was assigned a slug out of its own body text, and the intended
  // fall-back to the name was unreachable.
  const re = new RegExp(
    `<category\\b([^>]*\\bdomain="${escapeTag(domain)}"[^>]*)>([\\s\\S]*?)</category>`,
    'g',
  );
  const out: WxrTerm[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(item)) !== null) {
    const name = unwrapCdata(m[2]);
    const slug = decodeXmlEntities(m[1].match(/\bnicename="([^"]*)"/)?.[1] ?? '') || name;
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    out.push({ slug, name: name || slug });
  }
  return out;
}

/** One `<wp:postmeta>` value by key. */
function pickMeta(item: string, key: string): string | undefined {
  const re = /<wp:postmeta>([\s\S]*?)<\/wp:postmeta>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(item)) !== null) {
    if (pick(m[1], 'wp:meta_key') === key) return pick(m[1], 'wp:meta_value') || undefined;
  }
  return undefined;
}

/**
 * Parse a WXR export.
 *
 * Throws `WxrParseError` when the input is not one. An importer that quietly
 * finds zero items in a file the operator believes is their whole site is
 * worse than one that says plainly "this is not a WordPress export".
 */
export function parseWxr(xml: string): WxrDocument {
  if (typeof xml !== 'string' || xml.trim().length === 0) {
    throw new WxrParseError('The export file is empty.');
  }
  if (Buffer.byteLength(xml, 'utf8') > MAX_WXR_BYTES) {
    throw new WxrParseError(
      `The export is larger than ${Math.round(MAX_WXR_BYTES / 1024 / 1024)} MB. `
      + 'Split it in the WordPress exporter and import each part.',
    );
  }
  if (!/<rss[\s>]/i.test(xml) && !/<channel[\s>]/i.test(xml)) {
    throw new WxrParseError('This does not look like a WordPress export (no <rss> or <channel> element).');
  }
  // NUL is not a legal character anywhere in XML 1.0, and it is also the
  // masking character splitItems uses while lifting CDATA out. A crafted file
  // carrying NUL+digits+NUL could therefore splice one item's CDATA into
  // another item's field. Refusing the illegal byte outright closes that and
  // costs no legitimate export anything.
  if (xml.includes('\u0000')) {
    throw new WxrParseError('The export contains NUL bytes, which are not valid XML.');
  }

  // Header fields live before the first <item>; bounding the search stops a
  // post that happens to contain a <title> from being read as the site's.
  const headEnd = xml.indexOf('<item>');
  const head = headEnd >= 0 ? xml.slice(0, headEnd) : xml;

  const authors: WxrAuthor[] = [];
  const authorRe = /<wp:author>([\s\S]*?)<\/wp:author>/g;
  let am: RegExpExecArray | null;
  while ((am = authorRe.exec(head)) !== null) {
    const login = pick(am[1], 'wp:author_login');
    if (!login) continue;
    authors.push({
      login,
      ...(pick(am[1], 'wp:author_email') ? { email: pick(am[1], 'wp:author_email') } : {}),
      ...(pick(am[1], 'wp:author_display_name') ? { displayName: pick(am[1], 'wp:author_display_name') } : {}),
    });
  }

  const items: WxrItem[] = [];
  for (const raw of splitItems(xml)) {
    // GMT column first; then pubDate, which carries an EXPLICIT offset per
    // RFC 822 and therefore cannot be misread; the zone-less local
    // `wp:post_date` only as a last resort. The first version consulted the
    // local column before pubDate, and since toIso brands a bare datetime as
    // UTC, a draft whose GMT column was the zero date imported with its local
    // wall-clock time silently declared to be UTC — a shift of the site's
    // whole offset. pubDate is present in every real export, so the last
    // resort (still branded UTC, for want of anything better) is rare and the
    // trade is documented here rather than hidden.
    const publishedAt = toIso(pick(raw, 'wp:post_date_gmt'))
      ?? toIso(pick(raw, 'pubDate'))
      ?? toIso(pick(raw, 'wp:post_date'));
    const authorLogin = pick(raw, 'dc:creator');
    const link = pick(raw, 'link');
    const attachmentUrl = pick(raw, 'wp:attachment_url');
    const thumbnailId = pickMeta(raw, '_thumbnail_id');

    items.push({
      type: pick(raw, 'wp:post_type') || 'post',
      wpId: pick(raw, 'wp:post_id'),
      title: pick(raw, 'title'),
      slug: pick(raw, 'wp:post_name'),
      content: pick(raw, 'content:encoded'),
      excerpt: pick(raw, 'excerpt:encoded'),
      status: pick(raw, 'wp:status') || 'draft',
      ...(publishedAt ? { publishedAt } : {}),
      ...(authorLogin ? { authorLogin } : {}),
      categories: pickTerms(raw, 'category'),
      tags: pickTerms(raw, 'post_tag').map((t) => t.name),
      ...(link ? { link } : {}),
      ...(attachmentUrl ? { attachmentUrl } : {}),
      ...(thumbnailId ? { thumbnailId } : {}),
    });
  }

  return {
    ...(pick(head, 'wp:base_site_url') || pick(head, 'link')
      ? { siteUrl: pick(head, 'wp:base_site_url') || pick(head, 'link') }
      : {}),
    ...(pick(head, 'title') ? { siteTitle: pick(head, 'title') } : {}),
    authors,
    items,
  };
}
