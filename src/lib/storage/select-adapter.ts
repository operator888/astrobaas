/**
 * Choose the persistence engine at boot from the environment.
 *
 *   DATABASE_URL set + DATABASE_DRIVER=relational
 *                               → relational SqlStorage (per-entity rows; real
 *                                 concurrency + partial updates). LocalDB
 *                                 delegates to it directly, so the returned lowdb
 *                                 adapter here is an unused in-memory stub.
 *   DATABASE_URL set            → libSQL/SQLite doc-blob (durable, deploy-portable,
 *                                 last-write-wins). Default for a DATABASE_URL.
 *   unset (default)             → lowdb JSON file at DB_PATH. Zero-config local dev.
 *
 * The lowdb-backed drivers satisfy lowdb's Adapter contract, so LocalDB's lowdb
 * path is identical between them.
 */
import { JSONFile } from 'lowdb/node';
import { Memory } from 'lowdb';
import fs from 'node:fs';
import path from 'node:path';
import { LibsqlAdapter } from './libsql-adapter';
import { withReadCache } from './caching-adapter';
import { getDbPath } from '../paths';

export interface ChosenAdapter<T> {
  adapter: { read(): Promise<T | null>; write(data: T): Promise<void> };
  driver: 'libsql' | 'lowdb' | 'relational';
  /** Human-readable target for startup logging (never includes the auth token). */
  describe: string;
  /** Set when driver === 'relational': the libSQL connection for SqlStorage. */
  relational?: { url: string; authToken?: string };
}

/** True when the operator opted into the relational per-entity driver. */
export function isRelational(): boolean {
  return !!process.env.DATABASE_URL?.trim() && process.env.DATABASE_DRIVER?.trim() === 'relational';
}

export function selectAdapter<T>(): ChosenAdapter<T> {
  const url = process.env.DATABASE_URL?.trim();

  if (url && isRelational()) {
    // LocalDB talks to SqlStorage directly; this in-memory adapter is never used.
    return {
      adapter: new Memory<T>(),
      driver: 'relational',
      describe: `relational libsql (${url.split('?')[0]})`,
      relational: { url, authToken: process.env.DATABASE_AUTH_TOKEN },
    };
  }

  if (url) {
    return {
      adapter: new LibsqlAdapter<T>({ url, authToken: process.env.DATABASE_AUTH_TOKEN }),
      driver: 'libsql',
      describe: `libsql (${url.split('?')[0]})`,
    };
  }

  // Default: lowdb JSON file. Seeding from db.seed.json is handled by LocalDB.
  const dbPath = getDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  // Wrapped in an mtime-validated read cache. lowdb's own read() re-parses the
  // entire JSON document on EVERY call, and LocalDB calls it from all 78
  // getters — measured at 9.4 full parses to serve one /blog request. The cache
  // is invalidated by inode/size/mtime, so a write from any other process (a
  // second replica, an import CLI, a restore) is still picked up.
  return {
    adapter: withReadCache<T>(new JSONFile<T>(dbPath), dbPath),
    driver: 'lowdb',
    describe: `lowdb (${dbPath})`,
  };
}
