import { Low } from 'lowdb'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { hashPassword } from './auth'
import { getDbPath } from './paths'
import { selectAdapter } from './storage/select-adapter'
import { SqlStorage } from './storage/sql-storage'
import type { LibsqlAdapter } from './storage/libsql-adapter'
import { runExclusive } from './lease'
import { applyPostQuery, type PostQuery, type PagedResult } from '../core/post-query'
import { applyAuditQuery, type AuditQuery } from '../core/audit-query'
import {
  applyChangeQuery,
  changedFieldNames,
  compareChangesNewestFirst,
  normalizeChangeSince,
  recordPrunedChanges,
  CONTENT_CHANGE_CAP,
  type ContentChangeQuery,
  type ContentChangePage,
} from '../core/change-feed'
import { defaultLocale, locales } from './i18n'
import { makeDefaultData, makeSeedAdmin } from './seed-data'
import { runMigrationsExclusive, LATEST_SCHEMA_VERSION } from './migrations'
import { SlugTakenError } from './storage/slug-taken'
export { SlugTakenError, isSlugTakenError } from './storage/slug-taken'
import type {
  ShippingMethodRecord,
  CouponRecord,
  DatabaseSchema,
  Post,
  Category,
  User,
  MediaFile,
  Theme,
  ThemeConfig,
  Setting,
  ContentChange,
  PluginRecord,
  ContactMessage,
  Subscriber,
  ApiKey,
  Webhook,
  WebhookDelivery,
  AuditEvent,
  ConsentReceipt,
  EmailLogEntry,
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
} from '../core/models'
import type {
  Storage, UpdateProductOptions, OrderTransitionGuard, RecentOrdersQuery,
  PaymentEventClaim, PaymentEventClaimOptions, RefundAppend, IdempotencyClaim,
} from '../core/storage'
import type { RefundRecord } from '../core/models'
import { span } from './request-profile'

// Collision-resistant, unguessable identifiers. (Previously Date.now()+Math.random(),
// which was predictable and enabled IDOR-style enumeration.)
function generateId() {
  return crypto.randomUUID()
}

const DB_PATH = getDbPath()
const SEED_PATH = path.resolve(process.cwd(), 'db.seed.json')

// Domain models live in src/core/models.ts (imported above) so the data model
// has an identity independent of this storage engine.

// Pick the persistence engine from the environment (see select-adapter.ts):
//   relational → SqlStorage (per-entity rows); LocalDB delegates to it.
//   libsql/lowdb → the doc model below (lowdb in memory/file, or libSQL blob).
const chosen = selectAdapter<DatabaseSchema>()
const { adapter, driver } = chosen

// In relational mode every LocalDB method delegates to this backend; the lowdb
// `db` below is an unused in-memory stub kept only so the doc-path code compiles.
const sqlBackend = chosen.relational
  ? new SqlStorage(chosen.relational.url, chosen.relational.authToken)
  : null

// Did a lowdb database already exist at boot? Captured BEFORE the seed-copy so
// init() can stamp a brand-new file at the latest schema version (nothing to
// migrate) instead of needlessly running the migration pass on fresh data.
const lowdbExistedAtBoot = driver === 'lowdb' && fs.existsSync(DB_PATH)

/**
 * How many consent receipts are kept.
 *
 * Higher than the audit cap because these are one small row per visitor
 * decision rather than per privileged action, and because the value of the
 * trail is having the older ones when somebody asks about a decision they made
 * months ago. Six months is also the consent lifetime, so this is roughly
 * "everything still in force" for a small site.
 */
const CONSENT_RECEIPT_CAP = 20000

/**
 * How many outbound emails are remembered.
 *
 * Small on purpose. This holds recipient addresses, so it is personal data
 * that grows on its own, and the question it exists to answer — "did that go
 * out?" — is always about something recent. A year of sends would be a
 * liability rather than a feature.
 */
const EMAIL_LOG_CAP = 2000

// lowdb-only: if the operator has dropped a `db.seed.json` beside the project,
// first boot starts from THEIR data instead of the built-in seed. A
// bring-your-own-starter-data hook, nothing more.
//
// The project itself no longer ships one. It used to, and that file was a
// second, divergent copy of makeDefaultData(): stale post slugs, stale category
// slugs, and two invented users — john@example.com with the `admin` role —
// that makeDefaultData() had deliberately removed. Because this branch runs
// FIRST, the checked-in file silently overrode the code seed on the default
// driver, so the decision recorded in seed-data.ts was true everywhere except
// where most people would actually see it.
//
// (The libSQL drivers have no equivalent branch: they seed from defaultData
// plus the seed-admin step in init(), which is why they were already correct.)
if (driver === 'lowdb' && !fs.existsSync(DB_PATH) && fs.existsSync(SEED_PATH)) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true })
  fs.copyFileSync(SEED_PATH, DB_PATH)
}
const defaultData: DatabaseSchema = makeDefaultData()

const db = new Low<DatabaseSchema>(adapter, defaultData)

/**
 * Serialize every read-modify-write through a single async mutex. LowDB keeps
 * the whole document in memory and rewrites the file wholesale; without this,
 * two concurrent requests can read the same snapshot and the second write
 * clobbers the first (lost update). Single-node only — a multi-process
 * deployment still needs a real database (see README).
 */
/** One Idempotency-Key, as stored in the document (lowdb and doc-blob). */
interface IdempotencyRecord {
  fp: string
  state: 'pending' | 'done'
  /** Who holds a pending lease — completing or releasing needs it. */
  token: string
  expires_at: number
  response?: unknown
}

let opChain: Promise<unknown> = Promise.resolve()
function locked<T>(fn: () => Promise<T>): Promise<T> {
  const run = opChain.then(fn, fn)
  opChain = run.then(() => undefined, () => undefined)
  return run
}

// Appends a content-change record to the in-memory document. Caller already
// holds the lock and is responsible for db.write(); folding it into the same
// write keeps the mutation + audit entry atomic and avoids lock re-entrancy.
/** Keys of the first-class commerce collections on DatabaseSchema. */
type CommerceKey = 'products' | 'brands' | 'productCategories' | 'orders' | 'customers'
  | 'shippingMethods' | 'coupons'
/** Commerce entities tracked in the content-change feed (null = untracked). */
type EntityTypeFor = 'product' | 'order' | null

function appendChange(
  data: DatabaseSchema,
  entityType: ContentChange['entity_type'],
  entityId: string,
  action: ContentChange['action'],
  changes: any,
  // The names an UPDATE touched (see ContentChange.fields). Passed by every
  // update path that knows its patch; tests/change-feed.test.mjs drives each
  // one on every driver, because a path that forgot it would publish an update
  // with no field list — which reads as "unknown", so it is safe, but it
  // quietly costs a storefront the ability to skip a revalidation.
  fields?: string[],
): ContentChange {
  if (!data.contentChanges) data.contentChanges = []
  const contentChange: ContentChange = {
    id: generateId(),
    entity_type: entityType,
    entity_id: entityId,
    action,
    changes,
    timestamp: new Date().toISOString(),
    ...(fields ? { fields } : {}),
  }
  data.contentChanges.push(contentChange)
  trimChangeRing(data)
  return contentChange
}

/**
 * Keep only the newest CONTENT_CHANGE_CAP change-feed entries, and record what
 * goes.
 *
 * The cap is shared with the relational driver (core/change-feed.ts), which
 * prunes its table to the same number, so the feed means the same thing on all
 * three drivers. Insertion order IS time order here: every entry is stamped
 * `now` under the lock, so the head is the oldest and the tail is kept.
 *
 * What is evicted is folded into `contentChangesPruned`, per entity type — that
 * is how the public feed knows a poller's window was cut short
 * (`meta.truncated`). The relational driver records the same thing in the
 * transaction that deletes. See recordPrunedChanges.
 */
function trimChangeRing(data: DatabaseSchema): void {
  const over = data.contentChanges.length - CONTENT_CHANGE_CAP
  if (over <= 0) return
  data.contentChangesPruned = recordPrunedChanges(data.contentChangesPruned, data.contentChanges.slice(0, over))
  data.contentChanges = data.contentChanges.slice(over)
}

// Run pending schema migrations exactly once per process. Memoized on a
// promise so the many concurrent init() calls at startup all await one run; a
// failure clears the memo so the next init() retries rather than wedging.
let migrationPromise: Promise<void> | null = null
/**
 * The migration lease lasts a minute and is renewed every 20 s while the work
 * runs, so a process that dies mid-migration holds the others up for at most
 * a minute (on lowdb, not at all: a dead pid's lease is taken at once).
 */
const MIGRATION_LEASE_TTL_MS = 60_000
/**
 * How long a booting process waits for another one's migration before giving
 * up (MIGRATION_LOCK_WAIT_MS, default 2 minutes). Giving up is not fatal: the
 * next init() — the next request — waits again.
 */
function migrationLockWaitMs(): number {
  const n = Number(process.env.MIGRATION_LOCK_WAIT_MS)
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), 30 * 60_000) : 120_000
}
let lastMigration: { from: number; to: number; applied: string[] } | null = null
function ensureMigrated(): Promise<void> {
  if (!migrationPromise) {
    // LocalDB's static surface implements the whole Storage contract and routes
    // to the active backend, so the runner upgrades every driver uniformly.
    //
    // Under the `migrations` lease, so two processes booting together do not
    // migrate the same rows at the same time (see runMigrationsExclusive). A
    // failure to get it in time rejects like any other migration failure: the
    // memo is cleared and the next init() waits again.
    const log = (m: string) => console.log(m)
    migrationPromise = runMigrationsExclusive(LocalDB as unknown as Storage, log, (fn) =>
      runExclusive('migrations', fn, {
        ttlMs: MIGRATION_LEASE_TTL_MS,
        waitMs: migrationLockWaitMs(),
        log,
      }))
      .then((res) => {
        lastMigration = res
      })
      .catch((err) => {
        migrationPromise = null
        throw err
      })
  }
  return migrationPromise
}

/**
 * Resolves when the relational driver's background change-feed upkeep — the
 * backlog prune and the `(ts, id)` index, started by the first init() — has
 * finished. It never rejects.
 *
 * Nothing in production waits for it: running behind the boot instead of inside
 * it is the whole point (see SqlStorage.upkeepChangeFeed). The tests await it
 * before they look at the table. The document drivers have no such work: their
 * trim is part of init() itself.
 */
export function changeFeedUpkeep(): Promise<void> {
  return sqlBackend ? sqlBackend.changeFeedUpkeep : Promise.resolve()
}

/** Schema status for observability (see /readyz): target version + last run. */
export function getSchemaStatus(): {
  version: number
  lastMigration: { from: number; to: number; applied: string[] } | null
} {
  return { version: LATEST_SCHEMA_VERSION, lastMigration }
}

// Database operations
export class LocalDB {
  private static initialized = false

