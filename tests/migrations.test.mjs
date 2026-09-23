#!/usr/bin/env node
/**
 * Unit tests for the schema-migration runner (src/lib/migrations.ts). Uses an
 * in-memory mock Storage (only the methods the runner + shipped migrations
 * touch) so it exercises the real runMigrations() logic driver-agnostically.
 *
 * Run with:  node tests/migrations.test.mjs
 */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cacheDir = path.join(here, '..', 'node_modules', '.cache');
await fs.mkdir(cacheDir, { recursive: true });

// Bundle so the module's own cross-imports (migrations.ts -> i18n.ts) resolve.
async function load(rel) {
  const tmp = path.join(cacheDir, `astrobaas-${path.basename(rel)}-${process.pid}.mjs`);
  await build({
    entryPoints: [path.join(here, '..', rel)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    packages: 'external',
    outfile: tmp,
    logLevel: 'silent',
  });
  const mod = await import(pathToFileURL(tmp).href);
  await fs.rm(tmp, { force: true });
  return mod;
}

const { MIGRATIONS, LATEST_SCHEMA_VERSION, runMigrations } = await load('src/lib/migrations.ts');

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) pass++;
  else {
    fail++;
    console.error(`✗ ${name}`);
  }
}

/** Minimal in-memory Storage double: schema version + users/themes/posts/orders. */
function makeStore(initial = {}) {
  return {
    _version: initial.version ?? 0,
    users: initial.users ?? [],
    themes: initial.themes ?? [],
    posts: initial.posts ?? [],
    orders: initial.orders ?? [],
    customers: initial.customers ?? [],
    products: initial.products ?? [],
    shippingMethods: initial.shippingMethods ?? [],
    coupons: initial.coupons ?? [],
    media: initial.media ?? [],
    plugins: initial.plugins ?? [],
    writes: 0,
    mediaWrites: 0,
    pluginWrites: 0,
    async getPlugins() {
      return this.plugins;
    },
    async ensurePlugins(ids) {
      for (const id of ids) {
        if (!this.plugins.some((p) => p.id === id)) {
          this.plugins.push({ id, active: false, settings: {} });
          this.pluginWrites++;
        }
      }
      return this.plugins;
    },
    async setPluginActive(id, active) {
      const p = this.plugins.find((x) => x.id === id);
      if (p) {
        p.active = active;
        this.pluginWrites++;
      }
      return p ?? null;
    },
    settings: initial.settings ?? {},
    async getSetting(key) {
      return key in this.settings ? { key, value: this.settings[key] } : undefined;
    },
    async updateSetting(key, value) {
      this.settings[key] = value;
      this.writes++;
      return { key, value };
    },
    async getSchemaVersion() {
      return this._version;
    },
    async setSchemaVersion(v) {
      this._version = v;
    },
    async getUsers() {
      return this.users;
    },
    async updateUser(id, patch) {
      const u = this.users.find((x) => x.id === id);
      if (u) {
        Object.assign(u, patch);
        this.writes++;
      }
      return u ?? null;
    },
    async getThemes() {
      return this.themes;
    },
    async getMedia() {
      return this.media;
    },
    async updateMediaFile(id, updates) {
      const m = this.media.find((x) => x.id === id);
      if (!m) return null;
      Object.assign(m, updates);
      this.writes++;
      this.mediaWrites++;
      return m;
    },
    async getPosts() {
      return this.posts;
    },
    async updatePost(id, patch) {
      const p = this.posts.find((x) => x.id === id);
      if (p) {
        Object.assign(p, patch);
        this.writes++;
      }
      return p ?? null;
    },
    async getOrders() {
      return this.orders;
    },
    async getCustomers() {
      return this.customers;
    },
    async updateCustomer(id, patch) {
      const c = this.customers.find((x) => x.id === id);
      if (c) {
        Object.assign(c, patch);
        this.writes++;
      }
      return c ?? null;
    },
    async getProducts() {
      return this.products;
    },
    async getShippingMethods() {
      return this.shippingMethods;
    },
    async getCoupons() {
      return this.coupons;
    },
    async updateProduct(id, patch) {
      const p = this.products.find((x) => x.id === id);
      if (p) {
        Object.assign(p, patch);
        this.writes++;
      }
      return p ?? null;
    },
    async updateOrder(id, patch) {
      const o = this.orders.find((x) => x.id === id);
      if (o) {
        Object.assign(o, patch);
        this.writes++;
      }
      return o ?? null;
    },
    async updateThemeSettings(id, settings) {
      const t = this.themes.find((x) => x.id === id);
      if (t) {
        t.settings = settings;
        this.writes++;
        // Per-id counts: a global total silently breaks every time a LATER
        // migration touches themes, which turns a real regression check into a
        // magic number that has to be bumped.
        this.themeWrites = this.themeWrites || {};
        this.themeWrites[id] = (this.themeWrites[id] || 0) + 1;
      }
      return t ?? null;
    },
  };
}

