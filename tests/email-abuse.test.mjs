#!/usr/bin/env node
/**
 * Anonymous forms that send mail are bounded per RECIPIENT (S5.6, S5.7), and a
 * restock is announced in batches (S5.7).
 *
 * ## The bugs
 *
 *   - `POST /api/newsletter` sent a confirmation on every call, to any address.
 *     The per-IP gate protects the shop from one client; nothing protected the
 *     person whose address was typed, from any number of clients.
 *   - `POST /api/products/{id}/notify-me` shared the newsletter's per-IP bucket
 *     (so one form could close the other) and had no per-address limit — an
 *     address signed up to thousands of products is thousands of emails on the
 *     day stock arrives.
 *   - The restock sweep emailed every waiting shopper in one tick.
 *
 * ## What must hold
 *
 *   - the SAME answer whether or not a mail went out (no oracle);
 *   - `Victim+x@Example.com` and `v.i.c.t.i.m@gmail.com` count as the victim;
 *   - the store never holds an address;
 *   - across ticks, every waiting shopper is told exactly once — none lost,
 *     none twice — including when a delete fails or finds nothing.
 *
 * The route and sweep halves run against all three drivers.
 *
 * Run with:  node tests/email-abuse.test.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTs, ROOT } from './lib/load.mjs';

/* ---------------------------------------------------------------- child --- */
if (process.env.EMAIL_ABUSE_CHILD) {
  const entry = path.join(ROOT, 'node_modules', '.cache', `email-abuse-entry-${process.pid}.ts`);
  await fs.mkdir(path.dirname(entry), { recursive: true });
  const abs = (rel) => JSON.stringify(path.join(ROOT, rel));
  await fs.writeFile(entry, [
    `export { LocalDB } from ${abs('src/lib/localdb.ts')};`,
    `export { POST as newsletterPOST } from ${abs('src/pages/api/newsletter.ts')};`,
    `export { POST as notifyPOST } from ${abs('src/pages/api/products/[id]/notify-me.ts')};`,
    `export { sweepStockWaitlist } from ${abs('src/lib/scheduler.ts')};`,
    `export { setEmailTransport } from ${abs('src/lib/email.ts')};`,
    `export { WAITLIST_TYPE, WAITLIST_BATCH_KEY } from ${abs('src/lib/commerce/stock-waitlist.ts')};`,
    `export { WAITLIST_SIGNUP_BUDGET } from ${abs('src/lib/recipient-throttle.ts')};`,
  ].join('\n'));
  let M;
  try {
    M = await loadTs(path.relative(ROOT, entry), 'emailabuse');
  } finally {
    await fs.rm(entry, { force: true });
  }
  const { LocalDB } = M;
  await LocalDB.init();

  const sent = [];
  M.setEmailTransport({ name: 'test-capture', async send(msg) { sent.push(msg); } });
  const settle = () => new Promise((r) => setTimeout(r, 30)); // the newsletter send is fire-and-forget

  const post = async (handler, pathname, body, ip, params = {}) => {
    const url = new URL(`http://cms.test${pathname}`);
    const res = await handler({
      url, params, locals: { user: null, ip },
      request: new Request(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  /* ---- newsletter ---- */
  const nl = {};
  {
    const a = await post(M.newsletterPOST, '/api/newsletter', { email: 'victim@example.com' }, '10.0.0.1');
    await settle();
    nl.firstStatus = a.status;
    nl.firstMessage = a.body?.message;
    nl.afterFirst = sent.filter((m) => m.to === 'victim@example.com').length;
    // Different IPs, different spellings of the same mailbox.
    const again = [];
    for (const [i, email] of ['victim@example.com', 'Victim@Example.com', 'victim+promo@example.com'].entries()) {
      again.push(await post(M.newsletterPOST, '/api/newsletter', { email }, `10.0.1.${i}`));
    }
    await settle();
    nl.againStatuses = again.map((r) => r.status);
    nl.againMessages = again.map((r) => r.body?.message);
    nl.totalToVictim = sent.filter((m) => /victim/i.test(m.to)).length;
    const other = await post(M.newsletterPOST, '/api/newsletter', { email: 'someone.else@example.com' }, '10.0.0.1');
    await settle();
    nl.otherStatus = other.status;
    nl.otherSent = sent.filter((m) => m.to === 'someone.else@example.com').length;
    // Gmail ignores dots: these are one inbox.
    await post(M.newsletterPOST, '/api/newsletter', { email: 'first.last@gmail.com' }, '10.0.2.1');
    await post(M.newsletterPOST, '/api/newsletter', { email: 'firstlast@googlemail.com' }, '10.0.2.2');
    await settle();
    nl.gmailSent = sent.filter((m) => /first\.?last@(gmail|googlemail)\.com/.test(m.to)).length;
  }

  /* ---- notify-me ---- */
  const nm = {};
  {
    const products = [];
    for (let i = 0; i < 12; i += 1) {
      products.push(await LocalDB.createProduct({
        name: `Sold out ${i}`, slug: `sold-out-${i}`, status: 'active', stock: 0,
        manage_stock: true, in_stock: false, price_cents: 1000, categories: [],
      }));
    }
    const rowsFor = async (email) => (await LocalDB.getCustomEntities(M.WAITLIST_TYPE))
      .filter((r) => r.data?.email === email).length;

    // Twelve products, one address, twelve IPs: only the budget's worth stored.
    const statuses = [];
    for (let i = 0; i < 12; i += 1) {
      const r = await post(M.notifyPOST, `/api/products/${products[i].id}/notify-me`,
        { email: 'watcher@example.com' }, `10.1.0.${i}`, { id: products[i].id });
      statuses.push(r.status);
    }
    nm.statuses = statuses;
    nm.stored = await rowsFor('watcher@example.com');
    nm.budget = M.WAITLIST_SIGNUP_BUDGET.limit;

    // Its OWN per-IP bucket: exhaust the newsletter's from one IP, then sign up.
    for (let i = 0; i < 12; i += 1) {
      await post(M.newsletterPOST, '/api/newsletter', { email: `burn${i}@example.com` }, '10.9.9.9');
    }
    const burned = await post(M.newsletterPOST, '/api/newsletter', { email: 'burn-last@example.com' }, '10.9.9.9');
    nm.newsletterBucketExhausted = burned.status === 429;
    const own = await post(M.notifyPOST, `/api/products/${products[0].id}/notify-me`,
      { email: 'separate@example.com' }, '10.9.9.9', { id: products[0].id });
    nm.ownBucketStatus = own.status;
    nm.ownBucketStored = await rowsFor('separate@example.com');
    const bad = await post(M.notifyPOST, `/api/products/${products[1].id}/notify-me`,
      { email: 'not-an-address' }, '10.9.9.8', { id: products[1].id });
    nm.badStatus = bad.status;
    const ghost = await post(M.notifyPOST, '/api/products/ghost/notify-me',
      { email: 'ghost@example.com' }, '10.9.9.7', { id: 'ghost' });
    nm.ghostStatus = ghost.status;
    nm.ghostStored = await rowsFor('ghost@example.com');
  }

  /* ---- the restock sweep, across ticks ---- */
  const sw = {};
  {
    // Clear what the signups above left, so the sweep sees only this fixture.
    for (const r of await LocalDB.getCustomEntities(M.WAITLIST_TYPE)) {
      await LocalDB.deleteCustomEntity(M.WAITLIST_TYPE, r.id);
    }
    const back = await LocalDB.createProduct({
      name: 'Back again', slug: 'back-again', status: 'active', stock: 5,
      manage_stock: true, in_stock: true, price_cents: 1000, categories: [],
    });
    const out = await LocalDB.createProduct({
      name: 'Still out', slug: 'still-out', status: 'active', stock: 0,
      manage_stock: true, in_stock: false, price_cents: 1000, categories: [],
    });
    // Seven waiting for the returned product, inserted NEWEST first so storage
    // order and request order disagree; one waiting for a product still out.
    const base = Date.parse('2026-05-01T00:00:00.000Z');
    const waiting = [];
    for (let i = 6; i >= 0; i -= 1) {
      const email = `w${i}@example.com`;
      waiting.push(email);
      await LocalDB.createCustomEntity(M.WAITLIST_TYPE, {
        product_id: back.id, email, created_at: new Date(base + i * 60_000).toISOString(),
      });
    }
    await LocalDB.createCustomEntity(M.WAITLIST_TYPE, {
      product_id: out.id, email: 'patient@example.com', created_at: new Date(base).toISOString(),
    });
    await LocalDB.updateSetting(M.WAITLIST_BATCH_KEY, 3);

    const restockMail = () => sent.filter((m) => /back in stock/i.test(m.subject) || /back in stock/i.test(m.text));
    const startCount = restockMail().length;
    const ticks = [];
    for (let t = 0; t < 4; t += 1) {
      const before = restockMail().length;
      const r = await M.sweepStockWaitlist();
      ticks.push({ ...r, to: restockMail().slice(before).map((m) => m.to) });
    }
    sw.ticks = ticks;
    const all = restockMail().slice(startCount).map((m) => m.to);
    sw.all = all;
    sw.expected = [...waiting].sort();
    sw.remaining = (await LocalDB.getCustomEntities(M.WAITLIST_TYPE)).map((r) => r.data?.email);

    // A delete that FAILS must not send (the row stays, and is sent next tick,
    // once); a delete that finds NOTHING must not send either.
    for (let i = 0; i < 3; i += 1) {
      await LocalDB.createCustomEntity(M.WAITLIST_TYPE, {
        product_id: back.id, email: `claim${i}@example.com`,
        created_at: new Date(base + i * 60_000).toISOString(),
      });
    }
    await LocalDB.updateSetting(M.WAITLIST_BATCH_KEY, 10);
    const realDelete = LocalDB.deleteCustomEntity.bind(LocalDB);
    let calls = 0;
    LocalDB.deleteCustomEntity = async (type, id) => {
      calls += 1;
      if (type === M.WAITLIST_TYPE && calls === 1) throw new Error('storage blip');
      if (type === M.WAITLIST_TYPE && calls === 2) { await realDelete(type, id); return false; }
      return realDelete(type, id);
    };
    const before = restockMail().length;
    const blip = await M.sweepStockWaitlist();
    LocalDB.deleteCustomEntity = realDelete;
    const next = await M.sweepStockWaitlist();
    const claimMail = restockMail().slice(before).map((m) => m.to);
    sw.claim = {
      blipNotified: blip.notified,
      nextNotified: next.notified,
      mail: claimMail,
      leftover: (await LocalDB.getCustomEntities(M.WAITLIST_TYPE))
        .filter((r) => String(r.data?.email).startsWith('claim')).length,
    };

    // The notice is HTML: a product name or site title with markup in it must
    // arrive as text, not as markup inside a customer's mail client.
    const hostile = await LocalDB.createProduct({
      name: '<img src=x onerror=alert(1)> & Co', slug: 'hostile-name', status: 'active', stock: 2,
      manage_stock: true, in_stock: true, price_cents: 1000, categories: [],
    });
    await LocalDB.updateSetting('site_title', '<b>Shop</b>');
    await LocalDB.createCustomEntity(M.WAITLIST_TYPE, {
      product_id: hostile.id, email: 'escape@example.com', created_at: new Date(base).toISOString(),
    });
    await M.sweepStockWaitlist();
    const escMail = sent.filter((m) => m.to === 'escape@example.com').pop();
    sw.escape = { found: Boolean(escMail), html: escMail?.html ?? '' };
  }

  console.log('__RESULT__' + JSON.stringify({ nl, nm, sw }));
  process.exit(0);
}

/* --------------------------------------------------------------- parent --- */
let pass = 0;
let fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };

/* ---- the throttle itself ---- */
{
  const T = await loadTs('src/lib/recipient-throttle.ts');
  const RL = await loadTs('src/lib/rate-limit.ts');

  const c = T.canonicalMailbox;
  check('case and whitespace fold', c('  Victim@Example.COM ') === 'victim@example.com');
  check('a +tag is one mailbox', c('victim+shop@example.com') === 'victim@example.com');
  check('gmail ignores dots', c('v.i.c.t.i.m@gmail.com') === 'victim@gmail.com');
  check('googlemail is gmail', c('Victim@googlemail.com') === 'victim@gmail.com');
  check('dots elsewhere are kept', c('first.last@example.com') === 'first.last@example.com');
  check('nonsense is null', c('') === null && c('no-at') === null && c('@x.com') === null
    && c('a@') === null && c(null) === null && c('.@gmail.com') === null);
  check('a local part that merely STARTS with + is left alone', c('+tag@example.com') === '+tag@example.com');

  const k = T.recipientKey('newsletter-confirm', 'victim@example.com', 'x'.repeat(32));
  check('the store key never contains the address', !k.includes('victim') && !k.includes('example'));
  check('the key is scoped', k !== T.recipientKey('notify-me', 'victim@example.com', 'x'.repeat(32)));
  check('the key is keyed by the secret',
    k !== T.recipientKey('newsletter-confirm', 'victim@example.com', 'y'.repeat(32)));
  check('without a secret it is still not the address',
    !T.recipientKey('s', 'victim@example.com', '').includes('victim'));

  const store = new RL.MemoryRateLimitStore();
  const nb = T.NEWSLETTER_CONFIRM_BUDGET;
  check('newsletter budget: one per day', nb.limit === 1 && nb.windowMs === 24 * 60 * 60 * 1000);
  check('the first confirmation may go', await T.allowRecipient(nb, 'victim@example.com', store));
  check('a second the same day may not', !(await T.allowRecipient(nb, 'victim@example.com', store)));
  check('...nor under another spelling', !(await T.allowRecipient(nb, 'VICTIM+x@example.com', store)));
  check('another address is unaffected', await T.allowRecipient(nb, 'other@example.com', store));
  check('the waitlist budget is separate', await T.allowRecipient(T.WAITLIST_SIGNUP_BUDGET, 'victim@example.com', store));
  check('an unparseable address is refused, never mailed', !(await T.allowRecipient(nb, 'nope', store)));

  const wl = T.WAITLIST_SIGNUP_BUDGET;
  const s2 = new RL.MemoryRateLimitStore();
  const allowed = [];
  for (let i = 0; i < wl.limit + 3; i += 1) allowed.push(await T.allowRecipient(wl, 'w@example.com', s2));
  check(`waitlist budget: exactly ${wl.limit} per day`,
    allowed.filter(Boolean).length === wl.limit && allowed.slice(0, wl.limit).every(Boolean));
}

/* ---- batching, pure ---- */
{
  const W = await loadTs('src/lib/commerce/stock-waitlist.ts');
  check('default batch is 50', W.resolveWaitlistBatchSize({}, {}) === 50);
  check('the env var sets it', W.resolveWaitlistBatchSize({}, { STOCK_WAITLIST_BATCH_SIZE: '7' }) === 7);
  check('the setting wins over the env', W.resolveWaitlistBatchSize({ stock_waitlist_batch_size: 3 }, { STOCK_WAITLIST_BATCH_SIZE: '7' }) === 3);
  check('0 is clamped to 1, never "hold everyone forever"', W.resolveWaitlistBatchSize({ stock_waitlist_batch_size: 0 }, {}) === 1);
  check('nonsense falls back', W.resolveWaitlistBatchSize({ stock_waitlist_batch_size: 'lots' }, {}) === 50);
  const rows = [
    { id: 'c', created_at: '2026-01-03T00:00:00Z' },
    { id: 'x', created_at: '' },
    { id: 'a', created_at: '2026-01-01T00:00:00Z' },
    { id: 'b', created_at: '2026-01-02T00:00:00Z' },
  ];
  check('the batch is the OLDEST rows', W.waitlistBatch(rows, 2).map((r) => r.id).join() === 'a,b');
  check('an undated row goes last', W.waitlistBatch(rows, 4).map((r) => r.id).join() === 'a,b,c,x');
  check('the input is not reordered', rows[0].id === 'c');
}

/* ---- routes and sweep, per driver ---- */
const here = path.dirname(fileURLToPath(import.meta.url));
const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'astrobaas-email-abuse-'));
const DRIVERS = [
  { name: 'lowdb', env: (d) => ({ DB_PATH: path.join(d, 'db.json') }) },
  { name: 'libsql', env: (d) => ({ DATABASE_URL: `file:${path.join(d, 'db.sqlite')}` }) },
  { name: 'relational', env: (d) => ({ DATABASE_URL: `file:${path.join(d, 'db.sqlite')}`, DATABASE_DRIVER: 'relational' }) },
];

for (const driver of DRIVERS) {
  const dir = path.join(tmpRoot, driver.name);
  await fs.mkdir(path.join(dir, 'uploads'), { recursive: true });
  const env = { ...process.env };
  // The per-recipient store must be the in-process one here, whatever the shell says.
  delete env.RATE_LIMIT_STORE;
  const run = spawnSync(process.execPath, [path.join(here, 'email-abuse.test.mjs')], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 180_000,
    env: {
      ...env, EMAIL_ABUSE_CHILD: '1', NODE_ENV: 'test', SITE_URL: 'https://shop.example.com',
      AUTH_SECRET: 'test-secret-'.padEnd(40, 'x'),
      UPLOADS_DIR: path.join(dir, 'uploads'), ...driver.env(dir),
    },
  });
  const line = (run.stdout || '').split('\n').find((l) => l.startsWith('__RESULT__'));
  if (!line) {
    fail++;
    console.error(`✗ [${driver.name}] child produced no result\n${(run.stderr || '').slice(-1200)}`);
    continue;
  }
  const { nl, nm, sw } = JSON.parse(line.slice('__RESULT__'.length));
  const t = (n, c) => check(`[${driver.name}] ${n}`, c);

  // Newsletter.
  t('newsletter: a signup is 201 and sends one confirmation', nl.firstStatus === 201 && nl.afterFirst === 1);
  t('newsletter: THE BUG — repeats from other IPs and spellings send nothing more', nl.totalToVictim === 1);
  t('newsletter: ...while answering exactly the same (no oracle)',
    nl.againStatuses.every((s) => s === 201) && nl.againMessages.every((m) => m === nl.firstMessage));
  t('newsletter: another address is unaffected', nl.otherStatus === 201 && nl.otherSent === 1);
  t('newsletter: gmail dot-variants are one inbox', nl.gmailSent === 1);

  // Notify-me.
  t('notify-me: every signup answers 200', nm.statuses.every((s) => s === 200));
  t(`notify-me: THE BUG — one address stores at most ${nm.budget} a day`, nm.stored === nm.budget);
  t('notify-me: the newsletter bucket really was exhausted', nm.newsletterBucketExhausted === true);
  t('notify-me: ...and notify-me has its OWN bucket', nm.ownBucketStatus === 200 && nm.ownBucketStored === 1);
  t('notify-me: a malformed address is still named', nm.badStatus === 400);
  t('notify-me: a ghost product answers alike and stores nothing', nm.ghostStatus === 200 && nm.ghostStored === 0);

  // The sweep.
  const [t1, t2, t3, t4] = sw.ticks;
  t('sweep: tick 1 sends the batch and defers the rest', t1.notified === 3 && t1.deferred === 4);
  t('sweep: ...the three OLDEST requests first', t1.to.join() === 'w0@example.com,w1@example.com,w2@example.com');
  t('sweep: tick 2 continues', t2.notified === 3 && t2.deferred === 1);
  t('sweep: tick 3 finishes', t3.notified === 1 && t3.deferred === 0);
  t('sweep: tick 4 has nothing to do', t4.notified === 0 && t4.deferred === 0);
  t('sweep: across ticks, everyone told EXACTLY once',
    JSON.stringify([...sw.all].sort()) === JSON.stringify(sw.expected));
  t('sweep: a product still out keeps its waiter', JSON.stringify(sw.remaining) === JSON.stringify(['patient@example.com']));
  t('sweep: the notice was sent for a product whose name holds markup', sw.escape?.found === true);
  t('sweep: ...and the name and site title arrive escaped, never as markup',
    sw.escape?.html.includes('&lt;img src=x onerror=alert(1)&gt; &amp; Co') && !sw.escape.html.includes('<img')
      && sw.escape.html.includes('&lt;b&gt;Shop&lt;/b&gt;') && !sw.escape.html.includes('<b>Shop'));
  t('sweep: a failed delete sends nothing for that row, a vanished row sends nothing',
    sw.claim.blipNotified === 1);
  t('sweep: ...and the failed one is told on the next tick, once',
    sw.claim.nextNotified === 1 && sw.claim.leftover === 0
    && new Set(sw.claim.mail).size === sw.claim.mail.length && sw.claim.mail.length === 2);
}

await fs.rm(tmpRoot, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
