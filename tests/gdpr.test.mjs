#!/usr/bin/env node
/**
 * Data-subject access and erasure, against a real database, on every driver.
 *
 * The property that makes this correct rather than merely thorough:
 *
 *   **Erasure is not deletion of everything.** An order is a commercial record
 *   with a statutory retention period, and deleting it to satisfy an erasure
 *   request breaks an obligation the shop cannot waive. Keeping it with the
 *   buyer's name and address on it is not erasure either. So the totals
 *   survive and the person does not — and both halves of that are asserted
 *   here, because an implementation that gets either one wrong looks exactly
 *   like one that works.
 *
 * The rest is about completeness, in both directions: everything about the
 * subject is found, and nothing about anybody else is touched.
 *
 * Run with:  node tests/gdpr.test.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

/* ------------------------------------------------------------------ *
 * The child: one driver, one database.                                *
 * ------------------------------------------------------------------ */
if (process.env.GDPR_TEST_CHILD) {
  const { build } = await import('esbuild');
  const { pathToFileURL } = await import('node:url');

  const cacheDir = path.join(root, 'node_modules', '.cache');
  await fs.mkdir(cacheDir, { recursive: true });
  const load = async (entry, name) => {
    const out = path.join(cacheDir, `astrobaas-gdpr-${name}-${process.pid}.mjs`);
    await build({
      entryPoints: [path.join(root, entry)],
      bundle: true, format: 'esm', platform: 'node', packages: 'external',
      outfile: out, logLevel: 'silent',
    });
    const mod = await import(pathToFileURL(out).href);
    await fs.rm(out, { force: true });
    return mod;
  };

  const G = await load('src/lib/gdpr.ts', 'gdpr');
  const { LocalDB } = await load('src/lib/localdb.ts', 'db');

  await LocalDB.init();

  const SUBJECT = 'maria@example.com';
  const OTHER = 'someone.else@example.com';

  // The subject: a customer, two orders (one placed as a guest, before the
  // account existed), a message, a newsletter subscription.
  const customer = await LocalDB.createCustomer({
    email: SUBJECT, name: 'Maria K.', phone: '+30 210 0000000',
    address: '1 Some Street', city: 'Athens', postcode: '10000', country: 'GR',
  });
  const linkedOrder = await LocalDB.createOrder({
    number: 'GDPR-1', status: 'completed', currency: 'EUR', total_cents: 19900,
    customer_id: customer.id, email: SUBJECT, name: 'Maria K.',
    phone: '+30 210 0000000', address: '1 Some Street',
    // STRUCTURED addresses, carrying four things the flat string never did: a
    // recipient name, a company, a delivery phone and a ΑΦΜ. Erasing the
    // one-line rendering while leaving the fields it was rendered FROM is an
    // erasure that reads as complete and is not.
    shipping_address: {
      name: 'Maria K.', company: 'Maria Ltd', line1: '1 Some Street',
      city: 'Athens', postcode: '15124', country: 'GR', phone: '+30 210 0000000',
    },
    billing_address: {
      name: 'Maria K.', company: 'Maria Ltd', line1: '1 Some Street',
      city: 'Athens', postcode: '15124', country: 'GR', tax_id: '123456789',
    },
    // The delivery postcode and country are separate fields from the free-text
    // address, and only one of them should survive an erasure.
    shipping_postcode: '15124', shipping_country: 'GR',
    // A γνωμάτευση on the line. Article 9 health data, and the thing this
    // erasure now deliberately KEEPS — see the note in anonymisedOrderFields.
    items: [{
      name: 'Titanium frame', qty: 1, total_cents: 19900,
      prescription: { type: 'spectacles', od: { sph: -200 }, os: { sph: -175 }, issued_by: 'Dr Papadopoulos' },
    }],
  });
  // No customer_id: placed as a guest. Matching only on the id would miss it.
  const guestOrder = await LocalDB.createOrder({
    number: 'GDPR-2', status: 'completed', currency: 'EUR', total_cents: 4500,
    email: SUBJECT, name: 'Maria K.', address: '1 Some Street',
    items: [{ name: 'Lens cloth', qty: 3, total_cents: 4500 }],
  });
  await LocalDB.createMessage({
    name: 'Maria K.', email: SUBJECT, subject: 'A question', message: 'Do you ship to Crete?',
  });
  await LocalDB.createSubscriber(SUBJECT);
  // The outbound log holds recipient addresses, so it is personal data and has
  // to be covered by both halves of this.
  await LocalDB.logEmail({ to: SUBJECT, subject: 'Your order', transport: 'console', ok: true });
  await LocalDB.logEmail({ to: 'MARIA@Example.com', subject: 'A retry', transport: 'console', ok: false, error: 'timeout' });

  // A change-feed snapshot and a webhook delivery, each carrying the subject's
  // full order payload — the two transient stores the audit caught the erasure
  // leaving behind.
  await LocalDB.recordContentChange('post', 'ord-snap', 'create',
    { number: 'GDPR-1', email: SUBJECT, name: 'Maria K.', address: '1 Some Street' });
  await LocalDB.createWebhookDelivery({
    webhook_id: 'w1', url: 'https://hook.example', event: 'order.created',
    payload: JSON.stringify({ email: SUBJECT, name: 'Maria K.', phone: '+30 210 0000000' }),
    status: 'success', attempts: 1,
  });
  // And the same for the OTHER person, which must survive.
  await LocalDB.createWebhookDelivery({
    webhook_id: 'w1', url: 'https://hook.example', event: 'order.created',
    payload: JSON.stringify({ email: OTHER, name: 'Someone Else' }),
    status: 'success', attempts: 1,
  });

  // Somebody else, who must be untouched by any of this.
  const otherCustomer = await LocalDB.createCustomer({ email: OTHER, name: 'Someone Else' });
  const otherOrder = await LocalDB.createOrder({
    number: 'GDPR-3', status: 'completed', currency: 'EUR', total_cents: 1000,
    customer_id: otherCustomer.id, email: OTHER, name: 'Someone Else',
    items: [{ name: 'A thing', qty: 1, total_cents: 1000 }],
  });
  await LocalDB.createMessage({ name: 'Someone Else', email: OTHER, message: 'Hello' });
  await LocalDB.createSubscriber(OTHER);
  await LocalDB.logEmail({ to: OTHER, subject: 'Their order', transport: 'console', ok: true });

  // Case and whitespace must not matter — a request arrives as somebody typed it.
  const found = await G.collectSubjectData('  Maria@Example.COM  ');

  const erased = await G.eraseSubject(SUBJECT);

  const ordersAfter = await LocalDB.getOrders();
  const customersAfter = await LocalDB.getCustomers();
  const messagesAfter = await LocalDB.getMessages();
  const subsAfter = await LocalDB.getSubscribers();

  const keptLinked = ordersAfter.find((o) => o.number === 'GDPR-1');
  const keptGuest = ordersAfter.find((o) => o.number === 'GDPR-2');
  const untouched = ordersAfter.find((o) => o.number === 'GDPR-3');

  // Running it twice is what a nervous operator does.
  const again = await G.eraseSubject(SUBJECT);

  /* ---- consent receipts: storage, on every driver ---- */
  const RID = '11111111-2222-4333-8444-555555555555';
  const receipt = {
    id: RID, granted: ['necessary', 'analytics'], version: 1,
    created_at: '2026-01-01T00:00:00.000Z',
  };
  await LocalDB.createConsentReceipt(receipt);
  // The banner retries a POST that timed out. A duplicate would make the trail
  // overcount decisions.
  await LocalDB.createConsentReceipt({ ...receipt, granted: ['necessary'] });
  await LocalDB.createConsentReceipt({
    id: '99999999-2222-4333-8444-555555555555', granted: ['necessary'], version: 1,
    created_at: '2026-02-01T00:00:00.000Z',
  });
  const allReceipts = await LocalDB.getConsentReceipts(10);
  const oneReceipt = await LocalDB.getConsentReceipt(RID);

  // A staff account carrying a live TOTP secret and backup-code hashes: the
  // blocker was that the export stripped only the password, so these leaked.
  const staffEmail = 'staffer@shop.gr';
  await LocalDB.createUser({
    name: 'Staffer', email: staffEmail, role: 'editor', status: 'active',
    password_hash: 'HASH', password_salt: 'SALT', posts_count: 0,
    two_factor: { enabled: true, secret: 'JBSWY3DPEHPK3PXP', backup_codes: ['abc123hash', 'def456hash'] },
  });
  const staffExport = await G.collectSubjectData(staffEmail);
  const staffExportJson = JSON.stringify(staffExport);

  console.log(JSON.stringify({
    staff: {
      hasAccount: !!staffExport.account,
      accountKeys: staffExport.account ? Object.keys(staffExport.account).sort() : null,
      // The property that must hold: nothing 2FA-shaped anywhere in the export.
      leaksSecret: /JBSWY3DPEHPK3PXP|two_factor|backup_codes|abc123hash/.test(staffExportJson),
      leaksPassword: /HASH|SALT|password_hash|password_salt/.test(staffExportJson),
    },
    receipts: {
      count: allReceipts.length,
      newestFirst: allReceipts[0]?.created_at,
      byId: oneReceipt && { granted: oneReceipt.granted, version: oneReceipt.version },
      missing: (await LocalDB.getConsentReceipt('00000000-0000-4000-8000-000000000000')) === null,
      // Nothing identifying may exist on the record AT ALL.
      keys: oneReceipt ? Object.keys(oneReceipt).sort() : null,
    },
    found: {
      email: found.email,
      hasCustomer: !!found.customer,
      orders: found.orders.map((o) => o.number).sort(),
      messages: found.messages.length,
      newsletter: !!found.newsletter,
      accountKeys: found.account ? Object.keys(found.account) : null,
      emails: found.emails.map((e) => e.subject).sort(),
      emailBodiesLogged: found.emails.some((e) => 'text' in e || 'html' in e || 'body' in e),
    },
    erased: {
      ordersAnonymised: erased.ordersAnonymised,
      deleted: erased.deleted,
      notes: erased.notes.join(' | '),
    },
    ordersStillThere: ordersAfter.length,
    keptLinked: keptLinked && {
      total: keptLinked.total_cents,
      items: keptLinked.items?.length,
      itemName: keptLinked.items?.[0]?.name,
      status: keptLinked.status,
      currency: keptLinked.currency,
      email: keptLinked.email,
      name: keptLinked.name,
      phone: keptLinked.phone,
      address: keptLinked.address,
      // The WHOLE objects, serialised. Asserting on named sub-fields is what
      // made the previous version of this test unable to catch a new field
      // being added to an address and never cleared.
      shippingAddress: JSON.stringify(keptLinked.shipping_address ?? null),
      billingAddress: JSON.stringify(keptLinked.billing_address ?? null),
      customerId: keptLinked.customer_id ?? null,
      created: keptLinked.created_at,
      erasedAt: keptLinked.erased_at,
      postcode: keptLinked.shipping_postcode ?? null,
      country: keptLinked.shipping_country ?? null,
      rx: keptLinked.items?.[0]?.prescription ?? null,
      rxIssuer: keptLinked.items?.[0]?.prescription?.issued_by ?? null,
    },
    keptGuestTotal: keptGuest?.total_cents ?? null,
    keptGuestEmail: keptGuest?.email ?? null,
    untouched: untouched && {
      email: untouched.email, name: untouched.name, total: untouched.total_cents,
    },
    subjectCustomerGone: !customersAfter.some((c) => c.email === SUBJECT),
    otherCustomerThere: customersAfter.some((c) => c.email === OTHER),
    subjectMessagesGone: !messagesAfter.some((m) => m.email === SUBJECT),
    otherMessageThere: messagesAfter.some((m) => m.email === OTHER),
    subjectSubGone: !subsAfter.some((s) => s.email === SUBJECT),
    otherSubThere: subsAfter.some((s) => s.email === OTHER),
    emailLogAfter: (await LocalDB.getEmailLog(100)).map((e) => e.to.toLowerCase()).sort(),
    changeFeedDeleted: erased.deleted.changeFeed,
    webhookDeleted: erased.deleted.webhookDeliveries,
    changeFeedAfter: (await LocalDB.getContentChanges()).filter((c) => JSON.stringify(c).includes(SUBJECT)).length,
    subjectWebhookGone: !(await LocalDB.getWebhookDeliveries({ limit: 100 })).some((d) => d.payload.includes(SUBJECT)),
    otherWebhookThere: (await LocalDB.getWebhookDeliveries({ limit: 100 })).some((d) => d.payload.includes(OTHER)),
    exportOperational: found.operational,
    secondRun: {
      ordersAnonymised: again.ordersAnonymised,
      deleted: again.deleted,
      saysNothingFound: /Nothing was found/.test(again.notes.join(' ')),
    },
    // A fresh install's admin — the only address here that HAS a staff
    // account, and therefore the only one that can prove the export strips
    // credentials. Checking that on the subject above proved nothing: their
    // `account` is null, so the assertion could not fail either way.
    staffProbe: await (async () => {
      const admin = (await LocalDB.getUsers()).find((u) => u.role === 'admin');
      if (!admin) return null;
      const exported = await G.collectSubjectData(admin.email);
      const r = await G.eraseSubject(admin.email);
      const stillThere = (await LocalDB.getUsers()).some((u) => u.email === admin.email);
      return {
        flagged: r.staffAccountFound,
        stillThere,
        note: r.notes.join(' | '),
        hasAccount: !!exported.account,
        accountKeys: exported.account ? Object.keys(exported.account) : null,
        // The values themselves, not just the key names: a rename would slip
        // past a key check while still posting the hash to the subject.
        accountValues: exported.account ? JSON.stringify(exported.account) : '',
      };
    })(),
  }));
  process.exit(0);
}