// ---- shape ----
{
  check('LATEST_SCHEMA_VERSION is a positive integer', Number.isInteger(LATEST_SCHEMA_VERSION) && LATEST_SCHEMA_VERSION >= 1);
  const versions = MIGRATIONS.map((m) => m.version);
  check('migration versions are unique + ascending', versions.every((v, i) => i === 0 || v > versions[i - 1]));
  check('every migration has a name + up()', MIGRATIONS.every((m) => typeof m.name === 'string' && typeof m.up === 'function'));
  check('LATEST equals the max migration version (>=1)', LATEST_SCHEMA_VERSION === Math.max(1, ...versions));
}

// ---- fresh install (already stamped at LATEST) → no work ----
{
  const s = makeStore({ version: LATEST_SCHEMA_VERSION, users: [{ id: 'u1' /* no status */ }] });
  const res = await runMigrations(s);
  check('fresh: applies nothing', res.applied.length === 0 && res.to === LATEST_SCHEMA_VERSION);
  check('fresh: does not touch data', s.writes === 0 && s.users[0].status === undefined);
}

// ---- legacy/unversioned (v0) → runs pending, stamps LATEST ----
{
  const s = makeStore({
    version: 0,
    users: [
      { id: 'a' }, // missing status → should be backfilled
      { id: 'b', status: 'inactive' }, // explicit → must be preserved
      { id: 'c', status: 'active' }, // already fine → untouched
    ],
  });
  const res = await runMigrations(s);
  check('legacy: reports from=0 to=LATEST', res.from === 0 && res.to === LATEST_SCHEMA_VERSION);
  check('legacy: stamps the store to LATEST', s._version === LATEST_SCHEMA_VERSION);
  check('legacy: backfills missing status to active', s.users[0].status === 'active');
  check('legacy: preserves an explicit inactive status', s.users[1].status === 'inactive');
  check('legacy: leaves already-active users untouched', s.users[2].status === 'active' && s.writes === 1);
  check('legacy: applied includes backfill-user-status', res.applied.includes('backfill-user-status'));
}

// ---- v3: strips the dead ThemeConfig.layout field ----
{
  const s = makeStore({
    version: 0,
    themes: [
      // legacy theme carrying the dead field
      { id: 't1', settings: { colors: { primary: '#fff' }, typography: {}, layout: { headerStyle: 'modern' }, customCSS: '.a{}' } },
      // already-clean theme must not be rewritten
      { id: 't2', settings: { colors: { primary: '#000' }, typography: {} } },
    ],
  });
  await runMigrations(s);
  check('v3: removes theme layout field', !Object.prototype.hasOwnProperty.call(s.themes[0].settings, 'layout'));
  check('v3: preserves the rest of the theme config', s.themes[0].settings.colors.primary === '#fff' && s.themes[0].settings.customCSS === '.a{}');
  // v3's contract: it rewrites the theme carrying the dead `layout` field and
  // does not rewrite the clean one. Asserted per-theme rather than by a global
  // write total, which also counts every later migration (v9 backfills style
  // defaults for BOTH themes, correctly).
  check('v3: rewrites only the theme that carried the dead field',
    (s.themeWrites?.t1 ?? 0) >= 1);
  check('v3: leaves an already-clean theme untouched by v3 itself',
    !Object.prototype.hasOwnProperty.call(s.themes[1].settings, 'layout') &&
    s.themes[1].settings.colors.primary === '#000');

  // Re-running must not write again.
  const before = s.writes;
  await runMigrations(s);
  check('v3: idempotent on a second run', s.writes === before);
}

// ---- v4: backfills Post.locale ----
{
  const s = makeStore({
    version: 0,
    posts: [
      { id: 'p1' },                 // pre-i18n → stamped with the default
      { id: 'p2', locale: 'de' },   // already set → untouched
    ],
  });
  await runMigrations(s);
  check('v4: backfills a missing post locale', s.posts[0].locale === 'en');
  check('v4: preserves an existing locale', s.posts[1].locale === 'de');

  const before = s.writes;
  await runMigrations(s);
  check('v4: idempotent on a second run', s.writes === before);
}

