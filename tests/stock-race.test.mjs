#!/usr/bin/env node
/**
 * A product save racing a checkout must never give back the stock the checkout
 * took.
 *
 * ## The suspected bug, and why it had to be reproduced rather than argued
 *
 * On the relational driver a variant's count lives INSIDE the product's JSON
 * row. Checkout takes stock with an atomic conditional UPDATE, but
 * `updateProduct` was a read-then-write: SELECT the row, merge the patch in
 * JavaScript, UPDATE the whole row back. A reservation that lands between that
 * SELECT and that UPDATE is overwritten by the stale copy, the count goes back
 * up, and the next buyer is sold a unit that is already in somebody's parcel.
 *
 * An admin editing a description, an ERP pushing a price, a scheduled sale
 * opening — every one of them is an `updateProduct` — and checkout does not
 * pause for any of them.
 *
 * The same shape (read the whole row, write the whole row) is in `updateOrder`
 * and `updateCustomer`, where the casualty is a different field: a payment
 * webhook marking an order paid while staff add a packing note, and one of the
 * two edits silently disappears.
 *
 * ## How the race is made deterministic
 *
 * Relying on timing makes a test that passes on a quiet machine and proves
 * nothing. So the relational child patches `execute` on the libSQL client's
 * prototype and, the moment the save issues its WRITE (the first
 * `UPDATE products` after arming), runs the reservation first. That is the
 * worst possible interleaving, every time, and it is agnostic about how the
 * save is implemented: any correct implementation must survive a reservation
 * that lands after it started and before it wrote.
 *
 * A second, genuinely concurrent version (Promise.all over a hundred and twenty
 * interleaved reservations and saves) runs on all three drivers, and is honest
 * about what it can see on each. On the RELATIONAL driver every statement
 * first yields a random few turns of the event loop (installJitter), so a
 * reservation really can land between a save's read and its write: with the
 * old read-then-write updateProduct put back, the storm fails. Without the
 * jitter it could not — Promise.all issued every reservation before any save
 * read — and it stayed green on the broken code. On LOWDB and DOC-BLOB every
 * LocalDB operation runs inside one process-wide locked() mutex, so a save and
 * a reservation never interleave at all: there the storm is an arithmetic and
 * no-starvation guard, labelled as one, not a lost-update probe.
 *
 * ## The admin editor's save (D6–D8), which is where the other two drivers lose
 *
 * The lost update that DOES reach lowdb and doc-blob is not a microsecond
 * window. The admin product editor sends `stock` and the whole `variants`
 * array on every save, at the counts it loaded when the dialog opened, and
 * the dialog stays open for minutes. Every unit checkout sold meanwhile was
 * handed back by the save — measured on all three drivers: open at stock 5
 * and Black 3, sell one of each, save a description change, 5 and 3. No mutex
 * helps: the stale numbers are in the request. D6–D8 open (a JSON clone, which
 * is what the dialog holds), sell, and save the editor's body through the real
 * PUT route, on every driver. The editor now sends what it loaded as
 * `stock_base`, and a count equal to its base is taken from the row at write
 * time (readStockBases, UpdateProductOptions).
 *
 * ## The variant index (ABA)
 *
 * `reserveVariantStock` found the variant's ARRAY INDEX, then wrote
 * `$.variants[i].stock` guarded only by "the count at index i is still what I
 * read". Reorder the variants between the read and the write (an admin
 * dragging Tortoise above Black) and index i now holds a DIFFERENT variant
 * that happens to have the same count — the guard matches, and the wrong
 * colour is decremented. Remove the variant and the same thing happens to its
 * neighbour. The deterministic child does exactly that between the read and the
 * write.
 *
 * Run with:  node tests/stock-race.test.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, loadTs } from './lib/load.mjs';

/* ---------------------------------------------------------------- child --- */

/**
 * Hook the libSQL client so a callback runs immediately BEFORE the first
 * statement matching `match` — i.e. after the code under test has done its
 * reading and before its write lands.
 *
 * Patched on the PROTOTYPE, because the client lives inside a private field of
 * a module-level SqlStorage the test cannot reach. `@libsql/client` is external
 * to the bundle, so the test and LocalDB resolve the same module instance and
 * the patch reaches the real connection.
 *
 * The callback is handed a `raw` executor that bypasses the hook, so the
 * interfering write cannot trigger itself.
 */
