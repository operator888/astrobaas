import type { APIRoute } from 'astro';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { getUploadsDir } from '../../lib/paths';

// Serves runtime-uploaded media. In `astro dev`, files under public/uploads are
// served statically and this route is never hit; in a standalone production
// build the static handler only knows about build-time assets in dist/client,
// so runtime uploads (which live in UPLOADS_DIR) must be served here.
//
// THAT FIRST SENTENCE IS A TRAP WHEN TESTING VIDEO BY HAND. `astro dev` hands
// /uploads to Vite's static middleware, which answers a SUFFIX range
// (`Range: bytes=-10`) with `bytes 0-10` — the first eleven bytes rather than
// the last ten. Measured, in this repo: dev says `bytes 0-10/95620` where this
// route says `bytes 95610-95619/95620`. Somebody checking ranges against a dev
// server will conclude this file is broken and be looking at code that never
// ran. Two ways to actually exercise it: point UPLOADS_DIR outside `public/`
// (which is what tests/smoke.mjs does, and why its range assertions test this
// route rather than Vite's), or run a production build.
//
// Both production paths were measured and both are right. `npm run build`
// copies whatever is in public/uploads at that moment into dist/client, so an
// install that built with media already on disk serves THOSE through the node
// adapter's static handler and everything uploaded afterwards through here.
// Two handlers for one URL space is worth knowing about; on ranges they agree.
export const prerender = false;

const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  // Without these two the extension falls through to
  // application/octet-stream, which this route then marks as an attachment —
  // so a <video> would silently download instead of playing.
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

