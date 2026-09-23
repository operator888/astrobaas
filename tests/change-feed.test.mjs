#!/usr/bin/env node
/**
 * The content change feed: bounded, paged and pruned — on every driver.
 *
 * `GET /api/content/changes` is an anonymous public read that headless
 * storefronts poll for revalidation. It used to read the whole feed; on the
 * relational driver, which never pruned and stored a full product or order
 * snapshot on every save, that was one full-table read per anonymous request.
 * The properties asserted here are the ones that make it safe:
 *
 *   1. a history larger than the cap CANNOT come back in one request — and the
 *      default page is still the whole 1,000-entry window a storefront that
 *      has never heard of paging always received;
 *   2. paging over a store nobody is writing to has no duplicates and no gaps,
 *      and a stable order even when hundreds of changes share one timestamp;
 *   3. retention prunes — a bounded slice per write, and behind the boot, on a
 *      database created before retention existed on that driver, without
 *      holding the boot up;
 *   4. the public-visibility rules still hold, now that they are applied
 *      inside the read rather than after it;
 *   5. `meta.truncated` tells a poller its window was cut short — including by
 *      pruning DURING its walk — and never reflects a type it is not shown;
 *   6. on the relational driver, another process holding the write lock while
 *      this one boots or saves neither fails those saves nor loses them.
 *
 * The real route handler and the real storage layer are driven in a child
 * process per driver (lowdb, libSQL doc-blob, relational), seeded straight into
 * the store so the history has exactly the shape the assertions need: bigger
 * than the cap, full of ties, and mixed with types an anonymous caller must
 * never see.
 *
 * Run with:  node tests/change-feed.test.mjs
 * One driver: CHANGE_FEED_ONLY=relational node tests/change-feed.test.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTs, ROOT } from './lib/load.mjs';

const SECRET = 'SNAPSHOT-SECRET-7f3a';
const BUYER = 'buyer.cf@example.com';

/** Feed order, written out independently of core/change-feed.ts on purpose. */
const keyDesc = (a, b) => (a.timestamp === b.timestamp
  ? (a.id === b.id ? 0 : a.id > b.id ? -1 : 1)
  : a.timestamp > b.timestamp ? -1 : 1);
const keyAsc = (a, b) => -keyDesc(a, b);
/** An object with its keys sorted, so two records of evictions compare as JSON. */
const sortObj = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/**
 * Direct access to where a driver keeps the feed — to seed it, count it and
 * read it back without going through the code under test.
 */
async function openRaw(driver, env) {
  if (driver === 'lowdb') {
    const file = env.DB_PATH;
    const read = async () => JSON.parse(await fs.readFile(file, 'utf8'));
    return {
      async entries() { return (await read()).contentChanges ?? []; },
      async add(list, where = 'end') {
        const doc = await read();
        const now = doc.contentChanges ?? [];
        doc.contentChanges = where === 'start' ? [...list, ...now] : [...now, ...list];
        await fs.writeFile(file, JSON.stringify(doc));
      },
      async watermarks() { return { ...((await read()).contentChangesPruned ?? {}) }; },
      async dropWatermarks() {
        const doc = await read();
        delete doc.contentChangesPruned;
        await fs.writeFile(file, JSON.stringify(doc));
      },
      async close() {},
    };
  }
  const { createClient } = await import('@libsql/client');
  const c = createClient({ url: env.DATABASE_URL });
  if (driver === 'libsql') {
    const read = async () => JSON.parse(String((await c.execute("SELECT v FROM astrobaas_doc WHERE k = 'astrobaas'")).rows[0].v));
    return {
      async entries() { return (await read()).contentChanges ?? []; },
      async add(list, where = 'end') {
        const doc = await read();
        const now = doc.contentChanges ?? [];
        doc.contentChanges = where === 'start' ? [...list, ...now] : [...now, ...list];
        await c.execute({ sql: "UPDATE astrobaas_doc SET v = ? WHERE k = 'astrobaas'", args: [JSON.stringify(doc)] });
      },
      async watermarks() { return { ...((await read()).contentChangesPruned ?? {}) }; },
      async dropWatermarks() {
        const doc = await read();
        delete doc.contentChangesPruned;
        await c.execute({ sql: "UPDATE astrobaas_doc SET v = ? WHERE k = 'astrobaas'", args: [JSON.stringify(doc)] });
      },
      async close() { c.close(); },
    };
  }
  return {
    async entries() {
      return (await c.execute('SELECT data FROM content_changes')).rows.map((r) => JSON.parse(String(r.data)));
    },
    async add(list) {
      for (let i = 0; i < list.length; i += 500) {
        await c.batch(list.slice(i, i + 500).map((e) => ({
          sql: 'INSERT INTO content_changes (id, ts, data) VALUES (?, ?, ?)',
          args: [e.id, e.timestamp, JSON.stringify(e)],
        })), 'write');
      }
    },
    async indexes() {
      return (await c.execute("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'content_changes'"))
        .rows.map((r) => String(r.name));
    },
    async watermarks() {
      const rows = (await c.execute('SELECT entity_type, ts FROM content_changes_pruned')).rows;
      return Object.fromEntries(rows.map((r) => [String(r.entity_type), String(r.ts)]));
    },
    async dropWatermarks() { await c.execute('DROP TABLE IF EXISTS content_changes_pruned'); },
    async exec(sql) { await c.execute(sql); },
    async close() { c.close(); },
  };
}

/**
 * A change history: `n` entries in groups that share ONE timestamp — the bulk
 * import that writes hundreds of changes in a millisecond — with every kind of
 * type an anonymous caller may and may not see, each carrying a snapshot that
 * must never reach one. Returned oldest first, which is the order a real feed
 * is stored in.
 */
function makeHistory(n, { baseMs, stepMs = 500, groupSize = 10, prefix = 'h' }) {
  // Twenty slots: post ×8, product ×2, order ×2, event ×2 (public collection),
  // enquiry ×3 (a staff-only FORM), plugin ×1 (bookkeeping), mystery ×2 (a type
  // nothing registered — a collection deleted since its changes were recorded).
  const SLOTS = ['post', 'post', 'post', 'post', 'post', 'post', 'post', 'post',
    'product', 'product', 'order', 'order', 'event', 'event',
    'enquiry', 'enquiry', 'enquiry', 'plugin', 'mystery', 'mystery'];
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const type = SLOTS[i % SLOTS.length];
    out.push({
      id: crypto.randomUUID(),
      entity_type: type,
      entity_id: `${prefix}-${i}`,
      action: 'update',
      timestamp: new Date(baseMs + Math.floor(i / groupSize) * stepMs).toISOString(),
      changes: { secret: SECRET, email: BUYER, content: `<p>${SECRET}</p>` },
      fields: type === 'order' ? ['payment_status'] : ['title'],
    });
  }
  return out.sort(keyAsc);
}

/* ------------------------------------------------------------------ *
 * The lock holder: another PROCESS writing the same file database.   *
 * ------------------------------------------------------------------ */
if (process.env.CHANGE_FEED_CHILD === 'hold') {
  // BEGIN IMMEDIATE, one write, a pause, COMMIT: a second instance on the same
  // host in the middle of a save. libsql's default busy timeout (0) on purpose.
  // It exits 0 only if its own COMMIT succeeded — which a connection poisoned
  // in the OTHER process can prevent, by keeping a lock the commit must wait out.
  const { createClient } = await import('@libsql/client');
  const c = createClient({ url: process.env.DATABASE_URL });
  const tx = await c.transaction('write');
  await tx.execute('CREATE TABLE IF NOT EXISTS lock_probe (x)');
  await tx.execute('INSERT INTO lock_probe VALUES (1)');
  process.stdout.write('locked\n');
  await new Promise((r) => setTimeout(r, Number(process.env.HOLD_MS ?? 1500)));
  await tx.commit();
  c.close();
  await new Promise(() => { process.stdout.write('released\n', () => process.exit(0)); });
}

/* ------------------------------------------------------------------ *
 * The child: one driver, one database, the real route.               *
 * ------------------------------------------------------------------ */
