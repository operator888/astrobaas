/**
 * Third-party embeds behind a privacy facade (C-44).
 *
 * ## The roadmap's premise was false, and that shaped everything here
 *
 * The note said embeds worked and only needed a facade adding. They did not:
 * `iframe` is absent from the sanitizer's `allowedTags` and
 * `disallowedTagsMode` is `discard`, so a pasted YouTube embed was destroyed on
 * save. That is deliberate — it is a large part of what keeps the CSP intact —
 * and it means the facade cannot be a wrapper around a stored iframe.
 *
 * ## So nothing stores an iframe. Ever.
 *
 * What is stored is a PLACEHOLDER:
 *
 *     <div class="ab-embed" data-embed-provider="youtube" data-embed-id="dQw4w9WgXcQ">
 *
 * The provider must be one of a handful named here, and the id must match that
 * provider's own shape. The frame URL is then BUILT from the pair — it is never
 * read from content. An attacker who could write post HTML directly still
 * cannot point a frame anywhere: the worst they can express is a different
 * YouTube video.
 *
 * This is what makes it safe to allow the embed at all, and it is why the
 * sanitizer's `iframe` exclusion stays exactly as it was.
 *
 * ## The facade is a real privacy facade
 *
 * It makes NO third-party request before a click. Not even a thumbnail: a
 * YouTube poster image is served by Google and fetching one tells them who is
 * reading the article, which is the entire thing a facade exists to prevent.
 * (A LOCAL poster from the media library is supported, and is the answer for an
 * operator who wants a picture there.)
 *
 * A click loads that one embed. It does not grant consent for anything else,
 * and it does not persist.
 *
 * ## Socials are refused, with a reason
 *
 * X/Instagram/Facebook post embeds require the provider's own JavaScript in the
 * page. The CSP has no `unsafe-inline` and no third-party `script-src`, so they
 * cannot work here without dismantling the policy for every visitor to every
 * page. Pasting one gives a link instead — see `EMBED_REFUSALS`.
 */
import { escapeHtml } from './escape-html';
import { publicStrings, fill } from './i18n/public-strings';

export interface EmbedProvider {
  id: string;
  /** Shown on the facade: "Load this video from YouTube". */
  label: string;
  /** What the reader is about to contact, in full, so the facade can say it. */
  host: string;
  /** The shape of a valid id for this provider. Anchored at both ends. */
  idPattern: RegExp;
  /** Build the frame URL. Takes the VALIDATED id, never raw content. */
  frameSrc: (id: string) => string;
  /** CSP `frame-src` origins this provider needs. */
  origins: readonly string[];
  /** What the frame is, for the title attribute a screen reader reads. */
  kind: 'video' | 'map';
  /** Aspect ratio as width/height, for the reserved box. */
  ratio: number;
}

export const EMBED_PROVIDERS: readonly EmbedProvider[] = [
  {
    id: 'youtube',
    label: 'YouTube',
    // -nocookie is not cosmetic: the normal domain sets tracking cookies on
    // load, so a facade that then loaded youtube.com would have delayed the
    // tracking rather than removed it.
    host: 'www.youtube-nocookie.com',
    idPattern: /^[A-Za-z0-9_-]{11}$/,
    frameSrc: (id) => `https://www.youtube-nocookie.com/embed/${id}`,
    origins: ['https://www.youtube-nocookie.com'],
    kind: 'video',
    ratio: 16 / 9,
  },
  {
    id: 'vimeo',
    label: 'Vimeo',
    host: 'player.vimeo.com',
    idPattern: /^[0-9]{6,12}$/,
    frameSrc: (id) => `https://player.vimeo.com/video/${id}?dnt=1`,
    origins: ['https://player.vimeo.com'],
    kind: 'video',
    ratio: 16 / 9,
  },
  {
    id: 'openstreetmap',
    // The id is a bounding box plus an optional marker, which is why the
    // pattern is numeric rather than opaque.
    label: 'OpenStreetMap',
    host: 'www.openstreetmap.org',
    idPattern: /^-?\d+(\.\d+)?(,-?\d+(\.\d+)?){3}(!-?\d+(\.\d+)?,-?\d+(\.\d+)?)?$/,
    frameSrc: (id) => {
      const [box, marker] = id.split('!');
      const q = `bbox=${encodeURIComponent(box)}&layer=mapnik`;
      return `https://www.openstreetmap.org/export/embed.html?${q}${marker ? `&marker=${encodeURIComponent(marker)}` : ''}`;
    },
    origins: ['https://www.openstreetmap.org'],
    kind: 'map',
    ratio: 4 / 3,
  },
] as const;