  static async init() {
    // Relational driver self-initializes (creates tables + seeds) on demand.
    if (sqlBackend) {
      await sqlBackend.init()
      LocalDB.initialized = true
      await ensureMigrated()
      return
    }
    await locked(async () => {
      // What `db.read()` does, keeping the one fact it throws away: whether a
      // stored document exists at all.
      const stored = await adapter.read()
      if (stored) db.data = stored
      if (!db.data) {
        db.data = defaultData
      }
      // Only WRITE when this pass changed something. Every API route calls
      // init(), and this used to rewrite the whole document on each call — on
      // the libSQL doc-blob driver a whole-document write per request, which
      // with two replicas meant any request could overwrite the other
      // replica's write that landed between this read and this write. Every
      // step below only ADDS a missing key, replaces a null one, or adds the
      // seed admin, so comparing the key count, the null count and the user
      // count before and after tells us whether there is anything to save.
      //
      // The change-ring trim below is the one step that changes no key and no
      // user, only the LENGTH of contentChanges, so the shape carries that
      // length too. Without it an oversized document (a restored backup, a
      // hand-merged file) was trimmed in memory on every request and never
      // saved, and the feed's own test caught it.
      const shape = (d: DatabaseSchema) => {
        const values = Object.values(d as unknown as Record<string, unknown>)
        return `${values.length}:${values.filter(v => v == null).length}:${d.users?.length ?? -1}`
          + `:${d.contentChanges?.length ?? -1}`
      }
      const shapeBefore = stored ? shape(db.data) : null
      // Ensure newer top-level keys exist on legacy databases.
      db.data.contentChanges = db.data.contentChanges ?? []
      // The ring is enforced on APPEND, so a document that arrived oversized —
      // a restored backup, a hand-merged file, an import that wrote the array
      // wholesale — stayed oversized until somebody next saved something.
      // Trimmed here too, the same way appendChange trims (the tail is the
      // newest), so "the feed holds at most CONTENT_CHANGE_CAP" is true from the
      // first request rather than from the first write — and, like every
      // eviction, recorded, so a poller whose window reached into what this
      // drops is told so.
      trimChangeRing(db.data)
      db.data.themeSettings = db.data.themeSettings ?? []
      db.data.messages = db.data.messages ?? []
      db.data.subscribers = db.data.subscribers ?? []
      db.data.plugins = db.data.plugins ?? []
      db.data.custom = db.data.custom ?? {}
      db.data.apiKeys = db.data.apiKeys ?? []
      db.data.webhooks = db.data.webhooks ?? []
      db.data.webhookDeliveries = db.data.webhookDeliveries ?? []
      db.data.auditEvents = db.data.auditEvents ?? []
      db.data.consentReceipts = db.data.consentReceipts ?? []
      db.data.emailLog = db.data.emailLog ?? []
      db.data.postRevisions = db.data.postRevisions ?? []
      db.data.products = db.data.products ?? []
      db.data.brands = db.data.brands ?? []
      db.data.productCategories = db.data.productCategories ?? []
      db.data.orders = db.data.orders ?? []
      db.data.customers = db.data.customers ?? []

      // Seed an admin user with a known password on first boot. Operators are
      // expected to change the password in /admin/users immediately.
      //
      // The test is "does this install have ANY administrator?", not "is there
      // a user called admin@local". Matching on the address meant that an
      // operator who renamed the seeded account — which the users API now
      // permits — got a BRAND NEW admin@local on the next boot, carrying the
      // published default password and re-using the seed's fixed id. An install
      // the operator believed they had secured quietly grew a second door.
      if (!db.data.users.some(u => u.role === 'admin')) {
        db.data.users.unshift(makeSeedAdmin())
      }

      // A brand-new lowdb file has nothing to migrate — stamp it at the latest
      // version so the runner is a no-op. An existing/legacy file keeps its
      // recorded version (or 0 if unversioned) so pending migrations apply.
      if (db.data.schemaVersion == null && !lowdbExistedAtBoot) {
        db.data.schemaVersion = LATEST_SCHEMA_VERSION
      }

      if (shapeBefore === null || shape(db.data) !== shapeBefore) await db.write()
      LocalDB.initialized = true
    })
    // Run migrations OUTSIDE the init mutex — they call back into LocalDB
    // methods (which take the same lock), so holding it here would deadlock.
    await ensureMigrated()
  }

  static async getSchemaVersion(): Promise<number> {
    if (sqlBackend) return sqlBackend.getSchemaVersion()
    return locked(async () => {
      await db.read()
      return db.data?.schemaVersion ?? 0
    })
  }

  static async setSchemaVersion(version: number): Promise<void> {
    if (sqlBackend) return sqlBackend.setSchemaVersion(version)
    return locked(async () => {
      await db.read()
      if (db.data) {
        db.data.schemaVersion = version
        await db.write()
      }
    })
  }

  static async getUserByEmail(email: string) {
    if (sqlBackend) return sqlBackend.getUserByEmail(email)
    if (!LocalDB.initialized) await LocalDB.init()
    return locked(async () => {
      await db.read()
      return db.data?.users.find(u => u.email.toLowerCase() === email.toLowerCase())
    })
  }

  static async touchLogin(userId: string) {
    if (sqlBackend) return sqlBackend.touchLogin(userId)
    return locked(async () => {
      await db.read()
      const u = db.data?.users.find(x => x.id === userId)
      if (u) {
        u.last_login = new Date().toISOString()
        await db.write()
      }
    })
  }

  // Posts
  static async getPosts() {
    // Named spans on the three reads that dominate a page render (C-157).
    // `span` is a no-op unless PROFILE_REQUESTS=1, and it returns the promise's
    // own result and re-throws its error — wrapping a call can never change
    // what the caller sees.
    return span('db.posts', async () => {
      if (sqlBackend) return sqlBackend.getPosts()
      return locked(async () => {
        await db.read()
        return [...(db.data?.posts || [])]
      })
    })
  }

  static async queryPosts(query: PostQuery): Promise<PagedResult<Post>> {
    // Spanned (C-157). This is the read that serves a listing page on the
    // libSQL and relational drivers — so without it the breakdown showed no
    // db.* span at all and the whole cost landed in "unaccounted", on exactly
    // the installs where somebody would turn a profiler on.
    return span('db.query_posts', async () => {
      if (sqlBackend) return sqlBackend.queryPosts(query)
      return locked(async () => {
        await db.read()
        // The doc driver has no index to push into, so it runs the shared
        // specification directly. That is not a compromise — it is what makes
        // the spec authoritative: the SQL driver's job is to AGREE with this.
        return applyPostQuery(db.data?.posts ?? [], query, defaultLocale(), locales())
      })
    })
  }

  static async getPost(id: string) {
    if (sqlBackend) return sqlBackend.getPost(id)
    return locked(async () => {
      await db.read()
      return db.data?.posts.find(post => post.id === id)
    })
  }

  /**
   * Slug uniqueness, enforced where the WRITE happens.
   *
   * No storage driver has a unique index — every table is `(id, data)` — so
   * this is the only constraint there is. It used to live in the create route,
   * as a read of all posts followed by a separate write: two requests
   * interleave between those awaits, both see the slug as free, and both take
   * it. The second post is then permanently unreachable, because every
   * resolver (`/blog/{slug}`, `resolvePostRef`) takes the FIRST match — and
   * both requests got a 201, so nothing looks wrong until a URL serves the
   * wrong article.
   *
   * Doing the check inside the same `locked()` hold as the insert is what
   * makes it a constraint rather than a hope. `reserveStock` documents the
   * identical reasoning for stock; this is the same shape.
   */
  private static disambiguate(slug: string, taken: ReadonlySet<string>): string {
    if (!slug || !taken.has(slug)) return slug
    const MAX = 80
    const root = slug.slice(0, MAX)
    for (let n = 2; n <= 200; n += 1) {
      const suffix = `-${n}`
      const candidate = `${root.slice(0, MAX - suffix.length)}${suffix}`
      if (!taken.has(candidate)) return candidate
    }
    return `${root.slice(0, MAX - 7)}-${Math.random().toString(36).slice(2, 8)}`
  }

