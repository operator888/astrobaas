/**
 * Relational libSQL/SQLite storage driver.
 *
 * Unlike the doc-blob LibsqlAdapter (which serializes the WHOLE database into a
 * single row, last-write-wins), this stores ONE ROW PER ENTITY — each collection
 * is its own table of `(id, data JSON)`. That gives:
 *   - row-level concurrency (two writers touching different rows don't clobber),
 *   - partial updates (write one row, not the whole document),
 *   - queryability (indexable columns / json_extract filters).
 *
 * It implements the same `Storage` surface as the lowdb driver, so the app's
 * `LocalDB` façade can delegate to it transparently. Selected via
 * `DATABASE_URL` + `DATABASE_DRIVER=relational`.
 *
 * Entities are stored as JSON in a `data` column (a pragmatic middle ground: real
 * per-row storage without hand-maintaining a column for every field across an
 * evolving alpha schema). Hot lookups use `json_extract` rather than scanning.
 */
import type { PostQuery, PagedResult } from '../../core/post-query';
import { defaultLocale, locales } from '../i18n';
import type { Client, InValue } from '@libsql/client';
import {
  openSqlite, applyLocalSqlitePragmas, registerLocalSqlite, type LocalSqliteHolder, type SqliteOpenOptions,
} from './local-sqlite';
import crypto from 'node:crypto';
import { makeDefaultData, makeSeedAdmin } from '../seed-data';
import { normalizeBound, type AuditQuery } from '../../core/audit-query';
import {
  changedFieldNames,
  normalizeChangeQuery,
  normalizeChangeSince,
  pageFromRows,
  parseStoredFields,
  CONTENT_CHANGE_CAP,
  type ContentChangeMeta,
  type ContentChangePage,
  type ContentChangeQuery,
} from '../../core/change-feed';
import { LATEST_SCHEMA_VERSION } from '../migrations';
import type {
  Storage,
  UpdateProductOptions,
  OrderTransitionGuard,
  RecentOrdersQuery,
  PaymentEventClaim,
  PaymentEventClaimOptions,
  RefundAppend,
  IdempotencyClaim,
} from '../../core/storage';
import { SlugTakenError } from './slug-taken';
import type {
  ShippingMethodRecord,
  CouponRecord,
  Post,
  Category,
  User,
  MediaFile,
  Theme,
  ThemeConfig,
  Setting,
  ContentChange,
  ContactMessage,
  Subscriber,
  ConsentReceipt,
  EmailLogEntry,
  PluginRecord,
  CustomEntity,
  ApiKey,
  Webhook,
  WebhookDelivery,
  AuditEvent,
  PostRevision,
  Product,
  Brand,
  ProductCategory,
  Order,
  OrderStatus,
  Customer,
  PluginDataRecord,
  RedirectRule,
  NotFoundRecord,
  RefundRecord,
} from '../../core/models';

const newId = () => crypto.randomUUID();
const nowIso = () => new Date().toISOString();

/**
 * Delete every change older than the newest CONTENT_CHANGE_CAP, `LIMIT ?` rows
 * at a time (-1 = all of them).
 *
 * "Older" in the feed's own order, `(ts, id)` descending — the same order a
 * page is read in, so retention and paging can never disagree about which
 * entries are the newest. The subquery walks the covering (ts, id) index past
 * the entries that stay, so the cost is the cap plus what is deleted — not the
 * size of the table.
 */
const PRUNE_CHANGES_SQL =
  'DELETE FROM content_changes WHERE rowid IN ('
  + 'SELECT rowid FROM content_changes ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?)';

/**
 * Record what PRUNE_CHANGES_SQL is about to delete: per entity type, the
 * newest `ts` among exactly the rows the DELETE will take — the same subquery
 * with the same arguments, run first, in the same transaction. See
 * recordPrunedChanges in core/change-feed.ts for why the feed keeps this, and
 * why per type; it is what `meta.truncated` on the public feed is computed from.
 *
 * `max(ts, excluded.ts)` because a mark only moves forward: rows evicted later
 * are newer. `coalesce(…, '')` because a row with no readable type is still an
 * eviction a staff walk (which covers every type) must hear about, and a NULL
 * key would slip past the primary key. The WHERE clause is also what lets
 * SQLite parse `ON CONFLICT` after a SELECT without ambiguity.
 */
const RECORD_PRUNED_SQL =
  'INSERT INTO content_changes_pruned (entity_type, ts) '
  + "SELECT coalesce(json_extract(data, '$.entity_type'), ''), max(ts) FROM content_changes "
  + 'WHERE rowid IN (SELECT rowid FROM content_changes ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?) '
  + 'GROUP BY 1 ON CONFLICT(entity_type) DO UPDATE SET ts = max(ts, excluded.ts)';

/** A prune and its record, as the two batch statements every prune is. */
const pruneStatements = (limit: number, offset: number): { sql: string; args: InValue[] }[] => [
  { sql: RECORD_PRUNED_SQL, args: [limit, offset] },
  { sql: PRUNE_CHANGES_SQL, args: [limit, offset] },
];

/**
 * The most rows ONE write prunes on its way past.
 *
 * In steady state a write evicts exactly one. What this bounds is a backlog
 * left over — a database whose background prune has not finished yet, or
 * failed — where "everything over the cap" was once 99,001 rows deleted inside
 * a single save: 1.7 s with the event loop frozen and the write lock held the
 * whole time. Bounded, a backlog shrinks by at most this much per write, and a
 * write costs what a write costs.
 */
const WRITE_PRUNE_MAX = 200;

/**
 * Rows per step of the background backlog prune. Each step is one short write
 * transaction, and the prune yields to the event loop between steps.
 */
const BACKLOG_PRUNE_CHUNK = 1000;

/** Plain `(id, data)` collection tables. */
const SIMPLE_TABLES = [
  'posts',
  'categories',
  'users',
  'media',
  'themes',
  'settings',
  'messages',
  'subscribers',
  'plugins',
  'api_keys',
  'webhooks',
  'products',
  'brands',
  'product_categories',
  'orders',
  'customers',
  'shipping_methods',
  'coupons',
  /** Named monotonic counters. One row per counter; `data.value` is the number. */
  'counters',
] as const;

/**
 * A variant whose count `updateProduct` keeps from the stored row (see
 * UpdateProductOptions). `index` is its position in the SUBMITTED array, which
 * is where patchRow's json_set has just put it; `stock` is the submitted count,
 * the fallback when the stored row no longer has this variant.
 */
interface KeptVariant { index: number; id: string; stock: number | null }

function keptVariants(variants: unknown, keep: readonly string[] | undefined): KeptVariant[] {
  if (!keep?.length || !Array.isArray(variants)) return [];
  const ids = new Set(keep);
  const out: KeptVariant[] = [];
  variants.forEach((v, index) => {
    const id = (v as { id?: unknown } | null)?.id;
    if (typeof id !== 'string' || !ids.has(id)) return;
    const stock = (v as { stock?: unknown }).stock;
    out.push({ index, id, stock: typeof stock === 'number' && Number.isFinite(stock) ? Math.trunc(stock) : null });
  });
  return out;
}

/**
 * The stored variant with a given id, as JSON text, taken from the row the
 * UPDATE is writing — or NULL when it has none. On the right of `SET`, `data`
 * is the row as the UPDATE finds it, so this is read under the same write lock
 * as the write itself: nothing can commit between the read and the write.
 */
const STORED_VARIANT = `(SELECT o.value FROM json_each(data, '$.variants') o WHERE json_extract(o.value, '$.id') = ?)`;

/**
 * Wrap patchRow's expression so each kept variant's `stock` and `in_stock` come
 * from the stored variant with the same id. Everything else about the variant —
 * options, price, SKU, enabled — is the submitted value, as it always was.
 *
 * Keyed on the ID, never the array index: the editor may have removed or added
 * a variant, so the submitted index and the stored one need not match (the
 * reservation code met the same trap; see reserveVariantStock). The fallback,
 * for an id the row no longer has, is CAST to an integer because libsql binds
 * a JS number as REAL, and the count would come back as `4.0`.
 */
function keepStoredVariantStock(expr: string, args: InValue[], kept: KeptVariant[]): string {
  const sv = STORED_VARIANT;
  const storedStock = `json_extract(${sv}, '$.stock')`;
  // 25 variants per call: four arguments each plus the document is 101, under
  // SQLite's 127-argument cap on a function (patchRow chunks for the same cap).
  for (let i = 0; i < kept.length; i += 25) {
    let pairs = '';
    for (const k of kept.slice(i, i + 25)) {
      // `index` is an integer we computed, never input, so it is safe inside
      // the path literal (the same reasoning as reserveVariantStock's paths).
      const at = `$.variants[${k.index}]`;
      pairs += `, '${at}.stock', CASE WHEN ${sv} IS NULL THEN CAST(? AS INTEGER) ELSE ${storedStock} END`;
      args.push(k.id, k.stock, k.id);
      pairs += `, '${at}.in_stock', json(CASE WHEN ${sv} IS NULL THEN ? `
        + `WHEN ${storedStock} IS NULL OR ${storedStock} > 0 THEN 'true' ELSE 'false' END)`;
      args.push(k.id, k.stock === null || k.stock > 0 ? 'true' : 'false', k.id, k.id);
    }
    expr = `json_set(${expr}${pairs})`;
  }
  return expr;
}

export class SqlStorage implements Storage, LocalSqliteHolder {
  private client: Client;
  private url: string;
  private authToken?: string;
  private openOptions: SqliteOpenOptions = {};
  private ready: Promise<void> | null = null;

  /**
   * The background change-feed upkeep (see upkeepChangeFeed), started by the
   * first successful boot. Never rejects. Awaited by `changeFeedUpkeep()` in
   * localdb.ts and by the tests — never by a request, which is the point.
   */
  changeFeedUpkeep: Promise<void> = Promise.resolve();

  /** See SqliteOpenOptions: `busyTimeoutMs` is for the lock-contention tests. */
  constructor(url: string, authToken?: string, options: SqliteOpenOptions = {}) {
    // Through the shared opener, so a local file gets a busy timeout on EVERY
    // connection and a one-connection pool — see local-sqlite.ts for why a
    // PRAGMA alone was lost on the next connection the pool opened.
    this.client = openSqlite(url, authToken, options);
    this.url = url;
    this.authToken = authToken;
    this.openOptions = options;
    // A restore replaces the file under this client. Registered, it moves
    // this client onto the restored file instead of leaving it writing into
    // the replaced one — see swapLocalSqliteFile. A no-op for a remote URL.
    registerLocalSqlite(url, this);
  }

  /** For swapLocalSqliteFile only. Statements fail with CLIENT_CLOSED until reopenAfterSwap. */
  closeForSwap(): void {
    this.client.close();
  }

  /**
   * For swapLocalSqliteFile only: a new client on the file now at this path.
   * `ready` is cleared so the next call re-runs the setup against it — WAL and
   * the PRAGMAs (a restored snapshot is in rollback-journal mode), the DDL.
   */
  reopenAfterSwap(): void {
    this.client = openSqlite(this.url, this.authToken, this.openOptions);
    this.ready = null;
  }

  /* ---------- low-level helpers ---------- */
  private async exec(sql: string, args: InValue[] = []) {
    return this.client.execute({ sql, args });
  }