async function installSqlHook() {
  const { createClient } = await import('@libsql/client');
  const probe = createClient({ url: 'file::memory:' });
  const proto = Object.getPrototypeOf(probe);
  probe.close();
  const original = proto.execute;
  let pending = null;
  let fired = 0;
  proto.execute = async function hooked(stmt, args) {
    const sql = typeof stmt === 'string' ? stmt : stmt.sql;
    if (pending && pending.match(sql)) {
      const p = pending;
      pending = null;
      fired += 1;
      await p.run((s, a) => original.call(this, s, a));
    }
    return original.call(this, stmt, args);
  };
  return {
    /** Arm once. Returns a function reporting whether it actually fired. */
    before(match, run) {
      const at = fired;
      pending = { match, run };
      return () => fired > at;
    },
  };
}

/**
 * Make the relational storm a real interleaving.
 *
 * Every libSQL statement in one process runs synchronously on the JS thread,
 * and Promise.all started the storm round-robin: every reservation's UPDATE
 * had run before any save issued its SELECT, so the storm could not produce
 * the lost update it is named for — verified by putting updateProduct back to
 * SELECT/merge/UPDATE, which left every storm check green. Yielding a random
 * 0–3 turns of the event loop before each statement lets a reservation land
 * between a save's read and its write, the way a busy server interleaves
 * requests. Patched on the prototype for the reason installSqlHook gives.
 */
async function installJitter() {
  const { createClient } = await import('@libsql/client');
  const probe = createClient({ url: 'file::memory:' });
  const proto = Object.getPrototypeOf(probe);
  probe.close();
  const original = proto.execute;
  proto.execute = async function jittered(stmt, args) {
    for (let k = Math.floor(Math.random() * 4); k > 0; k -= 1) await new Promise(setImmediate);
    return original.call(this, stmt, args);
  };
}