export function getEmbedProvider(id: string): EmbedProvider | undefined {
  return EMBED_PROVIDERS.find((p) => p.id === id);
}

/** Every origin any provider frames, for `frame-src`. */
export function embedFrameOrigins(): string[] {
  return [...new Set(EMBED_PROVIDERS.flatMap((p) => [...p.origins]))];
}

/**
 * Hosts we deliberately do NOT embed, and what to say about it.
 *
 * Listed rather than left to fail silently: an author who pastes an Instagram
 * URL and gets nothing assumes a bug. They should be told it is a decision.
 */
export const EMBED_REFUSALS: Record<string, string> = {
  'instagram.com': 'Instagram embeds need Instagram’s own JavaScript, which this site’s security policy does not allow. Paste the link instead — it will still be a link.',
  'www.instagram.com': 'Instagram embeds need Instagram’s own JavaScript, which this site’s security policy does not allow. Paste the link instead — it will still be a link.',
  'x.com': 'X embeds need X’s own JavaScript, which this site’s security policy does not allow. Paste the link instead — it will still be a link.',
  'twitter.com': 'X embeds need X’s own JavaScript, which this site’s security policy does not allow. Paste the link instead — it will still be a link.',
  'www.facebook.com': 'Facebook embeds need Facebook’s own JavaScript, which this site’s security policy does not allow. Paste the link instead — it will still be a link.',
  'www.tiktok.com': 'TikTok embeds need TikTok’s own JavaScript, which this site’s security policy does not allow. Paste the link instead — it will still be a link.',
};

export interface ParsedEmbed {
  provider: string;
  id: string;
}