// ---- idempotency: a second run is a no-op ----
{
  const s = makeStore({ version: 0, users: [{ id: 'a' }] });
  await runMigrations(s);
  const writesAfterFirst = s.writes;
  const res2 = await runMigrations(s);
  check('idempotent: second run applies nothing', res2.applied.length === 0);
  check('idempotent: second run performs no writes', s.writes === writesAfterFirst);
  check('idempotent: version stays at LATEST', s._version === LATEST_SCHEMA_VERSION);
}

// ---- partial: a store already at an intermediate version only runs newer ----
{
  // Simulate being at version 1 (baseline) — v2 should still run.
  const s = makeStore({ version: 1, users: [{ id: 'a' }] });
  const res = await runMigrations(s);
  check('partial: from=1 runs the v2 migration', res.from === 1 && res.applied.includes('backfill-user-status'));
  check('partial: ends at LATEST', s._version === LATEST_SCHEMA_VERSION);
}

// ---- v5: payment_status backfill ----
// Orders written before payments existed have neither field. The inference must
// be conservative and idempotent: it may never invent "paid" for an order that
// was merely pending, and re-running must not overwrite a real value.
{
  const store = makeStore({
    version: 4,
    orders: [
      { id: 'o1', status: 'completed' },
      { id: 'o2', status: 'processing' },
      { id: 'o3', status: 'pending' },
      { id: 'o4', status: 'cancelled' },
      { id: 'o5', status: 'refunded' },
      { id: 'o6', status: 'pending', payment_status: 'paid' }, // already set
    ],
  });
  await runMigrations(store);
  const by = (id) => store.orders.find((o) => o.id === id).payment_status;

  check('v5: a completed order counts as paid', by('o1') === 'paid');
  check('v5: a processing order counts as paid', by('o2') === 'paid');
  check('v5: a PENDING order is unpaid, never assumed paid', by('o3') === 'unpaid');
  check('v5: a cancelled order maps to failed', by('o4') === 'failed');
  check('v5: a refunded order maps to refunded', by('o5') === 'refunded');
  check('v5: an existing payment_status is left alone', by('o6') === 'paid');

  const writesAfterFirst = store.writes;
  await runMigrations(store);
  check('v5: re-running writes nothing (idempotent)', store.writes === writesAfterFirst);
  check('v5: schema lands at the latest version', store._version === LATEST_SCHEMA_VERSION);
}

// ---- v6: product commerce defaults ----
// The two that can change BEHAVIOUR get the most attention: a wrong backorder
// default oversells, and a wrong manage_stock default makes an untracked
// product start tracking at zero (i.e. instantly out of stock).
{
  const store = makeStore({
    version: 5,
    products: [
      { id: 'p1', stock: 5 },
      { id: 'p2', stock: null },
      { id: 'p3', stock: 3, backorders: 'yes' },   // already set
      { id: 'p4', stock: 1, virtual: true },
    ],
  });
  await runMigrations(store);
  const p = (id) => store.products.find((x) => x.id === id);

  check('v6: backorders default to "no" (the only policy that cannot oversell)', p('p1').backorders === 'no');
  check('v6: an existing backorder policy is preserved', p('p3').backorders === 'yes');
  check('v6: a tracked product keeps tracking', p('p1').manage_stock === true);
  check('v6: an UNTRACKED product does not start tracking', p('p2').manage_stock === false);
  check('v6: catalog visibility defaults to visible', p('p1').catalog_visibility === 'visible');
  check('v6: physical goods require shipping', p('p1').requires_shipping === true);
  check('v6: a virtual product does NOT require shipping', p('p4').requires_shipping === false);
  check('v6: tags default to an empty array', Array.isArray(p('p1').tags) && p('p1').tags.length === 0);

  const writes = store.writes;
  await runMigrations(store);
  check('v6: re-running writes nothing (idempotent)', store.writes === writes);
}

