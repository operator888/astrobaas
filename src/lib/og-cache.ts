/**
 * A bounded, in-memory cache for rendered OG cards.
 *
 * ## Why the route needs one
 *
 * `/og/{slug}.png` runs sharp — an SVG rasterised to a 1200×630 PNG — on every
 * request. The `Cache-Control: public, max-age=86400` it sends only helps when
 * something in front of the CMS honours it, and a query string defeats that:
 * `/og/x.png?1`, `/og/x.png?2`… are different URLs to every CDN and browser,
 * and each one reached sharp. A few hundred of those a second is a CPU
 * exhaustion attack that needs nothing but a published slug.
 *
 * ## Keyed by what the picture IS, not by the URL
 *
 * The key is the slug plus a digest of the SVG the route is about to render.
 * The SVG is a pure function of everything that changes the picture — the
 * post's title, the author's name, the site title in the reader's locale, the
 * theme's colours — so:
 *
 *   - the query string is not part of it, and cannot mint new renders;
 *   - an edit to ANY of those inputs changes the digest, so a stale card is
 *     never served. A key of `slug + updated_at` would miss an author renaming
 *     themselves or the operator changing the site title or the theme, and
 *     would need a version counter threaded through three write paths to
 *     catch them;
 *   - the SVG is cheap to build (string concatenation), so computing the key
 *     costs nothing next to the render it saves.
 *
 * ## Bounded two ways
 *
 * By entry count (least-recently-used out first) AND by total bytes, because
 * a card is 30–120 KB and an entry limit alone is a memory limit only as long
 * as nobody finds a way to make the cards large.
 *
 * ## One render per key at a time
 *
 * A burst of requests for a card that is not cached yet — the moment a post is
 * shared, which is exactly when it is requested most — would otherwise start
 * one sharp render per request. Concurrent callers for the same key wait for
 * the one render in flight.
 */
import crypto from 'node:crypto';

export const OG_CACHE_MAX_ENTRIES = 100;
export const OG_CACHE_MAX_BYTES = 32 * 1024 * 1024;

/** The cache key for a card. `slug` is kept readable for debugging. */
export function ogCacheKey(slug: string, svg: string): string {
  const digest = crypto.createHash('sha256').update(svg).digest('base64url').slice(0, 32);
  return `${slug}:${digest}`;
}

export class RenderCache {
  private entries = new Map<string, Buffer>();
  private inFlight = new Map<string, Promise<Buffer | null>>();
  private bytes = 0;
  /** How many times `render` actually ran. For tests and diagnostics. */
  renders = 0;

  constructor(
    readonly maxEntries = OG_CACHE_MAX_ENTRIES,
    readonly maxBytes = OG_CACHE_MAX_BYTES,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  get totalBytes(): number {
    return this.bytes;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  /**
   * The cached bytes for `key`, or the result of `render()` — cached if it
   * produced something.
   *
   * A `null` from `render` (the renderer is unavailable, or failed) is NOT
   * cached: the caller falls back to something else, and the next request
   * should try again rather than be told "no" for as long as the entry lives.
   * A throw propagates to every waiter and is not cached either.
   */
  async getOrRender(key: string, render: () => Promise<Buffer | null>): Promise<Buffer | null> {
    const hit = this.entries.get(key);
    if (hit) {
      // Re-insert to mark as most recently used: a Map iterates in insertion
      // order, so the first key is always the least recently used.
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit;
    }
    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const job = (async () => {
      this.renders += 1;
      const out = await render();
      if (out) this.store(key, out);
      return out;
    })();
    this.inFlight.set(key, job);
    try {
      return await job;
    } finally {
      this.inFlight.delete(key);
    }
  }

  private store(key: string, value: Buffer): void {
    // A single value larger than the whole budget is served but never kept —
    // storing it would evict everything else and still exceed the bound.
    if (value.byteLength > this.maxBytes) return;
    const old = this.entries.get(key);
    if (old) {
      this.entries.delete(key);
      this.bytes -= old.byteLength;
    }
    this.entries.set(key, value);
    this.bytes += value.byteLength;
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      const evicted = this.entries.get(oldest.value)!;
      this.entries.delete(oldest.value);
      this.bytes -= evicted.byteLength;
    }
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }
}

/** The process-wide cache the OG route uses. */
export const ogCache = new RenderCache();