/* ------------------------------------------------------------------ *
 * The parent.                                                         *
 * ------------------------------------------------------------------ */
let pass = 0;
let fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };

const tmpRoot = path.join(os.tmpdir(), `astrobaas-gdpr-test-${process.pid}`);
await fs.mkdir(tmpRoot, { recursive: true });

const DRIVERS = [
  { name: 'lowdb', env: (dir) => ({ DB_PATH: path.join(dir, 'db.json') }) },
  { name: 'libsql', env: (dir) => ({ DATABASE_URL: `file:${path.join(dir, 'db.sqlite')}` }) },
  {
    name: 'relational',
    env: (dir) => ({
      DATABASE_URL: `file:${path.join(dir, 'db.sqlite')}`,
      DATABASE_DRIVER: 'relational',
    }),
  },
];

for (const driver of DRIVERS) {
  const dir = path.join(tmpRoot, driver.name);
  await fs.mkdir(path.join(dir, 'uploads'), { recursive: true });

  const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      GDPR_TEST_CHILD: '1',
      UPLOADS_DIR: path.join(dir, 'uploads'),
      NODE_ENV: 'test',
      ...driver.env(dir),
    },
    maxBuffer: 32 * 1024 * 1024,
  });

  const line = (run.stdout ?? '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
  if (!line) {
    fail++;
    console.error(`✗ [${driver.name}] the gdpr child produced no result`);
    console.error((run.stderr ?? '').split('\n').slice(-15).join('\n'));
    continue;
  }
  const r = JSON.parse(line);
  const t = (n, c) => check(`[${driver.name}] ${n}`, c);

  /* --- the export must not leak a staff account's 2FA material --- */
  t('a staff account IS exported (so the next check bites)', r.staff.hasAccount === true);
  t('the export leaks NO 2FA secret or backup codes — the blocker', r.staff.leaksSecret === false);
  t('...and no password hash or salt', r.staff.leaksPassword === false);
  t('the exported account carries only an allow-list of safe fields',
    Array.isArray(r.staff.accountKeys)
    && r.staff.accountKeys.every((k) => ['id','name','email','role','status','avatar','last_login','created_at','updated_at'].includes(k)));

  /* --- the transient snapshot stores are searched and purged --- */
  t('the export REPORTS the change-feed and webhook records that mention the address',
    r.exportOperational.changeFeed >= 1 && r.exportOperational.webhookDeliveries >= 1);
  t('erasure purges the change-feed snapshot', r.changeFeedDeleted >= 1 && r.changeFeedAfter === 0);
  t('erasure purges the subject webhook delivery', r.webhookDeleted >= 1 && r.subjectWebhookGone === true);
  t('...and leaves another person\'s webhook delivery alone', r.otherWebhookThere === true);

  /* --- consent receipts --- */
  t('a receipt is stored and read back', !!r.receipts.byId);
  t('a retried POST does not create a second receipt', r.receipts.count === 2);
  t('...and the FIRST decision is the one kept, not the retry',
    r.receipts.byId?.granted?.join() === 'necessary,analytics');
  t('receipts come back newest first', r.receipts.newestFirst === '2026-02-01T00:00:00.000Z');
  t('an unknown receipt id returns nothing rather than throwing', r.receipts.missing === true);
  // The whole design: a receipt proves a decision happened and says nothing
  // about who made it. A field added here later that carries an IP or a user
  // agent fails this.
  t('a receipt carries ONLY the decision — no address, no fingerprint, no id of a person',
    r.receipts.keys?.join() === 'created_at,granted,id,version');

  /* --- finding everything --- */
  t('the lookup is case- and whitespace-insensitive', r.found.email === 'maria@example.com');
  t('the customer record is found', r.found.hasCustomer === true);
  t('BOTH orders are found — the linked one and the one placed as a guest',
    r.found.orders.join() === 'GDPR-1,GDPR-2');
  t('the contact message is found', r.found.messages === 1);
  t('the newsletter subscription is found', r.found.newsletter === true);
  // Case-insensitively: the log records the address as the sender wrote it.
  t('emails sent to the address are found, whatever case they were logged in',
    r.found.emails.join() === 'A retry,Your order');
  t('...and the log never held the message bodies', r.found.emailBodiesLogged === false);
  t('no other person is swept in', !r.found.orders.includes('GDPR-3'));

  /* --- erasure: the half that must SURVIVE --- */
  t('the orders are still there — a shop must be able to produce its accounts',
    r.ordersStillThere === 3);
  t('the total is untouched', r.keptLinked?.total === 19900);
  t('the line items are untouched', r.keptLinked?.items === 1 && r.keptLinked?.itemName === 'Titanium frame');
  t('the status and currency are untouched',
    r.keptLinked?.status === 'completed' && r.keptLinked?.currency === 'EUR');
  t('the order date is untouched', typeof r.keptLinked?.created === 'string');

  /* --- erasure: the half that must be GONE --- */
  t('the buyer name is replaced', !/Maria/.test(r.keptLinked?.name ?? ''));
  t('the buyer email is replaced', r.keptLinked?.email !== 'maria@example.com');
  t('the phone number is gone', !r.keptLinked?.phone);
  t('the postal address is gone', !r.keptLinked?.address);
  /*
   * The STRUCTURED addresses go whole.
   *
   * Asserted as a serialised blob and searched for the identity strings, rather
   * than field by field: a per-field assertion passes forever after somebody
   * adds an eleventh field to Address and forgets to clear it, which is the
   * exact shape that let a company name and a ΑΦΜ survive an erasure here.
   */
  t('the structured shipping address is gone', r.keptLinked?.shippingAddress === 'null');
  t('the structured billing address is gone', r.keptLinked?.billingAddress === 'null');
  t('...so no identifying string survives anywhere in them', !/Maria|Maria Ltd|123456789|Some Street/
    .test(`${r.keptLinked?.shippingAddress} ${r.keptLinked?.billingAddress}`));
  t('the link to the deleted customer record is gone — no dangling id',
    !r.keptLinked?.customerId);
  t('the GUEST order is anonymised too', r.keptGuestEmail !== 'maria@example.com');
  // Per-order tokens: a shared placeholder re-links a subject's orders to each
  // other, and the one this used to write was a published constant that opened
  // the public order lookup.
  t('each erased order carries a DIFFERENT address',
    r.keptLinked?.email !== r.keptGuestEmail);
  t('...and neither is the old shared constant',
    !/erased@erased\.invalid/.test(`${r.keptLinked?.email} ${r.keptGuestEmail}`));
  t('...and both are inert addresses that can never receive mail',
    /@invalid$/.test(r.keptLinked?.email ?? '') && /@invalid$/.test(r.keptGuestEmail ?? ''));
  // The gate the public lookup reads.
  t('every erased order is marked, so no public path can reach it',
    /^\d{4}-\d{2}-\d{2}$/.test(r.keptLinked?.erasedAt ?? ''));
  t('the postcode is gone through the storage layer, not just in the patch',
    !r.keptLinked?.postcode);
  // The country stays: it is the VAT place of supply, and `tax_cents` cannot be
  // explained to an inspector without it.
  t('...but the country stays, because VAT needs it', r.keptLinked?.country === 'GR');

  // THE PRESCRIPTION SURVIVES — an owner decision, and the reverse of what this
  // function used to do. An optician has a professional obligation to keep the
  // practitioner's γνωμάτευση, and it is the record that settles a dispute
  // about a remake; Article 17(3)(b) covers retention required by law. It is
  // defensible only because everything IDENTIFYING is gone by now, which the
  // assertions above check, so what remains is a measurement against an order
  // number. Removing one is a deliberate act on the orders screen.
  //
  // This behaviour had NO test in either direction before now.
  t('the prescription is RETAINED through an erasure (Art 17(3)(b))',
    r.keptLinked?.rx && typeof r.keptLinked.rx === 'object');
  t('...intact, not a hollowed-out object',
    r.keptLinked?.rxIssuer === 'Dr Papadopoulos');
  // ...and the report SAYS so, because an operator answering a supervisory
  // authority cannot defend a retention the report never mentioned.
  t('...and the report declares the retained health data',
    /Article 9/.test(r.erased.notes) && /RETAINED/.test(r.erased.notes));
  t('...and its total survives', r.keptGuestTotal === 4500);
  t('both orders were reported as anonymised', r.erased.ordersAnonymised === 2);
  t('the report EXPLAINS why orders were kept',
    /Article 17\(3\)\(b\) and \(e\)/.test(r.erased.notes));
  // The report is a sentence an operator may repeat to a supervisory
  // authority, so it must not call these records anonymous. They are not: the
  // payment reference still resolves to the buyer inside the payment provider,
  // and Recital 26 asks whether identification is possible by any means
  // reasonably likely — a dashboard the operator logs into daily is.
  // It must SAY pseudonymised, and must not CLAIM anonymity. The word
  // "anonymous" legitimately appears in the phrase "not anonymous", so the
  // check is on the claim, not the word — the first version failed on the
  // very sentence that gets this right.
  t('...and does NOT claim they are anonymous',
    /PSEUDONYMISED/i.test(r.erased.notes)
    && !/\b(are|is|were|was)\s+anonymous\b/i.test(r.erased.notes)
    && !/\banonymised\b/i.test(r.erased.notes));

  /* --- everything else is deleted --- */
  t('the customer record is deleted', r.subjectCustomerGone === true);
  t('the message is deleted', r.subjectMessagesGone === true);
  t('the newsletter subscription is deleted', r.subjectSubGone === true);
  t('the send log for that address is deleted', !r.emailLogAfter.includes('maria@example.com'));
  t('...and only that address — the log is not emptied',
    r.emailLogAfter.includes('someone.else@example.com'));
  t('the report counts the log entries it removed', r.erased.deleted.emails === 2);
  t('the report counts what it deleted',
    r.erased.deleted.customers === 1 && r.erased.deleted.messages === 1 && r.erased.deleted.newsletter === 1);

  /* --- and nobody else is touched --- */
  t('another person’s order is completely untouched',
    r.untouched?.email === 'someone.else@example.com' && r.untouched?.name === 'Someone Else');
  t('another person’s customer record survives', r.otherCustomerThere === true);
  t('another person’s message survives', r.otherMessageThere === true);
  t('another person’s subscription survives', r.otherSubThere === true);

  /* --- running it twice --- */
  t('a second erasure finds nothing left to do',
    r.secondRun.ordersAnonymised === 0 && r.secondRun.deleted.customers === 0);
  t('...and says so plainly rather than reporting success', r.secondRun.saysNothingFound === true);

  /* --- staff accounts --- */
  if (r.staffProbe) {
    /* --- the export must not carry credentials --- */
    t('the staff account IS exported, so this check has something to bite on',
      r.staffProbe.hasAccount === true);
    t('an exported account carries no password hash',
      !r.staffProbe.accountKeys.includes('password_hash'));
    t('...and no salt', !r.staffProbe.accountKeys.includes('password_salt'));
    t('...and no hash-shaped value survives under any other name',
      !/password|hash|salt/i.test(r.staffProbe.accountValues));

    t('an address with a staff account is FLAGGED', r.staffProbe.flagged === true);
    t('...and the account is not deleted behind the operator’s back',
      r.staffProbe.stillThere === true);
    t('...with a note saying why', /orphans/.test(r.staffProbe.note));
  }
}

await fs.rm(tmpRoot, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
