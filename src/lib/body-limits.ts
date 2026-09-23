/**
 * Every route that accepts a body larger than an ordinary JSON request, and
 * the app-side constant its ceiling derives from.
 *
 * ## Why this is a table and not five `if`s in the middleware
 *
 * It was five `if`s in the middleware, and the numbers were correct. The
 * failure was one layer out: a reverse proxy in front of the app has its OWN
 * body cap, nginx's default is 1 MB, and a request refused there never reaches
 * the middleware at all. The operator gets a bare `413 Request Entity Too
 * Large` from nginx — no JSON, no message, nothing in the app's log — while
 * every app-side limit is set correctly and every test passes.
 *
 * That is exactly how the shipped vhost came to allow `12m` for an upload route
 * the app had raised to 110 MB: the two lived in different files, in different
 * languages, and nothing could compare them.
 *
 * So the ceilings live HERE, once, in a form something else can read:
 *
 *  - `src/middleware.ts` enforces them (`bodyLimitFor`).
 *  - `tests/body-limits.test.mjs` reads the SHIPPED proxy configs and fails if
 *    any of them would refuse a request this app is willing to accept.
 *  - `deploy/README.md` documents them, and the same test asserts the document
 *    still lists every route.
 *
 * Raising a cap is therefore a one-line change plus a test that tells you which
 * proxy config you forgot.
 *
 * ## Why the caps exceed the file caps
 *
 * A `Content-Length` counts multipart framing, boundary markers and the other
 * form fields, not just the file. A ceiling equal to the file cap refuses an
 * upload of exactly the documented maximum — at the layer least able to explain
 * why. The headroom is small and deliberate.
 */
import { IMPORT_BODY_LIMIT, MAX_HTTP_WXR_BYTES } from './import/limits';
import { MAX_VIDEO_SIZE } from './media/ingest';
import { MAX_ARCHIVE_BYTES } from './backup/offsite';
import { MAX_SUBMISSION_FILE_SIZE } from './media/private-files';

/** 2 MB for ordinary JSON bodies — and the floor a proxy must allow globally. */
export const BODY_LIMIT_DEFAULT = 2 * 1024 * 1024;

export interface BodyLimitRule {
  /** The route, written the way an operator writes it in a proxy config. */
  location: string;
  /** Does this rule govern that path? */
  match: (pathname: string) => boolean;
  /** The ceiling, in bytes. */
  bytes: number;
  /**
   * The app-side constant this derives from — the thing an operator raising
   * the limit actually edits. Named so the docs table cannot go stale about it.
   */
  derivesFrom: string;
  /** The environment variable that moves it, where one exists. */
  env?: string;
  /** What the route is, in one line an operator can act on. */
  purpose: string;
}

/**
 * ORDER MATTERS: first match wins, exactly as the middleware's `if` chain did.
 * Keep the regex rules after the exact ones.
 */
export const BODY_LIMITS: readonly BodyLimitRule[] = [
  {
    location: '/api/backup/import',
    match: (p) => p === '/api/backup/import',
    // Derived rather than hand-synced. These two had already drifted once: the
    // route raised itself to 256 MB to match what offsite.ts will write while
    // the middleware stayed at 60, so a shop's own archive was refused before
    // the route that allows it ever ran.
    bytes: Math.ceil(MAX_ARCHIVE_BYTES * 1.1),
    derivesFrom: 'MAX_ARCHIVE_BYTES (src/lib/backup/offsite.ts)',
    purpose: 'Restoring a full backup archive',
  },
  {
    location: '/api/media/upload',
    match: (p) => p === '/api/media/upload',
    // Video raises the ingester's ceiling tenfold over the image one, so a
    // stale constant here would 413 every upload before the route allowing it.
    bytes: Math.ceil(MAX_VIDEO_SIZE * 1.1),
    derivesFrom: 'MAX_VIDEO_SIZE (src/lib/media/ingest.ts)',
    env: 'MEDIA_MAX_VIDEO_MB',
    purpose: 'Uploading an image or a video from the media picker',
  },
  {
    location: '/api/media/replace',
    match: (p) => p === '/api/media/replace',
    // A replacement IS an upload; same ceiling, for the same reason.
    bytes: Math.ceil(MAX_VIDEO_SIZE * 1.1),
    derivesFrom: 'MAX_VIDEO_SIZE (src/lib/media/ingest.ts)',
    env: 'MEDIA_MAX_VIDEO_MB',
    purpose: 'Replacing the bytes behind an existing media file',
  },
  {
    location: '/api/import/wordpress',
    match: (p) => p === '/api/import/wordpress',
    // Defined next to the route's own file cap so this cannot quietly become
    // the smaller of the two — which would make the route's "use the CLI
    // instead" message unreachable and hand the operator a bare 413.
    bytes: IMPORT_BODY_LIMIT,
    derivesFrom: `MAX_HTTP_WXR_BYTES + 2 MB = IMPORT_BODY_LIMIT, with the file cap at ${
      Math.round(MAX_HTTP_WXR_BYTES / 1024 / 1024)
    } MB (src/lib/import/limits.ts)`,
    purpose: 'Uploading a WordPress WXR export over HTTP',
  },
  {
    location: '/api/forms/*/upload',
    match: (p) => /^\/api\/forms\/[^/]+\/upload\/?$/.test(p),
    bytes: Math.ceil(MAX_SUBMISSION_FILE_SIZE * 1.2),
    derivesFrom: 'MAX_SUBMISSION_FILE_SIZE (src/lib/media/private-files.ts)',
    purpose: 'A file attached to a public form by an anonymous visitor',
  },
];

/**
 * The ceiling for one path. The middleware's enforcement point.
 *
 * PURE and dependency-free at the call site, so it stays cheap enough to run on
 * every non-GET request.
 */
export function bodyLimitFor(pathname: string): number {
  for (const rule of BODY_LIMITS) {
    if (rule.match(pathname)) return rule.bytes;
  }
  return BODY_LIMIT_DEFAULT;
}

/** Bytes as an nginx/Caddy size token, rounded UP so the proxy never sits below the app. */
export function proxySize(bytes: number): string {
  return `${Math.ceil(bytes / (1024 * 1024))}m`;
}