// ---- v7/v8: order money breakdown + the new commerce collections ----
{
  const store = makeStore({
    version: 6,
    orders: [
      { id: 'o1', total_cents: 2480, items: [{ total_cents: 2480 }] },
      { id: 'o2', total_cents: 5000, items: [{ total_cents: 2000 }, { total_cents: 3000 }] },
      { id: 'o3', total_cents: 999, subtotal_cents: 999, items: [] }, // already stamped
    ],
  });
  await runMigrations(store);
  const o = (id) => store.orders.find((x) => x.id === id);

  check('v7: an order gains a subtotal from its line sum', o('o2').subtotal_cents === 5000);
  check('v7: a single-line order too', o('o1').subtotal_cents === 2480);
  // Inventing a VAT split for an order where none was computed would be
  // fabricating a tax record.
  check('v7: NO tax is invented for a historical order', o('o1').tax_cents === 0);
  check('v7: shipping and discount are stamped at zero',
    o('o1').shipping_cents === 0 && o('o1').discount_cents === 0);
  check('v7: an already-stamped order is left alone', o('o3').subtotal_cents === 999);
  check('v8: schema reaches the latest version', store._version === LATEST_SCHEMA_VERSION);

  const writes = store.writes;
  await runMigrations(store);
  check('v7/v8: re-running writes nothing (idempotent)', store.writes === writes);
}

// ---- v10: backfills the media thumbnail pointer ----
{
  const s = makeStore({
    version: 0,
    media: [
      // uploaded before thumb_url was persisted: pointer must be derived
      { id: 'm1', url: '/uploads/2024/10/abc123.jpg', mime_type: 'image/jpeg' },
      // already has one: must not be touched
      { id: 'm2', url: '/uploads/2024/10/def456.jpg', mime_type: 'image/jpeg', thumb_url: '/uploads/2024/10/custom.webp' },
      // not an image: no derivative exists, so no pointer should be invented
      { id: 'm3', url: '/uploads/2024/10/doc.pdf', mime_type: 'application/pdf' },
      // external/odd url: must be left alone rather than guessed at
      { id: 'm4', url: 'https://cdn.example.com/x.jpg', mime_type: 'image/jpeg' },
    ],
  });
  await runMigrations(s);
  check('v10: derives the thumbnail sibling for an image row',
    s.media[0].thumb_url === '/uploads/2024/10/abc123-thumb.webp');
  check('v10: leaves an existing thumb_url alone',
    s.media[1].thumb_url === '/uploads/2024/10/custom.webp');
  check('v10: invents nothing for a non-image', s.media[2].thumb_url === undefined);
  check('v10: ignores a url outside /uploads/', s.media[3].thumb_url === undefined);
  // Idempotence is the contract every migration here promises.
  const before = s.mediaWrites;
  await runMigrations(s);
  check('v10: is idempotent', s.mediaWrites === before);
}