if (process.env.CHANGE_FEED_CHILD) {
  const MODE = process.env.CHANGE_FEED_CHILD;
  const DRIVER = process.env.CHANGE_FEED_DRIVER;
  const F = await loadTs('src/core/change-feed.ts', 'cf-core');
  const { LocalDB, changeFeedUpkeep } = await loadTs('src/lib/localdb.ts', 'cf-db');
  const raw = await openRaw(DRIVER, process.env);
  /**
   * Print the result, and exit only once it has been flushed.
   *
   * `process.exit()` straight after a large `console.log` truncates a PIPED
   * stdout on macOS, and the parent then reads half a JSON line. That is how a
   * boot that failed to prune — the very thing this file exists to catch —
   * first surfaced as a crash with no ✗ line at all, instead of a failure.
   */
  const finish = (value) => new Promise(() => {
    process.stdout.write(`${JSON.stringify(value)}\n`, () => process.exit(0));
  });

  if (MODE === 'boot') {
    // Nothing but a boot, against a database the parent made look like one
    // that predates retention. The parent reads the store itself afterwards,
    // so nothing large has to cross the pipe.
    await LocalDB.init();
    // The relational backlog prune runs BEHIND the boot. The parent reads the
    // table once this process has exited, so the prune has to have finished.
    await changeFeedUpkeep();
    await raw.close();
    await finish({ booted: true });
  }

  const results = [];
  const t = (name, cond, detail = '') => results.push([name, !!cond, cond ? '' : String(detail).slice(0, 300)]);
  const firstDiff = (a, b) => {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i += 1) if (a[i] !== b[i]) return `at ${i}: got ${a[i]} expected ${b[i]} (lengths ${a.length}/${b.length})`;
    return '';
  };

  await LocalDB.init();
  // Nothing may be pruning in the background while the store is seeded by hand.
  await changeFeedUpkeep();
  // The two collections the visibility rules are about: a public FORM, which
  // anyone may submit and only staff may read, and a genuinely public one.
  await LocalDB.updateSetting('custom_content_types', [
    { name: 'enquiry', label: 'Enquiry', visibility: 'staff', writable: 'public', fields: [{ name: 'email', rule: { type: 'string' } }] },
    { name: 'event', label: 'Event', visibility: 'public', fields: [{ name: 'title', rule: { type: 'string' } }, { name: 'venue', rule: { type: 'string' } }] },
  ]);
  await LocalDB.updateSetting('commerce_enabled', true);

  const route = await loadTs('src/pages/api/content/changes.ts', 'cf-route');
  const ANON = {};
  const VIEWER = { user: { id: 'cf-viewer', role: 'viewer' } };
  const EDITOR = { user: { id: 'cf-editor', role: 'editor' } };
  const feed = async (locals, qs = '') => {
    const res = await route.GET({ url: new URL(`http://localhost/api/content/changes${qs ? `?${qs}` : ''}`), locals });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  /**
   * Follow next_cursor to the end. Bounded, so a cursor that never ends fails
   * instead of hanging. `truncs` is every page's `meta.truncated`, in order;
   * `afterPage(n)` runs after page n — a write in the middle of a walk.
   */
  const walk = async (locals, params, limit, { afterPage } = {}) => {
    const items = [];
    const sizes = [];
    const truncs = [];
    let cursor = null;
    let pages = 0;
    do {
      const qs = new URLSearchParams({ ...params, limit: String(limit) });
      if (cursor) qs.set('cursor', cursor);
      const { status, body } = await feed(locals, qs.toString());
      if (status !== 200) return { error: `status ${status}: ${JSON.stringify(body)?.slice(0, 200)}`, items, sizes, truncs };
      sizes.push(body.data.length);
      truncs.push(body.meta.truncated);
      items.push(...body.data);
      if (body.meta.has_more && !body.meta.next_cursor) return { error: 'has_more with no next_cursor', items, sizes, truncs };
      if (!body.meta.has_more && body.meta.next_cursor !== null) return { error: 'a next_cursor on the last page', items, sizes, truncs };
      cursor = body.meta.has_more ? body.meta.next_cursor : null;
      if (afterPage) await afterPage(pages);
      pages += 1;
    } while (cursor && pages < 3000);
    return { items, sizes, truncs, error: cursor ? 'the walk never ended' : '' };
  };

  // First call bootstraps the plugin registry — which reads the collection
  // definitions above — and records whatever bookkeeping a boot records.
  await feed(ANON);
  await LocalDB.clearContentChanges();

  /* ================================================================ *
   * 1. A history larger than the cap cannot come back in one request *
   * ================================================================ */
  {
    const big = makeHistory(1500, { baseMs: Date.UTC(2024, 0, 1), prefix: 'big' });
    await raw.add(big);

    // The storage layer bounds itself: no caller can ask it for more.
    const huge = await LocalDB.getContentChangesPage({ limit: 1e9, snapshots: true });
    t('storage: a page asked for 1e9 rows returns CHANGE_PAGE_MAX', huge.items.length === F.CHANGE_PAGE_MAX, huge.items.length);
    t('storage: ...and says there is more', huge.hasMore === true && huge.nextCursor !== null);
    const dflt = await LocalDB.getContentChangesPage({ snapshots: false });
    t('storage: the default page is bounded too', dflt.items.length === F.CHANGE_PAGE_DEFAULT && dflt.hasMore === true, dflt.items.length);
    const whole = await LocalDB.getContentChanges();
    t('storage: even the whole-window read is capped over an oversized store', whole.length === F.CONTENT_CHANGE_CAP, whole.length);

    // The route, as a caller would see it.
    const staff = await feed(EDITOR, 'limit=100000');
    t('route: an editor asking for 100000 gets at most CHANGE_PAGE_MAX',
      staff.status === 200 && staff.body.data.length === F.CHANGE_PAGE_MAX, `${staff.status} ${staff.body?.data?.length}`);
    const anon = await feed(ANON, 'limit=100000');
    t('route: so does an anonymous caller', anon.status === 200 && anon.body.data.length <= F.CHANGE_PAGE_MAX
      && anon.body.data.length > 0, anon.body?.data?.length);
    const bare = await feed(ANON);
    t('route: no `since` at all is a bounded page, NOT a 400',
      bare.status === 200 && bare.body.data.length > 0 && bare.body.data.length <= F.CHANGE_PAGE_DEFAULT
      && bare.body.meta.since === null, `${bare.status} ${bare.body?.data?.length}`);
    // ...and not merely bounded: the WHOLE window a storefront that never
    // heard of paging always received. Every size check above is relative to
    // the constants under test, so a default quietly shrunk to 100 passed all of
    // them. The relational store holds 1,050 visible entries here, so the
    // answer is exactly 1,000; the document stores were trimmed to 1,000, of
    // which 700 are visible.
    const visibleRetained = (await raw.entries())
      .filter((e) => ['post', 'product', 'event'].includes(e.entity_type)).length;
    t(`route: a bare anonymous poll gets every visible retained entry, up to 1,000 (${visibleRetained} visible)`,
      bare.body?.data?.length === Math.min(1000, visibleRetained), bare.body?.data?.length);
    if (DRIVER === 'relational') {
      // Nothing trims the table on a READ here, so the store really holds
      // 1,500 — and the response is still 1,000, with the rest behind a cursor.
      t('route: the relational store still holds more, and the response says so',
        staff.body.meta.has_more === true && typeof staff.body.meta.next_cursor === 'string');
    } else {
      // The document drivers run LocalDB.init() on every request, and init
      // trims an oversized document to the cap — so on these drivers the
      // oversized store did not survive the first request at all.
      t('route: the document store was trimmed to the cap by the request itself',
        (await raw.entries()).length === F.CONTENT_CHANGE_CAP, (await raw.entries()).length);
    }

    /* ---- 3a. retention on a normal write ---- */
    // Three writes. The document stores were trimmed to the cap by the first
    // request, and each write keeps them there. The relational store still
    // holds all 1,500, and one write prunes at most a bounded slice of a
    // backlog (WRITE_PRUNE_MAX, 200 — pinned by its own check in the parent):
    // 1,501 → 1,301 → 1,102 → 1,000.
    const probes = [];
    for (let i = 0; i < 3; i += 1) {
      probes.push(await LocalDB.recordContentChange('post', `retention-probe-${i}`, 'update', { probe: true }));
    }
    const kept = await raw.entries();
    t('retention: after three writes the store holds exactly CONTENT_CHANGE_CAP',
      kept.length === F.CONTENT_CHANGE_CAP, kept.length);
    const expectKept = [...probes, ...big].sort(keyDesc).slice(0, F.CONTENT_CHANGE_CAP).map((e) => e.id).sort();
    t('retention: ...and they are the NEWEST, in (timestamp, id) order',
      JSON.stringify(kept.map((e) => e.id).sort()) === JSON.stringify(expectKept),
      firstDiff(kept.map((e) => e.id).sort(), expectKept));
  }

  /* ================================================================ *
   * 2 + 4. Paging, ties, and who may see what                        *
   * ================================================================ */
  await LocalDB.clearContentChanges();
  const history = makeHistory(F.CONTENT_CHANGE_CAP, { baseMs: Date.UTC(2025, 0, 1), prefix: 'pg' });
  await raw.add(history);
  const ids = (list) => list.map((e) => e.id);
  const expectFor = (types, since) => ids(history
    .filter((e) => types.includes(e.entity_type) && (!since || e.timestamp > since))
    .sort(keyDesc));
  const ALL = ['post', 'product', 'order', 'event', 'enquiry', 'plugin', 'mystery'];
  // `order` is staff-only: its events told anyone the shop's order volume.
  const PUBLIC_SHOP_ON = ['post', 'product', 'event'];
  const PUBLIC_SHOP_OFF = ['post', 'event'];

  {
    // Seven: an odd page size, so pages end in the MIDDLE of a tie group — the
    // exact place a timestamp-only cursor skips or repeats an entry.
    const a = await walk(ANON, {}, 7);
    t('anonymous walk completes', !a.error, a.error);
    const got = ids(a.items);
    const want = expectFor(PUBLIC_SHOP_ON);
    t('anonymous walk: every visible entry exactly once, in (timestamp, id) order — no gaps, no duplicates',
      JSON.stringify(got) === JSON.stringify(want), firstDiff(got, want));
    t('...no id appears twice', new Set(got).size === got.length);
    t('...no page is larger than asked', a.sizes.every((s) => s <= 7), a.sizes.join(','));
    const again = await walk(ANON, {}, 7);
    t('...and a second walk returns the identical sequence', JSON.stringify(ids(again.items)) === JSON.stringify(got));

    const s = await walk(EDITOR, {}, 50);
    t('editor walk: every entry of every type, in order',
      !s.error && JSON.stringify(ids(s.items)) === JSON.stringify(expectFor(ALL)), s.error || firstDiff(ids(s.items), expectFor(ALL)));
    t('editor walk: snapshots are there for the editorial roles',
      s.items.length > 0 && s.items.every((i) => i.changes && i.changes.secret === SECRET));

    // `since` is exclusive, combines with the cursor, and is compared as an
    // instant. The stored timestamps alternate .000Z and .500Z, so a bound
    // written without milliseconds is where string comparison went wrong:
    // `…:50Z` sorts after `…:50.500Z` and dropped it.
    const bound = history[Math.floor(history.length / 2)].timestamp;
    const wantSince = expectFor(PUBLIC_SHOP_ON, bound);
    const w1 = await walk(ANON, { since: bound }, 9);
    t('since: exclusive, and paging stops at it',
      !w1.error && JSON.stringify(ids(w1.items)) === JSON.stringify(wantSince), w1.error || firstDiff(ids(w1.items), wantSince));
    const noMs = bound.replace(/\.000Z$/, 'Z');
    const w2 = await walk(ANON, { since: noMs }, 9);
    t(`since: "${noMs}" means the same instant as "${bound}"`,
      noMs !== bound && JSON.stringify(ids(w2.items)) === JSON.stringify(wantSince), firstDiff(ids(w2.items), wantSince));
    const offset = new Date(Date.parse(bound)).toISOString().replace(/^(\d{4}-\d{2}-\d{2})T(\d{2})/, (m, d, h) => `${d}T${String(Number(h) + 2).padStart(2, '0')}`).replace(/\.\d{3}Z$/, '+02:00');
    const w3 = await walk(ANON, { since: offset }, 9);
    t(`since: an offset form ("${offset}") is the same instant too`,
      JSON.stringify(ids(w3.items)) === JSON.stringify(wantSince), firstDiff(ids(w3.items), wantSince));
    const echo = await feed(ANON, `since=${encodeURIComponent(noMs)}&limit=1`);
    t('meta.since echoes what the caller sent', echo.body?.meta?.since === noMs, echo.body?.meta?.since);

    /* ---- what an anonymous caller must never see ---- */
    const blob = JSON.stringify(a.items);
    t('anonymous: no staff-only FORM, no bookkeeping, no unregistered type — not even an id',
      !a.items.some((i) => ['enquiry', 'plugin', 'mystery'].includes(i.entity_type)));
    t('anonymous: no snapshot key on any entry', a.items.every((i) => !('changes' in i)));
    t('anonymous: not one byte of any snapshot', !blob.includes(SECRET) && !blob.includes(BUYER));
    t('anonymous: only the allow-listed keys',
      a.items.every((i) => Object.keys(i).every((k) => ['id', 'entity_type', 'entity_id', 'action', 'timestamp', 'fields'].includes(k))));
    t('anonymous: field names for public records', a.items.filter((i) => i.entity_type === 'post').every((i) => JSON.stringify(i.fields) === '["title"]'));
    // Not even the fact that an order changed: ids and timing are the shop's
    // order volume. The seeded history holds order events, so this can fail.
    t('anonymous: NO order event at all — not even an id',
      history.some((e) => e.entity_type === 'order') && !a.items.some((i) => i.entity_type === 'order'));

    const v = await walk(VIEWER, {}, 100);
    t('a session without an editorial role is treated like anonymous',
      !v.error && JSON.stringify(ids(v.items)) === JSON.stringify(expectFor(PUBLIC_SHOP_ON))
      && v.items.every((i) => !('changes' in i)), v.error);

    await LocalDB.updateSetting('commerce_enabled', false);
    const off = await walk(ANON, {}, 13);
    t('shop switched OFF: an anonymous caller sees no product or order change',
      !off.error && JSON.stringify(ids(off.items)) === JSON.stringify(expectFor(PUBLIC_SHOP_OFF)),
      off.error || firstDiff(ids(off.items), expectFor(PUBLIC_SHOP_OFF)));
    const offStaff = await feed(EDITOR, 'limit=1000');
    t('...while staff still see them (they run the shop)',
      offStaff.body.data.some((i) => i.entity_type === 'product') && offStaff.body.data.some((i) => i.entity_type === 'order'));
    await LocalDB.updateSetting('commerce_enabled', true);

    /* ---- the cursor is a contract, not a suggestion ---- */
    const junk = await feed(ANON, 'cursor=not-a-cursor!');
    t('a malformed cursor is a 400, not a silent restart from page one', junk.status === 400, junk.status);
    const forged = Buffer.from(JSON.stringify(['yesterday', 'x'])).toString('base64url');
    const bad = await feed(ANON, `cursor=${forged}`);
    t('...and so is a well-encoded cursor with a nonsense position', bad.status === 400, bad.status);
    const clampLow = await feed(ANON, 'limit=0');
    const clampJunk = await feed(ANON, 'limit=abc');
    t('an unreadable or out-of-range limit is clamped, never refused',
      clampLow.status === 200 && clampLow.body.data.length === 1 && clampJunk.status === 200
      && clampJunk.body.data.length === Math.min(F.CHANGE_PAGE_DEFAULT, expectFor(PUBLIC_SHOP_ON).length),
      `${clampLow.body?.data?.length} ${clampJunk.body?.data?.length}`);
  }

  /* ================================================================ *
   * Field names, through every real update path                     *
   * ================================================================ */
  await LocalDB.clearContentChanges();
  {
    const post = await LocalDB.createPost({
      title: 'Feed probe', slug: `cf-probe-${Date.now()}`, content: `<p>${SECRET}</p>`, excerpt: '',
      status: 'draft', author_id: 'cf-author', category_id: null, tags: [], featured: false, views: 0,
    });
    await LocalDB.updatePost(post.id, { title: 'Feed probe 2', status: 'published', updated_at: 'ignored' });
    const product = await LocalDB.createProduct({ name: 'Probe', slug: `cf-product-${Date.now()}`, price_cents: 100, in_stock: true });
    await LocalDB.updateProduct(product.id, { stock: 3, price_cents: 200 });
    const order = await LocalDB.createOrder({ number: 'CF-1', status: 'pending', currency: 'EUR', total_cents: 100, email: BUYER, items: [] });
    await LocalDB.updateOrder(order.id, { status: 'processing', payment_status: 'paid' });
    const ev = await LocalDB.createCustomEntity('event', { title: 'Gig', venue: 'Hall' });
    await LocalDB.updateCustomEntity('event', ev.id, { venue: 'Arena' });
    await LocalDB.createCustomEntity('enquiry', { email: BUYER });
    const theme = (await LocalDB.getThemes())[0];
    await LocalDB.updateThemeSettings(theme.id, theme.settings);
    const plugin = (await LocalDB.getPlugins())[0];
    await LocalDB.setPluginActive(plugin.id, !plugin.active);
    await LocalDB.setPluginActive(plugin.id, plugin.active);

    const staff = (await feed(EDITOR, 'limit=1000')).body.data;
    const upd = (type, id) => staff.find((c) => c.entity_type === type && c.entity_id === id && c.action === 'update');
    const fieldsOf = (c) => JSON.stringify(c?.fields);
    t('post update records the fields it touched (sorted, updated_at left out)', fieldsOf(upd('post', post.id)) === '["status","title"]', fieldsOf(upd('post', post.id)));
    t('product update records its fields', fieldsOf(upd('product', product.id)) === '["price_cents","stock"]', fieldsOf(upd('product', product.id)));
    t('order update records its fields', fieldsOf(upd('order', order.id)) === '["payment_status","status"]', fieldsOf(upd('order', order.id)));
    t('custom-entity update records the DATA fields it touched', fieldsOf(upd('event', ev.id)) === '["venue"]', fieldsOf(upd('event', ev.id)));
    t('theme settings update records ["settings"]', fieldsOf(upd('theme', theme.id)) === '["settings"]', fieldsOf(upd('theme', theme.id)));
    t('plugin toggle records ["active"]', fieldsOf(upd('plugin', plugin.id)) === '["active"]', fieldsOf(upd('plugin', plugin.id)));
    t('a create records no field list — absent means unknown, not "nothing"',
      staff.filter((c) => c.action === 'create').every((c) => !('fields' in c)));

    const anon = (await feed(ANON, 'limit=1000')).body.data;
    const pub = (type, id) => anon.find((c) => c.entity_type === type && c.entity_id === id && c.action === 'update');
    t('anonymous: the post update carries its field names', fieldsOf(pub('post', post.id)) === '["status","title"]');
    t('anonymous: so does the public collection', fieldsOf(pub('event', ev.id)) === '["venue"]');
    t('anonymous: the order update is not listed at all', !!order?.id && !pub('order', order.id)
      && staff.some((c) => c.entity_type === 'order' && c.entity_id === order.id));
    t('anonymous: the form submission is not listed at all', !anon.some((c) => c.entity_type === 'enquiry'));
    t('anonymous: neither the draft body nor the buyer address appears', !JSON.stringify(anon).includes(SECRET) && !JSON.stringify(anon).includes(BUYER));
  }

  /* ================================================================ *
   * 5. meta.truncated — the one signal that a window was cut short   *
   * ================================================================ */
  {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const last = (list) => list[list.length - 1];
    /**
     * `n` raw entries all stamped NOW — after every real write so far and,
     * with a pause either side, before the next. Appended, which on the
     * document drivers is also time order.
     */
    const filler = (n, type, prefix) => {
      const ts = new Date().toISOString();
      return Array.from({ length: n }, (_, i) => ({
        id: crypto.randomUUID(), entity_type: type, entity_id: `${prefix}-${i}`, action: 'create', timestamp: ts,
        changes: { secret: SECRET },
      }));
    };
    // Every scenario starts from a cleared feed and a bound taken AFTER the
    // clear: clearing is itself recorded as an eviction, and everything it
    // evicted is older than the bound.
    const fresh = async () => {
      await LocalDB.clearContentChanges();
      await sleep(3);
      const bound = new Date().toISOString();
      await sleep(3);
      return bound;
    };

    // (a) A staff-only form that anyone may write evicts the visible entries
    // in the window. The old advice — "1,000 in total means you may have
    // overflowed" — cannot fire: the anonymous walk gets NOTHING.
    const T0 = await fresh();
    const posts = [];
    for (let i = 0; i < 20; i += 1) posts.push(await LocalDB.recordContentChange('post', `tr-${i}`, 'update', { i }));
    await sleep(3);
    const quiet = await walk(ANON, { since: T0 }, 7);
    t('truncated: false on every page of a window nothing was evicted from',
      !quiet.error && quiet.items.length === 20 && quiet.truncs.length === 3 && quiet.truncs.every((v) => v === false),
      quiet.error || `${quiet.items.length} [${quiet.truncs.join(',')}]`);
    await raw.add(filler(F.CONTENT_CHANGE_CAP - posts.length, 'enquiry', 'tr-fill'));
    await sleep(3);
    for (let i = 0; i < posts.length; i += 1) {
      await LocalDB.recordContentChange('enquiry', `tr-form-${i}`, 'create', { email: BUYER });
    }
    const gone = await walk(ANON, { since: T0 }, 7);
    t('truncated: staff-only writes evicted every post in the window, and the anonymous walk is TOLD — without being shown one enquiry',
      !gone.error && gone.items.length === 0 && last(gone.truncs) === true,
      gone.error || `${gone.items.length} [${gone.truncs.join(',')}]`);
    const staffGone = await walk(EDITOR, { since: T0 }, 500);
    t('truncated: ...and so is an editor', !staffGone.error && last(staffGone.truncs) === true,
      staffGone.error || staffGone.truncs.join(','));
    const past = await walk(ANON, { since: last(posts).timestamp }, 7);
    t('truncated: false for a window that starts at the newest eviction (since is exclusive)',
      !past.error && last(past.truncs) === false, past.error || past.truncs.join(','));

    // (b) The reverse: only the HIDDEN type is evicted. An anonymous caller
    // must not be told — that would be a count of form submissions.
    const T1 = await fresh();
    for (let i = 0; i < 20; i += 1) await LocalDB.recordContentChange('enquiry', `tr2-form-${i}`, 'create', { email: BUYER });
    await sleep(3);
    await raw.add(filler(F.CONTENT_CHANGE_CAP - 20, 'post', 'tr2-fill'));
    await sleep(3);
    for (let i = 0; i < 20; i += 1) await LocalDB.recordContentChange('post', `tr2-post-${i}`, 'update', { i });
    const anonB = await walk(ANON, { since: T1 }, 1000);
    const staffB = await walk(EDITOR, { since: T1 }, 1000);
    t('truncated: evicting a type the caller is NOT shown is not reported to it',
      !anonB.error && anonB.items.length === F.CONTENT_CHANGE_CAP && last(anonB.truncs) === false,
      anonB.error || `${anonB.items.length} [${anonB.truncs.join(',')}]`);
    t('truncated: ...while an editor, who is shown that type, is told',
      !staffB.error && staffB.items.every((i) => i.entity_type === 'post') && last(staffB.truncs) === true,
      staffB.error || staffB.truncs.join(','));

    // (c) Clearing the feed is an eviction like any other.
    await LocalDB.clearContentChanges();
    const cleared = await walk(ANON, { since: T1 }, 50);
    t('truncated: a window that reached into a cleared feed says so',
      !cleared.error && cleared.items.length === 0 && last(cleared.truncs) === true, cleared.error || cleared.truncs.join(','));

    // (d) Pruning DURING a walk. Pages walk older and retention evicts the
    // oldest, so a write mid-walk removes an entry the walk has not reached
    // yet — which only a signal evaluated on the LAST page can report.
    const T2 = await fresh();
    for (let i = 0; i < 30; i += 1) await LocalDB.recordContentChange('post', `tr3-${i}`, 'update', { i });
    await sleep(3);
    await raw.add(filler(F.CONTENT_CHANGE_CAP - 30, 'enquiry', 'tr3-fill'));
    await sleep(3);
    const calm = await walk(ANON, { since: T2 }, 7);
    t('truncated: a walk nothing happened during ends false',
      !calm.error && calm.items.length === 30 && last(calm.truncs) === false,
      calm.error || `${calm.items.length} [${calm.truncs.join(',')}]`);
    const during = await walk(ANON, { since: T2 }, 7, {
      afterPage: async (n) => {
        if (n === 0) await LocalDB.recordContentChange('enquiry', 'tr3-during', 'create', { email: BUYER });
      },
    });
    // Exactly one entry of the undisturbed walk is missing, and it is one of
    // the OLDEST: its timestamp is the earliest the walk saw. Which one of a
    // same-millisecond tie is not fixed — the document drivers evict the entry
    // appended first, the relational driver the first in `(ts, id)` order, and
    // the id is a random UUID — so the test does not name `tr3-0`.
    const earliest = calm.items.reduce((min, i) => (i.timestamp < min ? i.timestamp : min), calm.items[0]?.timestamp ?? '');
    const seen = new Set(during.items.map((i) => i.id));
    const missing = calm.items.filter((i) => !seen.has(i.id));
    t('truncated: a write during the walk evicted its oldest entry — the walk misses it, and its LAST page says so',
      !during.error && during.items.length === 29 && missing.length === 1 && missing[0].timestamp === earliest
      && during.items.every((i) => calm.items.some((c) => c.id === i.id))
      && during.truncs[0] === false && last(during.truncs) === true,
      during.error || `${during.items.length} [${during.truncs.join(',')}] missing ${missing.map((i) => `${i.entity_id}@${i.timestamp}`).join(',')} earliest ${earliest}`);
  }

  await raw.close();
  await finish({ results });
}

