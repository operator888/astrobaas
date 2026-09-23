#!/usr/bin/env node
/**
 * Scheduled sales open and close on a clock (`sweepScheduledSales`).
 *
 * ## The bug
 *
 * `sale_starts_at` / `sale_ends_at` were stored, validated and honoured by
 * `deriveSaleState()` — which every WRITE path goes through, and nothing else.
 * So a sale queued for Friday midnight did not begin until somebody opened the
 * product and saved it, and a sale that had ended kept selling at the sale
 * price for the same reason. `core/models.ts` documented this in as many words.
 *
 * It costs money in both directions, and the second is the expensive one: a
 * sale that will not start is a promotion that silently did nothing; a sale
 * that will not end is margin leaving on every order. Checkout reads the STORED
 * `price_cents` for a simple product, so this is what a customer is charged.
 *
 * Run against all three drivers, because the sweep WRITES.
 *
 * Run with:  node tests/scheduled-sales.test.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTogether } from './lib/load.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

const DAY = 24 * 60 * 60 * 1000;

/* ---------------------------------------------------------------- child --- */
if (process.env.SALES_TEST_CHILD) {
  const cacheDir = path.join(root, 'node_modules', '.cache');
  await fs.mkdir(cacheDir, { recursive: true });

  const [
    { sweepScheduledSales },
    { LocalDB },
  ] = await loadTogether([
    'src/lib/scheduler.ts',
    'src/lib/localdb.ts',
  ]);
  await LocalDB.init();

  const T0 = Date.parse('2026-06-01T12:00:00.000Z');
  const mk = (over) => LocalDB.createProduct({
    name: over.name, slug: over.slug, status: 'active', stock: 10,
    price_cents: 10000, regular_price_cents: 10000, sale_price_cents: 8000,
    on_sale: false, ...over,
  });

  // 1. A sale queued for TOMORROW. Saved today, so it is correctly off.
  const future = await mk({ name: 'Queued', slug: 'sale-queued',
    sale_starts_at: new Date(T0 + DAY).toISOString() });

  // 2. A sale that is ALREADY RUNNING — saved before it opened, so it is still
  //    stored as off. This is the promotion that silently did nothing.
  const due = await mk({ name: 'Due', slug: 'sale-due',
    sale_starts_at: new Date(T0 - DAY).toISOString() });

  // 3. A sale that has ENDED but is still stored as live and still charging the
  //    sale price. This is the margin leak.
  const ended = await mk({ name: 'Ended', slug: 'sale-ended',
    on_sale: true, price_cents: 8000,
    sale_starts_at: new Date(T0 - 5 * DAY).toISOString(),
    sale_ends_at: new Date(T0 - DAY).toISOString() });

  // 4. NO window at all. A background sweep must not touch it — `deriveSaleState`
  //    fills in a missing regular price, which is fine in a save the operator
  //    asked for and not something to do to a catalogue behind their back.
  const plain = await mk({ name: 'Plain', slug: 'sale-none',
    sale_price_cents: null, price_cents: 4200, regular_price_cents: null });

  // 5. THE ONE THE WINDOW FILTER ACTUALLY GUARDS. A stored sale price, no
  //    window, and `on_sale: false` — an operator who typed a sale price and
  //    has not switched it on. `deriveSaleState` with no window computes
  //    `on_sale = true` (saleActiveAt returns null, and `null !== false`), so a
  //    sweep that re-derived every product would switch on a promotion nobody
  //    scheduled. On a SAVE that derivation is what the operator asked for; in
  //    a background pass it is the catalogue changing behind their back.
  const unscheduled = await mk({ name: 'Unscheduled', slug: 'sale-unscheduled',
    price_cents: 10000, regular_price_cents: 10000, sale_price_cents: 8000,
    on_sale: false });

  // 6. A "sale" priced at or above the regular price is not a sale, window or
  //    no window — the guard that stops a bad feed advertising a fake discount.
  const fake = await mk({ name: 'Fake', slug: 'sale-fake',
    sale_price_cents: 10000, sale_starts_at: new Date(T0 - DAY).toISOString() });

  const first = await sweepScheduledSales(T0);
  const after = Object.fromEntries(
    (await LocalDB.getProducts()).map((p) => [p.slug, p]));

  // Idempotence: a second sweep at the same instant must change nothing, or the
  // sweep would rewrite every scheduled product on every tick.
  const second = await sweepScheduledSales(T0);

  // And moving the clock past the queued sale opens it.
  await sweepScheduledSales(T0 + 2 * DAY);
  const later = Object.fromEntries(
    (await LocalDB.getProducts()).map((p) => [p.slug, p]));

  console.log('__RESULT__' + JSON.stringify({
    firstRepriced: first.repriced,
    secondRepriced: second.repriced,
    due: { on_sale: after['sale-due']?.on_sale, price: after['sale-due']?.price_cents },
    ended: { on_sale: after['sale-ended']?.on_sale, price: after['sale-ended']?.price_cents },
    queuedBefore: { on_sale: after['sale-queued']?.on_sale, price: after['sale-queued']?.price_cents },
    queuedAfter: { on_sale: later['sale-queued']?.on_sale, price: later['sale-queued']?.price_cents },
    plain: { price: after['sale-none']?.price_cents, regular: after['sale-none']?.regular_price_cents ?? null },
    unscheduled: { on_sale: after['sale-unscheduled']?.on_sale, price: after['sale-unscheduled']?.price_cents },
    fake: { on_sale: after['sale-fake']?.on_sale, price: after['sale-fake']?.price_cents },
    ids: { future: !!future?.id, due: !!due?.id, ended: !!ended?.id, plain: !!plain?.id,
           fake: !!fake?.id, unscheduled: !!unscheduled?.id },
  }));
  process.exit(0);
}