// ---- v11: keeps an existing optical shop working after the module extraction ----
//
// Prescription validation moved from core checkout into the `optical` bundled
// plugin, and bundled plugins seed INACTIVE. Without this migration an upgrade
// would silently stop validating: a spectacle-lens order would be accepted with
// no prescription and reach the lab with nothing to grind, and nothing would
// error. So a shop that was already selling optical goods gets it switched on.
{
  // Evidence in the CATALOGUE.
  const byProduct = makeStore({
    version: 10,
    plugins: [{ id: 'optical', active: false }, { id: 'reading-time', active: true }],
    products: [{ id: 'p1', requires_prescription: true }, { id: 'p2' }],
  });
  await runMigrations(byProduct);
  check('v11: a shop with an Rx product gets the optical module activated',
    byProduct.plugins.find((p) => p.id === 'optical').active === true);

  // Evidence in the SALES, even when the product was archived or the flag
  // cleared since — the order history still says this shop does optical.
  const byOrder = makeStore({
    version: 10,
    plugins: [{ id: 'optical', active: false }],
    products: [{ id: 'p1' }],
    orders: [{ id: 'o1', items: [{ product_id: 'p1', prescription: { od: { sph: -225 } } }] }],
  });
  await runMigrations(byOrder);
  check('v11: a shop with a historical prescription gets it activated too',
    byOrder.plugins.find((p) => p.id === 'optical').active === true);

  // A general shop is left alone. Turning an eyewear vertical on for a shop
  // that sells shoes would be the migration inventing a decision the operator
  // never made.
  const general = makeStore({
    version: 10,
    plugins: [{ id: 'optical', active: false }],
    products: [{ id: 'p1' }, { id: 'p2', requires_prescription: false }],
    orders: [{ id: 'o1', items: [{ product_id: 'p1' }] }],
  });
  await runMigrations(general);
  check('v11: a shop with no optical evidence is left inactive',
    general.plugins.find((p) => p.id === 'optical').active === false);

  // It only ever turns the module ON. An operator who deliberately switched it
  // off must not have that reverted on the next boot.
  const deliberatelyOff = makeStore({
    version: 10,
    plugins: [{ id: 'optical', active: false }],
    products: [{ id: 'p1', requires_prescription: true }],
  });
  await runMigrations(deliberatelyOff);
  const writesAfterFirst = deliberatelyOff.pluginWrites;
  await runMigrations(deliberatelyOff);
  check('v11: is idempotent', deliberatelyOff.pluginWrites === writesAfterFirst);

  // An already-active module is not rewritten.
  const alreadyOn = makeStore({
    version: 10,
    plugins: [{ id: 'optical', active: true }],
    products: [{ id: 'p1', requires_prescription: true }],
  });
  await runMigrations(alreadyOn);
  check('v11: an already-active module is left untouched', alreadyOn.pluginWrites === 0);

  // THE ordering case, and the one that actually bit. Migrations run inside
  // LocalDB.init(), which ensurePluginsBootstrapped() calls BEFORE it seeds
  // bundled plugins — so at migration time there is normally NO optical record
  // at all. An earlier version bailed here, the boot then seeded the plugin
  // inactive, and prescription validation silently stopped on a live shop.
  // Verified against a real v10 database booted by the new build.
  const noRecord = makeStore({
    version: 10, plugins: [], products: [{ id: 'p1', requires_prescription: true }],
  });
  await runMigrations(noRecord);
  const seeded = noRecord.plugins.find((p) => p.id === 'optical');
  check('v11: with no plugin record yet, it seeds one and activates it',
    !!seeded && seeded.active === true);

  // The same path for a general shop must NOT invent an eyewear vertical.
  const noRecordGeneral = makeStore({ version: 10, plugins: [], products: [{ id: 'p1' }] });
  await runMigrations(noRecordGeneral);
  check('v11: a general shop with no record gets no optical plugin',
    !noRecordGeneral.plugins.some((p) => p.id === 'optical'));
}

// ---- v12: an existing shop keeps selling when commerce becomes opt-in ----
//
// Commerce is now off-by-default (`commerce_enabled` absent = off). Every
// pre-existing install that IS a shop must be switched on by the upgrade, or
// its storefront 404s on the next deploy. Evidence = products or orders.
{
  const shopWithProducts = makeStore({ version: 11, products: [{ id: 'p1' }] });
  await runMigrations(shopWithProducts);
  check('v12: an install with products gets commerce_enabled=true',
    shopWithProducts.settings.commerce_enabled === true);

  // Products deleted since, but the order book says this sold things.
  const shopWithOrdersOnly = makeStore({ version: 11, orders: [{ id: 'o1', items: [] }] });
  await runMigrations(shopWithOrdersOnly);
  check('v12: an install with only orders gets commerce_enabled=true',
    shopWithOrdersOnly.settings.commerce_enabled === true);

  // A blog is not a shop; the migration must not invent one. And "no row"
  // must stay "no row" — a written `false` would masquerade as a choice.
  const blog = makeStore({ version: 11 });
  await runMigrations(blog);
  check('v12: a blog gets NO commerce_enabled row at all',
    !('commerce_enabled' in blog.settings));

  // An operator's explicit OFF must never be reverted by a later boot.
  const deliberatelyOff = makeStore({
    version: 11,
    products: [{ id: 'p1' }],
    settings: { commerce_enabled: false },
  });
  await runMigrations(deliberatelyOff);
  check('v12: an explicit false is never flipped back on',
    deliberatelyOff.settings.commerce_enabled === false);
}