  static async createPost(post: Omit<Post, 'id' | 'created_at' | 'updated_at'>) {
    if (sqlBackend) return sqlBackend.createPost(post)
    return locked(async () => {
      await db.read()
      const taken = new Set((db.data?.posts ?? []).map(p => p.slug))
      const newPost: Post = {
        ...post,
        slug: LocalDB.disambiguate(post.slug, taken),
        id: generateId(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }
      if (!db.data) return newPost
      db.data.posts.push(newPost)
      appendChange(db.data, 'post', newPost.id, 'create', newPost)
      await db.write()
      return newPost
    })
  }

  /**
   * Add to view counters in ONE write, touching nothing else.
   *
   * Not `updatePost` per post, for three reasons the audit named:
   *   - it stamps `updated_at`, so a READ moved the article's modification date
   *     — which the sitemap publishes as `lastmod` and search engines read as
   *     "this changed";
   *   - it appends a full old+new snapshot to the content change feed, which is
   *     capped, so counting views evicted real editorial history;
   *   - it takes the lock and rewrites the WHOLE document once per post, so a
   *     flush of fifty articles was fifty full rewrites rather than one.
   */
  static async bumpPostViews(deltas: ReadonlyMap<string, number>) {
    if (deltas.size === 0) return 0
    if (sqlBackend) return sqlBackend.bumpPostViews(deltas)
    return locked(async () => {
      await db.read()
      if (!db.data) return 0
      let written = 0
      for (const [id, delta] of deltas) {
        if (!Number.isFinite(delta) || delta <= 0) continue
        const i = db.data.posts.findIndex(p => p.id === id)
        if (i < 0) continue
        const current = db.data.posts[i].views
        db.data.posts[i].views =
          (typeof current === 'number' && Number.isFinite(current) ? current : 0) + delta
        written += 1
      }
      // One write for every post counted, not one per post.
      if (written > 0) await db.write()
      return written
    })
  }

  static async updatePost(id: string, updates: Partial<Post>) {
    if (sqlBackend) return sqlBackend.updatePost(id, updates)
    return locked(async () => {
      await db.read()
      // Slug uniqueness, checked INSIDE the same lock as the write.
      //
      // The service layer checks it too, and that check is useful — it is what
      // produces the 400 with a message. But a read there followed by a write
      // here is two awaits apart, so concurrent renames all saw the slug free
      // and all took it. Create solved this by moving the check into the lock;
      // update refuses rather than renames, because on update the author typed
      // the slug and silently changing it is worse than saying no.
      if (typeof updates.slug === 'string') {
        const clash = (db.data?.posts ?? []).some(p => p.slug === updates.slug && p.id !== id)
        if (clash) throw new SlugTakenError(updates.slug)
      }
      const postIndex = db.data?.posts.findIndex(post => post.id === id)
      if (postIndex !== undefined && postIndex >= 0 && db.data) {
        const oldPost = { ...db.data.posts[postIndex] }
        db.data.posts[postIndex] = {
          ...db.data.posts[postIndex],
          ...updates,
          updated_at: new Date().toISOString()
        }
        appendChange(db.data, 'post', id, 'update', {
          old: oldPost,
          new: db.data.posts[postIndex],
          changes: updates
        }, changedFieldNames(updates))
        await db.write()
        return db.data.posts[postIndex]
      }
      return null
    })
  }

  static async deletePost(id: string) {
    if (sqlBackend) return sqlBackend.deletePost(id)
    return locked(async () => {
      await db.read()
      const postIndex = db.data?.posts.findIndex(post => post.id === id)
      if (postIndex !== undefined && postIndex >= 0 && db.data) {
        const deletedPost = db.data.posts[postIndex]
        db.data.posts.splice(postIndex, 1)
        appendChange(db.data, 'post', id, 'delete', deletedPost)
        await db.write()
        return true
      }
      return false
    })
  }

  // Categories
  static async getCategories() {
    if (sqlBackend) return sqlBackend.getCategories()
    return locked(async () => {
      await db.read()
      return [...(db.data?.categories || [])]
    })
  }

  static async createCategory(category: Omit<Category, 'id' | 'created_at' | 'updated_at'>) {
    if (sqlBackend) return sqlBackend.createCategory(category)
    return locked(async () => {
      await db.read()
      const newCategory: Category = {
        ...category,
        id: generateId(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }
      db.data?.categories.push(newCategory)
      await db.write()
      return newCategory
    })
  }

  static async updateCategory(id: string, updates: Partial<Category>) {
    if (sqlBackend) return sqlBackend.updateCategory(id, updates)
    return locked(async () => {
      await db.read()
      const categoryIndex = db.data?.categories.findIndex(cat => cat.id === id)
      if (categoryIndex !== undefined && categoryIndex >= 0 && db.data) {
        db.data.categories[categoryIndex] = {
          ...db.data.categories[categoryIndex],
          ...updates,
          updated_at: new Date().toISOString()
        }
        await db.write()
        return db.data.categories[categoryIndex]
      }
      return null
    })
  }

  static async deleteCategory(id: string) {
    if (sqlBackend) return sqlBackend.deleteCategory(id)
    return locked(async () => {
      await db.read()
      if (db.data) {
        db.data.categories = db.data.categories.filter(cat => cat.id !== id)
        await db.write()
        return true
      }
      return false
    })
  }

  // ── Commerce ─────────────────────────────────────────────────────────
  // First-class collections (products/brands/productCategories/orders/
  // customers). Same shape as the collections above; writes on products and
  // orders are recorded in the content-change feed for sync.

  private static commerceList<T>(key: CommerceKey) {
    return locked(async () => {
      await db.read()
      // Copy, like every other collection getter. The copy-on-read commit
      // listed ten getters and this helper was not one of them — so products,
      // brands, productCategories, orders, customers, shippingMethods and
      // coupons all still handed out the LIVE cached array.
      //
      // Five call sites sort it in place (api/orders, api/customers,
      // api/brands, admin/orders.astro, admin/customers.astro), and
      // /api/brands is in PUBLIC_API_GET — so an anonymous GET reordered
      // persisted state. commerce-service also hands the live products array
      // to third-party plugin filters.
      return [...(((db.data as any)?.[key] || []) as T[])]
    })
  }

  private static commerceCreate<T extends { id: string }>(
    key: CommerceKey, entity: EntityTypeFor, item: any,
  ) {
    return locked(async () => {
      await db.read()
      const record = {
        ...item,
        id: generateId(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      } as T
      // Collections added by a later schema version are absent from an older
      // document (a restored backup, or a database that predates them). Creating
      // the array here rather than assuming it turns a 500 into a no-op — the
      // migration seeds it too, but a restore can arrive without one.
      const data = db.data as any
      if (!Array.isArray(data[key])) data[key] = []
      data[key].push(record)
      if (entity) appendChange(db.data!, entity, record.id, 'create', record)
      await db.write()
      return record
    })
  }

  /**
   * `adjust` sees the stored row and the row about to replace it, INSIDE the
   * same locked() hold as the read and the write — so anything it copies from
   * `stored` is the value at write time, not at some earlier read.
   */
  private static commerceUpdate<T extends { id: string }>(
    key: CommerceKey, entity: EntityTypeFor, id: string, updates: Partial<T>,
    adjust?: (stored: T, next: T) => void,
  ) {
    return locked(async () => {
      await db.read()
      const rows = (db.data as any)[key] as T[]
      const idx = rows.findIndex(r => r.id === id)
      if (idx < 0) return null
      const next = { ...rows[idx], ...updates, updated_at: new Date().toISOString() }
      adjust?.(rows[idx], next)
      rows[idx] = next
      if (entity) appendChange(db.data!, entity, id, 'update', rows[idx], changedFieldNames(updates))
      await db.write()
      return rows[idx]
    })
  }

  private static commerceDelete(key: CommerceKey, entity: EntityTypeFor, id: string) {
    return locked(async () => {
      await db.read()
      const rows = (db.data as any)[key] as { id: string }[]
      const before = rows.length
      ;(db.data as any)[key] = rows.filter(r => r.id !== id)
      if (before === (db.data as any)[key].length) return false
      if (entity) appendChange(db.data!, entity, id, 'delete', { id })
      await db.write()
      return true
    })
  }

  // Products
  static async getProducts() {
    if (sqlBackend) return sqlBackend.getProducts()
    return this.commerceList<Product>('products')
  }
  static async getProduct(id: string) {
    if (sqlBackend) return sqlBackend.getProduct(id)
    return (await this.commerceList<Product>('products')).find(p => p.id === id) ?? null
  }
  static async getProductBySlug(slug: string) {
    if (sqlBackend) return sqlBackend.getProductBySlug(slug)
    return (await this.commerceList<Product>('products')).find(p => p.slug === slug) ?? null
  }
  static async createProduct(p: Omit<Product, 'id' | 'created_at' | 'updated_at'>) {
    if (sqlBackend) return sqlBackend.createProduct(p)
    return this.commerceCreate<Product>('products', 'product', p)
  }
  static async updateProduct(id: string, updates: Partial<Product>, opts?: UpdateProductOptions) {
    if (sqlBackend) return sqlBackend.updateProduct(id, updates, opts)
    const keep = opts?.keepVariantStock
    return this.commerceUpdate<Product>(
      'products', 'product', id, updates,
      keep?.length ? (stored, next) => LocalDB.keepStoredVariantStock(stored, next, keep) : undefined,
    )
  }

  /**
   * The lowdb and doc-blob half of `UpdateProductOptions.keepVariantStock`.
   *
   * Every listed variant is written as supplied except its count, which is
   * copied from the stored variant with the same id — the count as checkout
   * left it, since this runs inside the locked() hold that every reservation
   * also takes. `in_stock` follows that count the way normalizeVariants and
   * reserveStock derive it. A listed id the stored row no longer has keeps
   * the supplied count: there is nothing to keep it from.
   */
  private static keepStoredVariantStock(stored: Product, next: Product, keep: readonly string[]): void {
    if (!Array.isArray(next.variants) || !Array.isArray(stored.variants)) return
    const ids = new Set(keep)
    const storedById = new Map(stored.variants.map(v => [v.id, v]))
    next.variants = next.variants.map(v => {
      const was = ids.has(v.id) ? storedById.get(v.id) : undefined
      if (!was) return v
      const stock = was.stock ?? null
      return { ...v, stock, in_stock: stock === null ? true : stock > 0 }
    })
  }

  /**
   * Atomically reserve stock. The check AND the decrement happen inside ONE
   * `locked()` hold, which is what makes this safe: doing them as two separate
   * awaited calls lets concurrent checkouts interleave between the check and the
   * write and oversell the item.
   *
   * `stock === null` means "not tracked" — always succeeds, nothing is written.
   */
  static async reserveStock(
    productId: string, qty: number,
    opts?: { allowBackorder?: boolean; variantId?: string | null },
  ): Promise<boolean> {
    if (sqlBackend) return sqlBackend.reserveStock(productId, qty, opts)
    if (!Number.isInteger(qty) || qty <= 0) return false
    return locked(async () => {
      await db.read()
      const rows = (db.data as any).products as Product[]
      const p = rows?.find(r => r.id === productId)
      if (!p) return false

      // A variant carries its OWN count — the whole point of a variant is to
      // answer "how many black ones are left". Decrementing the parent here
      // would let every colour draw down one shared pool.
      if (opts?.variantId) {
        const v = (p.variants ?? []).find(x => x.id === opts.variantId)
        if (!v) return false
        if (v.stock == null) return true // untracked variant
        if (v.stock < qty && !opts?.allowBackorder) return false
        v.stock = v.stock - qty
        v.in_stock = v.stock > 0
        p.updated_at = new Date().toISOString()
        await db.write()
        return true
      }

      if (p.stock == null) return true // untracked: unlimited
      // A backorder is allowed to go negative; the count then records the debt
      // owed to buyers, which is what a warehouse actually needs to see.
      if (p.stock < qty && !opts?.allowBackorder) return false
      const stock = p.stock - qty
      Object.assign(p, { stock, in_stock: stock > 0, updated_at: new Date().toISOString() })
      await db.write()
      return true
    })
  }

  /** Return reserved stock (rollback / cancellation / refund). */
  static async releaseStock(
    productId: string, qty: number, opts?: { variantId?: string | null },
  ): Promise<void> {
    if (sqlBackend) return sqlBackend.releaseStock(productId, qty, opts)
    if (!Number.isInteger(qty) || qty <= 0) return
    await locked(async () => {
      await db.read()
      const rows = (db.data as any).products as Product[]
      const p = rows?.find(r => r.id === productId)
      if (!p) return

      // Return it to the same pool it came from, or a cancelled black frame
      // credits the parent and the black count stays wrong forever.
      if (opts?.variantId) {
        const v = (p.variants ?? []).find(x => x.id === opts.variantId)
        if (!v || v.stock == null) return
        v.stock = v.stock + qty
        v.in_stock = v.stock > 0
        p.updated_at = new Date().toISOString()
        await db.write()
        return
      }

      if (p.stock == null) return
      const stock = p.stock + qty
      Object.assign(p, { stock, in_stock: stock > 0, updated_at: new Date().toISOString() })
      await db.write()
    })
  }

  static async deleteProduct(id: string) {
    if (sqlBackend) return sqlBackend.deleteProduct(id)
    return this.commerceDelete('products', 'product', id)
  }

  // Brands
  static async getShippingMethods() {
    if (sqlBackend) return sqlBackend.getShippingMethods()
    return this.commerceList<ShippingMethodRecord>('shippingMethods')
  }
  static async createShippingMethod(m: Omit<ShippingMethodRecord, 'id' | 'created_at' | 'updated_at'>) {
    if (sqlBackend) return sqlBackend.createShippingMethod(m)
    return this.commerceCreate<ShippingMethodRecord>('shippingMethods', null, m)
  }
  static async updateShippingMethod(id: string, updates: Partial<ShippingMethodRecord>) {
    if (sqlBackend) return sqlBackend.updateShippingMethod(id, updates)
    return this.commerceUpdate<ShippingMethodRecord>('shippingMethods', null, id, updates)
  }
  static async deleteShippingMethod(id: string) {
    if (sqlBackend) return sqlBackend.deleteShippingMethod(id)
    return this.commerceDelete('shippingMethods', null, id)
  }

  static async getCoupons() {
    if (sqlBackend) return sqlBackend.getCoupons()
    return this.commerceList<CouponRecord>('coupons')
  }
  static async createCoupon(c: Omit<CouponRecord, 'id' | 'created_at' | 'updated_at'>) {
    if (sqlBackend) return sqlBackend.createCoupon(c)
    return this.commerceCreate<CouponRecord>('coupons', null, c)
  }
  static async updateCoupon(id: string, updates: Partial<CouponRecord>) {
    if (sqlBackend) return sqlBackend.updateCoupon(id, updates)
    return this.commerceUpdate<CouponRecord>('coupons', null, id, updates)
  }
  static async deleteCoupon(id: string) {
    if (sqlBackend) return sqlBackend.deleteCoupon(id)
    return this.commerceDelete('coupons', null, id)
  }

  /**
   * The lowdb and doc-blob half of Storage.claimCouponUse: the limit check
   * and the increment in ONE locked() hold.
   */
  static async claimCouponUse(id: string): Promise<boolean> {
    if (sqlBackend) return sqlBackend.claimCouponUse(id)
    return locked(async () => {
      await db.read()
      const rows = ((db.data as any)?.coupons ?? []) as CouponRecord[]
      const c = rows.find(r => r.id === id)
      if (!c) return false
      const used = Number(c.used_count) || 0
      if (c.usage_limit != null && used >= c.usage_limit) return false
      c.used_count = used + 1
      c.updated_at = new Date().toISOString()
      await db.write()
      return true
    })
  }

  static async releaseCouponUse(id: string): Promise<void> {
    if (sqlBackend) return sqlBackend.releaseCouponUse(id)
    await locked(async () => {
      await db.read()
      const rows = ((db.data as any)?.coupons ?? []) as CouponRecord[]
      const c = rows.find(r => r.id === id)
      if (!c) return
      c.used_count = Math.max(0, (Number(c.used_count) || 0) - 1)
      c.updated_at = new Date().toISOString()
      await db.write()
    })
  }

  /**
   * Atomic counter. The read AND the write happen inside one mutex hold —
   * the same discipline as reserveStock, and for the same reason: two
   * concurrent checkouts must never be handed the same order number.
   */
  static async nextSequence(name: string): Promise<number> {
    if (sqlBackend) return sqlBackend.nextSequence(name)
    return locked(async () => {
      await db.read()
      const data = db.data as any
      if (!data.counters || typeof data.counters !== 'object') data.counters = {}
      const current = Number(data.counters[name])
      const next = (Number.isFinite(current) ? current : 0) + 1
      data.counters[name] = next
      await db.write()
      return next
    })
  }

  static async getBrands() {
    if (sqlBackend) return sqlBackend.getBrands()
    return this.commerceList<Brand>('brands')
  }
  static async createBrand(b: Omit<Brand, 'id' | 'created_at' | 'updated_at'>) {
    if (sqlBackend) return sqlBackend.createBrand(b)
    return this.commerceCreate<Brand>('brands', null, b)
  }
  static async updateBrand(id: string, updates: Partial<Brand>) {
    if (sqlBackend) return sqlBackend.updateBrand(id, updates)
    return this.commerceUpdate<Brand>('brands', null, id, updates)
  }
  static async deleteBrand(id: string) {
    if (sqlBackend) return sqlBackend.deleteBrand(id)
    return this.commerceDelete('brands', null, id)
  }

  // Product categories
  static async getProductCategories() {
    if (sqlBackend) return sqlBackend.getProductCategories()
    return this.commerceList<ProductCategory>('productCategories')
  }
  static async createProductCategory(c: Omit<ProductCategory, 'id' | 'created_at' | 'updated_at'>) {
    if (sqlBackend) return sqlBackend.createProductCategory(c)
    return this.commerceCreate<ProductCategory>('productCategories', null, c)
  }
  static async updateProductCategory(id: string, updates: Partial<ProductCategory>) {
    if (sqlBackend) return sqlBackend.updateProductCategory(id, updates)
    return this.commerceUpdate<ProductCategory>('productCategories', null, id, updates)
  }
  static async deleteProductCategory(id: string) {
    if (sqlBackend) return sqlBackend.deleteProductCategory(id)
    return this.commerceDelete('productCategories', null, id)
  }

  // Orders
  static async getOrders() {
    if (sqlBackend) return sqlBackend.getOrders()
    return this.commerceList<Order>('orders')
  }
  static async getOrder(id: string) {
    if (sqlBackend) return sqlBackend.getOrder(id)
    return (await this.commerceList<Order>('orders')).find(o => o.id === id) ?? null
  }
  static async createOrder(o: Omit<Order, 'id' | 'created_at' | 'updated_at'>) {
    if (sqlBackend) return sqlBackend.createOrder(o)
    return this.commerceCreate<Order>('orders', 'order', o)
  }
  static async updateOrder(id: string, updates: Partial<Order>) {
    if (sqlBackend) return sqlBackend.updateOrder(id, updates)
    return this.commerceUpdate<Order>('orders', 'order', id, updates)
  }
  /**
   * The lowdb and doc-blob half of Storage.transitionOrderStatus.
   *
   * The comparison and the write share ONE `locked()` hold, which is what
   * `setOrderStatus` did not have: it read the status in one hold, moved
   * stock in others, and wrote the status in a last one, and a second
   * request's read fitted between the first two. Here the second request
   * finds the status already moved and gets null.
   *
   * Same record, same feed entry as commerceUpdate writes for updateOrder —
   * written only when the move lands. Single-process, like every other lowdb
   * guarantee: on the doc-blob driver a second WRITING process still
   * overwrites the whole document (see libsql-adapter.ts).
   */
  static async transitionOrderStatus(
    id: string, from: OrderStatus, to: OrderStatus, guard?: OrderTransitionGuard, set?: Partial<Order>,
  ): Promise<Order | null> {
    if (sqlBackend) return sqlBackend.transitionOrderStatus(id, from, to, guard, set)
    return locked(async () => {
      await db.read()
      const rows = ((db.data as any)?.orders ?? []) as Order[]
      const idx = rows.findIndex(o => o.id === id)
      if (idx < 0) return null
      const stored = rows[idx]
      if (stored.status !== from) return null
      if (guard?.paymentStatus !== undefined && (stored.payment_status ?? null) !== guard.paymentStatus) return null
      const next: Order = { ...stored, status: to, updated_at: new Date().toISOString() }
      for (const [key, value] of Object.entries(set ?? {})) {
        if (value === undefined) delete (next as any)[key]
        else (next as any)[key] = value
      }
      rows[idx] = next
      appendChange(db.data!, 'order', id, 'update', next)
      await db.write()
      return next
    })
  }
  static async deleteOrder(id: string) {
    if (sqlBackend) return sqlBackend.deleteOrder(id)
    return this.commerceDelete('orders', 'order', id)
  }

  /** Storage.getRecentOrders. The whole document is in memory; this bounds what is handed out. */
  static async getRecentOrders(query: RecentOrdersQuery): Promise<Order[]> {
    if (sqlBackend) return sqlBackend.getRecentOrders(query)
    const atLeast = Math.max(0, Math.floor(query.atLeast ?? 0))
    const atMost = Math.max(0, Math.floor(query.atMost ?? 5000))
    return locked(async () => {
      await db.read()
      const rows = ((db.data as any)?.orders ?? []) as Order[]
      // Newest first; among equal timestamps the later-inserted first, which
      // is what "newest" means when two orders share a millisecond.
      const sorted = rows
        .map((o, i) => ({ o, i }))
        .sort((a, b) => String(b.o.created_at ?? '').localeCompare(String(a.o.created_at ?? '')) || b.i - a.i)
        .map(x => x.o)
      const recent = sorted.filter(o => String(o.created_at ?? '') >= query.since).length
      return sorted.slice(0, Math.min(atMost, Math.max(atLeast, recent)))
    })
  }

  static async getOrderByNumber(number: string): Promise<Order | null> {
    if (sqlBackend) return sqlBackend.getOrderByNumber(number)
    return (await this.commerceList<Order>('orders')).find(o => String(o.number) === number) ?? null
  }

  /**
   * The lowdb and doc-blob half of Storage.claimPaymentEvent: the ledger
   * check, the payment-status check and the write in one locked() hold.
   * Single-process, like every lowdb guarantee.
   */
  static async claimPaymentEvent(
    id: string, eventId: string, patch: Partial<Order>, opts: PaymentEventClaimOptions,
  ): Promise<PaymentEventClaim> {
    if (sqlBackend) return sqlBackend.claimPaymentEvent(id, eventId, patch, opts)
    return locked(async () => {
      await db.read()
      const rows = ((db.data as any)?.orders ?? []) as Order[]
      const idx = rows.findIndex(o => o.id === id)
      if (idx < 0) return { outcome: 'missing' } as const
      const stored = rows[idx]
      const ledger = Array.isArray(stored.payment_events) ? stored.payment_events : []
      if (eventId && ledger.includes(eventId)) return { outcome: 'duplicate' } as const
      if (opts.expectPaymentStatus !== undefined && (stored.payment_status ?? null) !== opts.expectPaymentStatus) {
        return { outcome: 'changed' } as const
      }
      const next: Order = { ...stored, ...patch, updated_at: new Date().toISOString() }
      if (eventId) {
        const events = [...ledger, eventId]
        next.payment_events = events.length > opts.history ? events.slice(-opts.history) : events
      }
      if (opts.countDecline) next.payment_declines = (Number(stored.payment_declines) || 0) + 1
      rows[idx] = next
      appendChange(db.data!, 'order', id, 'update', next)
      await db.write()
      return { outcome: 'applied', order: next } as const
    })
  }

  /** The lowdb and doc-blob half of Storage.appendRefund. */
  static async appendRefund(id: string, record: RefundRecord): Promise<RefundAppend> {
    if (sqlBackend) return sqlBackend.appendRefund(id, record)
    return locked(async () => {
      await db.read()
      const rows = ((db.data as any)?.orders ?? []) as Order[]
      const idx = rows.findIndex(o => o.id === id)
      if (idx < 0) return { outcome: 'missing' } as const
      const stored = rows[idx]
      const refunds = Array.isArray(stored.refunds) ? stored.refunds : []
      if (refunds.some(r => r?.id === record.id)) return { outcome: 'duplicate', order: stored } as const
      const nextRefunds = [...refunds, record]
      // The same arithmetic as refunds.ts's refundedTotal: malformed rows count for nothing.
      const sum = nextRefunds.reduce((s, r) => {
        const n = Number(r?.amount_cents)
        return Number.isInteger(n) && n > 0 ? s + n : s
      }, 0)
      const next: Order = {
        ...stored,
        refunds: nextRefunds,
        payment_status: sum >= (Number(stored.total_cents) || 0) ? 'refunded' : 'paid',
        updated_at: new Date().toISOString(),
      }
      rows[idx] = next
      appendChange(db.data!, 'order', id, 'update', next)
      await db.write()
      return { outcome: 'appended', order: next } as const
    })
  }

  /**
   * Idempotency records live in the document under `idempotencyKeys`, keyed
   * by the (already hashed) key. Expired entries are dropped on every claim,
   * so the map holds at most a day of keys.
   */
  static async claimIdempotencyKey(key: string, fingerprint: string, leaseMs: number): Promise<IdempotencyClaim> {
    if (sqlBackend) return sqlBackend.claimIdempotencyKey(key, fingerprint, leaseMs)
    return locked(async () => {
      await db.read()
      const data = db.data as any
      if (!data.idempotencyKeys || typeof data.idempotencyKeys !== 'object') data.idempotencyKeys = {}
      const map = data.idempotencyKeys as Record<string, IdempotencyRecord>
      const now = Date.now()
      for (const [k, rec] of Object.entries(map)) if (!(rec?.expires_at > now)) delete map[k]
      const existing = map[key]
      if (existing) {
        return existing.state === 'done'
          ? { state: 'done', fingerprint: existing.fp, response: existing.response }
          : { state: 'pending', fingerprint: existing.fp }
      }
      const token = generateId()
      map[key] = { fp: fingerprint, state: 'pending', token, expires_at: now + leaseMs }
      await db.write()
      return { state: 'claimed', token }
    })
  }

  static async completeIdempotencyKey(key: string, token: string, response: unknown, ttlMs: number): Promise<void> {
    if (sqlBackend) return sqlBackend.completeIdempotencyKey(key, token, response, ttlMs)
    await locked(async () => {
      await db.read()
      const map = (db.data as any)?.idempotencyKeys as Record<string, IdempotencyRecord> | undefined
      const rec = map?.[key]
      if (!rec || rec.token !== token) return
      map![key] = { ...rec, state: 'done', response, expires_at: Date.now() + ttlMs }
      await db.write()
    })
  }

  static async releaseIdempotencyKey(key: string, token: string): Promise<void> {
    if (sqlBackend) return sqlBackend.releaseIdempotencyKey(key, token)
    await locked(async () => {
      await db.read()
      const map = (db.data as any)?.idempotencyKeys as Record<string, IdempotencyRecord> | undefined
      const rec = map?.[key]
      if (!rec || rec.token !== token || rec.state !== 'pending') return
      delete map![key]
      await db.write()
    })
  }

  // Customers
  static async getCustomers() {
    if (sqlBackend) return sqlBackend.getCustomers()
    return this.commerceList<Customer>('customers')
  }
  static async getCustomer(id: string) {
    if (sqlBackend) return sqlBackend.getCustomer(id)
    return (await this.commerceList<Customer>('customers')).find(c => c.id === id) ?? null
  }
  static async getCustomerByEmail(email: string) {
    if (sqlBackend) return sqlBackend.getCustomerByEmail(email)
    const norm = email.trim().toLowerCase()
    return (await this.commerceList<Customer>('customers')).find(c => c.email.toLowerCase() === norm) ?? null
  }
  static async createCustomer(c: Omit<Customer, 'id' | 'created_at' | 'updated_at'>) {
    if (sqlBackend) return sqlBackend.createCustomer(c)
    return this.commerceCreate<Customer>('customers', null, c)
  }
  static async updateCustomer(id: string, updates: Partial<Customer>) {
    if (sqlBackend) return sqlBackend.updateCustomer(id, updates)
    return this.commerceUpdate<Customer>('customers', null, id, updates)
  }
  static async deleteCustomer(id: string) {
    if (sqlBackend) return sqlBackend.deleteCustomer(id)
    return this.commerceDelete('customers', null, id)
  }

  // Users
  static async getUsers() {
    if (sqlBackend) return sqlBackend.getUsers()
    return locked(async () => {
      await db.read()
      return [...(db.data?.users || [])]
    })
  }

  static async getUser(id: string) {
    if (sqlBackend) return sqlBackend.getUser(id)
    return locked(async () => {
      await db.read()
      return db.data?.users.find(user => user.id === id)
    })
  }

  static async createUser(user: Omit<User, 'id' | 'created_at' | 'updated_at'>) {
    if (sqlBackend) return sqlBackend.createUser(user)
    return locked(async () => {
      await db.read()
      const newUser: User = {
        ...user,
        id: generateId(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }
      db.data?.users.push(newUser)
      await db.write()
      return newUser
    })
  }

  static async updateUser(id: string, updates: Partial<User>) {
    if (sqlBackend) return sqlBackend.updateUser(id, updates)
    return locked(async () => {
      await db.read()
      const userIndex = db.data?.users.findIndex(user => user.id === id)
      if (userIndex !== undefined && userIndex >= 0 && db.data) {
        db.data.users[userIndex] = {
          ...db.data.users[userIndex],
          ...updates,
          updated_at: new Date().toISOString()
        }
        await db.write()
        return db.data.users[userIndex]
      }
      return null
    })
  }

  static async deleteUser(id: string) {
    if (sqlBackend) return sqlBackend.deleteUser(id)
    return locked(async () => {
      await db.read()
      if (db.data) {
        db.data.users = db.data.users.filter(user => user.id !== id)
        await db.write()
        return true
      }
      return false
    })
  }

  // Media
  static async getMedia() {
    if (sqlBackend) return sqlBackend.getMedia()
    return locked(async () => {
      await db.read()
      return [...(db.data?.media || [])]
    })
  }

  static async getMediaFile(id: string) {
    if (sqlBackend) return sqlBackend.getMediaFile(id)
    return locked(async () => {
      await db.read()
      return db.data?.media.find(media => media.id === id)
    })
  }

  static async createMediaFile(media: Omit<MediaFile, 'id' | 'created_at'>) {
    if (sqlBackend) return sqlBackend.createMediaFile(media)
    return locked(async () => {
      await db.read()
      const newMedia: MediaFile = {
        ...media,
        id: generateId(),
        created_at: new Date().toISOString()
      }
      db.data?.media.push(newMedia)
      await db.write()
      return newMedia
    })
  }

  static async updateMediaFile(id: string, updates: Partial<MediaFile>) {
    if (sqlBackend) return sqlBackend.updateMediaFile(id, updates)
    return locked(async () => {
      await db.read()
      const mediaIndex = db.data?.media.findIndex(media => media.id === id)
      if (mediaIndex !== undefined && mediaIndex >= 0 && db.data) {
        db.data.media[mediaIndex] = {
          ...db.data.media[mediaIndex],
          ...updates
        }
        await db.write()
        return db.data.media[mediaIndex]
      }
      return null
    })
  }

  static async deleteMediaFile(id: string) {
    if (sqlBackend) return sqlBackend.deleteMediaFile(id)
    return locked(async () => {
      await db.read()
      if (db.data) {
        db.data.media = db.data.media.filter(media => media.id !== id)
        await db.write()
        return true
      }
      return false
    })
  }

  // Themes
  static async getThemes() {
    if (sqlBackend) return sqlBackend.getThemes()
    return locked(async () => {
      await db.read()
      return [...(db.data?.themes || [])]
    })
  }

  static async ensureThemes(themes: Array<Pick<Theme, 'id' | 'name' | 'description' | 'version' | 'author' | 'settings'>>) {
    if (sqlBackend) return sqlBackend.ensureThemes(themes)
    return locked(async () => {
      await db.read()
      if (!db.data) return []
      const now = new Date().toISOString()
      let changed = false
      for (const t of themes) {
        if (db.data.themes.some(x => x.id === t.id)) continue
        // New rows are inactive; activation is always an explicit operator act.
        db.data.themes.push({ ...t, status: 'inactive', created_at: now } as Theme)
        changed = true
      }
      if (changed) await db.write()
      return db.data.themes
    })
  }

  static async upsertDeclarativeTheme(theme: Theme) {
    if (sqlBackend) return sqlBackend.upsertDeclarativeTheme(theme)
    return locked(async () => {
      await db.read()
      if (!db.data) return theme
      const now = new Date().toISOString()
      const i = db.data.themes.findIndex(t => t.id === theme.id)
      if (i === -1) {
        db.data.themes.push({ ...theme, status: 'inactive', created_at: now })
      } else {
        // `settings` and `status` belong to the OPERATOR. An upgrade that reset
        // their customized colours, or silently activated the theme, would be
        // the theme equivalent of overwriting someone's content.
        const prev = db.data.themes[i]
        db.data.themes[i] = { ...theme, settings: prev.settings, status: prev.status, created_at: prev.created_at }
      }
      await db.write()
      return db.data.themes.find(t => t.id === theme.id) as Theme
    })
  }

  static async deleteTheme(id: string) {
    if (sqlBackend) return sqlBackend.deleteTheme(id)
    return locked(async () => {
      await db.read()
      if (!db.data) return false
      const before = db.data.themes.length
      db.data.themes = db.data.themes.filter(t => t.id !== id)
      if (db.data.themes.length === before) return false
      await db.write()
      return true
    })
  }

  static async getActiveTheme() {
    if (sqlBackend) return sqlBackend.getActiveTheme()
    return locked(async () => {
      await db.read()
      return db.data?.themes.find(theme => theme.status === 'active')
    })
  }

  static async activateTheme(id: string) {
    if (sqlBackend) return sqlBackend.activateTheme(id)
    return locked(async () => {
      await db.read()
      if (db.data) {
        // Deactivate all themes
        db.data.themes.forEach(theme => {
          theme.status = 'inactive'
        })
        // Activate selected theme
        const theme = db.data.themes.find(t => t.id === id)
        if (theme) {
          theme.status = 'active'
          await db.write()
          return theme
        }
      }
      return null
    })
  }

  static async updateThemeSettings(id: string, settings: ThemeConfig) {
    if (sqlBackend) return sqlBackend.updateThemeSettings(id, settings)
    return locked(async () => {
      await db.read()
      const themeIndex = db.data?.themes.findIndex(theme => theme.id === id)
      if (themeIndex !== undefined && themeIndex >= 0 && db.data) {
        const oldSettings = { ...db.data.themes[themeIndex].settings }
        db.data.themes[themeIndex].settings = settings
        appendChange(db.data, 'theme', id, 'update', {
          old: oldSettings,
          new: settings
        }, ['settings'])
        await db.write()
        return db.data.themes[themeIndex]
      }
      return null
    })
  }

  // Settings
  static async getSettings() {
    return span('db.settings', async () => {
      if (sqlBackend) return sqlBackend.getSettings()
      return locked(async () => {
        await db.read()
        return [...(db.data?.settings || [])]
      })
    })
  }

  static async getSetting(key: string) {
    if (sqlBackend) return sqlBackend.getSetting(key)
    return locked(async () => {
      await db.read()
      return db.data?.settings.find(setting => setting.key === key)
    })
  }

  static async updateSetting(key: string, value: any) {
    if (sqlBackend) return sqlBackend.updateSetting(key, value)
    return locked(async () => {
      await db.read()
      const settingIndex = db.data?.settings.findIndex(setting => setting.key === key)
      if (settingIndex !== undefined && settingIndex >= 0 && db.data) {
        db.data.settings[settingIndex].value = value
        db.data.settings[settingIndex].updated_at = new Date().toISOString()
        await db.write()
        return db.data.settings[settingIndex]
      } else if (db.data) {
        // Create new setting
        const newSetting: Setting = {
          id: generateId(),
          key,
          value,
          category: 'general',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }
        db.data.settings.push(newSetting)
        await db.write()
        return newSetting
      }
      return null
    })
  }

  // Content Changes Tracking
  static async getContentChanges(since?: string) {
    if (sqlBackend) return sqlBackend.getContentChanges(since)
    return locked(async () => {
      await db.read()
      // `.slice()` FIRST. Without it, the no-`since` path sorts
      // db.data.contentChanges itself, descending — and the ring buffer at
      // appendChange() does `push(...)` then `slice(-CONTENT_CHANGE_CAP)`, which
      // is correct only oldest-first. After the reorder, the slice keeps the
      // OLDEST entries and evicts the newest.
      //
      // Harmless before the read cache (the next db.read() re-parsed); with the
      // cache adopting the same object, the reorder is what the next write
      // serialises. Matches getMessages/getSubscribers, which already slice.
      let changes = (db.data?.contentChanges || []).slice()

      // The same `since` rule as the paged read (core/change-feed.ts), so the
      // two cannot disagree about the boundary.
      const bound = normalizeChangeSince(since)
      if (bound) {
        changes = changes.filter(change => change.timestamp > bound)
      }

      // Bounded by the retention cap even if the stored array is not — a
      // document can arrive oversized from a restore, and this read should not
      // be the thing that finds out. `(timestamp, id)`, the feed's one order.
      return changes.sort(compareChangesNewestFirst).slice(0, CONTENT_CHANGE_CAP)
    })
  }

  /** One bounded page of the feed. The rule is core/change-feed.ts, verbatim. */
  static async getContentChangesPage(query: ContentChangeQuery): Promise<ContentChangePage> {
    if (sqlBackend) return sqlBackend.getContentChangesPage(query)
    return locked(async () => {
      await db.read()
      // applyChangeQuery filters into a new array before it sorts, so the
      // cached document's own array is never reordered (see above).
      return applyChangeQuery(db.data?.contentChanges || [], query, db.data?.contentChangesPruned)
    })
  }

  /**
   * How many retained change-feed entries mention this address — the export's
   * half of deleteContentChangesFor, and the same substring rule, so what the
   * export reports is exactly what an erasure would remove.
   */
  static async countContentChangesFor(email: string): Promise<number> {
    if (sqlBackend) return sqlBackend.countContentChangesFor(email)
    return locked(async () => {
      await db.read()
      const needle = email.trim().toLowerCase()
      if (!needle) return 0
      return (db.data?.contentChanges || [])
        .filter(c => JSON.stringify(c).toLowerCase().includes(needle)).length
    })
  }

  static async recordContentChange(
    entityType: 'post' | 'theme' | 'setting' | 'category' | 'user',
    entityId: string,
    action: 'create' | 'update' | 'delete',
    changes: any
  ) {
    if (sqlBackend) return sqlBackend.recordContentChange(entityType, entityId, action, changes)
    return locked(async () => {
      await db.read()
      if (db.data) {
        const contentChange = appendChange(db.data, entityType, entityId, action, changes)
        await db.write()
        return contentChange
      }
      return null
    })
  }

  static async clearContentChanges() {
    if (sqlBackend) return sqlBackend.clearContentChanges()
    return locked(async () => {
      await db.read()
      if (db.data) {
        // Recorded like any other eviction (see SqlStorage.clearContentChanges).
        db.data.contentChangesPruned = recordPrunedChanges(db.data.contentChangesPruned, db.data.contentChanges || [])
        db.data.contentChanges = []
        await db.write()
      }
    })
  }

  /**
   * Drop every change-feed snapshot that carries this address.
   *
   * The feed stores FULL entity snapshots — a just-erased order or form
   * submission still sits here with the buyer's name, email, phone and
   * address until the ring buffer evicts it. Erasure has to reach it. Matched
   * by the email appearing anywhere in the serialised snapshot, the same
   * pragmatic rule the email-log purge uses; an incidental mention of the
   * address in some other record's free text is out of scope, as it is for the
   * export.
   *
   * Not folded into `contentChangesPruned`: an erasure is not retention, and a
   * mark that moved when one customer's entries were erased would publish when
   * the erasure happened (recordPrunedChanges, core/change-feed.ts).
   */
  static async deleteContentChangesFor(email: string) {
    if (sqlBackend) return sqlBackend.deleteContentChangesFor(email)
    return locked(async () => {
      await db.read()
      if (!db.data?.contentChanges) return 0
      const needle = email.trim().toLowerCase()
      const before = db.data.contentChanges.length
      db.data.contentChanges = db.data.contentChanges.filter(
        c => !JSON.stringify(c).toLowerCase().includes(needle),
      )
      const removed = before - db.data.contentChanges.length
      if (removed > 0) await db.write()
      return removed
    })
  }

  /** Drop every webhook-delivery record whose payload carries this address. */
  static async deleteWebhookDeliveriesFor(email: string) {
    if (sqlBackend) return sqlBackend.deleteWebhookDeliveriesFor(email)
    return locked(async () => {
      await db.read()
      if (!db.data?.webhookDeliveries) return 0
      const needle = email.trim().toLowerCase()
      const before = db.data.webhookDeliveries.length
      db.data.webhookDeliveries = db.data.webhookDeliveries.filter(
        d => !JSON.stringify(d).toLowerCase().includes(needle),
      )
      const removed = before - db.data.webhookDeliveries.length
      if (removed > 0) await db.write()
      return removed
    })
  }

  // Contact messages
  static async getMessages() {
    if (sqlBackend) return sqlBackend.getMessages()
    return locked(async () => {
      await db.read()
      return (db.data?.messages || []).slice().sort((a, b) => b.created_at.localeCompare(a.created_at))
    })
  }

  static async createMessage(msg: Omit<ContactMessage, 'id' | 'created_at' | 'read'>) {
    if (sqlBackend) return sqlBackend.createMessage(msg)
    return locked(async () => {
      await db.read()
      if (!db.data) return null
      const message: ContactMessage = {
        ...msg,
        id: generateId(),
        read: false,
        created_at: new Date().toISOString(),
      }
      db.data.messages.push(message)
      // Cap stored messages to avoid unbounded growth on a spammed form.
      if (db.data.messages.length > 5000) {
        db.data.messages = db.data.messages.slice(-5000)
      }
      await db.write()
      return message
    })
  }

  static async markMessageRead(id: string, read: boolean) {
    if (sqlBackend) return sqlBackend.markMessageRead(id, read)
    return locked(async () => {
      await db.read()
      const m = db.data?.messages.find(x => x.id === id)
      if (m) {
        m.read = read
        await db.write()
        return m
      }
      return null
    })
  }

  static async deleteMessage(id: string) {
    if (sqlBackend) return sqlBackend.deleteMessage(id)
    return locked(async () => {
      await db.read()
      if (db.data) {
        db.data.messages = db.data.messages.filter(m => m.id !== id)
        await db.write()
        return true
      }
      return false
    })
  }

  // Newsletter subscribers
  static async getSubscribers() {
    if (sqlBackend) return sqlBackend.getSubscribers()
    return locked(async () => {
      await db.read()
      return (db.data?.subscribers || []).slice().sort((a, b) => b.created_at.localeCompare(a.created_at))
    })
  }

  static async createSubscriber(email: string) {
    if (sqlBackend) return sqlBackend.createSubscriber(email)
    return locked(async () => {
      await db.read()
      if (!db.data) return null
      const existing = db.data.subscribers.find(s => s.email.toLowerCase() === email.toLowerCase())
      if (existing) return existing
      const sub: Subscriber = {
        id: generateId(),
        email,
        created_at: new Date().toISOString(),
      }
      db.data.subscribers.push(sub)
      await db.write()
      return sub
    })
  }

  /**
   * Remove one subscriber.
   *
   * Added for the data-subject erasure path: a newsletter address is exactly
   * the kind of record an Article 17 request is about, and there was no way to
   * remove one from anywhere in the codebase.
   */
  static async deleteSubscriber(id: string) {
    if (sqlBackend) return sqlBackend.deleteSubscriber(id)
    return locked(async () => {
      await db.read()
      if (!db.data) return false
      const before = db.data.subscribers.length
      db.data.subscribers = db.data.subscribers.filter(s => s.id !== id)
      if (db.data.subscribers.length === before) return false
      await db.write()
      return true
    })
  }

  // Plugins (activation state persisted so it survives restarts)
  static async getPlugins() {
    if (sqlBackend) return sqlBackend.getPlugins()
    return locked(async () => {
      await db.read()
      return [...(db.data?.plugins || [])]
    })
  }

  /** Ensure a record exists for each known plugin id (default inactive). */
  static async ensurePlugins(ids: string[]) {
    if (sqlBackend) return sqlBackend.ensurePlugins(ids)
    return locked(async () => {
      await db.read()
      if (!db.data) return []
      const now = new Date().toISOString()
      let changed = false
      for (const id of ids) {
        if (!db.data.plugins.some(p => p.id === id)) {
          db.data.plugins.push({ id, active: false, settings: {}, installed_at: now, updated_at: now })
          changed = true
        }
      }
      if (changed) await db.write()
      return db.data.plugins
    })
  }

  static async setPluginActive(id: string, active: boolean) {
    if (sqlBackend) return sqlBackend.setPluginActive(id, active)
    return locked(async () => {
      await db.read()
      if (!db.data) return null
      const now = new Date().toISOString()
      let rec = db.data.plugins.find(p => p.id === id)
      if (!rec) {
        rec = { id, active, settings: {}, installed_at: now, updated_at: now }
        db.data.plugins.push(rec)
      } else {
        rec.active = active
        rec.updated_at = now
      }
      appendChange(db.data, 'plugin', id, 'update', { active }, ['active'])
      await db.write()
      return rec
    })
  }

  static async updatePluginSettings(id: string, settings: Record<string, any>) {
    if (sqlBackend) return sqlBackend.updatePluginSettings(id, settings)
    return locked(async () => {
      await db.read()
      if (!db.data) return null
      const rec = db.data.plugins.find(p => p.id === id)
      if (!rec) return null
      rec.settings = settings
      rec.updated_at = new Date().toISOString()
      await db.write()
      return rec
    })
  }

  static async deletePlugin(id: string) {
    if (sqlBackend) return sqlBackend.deletePlugin(id)
    return locked(async () => {
      await db.read()
      if (!db.data) return false
      const before = db.data.plugins.length
      db.data.plugins = db.data.plugins.filter(p => p.id !== id)
      const removed = db.data.plugins.length < before
      if (removed) await db.write()
      return removed
    })
  }

  // Custom content types (plugin-registered collections). Records live under
  // db.custom[type]; the type's field schema is enforced by the API layer.
  /* ---------- Legacy-URL recovery ---------- */

  static async getRedirects(): Promise<RedirectRule[]> {
    if (sqlBackend) return sqlBackend.getRedirects()
    return locked(async () => {
      await db.read()
      return [...(db.data?.redirects || [])]
    })
  }

  static async saveRedirect(rule: RedirectRule): Promise<RedirectRule> {
    if (sqlBackend) return sqlBackend.saveRedirect(rule)
    return locked(async () => {
      await db.read()
      if (!db.data) throw new Error('Database not initialized')
      if (!db.data.redirects) db.data.redirects = []
      const rows = db.data.redirects
      const i = rows.findIndex(r => r.id === rule.id)
      if (i >= 0) rows[i] = rule
      else rows.push(rule)
      await db.write()
      return rule
    })
  }

  static async deleteRedirect(id: string): Promise<boolean> {
    if (sqlBackend) return sqlBackend.deleteRedirect(id)
    return locked(async () => {
      await db.read()
      if (!db.data?.redirects) return false
      const before = db.data.redirects.length
      db.data.redirects = db.data.redirects.filter(r => r.id !== id)
      if (db.data.redirects.length === before) return false
      await db.write()
      return true
    })
  }

  static async getNotFound(): Promise<NotFoundRecord[]> {
    if (sqlBackend) return sqlBackend.getNotFound()
    return locked(async () => {
      await db.read()
      return [...(db.data?.notFound || [])]
    })
  }

  /**
   * Replace the whole set.
   *
   * Wholesale because the aggregation is a pure function over the previous
   * state (recordHit), and because the set is CAPPED — a partial update could
   * not express an eviction. It is at most a few hundred small rows.
   */
  static async putNotFound(records: readonly NotFoundRecord[]): Promise<void> {
    if (sqlBackend) return sqlBackend.putNotFound(records)
    return locked(async () => {
      await db.read()
      if (!db.data) throw new Error('Database not initialized')
      db.data.notFound = records.map(r => ({ ...r }))
      await db.write()
    })
  }

  /* ---------- Plugin-owned data ----------
   *
   * `ns` is "<plugin-id>:<collection>". Nothing here touches the content change
   * feed, which is what makes this safe for data a plugin does not intend to
   * publish — see PluginDataRecord.
   */

  static async getPluginData(ns: string): Promise<PluginDataRecord[]> {
    if (sqlBackend) return sqlBackend.getPluginData(ns)
    return locked(async () => {
      await db.read()
      // Copies, so a caller mutating a result cannot reach into the store.
      return (db.data?.pluginData || []).filter(r => r.ns === ns).map(r => structuredClone(r))
    })
  }

  static async getPluginDataRecord(ns: string, id: string): Promise<PluginDataRecord | undefined> {
    if (sqlBackend) return sqlBackend.getPluginDataRecord(ns, id)
    return locked(async () => {
      await db.read()
      const found = (db.data?.pluginData || []).find(r => r.ns === ns && r.id === id)
      return found ? structuredClone(found) : undefined
    })
  }

  /**
   * Upsert. One operation rather than create/update because a plugin usually
   * knows the id it wants (an order number, an external reference) and the
   * two-call version is a race between the check and the write.
   */
  static async putPluginData(ns: string, id: string, data: Record<string, unknown>): Promise<PluginDataRecord> {
    if (sqlBackend) return sqlBackend.putPluginData(ns, id, data)
    return locked(async () => {
      await db.read()
      if (!db.data) throw new Error('Database not initialized')
      if (!db.data.pluginData) db.data.pluginData = []
      const now = new Date().toISOString()
      const rows = db.data.pluginData
      const i = rows.findIndex(r => r.ns === ns && r.id === id)
      // COPY the caller's object. The relational driver round-trips through
      // JSON, so it stores a snapshot; storing the live reference here meant a
      // plugin mutating the object it just wrote silently persisted the change
      // on lowdb and libsql and lost it on relational. A difference between
      // drivers is worse than either behaviour on its own.
      const snapshot = structuredClone(data) as Record<string, unknown>
      const rec: PluginDataRecord = i >= 0
        ? { ...rows[i], data: snapshot, updated_at: now }
        : { ns, id, data: snapshot, created_at: now, updated_at: now }
      if (i >= 0) rows[i] = rec
      else rows.push(rec)
      await db.write()
      return rec
    })
  }

  static async deletePluginDataRecord(ns: string, id: string): Promise<boolean> {
    if (sqlBackend) return sqlBackend.deletePluginDataRecord(ns, id)
    return locked(async () => {
      await db.read()
      if (!db.data?.pluginData) return false
      const before = db.data.pluginData.length
      db.data.pluginData = db.data.pluginData.filter(r => !(r.ns === ns && r.id === id))
      if (db.data.pluginData.length === before) return false
      await db.write()
      return true
    })
  }

  /**
   * Drop a whole namespace, or everything a plugin owns when given a bare id.
   *
   * The prefix form is what makes uninstall complete: deleting the plugins row
   * used to leave every record the plugin had written orphaned in the database
   * with nothing able to read or remove it.
   */
  static async deletePluginData(ns: string): Promise<number> {
    if (sqlBackend) return sqlBackend.deletePluginData(ns)
    return locked(async () => {
      await db.read()
      if (!db.data?.pluginData) return 0
      const prefix = ns.includes(':') ? null : `${ns}:`
      const keep = db.data.pluginData.filter(
        r => !(r.ns === ns || (prefix !== null && r.ns.startsWith(prefix))),
      )
      const removed = db.data.pluginData.length - keep.length
      if (removed === 0) return 0
      db.data.pluginData = keep
      await db.write()
      return removed
    })
  }

  static async getCustomEntities(type: string) {
    if (sqlBackend) return sqlBackend.getCustomEntities(type)
    return locked(async () => {
      await db.read()
      return [...(db.data?.custom?.[type] ?? [])]
    })
  }

  static async getCustomEntity(type: string, id: string) {
    if (sqlBackend) return sqlBackend.getCustomEntity(type, id)
    return locked(async () => {
      await db.read()
      return db.data?.custom?.[type]?.find(e => e.id === id)
    })
  }

  static async createCustomEntity(type: string, data: Record<string, any>) {
    if (sqlBackend) return sqlBackend.createCustomEntity(type, data)
    return locked(async () => {
      await db.read()
      if (!db.data) return null
      if (!db.data.custom) db.data.custom = {}
      if (!db.data.custom[type]) db.data.custom[type] = []
      const now = new Date().toISOString()
      const entity = { id: generateId(), type, data, created_at: now, updated_at: now }
      db.data.custom[type].push(entity)
      appendChange(db.data, type, entity.id, 'create', entity)
      await db.write()
      return entity
    })
  }

  static async updateCustomEntity(type: string, id: string, data: Record<string, any>) {
    if (sqlBackend) return sqlBackend.updateCustomEntity(type, id, data)
    return locked(async () => {
      await db.read()
      const list = db.data?.custom?.[type]
      const idx = list?.findIndex(e => e.id === id)
      if (list && idx !== undefined && idx >= 0 && db.data) {
        list[idx] = { ...list[idx], data: { ...list[idx].data, ...data }, updated_at: new Date().toISOString() }
        // The entry's own fields live under `.data`, so the patch names ARE the
        // changed field names — `data` itself is not a field anybody edits.
        appendChange(db.data, type, id, 'update', list[idx], changedFieldNames(data))
        await db.write()
        return list[idx]
      }
      return null
    })
  }

  /**
   * Compare-and-set on a custom entity: apply `patch` to its data ONLY if every
   * field in `expected` still holds the value given (missing reads as null).
   * Returns the updated entity, or null when it is gone or a field has moved.
   *
   * Per driver, and the differences are the point:
   *
   *  - relational: one conditional UPDATE (SqlStorage.updateCustomEntityIf).
   *  - libSQL doc-blob: the whole document is the unit of write, and a plain
   *    write is last-write-wins across processes. So the check-and-write goes
   *    through `writeIfUnchanged`, which refuses if ANY other write landed
   *    since our read; we then re-read and decide again. A busy site writes
   *    often (views, orders), hence the retries — each one is a fresh read, so
   *    a retry that finds the field moved returns null like any other loser.
   *  - lowdb: the in-process mutex. The JSON file is single-process; the
   *    scheduler lease is what keeps a second process from sweeping at all.
   */
  static async updateCustomEntityIf(
    type: string,
    id: string,
    expected: Readonly<Record<string, string | number | null>>,
    patch: Readonly<Record<string, unknown>>,
  ) {
    if (sqlBackend) return sqlBackend.updateCustomEntityIf(type, id, expected, patch)
    const apply = (data: DatabaseSchema | null | undefined) => {
      const list = data?.custom?.[type]
      const idx = list?.findIndex(e => e.id === id) ?? -1
      if (!data || !list || idx < 0) return null
      const current = list[idx].data ?? {}
      for (const [k, v] of Object.entries(expected)) {
        if ((current[k] ?? null) !== v) return null
      }
      const cleaned = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined))
      list[idx] = { ...list[idx], data: { ...current, ...cleaned }, updated_at: new Date().toISOString() }
      appendChange(data, type, id, 'update', list[idx])
      return list[idx]
    }
    const cas = adapter as unknown as Partial<LibsqlAdapter<DatabaseSchema>>
    if (driver === 'libsql' && typeof cas.readRaw === 'function' && typeof cas.writeIfUnchanged === 'function') {
      for (let attempt = 0; attempt < 8; attempt++) {
        const outcome = await locked(async () => {
          const raw = await cas.readRaw!()
          let data: DatabaseSchema | null = null
          try { data = raw ? JSON.parse(raw) as DatabaseSchema : null } catch { data = null }
          const updated = apply(data)
          if (!updated || !data) return { done: true as const, value: null }
          if (!(await cas.writeIfUnchanged!(data, raw))) return { done: false as const }
          db.data = data
          return { done: true as const, value: updated }
        })
        if (outcome.done) return outcome.value
        await new Promise(r => setTimeout(r, 10 * (attempt + 1)))
      }
      // Could not get a clean read-and-write in. Report "not claimed": the
      // caller's next tick tries again, which is safe; a guess is not.
      return null
    }
    return locked(async () => {
      await db.read()
      const updated = apply(db.data)
      if (updated) await db.write()
      return updated
    })
  }

  static async deleteCustomEntity(type: string, id: string) {
    if (sqlBackend) return sqlBackend.deleteCustomEntity(type, id)
    return locked(async () => {
      await db.read()
      const list = db.data?.custom?.[type]
      if (list && db.data) {
        const before = list.length
        db.data.custom![type] = list.filter(e => e.id !== id)
        if (db.data.custom![type].length < before) {
          appendChange(db.data, type, id, 'delete', { id, type })
          await db.write()
          return true
        }
      }
      return false
    })
  }

  // API keys (cross-origin / headless / agent auth). Only the hash is stored.
  static async getApiKeys() {
    if (sqlBackend) return sqlBackend.getApiKeys()
    return locked(async () => {
      await db.read()
      return [...(db.data?.apiKeys ?? [])]
    })
  }

  /** Look up a key by its at-rest hash (for request authentication). */
  static async findApiKeyByHash(hash: string) {
    if (sqlBackend) return sqlBackend.findApiKeyByHash(hash)
    return locked(async () => {
      await db.read()
      return db.data?.apiKeys?.find(k => k.key_hash === hash)
    })
  }

  static async createApiKey(rec: Omit<ApiKey, 'id' | 'created_at'>) {
    if (sqlBackend) return sqlBackend.createApiKey(rec)
    return locked(async () => {
      await db.read()
      if (!db.data) return null
      if (!db.data.apiKeys) db.data.apiKeys = []
      const key: ApiKey = { ...rec, id: generateId(), created_at: new Date().toISOString() }
      db.data.apiKeys.push(key)
      await db.write()
      return key
    })
  }

  static async touchApiKey(id: string) {
    if (sqlBackend) return sqlBackend.touchApiKey(id)
    return locked(async () => {
      await db.read()
      const k = db.data?.apiKeys?.find(x => x.id === id)
      if (k) {
        k.last_used = new Date().toISOString()
        await db.write()
      }
    })
  }

  static async updateApiKey(id: string, patch: Partial<Omit<ApiKey, 'id' | 'created_at'>>) {
    if (sqlBackend) return sqlBackend.updateApiKey(id, patch)
    return locked(async () => {
      await db.read()
      const k = db.data?.apiKeys?.find(x => x.id === id)
      if (!k) return null
      // id/created_at are immutable; everything else (hash, prefix, scopes,
      // expiry, role, name, last_used) may be patched (used by key rotation).
      Object.assign(k, patch)
      await db.write()
      return k
    })
  }

  static async deleteApiKey(id: string) {
    if (sqlBackend) return sqlBackend.deleteApiKey(id)
    return locked(async () => {
      await db.read()
      if (db.data?.apiKeys) {
        const before = db.data.apiKeys.length
        db.data.apiKeys = db.data.apiKeys.filter(k => k.id !== id)
        await db.write()
        return db.data.apiKeys.length < before
      }
      return false
    })
  }

  // Webhooks (outbound event delivery)
  static async getWebhooks() {
    if (sqlBackend) return sqlBackend.getWebhooks()
    return locked(async () => {
      await db.read()
      return [...(db.data?.webhooks ?? [])]
    })
  }

  static async createWebhook(rec: Omit<Webhook, 'id' | 'created_at'>) {
    if (sqlBackend) return sqlBackend.createWebhook(rec)
    return locked(async () => {
      await db.read()
      if (!db.data) return null
      if (!db.data.webhooks) db.data.webhooks = []
      const wh: Webhook = { ...rec, id: generateId(), created_at: new Date().toISOString() }
      db.data.webhooks.push(wh)
      await db.write()
      return wh
    })
  }

  static async deleteWebhook(id: string) {
    if (sqlBackend) return sqlBackend.deleteWebhook(id)
    return locked(async () => {
      await db.read()
      if (db.data?.webhooks) {
        const before = db.data.webhooks.length
        db.data.webhooks = db.data.webhooks.filter(w => w.id !== id)
        await db.write()
        return db.data.webhooks.length < before
      }
      return false
    })
  }

  // Webhook delivery log
  static async createWebhookDelivery(rec: Omit<WebhookDelivery, 'id' | 'created_at' | 'updated_at'>) {
    if (sqlBackend) return sqlBackend.createWebhookDelivery(rec)
    return locked(async () => {
      await db.read()
      if (!db.data) return null
      if (!db.data.webhookDeliveries) db.data.webhookDeliveries = []
      const now = new Date().toISOString()
      const d: WebhookDelivery = { ...rec, id: generateId(), created_at: now, updated_at: now }
      db.data.webhookDeliveries.push(d)
      // Cap to the most recent 1000 to bound growth.
      if (db.data.webhookDeliveries.length > 1000) {
        db.data.webhookDeliveries = db.data.webhookDeliveries.slice(-1000)
      }
      await db.write()
      return d
    })
  }

  static async updateWebhookDelivery(id: string, patch: Partial<Omit<WebhookDelivery, 'id' | 'created_at'>>) {
    if (sqlBackend) return sqlBackend.updateWebhookDelivery(id, patch)
    return locked(async () => {
      await db.read()
      const d = db.data?.webhookDeliveries?.find(x => x.id === id)
      if (!d) return null
      Object.assign(d, patch, { updated_at: new Date().toISOString() })
      await db.write()
      return d
    })
  }

  static async getWebhookDelivery(id: string) {
    if (sqlBackend) return sqlBackend.getWebhookDelivery(id)
    return locked(async () => {
      await db.read()
      return db.data?.webhookDeliveries?.find(x => x.id === id)
    })
  }

  static async getWebhookDeliveries(opts?: { webhookId?: string; limit?: number }) {
    if (sqlBackend) return sqlBackend.getWebhookDeliveries(opts)
    return locked(async () => {
      await db.read()
      let list = (db.data?.webhookDeliveries ?? []).slice()
      if (opts?.webhookId) list = list.filter(d => d.webhook_id === opts.webhookId)
      list.sort((a, b) => b.created_at.localeCompare(a.created_at))
      if (opts?.limit) list = list.slice(0, opts.limit)
      return list
    })
  }

  // Security audit log
  static async createAuditEvent(rec: Omit<AuditEvent, 'id' | 'created_at'>) {
    if (sqlBackend) return sqlBackend.createAuditEvent(rec)
    return locked(async () => {
      await db.read()
      if (!db.data) return null
      if (!db.data.auditEvents) db.data.auditEvents = []
      const ev: AuditEvent = { ...rec, id: generateId(), created_at: new Date().toISOString() }
      db.data.auditEvents.push(ev)
      // Cap to the most recent 5000 to bound growth.
      if (db.data.auditEvents.length > 5000) {
        db.data.auditEvents = db.data.auditEvents.slice(-5000)
      }
      await db.write()
      return ev
    })
  }

  /* ---------- outbound email log ---------- */

  static async logEmail(rec: Omit<EmailLogEntry, 'id' | 'created_at'>) {
    if (sqlBackend) return sqlBackend.logEmail(rec)
    return locked(async () => {
      await db.read()
      if (!db.data) return null
      if (!db.data.emailLog) db.data.emailLog = []
      const entry: EmailLogEntry = { ...rec, id: generateId(), created_at: new Date().toISOString() }
      db.data.emailLog.push(entry)
      if (db.data.emailLog.length > EMAIL_LOG_CAP) {
        db.data.emailLog = db.data.emailLog.slice(-EMAIL_LOG_CAP)
      }
      await db.write()
      return entry
    })
  }

  static async getEmailLog(limit = 100) {
    if (sqlBackend) return sqlBackend.getEmailLog(limit)
    return locked(async () => {
      await db.read()
      return (db.data?.emailLog || [])
        .slice()
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, Math.max(1, Math.min(limit, EMAIL_LOG_CAP)))
    })
  }

  /** Remove every logged send to one address. Used by the erasure path. */
  static async deleteEmailLogFor(email: string) {
    if (sqlBackend) return sqlBackend.deleteEmailLogFor(email)
    return locked(async () => {
      await db.read()
      if (!db.data?.emailLog) return 0
      const before = db.data.emailLog.length
      const wanted = email.trim().toLowerCase()
      db.data.emailLog = db.data.emailLog.filter(e => String(e.to).trim().toLowerCase() !== wanted)
      const removed = before - db.data.emailLog.length
      if (removed > 0) await db.write()
      return removed
    })
  }

  /* ---------- consent receipts ---------- */

  /**
   * Record one consent decision.
   *
   * Idempotent on the receipt id: the banner may retry a failed POST, and a
   * duplicate receipt would make an audit trail that overcounts decisions.
   *
   * Capped separately from `auditEvents` on purpose. Sharing that store would
   * let a busy site's consent traffic evict its security events — the logins,
   * the API-key rotations — which is precisely backwards.
   */
  static async createConsentReceipt(rec: ConsentReceipt) {
    if (sqlBackend) return sqlBackend.createConsentReceipt(rec)
    return locked(async () => {
      await db.read()
      if (!db.data) return null
      if (!db.data.consentReceipts) db.data.consentReceipts = []
      const existing = db.data.consentReceipts.find(r => r.id === rec.id)
      if (existing) return existing
      db.data.consentReceipts.push(rec)
      if (db.data.consentReceipts.length > CONSENT_RECEIPT_CAP) {
        db.data.consentReceipts = db.data.consentReceipts.slice(-CONSENT_RECEIPT_CAP)
      }
      await db.write()
      return rec
    })
  }

  static async getConsentReceipts(limit = 100) {
    if (sqlBackend) return sqlBackend.getConsentReceipts(limit)
    return locked(async () => {
      await db.read()
      return (db.data?.consentReceipts || [])
        .slice()
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, Math.max(1, Math.min(limit, CONSENT_RECEIPT_CAP)))
    })
  }