/* ------------------------------------------------------------------ *
 * The parent.                                                         *
 * ------------------------------------------------------------------ */
let pass = 0;
let fail = 0;
const check = (name, cond) => { if (cond) pass++; else { fail++; console.error(`✗ ${name}`); } };
const code = (src) => src.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/<!--[\s\S]*?-->/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const F = await loadTs('src/core/change-feed.ts', 'cf-spec');

/* ---------------- the spec, in isolation ---------------- */
{
  check('the retention cap is the doc drivers\' long-standing 1,000', F.CONTENT_CHANGE_CAP === 1000);
  check('no page may exceed the retention cap', F.CHANGE_PAGE_MAX <= F.CONTENT_CHANGE_CAP);
  // Pinned to the NUMBER, not to each other: every size check the drivers run
  // is relative to these constants, so a default quietly shrunk to 100 — which
  // cuts what a paging-unaware storefront receives from 1,000 to 100 — passed
  // every one of them.
  check('the default page and the largest page are both the documented 1,000',
    F.CHANGE_PAGE_DEFAULT === 1000 && F.CHANGE_PAGE_MAX === 1000);
  check('limit: absent or unreadable is the default',
    F.clampChangeLimit(undefined) === F.CHANGE_PAGE_DEFAULT && F.clampChangeLimit('abc') === F.CHANGE_PAGE_DEFAULT);
  check('limit: clamped into [1, max], never refused',
    F.clampChangeLimit('0') === 1 && F.clampChangeLimit(-5) === 1 && F.clampChangeLimit('5000') === F.CHANGE_PAGE_MAX
    && F.clampChangeLimit('7') === 7 && F.clampChangeLimit(7.9) === 7);

  check('since: a bound without milliseconds is rewritten into the stored shape',
    F.normalizeChangeSince('2026-09-11T10:00:00Z') === '2026-09-11T10:00:00.000Z');
  check('since: an offset is converted to the same instant in UTC',
    F.normalizeChangeSince('2026-09-11T12:00:00+02:00') === '2026-09-11T10:00:00.000Z');
  check('since: an unreadable value is passed through as before, not refused',
    F.normalizeChangeSince('garbage') === 'garbage' && F.normalizeChangeSince('') === undefined && F.normalizeChangeSince(null) === undefined);
  {
    // A date-time with no zone designator is UTC — whatever the HOST's zone.
    // Date.parse reads that form as local time, so in New York the bound moved
    // four hours later and dropped every change in between. `localProbe`
    // proves the zone really changed; without it this passes vacuously on a
    // machine that runs in UTC.
    const hadTz = Object.prototype.hasOwnProperty.call(process.env, 'TZ');
    const oldTz = process.env.TZ;
    process.env.TZ = 'America/New_York';
    const localProbe = new Date(2026, 8, 11, 10).toISOString();
    const forms = ['2026-09-11T10:00:00', '2026-09-11T10:00', '2026-09-11 10:00:00', '2026-09-11t10:00:00'];
    const got = forms.map((s) => F.normalizeChangeSince(s));
    if (hadTz) process.env.TZ = oldTz; else delete process.env.TZ;
    check(`since: a date-time with no zone is read as UTC, not as the host's local time (${got.join(' ')})`,
      localProbe === '2026-09-11T14:00:00.000Z' && got.every((g) => g === '2026-09-11T10:00:00.000Z'));
  }

  {
    const W = '2026-09-11T10:00:00.500Z';
    check('truncated: nothing evicted is never truncated',
      F.isChangeWindowTruncated(null, undefined) === false && F.isChangeWindowTruncated(null, '2020-01-01T00:00:00Z') === false);
    check('truncated: any eviction truncates a window with no lower bound',
      F.isChangeWindowTruncated(W, undefined) === true && F.isChangeWindowTruncated(W, '') === true);
    check('truncated: an eviction after `since` truncates; one at or before it does not (since is exclusive)',
      F.isChangeWindowTruncated(W, '2026-09-11T10:00:00.499Z') === true
      && F.isChangeWindowTruncated(W, W) === false
      && F.isChangeWindowTruncated(W, '2026-09-11T10:00:01Z') === false);
    // `…T10:00:00Z` sorts AFTER `…T10:00:00.500Z` as a string; as an instant
    // it is half a second before it. The bound is the instant the store uses.
    check('truncated: the bound is compared the way the store compares it, whatever form it came in',
      F.isChangeWindowTruncated(W, '2026-09-11T10:00:00Z') === true
      && F.isChangeWindowTruncated(W, '2026-09-11T12:00:00+02:00') === true
      && F.isChangeWindowTruncated(W, '2026-09-11T12:00:00.600+02:00') === false);

    const ev = [
      { id: 'a', entity_type: 'post', timestamp: '2026-01-01T00:00:01.000Z' },
      { id: 'b', entity_type: 'post', timestamp: '2026-01-01T00:00:03.000Z' },
      { id: 'c', entity_type: 'enquiry', timestamp: '2026-01-01T00:00:05.000Z' },
      { id: 'd', entity_type: '__proto__', timestamp: '2026-01-01T00:00:02.000Z' },
    ];
    const prior = { post: '2026-01-01T00:00:02.000Z', event: '2025-12-31T00:00:00.000Z' };
    const marks = F.recordPrunedChanges(prior, ev);
    check('watermarks: the newest eviction per type — a mark never moves backwards, and the input is left alone',
      marks.post === '2026-01-01T00:00:03.000Z' && marks.enquiry === '2026-01-01T00:00:05.000Z'
      && marks.event === '2025-12-31T00:00:00.000Z' && prior.post === '2026-01-01T00:00:02.000Z'
      && F.recordPrunedChanges({ post: '2026-01-01T00:00:09.000Z' }, ev).post === '2026-01-01T00:00:09.000Z');
    const reread = JSON.parse(JSON.stringify(marks));
    check('watermarks: a type called __proto__ is recorded like any other, and survives the JSON file',
      Object.prototype.hasOwnProperty.call(marks, '__proto__') && marks['__proto__'] === '2026-01-01T00:00:02.000Z'
      && F.prunedThroughFor(reread, ['__proto__']) === '2026-01-01T00:00:02.000Z');
    check('prunedThrough: the newest eviction among the types asked for — and only those',
      F.prunedThroughFor(marks, ['post', 'event']) === '2026-01-01T00:00:03.000Z'
      && F.prunedThroughFor(marks, null) === '2026-01-01T00:00:05.000Z'
      && F.prunedThroughFor(marks, ['product']) === null && F.prunedThroughFor(marks, []) === null
      && F.prunedThroughFor(undefined, null) === null);
    check('prunedThrough: a mark that is not a string (a hand-edited document) is ignored',
      F.prunedThroughFor({ post: 5, event: '2026-01-01T00:00:00.000Z' }, null) === '2026-01-01T00:00:00.000Z');
  }

  const cur = { ts: '2026-09-11T10:00:00.123Z', id: '6b1f0c52-9d7e-4c3b-8a55-0f2b8e9d1a77' };
  const enc = F.encodeChangeCursor(cur);
  check('cursor: opaque and URL-safe', /^[A-Za-z0-9_-]+$/.test(enc) && !enc.includes(cur.id));
  check('cursor: round-trips', JSON.stringify(F.decodeChangeCursor(enc)) === JSON.stringify(cur));
  const b64 = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
  const rejected = ['', 'x', '!!!', 'a'.repeat(600), b64('["a"]'), b64([1, 2]), b64(['not a date', 'id']), b64([cur.ts, '']), b64('{"ts":1}'), b64('not json')];
  check('cursor: anything this module did not write decodes to null, never throws',
    rejected.every((r) => F.decodeChangeCursor(r) === null));

  check('fields: the patch keys, sorted, without updated_at and id',
    JSON.stringify(F.changedFieldNames({ b: 1, a: 2, updated_at: 3, id: 4 })) === '["a","b"]');
  check('fields: not a plain object means unknown',
    F.changedFieldNames(null) === undefined && F.changedFieldNames([1]) === undefined && F.changedFieldNames('x') === undefined);
  const wide = Object.fromEntries(Array.from({ length: F.MAX_CHANGE_FIELDS + 1 }, (_, i) => [`f${i}`, i]));
  check('fields: a patch too wide to list honestly is unknown, not truncated', F.changedFieldNames(wide) === undefined);

  // The in-memory implementation — the document drivers' whole read.
  const base = Date.UTC(2026, 0, 1);
  const list = Array.from({ length: 60 }, (_, i) => ({
    id: crypto.randomUUID(), entity_type: i % 3 ? 'post' : 'enquiry', entity_id: `x${i}`, action: 'update',
    timestamp: new Date(base + Math.floor(i / 12) * 1000).toISOString(), changes: { secret: SECRET },
  }));
  const before = list.map((e) => e.id).join();
  const walked = [];
  let cursor;
  let guard = 0;
  do {
    const page = F.applyChangeQuery(list, { limit: 5, before: cursor, types: ['post'] });
    walked.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor && ++guard < 100);
  const want = list.filter((e) => e.entity_type === 'post').sort(keyDesc).map((e) => e.id);
  check('applyChangeQuery: paging over ties is exact', JSON.stringify(walked.map((e) => e.id)) === JSON.stringify(want));
  check('applyChangeQuery: a metadata page carries no snapshot', walked.every((e) => !('changes' in e)));
  check('applyChangeQuery: never reorders the array it was given (the ring depends on it)',
    list.map((e) => e.id).join() === before);
  const many = Array.from({ length: 2500 }, (_, i) => ({ ...list[0], id: `m${i}` }));
  check('applyChangeQuery: a caller cannot ask it for more than the maximum',
    F.applyChangeQuery(many, { limit: 1e9 }).items.length === F.CHANGE_PAGE_MAX);
  const evictedMarks = { post: '2026-01-01T00:00:03.000Z', enquiry: '2026-01-01T00:00:05.000Z' };
  check('applyChangeQuery: prunedThrough is read for the query\'s own types',
    F.applyChangeQuery(list, { types: ['post'] }, evictedMarks).prunedThrough === '2026-01-01T00:00:03.000Z'
    && F.applyChangeQuery(list, {}, evictedMarks).prunedThrough === '2026-01-01T00:00:05.000Z'
    && F.applyChangeQuery(list, {}).prunedThrough === null);
}