/* ---------------------------------------------------- v13: customer address book */
{
  const store = makeStore({
    schemaVersion: 12,
    customers: [
      // Everything to lift, including a proper ISO country.
      { id: 'c1', email: 'a@b.c', name: 'Maria K.', phone: '+30 210 0000000',
        address: 'Ερμού 15', city: 'Αθήνα', postcode: '10563', country: 'gr' },
      // A country the migration CANNOT verify. It must write no country rather
      // than guess 'GR' from the word — and must not drop the legacy field.
      { id: 'c2', email: 'd@e.f', address: '1 Some Street', country: 'Greece' },
      // Nothing to lift: must stay byte-identical.
      { id: 'c3', email: 'g@h.i' },
      // Already has a book: must not be touched or duplicated.
      { id: 'c4', email: 'j@k.l', address: 'Old', addresses: [{ id: 'keep', line1: 'Existing' }] },
    ],
  });
  await runMigrations(store);

  const c1 = store.customers.find((c) => c.id === 'c1');
  check('v13 lifts a customer address into the book', c1.addresses?.length === 1);
  check('...mapping address to line1', c1.addresses[0].line1 === 'Ερμού 15');
  check('...carrying city and postcode', c1.addresses[0].city === 'Αθήνα' && c1.addresses[0].postcode === '10563');
  check('...upper-casing a valid country', c1.addresses[0].country === 'GR');
  check('...and marking it the default for both purposes',
    c1.addresses[0].default_shipping === true && c1.addresses[0].default_billing === true);
  check('...while LEAVING the legacy fields alone (two storefronts read them)',
    c1.address === 'Ερμού 15' && c1.city === 'Αθήνα' && c1.country === 'gr');

  const c2 = store.customers.find((c) => c.id === 'c2');
  check('a country it cannot verify is NOT guessed', c2.addresses[0].country === undefined);
  check('...and the legacy value is not destroyed either', c2.country === 'Greece');

  const c3 = store.customers.find((c) => c.id === 'c3');
  check('a customer with nothing to lift gets no empty book', c3.addresses === undefined);

  const c4 = store.customers.find((c) => c.id === 'c4');
  check('an existing book is left alone', c4.addresses.length === 1 && c4.addresses[0].id === 'keep');

  // Idempotence, which is the contract every migration here signs.
  const writesBefore = store.writes;
  await runMigrations(store);
  check('v13 is idempotent — a second run writes nothing', store.writes === writesBefore);

  // THE ONE IT MUST NOT DO. An order's flat address is never parsed.
  const orderStore = makeStore({
    schemaVersion: 12,
    orders: [{ id: 'o1', number: 'A-1', address: 'Ερμού 15, 3ος, 10563 Αθήνα' }],
  });
  await runMigrations(orderStore);
  const o1 = orderStore.orders.find((o) => o.id === 'o1');
  check('v13 NEVER invents a structured address for a historical order',
    o1.shipping_address === undefined && o1.billing_address === undefined);
  check('...and leaves the order flat address exactly as it was',
    o1.address === 'Ερμού 15, 3ος, 10563 Αθήνα');
}