  private async ensureReady(): Promise<void> {
    if (this.ready) return this.ready;
    const boot = (async () => {
      // WAL and the per-connection PRAGMAs before the first statement, so the
      // DDL below already runs under them. Local files only, and it never
      // throws: a filesystem that refuses WAL must not turn this memoised
      // promise into one that fails every request.
      await applyLocalSqlitePragmas(this.client, this.url, this.openOptions);
      const ddl = SIMPLE_TABLES.map(
        (t) => `CREATE TABLE IF NOT EXISTS ${t} (id TEXT PRIMARY KEY, data TEXT NOT NULL)`,
      );
      ddl.push('CREATE TABLE IF NOT EXISTS content_changes (id TEXT PRIMARY KEY, ts TEXT NOT NULL, data TEXT NOT NULL)');
      // What retention has evicted, per entity type: one row per type, the
      // newest `ts` evicted. The public feed's `meta.truncated` is computed
      // from it (RECORD_PRUNED_SQL; recordPrunedChanges in core/change-feed.ts).
      // Here with the tables, not in the background upkeep, because every
      // recorded change writes to it — on a database created before it
      // existed, it has to be there before the first write.
      ddl.push('CREATE TABLE IF NOT EXISTS content_changes_pruned (entity_type TEXT PRIMARY KEY, ts TEXT NOT NULL)');
      ddl.push('CREATE TABLE IF NOT EXISTS custom_entities (id TEXT PRIMARY KEY, type TEXT NOT NULL, data TEXT NOT NULL)');
      ddl.push('CREATE TABLE IF NOT EXISTS webhook_deliveries (id TEXT PRIMARY KEY, webhook_id TEXT NOT NULL, ts TEXT NOT NULL, data TEXT NOT NULL)');
      ddl.push('CREATE TABLE IF NOT EXISTS audit_events (id TEXT PRIMARY KEY, action TEXT NOT NULL, ts TEXT NOT NULL, data TEXT NOT NULL)');
      ddl.push('CREATE TABLE IF NOT EXISTS post_revisions (id TEXT PRIMARY KEY, post_id TEXT NOT NULL, ts TEXT NOT NULL, data TEXT NOT NULL)');
      ddl.push('CREATE TABLE IF NOT EXISTS schema_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
      // Plugin-owned records. ONE table for every plugin, created here with all
      // the others rather than on demand: ensureReady() is memoized and runs
      // exactly once per process, so a table a plugin asked for after boot
      // would never be created at all. A shared table also means installing a
      // plugin needs no DDL privilege and no migration.
      //
      // `ns` is "<plugin-id>:<collection>", and the primary key is (ns, id) so
      // two plugins may use the same record id without colliding.
      ddl.push('CREATE TABLE IF NOT EXISTS plugin_data (ns TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (ns, id))');
      // Legacy-URL recovery. `redirects` follows the standard (id, data) shape;
      // `not_found` is keyed on the PATH because that is its identity — one row
      // per dead URL, replaced as hits accumulate.
      ddl.push('CREATE TABLE IF NOT EXISTS redirects (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
      ddl.push('CREATE TABLE IF NOT EXISTS not_found (path TEXT PRIMARY KEY, data TEXT NOT NULL)');
      ddl.push('CREATE INDEX IF NOT EXISTS idx_custom_type ON custom_entities (type)');
      // The change feed's `(ts, id)` index is NOT created here. The background
      // upkeep builds it AFTER the backlog prune, so on a database that was
      // never pruned it is built over at most the cap rather than over the
      // whole history. See upkeepChangeFeed.
      ddl.push('CREATE INDEX IF NOT EXISTS idx_deliveries_wh ON webhook_deliveries (webhook_id)');
      ddl.push('CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_events (action)');
      // Consent receipts: (id, ts, data). Their own table rather than a row in
      // audit_events, so a busy site's consent traffic cannot evict the
      // security events that log is for.
      ddl.push('CREATE TABLE IF NOT EXISTS consent_receipts (id TEXT PRIMARY KEY, ts TEXT NOT NULL, data TEXT NOT NULL)');
      ddl.push('CREATE INDEX IF NOT EXISTS idx_consent_ts ON consent_receipts (ts)');
      // The outbound email log. `recipient` is a column rather than a JSON
      // extract because the erasure path deletes by it, and that must not be a
      // full-table scan on a shop with a busy transactional mailer.
      ddl.push('CREATE TABLE IF NOT EXISTS email_log (id TEXT PRIMARY KEY, recipient TEXT NOT NULL, ts TEXT NOT NULL, data TEXT NOT NULL)');
      ddl.push('CREATE INDEX IF NOT EXISTS idx_email_log_ts ON email_log (ts)');
      ddl.push('CREATE INDEX IF NOT EXISTS idx_email_log_to ON email_log (recipient)');
      ddl.push('CREATE INDEX IF NOT EXISTS idx_revisions_post ON post_revisions (post_id)');
      // Namespace lookups are every read this table serves; without the index
      // each one is a full scan of every plugin's data.
      ddl.push('CREATE INDEX IF NOT EXISTS idx_plugin_data_ns ON plugin_data (ns)');
      // Checkout reads the newest orders on every order (the unpaid cap and
      // risk velocity), and the public payment-start route finds one order
      // by its number. Expression indexes, so neither is a scan of the whole
      // order book — the query text must match these expressions exactly.
      ddl.push("CREATE INDEX IF NOT EXISTS idx_orders_created ON orders (json_extract(data, '$.created_at'))");
      ddl.push("CREATE INDEX IF NOT EXISTS idx_orders_number ON orders (json_extract(data, '$.number'))");
      // Idempotency-Key records for POST /api/orders. `k` is already a hash;
      // `expires_at` is epoch ms, the lease while pending and the replay
      // window once answered.
      ddl.push('CREATE TABLE IF NOT EXISTS idempotency_keys (k TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, data TEXT NOT NULL)');
      for (const stmt of ddl) await this.exec(stmt);
      await this.seedIfEmpty();
    })();
    const ready: Promise<void> = boot.then(
      () => {
        // Started once the schema exists, and NOT awaited — see
        // upkeepChangeFeed for why a boot must not wait for it.
        this.changeFeedUpkeep = this.upkeepChangeFeed();
      },
      async (err) => {
        // Not memoized. A failed boot used to stay failed: every later call got
        // the same rejected promise, so one SQLITE_BUSY on the first boot after
        // an upgrade — the one boot that has DDL to write, and so needs the
        // write lock — failed every storage call until the process restarted.
        // Cleared, the next call boots again. `migrationPromise` in localdb.ts
        // does the same, for the same reason. The connections go too: the
        // statement that failed may have poisoned one.
        if (this.ready === ready) this.ready = null;
        await this.dropLocalConnections(err);
        throw err;
      },
    );
    this.ready = ready;
    return ready;
  }

  /**
   * Bring the change feed to its current shape — in the BACKGROUND, after boot.
   *
   * Two jobs, in this order:
   *
   *   1. Prune a backlog (pruneExistingChanges). Every database created before
   *      retention existed on this driver holds its whole history — every
   *      product and order save, each with a full snapshot. `recordChange`
   *      keeps a pruned table pruned; this is what gets an existing one there.
   *   2. Build the `(ts, id)` index and drop the `(ts)` index it replaces. The
   *      feed is read and pruned in `(ts, id)` order — the id is the tie-break
   *      that makes a cursor name exactly one position when a bulk import
   *      writes many changes in one millisecond. An index on `ts` alone made
   *      SQLite sort every tie group in a temp B-tree; this one serves the
   *      keyset page, the cursor range and the retention walk directly, and is
   *      COVERING for the prune, which reads nothing but `rowid`. Keeping both
   *      would cost a second index write on every change recorded.
   *
   * The index comes AFTER the prune. The old `(ts)` index is what serves the
   * prune's ORDER BY, and building the new one first meant sorting the entire
   * backlog — millions of rows on a large catalogue — into an index the prune
   * then emptied again. Built afterwards, it covers at most the cap.
   *
   * NOT awaited by `ready`. The file driver runs every statement synchronously,
   * so an awaited boot prune froze the whole process: on a 100,000-row backlog
   * the first boot took three seconds with not one timer firing, nothing
   * served, and the container health check counting. The reads do not need it —
   * every one carries its own LIMIT — so the instance serves from the moment
   * its schema exists and this runs behind it, one short step at a time.
   *
   * Runs on every boot, which is how a database created before the index or
   * the retention existed gets both on its next start, with no migration. On a
   * database already in shape it asks for no write lock at all: the prune looks
   * before it deletes, and the index statements are no-ops.
   *
   * Housekeeping, so a failure is logged and swallowed: reads are bounded
   * whether or not this finished, every write prunes a little more of a
   * backlog, and the next boot tries again. Taking the instance down because a
   * cleanup could not finish would be the wrong trade. But a failed statement
   * on a local file can POISON its connection, so the failure path drops the
   * connections rather than hand that one to the next save.
   */
  private async upkeepChangeFeed(): Promise<void> {
    try {
      await this.pruneExistingChanges();
      await this.exec('CREATE INDEX IF NOT EXISTS idx_changes_ts_id ON content_changes (ts, id)');
      await this.exec('DROP INDEX IF EXISTS idx_changes_ts');
    } catch (err) {
      console.error('[astrobaas] change-feed upkeep did not finish (the next boot retries):', err);
      await this.dropLocalConnections(err);
    }
  }

  /**
   * Delete everything over the retention cap, a step at a time, yielding to the
   * event loop between steps so requests are served while it runs.
   *
   * It LOOKS before it deletes. On a database at or under the cap — every boot
   * but the first after the upgrade — it reads one index entry and returns
   * without asking for the write lock. It used to run its DELETE on every boot,
   * and when another process held the lock that DELETE failed with SQLITE_BUSY
   * even with nothing to delete, poisoning the connection it ran on.
   *
   * Each step records what it evicts in the same transaction as the delete,
   * like every other prune (pruneStatements).
   */
  private async pruneExistingChanges(): Promise<void> {
    const over = await this.exec(
      'SELECT 1 FROM content_changes ORDER BY ts DESC, id DESC LIMIT 1 OFFSET ?',
      [CONTENT_CHANGE_CAP],
    );
    if (over.rows.length === 0) return;
    for (;;) {
      const results = await this.client.batch(pruneStatements(BACKLOG_PRUNE_CHUNK, CONTENT_CHANGE_CAP), 'write');
      if (Number(results[1]?.rowsAffected ?? 0) < BACKLOG_PRUNE_CHUNK) break;
      // A macrotask, not a resolved promise: awaiting a promise lets only other
      // microtasks in, and a request arrives as an I/O callback.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  /**
   * Drop every pooled connection of a LOCAL file database after a statement on
   * it failed.
   *
   * libsql does not reset a statement that failed with SQLITE_BUSY, and the
   * un-reset statement keeps its connection's SHARED lock. The pool hands that
   * connection to the next caller, and on it a transaction fails to commit
   * ("SQL statements in progress"), an autocommit INSERT reports success and is
   * never visible to any other connection — a save silently lost — and another
   * process's COMMIT can fail because this connection still holds the lock.
   * tests/change-feed.test.mjs reproduces it with a second process holding the
   * write lock.
   *
   * `reconnect()` closes every pooled connection and opens fresh ones, which is
   * the only public way to get rid of the poisoned one. It also fails an
   * operation that had borrowed a connection and not yet run — a narrow window
   * and a loud error, against a silent lost write. Skipped for remote clients:
   * nothing is poisoned that way there, and reconnecting would abort every
   * request in flight.
   *
   * Only for an error SQLite itself returned (`SQLITE_*`). One the CLIENT
   * raised never reached a connection — above all TRANSACTION_ACTIVE, the
   * one-connection pool refusing a statement while a transaction holds that
   * connection (see local-sqlite.ts) — and reconnecting then would close that
   * transaction under whoever opened it.
   */
  private async dropLocalConnections(err: unknown): Promise<void> {
    if (this.client.protocol !== 'file') return;
    const code = String((err as { code?: unknown } | null)?.code ?? '');
    if (!code.startsWith('SQLITE_')) return;
    try {
      await this.client.reconnect();
    } catch (err) {
      console.error('[astrobaas] could not reopen the database connections:', err);
    }
  }

  /** Seed the default document + bootstrap admin the first time the DB is empty. */
  private async seedIfEmpty(): Promise<void> {
    const res = await this.exec('SELECT count(*) AS n FROM users');
    if (Number(res.rows[0]?.n ?? 0) > 0) return;
    const data = makeDefaultData();
    const stmts: { sql: string; args: InValue[] }[] = [];
    const push = (table: string, rows: { id: string }[]) => {
      for (const row of rows) stmts.push({ sql: `INSERT OR IGNORE INTO ${table} (id, data) VALUES (?, ?)`, args: [row.id, JSON.stringify(row)] });
    };
    push('posts', data.posts);
    push('categories', data.categories);
    push('users', [...data.users, makeSeedAdmin()]);
    push('themes', data.themes);
    push('settings', data.settings);
    if (stmts.length) await this.client.batch(stmts, 'write');
    // Fresh install → stamp the current schema version so migrations never run
    // against an already-current database.
    await this.exec("INSERT OR REPLACE INTO schema_meta (k, v) VALUES ('schema_version', ?)", [
      String(LATEST_SCHEMA_VERSION),
    ]);
  }

  private async all<T>(table: string): Promise<T[]> {
    await this.ensureReady();
    const res = await this.exec(`SELECT data FROM ${table} ORDER BY rowid`);
    return res.rows.map((r) => JSON.parse(String(r.data)) as T);
  }

  private async byId<T>(table: string, id: string): Promise<T | undefined> {
    await this.ensureReady();
    const res = await this.exec(`SELECT data FROM ${table} WHERE id = ?`, [id]);
    const row = res.rows[0];
    return row ? (JSON.parse(String(row.data)) as T) : undefined;
  }

  private async insert(table: string, row: { id: string }): Promise<void> {
    await this.ensureReady();
    await this.exec(`INSERT INTO ${table} (id, data) VALUES (?, ?)`, [row.id, JSON.stringify(row)]);
  }

  private async put(table: string, id: string, row: object): Promise<void> {
    await this.exec(`UPDATE ${table} SET data = ? WHERE id = ?`, [JSON.stringify(row), id]);
  }

  private async del(table: string, id: string): Promise<boolean> {
    await this.ensureReady();
    const res = await this.exec(`DELETE FROM ${table} WHERE id = ?`, [id]);
    return (res.rowsAffected ?? 0) > 0;
  }

  /**
   * Shallow-merge `patch` into one `(id, data)` row IN ONE STATEMENT, and
   * return the row as that statement wrote it (null when there is no row).
   *
   * ## Why not SELECT, merge, UPDATE
   *
   * That was `updateProduct`, `updateOrder` and `updateCustomer`, and on a row
   * that something ELSE writes it loses that write. A product row is written by
   * checkout: `reserveStock` decrements the count in its own conditional
   * UPDATE. A save that read the row before the reservation and wrote it back
   * after put the old count back — the unit was in a customer's basket and on
   * sale again. An admin editing a description, an ERP pushing a price, the
   * scheduler opening a sale: all of them are `updateProduct`, and checkout
   * does not pause for any of them. An order row is written by the payment
   * webhook and by staff, and whichever landed second erased the other's field.
   * `tests/stock-race.test.mjs` reproduces all three by running the interfering
   * write between the read and the write.
   *
   * ## What this does instead
   *
   * `json_set(data, '$."key"', json(?), …)` for every key the caller supplied
   * and `json_remove` for a key supplied as `undefined`, evaluated against the
   * row AS IT IS when the UPDATE runs. A key the caller did not mention — the
   * count a reservation just took, the note staff just added — is never
   * written, so it can never be written back stale.
   *
   * The semantics are the old `{ ...existing, ...patch }`, minus the window:
   * shallow, so a supplied object or array REPLACES the stored one; and a key
   * set to `undefined` disappears, exactly as JSON.stringify dropped it before.
   * No retry loop and no version column — nothing was read, so there is nothing
   * to compare. A patch that explicitly carries `stock` or `variants` still
   * writes them: that is an operator or an ERP SETTING the count — unless the
   * caller says a variant's count is one it did not change, which `extend`
   * handles (updateProduct's keepStoredVariantStock).
   *
   * `extend` wraps the finished expression and pushes its own arguments; it
   * runs last, so what it writes wins over the patch.
   */
  private async patchRow<T>(
    table: string, id: string, patch: Record<string, unknown>,
    extend?: (expr: string, args: InValue[]) => string,
  ): Promise<T | null> {
    await this.ensureReady();
    const args: InValue[] = [];
    let expr = this.patchExpr('data', patch, args);
    if (extend) expr = extend(expr, args);
    const res = await this.exec(`UPDATE ${table} SET data = ${expr} WHERE id = ? RETURNING data`, [...args, id]);
    const row = res.rows[0];
    return row ? (JSON.parse(String(row.data)) as T) : null;
  }

  /**
   * patchRow's expression: `base` with every supplied key set (or removed,
   * for `undefined`), pushing its placeholders onto `args` in SQL order.
   * Shared with the conditional order writes below, so a payment patch is
   * applied by exactly the rules an updateOrder patch is.
   */
  private patchExpr(base: string, patch: Record<string, unknown>, args: InValue[]): string {
    const sets: Array<[string, string]> = [];
    const removes: string[] = [];
    for (const [key, value] of Object.entries(patch)) {
      // A JSON path quotes a label in double quotes with no escape inside
      // them, so a key containing one cannot be addressed at all. Refused
      // loudly rather than written somewhere else.
      if (key.includes('"')) {
        throw new TypeError(`Cannot store a field named ${JSON.stringify(key)}: field names may not contain a double quote`);
      }
      const at = `$."${key}"`;
      const json = value === undefined ? undefined : JSON.stringify(value);
      if (json === undefined) removes.push(at);
      else sets.push([at, json]);
    }
    let expr = base;
    // One json_set takes the whole list, but SQLite caps a function at 127
    // arguments and a full product form is past half of that — so a longer
    // patch nests a second call instead of failing. The placeholders appear
    // in the SQL in the order they are pushed: inner call first.
    for (let i = 0; i < sets.length; i += 50) {
      const chunk = sets.slice(i, i + 50);
      expr = `json_set(${expr}${', ?, json(?)'.repeat(chunk.length)})`;
      for (const [at, json] of chunk) args.push(at, json);
    }
    for (let i = 0; i < removes.length; i += 100) {
      const chunk = removes.slice(i, i + 100);
      expr = `json_remove(${expr}${', ?'.repeat(chunk.length)})`;
      args.push(...chunk);
    }
    return expr;
  }

  /**
   * Append a content-change row (mirrors the lowdb appendChange helper), and
   * keep the table at the retention cap.
   *
   * This table used to grow without bound: every product and order save wrote
   * a full snapshot, and nothing ever deleted one. The doc drivers' ring kept
   * 1,000; this now keeps the same CONTENT_CHANGE_CAP, in the feed's own
   * `(ts, id)` order.
   *
   * The insert and the prune go in ONE batch: one round trip on a remote
   * libSQL/Turso database (where a second statement per save would double the
   * latency of every product edit), and one transaction, so no reader ever sees
   * the table over the cap once it has reached it. The prune records what it
   * evicts in that same transaction (pruneStatements).
   *
   * The prune normally deletes a single row, and never more than
   * WRITE_PRUNE_MAX: a backlog the background upkeep has not finished with is
   * whittled down a slice per write, not deleted wholesale inside somebody's
   * save.
   *
   * `fields` — the names an update touched; see appendChange in localdb.ts.
   */
  private async recordChange(
    entityType: ContentChange['entity_type'],
    entityId: string,
    action: ContentChange['action'],
    changes: any,
    fields?: string[],
  ): Promise<ContentChange> {
    const change: ContentChange = {
      id: newId(),
      entity_type: entityType,
      entity_id: entityId,
      action,
      changes,
      timestamp: nowIso(),
      ...(fields ? { fields } : {}),
    };
    await this.client.batch([
      {
        sql: 'INSERT INTO content_changes (id, ts, data) VALUES (?, ?, ?)',
        args: [change.id, change.timestamp, JSON.stringify(change)],
      },
      ...pruneStatements(WRITE_PRUNE_MAX, CONTENT_CHANGE_CAP),
    ], 'write');
    return change;
  }

  /* ---------- lifecycle ---------- */
  async init(): Promise<void> {
    await this.ensureReady();
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    await this.ensureReady();
    const res = await this.exec("SELECT data FROM users WHERE lower(json_extract(data, '$.email')) = lower(?)", [email]);
    const row = res.rows[0];
    return row ? (JSON.parse(String(row.data)) as User) : undefined;
  }

  async touchLogin(userId: string): Promise<void> {
    const u = await this.byId<User>('users', userId);
    if (u) {
      u.last_login = nowIso();
      await this.put('users', userId, u);
    }
  }

  /* ---------- posts ---------- */
  getPosts(): Promise<Post[]> {
    return this.all<Post>('posts');
  }
  /**
   * The same query as `applyPostQuery`, pushed into SQL.
   *
   * Every table here is `(id, data)` with the record as a JSON blob, so filters
   * are `json_extract(data, '$.field')`. That still beats loading the
   * collection: SQLite does the scan and the slice, and only the rows for this
   * page are parsed into JavaScript.
   *
   * This is a SECOND implementation of semantics defined in
   * `src/core/post-query.ts`, which means it can disagree with the first. Two
   * places where it would be easy and silent:
   *
   *  - `total` must count rows matching the filters BEFORE limit/offset, or
   *    `hasMore` goes false early and pagination stops before the last page;
   *  - the sort must be TOTAL. Ordering on `created_at` alone lets two posts
   *    written in the same millisecond swap between pages, serving one twice
   *    and another never. `id` is the tiebreak in both implementations.
   *
   * The differential test in the smoke suite runs identical queries against all
   * three drivers and compares the output, because agreeing by inspection is
   * not the same as agreeing.
   */
  async queryPosts(query: PostQuery): Promise<PagedResult<Post>> {
    await this.ensureReady();

    const where: string[] = [];
    // Typed as the driver's parameter type rather than unknown[]: these go
    // straight into a prepared statement, and `unknown` would only be silenced
    // with a cast that hides a real mismatch.
    const args: (string | number)[] = [];
    const field = (name: string) => `json_extract(data, '$.${name}')`;

    // Absent `kind` means article, so the comparison has to tolerate NULL —
    // `<> 'page'` alone is NULL for every pre-Pages row and matches nothing.
    if (query.kind === 'page') where.push(`${field('kind')} = 'page'`);
    else if (query.kind !== 'all') where.push(`(${field('kind')} IS NULL OR ${field('kind')} <> 'page')`);

    if (query.status !== undefined) { where.push(`${field('status')} = ?`); args.push(query.status); }
    if (query.categoryId !== undefined) { where.push(`${field('category_id')} = ?`); args.push(query.categoryId); }
    if (query.authorId !== undefined) { where.push(`${field('author_id')} = ?`); args.push(query.authorId); }
    if (query.locale !== undefined) {
      // The EFFECTIVE locale, matching `recordLocale()` and the pure version:
      // anything not in the configured set folds to the default, not just NULL.
      // `COALESCE` alone was wrong — it substitutes only for a missing key, so
      // a post carrying a stale or since-removed locale disappeared instead of
      // falling back.
      const known = locales();
      const holes = known.map(() => '?').join(', ');
      where.push(
        `(CASE WHEN ${field('locale')} IN (${holes}) THEN ${field('locale')} ELSE ? END) = ?`,
      );
      args.push(...known, defaultLocale(), query.locale);
    }
    if (query.visibility) {
      if (query.visibility.orAuthorId) {
        where.push(`(${field('status')} = 'published' OR ${field('author_id')} = ?)`);
        args.push(query.visibility.orAuthorId);
      } else {
        where.push(`${field('status')} = 'published'`);
      }
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const countRes = await this.exec(`SELECT COUNT(*) AS n FROM posts ${clause}`, args);
    const total = Number(countRes.rows[0]?.n ?? 0);

    // Sorting a JSON string lexicographically is only equivalent to sorting by
    // time because `created_at` is ALWAYS `new Date().toISOString()` — the
    // storage layer stamps it and `createPost` takes `Omit<Post, 'created_at'>`,
    // so a caller cannot supply another format. Fixed-width ISO-8601 UTC orders
    // identically as text and as a date. If that ever stops being true, this
    // ORDER BY silently disagrees with the pure implementation.
    const dir = query.sort === 'created_asc' ? 'ASC' : 'DESC';
    // COALESCE on BOTH new keys, and this is the whole risk of the feature.
    // `json_extract` returns NULL for a field absent from the row, and every
    // post written before pinning existed has neither — so a bare
    // `ORDER BY pinned DESC` sorts every existing row into the wrong place on
    // the relational driver ONLY. The defaults mirror the pure comparator
    // exactly: not pinned = 0, no manual position = MAX_SAFE_INTEGER.
    //
    // `pinned` is DESC regardless of `dir`: pinning is not a direction, and
    // `?sort=created_asc` asking for oldest first must not also mean
    // "pinned last".
    const order = [
      `COALESCE(${field('pinned')}, 0) DESC`,
      `COALESCE(${field('menu_order')}, 9007199254740991) ASC`,
      `${field('created_at')} ${dir}`,
      `id ${dir}`,
    ].join(', ');
    let sql = `SELECT data FROM posts ${clause} ORDER BY ${order}`;
    const pageArgs = [...args];
    if (query.limit !== undefined) {
      sql += ' LIMIT ? OFFSET ?';
      pageArgs.push(Math.max(0, query.limit), Math.max(0, query.offset ?? 0));
    } else if (query.offset) {
      // SQLite requires a LIMIT before OFFSET; -1 means "no limit".
      sql += ' LIMIT -1 OFFSET ?';
      pageArgs.push(Math.max(0, query.offset));
    }

    const res = await this.exec(sql, pageArgs);
    return { items: res.rows.map((r) => JSON.parse(String(r.data)) as Post), total };
  }

  getPost(id: string): Promise<Post | undefined> {
    return this.byId<Post>('posts', id);
  }
  /**
   * Create a post, with slug uniqueness enforced ATOMICALLY.
   *
   * There is no unique index to lean on — every table here is `(id, data)`,
   * and adding one to a live shop that may already hold duplicates is not a
   * migration worth risking. So the insert itself carries the condition:
   * `INSERT ... SELECT ... WHERE NOT EXISTS (...)` is evaluated and applied in
   * one statement, so two concurrent creates cannot both observe the slug as
   * free. A rejected attempt (`rowsAffected === 0`) retries with a suffix.
   *
   * Doing it as a separate SELECT then INSERT is what let two duplicates take
   * the same slug: the second post then became permanently unreachable,
   * because every resolver takes the first match — and both requests were
   * answered 201, so nothing surfaced until a URL served the wrong article.
   */
  async createPost(post: Omit<Post, 'id' | 'created_at' | 'updated_at'>): Promise<Post> {
    await this.ensureReady();
    const MAX_SLUG = 80;
    const base = (post.slug ?? '').slice(0, MAX_SLUG);
    for (let attempt = 0; attempt <= 200; attempt += 1) {
      const slug = attempt === 0
        ? base
        : `${base.slice(0, MAX_SLUG - String(attempt + 1).length - 1)}-${attempt + 1}`;
      const newPost: Post = {
        ...(post as Post), slug, id: newId(), created_at: nowIso(), updated_at: nowIso(),
      };
      const res = await this.exec(
        "INSERT INTO posts (id, data) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM posts WHERE json_extract(data, '$.slug') = ?)",
        [newPost.id, JSON.stringify(newPost), slug],
      );
      if ((res.rowsAffected ?? 0) > 0) {
        await this.recordChange('post', newPost.id, 'create', newPost);
        return newPost;
      }
    }
    // Two hundred posts contesting one slug is no longer a naming problem.
    const fallback: Post = {
      ...(post as Post),
      slug: `${base.slice(0, MAX_SLUG - 7)}-${newId().slice(0, 6)}`,
      id: newId(), created_at: nowIso(), updated_at: nowIso(),
    };
    await this.insert('posts', fallback);
    await this.recordChange('post', fallback.id, 'create', fallback);
    return fallback;
  }
  /**
   * Add to view counters, and touch nothing else.
   *
   * NOT `updatePost`. That stamps `updated_at` and appends a full old+new
   * snapshot to the content change feed — so a READ would have moved the
   * article's modification date (which the sitemap publishes as `lastmod`) and
   * pushed real editorial history out of a capped feed. A view is not an edit.
   *
   * One statement per post, each reading and writing inside the same UPDATE, so
   * two processes counting the same article cannot lose each other's increments
   * the way a read-modify-write in application code would.
   */
  async bumpPostViews(deltas: ReadonlyMap<string, number>): Promise<number> {
    if (deltas.size === 0) return 0;
    await this.ensureReady();
    let written = 0;
    // A statement that throws part-way leaves the counts it ALREADY wrote
    // written, and the caller puts the whole batch back — so those posts get
    // counted twice on the retry. Recording what landed lets the caller put
    // back only what did not.
    const done = new Set<string>();
    for (const [id, delta] of deltas) {
      if (!Number.isFinite(delta) || delta <= 0) continue;
      let res;
      try {
        res = await this.exec(
          `UPDATE posts SET data = json_set(
             data, '$.views',
             COALESCE(CAST(json_extract(data, '$.views') AS INTEGER), 0) + ?
           ) WHERE id = ?`,
          [delta, id],
        );
      } catch (err) {
        // Tell the caller which ids already landed, so its retry does not
        // count them a second time.
        (err as { landed?: Set<string> }).landed = done;
        throw err;
      }
      done.add(id);
      if ((res.rowsAffected ?? 0) > 0) written += 1;
    }
    return written;
  }

  async updatePost(id: string, updates: Partial<Post>): Promise<Post | null> {
    const existing = await this.byId<Post>('posts', id);
    if (!existing) return null;
    const updated: Post = { ...existing, ...updates, updated_at: nowIso() };
    // Conditional UPDATE when the slug changes: evaluated and applied in ONE
    // statement, so two concurrent renames cannot both observe it as free.
    // Refuses rather than renames — on update the author typed the slug.
    if (typeof updates.slug === 'string' && updates.slug !== existing.slug) {
      await this.ensureReady();
      const res = await this.exec(
        "UPDATE posts SET data = ? WHERE id = ? AND NOT EXISTS (SELECT 1 FROM posts p2 WHERE json_extract(p2.data, '$.slug') = ? AND p2.id != ?)",
        [JSON.stringify(updated), id, updates.slug, id],
      );
      if ((res.rowsAffected ?? 0) === 0) throw new SlugTakenError(updates.slug);
      await this.recordChange('post', id, 'update', { old: existing, new: updated, changes: updates }, changedFieldNames(updates));
      return updated;
    }
    await this.put('posts', id, updated);
    await this.recordChange('post', id, 'update', { old: existing, new: updated, changes: updates }, changedFieldNames(updates));
    return updated;
  }
  async deletePost(id: string): Promise<boolean> {
    const existing = await this.byId<Post>('posts', id);
    if (!existing) return false;
    await this.del('posts', id);
    await this.recordChange('post', id, 'delete', existing);
    return true;
  }

  /* ---------- categories ---------- */
  getCategories(): Promise<Category[]> {
    return this.all<Category>('categories');
  }
  async createCategory(category: Omit<Category, 'id' | 'created_at' | 'updated_at'>): Promise<Category> {
    const rec: Category = { ...(category as Category), id: newId(), created_at: nowIso(), updated_at: nowIso() };
    await this.insert('categories', rec);
    return rec;
  }
  async updateCategory(id: string, updates: Partial<Category>): Promise<Category | null> {
    const existing = await this.byId<Category>('categories', id);
    if (!existing) return null;
    const updated: Category = { ...existing, ...updates, updated_at: nowIso() };
    await this.put('categories', id, updated);
    return updated;
  }
  /* ---------- commerce ---------- */
  getProducts(): Promise<Product[]> {
    return this.all<Product>('products');
  }
  async getProduct(id: string): Promise<Product | null> {
    return (await this.byId<Product>('products', id)) ?? null;
  }
  async getProductBySlug(slug: string): Promise<Product | null> {
    await this.ensureReady();
    const res = await this.exec(
      "SELECT data FROM products WHERE json_extract(data,'$.slug') = ?", [slug]);
    return res.rows[0] ? (JSON.parse(String(res.rows[0].data)) as Product) : null;
  }
  async createProduct(p: Omit<Product, 'id' | 'created_at' | 'updated_at'>): Promise<Product> {
    const rec: Product = { ...(p as Product), id: newId(), created_at: nowIso(), updated_at: nowIso() };
    await this.insert('products', rec);
    await this.recordChange('product', rec.id, 'create', rec);
    return rec;
  }
  async updateProduct(id: string, updates: Partial<Product>, opts?: UpdateProductOptions): Promise<Product | null> {
    // One statement, touching only the keys supplied — see patchRow. The
    // read-then-write this replaced gave back stock checkout had just taken.
    // A variant the caller did not recount keeps its STORED count, read inside
    // that same UPDATE — see keepStoredVariantStock.
    const kept = keptVariants(updates.variants, opts?.keepVariantStock);
    const updated = await this.patchRow<Product>(
      'products', id, { ...updates, updated_at: nowIso() },
      kept.length ? (expr, args) => keepStoredVariantStock(expr, args, kept) : undefined,
    );
    if (!updated) return null;
    await this.recordChange('product', id, 'update', updated, changedFieldNames(updates));
    return updated;
  }
  async deleteProduct(id: string): Promise<boolean> {
    const ok = await this.del('products', id);
    if (ok) await this.recordChange('product', id, 'delete', { id });
    return ok;
  }

  getShippingMethods(): Promise<ShippingMethodRecord[]> {
    return this.all<ShippingMethodRecord>('shipping_methods');
  }
  async createShippingMethod(m: Omit<ShippingMethodRecord, 'id' | 'created_at' | 'updated_at'>) {
    const rec: ShippingMethodRecord = { ...(m as ShippingMethodRecord), id: newId(), created_at: nowIso(), updated_at: nowIso() };
    await this.insert('shipping_methods', rec);
    return rec;
  }
  async updateShippingMethod(id: string, updates: Partial<ShippingMethodRecord>) {
    const existing = await this.byId<ShippingMethodRecord>('shipping_methods', id);
    if (!existing) return null;
    const updated = { ...existing, ...updates, id, updated_at: new Date().toISOString() };
    await this.put('shipping_methods', id, updated);
    return updated;
  }
  deleteShippingMethod(id: string): Promise<boolean> {
    return this.del('shipping_methods', id);
  }

  getCoupons(): Promise<CouponRecord[]> {
    return this.all<CouponRecord>('coupons');
  }
  async createCoupon(c: Omit<CouponRecord, 'id' | 'created_at' | 'updated_at'>) {
    const rec: CouponRecord = { ...(c as CouponRecord), id: newId(), created_at: nowIso(), updated_at: nowIso() };
    await this.insert('coupons', rec);
    return rec;
  }
  async updateCoupon(id: string, updates: Partial<CouponRecord>) {
    const existing = await this.byId<CouponRecord>('coupons', id);
    if (!existing) return null;
    const updated = { ...existing, ...updates, id, updated_at: new Date().toISOString() };
    await this.put('coupons', id, updated);
    return updated;
  }
  deleteCoupon(id: string): Promise<boolean> {
    return this.del('coupons', id);
  }

  /**
   * Storage.claimCouponUse as one conditional UPDATE: the limit is in the
   * WHERE clause and the increment reads the count in the row being written,
   * so of two claims on the last use exactly one matches.
   */
  async claimCouponUse(id: string): Promise<boolean> {
    await this.ensureReady();
    const res = await this.exec(
      `UPDATE coupons
          SET data = json_set(data,
                '$.used_count', coalesce(json_extract(data, '$.used_count'), 0) + 1,
                '$.updated_at', ?)
        WHERE id = ?
          AND (json_extract(data, '$.usage_limit') IS NULL
               OR coalesce(json_extract(data, '$.used_count'), 0) < json_extract(data, '$.usage_limit'))`,
      [nowIso(), id],
    );
    return Number(res.rowsAffected ?? 0) > 0;
  }

  async releaseCouponUse(id: string): Promise<void> {
    await this.ensureReady();
    await this.exec(
      `UPDATE coupons
          SET data = json_set(data,
                '$.used_count', max(coalesce(json_extract(data, '$.used_count'), 0) - 1, 0),
                '$.updated_at', ?)
        WHERE id = ?`,
      [nowIso(), id],
    );
  }

  /**
   * Atomic counter via a conditional UPDATE, then a retry loop for the
   * first-use case.
   *
   * The UPDATE ... WHERE json_extract(...) = ? is the atomic part: only one
   * concurrent caller can match a given current value, so only one wins each
   * increment. A read-then-write pair here would hand two checkouts the same
   * order number, which is the bug this replaces.
   */
  async nextSequence(name: string): Promise<number> {
    await this.ensureReady();
    const id = `seq:${name}`;
    for (let attempt = 0; attempt < 10; attempt++) {
      const row = await this.byId<{ id: string; value: number }>('counters', id);
      if (!row) {
        try {
          await this.insert('counters', { id, value: 1 } as any);
          return 1;
        } catch {
          continue; // another writer created it first; re-read and increment
        }
      }
      const current = Number((row as any).value) || 0;
      const next = current + 1;
      const res = await this.exec(
        `UPDATE counters
            SET data = json_set(data, '$.value', ?)
          WHERE id = ? AND json_extract(data, '$.value') = ?`,
        [next, id, current],
      );
      if (Number(res.rowsAffected ?? 0) > 0) return next;
      // Lost the race — somebody else incremented. Try again with a fresh read.
    }
    throw new Error('Could not allocate a sequence number after 10 attempts');
  }

  getBrands(): Promise<Brand[]> {
    return this.all<Brand>('brands');
  }
  async createBrand(b: Omit<Brand, 'id' | 'created_at' | 'updated_at'>): Promise<Brand> {
    const rec: Brand = { ...(b as Brand), id: newId(), created_at: nowIso(), updated_at: nowIso() };
    await this.insert('brands', rec);
    return rec;
  }
  async updateBrand(id: string, updates: Partial<Brand>): Promise<Brand | null> {
    const existing = await this.byId<Brand>('brands', id);
    if (!existing) return null;
    const updated: Brand = { ...existing, ...updates, updated_at: nowIso() };
    await this.put('brands', id, updated);
    return updated;
  }
  deleteBrand(id: string): Promise<boolean> {
    return this.del('brands', id);
  }

  getProductCategories(): Promise<ProductCategory[]> {
    return this.all<ProductCategory>('product_categories');
  }
  async createProductCategory(c: Omit<ProductCategory, 'id' | 'created_at' | 'updated_at'>): Promise<ProductCategory> {
    const rec: ProductCategory = { ...(c as ProductCategory), id: newId(), created_at: nowIso(), updated_at: nowIso() };
    await this.insert('product_categories', rec);
    return rec;
  }
  async updateProductCategory(id: string, updates: Partial<ProductCategory>): Promise<ProductCategory | null> {
    const existing = await this.byId<ProductCategory>('product_categories', id);
    if (!existing) return null;
    const updated: ProductCategory = { ...existing, ...updates, updated_at: nowIso() };
    await this.put('product_categories', id, updated);
    return updated;
  }
  deleteProductCategory(id: string): Promise<boolean> {
    return this.del('product_categories', id);
  }

  getOrders(): Promise<Order[]> {
    return this.all<Order>('orders');
  }
  async getOrder(id: string): Promise<Order | null> {
    return (await this.byId<Order>('orders', id)) ?? null;
  }
  async createOrder(o: Omit<Order, 'id' | 'created_at' | 'updated_at'>): Promise<Order> {
    const rec: Order = { ...(o as Order), id: newId(), created_at: nowIso(), updated_at: nowIso() };
    await this.insert('orders', rec);
    await this.recordChange('order', rec.id, 'create', rec);
    return rec;
  }
  async updateOrder(id: string, updates: Partial<Order>): Promise<Order | null> {
    // Same mechanism as updateProduct, different casualty: the payment webhook
    // marking an order paid while staff add a packing note, and one of the two
    // edits silently vanishing. Partial and in SQL — see patchRow.
    const updated = await this.patchRow<Order>('orders', id, { ...updates, updated_at: nowIso() });
    if (!updated) return null;
    await this.recordChange('order', id, 'update', updated, changedFieldNames(updates));
    return updated;
  }
  /**
   * The status move as ONE conditional statement: the WHERE clause carries the
   * status the caller decided from, so of two requests that both read
   * `processing` exactly one matches a row and the other gets nothing back.
   * That "nothing" is the whole point — see Storage.transitionOrderStatus.
   *
   * `IS ?` rather than `= ?` for the payment pin, because an absent
   * payment_status extracts as NULL and `NULL = NULL` is not true.
   *
   * The change-feed row is written only for the request that won, and after
   * the move, as updateOrder writes it.
   */
  async transitionOrderStatus(
    id: string, from: OrderStatus, to: OrderStatus, guard?: OrderTransitionGuard, set?: Partial<Order>,
  ): Promise<Order | null> {
    await this.ensureReady();
    const pinPayment = guard?.paymentStatus !== undefined;
    // `set` rides in the same statement (patchExpr, the rules updateOrder
    // uses): its placeholders come after the status and timestamp, which are
    // innermost in the expression, and before the WHERE arguments.
    const args: InValue[] = [to, nowIso()];
    const expr = this.patchExpr(`json_set(data, '$.status', ?, '$.updated_at', ?)`, set ?? {}, args);
    args.push(id, from);
    if (pinPayment) args.push(guard!.paymentStatus ?? null);
    const res = await this.exec(
      `UPDATE orders
          SET data = ${expr}
        WHERE id = ?
          AND json_extract(data, '$.status') = ?
          ${pinPayment ? `AND json_extract(data, '$.payment_status') IS ?` : ''}
        RETURNING data`,
      args,
    );
    const row = res.rows[0];
    if (!row) return null;
    const updated = JSON.parse(String(row.data)) as Order;
    await this.recordChange('order', id, 'update', updated);
    return updated;
  }
  async deleteOrder(id: string): Promise<boolean> {
    const ok = await this.del('orders', id);
    if (ok) await this.recordChange('order', id, 'delete', { id });
    return ok;
  }

  /**
   * Storage.getRecentOrders in one statement over idx_orders_created: the
   * LIMIT is "everything since `since`, at least `atLeast`, at most
   * `atMost`", counted by the same index it then reads.
   */
  async getRecentOrders(query: RecentOrdersQuery): Promise<Order[]> {
    await this.ensureReady();
    const atLeast = Math.max(0, Math.floor(query.atLeast ?? 0));
    const atMost = Math.max(0, Math.floor(query.atMost ?? 5000));
    const res = await this.exec(
      `SELECT data FROM orders
        ORDER BY json_extract(data, '$.created_at') DESC, rowid DESC
        LIMIT min(?, max(?, (SELECT count(*) FROM orders WHERE json_extract(data, '$.created_at') >= ?)))`,
      [atMost, atLeast, query.since],
    );
    return res.rows.map((r) => JSON.parse(String(r.data)) as Order);
  }

  async getOrderByNumber(number: string): Promise<Order | null> {
    await this.ensureReady();
    const res = await this.exec(
      `SELECT data FROM orders WHERE json_extract(data, '$.number') = ? ORDER BY rowid LIMIT 1`,
      [number],
    );
    const row = res.rows[0];
    return row ? (JSON.parse(String(row.data)) as Order) : null;
  }

  /**
   * Storage.claimPaymentEvent as one conditional UPDATE.
   *
   * The ledger check is `NOT EXISTS (… json_each(payment_events) …)` and the
   * payment pin is `IS ?` (an absent status extracts as NULL), both in the
   * WHERE clause, so the decision and the write cannot be separated. The id is
   * appended with `$[#]`; a ledger over its bound loses its oldest entry in a
   * second statement, which is idempotent and never drops the id just added.
   */
  async claimPaymentEvent(
    id: string, eventId: string, patch: Partial<Order>, opts: PaymentEventClaimOptions,
  ): Promise<PaymentEventClaim> {
    await this.ensureReady();
    const args: InValue[] = [];
    let expr = 'data';
    if (eventId) {
      expr = `json_insert(CASE WHEN json_type(data, '$.payment_events') = 'array' THEN data
                              ELSE json_set(data, '$.payment_events', json('[]')) END,
                         '$.payment_events[#]', ?)`;
      args.push(eventId);
    }
    if (opts.countDecline) {
      expr = `json_set(${expr}, '$.payment_declines', coalesce(json_extract(data, '$.payment_declines'), 0) + 1)`;
    }
    expr = this.patchExpr(expr, { ...patch, updated_at: nowIso() }, args);
    const where: string[] = ['id = ?'];
    args.push(id);
    if (eventId) {
      where.push(`NOT EXISTS (SELECT 1 FROM json_each(data, '$.payment_events') e WHERE e.value = ?)`);
      args.push(eventId);
    }
    if (opts.expectPaymentStatus !== undefined) {
      where.push(`json_extract(data, '$.payment_status') IS ?`);
      args.push(opts.expectPaymentStatus ?? null);
    }
    const res = await this.exec(`UPDATE orders SET data = ${expr} WHERE ${where.join(' AND ')} RETURNING data`, args);
    const row = res.rows[0];
    if (!row) {
      const now = await this.byId<Order>('orders', id);
      if (!now) return { outcome: 'missing' };
      if (eventId && (now.payment_events ?? []).includes(eventId)) return { outcome: 'duplicate' };
      return { outcome: 'changed' };
    }
    let updated = JSON.parse(String(row.data)) as Order;
    if (eventId && (updated.payment_events?.length ?? 0) > opts.history) {
      const trimmed = await this.exec(
        `UPDATE orders SET data = json_remove(data, '$.payment_events[0]')
          WHERE id = ? AND json_array_length(data, '$.payment_events') > ? RETURNING data`,
        [id, opts.history],
      );
      if (trimmed.rows[0]) updated = JSON.parse(String(trimmed.rows[0].data)) as Order;
    }
    await this.recordChange('order', id, 'update', updated);
    return { outcome: 'applied', order: updated };
  }

  /**
   * Storage.appendRefund as one conditional UPDATE: the duplicate check is in
   * the WHERE clause, and the new payment status is computed from the refunds
   * IN THE ROW plus this one — the same arithmetic as refunds.ts's
   * refundedTotal, which counts only positive whole amounts.
   */
  async appendRefund(id: string, record: RefundRecord): Promise<RefundAppend> {
    await this.ensureReady();
    const stored = `(SELECT coalesce(sum(json_extract(r.value, '$.amount_cents')), 0)
                       FROM json_each(data, '$.refunds') r
                      WHERE json_type(r.value, '$.amount_cents') = 'integer'
                        AND json_extract(r.value, '$.amount_cents') > 0)`;
    const amount = Number.isInteger(record.amount_cents) && record.amount_cents > 0 ? record.amount_cents : 0;
    const res = await this.exec(
      `UPDATE orders
          SET data = json_set(
                json_insert(CASE WHEN json_type(data, '$.refunds') = 'array' THEN data
                                 ELSE json_set(data, '$.refunds', json('[]')) END,
                            '$.refunds[#]', json(?)),
                '$.payment_status',
                CASE WHEN ${stored} + ? >= coalesce(json_extract(data, '$.total_cents'), 0)
                     THEN 'refunded' ELSE 'paid' END,
                '$.updated_at', ?)
        WHERE id = ?
          AND NOT EXISTS (SELECT 1 FROM json_each(data, '$.refunds') x WHERE json_extract(x.value, '$.id') = ?)
        RETURNING data`,
      [JSON.stringify(record), amount, nowIso(), id, record.id],
    );
    const row = res.rows[0];
    if (!row) {
      const now = await this.byId<Order>('orders', id);
      return now ? { outcome: 'duplicate', order: now } : { outcome: 'missing' };
    }
    const updated = JSON.parse(String(row.data)) as Order;
    await this.recordChange('order', id, 'update', updated);
    return { outcome: 'appended', order: updated };
  }

  /**
   * Storage.claimIdempotencyKey: an INSERT that takes over an EXPIRED row and
   * nothing else — the same upsert shape as the single-use store in
   * rate-limit.ts — so of two requests with one key exactly one gets a row
   * back.
   */
  async claimIdempotencyKey(key: string, fingerprint: string, leaseMs: number): Promise<IdempotencyClaim> {
    await this.ensureReady();
    const now = Date.now();
    const token = newId();
    const res = await this.exec(
      `INSERT INTO idempotency_keys (k, expires_at, data) VALUES (?, ?, ?)
       ON CONFLICT(k) DO UPDATE SET expires_at = excluded.expires_at, data = excluded.data
        WHERE idempotency_keys.expires_at <= ?
       RETURNING k`,
      [key, now + leaseMs, JSON.stringify({ fp: fingerprint, state: 'pending', token }), now],
    );
    // Best-effort sweep, so the table holds about a day of keys.
    this.exec('DELETE FROM idempotency_keys WHERE expires_at < ?', [now]).catch(() => {});
    if (res.rows.length > 0) return { state: 'claimed', token };
    const held = await this.exec('SELECT data FROM idempotency_keys WHERE k = ?', [key]);
    const rec = held.rows[0] ? JSON.parse(String(held.rows[0].data)) : null;
    if (!rec) {
      // Expired and swept between the two statements: claimable, so ask again.
      return this.claimIdempotencyKey(key, fingerprint, leaseMs);
    }
    return rec.state === 'done'
      ? { state: 'done', fingerprint: String(rec.fp), response: rec.response }
      : { state: 'pending', fingerprint: String(rec.fp) };
  }

  async completeIdempotencyKey(key: string, token: string, response: unknown, ttlMs: number): Promise<void> {
    await this.ensureReady();
    const held = await this.exec('SELECT data FROM idempotency_keys WHERE k = ?', [key]);
    const rec = held.rows[0] ? JSON.parse(String(held.rows[0].data)) : null;
    if (!rec) return;
    await this.exec(
      `UPDATE idempotency_keys SET expires_at = ?, data = ?
        WHERE k = ? AND json_extract(data, '$.token') = ?`,
      [Date.now() + ttlMs, JSON.stringify({ fp: rec.fp, state: 'done', token, response }), key, token],
    );
  }

  async releaseIdempotencyKey(key: string, token: string): Promise<void> {
    await this.ensureReady();
    await this.exec(
      `DELETE FROM idempotency_keys
        WHERE k = ? AND json_extract(data, '$.token') = ? AND json_extract(data, '$.state') = 'pending'`,
      [key, token],
    );
  }

  getCustomers(): Promise<Customer[]> {
    return this.all<Customer>('customers');
  }
  async getCustomer(id: string): Promise<Customer | null> {
    return (await this.byId<Customer>('customers', id)) ?? null;
  }
  async getCustomerByEmail(email: string): Promise<Customer | null> {
    await this.ensureReady();
    const res = await this.exec(
      "SELECT data FROM customers WHERE lower(json_extract(data,'$.email')) = lower(?)", [email.trim()]);
    return res.rows[0] ? (JSON.parse(String(res.rows[0].data)) as Customer) : null;
  }
  async createCustomer(c: Omit<Customer, 'id' | 'created_at' | 'updated_at'>): Promise<Customer> {
    const rec: Customer = { ...(c as Customer), id: newId(), created_at: nowIso(), updated_at: nowIso() };
    await this.insert('customers', rec);
    return rec;
  }
  async updateCustomer(id: string, updates: Partial<Customer>): Promise<Customer | null> {
    // Two edits to one customer (an address saved at checkout, a phone number
    // typed in the admin) must both survive. Partial and in SQL — see patchRow.
    return this.patchRow<Customer>('customers', id, { ...updates, updated_at: nowIso() });
  }
  deleteCustomer(id: string): Promise<boolean> {
    return this.del('customers', id);
  }

  deleteCategory(id: string): Promise<boolean> {
    return this.del('categories', id);
  }

  /* ---------- users ---------- */
  getUsers(): Promise<User[]> {
    return this.all<User>('users');
  }
  getUser(id: string): Promise<User | undefined> {
    return this.byId<User>('users', id);
  }
  async createUser(user: Omit<User, 'id' | 'created_at' | 'updated_at'>): Promise<User> {
    const rec: User = { ...(user as User), id: newId(), created_at: nowIso(), updated_at: nowIso() };
    await this.insert('users', rec);
    return rec;
  }
  async updateUser(id: string, updates: Partial<User>): Promise<User | null> {
    const existing = await this.byId<User>('users', id);
    if (!existing) return null;
    const updated: User = { ...existing, ...updates, updated_at: nowIso() };
    await this.put('users', id, updated);
    return updated;
  }
  deleteUser(id: string): Promise<boolean> {
    return this.del('users', id);
  }

  /* ---------- media ---------- */
  getMedia(): Promise<MediaFile[]> {
    return this.all<MediaFile>('media');
  }
  getMediaFile(id: string): Promise<MediaFile | undefined> {
    return this.byId<MediaFile>('media', id);
  }
  async createMediaFile(media: Omit<MediaFile, 'id' | 'created_at'>): Promise<MediaFile> {
    const rec: MediaFile = { ...(media as MediaFile), id: newId(), created_at: nowIso() };
    await this.insert('media', rec);
    return rec;
  }
  async updateMediaFile(id: string, updates: Partial<MediaFile>): Promise<MediaFile | null> {
    const existing = await this.byId<MediaFile>('media', id);
    if (!existing) return null;
    const updated: MediaFile = { ...existing, ...updates };
    await this.put('media', id, updated);
    return updated;
  }
  deleteMediaFile(id: string): Promise<boolean> {
    return this.del('media', id);
  }

  /* ---------- themes ---------- */
  getThemes(): Promise<Theme[]> {
    return this.all<Theme>('themes');
  }
  async ensureThemes(
    themes: Array<Pick<Theme, 'id' | 'name' | 'description' | 'version' | 'author' | 'settings'>>,
  ): Promise<Theme[]> {
    await this.ensureReady();
    const existing = await this.all<Theme>('themes');
    const have = new Set(existing.map((t) => t.id));
    for (const t of themes) {
      if (have.has(t.id)) continue;
      // New rows are inactive; activation is always an explicit operator act.
      await this.insert('themes', { ...t, status: 'inactive', created_at: nowIso() } as unknown as { id: string });
    }
    return this.all<Theme>('themes');
  }

  async upsertDeclarativeTheme(theme: Theme): Promise<Theme> {
    await this.ensureReady();
    const prev = await this.byId<Theme>('themes', theme.id);
    if (!prev) {
      const row = { ...theme, status: 'inactive' as const, created_at: nowIso() };
      await this.insert('themes', row as unknown as { id: string });
      return row;
    }
    // `settings` and `status` are the operator's; an upgrade must not reset the
    // colours they tuned or silently activate the theme.
    const merged: Theme = {
      ...theme, settings: prev.settings, status: prev.status, created_at: prev.created_at,
    };
    await this.put('themes', theme.id, merged);
    return merged;
  }

  async deleteTheme(id: string): Promise<boolean> {
    await this.ensureReady();
    const existing = await this.byId<Theme>('themes', id);
    if (!existing) return false;
    await this.exec('DELETE FROM themes WHERE id = ?', [id]);
    return true;
  }

  async getActiveTheme(): Promise<Theme | undefined> {
    await this.ensureReady();
    const res = await this.exec("SELECT data FROM themes WHERE json_extract(data, '$.status') = 'active' LIMIT 1");
    const row = res.rows[0];
    return row ? (JSON.parse(String(row.data)) as Theme) : undefined;
  }
  async activateTheme(id: string): Promise<Theme | null> {
    const target = await this.byId<Theme>('themes', id);
    if (!target) return null;
    // Deactivate all, then activate the target.
    await this.exec("UPDATE themes SET data = json_set(data, '$.status', 'inactive')");
    target.status = 'active';
    await this.put('themes', id, target);
    return target;
  }
  async updateThemeSettings(id: string, settings: ThemeConfig): Promise<Theme | null> {
    const existing = await this.byId<Theme>('themes', id);
    if (!existing) return null;
    const oldSettings = existing.settings;
    existing.settings = settings;
    await this.put('themes', id, existing);
    await this.recordChange('theme', id, 'update', { old: oldSettings, new: settings }, ['settings']);
    return existing;
  }

  /* ---------- settings ---------- */
  getSettings(): Promise<Setting[]> {
    return this.all<Setting>('settings');
  }
  async getSetting(key: string): Promise<Setting | undefined> {
    await this.ensureReady();
    const res = await this.exec("SELECT data FROM settings WHERE json_extract(data, '$.key') = ?", [key]);
    const row = res.rows[0];
    return row ? (JSON.parse(String(row.data)) as Setting) : undefined;
  }
  async updateSetting(key: string, value: any): Promise<Setting | null> {
    const existing = await this.getSetting(key);
    if (existing) {
      existing.value = value;
      existing.updated_at = nowIso();
      await this.put('settings', existing.id, existing);
      return existing;
    }
    const rec: Setting = { id: newId(), key, value, category: 'general', created_at: nowIso(), updated_at: nowIso() };
    await this.insert('settings', rec);
    return rec;
  }

  /* ---------- content changes ---------- */
  /**
   * The whole retained window, snapshots included.
   *
   * This was `SELECT data FROM content_changes` with no LIMIT, on a table that
   * was never pruned — every product and order save ever made, each with its
   * full snapshot, parsed into memory on every call. It now carries the
   * retention cap as its LIMIT, so it stays bounded even on a database whose
   * boot prune has not finished.
   */
  async getContentChanges(since?: string): Promise<ContentChange[]> {
    await this.ensureReady();
    const bound = normalizeChangeSince(since);
    const res = bound
      ? await this.exec('SELECT data FROM content_changes WHERE ts > ? ORDER BY ts DESC, id DESC LIMIT ?', [bound, CONTENT_CHANGE_CAP])
      : await this.exec('SELECT data FROM content_changes ORDER BY ts DESC, id DESC LIMIT ?', [CONTENT_CHANGE_CAP]);
    return res.rows.map((r) => JSON.parse(String(r.data)) as ContentChange);
  }

  /**
   * One page of the feed, pushed into SQL.
   *
   * It must agree row for row with `applyChangeQuery` (core/change-feed.ts),
   * which is what the document drivers run; tests/change-feed.test.mjs holds
   * both to the same expected sequence on the same seeded history.
   *
   *   - `(ts, id) < (?, ?)` is the keyset cursor, a row-value comparison the
   *     `(ts, id)` index serves as a range — no OFFSET, so page 50 costs what
   *     page 1 costs.
   *   - The type allow-list is applied HERE, not afterwards, so a page is full
   *     and `hasMore` counts only what the caller may see.
   *   - `LIMIT ?` is `limit + 1`: the extra row is how `hasMore` is known
   *     without a COUNT.
   *
   * Without snapshots the `data` column is never SELECTED. The five metadata
   * values are extracted inside SQLite, so a public page does not move a single
   * product or order snapshot across the wire (on Turso, the network) or into
   * this process's memory.
   */
  async getContentChangesPage(query: ContentChangeQuery): Promise<ContentChangePage> {
    await this.ensureReady();
    const q = normalizeChangeQuery(query);
    // An empty allow-list means "nothing", and `IN ()` is a syntax error.
    if (q.types && q.types.length === 0) return { items: [], hasMore: false, nextCursor: null, prunedThrough: null };
    const where: string[] = [];
    const args: InValue[] = [];
    if (q.since !== undefined) {
      where.push('ts > ?');
      args.push(q.since);
    }
    if (q.before) {
      where.push('(ts, id) < (?, ?)');
      args.push(q.before.ts, q.before.id);
    }
    if (q.types) {
      where.push(`json_extract(data, '$.entity_type') IN (${q.types.map(() => '?').join(', ')})`);
      args.push(...q.types);
    }
    const columns = q.snapshots
      ? 'id, ts, data'
      : "id, ts, json_extract(data, '$.entity_type') AS entity_type, "
        + "json_extract(data, '$.entity_id') AS entity_id, "
        + "json_extract(data, '$.action') AS action, "
        + "json_extract(data, '$.fields') AS fields";
    args.push(q.limit + 1);
    const res = await this.exec(
      `SELECT ${columns} FROM content_changes${where.length ? ` WHERE ${where.join(' AND ')}` : ''} `
        + 'ORDER BY ts DESC, id DESC LIMIT ?',
      args,
    );
    const rows = res.rows.map((r) => {
      const id = String(r.id);
      const ts = String(r.ts);
      if (q.snapshots) return { id, ts, item: JSON.parse(String(r.data)) as ContentChange | ContentChangeMeta };
      const meta: ContentChangeMeta = {
        id,
        entity_type: String(r.entity_type ?? ''),
        entity_id: String(r.entity_id ?? ''),
        action: String(r.action ?? '') as ContentChange['action'],
        timestamp: ts,
      };
      const fields = parseStoredFields(r.fields);
      if (fields) meta.fields = fields;
      return { id, ts, item: meta as ContentChange | ContentChangeMeta };
    });
    const page = pageFromRows(rows, q.limit, (r) => r.ts);
    // What retention has evicted among the SAME types (recordPrunedChanges).
    // Read AFTER the page, deliberately: a prune landing between the two
    // statements then shows up here although the page was read before it — a
    // spurious "truncated" at worst, which costs a storefront one full
    // revalidation. Read before, the same prune would be a silent gap.
    const marks = q.types
      ? await this.exec(
        `SELECT max(ts) AS ts FROM content_changes_pruned WHERE entity_type IN (${q.types.map(() => '?').join(', ')})`,
        q.types,
      )
      : await this.exec('SELECT max(ts) AS ts FROM content_changes_pruned');
    const newest = marks.rows[0]?.ts;
    return {
      items: page.items.map((r) => r.item),
      hasMore: page.hasMore,
      nextCursor: page.nextCursor,
      prunedThrough: newest === null || newest === undefined ? null : String(newest),
    };
  }
  async recordContentChange(
    entityType: 'post' | 'theme' | 'setting' | 'category' | 'user',
    entityId: string,
    action: 'create' | 'update' | 'delete',
    changes: any,
  ): Promise<ContentChange | null> {
    await this.ensureReady();
    return this.recordChange(entityType, entityId, action, changes);
  }
  async clearContentChanges(): Promise<void> {
    await this.ensureReady();
    // Recorded like any other eviction: a poller whose window reached into
    // what was cleared has lost those entries, and `meta.truncated` must say
    // so. LIMIT -1 OFFSET 0 is every row.
    await this.client.batch(pruneStatements(-1, 0), 'write');
  }
  async deleteContentChangesFor(email: string): Promise<number> {
    await this.ensureReady();
    // instr on the lower-cased JSON blob: the same substring rule the doc path
    // uses, pushed into SQL so it does not pull every row into memory.
    //
    // NOT recorded in content_changes_pruned: an erasure is not retention, and
    // a mark that moved when one customer's entries were erased would publish
    // when the erasure happened (recordPrunedChanges, core/change-feed.ts).
    const needle = email.trim().toLowerCase();
    const res = await this.exec(
      "DELETE FROM content_changes WHERE instr(lower(data), ?) > 0",
      [needle],
    );
    return Number(res.rowsAffected ?? 0);
  }
  /**
   * The export's half of the above: how many retained entries mention the
   * address, by the same `instr` rule — counted where the rows are, so an
   * access request does not pull every retained snapshot into memory to count.
   */
  async countContentChangesFor(email: string): Promise<number> {
    await this.ensureReady();
    const needle = email.trim().toLowerCase();
    // `instr(x, '')` is 1 for every row: an empty needle would count the lot.
    if (!needle) return 0;
    const res = await this.exec(
      'SELECT count(*) AS n FROM content_changes WHERE instr(lower(data), ?) > 0',
      [needle],
    );
    return Number(res.rows[0]?.n ?? 0);
  }
  async deleteWebhookDeliveriesFor(email: string): Promise<number> {
    await this.ensureReady();
    const needle = email.trim().toLowerCase();
    const res = await this.exec(
      "DELETE FROM webhook_deliveries WHERE instr(lower(data), ?) > 0",
      [needle],
    );
    return Number(res.rowsAffected ?? 0);
  }

  /* ---------- messages ---------- */
  async getMessages(): Promise<ContactMessage[]> {
    const all = await this.all<ContactMessage>('messages');
    return all.sort((a, b) => b.created_at.localeCompare(a.created_at));
  }
  async createMessage(msg: Omit<ContactMessage, 'id' | 'created_at' | 'read'>): Promise<ContactMessage | null> {
    const rec: ContactMessage = { ...(msg as ContactMessage), id: newId(), read: false, created_at: nowIso() };
    await this.insert('messages', rec);
    // Cap stored messages (mirror lowdb) to bound growth on a spammed form.
    await this.exec('DELETE FROM messages WHERE id NOT IN (SELECT id FROM messages ORDER BY rowid DESC LIMIT 5000)');
    return rec;
  }
  async markMessageRead(id: string, read: boolean): Promise<ContactMessage | null> {
    const existing = await this.byId<ContactMessage>('messages', id);
    if (!existing) return null;
    existing.read = read;
    await this.put('messages', id, existing);
    return existing;
  }
  deleteMessage(id: string): Promise<boolean> {
    return this.del('messages', id);
  }

  /* ---------- subscribers ---------- */
  async getSubscribers(): Promise<Subscriber[]> {
    const all = await this.all<Subscriber>('subscribers');
    return all.sort((a, b) => b.created_at.localeCompare(a.created_at));
  }
  async createSubscriber(email: string): Promise<Subscriber | null> {
    await this.ensureReady();
    const res = await this.exec("SELECT data FROM subscribers WHERE lower(json_extract(data, '$.email')) = lower(?)", [email]);
    if (res.rows[0]) return JSON.parse(String(res.rows[0].data)) as Subscriber;
    const rec: Subscriber = { id: newId(), email, created_at: nowIso() };
    await this.insert('subscribers', rec);
    return rec;
  }
  deleteSubscriber(id: string): Promise<boolean> {
    return this.del('subscribers', id);
  }

  /* ---------- outbound email log ---------- */
  async logEmail(rec: Omit<EmailLogEntry, 'id' | 'created_at'>): Promise<EmailLogEntry> {
    await this.ensureReady();
    const entry: EmailLogEntry = { ...rec, id: newId(), created_at: nowIso() };
    await this.exec(
      'INSERT INTO email_log (id, recipient, ts, data) VALUES (?, ?, ?, ?)',
      [entry.id, String(entry.to).trim().toLowerCase(), entry.created_at, JSON.stringify(entry)],
    );
    // Bounded here rather than by a sweep elsewhere: this table holds
    // recipient addresses and grows on its own.
    await this.exec(
      'DELETE FROM email_log WHERE id NOT IN (SELECT id FROM email_log ORDER BY ts DESC LIMIT 2000)',
    );
    return entry;
  }
  async getEmailLog(limit = 100): Promise<EmailLogEntry[]> {
    await this.ensureReady();
    const res = await this.exec(
      'SELECT data FROM email_log ORDER BY ts DESC LIMIT ?',
      [Math.max(1, Math.min(limit, 2000))],
    );
    return res.rows.map((r) => JSON.parse(String(r.data)) as EmailLogEntry);
  }
  async deleteEmailLogFor(email: string): Promise<number> {
    await this.ensureReady();
    const res = await this.exec(
      'DELETE FROM email_log WHERE recipient = ?',
      [email.trim().toLowerCase()],
    );
    return Number(res.rowsAffected ?? 0);
  }

  /* ---------- consent receipts ---------- */
  /** Idempotent on the id: the banner may retry a POST that timed out. */
  async createConsentReceipt(rec: ConsentReceipt): Promise<ConsentReceipt> {
    await this.ensureReady();
    await this.exec(
      'INSERT OR IGNORE INTO consent_receipts (id, ts, data) VALUES (?, ?, ?)',
      [rec.id, rec.created_at, JSON.stringify(rec)],
    );
    // The cap lived only in the lowdb driver, so on libSQL and relational the
    // "capped" promise was false and the table grew without bound. Trim to the
    // most recent CONSENT_RECEIPT_CAP after each insert, same shape as the
    // email-log trim.
    await this.exec(
      'DELETE FROM consent_receipts WHERE id NOT IN (SELECT id FROM consent_receipts ORDER BY ts DESC LIMIT ?)',
      [20000],
    );
    return rec;
  }
  async getConsentReceipts(limit = 100): Promise<ConsentReceipt[]> {
    await this.ensureReady();
    const res = await this.exec(
      'SELECT data FROM consent_receipts ORDER BY ts DESC LIMIT ?',
      [Math.max(1, Math.min(limit, 20000))],
    );
    return res.rows.map((r) => JSON.parse(String(r.data)) as ConsentReceipt);
  }
  async getConsentReceipt(id: string): Promise<ConsentReceipt | null> {
    await this.ensureReady();
    const res = await this.exec('SELECT data FROM consent_receipts WHERE id = ?', [id]);
    return res.rows[0] ? (JSON.parse(String(res.rows[0].data)) as ConsentReceipt) : null;
  }

  /* ---------- plugins ---------- */
  getPlugins(): Promise<PluginRecord[]> {
    return this.all<PluginRecord>('plugins');
  }
  async ensurePlugins(ids: string[]): Promise<PluginRecord[]> {
    await this.ensureReady();
    const existing = await this.getPlugins();
    const have = new Set(existing.map((p) => p.id));
    const now = nowIso();
    for (const id of ids) {
      if (!have.has(id)) {
        await this.insert('plugins', { id, active: false, settings: {}, installed_at: now, updated_at: now } as PluginRecord);
      }
    }
    return this.getPlugins();
  }
  async setPluginActive(id: string, active: boolean): Promise<PluginRecord | null> {
    await this.ensureReady();
    const now = nowIso();
    let rec = await this.byId<PluginRecord>('plugins', id);
    if (!rec) {
      rec = { id, active, settings: {}, installed_at: now, updated_at: now };
      await this.insert('plugins', rec);
    } else {
      rec.active = active;
      rec.updated_at = now;
      await this.put('plugins', id, rec);
    }
    await this.recordChange('plugin', id, 'update', { active }, ['active']);
    return rec;
  }
  async updatePluginSettings(id: string, settings: Record<string, any>): Promise<PluginRecord | null> {
    const rec = await this.byId<PluginRecord>('plugins', id);
    if (!rec) return null;
    rec.settings = settings;
    rec.updated_at = nowIso();
    await this.put('plugins', id, rec);
    return rec;
  }
  async deletePlugin(id: string): Promise<boolean> {
    return this.del('plugins', id);
  }

  /* ---------- custom content types ---------- */
  /* ---------- Legacy-URL recovery ---------- */

  async getRedirects(): Promise<RedirectRule[]> {
    await this.ensureReady();
    const res = await this.exec('SELECT data FROM redirects ORDER BY rowid');
    return res.rows.map((r) => JSON.parse(String(r.data)) as RedirectRule);
  }

  async saveRedirect(rule: RedirectRule): Promise<RedirectRule> {
    await this.ensureReady();
    await this.exec(
      'INSERT INTO redirects (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data',
      [rule.id, JSON.stringify(rule)],
    );
    return rule;
  }

  async deleteRedirect(id: string): Promise<boolean> {
    await this.ensureReady();
    const res = await this.exec('DELETE FROM redirects WHERE id = ?', [id]);
    return (res.rowsAffected ?? 0) > 0;
  }

  async getNotFound(): Promise<NotFoundRecord[]> {
    await this.ensureReady();
    const res = await this.exec('SELECT data FROM not_found ORDER BY rowid');
    return res.rows.map((r) => JSON.parse(String(r.data)) as NotFoundRecord);
  }

  async putNotFound(records: readonly NotFoundRecord[]): Promise<void> {
    await this.ensureReady();
    // Upsert every row, then drop what is no longer in the set. The set is
    // capped and small, and this keeps eviction meaning the same thing on every
    // driver — a row that fell out of the document model must also fall out
    // here, or the two would slowly disagree about what the report shows.
    const keep = new Set<string>();
    for (const r of records) {
      keep.add(r.path);
      await this.exec(
        'INSERT INTO not_found (path, data) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET data = excluded.data',
        [r.path, JSON.stringify(r)],
      );
    }
    const existing = await this.exec('SELECT path FROM not_found');
    for (const row of existing.rows) {
      const path = String(row.path);
      if (!keep.has(path)) await this.exec('DELETE FROM not_found WHERE path = ?', [path]);
    }
  }

  /* ---------- Plugin-owned data ---------- */

  async getPluginData(ns: string): Promise<PluginDataRecord[]> {
    await this.ensureReady();
    const res = await this.exec('SELECT data FROM plugin_data WHERE ns = ? ORDER BY rowid', [ns]);
    return res.rows.map((r) => JSON.parse(String(r.data)) as PluginDataRecord);
  }

  async getPluginDataRecord(ns: string, id: string): Promise<PluginDataRecord | undefined> {
    await this.ensureReady();
    const res = await this.exec('SELECT data FROM plugin_data WHERE ns = ? AND id = ?', [ns, id]);
    const row = res.rows[0];
    return row ? (JSON.parse(String(row.data)) as PluginDataRecord) : undefined;
  }

  async putPluginData(ns: string, id: string, data: Record<string, unknown>): Promise<PluginDataRecord> {
    await this.ensureReady();
    const now = nowIso();
    const existing = await this.getPluginDataRecord(ns, id);
    const rec: PluginDataRecord = {
      ns,
      id,
      data,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    // ON CONFLICT rather than SELECT-then-INSERT-or-UPDATE: two concurrent
    // writers to the same key must not race into a duplicate-key error.
    await this.exec(
      'INSERT INTO plugin_data (ns, id, data) VALUES (?, ?, ?) '
      + 'ON CONFLICT(ns, id) DO UPDATE SET data = excluded.data',
      [ns, id, JSON.stringify(rec)],
    );
    return rec;
  }

  async deletePluginDataRecord(ns: string, id: string): Promise<boolean> {
    await this.ensureReady();
    const res = await this.exec('DELETE FROM plugin_data WHERE ns = ? AND id = ?', [ns, id]);
    return (res.rowsAffected ?? 0) > 0;
  }

  async deletePluginData(ns: string): Promise<number> {
    await this.ensureReady();
    if (ns.includes(':')) {
      const res = await this.exec('DELETE FROM plugin_data WHERE ns = ?', [ns]);
      return res.rowsAffected ?? 0;
    }
    // A bare plugin id drops every collection it owns.
    //
    // NOT `LIKE`: SQLite's LIKE is case-INSENSITIVE for ASCII, so uninstalling
    // a plugin called "Shop" would have deleted the data of a different plugin
    // called "shop" — while the document drivers, which compare with
    // startsWith, left it alone. A difference between drivers that destroys
    // data is the worst kind.
    //
    // `substr(ns, 1, n) = ?` is an exact, case-sensitive comparison and needs
    // no escaping, so a plugin id containing %, _ or a backslash is literal.
    const prefix = `${ns}:`;
    const res = await this.exec(
      'DELETE FROM plugin_data WHERE substr(ns, 1, ?) = ?',
      [prefix.length, prefix],
    );
    return res.rowsAffected ?? 0;
  }

  async getCustomEntities(type: string): Promise<CustomEntity[]> {
    await this.ensureReady();
    const res = await this.exec('SELECT data FROM custom_entities WHERE type = ? ORDER BY rowid', [type]);
    return res.rows.map((r) => JSON.parse(String(r.data)) as CustomEntity);
  }
  async getCustomEntity(type: string, id: string): Promise<CustomEntity | undefined> {
    await this.ensureReady();
    const res = await this.exec('SELECT data FROM custom_entities WHERE type = ? AND id = ?', [type, id]);
    const row = res.rows[0];
    return row ? (JSON.parse(String(row.data)) as CustomEntity) : undefined;
  }
  async createCustomEntity(type: string, data: Record<string, any>): Promise<CustomEntity | null> {
    await this.ensureReady();
    const now = nowIso();
    const entity: CustomEntity = { id: newId(), type, data, created_at: now, updated_at: now };
    await this.exec('INSERT INTO custom_entities (id, type, data) VALUES (?, ?, ?)', [entity.id, type, JSON.stringify(entity)]);
    await this.recordChange(type, entity.id, 'create', entity);
    return entity;
  }
  async updateCustomEntity(type: string, id: string, data: Record<string, any>): Promise<CustomEntity | null> {
    const existing = await this.getCustomEntity(type, id);
    if (!existing) return null;
    const updated: CustomEntity = { ...existing, data: { ...existing.data, ...data }, updated_at: nowIso() };
    await this.exec('UPDATE custom_entities SET data = ? WHERE id = ?', [JSON.stringify(updated), id]);
    // The patch is to `.data`, so its keys are the entry's changed fields.
    await this.recordChange(type, id, 'update', updated, changedFieldNames(data));
    return updated;
  }
  /**
   * Update a custom entity ONLY if the named fields still hold the values the
   * caller read — a compare-and-set, in one statement.
   *
   * Exists for the newsletter campaign cursor (scheduler.ts): two processes
   * that read cursor 50 must not both send subscribers 50–74. The WHERE clause
   * is the atomic part — once one UPDATE has moved the cursor, the other's
   * no longer matches and changes nothing. `json_set` writes only the patched
   * fields, so a concurrent edit to another field is not overwritten with the
   * value this caller happened to read.
   *
   * `expected` compares with SQL semantics: a missing field reads as null, and
   * the number 0 is not the string "0". Returns the updated entity, or null
   * when the entity is gone or a field has moved.
   */
  async updateCustomEntityIf(
    type: string,
    id: string,
    expected: Readonly<Record<string, string | number | null>>,
    patch: Readonly<Record<string, unknown>>,
  ): Promise<CustomEntity | null> {
    await this.ensureReady();
    const key = (k: string) => {
      // Field names become JSON paths inside the SQL text; only plain
      // identifiers get that far.
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k)) throw new Error(`Invalid field name: ${k}`);
      return `'$.data.${k}'`;
    };
    const sets: string[] = [];
    const setArgs: InValue[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      if (v === null || typeof v === 'object' || typeof v === 'boolean') {
        // json() so null, booleans, objects and arrays are stored as JSON, not
        // as the text of their JSON.
        sets.push(`${key(k)}, json(?)`);
        setArgs.push(JSON.stringify(v));
      } else {
        sets.push(`${key(k)}, ?`);
        setArgs.push(v as InValue);
      }
    }
    const now = nowIso();
    sets.push(`'$.updated_at', ?`);
    setArgs.push(now);
    const where: string[] = ['id = ?', 'type = ?'];
    const whereArgs: InValue[] = [id, type];
    for (const [k, v] of Object.entries(expected)) {
      where.push(`json_extract(data, ${key(k)}) IS ?`);
      whereArgs.push(v);
    }
    const res = await this.exec(
      `UPDATE custom_entities SET data = json_set(data, ${sets.join(', ')})
        WHERE ${where.join(' AND ')}
        RETURNING data`,
      [...setArgs, ...whereArgs],
    );
    const row = res.rows[0];
    if (!row) return null;
    const updated = JSON.parse(String(row.data)) as CustomEntity;
    await this.recordChange(type, id, 'update', updated);
    return updated;
  }
  async deleteCustomEntity(type: string, id: string): Promise<boolean> {
    await this.ensureReady();
    const res = await this.exec('DELETE FROM custom_entities WHERE type = ? AND id = ?', [type, id]);
    if ((res.rowsAffected ?? 0) > 0) {
      await this.recordChange(type, id, 'delete', { id, type });
      return true;
    }
    return false;
  }

  /* ---------- API keys ---------- */
  getApiKeys(): Promise<ApiKey[]> {
    return this.all<ApiKey>('api_keys');
  }
  async findApiKeyByHash(hash: string): Promise<ApiKey | undefined> {
    await this.ensureReady();
    const res = await this.exec("SELECT data FROM api_keys WHERE json_extract(data, '$.key_hash') = ?", [hash]);
    const row = res.rows[0];
    return row ? (JSON.parse(String(row.data)) as ApiKey) : undefined;
  }
  async createApiKey(rec: Omit<ApiKey, 'id' | 'created_at'>): Promise<ApiKey | null> {
    const key: ApiKey = { ...(rec as ApiKey), id: newId(), created_at: nowIso() };
    await this.insert('api_keys', key);
    return key;
  }
  async touchApiKey(id: string): Promise<void> {
    const k = await this.byId<ApiKey>('api_keys', id);
    if (k) {
      k.last_used = nowIso();
      await this.put('api_keys', id, k);
    }
  }
  async updateApiKey(id: string, patch: Partial<Omit<ApiKey, 'id' | 'created_at'>>): Promise<ApiKey | null> {
    const k = await this.byId<ApiKey>('api_keys', id);
    if (!k) return null;
    Object.assign(k, patch);
    await this.put('api_keys', id, k);
    return k;
  }
  deleteApiKey(id: string): Promise<boolean> {
    return this.del('api_keys', id);
  }

  /* ---------- webhooks ---------- */
  getWebhooks(): Promise<Webhook[]> {
    return this.all<Webhook>('webhooks');
  }
  async createWebhook(rec: Omit<Webhook, 'id' | 'created_at'>): Promise<Webhook | null> {
    const wh: Webhook = { ...(rec as Webhook), id: newId(), created_at: nowIso() };
    await this.insert('webhooks', wh);
    return wh;
  }
  deleteWebhook(id: string): Promise<boolean> {
    return this.del('webhooks', id);
  }

  /* ---------- webhook delivery log ---------- */
  async createWebhookDelivery(rec: Omit<WebhookDelivery, 'id' | 'created_at' | 'updated_at'>): Promise<WebhookDelivery | null> {
    await this.ensureReady();
    const now = nowIso();
    const d: WebhookDelivery = { ...(rec as WebhookDelivery), id: newId(), created_at: now, updated_at: now };
    await this.exec('INSERT INTO webhook_deliveries (id, webhook_id, ts, data) VALUES (?, ?, ?, ?)', [d.id, d.webhook_id, now, JSON.stringify(d)]);
    return d;
  }
  async updateWebhookDelivery(id: string, patch: Partial<Omit<WebhookDelivery, 'id' | 'created_at'>>): Promise<WebhookDelivery | null> {
    await this.ensureReady();
    const res = await this.exec('SELECT data FROM webhook_deliveries WHERE id = ?', [id]);
    const row = res.rows[0];
    if (!row) return null;
    const d: WebhookDelivery = { ...(JSON.parse(String(row.data)) as WebhookDelivery), ...patch, updated_at: nowIso() };
    await this.exec('UPDATE webhook_deliveries SET data = ? WHERE id = ?', [JSON.stringify(d), id]);
    return d;
  }
  async getWebhookDelivery(id: string): Promise<WebhookDelivery | undefined> {
    await this.ensureReady();
    const res = await this.exec('SELECT data FROM webhook_deliveries WHERE id = ?', [id]);
    const row = res.rows[0];
    return row ? (JSON.parse(String(row.data)) as WebhookDelivery) : undefined;
  }
  async getWebhookDeliveries(opts?: { webhookId?: string; limit?: number }): Promise<WebhookDelivery[]> {
    await this.ensureReady();
    const limit = opts?.limit ?? 1000;
    const res = opts?.webhookId
      ? await this.exec('SELECT data FROM webhook_deliveries WHERE webhook_id = ? ORDER BY ts DESC LIMIT ?', [opts.webhookId, limit])
      : await this.exec('SELECT data FROM webhook_deliveries ORDER BY ts DESC LIMIT ?', [limit]);
    return res.rows.map((r) => JSON.parse(String(r.data)) as WebhookDelivery);
  }

  /* ---------- audit log ---------- */
  async createAuditEvent(rec: Omit<AuditEvent, 'id' | 'created_at'>): Promise<AuditEvent | null> {
    await this.ensureReady();
    const ev: AuditEvent = { ...(rec as AuditEvent), id: newId(), created_at: nowIso() };
    await this.exec('INSERT INTO audit_events (id, action, ts, data) VALUES (?, ?, ?, ?)', [ev.id, ev.action, ev.created_at, JSON.stringify(ev)]);
    return ev;
  }
  /**
   * The audit filter, in SQL, agreeing with `core/audit-query.ts` row for row.
   *
   * The predicates are written out rather than reused because SQL cannot call a
   * TypeScript function — which is exactly why a differential test compares the
   * two on the same fixtures. Three details make them agree:
   *
   *  - action is a PREFIX (`LIKE 'auth.%'`), not equality, matching
   *    `startsWith` in the spec;
   *  - actor is a case-insensitive SUBSTRING, and `LOWER()` is applied to BOTH
   *    sides because SQLite's `LOWER()` is ASCII-only and would otherwise leave
   *    a Greek actor name unfolded on one side of the comparison;
   *  - `ts` is the ISO string, so range comparison is lexicographic here and in
   *    the spec.
   *
   * `%` and `_` in user input are escaped, or an actor containing `%` would
   * match everything.
   */
  async getAuditEvents(opts?: AuditQuery): Promise<AuditEvent[]> {
    await this.ensureReady();
    const limit = opts?.limit && opts.limit > 0 ? opts.limit : 1000;
    const where: string[] = [];
    const args: InValue[] = [];

    const like = (v: string) => v.replace(/[\\%_]/g, (c) => `\\${c}`);

    const action = opts?.action?.trim();
    if (action) {
      where.push("action LIKE ? ESCAPE '\\'");
      args.push(`${like(action)}%`);
    }
    const actor = opts?.actor?.trim();
    if (actor) {
      // `json_extract`, not a column: audit_events is (id, action, ts, data) and
      // the actor lives inside the blob. `LOWER(actor)` referenced a column that
      // does not exist and quietly matched nothing — the relational driver
      // returned zero rows while the document drivers returned the right ones.
      // Caught by the cross-driver smoke assertions, which is the entire reason
      // they run the same checks against all three.
      //
      // SQLite's LOWER() is ASCII-only, which is fine here because an actor is
      // a user id or `apikey:<id>`. If it ever holds a display name, this stops
      // folding Greek and the JS side would disagree — see the folding notes in search/rank.ts.
      where.push("LOWER(json_extract(data, '$.actor')) LIKE ? ESCAPE '\\'");
      args.push(`%${like(actor.toLowerCase())}%`);
    }
    const from = normalizeBound(opts?.from, 'start');
    if (from) { where.push('ts >= ?'); args.push(from); }
    const to = normalizeBound(opts?.to, 'end');
    if (to) { where.push('ts <= ?'); args.push(to); }

    const sql = `SELECT data FROM audit_events${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`
      + ' ORDER BY ts DESC, id DESC LIMIT ?';
    args.push(limit);
    const res = await this.exec(sql, args);
    return res.rows.map((r) => JSON.parse(String(r.data)) as AuditEvent);
  }



  /**
   * Atomically reserve stock with a CONDITIONAL update: the availability check
   * lives in the WHERE clause, so SQLite evaluates it and applies the decrement
   * in one statement. Two concurrent checkouts cannot both pass — the second
   * matches 0 rows. (A read-then-write pair here would oversell.)
   *
   * `stock === null` means "not tracked": the row matches, nothing changes.
   */
  async reserveStock(
    productId: string, qty: number,
    opts?: { allowBackorder?: boolean; variantId?: string | null },
  ): Promise<boolean> {
    await this.ensureReady();
    if (!Number.isInteger(qty) || qty <= 0) return false;

    if (opts?.variantId) return this.reserveVariantStock(productId, opts.variantId, qty, opts.allowBackorder === true);

    // Untracked stock: succeed without touching the row.
    const cur = await this.byId<Product>('products', productId);
    if (!cur) return false;
    if (cur.stock == null) return true;

    // The `stock >= qty` guard is what makes this atomic. A backorder drops
    // THAT guard only — the update is still one conditional statement, so two
    // concurrent backorders both apply and the count ends up correctly
    // negative rather than one of them being lost.
    const stockGuard = opts?.allowBackorder ? '' : `AND json_extract(data, '$.stock') >= ?`;
    const params: (string | number)[] = opts?.allowBackorder
      ? [qty, qty, productId]
      : [qty, qty, productId, qty];

    const res = await this.exec(
      `UPDATE products
          SET data = json_set(
                json_set(data, '$.stock', json_extract(data, '$.stock') - ?),
                '$.in_stock',
                json(CASE WHEN json_extract(data, '$.stock') - ? > 0 THEN 'true' ELSE 'false' END))
        WHERE id = ?
          AND json_extract(data, '$.stock') IS NOT NULL
          ${stockGuard}`,
      params,
    );
    return Number(res.rowsAffected ?? 0) > 0;
  }

  /**
   * Reserve a VARIANT's stock atomically.
   *
   * A variant lives inside the product's JSON, so the row cannot be guarded
   * with a plain `WHERE stock >= ?`: the variant's position in the array has
   * to be found first. That position is where this used to go wrong.
   *
   * ## An index is a pointer, and pointers go stale (ABA)
   *
   * The old version read the variant's array index, then wrote
   * `$.variants[i].stock` guarded ONLY by "the count at index i is still the
   * count I read". Between the read and the write an admin can reorder the
   * variants or delete one, and index i then holds a DIFFERENT variant. If its
   * count happens to equal the one read — two colours with 2 left each is the
   * ordinary case — the guard passes and the wrong colour is sold. Deleting the
   * variant sold a colour that no longer existed out of its neighbour's stock.
   * `tests/stock-race.test.mjs` (A1–A3) makes both happen between the two
   * statements.
   *
   * ## Now
   *
   * The UPDATE is also guarded on the variant's ID at that index, so a stale
   * index matches nothing and the loop re-reads to find where the variant went,
   * or that it is gone. And the count is decremented IN SQL from the value in
   * the row at write time, behind a `>= qty` guard — the one-statement shape
   * `reserveStock` uses for a simple product. So two checkouts of the same
   * colour are no longer a conflict to retry. The old compare-exact guard made
   * every such collision a lost attempt, and after ten a checkout was refused
   * as out of stock with units on the shelf (the storm in the same test granted
   * fewer than 30 of 30 with 40 in stock). The loop now only turns when the
   * array itself changed shape.
   */
  private async reserveVariantStock(
    productId: string, variantId: string, qty: number, allowBackorder: boolean,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const product = await this.byId<Product>('products', productId);
      if (!product) return false;
      const index = (product.variants ?? []).findIndex((v) => v.id === variantId);
      if (index < 0) return false;
      const variant = product.variants![index];
      if (variant.stock == null) return true; // untracked variant
      if (variant.stock < qty && !allowBackorder) return false;

      // `index` is an integer we computed, never input, so it is safe inside
      // the path literal. Both json_set values are evaluated against the row
      // BEFORE the update, so in_stock is derived from the same count that is
      // decremented.
      const at = `$.variants[${index}]`;
      const stockGuard = allowBackorder ? '' : `AND json_extract(data, '${at}.stock') >= ?`;
      const res = await this.exec(
        `UPDATE products
            SET data = json_set(data,
                  '${at}.stock', json_extract(data, '${at}.stock') - CAST(? AS INTEGER),
                  '${at}.in_stock',
                  json(CASE WHEN json_extract(data, '${at}.stock') - ? > 0 THEN 'true' ELSE 'false' END))
          WHERE id = ?
            AND json_extract(data, '${at}.id') = ?
            AND json_extract(data, '${at}.stock') IS NOT NULL
            ${stockGuard}`,
        allowBackorder ? [qty, qty, productId, variantId] : [qty, qty, productId, variantId, qty],
      );
      if (Number(res.rowsAffected ?? 0) > 0) return true;
      // Nothing matched: since the read, the variant moved, ran short, or
      // stopped being tracked. The next read says which.
    }
    return false;
  }

  /**
   * The same hazard on the way back, with the same guard: a cancellation must
   * credit the variant it came from even if the list was reordered in between.
   *
   * `in_stock` is derived from the new count rather than set to true. The
   * lowdb driver has always done `stock > 0`, and this one said "in stock" for
   * a backordered variant released from -2 to -1 — a storefront badge that
   * disagreed between drivers.
   */
  private async releaseVariantStock(productId: string, variantId: string, qty: number): Promise<void> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const product = await this.byId<Product>('products', productId);
      if (!product) return;
      const index = (product.variants ?? []).findIndex((v) => v.id === variantId);
      if (index < 0) return;
      if (product.variants![index].stock == null) return;

      const at = `$.variants[${index}]`;
      const res = await this.exec(
        `UPDATE products
            SET data = json_set(data,
                  '${at}.stock', json_extract(data, '${at}.stock') + CAST(? AS INTEGER),
                  '${at}.in_stock',
                  json(CASE WHEN json_extract(data, '${at}.stock') + ? > 0 THEN 'true' ELSE 'false' END))
          WHERE id = ?
            AND json_extract(data, '${at}.id') = ?
            AND json_extract(data, '${at}.stock') IS NOT NULL`,
        [qty, qty, productId, variantId],
      );
      if (Number(res.rowsAffected ?? 0) > 0) return;
    }
  }

  /** Return reserved stock (rollback / cancellation / refund). */
  async releaseStock(productId: string, qty: number, opts?: { variantId?: string | null }): Promise<void> {
    await this.ensureReady();
    if (!Number.isInteger(qty) || qty <= 0) return;
    if (opts?.variantId) return this.releaseVariantStock(productId, opts.variantId, qty);
    // `in_stock` from the new count, as lowdb derives it — not a flat true,
    // which advertised a backordered product still below zero as in stock.
    await this.exec(
      `UPDATE products
          SET data = json_set(
                json_set(data, '$.stock', json_extract(data, '$.stock') + ?),
                '$.in_stock',
                json(CASE WHEN json_extract(data, '$.stock') + ? > 0 THEN 'true' ELSE 'false' END))
        WHERE id = ?
          AND json_extract(data, '$.stock') IS NOT NULL`,
      [qty, qty, productId],
    );
  }

  /* ---------- post revisions ---------- */
  async createPostRevision(rec: Omit<PostRevision, 'id' | 'created_at'>): Promise<PostRevision | null> {
    await this.ensureReady();
    const rev: PostRevision = { ...(rec as PostRevision), id: newId(), created_at: nowIso() };
    await this.exec('INSERT INTO post_revisions (id, post_id, ts, data) VALUES (?, ?, ?, ?)', [
      rev.id, rev.post_id, rev.created_at, JSON.stringify(rev),
    ]);
    return rev;
  }

  async getPostRevisions(postId: string, limit = 50): Promise<PostRevision[]> {
    await this.ensureReady();
    const res = await this.exec(
      'SELECT data FROM post_revisions WHERE post_id = ? ORDER BY ts DESC LIMIT ?',
      [postId, Math.max(0, limit)],
    );
    return res.rows.map((r) => JSON.parse(String(r.data)) as PostRevision);
  }

  async getPostRevision(id: string): Promise<PostRevision | undefined> {
    await this.ensureReady();
    const res = await this.exec('SELECT data FROM post_revisions WHERE id = ?', [id]);
    const row = res.rows[0];
    return row ? (JSON.parse(String(row.data)) as PostRevision) : undefined;
  }

  async prunePostRevisions(postId: string, keep: number): Promise<number> {
    await this.ensureReady();
    // Delete everything for this post EXCEPT the newest `keep` rows.
    const res = await this.exec(
      `DELETE FROM post_revisions
       WHERE post_id = ?
         AND id NOT IN (SELECT id FROM post_revisions WHERE post_id = ? ORDER BY ts DESC LIMIT ?)`,
      [postId, postId, Math.max(0, keep)],
    );
    return Number(res.rowsAffected ?? 0);
  }

  async deletePostRevisions(postId: string): Promise<number> {
    await this.ensureReady();
    const res = await this.exec('DELETE FROM post_revisions WHERE post_id = ?', [postId]);
    return Number(res.rowsAffected ?? 0);
  }

  /* ---------- schema version (migration runner) ---------- */
  async getSchemaVersion(): Promise<number> {
    await this.ensureReady();
    const res = await this.exec("SELECT v FROM schema_meta WHERE k = 'schema_version'");
    const raw = res.rows[0]?.v;
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  }
  async setSchemaVersion(version: number): Promise<void> {
    await this.ensureReady();
    await this.exec("INSERT OR REPLACE INTO schema_meta (k, v) VALUES ('schema_version', ?)", [String(version)]);
  }
}
