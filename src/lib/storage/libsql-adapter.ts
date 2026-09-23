/**
 * A lowdb-compatible adapter backed by libSQL / SQLite.
 *
 * lowdb's `Low` just needs an adapter with `read(): Promise<T|null>` and
 * `write(data: T): Promise<void>`. This stores the whole document as a single
 * JSON row in a libSQL database — which can be:
 *   - a local SQLite file   (DATABASE_URL="file:./data/astrobaas.db")
 *   - a remote Turso/libSQL  (DATABASE_URL="libsql://...", DATABASE_AUTH_TOKEN=...)
 *
 * Because it satisfies lowdb's Adapter contract, every LocalDB method works
 * unchanged — we only swap where the bytes live. This makes the app deployable
 * to hosts with a real (durable, network-attached) database instead of a local
 * JSON file, which is the requirement for serverless/multi-host deploys.
 *
 * Note: this is document-blob persistence (durable + deploy-portable), not
 * per-row relational storage. Concurrency is last-write-wins across instances,
 * same as the JSON file but now on durable infra. A relational per-entity
 * driver is the documented follow-up; the Storage interface already allows it.
 */
import type { Client } from '@libsql/client';
import { openSqlite, applyLocalSqlitePragmas, registerLocalSqlite, type LocalSqliteHolder } from './local-sqlite';

export interface LibsqlAdapterOptions {
  url: string;
  authToken?: string;
  /** Row key for the single document blob. */
  docKey?: string;
}

export class LibsqlAdapter<T> implements LocalSqliteHolder {
  private client: Client;
  private url: string;
  private authToken?: string;
  private docKey: string;
  private ready: Promise<void> | null = null;

  constructor(opts: LibsqlAdapterOptions) {
    // The shared opener: on a local file, a busy timeout on every connection
    // and a one-connection pool (see local-sqlite.ts).
    //
    // What the timeout does NOT do on this driver is make a second WRITER
    // process safe. Every write replaces the whole document with the writing
    // process's copy, so two processes writing at once each overwrite the
    // other's changes — the last-write-wins the header describes. Before the
    // timeout that collision at least failed loudly, with SQLITE_BUSY; now it
    // succeeds and rows go missing without a word (a two-process test lost
    // more than half of 300 creates, with no error). So a writing CLI runs
    // with the site STOPPED — `import:woo --apply` refuses a doc-blob database
    // without `--site-stopped` — or the shop belongs on
    // DATABASE_DRIVER=relational. What the timeout does help here is everything
    // that is safe beside a running site: readers, a backup's snapshot, and
    // the rate-limit store sharing this file.
    this.client = openSqlite(opts.url, opts.authToken);
    this.url = opts.url;
    this.authToken = opts.authToken;
    this.docKey = opts.docKey ?? 'astrobaas';
    // A restore replaces the file under this client — see swapLocalSqliteFile.
    registerLocalSqlite(opts.url, this);
  }

  /** For swapLocalSqliteFile only. Reads and writes fail with CLIENT_CLOSED until reopenAfterSwap. */
  closeForSwap(): void {
    this.client.close();
  }

  /**
   * For swapLocalSqliteFile only. The next read re-runs the setup against the
   * restored file, and LocalDB re-reads the document on every operation, so
   * the restored data is what the next request sees.
   */
  reopenAfterSwap(): void {
    this.client = openSqlite(this.url, this.authToken);
    this.ready = null;
  }

  private ensureSchema(): Promise<void> {
    if (!this.ready) {
      this.ready = (async () => {
        // WAL + synchronous=NORMAL for a local file, before the first
        // statement. Never throws; see applyLocalSqlitePragmas.
        await applyLocalSqlitePragmas(this.client, this.url);
        await this.client.execute('CREATE TABLE IF NOT EXISTS astrobaas_doc (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
      })();
    }
    return this.ready;
  }

  async read(): Promise<T | null> {
    await this.ensureSchema();
    const res = await this.client.execute({
      sql: 'SELECT v FROM astrobaas_doc WHERE k = ?',
      args: [this.docKey],
    });
    const row = res.rows[0];
    if (!row || row.v == null) return null;
    try {
      return JSON.parse(String(row.v)) as T;
    } catch {
      return null;
    }
  }

  /**
   * The document exactly as stored, unparsed — the "expected" half of
   * `writeIfUnchanged`. Null when there is no document yet.
   */
  async readRaw(): Promise<string | null> {
    await this.ensureSchema();
    const res = await this.client.execute({
      sql: 'SELECT v FROM astrobaas_doc WHERE k = ?',
      args: [this.docKey],
    });
    const row = res.rows[0];
    return row && row.v != null ? String(row.v) : null;
  }

  /**
   * Write `data` only if the stored document is still exactly `expectedRaw`.
   *
   * The one write on this driver that is not last-write-wins across processes.
   * `write()` replaces the document whatever another replica wrote meanwhile;
   * this refuses instead, so the caller can re-read and decide again. Used
   * where a lost update is not a cosmetic problem (the newsletter campaign
   * claim). The comparison is SQLite's own string equality inside one UPDATE,
   * so no other writer can slip between the check and the write.
   */
  async writeIfUnchanged(data: T, expectedRaw: string | null): Promise<boolean> {
    await this.ensureSchema();
    const next = JSON.stringify(data);
    const res = expectedRaw === null
      ? await this.client.execute({
        sql: 'INSERT INTO astrobaas_doc (k, v) VALUES (?, ?) ON CONFLICT(k) DO NOTHING',
        args: [this.docKey, next],
      })
      : await this.client.execute({
        sql: 'UPDATE astrobaas_doc SET v = ? WHERE k = ? AND v = ?',
        args: [next, this.docKey, expectedRaw],
      });
    return Number(res.rowsAffected ?? 0) > 0;
  }

  async write(data: T): Promise<void> {
    await this.ensureSchema();
    await this.client.execute({
      sql: 'INSERT INTO astrobaas_doc (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
      args: [this.docKey, JSON.stringify(data)],
    });
  }
}