  /** One receipt by the id a visitor is holding. */
  static async getConsentReceipt(id: string) {
    if (sqlBackend) return sqlBackend.getConsentReceipt(id)
    return locked(async () => {
      await db.read()
      return (db.data?.consentReceipts || []).find(r => r.id === id) ?? null
    })
  }

  static async getAuditEvents(opts?: AuditQuery) {
    if (sqlBackend) return sqlBackend.getAuditEvents(opts)
    return locked(async () => {
      await db.read()
      // The filter is core/audit-query.ts, not a hand-rolled copy — the
      // relational driver's SQL is asserted against this same function.
      return applyAuditQuery(db.data?.auditEvents ?? [], opts ?? {})
    })
  }

  /* ---------- post revisions ---------- */

  static async createPostRevision(rec: Omit<PostRevision, 'id' | 'created_at'>) {
    if (sqlBackend) return sqlBackend.createPostRevision(rec)
    return locked(async () => {
      await db.read()
      if (!db.data) return null
      if (!db.data.postRevisions) db.data.postRevisions = []
      const revision: PostRevision = { ...rec, id: generateId(), created_at: new Date().toISOString() }
      db.data.postRevisions.push(revision)
      await db.write()
      return revision
    })
  }

  static async getPostRevisions(postId: string, limit = 50) {
    if (sqlBackend) return sqlBackend.getPostRevisions(postId, limit)
    return locked(async () => {
      await db.read()
      const list = (db.data?.postRevisions ?? []).filter(r => r.post_id === postId)
      // Newest first. created_at is ISO, so lexicographic order is chronological;
      // ties (same-millisecond writes) fall back to insertion order reversed.
      list.sort((a, b) => b.created_at.localeCompare(a.created_at))
      return list.slice(0, Math.max(0, limit))
    })
  }