/* ------------------------------------------------------------------ v14 */
{
  /*
   * v14 is asserted BOTH ways, because the two claims need different scopes.
   *
   * Through the runner: that it is wired into the chain at all and classifies
   * what it should. In isolation: how many products it WRITES — a full chain
   * run cannot answer that, because v6 backfills commerce defaults onto every
   * product and v12 writes a setting, so `store.writes` counts their work too.
   * An "only wrote what changed" assertion measured across the chain would be
   * measuring v6.
   */
  const v14 = MIGRATIONS.find((m) => m.name === 'classify-existing-gallery-video');
  // Pinned to its VERSION, not to being newest. The first version of this
  // asserted `v14.version === LATEST_SCHEMA_VERSION`, which every subsequent
  // migration would break — a test that fails for the one reason that is never
  // a bug teaches the next person to edit tests to make them pass.
  check('v14 exists, at version 14', !!v14 && v14.version === 14);
  check('...and is wired into the chain', LATEST_SCHEMA_VERSION >= 14);

  const gallery = () => ({
    media: [
      { id: 'm1', url: '/uploads/clip', mime_type: 'video/mp4' },
      { id: 'm2', url: '/uploads/shot', mime_type: 'image/webp' },
      { id: 'm3', url: '/uploads/lying.webp', mime_type: 'video/mp4' },
    ],
    products: [
      { id: 'p1', images: [{ src: '/uploads/front.webp' }, { src: '/uploads/tour.mp4' }] },
      { id: 'p2', images: [{ src: '/uploads/clip' }, { src: '/uploads/shot' }] },
      { id: 'p3', images: [{ src: '/uploads/lying.webp' }] },
      { id: 'p4', images: [{ src: '/uploads/a.webp' }, { src: '/uploads/b.jpg' }] },
      { id: 'p5', images: [] },
      { id: 'p6' },
      { id: 'p7', images: [{ src: '/uploads/old.mp4', kind: 'video' }] },
    ],
  });

  /* --- through the whole chain, as a real boot runs it --- */
  const store = makeStore(gallery());
  await runMigrations(store);
  const byId = (id) => store.products.find((p) => p.id === id);

  check('v14 classifies a video by extension', byId('p1').images[1].kind === 'video');
  check('...and leaves the photograph beside it alone', byId('p1').images[0].kind === undefined);
  check('v14 classifies an EXTENSIONLESS video from the media table',
    byId('p2').images[0].kind === 'video');
  check('...and does not mislabel the image beside it', byId('p2').images[1].kind === undefined);
  check('the media table beats a misleading extension', byId('p3').images[0].kind === 'video');
  check('a gallery with no video is left entirely unmarked',
    byId('p4').images.every((i) => !('kind' in i)));
  check('an empty gallery is untouched', byId('p5').images.length === 0);
  check('a product with no images at all is skipped', byId('p6').images === undefined);
  check('an already-classified video is left as it was', byId('p7').images[0].kind === 'video');

  /* --- in isolation, where the write count means something --- */
  const solo = makeStore(gallery());
  await v14.up(solo);
  // updateProduct stamps `updated_at` and pushes a change-feed entry on every
  // driver, so a sweep that touched every product would flush the 1000-entry
  // ring and re-date the whole catalogue.
  check('v14 writes ONLY the products that actually changed', solo.writes === 3);

  const writesBefore = solo.writes;
  await v14.up(solo);
  check('v14 is idempotent — running it again writes nothing', solo.writes === writesBefore);

  // ADD-ONLY. It may never demote something the sniffer or a human called a
  // video, even when it disagrees.
  const stubborn = makeStore({
    media: [{ id: 'm1', url: '/uploads/p.webp', mime_type: 'image/webp' }],
    products: [{ id: 'p1', images: [{ src: '/uploads/p.webp', kind: 'video' }] }],
  });
  await v14.up(stubborn);
  check('v14 never REMOVES a kind it disagrees with',
    stubborn.products[0].images[0].kind === 'video');
  check('...and never writes the product to do so', stubborn.writes === 0);

  // A malformed row must not take the migration — and with it the boot — down.
  const junk = makeStore({
    products: [{ id: 'p1', images: [null, { alt: 'no src' }, { src: 5 }, { src: '/uploads/ok.mp4' }] }],
  });
  // Caught, not awaited bare: a migration that throws here would take the whole
  // boot down, and the test must report THAT as a failed assertion rather than
  // dying itself and taking every assertion after it with it.
  let threw = null;
  try { await v14.up(junk); } catch (e) { threw = e; }
  check(`v14 does not throw on a malformed gallery entry${threw ? ` (threw ${threw.message})` : ''}`,
    threw === null);
  check('...and still classifies the one real video beside the junk',
    junk.products[0].images?.[3]?.kind === 'video');
  check('...without inventing anything for the entries it cannot read',
    junk.products[0].images?.[0] === null && junk.products[0].images?.[2]?.src === 5);
}

