/**
 * The storage a plugin actually gets.
 *
 * A thin, namespaced facade over `LocalDB.getPluginData` and friends. It exists
 * so a plugin never handles a raw namespace string — every method is already
 * scoped to the plugin that was handed the store, which is what makes "one
 * plugin cannot read another's data" a property of the API rather than a rule
 * plugin authors have to remember.
 *
 * ## Why it is deliberately small
 *
 * No query language, no joins, no indexes beyond the namespace. A plugin that
 * needs those should keep its own database; what this is for is the long tail
 * of modules that need to persist a few thousand records and currently cannot
 * persist anything at all.
 *
 * `list()` filtering happens in this process. That is honest for the sizes this
 * is meant for and dishonest above them, so `list()` says so and the record cap
 * is enforced rather than implied.
 */

import type { PluginDataRecord } from '../../core/models';

/** The storage calls this module needs. Injected so it is testable offline. */
export interface PluginDataBackend {
  getPluginData(ns: string): Promise<PluginDataRecord[]>;
  getPluginDataRecord(ns: string, id: string): Promise<PluginDataRecord | undefined>;
  putPluginData(ns: string, id: string, data: Record<string, unknown>): Promise<PluginDataRecord>;
  deletePluginDataRecord(ns: string, id: string): Promise<boolean>;
  deletePluginData(ns: string): Promise<number>;
}

/**
 * Reject anything that could escape its own namespace or break the key.
 *
 * The leading character must be alphanumeric, which RESERVES `_`-prefixed
 * collections for the platform. That is not cosmetic: the migration runner
 * keeps a plugin's applied version in `_meta`, and a plugin able to name a
 * collection `_meta` could overwrite its own schema version and silently
 * re-run or skip its migrations.
 */
const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export function isValidPluginId(id: unknown): id is string {
  return typeof id === 'string' && NAME.test(id);
}

export function isValidCollection(name: unknown): name is string {
  return typeof name === 'string' && NAME.test(name);
}

/**
 * Build a namespace key.
 *
 * Throws rather than sanitising. A collection name is written by a plugin
 * author, not a user, so an invalid one is a bug to surface at the first call —
 * and quietly rewriting it would mean data written under one key and read back
 * under another.
 */
export function namespaceFor(pluginId: string, collection: string): string {
  if (!isValidPluginId(pluginId)) throw new Error(`Invalid plugin id "${pluginId}"`);
  if (!isValidCollection(collection)) {
    throw new Error(
      `Invalid collection name "${collection}" — letters, digits, dash and underscore, up to 64 characters`,
    );
  }
  return `${pluginId}:${collection}`;
}

/** How many records one `list()` will return. */
export const PLUGIN_LIST_CAP = 5000;

export interface PluginStore {
  /**
   * Every record in a collection, oldest first.
   *
   * Capped at PLUGIN_LIST_CAP. A plugin holding more than that has outgrown
   * this store, and silently returning a prefix would be the kind of filter
   * that looks like an answer.
   */
  list<T = Record<string, unknown>>(collection: string): Promise<{ id: string; data: T }[]>;
  get<T = Record<string, unknown>>(collection: string, id: string): Promise<T | undefined>;
  /** Insert or replace. Returns the stored value. */
  put<T extends Record<string, unknown>>(collection: string, id: string, data: T): Promise<T>;
  delete(collection: string, id: string): Promise<boolean>;
  /** Remove every record in a collection. Returns how many went. */
  clear(collection: string): Promise<number>;
}

export function createPluginStore(pluginId: string, backend: PluginDataBackend): PluginStore {
  const ns = (collection: string) => namespaceFor(pluginId, collection);
  return {
    async list<T>(collection: string) {
      const rows = await backend.getPluginData(ns(collection));
      if (rows.length > PLUGIN_LIST_CAP) {
        console.warn(
          `[astrobaas] plugin "${pluginId}" collection "${collection}" holds ${rows.length} records; `
          + `list() returns the first ${PLUGIN_LIST_CAP}. This store is not built for that size.`,
        );
      }
      return rows.slice(0, PLUGIN_LIST_CAP).map((r) => ({ id: r.id, data: r.data as T }));
    },
    async get<T>(collection: string, id: string) {
      const row = await backend.getPluginDataRecord(ns(collection), String(id));
      return row ? (row.data as T) : undefined;
    },
    async put<T extends Record<string, unknown>>(collection: string, id: string, data: T) {
      const key = String(id);
      if (!key) throw new Error('A plugin record needs an id');
      // A stored record is a SNAPSHOT, taken here rather than left to the
      // backend — because the backends disagree.
      //
      // The relational driver serialises to JSON at write time, so a later
      // mutation of the caller's object is lost. The document drivers keep the
      // object in memory and serialise on flush, so the SAME mutation is
      // silently persisted. A plugin author who mutates an object after storing
      // it would therefore get different data depending on which driver the
      // operator runs, which is worse than either behaviour on its own.
      //
      // JSON is the right shape of copy, not structuredClone: whatever cannot
      // survive a JSON round trip cannot be stored by the relational driver
      // either, so this fails fast and identically everywhere instead of
      // working on two drivers out of three.
      const snapshot = JSON.parse(JSON.stringify(data)) as T;
      await backend.putPluginData(ns(collection), key, snapshot);
      return snapshot;
    },
    delete(collection: string, id: string) {
      return backend.deletePluginDataRecord(ns(collection), String(id));
    },
    clear(collection: string) {
      return backend.deletePluginData(ns(collection));
    },
  };
}