/* ---------------- every caller reads a bounded slice ---------------- */
{
  const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
  const dashboard = code(read('src/pages/admin/index.astro'));
  check('the dashboard reads a bounded page, metadata only',
    /getContentChangesPage\(\{[^}]*limit:\s*\d+[^}]*snapshots:\s*false/.test(dashboard));

  // List-free: whatever file calls the whole-window read tomorrow is caught.
  // Only the storage layer itself may; the feed, the dashboard and the GDPR
  // export all have bounded alternatives.
  const ALLOWED = new Set([
    path.join('src', 'core', 'storage.ts'),
    path.join('src', 'lib', 'localdb.ts'),
    path.join('src', 'lib', 'storage', 'sql-storage.ts'),
  ]);
  const offenders = [];
  const walkDir = function* (dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) yield* walkDir(p);
      else yield p;
    }
  };
  for (const f of walkDir(path.join(ROOT, 'src'))) {
    if (!/\.(ts|astro)$/.test(f)) continue;
    const rel = path.relative(ROOT, f);
    if (ALLOWED.has(rel)) continue;
    if (/\bgetContentChanges\s*\(/.test(code(read(rel)))) offenders.push(rel);
  }
  check(`nothing outside the storage layer reads the whole feed${offenders.length ? ` (${offenders.join(', ')})` : ''}`,
    offenders.length === 0);

  const routeSrc = code(read('src/pages/api/content/changes.ts'));
  // The storage read is where the snapshot is left behind; the projection in
  // the route is the second lock. Both, so neither alone is load-bearing.
  check('the route asks storage for snapshots ONLY for the editorial roles', /snapshots:\s*editorial\b/.test(routeSrc));
  check('...and pushes the public allow-list into the read', /types:\s*editorial\s*\?\s*undefined\s*:\s*publicChangeTypes\(/.test(routeSrc));
}

/* ---------------- relational: the snapshot never leaves SQLite ---------------- */
const tmpRoot = path.join(os.tmpdir(), `astrobaas-change-feed-test-${process.pid}`);
await fs.mkdir(tmpRoot, { recursive: true });
{
  const { SqlStorage } = await loadTs('src/lib/storage/sql-storage.ts', 'cf-sql');
  const url = `file:${path.join(tmpRoot, 'strip.sqlite')}`;
  const s = new SqlStorage(url);
  await s.init();
  // The (ts, id) index is built by the background upkeep; the query plan
  // check below needs it to be there.
  await s.changeFeedUpkeep;
  for (let i = 0; i < 20; i += 1) {
    await s.recordContentChange('post', `strip-${i}`, 'update', { content: 'X'.repeat(20000), secret: SECRET });
  }
  const seen = [];
  const original = s.client.execute.bind(s.client);
  s.client.execute = async (stmt) => {
    const res = await original(stmt);
    seen.push({
      sql: typeof stmt === 'string' ? stmt : stmt.sql, args: stmt.args ?? [], columns: res.columns,
      rows: res.rows.length, bytes: JSON.stringify(res.rows).length,
    });
    return res;
  };
  const meta = await s.getContentChangesPage({ limit: 5, snapshots: false, types: ['post'] });
  const metaSelect = seen.filter((x) => /^\s*SELECT\b[\s\S]*\bFROM content_changes\b/i.test(x.sql));
  check('relational: a metadata page is ONE select', metaSelect.length === 1);
  // The LIMIT is in the SQL, not just in the slice afterwards: the page is
  // built by reading one extra row, so a query that read the table and let
  // JavaScript trim it would return the same five items — and the whole
  // table's worth of rows, which is the bug.
  check(`relational: ...that reads limit + 1 rows, not the table (${metaSelect[0]?.rows})`, metaSelect[0]?.rows === 6);
  check('relational: ...and never selects the snapshot column', metaSelect.length === 1 && !metaSelect[0].columns.includes('data'));
  check('relational: ...so no snapshot bytes cross the wire', metaSelect[0]?.bytes < 4000 && !JSON.stringify(meta).includes(SECRET));
  check('relational: ...and the page still has its five entries', meta.items.length === 5 && meta.items.every((i) => i.entity_type === 'post'));

  const pageSql = metaSelect[0];
  seen.length = 0;
  const full = await s.getContentChangesPage({ limit: 5, snapshots: true });
  check('relational: the editorial page DOES select it (so the check above can fail)',
    seen.some((x) => x.columns.includes('data')) && JSON.stringify(full).includes(SECRET));
  s.client.execute = original;

  // The index the page is read through. A separate connection: EXPLAIN leaves
  // a statement open on the one it runs on.
  const { createClient } = await import('@libsql/client');
  const probe = createClient({ url });
  const plan = (await probe.execute({ sql: `EXPLAIN QUERY PLAN ${pageSql.sql}`, args: pageSql.args })).rows.map((r) => String(r.detail)).join(' | ');
  probe.close();
  check(`relational: the page is served by the (ts, id) index with no sort step (${plan})`,
    /idx_changes_ts_id/.test(plan) && !/TEMP B-TREE/.test(plan));

  // The order must be total in the SQL ITSELF, not an accident of the scan.
  // With the (ts, id) index in place SQLite walks it backwards and hands ties
  // back in id order whether or not the ORDER BY says so — so a query that had
  // lost its tie-break passed every check in this file. Without the index it
  // has to SORT, and then only the declared tie-break decides which of two
  // equal timestamps comes first. The rows go in in ascending id order, the
  // opposite of the answer, so insertion order cannot pass for it either.
  {
    const tiesUrl = `file:${path.join(tmpRoot, 'ties.sqlite')}`;
    const ties = new SqlStorage(tiesUrl);
    await ties.init();
    // Finished before the index is dropped, or the upkeep builds it again
    // behind this check's back and the SORT it exists to force never happens.
    await ties.changeFeedUpkeep;
    const rows = Array.from({ length: 60 }, (_, i) => ({
      id: crypto.randomUUID(), entity_type: 'post', entity_id: `tie-${i}`, action: 'update',
      timestamp: new Date(Date.UTC(2026, 1, 1) + Math.floor(i / 10) * 1000).toISOString(),
    }));
    const direct = createClient({ url: tiesUrl });
    await direct.execute('DROP INDEX IF EXISTS idx_changes_ts_id');
    await direct.batch([...rows].sort((a, b) => (a.id < b.id ? -1 : 1)).map((r) => ({
      sql: 'INSERT INTO content_changes (id, ts, data) VALUES (?, ?, ?)', args: [r.id, r.timestamp, JSON.stringify(r)],
    })), 'write');
    direct.close();
    const walked = [];
    let before;
    let guard = 0;
    do {
      const page = await ties.getContentChangesPage({ limit: 4, before });
      walked.push(...page.items.map((i) => i.id));
      before = page.nextCursor ?? undefined;
    } while (before && ++guard < 100);
    const want = [...rows].sort(keyDesc).map((r) => r.id);
    check('relational: ties come back in id order even when SQLite has to SORT — the tie-break is in the SQL',
      JSON.stringify(walked) === JSON.stringify(want));
  }

  const countRows = async (client) => Number((await client.execute('SELECT count(*) AS n FROM content_changes')).rows[0].n);
  const seedRows = async (client, list) => {
    for (let i = 0; i < list.length; i += 500) {
      await client.batch(list.slice(i, i + 500).map((e) => ({
        sql: 'INSERT INTO content_changes (id, ts, data) VALUES (?, ?, ?)', args: [e.id, e.timestamp, JSON.stringify(e)],
      })), 'write');
    }
  };
  const readMarks = async (client) => Object.fromEntries((await client.execute('SELECT entity_type, ts FROM content_changes_pruned'))
    .rows.map((r) => [String(r.entity_type), String(r.ts)]));
  /** A database this build created, then made to look like one that predates retention: a backlog and the `ts` index. */
  const legacyDb = async (name, rows) => {
    const file = path.join(tmpRoot, name);
    const dbUrl = `file:${file}`;
    const s0 = new SqlStorage(dbUrl);
    await s0.init();
    await s0.changeFeedUpkeep;
    s0.client.close();
    const direct = createClient({ url: dbUrl });
    await direct.execute('DROP INDEX IF EXISTS idx_changes_ts_id');
    await direct.execute('CREATE INDEX IF NOT EXISTS idx_changes_ts ON content_changes (ts)');
    await seedRows(direct, makeHistory(rows, { baseMs: Date.UTC(2023, 0, 1), prefix: name }));
    return { file, url: dbUrl, direct };
  };

  /* ---- the backlog prune runs BEHIND the boot, and the index is built after it ---- */
  {
    const { url: dbUrl, direct } = await legacyDb('upkeep.sqlite', 5000);
    const up = new SqlStorage(dbUrl);
    // Every time the index statement runs, how many rows it would index. ALL
    // of them, not the last: an index built at boot and then "again" (IF NOT
    // EXISTS) after the prune would otherwise report the second, harmless one.
    const rowsWhenIndexed = [];
    const exec = up.client.execute.bind(up.client);
    up.client.execute = async (stmt) => {
      const sql = typeof stmt === 'string' ? stmt : stmt.sql;
      if (/CREATE INDEX IF NOT EXISTS idx_changes_ts_id/.test(sql)) rowsWhenIndexed.push(await countRows(direct));
      return exec(stmt);
    };
    await up.init();
    const atReady = await countRows(direct);
    const served = await up.getContentChangesPage({ limit: 5 });
    const afterRead = await countRows(direct);
    // An HTTP request arrives as an I/O callback — a macrotask. A prune that
    // only ever awaited promises would run to the end before any macrotask,
    // which is the frozen boot all over again, just later.
    let upkeepDone = false;
    up.changeFeedUpkeep.then(() => { upkeepDone = true; });
    const macrotaskRanDuring = await new Promise((resolve) => setImmediate(() => resolve(!upkeepDone)));
    await up.changeFeedUpkeep;
    const settled = await countRows(direct);
    up.client.execute = exec;
    check(`relational: boot does not wait for the backlog prune — ready, and a read served, while it runs (${atReady}, ${afterRead})`,
      atReady > F.CONTENT_CHANGE_CAP && afterRead > F.CONTENT_CHANGE_CAP && served.items.length === 5);
    check('relational: ...and it yields to the event loop between steps, so a macrotask runs while it is in progress', macrotaskRanDuring);
    check(`relational: ...which then finishes in the background (${settled})`, settled === F.CONTENT_CHANGE_CAP);
    check(`relational: the (ts, id) index is built AFTER the prune, over at most the cap (${rowsWhenIndexed.join(', ') || 'never built'} rows)`,
      rowsWhenIndexed.length > 0 && Math.max(...rowsWhenIndexed) <= F.CONTENT_CHANGE_CAP);
    direct.close();
    up.client.close();
  }

  /* ---- one write prunes a bounded slice of a backlog, and records it ---- */
  {
    // A backlog the background prune never dealt with — stubbed out, as if it
    // had failed. One save must not become the backlog's whole cleanup: that
    // was 99,001 rows deleted inside a single save, with the process frozen.
    const dbUrl = `file:${path.join(tmpRoot, 'write-prune.sqlite')}`;
    const wp = new SqlStorage(dbUrl);
    wp.pruneExistingChanges = async () => {};
    await wp.init();
    await wp.changeFeedUpkeep;
    const direct = createClient({ url: dbUrl });
    const backlog = makeHistory(5000, { baseMs: Date.UTC(2023, 0, 1), prefix: 'wp' });
    // ...and, oldest of all, a type that appears NOWHERE in the slice one write
    // deletes. Every other type recurs every twenty rows, so it is in any slice
    // and a record taken over MORE than the slice — everything over the cap,
    // say — would come out the same for it. This one would not.
    const relics = Array.from({ length: 100 }, (_, i) => ({
      id: crypto.randomUUID(), entity_type: 'relic', entity_id: `relic-${i}`, action: 'update',
      timestamp: new Date(Date.UTC(2022, 0, 1) + i * 1000).toISOString(), changes: {},
    }));
    await seedRows(direct, [...relics, ...backlog]);
    const probe = await wp.recordContentChange('post', 'bounded-write', 'update', {});
    const total = relics.length + backlog.length + 1;
    const n = await countRows(direct);
    check(`relational: one write prunes at most a bounded slice of a backlog (${total} → ${n})`, n >= total - 200 && n < total);
    // ...and records exactly what it took: per type, the newest of the rows it
    // deleted. Those are the rows just past the cap in feed order — the prune
    // walks the index down from the newest — not the oldest in the table.
    const removed = total - n;
    const expectMarks = {};
    for (const e of [probe, ...backlog, ...relics].sort(keyDesc).slice(F.CONTENT_CHANGE_CAP, F.CONTENT_CHANGE_CAP + removed)) {
      if (!expectMarks[e.entity_type] || e.timestamp > expectMarks[e.entity_type]) expectMarks[e.entity_type] = e.timestamp;
    }
    const marks = await readMarks(direct);
    check(`relational: ...and records, per type, the newest of exactly the rows it deleted — nothing for rows it left (${Object.keys(marks).sort().join(',')})`,
      Object.keys(expectMarks).length > 0 && !('relic' in marks)
      && JSON.stringify(sortObj(marks)) === JSON.stringify(sortObj(expectMarks)));
    direct.close();
    wp.client.close();
  }

  /* ---- another PROCESS holding the write lock ---- */
  /** Start a process that holds the write lock on `file`; resolves once it holds it. */
  const holdLock = (file, ms) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
      cwd: ROOT,
      env: { ...process.env, CHANGE_FEED_CHILD: 'hold', DATABASE_URL: `file:${file}`, HOLD_MS: String(ms) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const exited = new Promise((done) => child.on('exit', (code) => done({ code, err })));
    child.stdout.on('data', (d) => { out += d; if (out.includes('locked')) resolve({ exited }); });
    child.stderr.on('data', (d) => { err += d; });
    child.on('exit', (exitCode) => {
      if (!out.includes('locked')) reject(new Error(`the lock holder exited (${exitCode}) before locking: ${err.slice(-300)}`));
    });
  });
  /** Is the post with this slug visible from a SEPARATE connection — durable, not just "returned ok"? */
  const durable = async (dbUrl, slug) => {
    const other = createClient({ url: dbUrl });
    try {
      const res = await other.execute({ sql: "SELECT count(*) AS n FROM posts WHERE json_extract(data, '$.slug') = ?", args: [slug] });
      return Number(res.rows[0].n) === 1;
    } finally {
      other.close();
    }
  };
  const trySave = async (store, slug) => {
    try {
      await store.createPost({
        title: 'Lock probe', slug, content: '<p>x</p>', excerpt: '', status: 'draft', author_id: 'cf-author',
        category_id: null, tags: [], featured: false, views: 0,
      });
      return 'ok';
    } catch (e) {
      return `FAILED ${e?.code ?? e?.message}`;
    }
  };
  /** Run `fn` with console.error captured; return what it logged. */
  const capturingErrors = async (fn) => {
    const logged = [];
    const original = console.error;
    console.error = (...args) => { logged.push(args.map((a) => a?.code ?? String(a)).join(' ')); };
    try { await fn(); } finally { console.error = original; }
    return logged;
  };
  /** A database this build created and left at the cap: every boot but the first after an upgrade. */
  const steadyDb = async (name) => {
    const file = path.join(tmpRoot, name);
    const dbUrl = `file:${file}`;
    const s0 = new SqlStorage(dbUrl);
    await s0.init();
    await s0.changeFeedUpkeep;
    for (let i = 0; i < 1200; i += 1) await s0.recordContentChange('post', `steady-${i}`, 'update', { i });
    s0.client.close();
    return { file, url: dbUrl };
  };

  {
    // A save that meets another process's lock WAITS for it. libsql's default
    // busy timeout is 0: it failed on the spot.
    const { file, url: dbUrl } = await steadyDb('busy-wait.sqlite');
    const st = new SqlStorage(dbUrl);
    await st.init();
    await st.changeFeedUpkeep;
    const holder = await holdLock(file, 800);
    const saved = await trySave(st, 'busy-wait-probe');
    const held = await holder.exited;
    check(`relational: a save made while another process holds the write lock waits for it, not fails (${saved}, holder exit ${held.code})`,
      saved === 'ok' && held.code === 0 && await durable(dbUrl, 'busy-wait-probe'));
    st.client.close();
  }

  {
    // A database already at the cap asks for NO write lock at boot. Booted with
    // no busy timeout at all, so any write it tried while the other process
    // holds the lock would fail — and the upkeep would log it.
    const { file, url: dbUrl } = await steadyDb('busy-steady.sqlite');
    const holder = await holdLock(file, 1200);
    const st = new SqlStorage(dbUrl, undefined, { busyTimeoutMs: 0 });
    let bootError = null;
    const logged = await capturingErrors(async () => {
      try { await st.getPosts(); await st.changeFeedUpkeep; } catch (e) { bootError = e?.code ?? String(e); }
    });
    const held = await holder.exited;
    const saved = await trySave(st, 'busy-steady-probe');
    check(`relational: booting a steady-state database while another process writes asks for no write lock (${bootError ?? 'no error'}; logged: ${logged.join(' | ') || 'nothing'})`,
      bootError === null && logged.length === 0 && held.code === 0);
    check(`relational: ...and a save after it is durable (${saved})`, saved === 'ok' && await durable(dbUrl, 'busy-steady-probe'));
    st.client.close();
  }

  {
    // When a statement DOES fail against the lock, the connection it ran on is
    // dropped instead of handed to the next save. A backlog makes the boot
    // prune write; with no busy timeout that write fails.
    const { file, url: dbUrl, direct } = await legacyDb('busy-backlog.sqlite', 1500);
    direct.close();
    const holder = await holdLock(file, 1200);
    const st = new SqlStorage(dbUrl, undefined, { busyTimeoutMs: 0 });
    let bootError = null;
    const logged = await capturingErrors(async () => {
      try { await st.getPosts(); await st.changeFeedUpkeep; } catch (e) { bootError = e?.code ?? String(e); }
    });
    const held = await holder.exited;
    const saved = await trySave(st, 'busy-backlog-probe');
    check(`relational: a boot prune that fails against the lock is logged and swallowed, not a failed boot (${bootError ?? 'no error'}; ${logged.length} logged)`,
      bootError === null && logged.some((l) => l.includes('SQLITE_BUSY')));
    check(`relational: ...and a save made afterwards is DURABLE — not lost on a poisoned connection (${saved}, holder exit ${held.code})`,
      held.code === 0 && saved === 'ok' && await durable(dbUrl, 'busy-backlog-probe'));
    st.client.close();
  }

  {
    // A failed BOOT is not memoized. The first boot after this upgrade is the
    // one with DDL to write (content_changes_pruned); with no busy timeout it
    // fails against the lock — and the next call must boot again, not replay
    // that failure to every call until a restart.
    const { file, url: dbUrl, direct } = await legacyDb('busy-ddl.sqlite', 10);
    await direct.execute('DROP TABLE IF EXISTS content_changes_pruned');
    direct.close();
    const holder = await holdLock(file, 1200);
    const st = new SqlStorage(dbUrl, undefined, { busyTimeoutMs: 0 });
    let first = 'resolved';
    try { await st.getPosts(); } catch (e) { first = e?.code ?? String(e); }
    const held = await holder.exited;
    let second = 'resolved';
    try { await st.getPosts(); } catch (e) { second = e?.code ?? String(e); }
    const saved = await trySave(st, 'busy-ddl-probe');
    check(`relational: a boot that meets the lock with DDL to write fails (${first})`, first !== 'resolved');
    check(`relational: ...and the NEXT call boots again instead of replaying that failure (${second})`, second === 'resolved');
    check(`relational: ...and its saves are durable (${saved}, holder exit ${held.code})`,
      saved === 'ok' && held.code === 0 && await durable(dbUrl, 'busy-ddl-probe'));
    st.client.close();
  }

  {
    // A statement the one-connection pool REFUSES never reached SQLite, so it
    // poisoned nothing. Dropping the connections for it closed the transaction
    // holding that connection under whoever had opened it.
    const { url: dbUrl } = await steadyDb('refused.sqlite');
    const st = new SqlStorage(dbUrl);
    const tx = await st.client.transaction('write');
    let first = 'resolved';
    try { await st.getPosts(); } catch (e) { first = e?.code ?? String(e); }
    let committed = 'ok';
    try {
      await tx.execute("INSERT INTO settings (id, data) VALUES ('refused-probe', '{}')");
      await tx.commit();
    } catch (e) { committed = e?.code ?? String(e); }
    let second = 'resolved';
    try { await st.getPosts(); } catch (e) { second = e?.code ?? String(e); }
    check(`relational: a boot the one-connection pool refuses (${first}) leaves the transaction that holds the connection usable (${committed})`,
      first === 'TRANSACTION_ACTIVE' && committed === 'ok');
    check(`relational: ...and the next call boots (${second})`, second === 'resolved');
    st.client.close();
  }
}