const UPDATE_PRODUCTS = (sql) => /^\s*UPDATE\s+products\b/i.test(sql);
const UPDATE_VARIANT = (sql) => UPDATE_PRODUCTS(sql) && /\$\.variants\[/.test(sql);
const UPDATE_ORDERS = (sql) => /^\s*UPDATE\s+orders\b/i.test(sql);
const UPDATE_CUSTOMERS = (sql) => /^\s*UPDATE\s+customers\b/i.test(sql);

const variantStock = (p, id) => (p?.variants ?? []).find((v) => v.id === id)?.stock;

/** Rewrite a product's variants array behind the storage layer's back. */
async function setVariantsRaw(raw, productId, mutate) {
  const res = await raw({ sql: 'SELECT data FROM products WHERE id = ?', args: [productId] });
  const doc = JSON.parse(String(res.rows[0].data));
  doc.variants = mutate(doc.variants);
  await raw({ sql: 'UPDATE products SET data = ? WHERE id = ?', args: [JSON.stringify(doc), productId] });
}

const twoVariants = (a, b) => [
  { id: 'v-black', options: { Colour: 'Black' }, stock: a, in_stock: a > 0, enabled: true },
  { id: 'v-tort', options: { Colour: 'Tortoise' }, stock: b, in_stock: b > 0, enabled: true },
];

async function deterministicChild(LocalDB, saveProduct) {
  const hook = await installSqlHook();
  const out = {};
  const mk = (over) => LocalDB.createProduct({
    status: 'active', price_cents: 1000, categories: [], images: [], on_sale: false, in_stock: true,
    ...over,
  });

  // D1. LocalDB.updateProduct, a simple product, a patch that never mentions
  //     stock. The reservation lands between the save's read and its write.
  {
    const p = await mk({ name: 'D1', slug: 'race-d1', stock: 5 });
    let reserved = null;
    const fired = hook.before(UPDATE_PRODUCTS, async () => {
      reserved = await LocalDB.reserveStock(p.id, 1);
    });
    await LocalDB.updateProduct(p.id, { description: 'edited while a checkout reserved' });
    const after = await LocalDB.getProduct(p.id);
    out.d1 = { fired: fired(), reserved, stock: after.stock, description: after.description };
  }

  // D2. The REAL save path — saveProduct, exactly as PUT /api/products/{id}
  //     calls it — on a variable product.
  {
    const p = await mk({ name: 'D2', slug: 'race-d2', stock: null, type: 'variable', variants: twoVariants(3, 3) });
    let reserved = null;
    const fired = hook.before(UPDATE_PRODUCTS, async () => {
      reserved = await LocalDB.reserveStock(p.id, 1, { variantId: 'v-black' });
    });
    const saved = await saveProduct({ description: 'new copy from the admin' }, p.id, 'race-test');
    const after = await LocalDB.getProduct(p.id);
    out.d2 = {
      fired: fired(), reserved, ok: saved.ok,
      black: variantStock(after, 'v-black'), tort: variantStock(after, 'v-tort'),
      description: after.description,
    };
  }

  // D3. The last unit sells while the save is in flight. The count must stay
  //     at 0 AND the product must stop advertising itself as in stock — the
  //     save derived `in_stock` from the copy it read before the sale.
  {
    const p = await mk({ name: 'D3', slug: 'race-d3', stock: 1 });
    let reserved = null;
    const fired = hook.before(UPDATE_PRODUCTS, async () => {
      reserved = await LocalDB.reserveStock(p.id, 1);
    });
    const saved = await saveProduct({ description: 'last one' }, p.id, 'race-test');
    const after = await LocalDB.getProduct(p.id);
    out.d3 = { fired: fired(), reserved, ok: saved.ok, stock: after.stock, in_stock: after.in_stock };
  }

  // D4. updateOrder: a payment webhook and a staff note, interleaved.
  {
    const o = await LocalDB.createOrder({
      number: 9001, status: 'processing', payment_status: 'pending', email: 'race@example.com',
      items: [], subtotal_cents: 0, total_cents: 0, currency: 'EUR',
    });
    const fired = hook.before(UPDATE_ORDERS, async () => {
      await LocalDB.updateOrder(o.id, { staff_note: 'packed, awaiting courier' });
    });
    await LocalDB.updateOrder(o.id, { payment_status: 'paid' });
    const after = await LocalDB.getOrder(o.id);
    out.d4 = { fired: fired(), payment_status: after.payment_status, staff_note: after.staff_note ?? null };
  }

  // D5. updateCustomer: two edits to different fields, interleaved.
  {
    const c = await LocalDB.createCustomer({ email: 'race-customer@example.com', name: 'Race' });
    const fired = hook.before(UPDATE_CUSTOMERS, async () => {
      await LocalDB.updateCustomer(c.id, { phone: '+30 210 000 0000' });
    });
    await LocalDB.updateCustomer(c.id, { name: 'Race Renamed' });
    const after = await LocalDB.getCustomer(c.id);
    out.d5 = { fired: fired(), name: after.name, phone: after.phone ?? null };
  }

  // A1. ABA by REORDER: both variants hold 2, so a guard on the count alone
  //     cannot tell them apart once they swap places.
  {
    const p = await mk({ name: 'A1', slug: 'race-a1', stock: null, type: 'variable', variants: twoVariants(2, 2) });
    const fired = hook.before(UPDATE_VARIANT, (raw) => setVariantsRaw(raw, p.id, (vs) => [vs[1], vs[0]]));
    const reserved = await LocalDB.reserveStock(p.id, 1, { variantId: 'v-black' });
    const after = await LocalDB.getProduct(p.id);
    out.a1 = {
      fired: fired(), reserved,
      black: variantStock(after, 'v-black'), tort: variantStock(after, 'v-tort'),
      order: after.variants.map((v) => v.id),
    };
  }

  // A2. ABA by REMOVAL: Black is deleted mid-checkout. Its neighbour slides
  //     into index 0 with the same count.
  {
    const p = await mk({ name: 'A2', slug: 'race-a2', stock: null, type: 'variable', variants: twoVariants(2, 2) });
    const fired = hook.before(UPDATE_VARIANT, (raw) => setVariantsRaw(raw, p.id, (vs) => vs.filter((v) => v.id !== 'v-black')));
    const reserved = await LocalDB.reserveStock(p.id, 1, { variantId: 'v-black' });
    const after = await LocalDB.getProduct(p.id);
    out.a2 = { fired: fired(), reserved, tort: variantStock(after, 'v-tort'), count: after.variants.length };
  }

  // A3. The same hazard on the way back: a cancellation must credit the
  //     variant it came from, even if the list was reordered in between.
  {
    const p = await mk({ name: 'A3', slug: 'race-a3', stock: null, type: 'variable', variants: twoVariants(1, 1) });
    const fired = hook.before(UPDATE_VARIANT, (raw) => setVariantsRaw(raw, p.id, (vs) => [vs[1], vs[0]]));
    await LocalDB.releaseStock(p.id, 1, { variantId: 'v-black' });
    const after = await LocalDB.getProduct(p.id);
    out.a3 = { fired: fired(), black: variantStock(after, 'v-black'), tort: variantStock(after, 'v-tort') };
  }

  return out;
}

/**
 * The admin editor's save, on EVERY driver. See the header, D6–D8.
 *
 * `bases: true` sends what src/pages/admin/products.astro sends now: every
 * field the dialog loaded, the operator's edit on top, and the counts it
 * LOADED as `stock_base`. `bases: false` is a client that sends no base — an
 * ERP pushing absolute counts — which must keep meaning exactly what it says.
 */
async function editorChild(LocalDB, putProduct) {
  const out = {};
  const mk = (over) => LocalDB.createProduct({
    status: 'active', price_cents: 1000, categories: [], images: [], on_sale: false, in_stock: true,
    ...over,
  });
  // What the dialog holds: a copy, detached from the stored row (on lowdb a
  // getter hands out the cached objects themselves).
  const open = async (id) => JSON.parse(JSON.stringify(await LocalDB.getProduct(id)));
  const editorBody = (opened, edit, { bases = true } = {}) => {
    const body = { ...opened, ...edit };
    if (!bases) return body;
    const loaded = new Map((opened.variants ?? []).map((v) => [v.id, v.stock ?? null]));
    return {
      ...body,
      stock_base: opened.stock ?? null,
      variants: (body.variants ?? []).map((v) => (loaded.has(v.id) ? { ...v, stock_base: loaded.get(v.id) } : v)),
    };
  };
  const put = async (id, body) => {
    const res = await putProduct({
      params: { id },
      request: new Request(`http://localhost/api/products/${id}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      }),
      locals: { user: { id: 'race-admin', role: 'admin' } },
    });
    return res.status;
  };
  const variantOf = (p, id) => (p?.variants ?? []).find((v) => v.id === id);

  // D6a. A simple product: the dialog opens at 5, one sells, the operator
  //      fixes a typo in the description and saves the whole form.
  {
    const p = await mk({ name: 'D6a', slug: 'editor-d6a', stock: 5 });
    const opened = await open(p.id);
    const reserved = await LocalDB.reserveStock(p.id, 1);
    const status = await put(p.id, editorBody(opened, { description: 'fixed a typo while the dialog was open' }));
    const after = await LocalDB.getProduct(p.id);
    out.d6a = { reserved, status, stock: after.stock, in_stock: after.in_stock, description: after.description };
  }

  // D6b. A variable product: Black sells while the dialog is open.
  {
    const p = await mk({ name: 'D6b', slug: 'editor-d6b', stock: null, type: 'variable', variants: twoVariants(3, 3) });
    const opened = await open(p.id);
    const reserved = await LocalDB.reserveStock(p.id, 1, { variantId: 'v-black' });
    const status = await put(p.id, editorBody(opened, { short_description: 'new copy from the editor' }));
    const after = await LocalDB.getProduct(p.id);
    out.d6b = {
      reserved, status,
      black: variantOf(after, 'v-black')?.stock, tort: variantOf(after, 'v-tort')?.stock,
      short: after.short_description,
    };
  }

  // D6c. The LAST unit sells while the dialog is open — of a simple product
  //      and of a variant. The count must stay 0 and stop saying "in stock".
  {
    const p = await mk({ name: 'D6c', slug: 'editor-d6c', stock: 1 });
    const v = await mk({ name: 'D6c variants', slug: 'editor-d6c-v', stock: null, type: 'variable', variants: twoVariants(1, 2) });
    const openedP = await open(p.id);
    const openedV = await open(v.id);
    await LocalDB.reserveStock(p.id, 1);
    await LocalDB.reserveStock(v.id, 1, { variantId: 'v-black' });
    const statuses = [
      await put(p.id, editorBody(openedP, { description: 'the last one' })),
      await put(v.id, editorBody(openedV, { description: 'the last black one' })),
    ];
    const afterP = await LocalDB.getProduct(p.id);
    const black = variantOf(await LocalDB.getProduct(v.id), 'v-black');
    out.d6c = { statuses, stock: afterP.stock, in_stock: afterP.in_stock, black: black?.stock, blackInStock: black?.in_stock };
  }

  // D7. The operator RECOUNTS: 5 → 10 on a simple product, Black 3 → 7 on a
  //     variable one, while checkout sold one of each (and one Tortoise, which
  //     the operator did not touch). A count that differs from its base is
  //     the operator setting it; the untouched Tortoise keeps its sale.
  {
    const p = await mk({ name: 'D7', slug: 'editor-d7', stock: 5 });
    const v = await mk({ name: 'D7 variants', slug: 'editor-d7-v', stock: null, type: 'variable', variants: twoVariants(3, 3) });
    const openedP = await open(p.id);
    const openedV = await open(v.id);
    await LocalDB.reserveStock(p.id, 1);
    await LocalDB.reserveStock(v.id, 1, { variantId: 'v-black' });
    await LocalDB.reserveStock(v.id, 1, { variantId: 'v-tort' });
    const recounted = openedV.variants.map((x) => (x.id === 'v-black' ? { ...x, stock: 7 } : x));
    const statuses = [
      await put(p.id, editorBody(openedP, { stock: 10 })),
      await put(v.id, editorBody(openedV, { variants: recounted })),
    ];
    const afterP = await LocalDB.getProduct(p.id);
    const afterV = await LocalDB.getProduct(v.id);
    out.d7 = {
      statuses, stock: afterP.stock,
      black: variantOf(afterV, 'v-black')?.stock, blackInStock: variantOf(afterV, 'v-black')?.in_stock,
      tort: variantOf(afterV, 'v-tort')?.stock,
    };
  }

  // D8. A client that sends NO base. Its counts are absolutes, exactly as
  //     before this change — an ERP that says 5 means 5.
  {
    const p = await mk({ name: 'D8', slug: 'editor-d8', stock: 5 });
    const v = await mk({ name: 'D8 variants', slug: 'editor-d8-v', stock: null, type: 'variable', variants: twoVariants(3, 3) });
    const openedP = await open(p.id);
    const openedV = await open(v.id);
    await LocalDB.reserveStock(p.id, 1);
    await LocalDB.reserveStock(v.id, 1, { variantId: 'v-black' });
    const statuses = [
      await put(p.id, editorBody(openedP, { description: 'from the feed' }, { bases: false })),
      await put(v.id, editorBody(openedV, { description: 'from the feed' }, { bases: false })),
    ];
    out.d8 = {
      statuses, stock: (await LocalDB.getProduct(p.id)).stock,
      black: variantOf(await LocalDB.getProduct(v.id), 'v-black')?.stock,
    };
  }

  return out;
}

/**
 * The genuinely concurrent version: no hooks, just a storm. Every driver —
 * see the header for what it can and cannot see on each.
 *
 * The invariant is arithmetic: whatever the interleaving, the count after the
 * storm is the starting count minus the reservations that were GRANTED. A lost
 * reservation shows up as stock left over; an over-grant as too little.
 */
async function concurrentChild(LocalDB) {
  if (process.env.DATABASE_DRIVER === 'relational') await installJitter();
  const START = 40;
  const simple = await LocalDB.createProduct({
    name: 'Storm', slug: 'storm-simple', status: 'active', price_cents: 1000, stock: START,
    in_stock: true, categories: [], images: [], on_sale: false,
  });
  const variable = await LocalDB.createProduct({
    name: 'Storm variants', slug: 'storm-variable', status: 'active', price_cents: 1000, stock: null,
    type: 'variable', variants: twoVariants(START, START), in_stock: true, categories: [], images: [], on_sale: false,
  });
  const ops = [];
  const grantedSimple = [];
  const grantedBlack = [];
  for (let i = 0; i < 30; i += 1) {
    ops.push(LocalDB.reserveStock(simple.id, 1).then((ok) => grantedSimple.push(ok)));
    ops.push(LocalDB.updateProduct(simple.id, { description: `edit ${i}` }));
    ops.push(LocalDB.reserveStock(variable.id, 1, { variantId: 'v-black' }).then((ok) => grantedBlack.push(ok)));
    ops.push(LocalDB.updateProduct(variable.id, { short_description: `edit ${i}` }));
  }
  await Promise.all(ops);
  const s = await LocalDB.getProduct(simple.id);
  const v = await LocalDB.getProduct(variable.id);

  // B1. Not a race — a driver disagreement found beside one. A backordered
  //     count released back up but still below zero is still OUT of stock.
  //     lowdb derived `in_stock` from the count; the relational release set it
  //     to a flat true, so one storefront badge said two different things.
  const bo = await LocalDB.createProduct({
    name: 'Backordered', slug: 'storm-backorder', status: 'active', price_cents: 1000, stock: 0,
    in_stock: false, backorders: 'yes', categories: [], images: [], on_sale: false,
  });
  await LocalDB.reserveStock(bo.id, 2, { allowBackorder: true });
  await LocalDB.releaseStock(bo.id, 1);
  const boAfter = await LocalDB.getProduct(bo.id);
  const bov = await LocalDB.createProduct({
    name: 'Backordered variants', slug: 'storm-backorder-variant', status: 'active', price_cents: 1000,
    stock: null, type: 'variable', variants: twoVariants(0, 5), in_stock: true, backorders: 'yes',
    categories: [], images: [], on_sale: false,
  });
  await LocalDB.reserveStock(bov.id, 2, { variantId: 'v-black', allowBackorder: true });
  await LocalDB.releaseStock(bov.id, 1, { variantId: 'v-black' });
  const bovBlack = ((await LocalDB.getProduct(bov.id)).variants ?? []).find((x) => x.id === 'v-black');

  return {
    start: START,
    simple: { granted: grantedSimple.filter(Boolean).length, stock: s.stock },
    black: { granted: grantedBlack.filter(Boolean).length, stock: variantStock(v, 'v-black') },
    tort: variantStock(v, 'v-tort'),
    backorder: { stock: boAfter.stock, in_stock: boAfter.in_stock },
    backorderVariant: { stock: bovBlack?.stock, in_stock: bovBlack?.in_stock },
  };
}

if (process.env.STOCK_RACE_CHILD) {
  const { LocalDB, saveProduct, putProduct } = await loadTs('tests/fixtures/storage-entry.ts', 'stockrace');
  await LocalDB.init();
  const mode = process.env.STOCK_RACE_CHILD;
  const result = mode === 'deterministic'
    ? await deterministicChild(LocalDB, saveProduct)
    : mode === 'editor'
      ? await editorChild(LocalDB, putProduct)
      : await concurrentChild(LocalDB);
  console.log('__RESULT__' + JSON.stringify(result));
  process.exit(0);
}

/* --------------------------------------------------------------- parent --- */
let pass = 0;
let fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };

const tmpRoot = path.join(os.tmpdir(), `astrobaas-stock-race-${process.pid}`);
await fs.mkdir(tmpRoot, { recursive: true });

const DRIVERS = [
  { name: 'lowdb', env: (d) => ({ DB_PATH: path.join(d, 'db.json') }) },
  { name: 'libsql', env: (d) => ({ DATABASE_URL: `file:${path.join(d, 'db.sqlite')}` }) },
  { name: 'relational', env: (d) => ({ DATABASE_URL: `file:${path.join(d, 'db.sqlite')}`, DATABASE_DRIVER: 'relational' }) },
];

function runChild(mode, driver) {
  const dir = path.join(tmpRoot, `${mode}-${driver.name}`);
  return fs.mkdir(path.join(dir, 'uploads'), { recursive: true }).then(() => {
    const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env, STOCK_RACE_CHILD: mode, NODE_ENV: 'test',
        UPLOADS_DIR: path.join(dir, 'uploads'), ...driver.env(dir),
      },
    });
    const line = (run.stdout || '').split('\n').find((l) => l.startsWith('__RESULT__'));
    if (!line) {
      fail++;
      console.error(`✗ [${driver.name}/${mode}] child produced no result\n${(run.stderr || '').slice(-1500)}`);
      return null;
    }
    return JSON.parse(line.slice('__RESULT__'.length));
  });
}

/* ---- the admin editor's save, on every driver (D6–D8) ---- */
for (const driver of DRIVERS) {
  const r = await runChild('editor', driver);
  if (!r) continue;
  const t = (n, c) => check(`[${driver.name}] ${n}`, c);

  t('D6a: the unit sold while the dialog was open was granted', r.d6a.reserved === true);
  t(`D6a: the editor's save succeeded (status ${r.d6a.status})`, r.d6a.status === 200);
  t(`D6a: saving the editor's whole form does not give back the unit sold while it was open (stock=${r.d6a.stock}, expected 4)`,
    r.d6a.stock === 4);
  t('D6a: ...and the operator\'s edit itself landed', r.d6a.description === 'fixed a typo while the dialog was open');

  t('D6b: the Black sold while the dialog was open was granted', r.d6b.reserved === true);
  t(`D6b: the editor's save succeeded (status ${r.d6b.status})`, r.d6b.status === 200);
  t(`D6b: the variant keeps its sale through the whole-form save (black=${r.d6b.black}, expected 2)`, r.d6b.black === 2);
  t(`D6b: ...the colour nobody bought is untouched (tort=${r.d6b.tort})`, r.d6b.tort === 3);
  t('D6b: ...and the new copy is saved', r.d6b.short === 'new copy from the editor');

  t(`D6c: both saves succeeded (${r.d6c.statuses.join(',')})`, r.d6c.statuses.every((s) => s === 200));
  t(`D6c: the last unit sold mid-edit stays sold and out of stock (stock=${r.d6c.stock}, in_stock=${r.d6c.in_stock})`,
    r.d6c.stock === 0 && r.d6c.in_stock === false);
  t(`D6c: ...and so does the last Black (stock=${r.d6c.black}, in_stock=${r.d6c.blackInStock})`,
    r.d6c.black === 0 && r.d6c.blackInStock === false);

  t(`D7: both recounts saved (${r.d7.statuses.join(',')})`, r.d7.statuses.every((s) => s === 200));
  t(`D7: an operator's recount of a simple product is written as typed (stock=${r.d7.stock}, expected 10)`, r.d7.stock === 10);
  t(`D7: ...and of a variant (black=${r.d7.black}, in_stock=${r.d7.blackInStock}, expected 7)`,
    r.d7.black === 7 && r.d7.blackInStock === true);
  t(`D7: ...while the variant saved at its loaded count keeps the sale made meanwhile (tort=${r.d7.tort}, expected 2)`,
    r.d7.tort === 2);

  t(`D8: a client that sends no base still saves (${r.d8.statuses.join(',')})`, r.d8.statuses.every((s) => s === 200));
  t(`D8: ...and its count is an absolute, exactly as before (stock=${r.d8.stock}, black=${r.d8.black}, expected 5 and 3)`,
    r.d8.stock === 5 && r.d8.black === 3);
}

/* ---- the genuinely concurrent storm, on every driver ---- */
for (const driver of DRIVERS) {
  const r = await runChild('concurrent', driver);
  if (!r) continue;
  const t = (n, c) => check(`[${driver.name}] ${n}`, c);
  // On lowdb and doc-blob, locked() serialises every save and reservation, so
  // these cannot see a lost update there (D6 does); they still prove the
  // arithmetic and that nobody is starved. On relational, installJitter makes
  // the interleaving real, and the first and third checks are the probe.
  const how = driver.name === 'relational'
    ? 'interleaved by jitter: a lost-update probe'
    : 'serialised by locked(): an arithmetic guard, not a lost-update probe';
  t(`simple product (${how}): stock == start - granted after 30 saves raced 30 reservations (start=${r.start} granted=${r.simple.granted} stock=${r.simple.stock})`,
    r.simple.stock === r.start - r.simple.granted);
  t('...and every reservation was granted (there was plenty of stock)', r.simple.granted === 30);
  t(`variant (${how}): stock == start - granted (granted=${r.black.granted} stock=${r.black.stock})`,
    r.black.stock === r.start - r.black.granted);
  // The old compare-exact variant guard lost every collision with another
  // reservation of the same colour and gave up after ten, refusing buyers as
  // "out of stock" with units on the shelf. Plenty of stock: all 30 must win.
  t(`...and every variant reservation was granted (granted=${r.black.granted} of 30, with ${r.start} in stock)`,
    r.black.granted === 30);
  t(`the variant nobody bought is untouched (tort=${r.tort})`, r.tort === r.start);
  t(`a backordered product released to -1 is still out of stock (stock=${r.backorder.stock}, in_stock=${r.backorder.in_stock})`,
    r.backorder.stock === -1 && r.backorder.in_stock === false);
  t(`...and so is a backordered variant (stock=${r.backorderVariant.stock}, in_stock=${r.backorderVariant.in_stock})`,
    r.backorderVariant.stock === -1 && r.backorderVariant.in_stock === false);
}

/* ---- the deterministic interleavings, on the driver that has them ---- */
{
  const relational = DRIVERS.find((d) => d.name === 'relational');
  const r = await runChild('deterministic', relational);
  if (r) {
    const t = (n, c) => check(`[relational] ${n}`, c);

    // Every scenario first proves the interleaving HAPPENED. A hook that never
    // fired would make every assertion below vacuously true.
    for (const k of ['d1', 'd2', 'd3', 'd4', 'd5', 'a1', 'a2', 'a3']) {
      t(`${k}: the interfering write really ran between the read and the write`, r[k]?.fired === true);
    }

    t('D1: the reservation was granted', r.d1.reserved === true);
    t(`D1: a save that never mentioned stock does not give back a reserved unit (stock=${r.d1.stock}, expected 4)`,
      r.d1.stock === 4);
    t('D1: ...and the save itself still landed', r.d1.description === 'edited while a checkout reserved');

    t('D2: saveProduct succeeded', r.d2.ok === true);
    t(`D2: the variant reserved mid-save keeps its reservation (black=${r.d2.black}, expected 2)`, r.d2.black === 2);
    t(`D2: ...the other variant is untouched (tort=${r.d2.tort})`, r.d2.tort === 3);
    t('D2: ...and the new copy is saved', r.d2.description === 'new copy from the admin');

    t(`D3: the last unit sold mid-save stays sold (stock=${r.d3.stock})`, r.d3.stock === 0);
    t(`D3: ...and the product no longer claims to be in stock (in_stock=${r.d3.in_stock})`, r.d3.in_stock === false);

    t(`D4: the payment webhook's edit survives (payment_status=${r.d4.payment_status})`, r.d4.payment_status === 'paid');
    t(`D4: ...AND the staff note written in between survives (staff_note=${r.d4.staff_note})`,
      r.d4.staff_note === 'packed, awaiting courier');

    t(`D5: both concurrent customer edits survive (name=${r.d5.name}, phone=${r.d5.phone})`,
      r.d5.name === 'Race Renamed' && r.d5.phone === '+30 210 000 0000');

    t(`A1: after a reorder, Black is the colour decremented (black=${r.a1.black}, expected 1)`, r.a1.black === 1);
    t(`A1: ...and Tortoise, now at Black's old index with the same count, is NOT (tort=${r.a1.tort})`, r.a1.tort === 2);
    t('A1: ...the reservation was granted', r.a1.reserved === true);

    t('A2: reserving a variant deleted mid-checkout is refused', r.a2.reserved === false);
    t(`A2: ...and its neighbour is not charged for it (tort=${r.a2.tort})`, r.a2.tort === 2 && r.a2.count === 1);

    t(`A3: a cancellation after a reorder credits the right colour (black=${r.a3.black}, tort=${r.a3.tort})`,
      r.a3.black === 2 && r.a3.tort === 1);
  }
}

await fs.rm(tmpRoot, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