export const GET: APIRoute = async ({ params, request }) => {
  const rel = (params.path || '').replace(/\\/g, '/');
  // Reject empty, absolute, or traversal paths before touching the filesystem.
  if (!rel || rel.startsWith('/') || rel.split('/').includes('..')) {
    return new Response('Not found', { status: 404 });
  }

  const root = getUploadsDir();
  const target = path.resolve(root, rel);
  if (target !== root && !target.startsWith(root + path.sep)) {
    return new Response('Not found', { status: 404 });
  }

  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(target);
    if (!stat.isFile()) return new Response('Not found', { status: 404 });
  } catch {
    return new Response('Not found', { status: 404 });
  }

  const ext = path.extname(target).toLowerCase();
  const type = CONTENT_TYPES[ext] || 'application/octet-stream';

  /*
   * VALIDATORS — the reason a hard refresh used to re-download the whole
   * library.
   *
   * `immutable` tells a browser not to revalidate, and that covers the common
   * case. It does not cover the ones that actually hurt: a hard refresh, an
   * evicted cache, a new device, a CDN cold start. Each of those revalidates,
   * and with no ETag and no Last-Modified there is nothing to revalidate
   * AGAINST — so every full-size thumbnail came down again. On a 948-item
   * library that is the difference between a page of 304s and tens of
   * megabytes.
   *
   * The tag is derived from size and mtime rather than the bytes: hashing the
   * content would mean reading every file on every conditional request, which
   * is the cost this exists to avoid. Uploads are written once under a
   * randomised name and never edited in place, so size+mtime identifies them.
   * Weak (`W/`) because that is an honest description of the guarantee.
   */
  const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  const lastModified = new Date(stat.mtimeMs).toUTCString();

  const headers: Record<string, string> = {
    'Content-Type': type,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'public, max-age=31536000, immutable',
    ETag: etag,
    'Last-Modified': lastModified,
  };
  // Anything we don't have an explicit safe type for is forced to download.
  if (type === 'application/octet-stream') headers['Content-Disposition'] = 'attachment';
  // SVG is markup: what is on disk was sanitized at upload, and this header
  // is the second lock on the same door. Opened as a DOCUMENT (someone
  // pasting the /uploads URL into the address bar), scripts, external
  // fetches and plugins are all refused even if a hostile file ever reached
  // disk some other way. Inline styles stay allowed — that is how SVGs are
  // styled. As an <img> the CSP is moot; browsers already run nothing there.
  if (ext === '.svg') {
    headers['Content-Security-Policy'] =
      "default-src 'none'; style-src 'unsafe-inline'";
  }

  // A conditional request that still matches costs no body and no file read.
  //
  // If-None-Match wins over If-Modified-Since when both are present, per
  // RFC 9110: the tag is the more precise validator, and a second-resolution
  // date cannot distinguish two writes within the same second.
  const ifNoneMatch = request.headers.get('if-none-match');
  if (ifNoneMatch) {
    // A client may send several, and a `W/` prefix on either side must not stop
    // a match — the comparison for If-None-Match is weak.
    const weak = (v: string) => v.trim().replace(/^W\//, '');
    const matches = ifNoneMatch === '*'
      || ifNoneMatch.split(',').some((candidate) => weak(candidate) === weak(etag));
    if (matches) return new Response(null, { status: 304, headers });
  } else {
    const ifModifiedSince = request.headers.get('if-modified-since');
    if (ifModifiedSince) {
      const since = Date.parse(ifModifiedSince);
      // Compared at SECOND resolution, because that is all the header carries;
      // milliseconds on our side would make an unmodified file look newer.
      if (Number.isFinite(since) && Math.floor(stat.mtimeMs / 1000) * 1000 <= since) {
        return new Response(null, { status: 304, headers });
      }
    }
  }

  /*
   * THE BODY IS STREAMED, never read whole.
   *
   * This used to `fs.readFile` the entire file before looking at the Range
   * header — so a `Range: bytes=0-1` probe on a 400 MB video (the one Safari
   * sends before it plays anything) allocated 400 MB, and a handful of
   * anonymous scrub-bar requests could exhaust the process. The cost of a range
   * request must be the size of the RANGE.
   *
   * The file is OPENED here, once, and every read below goes through this
   * handle: a file deleted or replaced between the stat above and the read
   * cannot turn into a stream that errors half-way through a 200, because a
   * failed open is still a clean 404 and an open handle keeps the bytes it
   * opened.
   *
   * A HEAD request gets the same headers and no stream at all. Astro answers
   * HEAD by calling this GET and discarding the body WITHOUT cancelling it, so
   * a stream opened for a HEAD would hold a file descriptor until garbage
   * collection.
   */
  const isHead = request.method.toUpperCase() === 'HEAD';
  const notFound = () => new Response('Not found', { status: 404 });
  /** The bytes `start..end` inclusive; `null` for HEAD; `'missing'` if the file went away. */
  const open = async (start: number, end: number): Promise<ReadableStream | null | 'missing'> => {
    if (isHead) return null;
    let handle: Awaited<ReturnType<typeof fs.open>>;
    try {
      handle = await fs.open(target, 'r');
    } catch {
      return 'missing';
    }
    // `autoClose` (the default) releases the handle when the stream ends, errors
    // or is destroyed — including when the client disconnects and the web
    // stream is cancelled, which `Readable.toWeb` forwards as a destroy.
    const nodeStream = handle.createReadStream({ start, end, highWaterMark: 64 * 1024 });
    return Readable.toWeb(nodeStream) as unknown as ReadableStream;
  };

  /*
   * RANGE REQUESTS — without these, video does not work.
   *
   * Not an optimisation. Safari asks for `Range: bytes=0-1` before it will play
   * anything and refuses the file outright if the answer is a plain 200, and
   * every browser needs ranges to SEEK: dragging the scrub bar is a request for
   * the middle of the file. A 200 with the whole body means the player can only
   * ever start from the beginning, after downloading everything before the
   * point somebody wanted.
   *
   * Only a single range is honoured. Multipart ranges need a multipart/byteranges
   * body, no media player asks for one, and answering 200 to a request we do not
   * understand is the correct fallback — the client gets the whole file, which is
   * always a valid response to a Range request.
   */
  headers['Accept-Ranges'] = 'bytes';
  const rangeHeader = request.headers.get('range');
  const single = rangeHeader ? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim()) : null;
  if (single) {
    const [, rawStart, rawEnd] = single;
    let start: number;
    let end: number;
    if (rawStart === '') {
      // A SUFFIX range — "the last N bytes". `bytes=-500` is the last 500, not
      // "from 0 to 500", and reading it the other way serves the wrong part of
      // the file with a 206 that claims otherwise.
      const suffix = Number(rawEnd);
      if (!Number.isFinite(suffix) || suffix <= 0) {
        return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${stat.size}` } });
      }
      start = Math.max(0, stat.size - suffix);
      end = stat.size - 1;
    } else {
      start = Number(rawStart);
      end = rawEnd === '' ? stat.size - 1 : Number(rawEnd);
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= stat.size) {
      // 416 must carry the real length, or a player cannot correct itself.
      return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${stat.size}` } });
    }
    end = Math.min(end, stat.size - 1);
    const body = await open(start, end);
    if (body === 'missing') return notFound();
    return new Response(body, {
      status: 206,
      headers: {
        ...headers,
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Content-Length': String(end - start + 1),
      },
    });
  }

  // An empty file has no byte 0 to start a stream at; answer it directly.
  if (stat.size === 0) {
    return new Response(isHead ? null : new Uint8Array(0), {
      status: 200, headers: { ...headers, 'Content-Length': '0' },
    });
  }
  const body = await open(0, stat.size - 1);
  if (body === 'missing') return notFound();
  return new Response(body, {
    status: 200,
    headers: { ...headers, 'Content-Length': String(stat.size) },
  });
};