/* ------------------------------------------------------------------ *
 * Per-plugin migrations
 * ------------------------------------------------------------------ */

export interface PluginMigration {
  /** Monotonic, starting at 1. Gaps are fine; order is by this number. */
  version: number;
  name: string;
  up(store: PluginStore): Promise<void> | void;
}

/**
 * Where a plugin's applied version is kept.
 *
 * A `_`-prefixed collection, which `namespaceFor` refuses for plugin-supplied
 * names — so this record exists in a namespace the plugin itself cannot reach
 * through its own store. A plugin that could rewrite its schema version could
 * make its migrations re-run or never run, on data it has already transformed.
 */
const META_COLLECTION = '_meta';
const VERSION_ID = 'schema';

/** Internal namespace. Bypasses the collection-name check deliberately. */
function metaNamespace(pluginId: string): string {
  if (!isValidPluginId(pluginId)) throw new Error(`Invalid plugin id "${pluginId}"`);
  return `${pluginId}:${META_COLLECTION}`;
}

export async function appliedVersion(
  pluginId: string,
  backend: PluginDataBackend,
): Promise<number> {
  const rec = await backend.getPluginDataRecord(metaNamespace(pluginId), VERSION_ID);
  const v = (rec?.data as { version?: unknown } | undefined)?.version;
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0;
}

export interface MigrationOutcome {
  from: number;
  to: number;
  applied: string[];
  failed?: { version: number; name: string; error: string };
}

/**
 * Bring a plugin's data up to date.
 *
 * Run once per bootstrap, inside the bootstrap promise, so concurrent requests
 * cannot start a second pass. That is a per-PROCESS guarantee only — the same
 * one core's own migration runner gives — so across replicas two processes can
 * still run the same migration at the same time. `up()` must therefore be
 * idempotent, and this says so rather than implying it.
 *
 * A failure STOPS the run and leaves the version at the last success. Carrying
 * on would apply v3 to data that v2 never transformed, which is how a partial
 * migration becomes an unrecoverable one.
 */
export async function runPluginMigrations(
  pluginId: string,
  migrations: readonly PluginMigration[],
  store: PluginStore,
  backend: PluginDataBackend,
  log: (msg: string) => void = (m) => console.log(m),
): Promise<MigrationOutcome> {
  const ordered = [...migrations]
    .filter((m) => m && Number.isInteger(m.version) && m.version > 0 && typeof m.up === 'function')
    .sort((a, b) => a.version - b.version);

  const from = await appliedVersion(pluginId, backend);
  const pending = ordered.filter((m) => m.version > from);
  if (pending.length === 0) return { from, to: from, applied: [] };

  const applied: string[] = [];
  let current = from;
  for (const m of pending) {
    try {
      await m.up(store);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error(
        `[astrobaas] plugin "${pluginId}" migration v${m.version} (${m.name}) FAILED: ${error}. `
        + `Stopping at v${current} — later migrations assume this one ran.`,
      );
      return { from, to: current, applied, failed: { version: m.version, name: m.name, error } };
    }
    current = m.version;
    applied.push(`v${m.version} ${m.name}`);
    // Stamped after EACH migration, not once at the end: a crash halfway
    // through a run must not re-apply the ones that already succeeded.
    await backend.putPluginData(metaNamespace(pluginId), VERSION_ID, { version: current });
  }

  log(`[astrobaas] plugin "${pluginId}" data migrated v${from} → v${current} (${applied.length} applied)`);
  return { from, to: current, applied };
}
