import type { APIRoute } from 'astro';
import { visibleOne } from '../../lib/visibility';
import { LocalDB } from '../../lib/localdb';
import { escapeXml as xmlEscape } from '../../lib/escape-html';
import { localizedSettings } from '../../lib/settings-i18n';
import { ogCache, ogCacheKey } from '../../lib/og-cache';
import { etagMatches } from '../../lib/http-cache';

/**
 * OG image generator. Renders an SVG with the post title + author + site
 * tagline, converts to PNG with sharp. Cached for a day at the edge.
 *
 * And cached HERE, in a bounded LRU keyed by what the card depicts — see
 * lib/og-cache.ts. The route reads only `params`, so a query string never
 * changes what is rendered; the cache makes sure it never causes a render
 * either. Query variants are served, not redirected: the storefronts that link
 * these cards live in other repositories, and a 301 on a URL one of them emits
 * with a cache-busting `?v=` would be a change nobody here can check. With the
 * render cached, a query variant costs a Map lookup — the redirect would buy a
 * smaller CDN entry and nothing else.
 */

async function getSharp() {
  try {
    const mod = await import('sharp');
    return (mod as any).default || mod;
  } catch {
    return null;
  }
}


// Simple word-wrap that respects a per-line character budget.
function wrap(text: string, perLine: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const w of words) {
    if (!current.length) {
      current = w;
    } else if ((current + ' ' + w).length <= perLine) {
      current += ' ' + w;
    } else {
      lines.push(current);
      if (lines.length >= maxLines) {
        const last = lines.pop()!;
        lines.push(last.replace(/\s\S*$/, '') + '…');
        return lines;
      }
      current = w;
    }
  }
  if (current) lines.push(current);
  return lines.slice(0, maxLines);
}

export const GET: APIRoute = async ({ params, locals, request }) => {
  const slug = (params as { slug?: string }).slug || '';
  await LocalDB.init();
  const posts = await LocalDB.getPosts();
  const post = posts.find((p) => p.slug === slug);
  // An OG card is a PUBLIC image: it renders the post's title and author into
  // a PNG that needs no session. Without this check, anyone who guessed a slug
  // got the title of an unpublished post — and a 200-vs-404 oracle telling them
  // which draft slugs exist. Same visibility rule as every other read.
  const visible = visibleOne(post ?? null, locals?.user);
  if (!visible) return new Response('Not found', { status: 404 });
  // A card a signed-in author can see because it is THEIR draft is not a
  // public image. `public, max-age=86400` on it would let a CDN hand the draft's
  // title to the next anonymous visitor for a day — the oracle the check above
  // exists to close, reopened one layer out.
  const isPublic = visibleOne(post ?? null, null) !== null;
  const cacheControl = isPublic ? 'public, max-age=86400' : 'private, no-store';

  const settings = await LocalDB.getSettings();
  const settingsMap: Record<string, any> = {};
  settings.forEach((s) => (settingsMap[s.key] = s.value));
  // Per-locale (C-136). The card is the first thing a reader sees when the
  // article is shared, and a German post shared with the Greek site title on it
  // is exactly what that row said it had fixed.
  const siteTitle = String(localizedSettings(settingsMap, locals?.locale).site_title || 'AstroBaaS');

  // One user by id, not the whole users table per image request.
  const authorRow = visible.author_id ? await LocalDB.getUser(visible.author_id) : null;
  const author = authorRow?.name || siteTitle;

  // Active theme tokens for color.
  const theme = await LocalDB.getActiveTheme();
  const primary = theme?.settings?.colors?.primary || '#3B82F6';
  const secondary = theme?.settings?.colors?.secondary || '#8B5CF6';
  const textColor = '#111827';
  const subtextColor = '#6B7280';

  const titleLines = wrap(visible.title, 28, 4);
  const titleFontSize = titleLines.length > 3 ? 56 : titleLines.length > 2 ? 64 : 72;
  const lineHeight = Math.round(titleFontSize * 1.1);
  const totalTitleHeight = titleLines.length * lineHeight;
  const titleStartY = 320 - totalTitleHeight / 2 + lineHeight * 0.7;

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#FFFFFF"/>
      <stop offset="100%" stop-color="#F9FAFB"/>
    </linearGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="${primary}"/>
      <stop offset="100%" stop-color="${secondary}"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <rect x="0" y="0" width="1200" height="12" fill="url(#accent)"/>

  <text x="80" y="120" font-family="Inter, system-ui, sans-serif" font-size="28" font-weight="600" fill="${primary}">
    ${xmlEscape(siteTitle.toUpperCase())}
  </text>

  ${titleLines
    .map(
      (line, i) =>
        `<text x="80" y="${
          titleStartY + i * lineHeight
        }" font-family="Inter, system-ui, sans-serif" font-size="${titleFontSize}" font-weight="700" fill="${textColor}">${xmlEscape(line)}</text>`,
    )
    .join('\n  ')}

  <text x="80" y="550" font-family="Inter, system-ui, sans-serif" font-size="28" font-weight="500" fill="${subtextColor}">
    By ${xmlEscape(author)}
  </text>
  <rect x="80" y="570" width="60" height="4" fill="url(#accent)"/>
</svg>`;

  // The key IS the picture: slug + a digest of the SVG. Anything that changes
  // what the card shows changes the key, so an edit is never served stale, and
  // nothing else — a query string, a header — can mint a new render.
  const key = ogCacheKey(slug, svg);
  // The same digest makes an honest validator, so a revalidating CDN or
  // browser gets a bodiless 304 instead of the PNG again.
  const etag = `W/"${key.slice(key.indexOf(':') + 1)}"`;
  const svgResponse = () => new Response(svg, {
    status: 200,
    headers: {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': cacheControl,
    },
  });

  let png: Buffer | null = null;
  try {
    png = await ogCache.getOrRender(key, async () => {
      const sharp = await getSharp();
      // Sharp unavailable — the SVG fallback below. Not cached as a miss, so a
      // sharp that becomes loadable is used on the next request.
      if (!sharp) return null;
      return sharp(Buffer.from(svg)).png().toBuffer() as Promise<Buffer>;
    });
  } catch (err) {
    console.error('OG render error:', err);
    png = null;
  }
  // Sharp unavailable or failed — return the SVG. Most platforms render SVG OG
  // images fine.
  if (!png) return svgResponse();

  const headers = {
    'Content-Type': 'image/png',
    'Cache-Control': cacheControl,
    ETag: etag,
  };
  if (isPublic && etagMatches(request.headers.get('if-none-match'), etag)) {
    return new Response(null, { status: 304, headers: { 'Cache-Control': cacheControl, ETag: etag } });
  }
  return new Response(new Uint8Array(png), { status: 200, headers });
};