/* --------------------------------------------------------------- parent --- */
let pass = 0;
let fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };

const tmpRoot = path.join(os.tmpdir(), `astrobaas-sales-test-${process.pid}`);
await fs.mkdir(tmpRoot, { recursive: true });

const DRIVERS = [
  { name: 'lowdb', env: (d) => ({ DB_PATH: path.join(d, 'db.json') }) },
  { name: 'libsql', env: (d) => ({ DATABASE_URL: `file:${path.join(d, 'db.sqlite')}` }) },
  { name: 'relational', env: (d) => ({ DATABASE_URL: `file:${path.join(d, 'db.sqlite')}`, DATABASE_DRIVER: 'relational' }) },
];

for (const driver of DRIVERS) {
  const dir = path.join(tmpRoot, driver.name);
  await fs.mkdir(path.join(dir, 'uploads'), { recursive: true });
  const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, SALES_TEST_CHILD: '1', NODE_ENV: 'test',
      UPLOADS_DIR: path.join(dir, 'uploads'), ...driver.env(dir) },
  });
  const line = (run.stdout || '').split('\n').find((l) => l.startsWith('__RESULT__'));
  if (!line) {
    fail++;
    console.error(`✗ [${driver.name}] child produced no result\n${(run.stderr || '').slice(-700)}`);
    continue;
  }
  const r = JSON.parse(line.slice('__RESULT__'.length));
  const t = (n, c) => check(`[${driver.name}] ${n}`, c);

  t('every fixture was created', Object.values(r.ids).every(Boolean));

  // THE BUG, first direction: a due sale must open on the clock.
  t('a sale whose window has OPENED goes live without a save',
    r.due.on_sale === true && r.due.price === 8000);

  // THE BUG, second direction — the expensive one.
  t('a sale whose window has CLOSED stops charging the sale price',
    r.ended.on_sale === false && r.ended.price === 10000);

  // ...and the sweep must not run ahead of the clock.
  t('a sale queued for tomorrow stays off today',
    r.queuedBefore.on_sale === false && r.queuedBefore.price === 10000);
  t('...and opens once the clock passes it',
    r.queuedAfter.on_sale === true && r.queuedAfter.price === 8000);

  // A product with no window is none of the sweep's business.
  t('a product with NO sale window is left completely alone',
    r.plain.price === 4200 && r.plain.regular === null);

  // THE ASSERTION THAT MAKES THE WINDOW FILTER LOAD-BEARING. Without it the
  // sweep re-derives this product, `saleActiveAt` returns null for "no window",
  // `null !== false` is true, and a sale the operator never scheduled switches
  // itself on at the next tick.
  t('an UNSCHEDULED sale price is not switched on by the sweep',
    r.unscheduled.on_sale === false && r.unscheduled.price === 10000);

  // The one rule the sweep must not have a second opinion about.
  t('a "sale" priced at the regular price is still not a sale',
    r.fake.on_sale === false && r.fake.price === 10000);

  // Exactly the two that changed, and nothing on the second pass.
  t('only the products the clock moved are written', r.firstRepriced === 2);
  t('a second sweep at the same instant writes nothing', r.secondRepriced === 0);
}

await fs.rm(tmpRoot, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
