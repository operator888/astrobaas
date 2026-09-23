/**
 * An mtime-validated read cache for the file-backed lowdb adapter.
 *
 * ## The problem this solves
 *
 * lowdb's `read()` has no cache: every call re-reads the file from disk and
 * re-runs `JSON.parse` over the whole document. LocalDB wraps *every* getter in
 * `db.read()` — 78 call sites — so a single page render pays that cost many
 * times over.
 *
 * Measured on a 26.5 MB database before this existed:
 *   - 158.7 ms per parse
 *   - 9.4 parses to serve one `/blog` request  (~1.1 s TTFB)
 *   - 16.2 s of wall clock for ten concurrent `/blog` requests
 *
 * That is not a micro-optimisation. It is the difference between a CMS that
 * runs on a small VPS and one that does not, and it was being paid by every
 * headless storefront reading over the API.
 *
 * ## Why mtime rather than "invalidate on our own writes"
 *
 * Invalidating only when *this* process writes would be wrong the moment
 * anything else touches the file — a second replica, a CLI command
 * (`npm run import:woo`, `reset-password`), a restore, or an operator with an
 * editor. Those are all real, and a cache that silently serves a stale
 * database is far worse than a slow one.
 *
 * So the cache is keyed on the file's identity and version: inode, size and
 * mtime in milliseconds. Any writer, in any process, changes at least one of
 * them. `stat()` costs microseconds; the parse it avoids costs ~159 ms.
 *
 * The one real gap, stated plainly: two writes to the same inode with the same
 * byte length and an indistinguishable mtime. Our OWN writes cannot hit it —
 * `write()` updates the cache directly. It needs a second process, writing a
 * same-length document, within the filesystem's mtime granularity. On APFS and
 * ext4 that granularity is nanoseconds; on a filesystem with 1-second mtimes it
 * is a one-second window.
 *
 * That is acceptable because AstroBaaS's lowdb driver is explicitly the
 * single-process, zero-config option — the documented answer to "I want two
 * replicas" is the libSQL driver, which is not cached here for exactly this
 * reason. Other writers in practice are CLI tools an operator runs by hand
 * (`import:woo`, `reset-password`, a restore), which are seconds apart, and
 * which this catches.
 *
 * ## Ownership of the returned object
 *
 * `read()` hands back the SAME object on a cache hit, exactly as an
 * uncached lowdb hands back a fresh one. Callers must not mutate what a getter
 * returns without writing it back — see the copy-on-read note in localdb.ts,
 * which is what keeps `(await getOrders()).sort()` from reordering the cache.
 */
import fs from 'node:fs';

export interface MinimalAdapter<T> {
  read(): Promise<T | null>;
  write(data: T): Promise<void>;
}

/** What we believe about the file backing the current cache entry. */
interface Stamp {
  ino: number;
  size: number;
  mtimeMs: number;
}

const stampOf = (file: string): Stamp | null => {
  try {
    const s = fs.statSync(file);
    return { ino: s.ino, size: s.size, mtimeMs: s.mtimeMs };
  } catch {
    return null; // missing file: treat as "cannot validate", never as a hit
  }
};

const same = (a: Stamp | null, b: Stamp | null): boolean =>
  !!a && !!b && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;

export interface CacheStats {
  hits: number;
  misses: number;
  writes: number;
}

/**
 * Wrap a file-backed adapter so repeated reads of an unchanged file are free.
 *
 * Only used for the lowdb/JSONFile driver, where a `stat()` gives a cheap and
 * trustworthy version check. The libSQL drivers are left alone deliberately:
 * there is no file to stat, so a cache there would have to trust that no other
 * replica has written — which is exactly the assumption a networked database
 * exists to avoid.
 */
export function withReadCache<T>(inner: MinimalAdapter<T>, file: string): MinimalAdapter<T> & { stats: CacheStats } {
  let cached: T | null = null;
  let stamp: Stamp | null = null;
  const stats: CacheStats = { hits: 0, misses: 0, writes: 0 };

  return {
    stats,

    async read(): Promise<T | null> {
      const now = stampOf(file);
      if (cached !== null && same(now, stamp)) {
        stats.hits++;
        return cached;
      }
      stats.misses++;
      const data = await inner.read();
      // Re-stat AFTER the read. If the file changed while we were reading it,
      // the stamp we store must describe what we actually parsed, not what was
      // there before — otherwise the next request trusts a mismatched entry.
      stamp = stampOf(file);
      cached = data;
      return data;
    },

    async write(data: T): Promise<void> {
      stats.writes++;
      await inner.write(data);
      // Adopt the just-written document rather than dropping the cache: the
      // next read is almost always the same request continuing, and re-parsing
      // what we just serialised is the exact waste this class exists to remove.
      cached = data;
      stamp = stampOf(file);
    },
  };
}