  static async getPostRevision(id: string) {
    if (sqlBackend) return sqlBackend.getPostRevision(id)
    return locked(async () => {
      await db.read()
      return (db.data?.postRevisions ?? []).find(r => r.id === id)
    })
  }

  static async prunePostRevisions(postId: string, keep: number) {
    if (sqlBackend) return sqlBackend.prunePostRevisions(postId, keep)
    return locked(async () => {
      await db.read()
      if (!db.data?.postRevisions) return 0
      const mine = db.data.postRevisions.filter(r => r.post_id === postId)
      if (mine.length <= keep) return 0
      mine.sort((a, b) => b.created_at.localeCompare(a.created_at))
      const doomed = new Set(mine.slice(Math.max(0, keep)).map(r => r.id))
      db.data.postRevisions = db.data.postRevisions.filter(r => !doomed.has(r.id))
      await db.write()
      return doomed.size
    })
  }

  static async deletePostRevisions(postId: string) {
    if (sqlBackend) return sqlBackend.deletePostRevisions(postId)
    return locked(async () => {
      await db.read()
      if (!db.data?.postRevisions) return 0
      const before = db.data.postRevisions.length
      db.data.postRevisions = db.data.postRevisions.filter(r => r.post_id !== postId)
      const removed = before - db.data.postRevisions.length
      if (removed) await db.write()
      return removed
    })
  }
}
export type {
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
  PluginRecord,
}

// Compile-time guarantee that LocalDB's static surface satisfies the Storage
// contract. If the two drift apart, this line fails the build — keeping the
// public interface and the default engine in lockstep. (LocalDB is all-static,
// so we assert on `typeof LocalDB` rather than `implements`.)
const _storageConformance: Storage = LocalDB
void _storageConformance