/* ---------------- every driver ---------------- */
const DRIVERS = [
  { name: 'lowdb', env: (dir) => ({ DB_PATH: path.join(dir, 'db.json') }) },
  { name: 'libsql', env: (dir) => ({ DATABASE_URL: `file:${path.join(dir, 'db.sqlite')}` }) },
  { name: 'relational', env: (dir) => ({ DATABASE_URL: `file:${path.join(dir, 'db.sqlite')}`, DATABASE_DRIVER: 'relational' }) },
];
const only = (process.env.CHANGE_FEED_ONLY ?? '').split(',').map((s) => s.trim()).filter(Boolean);

const runChild = (mode, driver, env) => {
  const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...env, CHANGE_FEED_CHILD: mode, CHANGE_FEED_DRIVER: driver },
    maxBuffer: 64 * 1024 * 1024,
  });
  const line = (run.stdout ?? '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
  if (!line) {
    console.error((run.stderr ?? '').split('\n').slice(-20).join('\n'));
    return null;
  }
  // A torn line is a failed assertion upstream, not a reason to crash here and
  // take every remaining ✗ line with it.
  try {
    return JSON.parse(line);
  } catch {
    console.error(`unreadable ${mode} child output (${line.length} chars)`);
    return null;
  }
};

for (const driver of DRIVERS) {
  if (only.length && !only.includes(driver.name)) continue;
  const dir = path.join(tmpRoot, driver.name);
  await fs.mkdir(path.join(dir, 'uploads'), { recursive: true });
  const env = { ...process.env, UPLOADS_DIR: path.join(dir, 'uploads'), NODE_ENV: 'test', ...driver.env(dir) };
  // Never inherit a driver from the developer's shell: a stray DATABASE_URL
  // would quietly run the "lowdb" pass against libSQL.
  if (driver.name === 'lowdb') { delete env.DATABASE_URL; delete env.DATABASE_DRIVER; }
  if (driver.name === 'libsql') delete env.DATABASE_DRIVER;

  const main = runChild('main', driver.name, env);
  if (!main) { check(`[${driver.name}] the change-feed child produced no result`, false); continue; }
  for (const [name, ok, detail] of main.results) check(`[${driver.name}] ${name}${ok ? '' : ` — ${detail}`}`, ok);

  /* ---- 3b. an install that predates retention, booted by this build ---- */
  const raw = await openRaw(driver.name, env);
  // More than one step of the relational backlog prune (1,000 rows a step), so
  // its loop has to go round: a prune that stopped after its first step left
  // 11,000 rows behind and still passed on a 2,500-row backlog.
  const backlog = makeHistory(driver.name === 'relational' ? 12000 : 2500, { baseMs: Date.UTC(2023, 0, 1), prefix: 'old' });
  // Oldest first, ahead of what is there — the shape a years-old feed has...
  await raw.add(backlog, 'start');
  // ...with no record of evictions, which no install before this one kept...
  await raw.dropWatermarks();
  if (driver.name === 'relational') {
    // ...and the index layout it had: `ts` alone.
    await raw.exec('DROP INDEX IF EXISTS idx_changes_ts_id');
    await raw.exec('CREATE INDEX IF NOT EXISTS idx_changes_ts ON content_changes (ts)');
  }
  const beforeBoot = await raw.entries();
  await raw.close();
  const expected = [...beforeBoot].sort(keyDesc).slice(0, 1000).map((e) => e.id).sort();
  // What the boot evicts, per type — what its record of evictions must say.
  const expectMarks = {};
  for (const e of [...beforeBoot].sort(keyDesc).slice(1000)) {
    if (!expectMarks[e.entity_type] || e.timestamp > expectMarks[e.entity_type]) expectMarks[e.entity_type] = e.timestamp;
  }

  const boot = runChild('boot', driver.name, env);
  if (!boot?.booted) { check(`[${driver.name}] the boot child did not complete`, false); continue; }
  // Read back by the parent, straight from the store — not reported by the
  // child, whose stdout is exactly what an oversized result used to tear.
  const after = await openRaw(driver.name, env);
  const kept = await after.entries();
  const indexes = after.indexes ? await after.indexes() : null;
  const marks = await after.watermarks();
  await after.close();
  const t = (n, c) => check(`[${driver.name}] ${n}`, c);
  t(`an oversized feed (${beforeBoot.length}) is pruned to the cap on boot (${kept.length})`, kept.length === 1000);
  t('...keeping the newest, in (timestamp, id) order', JSON.stringify(kept.map((e) => e.id).sort()) === JSON.stringify(expected));
  t('...and records what it evicted, per type, on a store that had no such record',
    Object.keys(expectMarks).length > 0 && JSON.stringify(sortObj(marks)) === JSON.stringify(sortObj(expectMarks)));
  if (driver.name === 'relational') {
    t('a database created before the (ts, id) index gets it on boot', indexes.includes('idx_changes_ts_id'));
    t('...and loses the ts-only index it replaces', !indexes.includes('idx_changes_ts'));
  }
}

await fs.rm(tmpRoot, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