/** A number that is genuinely a number, for map coordinates. */
function num(v: string | null | undefined): number | null {
  if (v === null || v === undefined || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Recognise a URL an author pasted.
 *
 * Returns `null` for anything not recognised — including a refused host, which
 * the caller distinguishes with `embedRefusal`. Never throws: this runs on
 * whatever somebody typed.
 */
export function parseEmbedUrl(raw: string): ParsedEmbed | null {
  let url: URL;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase();

  // YouTube: three URL shapes, one id.
  if (host === 'youtu.be') {
    const id = url.pathname.slice(1).split('/')[0];
    return getEmbedProvider('youtube')!.idPattern.test(id) ? { provider: 'youtube', id } : null;
  }
  if (host === 'www.youtube.com' || host === 'youtube.com' || host === 'm.youtube.com'
      || host === 'www.youtube-nocookie.com' || host === 'youtube-nocookie.com') {
    // `searchParams.get` returns null for an absent key and '' for `?v=`, so
    // `??` alone would take the empty string and never reach the /embed/ path.
    // `||` is correct here for exactly that reason.
    const v = url.searchParams.get('v')
      || (url.pathname.startsWith('/embed/') ? url.pathname.slice('/embed/'.length).split('/')[0] : '');
    const id = v.split('/')[0];
    return getEmbedProvider('youtube')!.idPattern.test(id) ? { provider: 'youtube', id } : null;
  }

  // Vimeo: the numeric id, from either the site or the player.
  if (host === 'vimeo.com' || host === 'www.vimeo.com' || host === 'player.vimeo.com') {
    const parts = url.pathname.split('/').filter(Boolean);
    const id = parts.find((p) => /^[0-9]{6,12}$/.test(p)) ?? '';
    return id ? { provider: 'vimeo', id } : null;
  }

  // OpenStreetMap: the share URL carries `#map=zoom/lat/lon`, which is a CENTRE
  // rather than a box, so a box is computed around it. The zoom decides how
  // wide — a 17 is a street corner, a 5 is a country, and using one span for
  // both would embed either a useless map or the wrong continent.
  if (host === 'www.openstreetmap.org' || host === 'openstreetmap.org') {
    const m = /#map=(\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)/.exec(url.hash);
    if (m) {
      const zoom = Number(m[1]);
      const lat = Number(m[2]);
      const lon = Number(m[3]);
      // Half-width in degrees, halving per zoom level. 360/2^zoom is the full
      // world width at that zoom; a quarter of it frames the point sensibly.
      const span = Math.min(90, Math.max(0.0005, 360 / Math.pow(2, Math.max(1, zoom)) / 4));
      const bbox = [lon - span, lat - span / 2, lon + span, lat + span / 2]
        .map((n) => n.toFixed(6)).join(',');
      return { provider: 'openstreetmap', id: `${bbox}!${lat.toFixed(6)},${lon.toFixed(6)}` };
    }
    // An already-built embed URL: take its bbox as given, once validated.
    const bbox = url.searchParams.get('bbox');
    const marker = url.searchParams.get('marker');
    if (bbox && bbox.split(',').length === 4 && bbox.split(',').every((p) => num(p) !== null)) {
      const id = marker && marker.split(',').length === 2 && marker.split(',').every((p) => num(p) !== null)
        ? `${bbox}!${marker}` : bbox;
      return getEmbedProvider('openstreetmap')!.idPattern.test(id) ? { provider: 'openstreetmap', id } : null;
    }
  }

  return null;
}

/** The explanation for a host we refuse on purpose, or null. */
export function embedRefusal(raw: string): string | null {
  try {
    return EMBED_REFUSALS[new URL(String(raw ?? '').trim()).hostname.toLowerCase()] ?? null;
  } catch {
    return null;
  }
}

/** The class the sanitizer allows and the renderer looks for. */
export const EMBED_CLASS = 'ab-embed';

/** The data attributes an embed placeholder may carry. Nothing else survives. */
export const EMBED_ATTRIBUTES = ['data-embed-provider', 'data-embed-id', 'data-embed-title', 'data-embed-poster'] as const;

/**
 * Is this stored placeholder one we will render?
 *
 * The sanitizer calls this on save and the renderer calls it on read, so a
 * placeholder that stopped being valid — a provider removed in an upgrade —
 * is left as the inert div it already is rather than becoming a broken frame.
 * (It "degrades to nothing" only in the sense that nothing renders: the empty
 * div stays in the markup, which is invisible and harmless.)
 */
export function validEmbed(provider: unknown, id: unknown): boolean {
  const p = getEmbedProvider(String(provider ?? ''));
  return !!p && p.idPattern.test(String(id ?? ''));
}

/**
 * The markup an editor stores. Attribute values are validated, then escaped.
 *
 * `escapeHtml` rather than a local four-replace chain: the first draft of this
 * wrote its own and a guard in shared-lib.test.mjs rejected it, correctly — the
 * five copies that guard was written for did not all agree, and the one that
 * forgot the apostrophe is the one that mattered.
 */
export function embedPlaceholderHtml(parsed: ParsedEmbed, title = ''): string {
  if (!validEmbed(parsed.provider, parsed.id)) return '';
  const t = title.trim().slice(0, 200);
  return `<div class="${EMBED_CLASS}" data-embed-provider="${escapeHtml(parsed.provider)}" data-embed-id="${escapeHtml(parsed.id)}"`
    + (t ? ` data-embed-title="${escapeHtml(t)}"` : '')
    + '></div>';
}

/**
 * The placeholder, rendered as the facade a reader sees.
 *
 * Server-side and string-based, so it runs wherever stored HTML is turned into
 * HTML a reader sees — including the two API routes a headless storefront
 * reads, which is where the installs that matter here get their HTML. A
 * client-only upgrade would have left those storefronts with an empty div.
 *
 * Callers, and they are enumerated rather than assumed: `content-render.ts`
 * (posts, pages, and both post API routes), the admin preview, and the product
 * description. The claim that this "runs in the ONE pipeline every surface goes
 * through" was wrong — products have their own read path, and an audit found
 * that a video in a product description rendered as an empty div forever.
 *
 * The button carries everything the runtime needs. The runtime re-validates it
 * anyway: this markup can also arrive at a storefront that renders it itself.
 */
export function renderEmbedFacades(html: string, locale?: unknown): string {
  if (!html || !html.includes(EMBED_CLASS)) return html;
  // The CONTENT locale, defaulting to English. A facade sits inside an article
  // whatever theme is active, so an English sentence in the middle of a Greek
  // page is the core's fault rather than the theme's.
  const strings = publicStrings(locale);

  return html.replace(
    /<div\b([^>]*\bclass="[^"]*\bab-embed\b[^"]*"[^>]*)><\/div>/g,
    (whole, attrs: string) => {
      const attr = (name: string) => {
        const m = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs);
        return m ? m[1] : '';
      };
      const providerId = attr('data-embed-provider');
      const id = attr('data-embed-id');
      if (!validEmbed(providerId, id)) return whole;
      const provider = getEmbedProvider(providerId)!;
      // Both come from BETWEEN the quotes of a sanitizer-written attribute, so
      // they are already entity-escaped and are safe in an attribute and as
      // text. Re-escaping would double it (`&amp;` → `&amp;amp;`). The guard is
      // here so that safety is checked rather than argued: if a caller ever
      // hands this raw HTML, the title is dropped instead of injected.
      const safe = (v: string) => (/[<>"]/.test(v) ? '' : v);
      const title = safe(attr('data-embed-title'));
      const poster = safe(attr('data-embed-poster'));

      // The RATIO is expressed by the provider attribute and an attribute
      // selector in global.css, not by an inline style: the CSP has no
      // `unsafe-inline` for styles either, so a `style="padding-top:75%"` here
      // would be dropped and every map would render at video proportions.
      const label = title
        || `${provider.kind === 'map' ? strings.embedMap : strings.embedVideo} — ${provider.label}`;

      return `<div class="ab-embed ab-embed-facade" data-embed-provider="${providerId}" data-embed-id="${id}"`
        + (title ? ` data-embed-title="${title}"` : '')
        + '>'
        + `<div class="ab-embed-box">`
        + (poster ? `<img class="ab-embed-poster" src="${poster}" alt="" loading="lazy" decoding="async">` : '')
        + `<button type="button" class="ab-embed-load" data-embed-load>`
        + `<span class="ab-embed-title">${label}</span>`
        + `<span class="ab-embed-note">${fill(strings.embedLoad, { host: provider.host })}. ${strings.embedNote}</span>`
        + `</button>`
        + `</div></div>`;
    },
  );
}

/**
 * Apply `renderEmbedFacades` to a product's two HTML fields.
 *
 * Exists so the LIST route and the SINGLE route cannot disagree — the shape
 * this codebase gets wrong most often, and the one an audit found here: the
 * runtime script is loaded on every public page on the stated grounds that "an
 * embed can be in a post body, a Page, A PRODUCT DESCRIPTION or a plugin's
 * section", and the product path never converted one. A video in a product
 * description rendered as an empty div, forever, on the installs that are
 * entirely product pages.
 *
 * Returns a new object; the stored record is untouched.
 */
export function withProductEmbeds<T extends object>(product: T): T {
  const record = product as unknown as Record<string, unknown>;
  const description = record.description;
  const shortDescription = record.short_description;
  if (typeof description !== 'string' && typeof shortDescription !== 'string') return product;
  return {
    ...product,
    ...(typeof description === 'string' ? { description: renderEmbedFacades(description) } : {}),
    ...(typeof shortDescription === 'string' ? { short_description: renderEmbedFacades(shortDescription) } : {}),
  };
}