/* ------------------------------------------------------------------ v15 */
{
  const v15 = MIGRATIONS.find((m) => m.name === 'canonical-brand-spellings');
  check('v15 exists, at version 15', !!v15 && v15.version === 15);

  // The live shop's own spread, so the guards are tested against data that
  // actually existed rather than against a tidy invention.
  const catalogue = () => ({
    products: [
      ...Array(16).fill('Rayban'), 'RAYBAN',            // 94% — clear, case only
      ...Array(52).fill('Symbol'), ...Array(9).fill('SYMBOL'), 'Symbol ', 'Symbol ',
      ...Array(4).fill('Dalet'), ...Array(6).fill('DALET'),   // 60% — NOT clear
      ...Array(6).fill('Solano Clips'), 'Solano clips', 'Solano clips',
      'SOLANO', 'SOLANO',
      ...Array(5).fill('Tipi Diversi'), ...Array(3).fill('Tipi Diversi Clip'),
      'Persol',
    ].map((brand, i) => ({ id: `p${i}`, brand })),
  });

  const store = makeStore(catalogue());
  await v15.up(store);
  const brandOf = (id) => store.products.find((p) => p.id === id).brand;
  const count = (name) => store.products.filter((p) => p.brand === name).length;

  /* --- what it DOES --- */
  check('v15 canonicalises a clear case-only winner', count('Rayban') === 17 && count('RAYBAN') === 0);
  check('...and tidies a trailing space', count('Symbol') === 63 && count('Symbol ') === 0);
  check('...and a lower-cased word', count('Solano Clips') === 8);

  /* --- GUARD 2: no clear winner --- */
  check('v15 REFUSES a 60/40 split rather than picking the shoutier spelling',
    count('DALET') === 6 && count('Dalet') === 4);

  /* --- what it must NEVER do --- */
  check('SOLANO is not absorbed into Solano Clips', count('SOLANO') === 2);
  check('Tipi Diversi Clip survives as its own line', count('Tipi Diversi Clip') === 3);
  check('...and Tipi Diversi with it', count('Tipi Diversi') === 5);
  check('a lone brand is untouched', count('Persol') === 1);

  /* --- the report --- */
  const report = store.settings.brand_spelling_report;
  check('v15 writes a report an operator can read', !!report);
  check('...naming what it changed',
    report.applied.some((a) => a.to === 'Rayban' && a.from.includes('RAYBAN')));
  check('...and what it refused, with a reason',
    report.needs_a_human.some((n) => n.spellings.some((s) => s.name === 'DALET'))
    && report.needs_a_human.every((n) => typeof n.reason === 'string' && n.reason.length > 20));
  check('...and the near-misses it deliberately did not merge',
    report.possibly_related.some((r) => r.a === 'Tipi Diversi' && r.b === 'Tipi Diversi Clip'));

  /* --- idempotence, the contract every migration here signs --- */
  // Measured on the PRODUCTS, not on `store.writes`: the double counts
  // `updateSetting` too, and re-stating the report on a second run is correct —
  // the DALET group still needs a human, so the row must still say so.
  const productsBefore = JSON.stringify(store.products);
  await v15.up(store);
  check('v15 is idempotent — a second run rewrites no product',
    JSON.stringify(store.products) === productsBefore);

  /* --- GUARD 1: punctuation is never merged automatically --- */
  const hyphen = makeStore({
    products: [
      ...Array(16).fill('Rayban'), 'Ray-Ban',
    ].map((brand, i) => ({ id: `h${i}`, brand })),
  });
  await v15.up(hyphen);
  // The most common spelling is the WRONG one here, which is exactly why a
  // punctuation difference is never applied automatically.
  check('v15 refuses to rewrite Ray-Ban into the more common Rayban',
    hyphen.products.filter((p) => p.brand === 'Ray-Ban').length === 1);
  check('...and reports it instead',
    (hyphen.settings.brand_spelling_report?.needs_a_human ?? [])
      .some((n) => n.spellings.some((s) => s.name === 'Ray-Ban')));

  /* --- a tidy shop gets no report at all --- */
  const tidy = makeStore({ products: [{ id: 't1', brand: 'Persol' }, { id: 't2', brand: 'Rayban' }] });
  await v15.up(tidy);
  check('a shop with tidy brands is written nothing, and gets NO report',
    tidy.writes === 0 && tidy.settings.brand_spelling_report === undefined);

  /* --- malformed rows must not take the boot down --- */
  const junk = makeStore({
    products: [
      { id: 'j1' }, { id: 'j2', brand: null }, { id: 'j3', brand: 7 },
      { id: 'j4', brand: '   ' }, { id: 'j5', brand: 'Rayban' }, { id: 'j6', brand: 'RAYBAN' },
    ],
  });
  let threw = null;
  try { await v15.up(junk); } catch (e) { threw = e; }
  check(`v15 survives malformed brand values${threw ? ` (threw ${threw.message})` : ''}`, threw === null);
  check('...without inventing a brand for the rows that have none',
    junk.products.find((p) => p.id === 'j1').brand === undefined
    && junk.products.find((p) => p.id === 'j2').brand === null);
  // A one-against-one tie has no two-thirds winner, so the guard refuses it —
  // there is genuinely no evidence which spelling the shop means.
  check('a 50/50 split between two spellings is refused, not coin-flipped',
    junk.products.find((p) => p.id === 'j6').brand === 'RAYBAN'
    && junk.products.find((p) => p.id === 'j5').brand === 'Rayban');

  // ...and with a real majority beside it, the same pair IS applied.
  const clear = makeStore({
    products: [...Array(3).fill('Rayban'), 'RAYBAN']
      .map((brand, i) => ({ id: `c${i}`, brand })),
  });
  await v15.up(clear);
  check('...while 3-against-1 is applied',
    clear.products.filter((p) => p.brand === 'Rayban').length === 4);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
