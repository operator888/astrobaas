#!/usr/bin/env node
/**
 * Public form uploads: orphans are cleaned up and each form has a disk quota
 * (S5.8).
 *
 * ## The bugs
 *
 *   - A form uploads its file first and submits the record naming it second.
 *     Every abandoned form — and every bot that found the upload endpoint —
 *     left bytes behind forever: the only delete started from a submission.
 *   - Nothing bounded the total. Five uploads per IP per quarter hour bounds
 *     one client, not a thousand, and a full disk takes the database with it.
 *
 * ## What must hold, because what is deleted is a customer's file
 *
 *   - an attached file is never swept — including when the form's plugin is
 *     switched off, and when the id sits inside a repeater;
 *   - a file younger than the grace period is never swept;
 *   - a file written before forms were recorded is never swept;
 *   - a lookup that FAILS deletes nothing;
 *   - the quota is exact under concurrent uploads, and a repeat of bytes
 *     already stored costs nothing.
 *
 * All on disk, in a temporary directory; the database half per driver.
 *
 * Run with:  node tests/form-uploads.test.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTs, ROOT } from './lib/load.mjs';

const HOUR = 60 * 60 * 1000;
const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** A distinct "PNG" of `size` bytes. Sniffing only reads the magic bytes. */
const png = (seed, size = 64) => {
  const b = Buffer.alloc(size, seed % 256);
  PNG_HEAD.copy(b, 0);
  b.writeUInt32BE(seed, 8);
  return b;
};

/** Rewrite a sidecar's created_at, as if the upload happened `hours` ago. */
async function age(root, id, hours, now = Date.now()) {
  for (const y of await fs.readdir(root)) {
    for (const m of await fs.readdir(path.join(root, y)).catch(() => [])) {
      const p = path.join(root, y, m, `${id}.json`);
      const raw = await fs.readFile(p, 'utf8').catch(() => null);
      if (!raw) continue;
      const meta = JSON.parse(raw);
      meta.created_at = new Date(now - hours * HOUR).toISOString();
      await fs.writeFile(p, JSON.stringify(meta));
    }
  }
}
async function exists(root, file) {
  return fs.stat(path.join(root, file.rel)).then(() => true, () => false);
}

/* ---------------------------------------------------------------- child --- */
if (process.env.FORM_UPLOADS_CHILD) {
  const entry = path.join(ROOT, 'node_modules', '.cache', `form-uploads-entry-${process.pid}.ts`);
  await fs.mkdir(path.dirname(entry), { recursive: true });
  const abs = (rel) => JSON.stringify(path.join(ROOT, rel));
  await fs.writeFile(entry, [
    `export { LocalDB } from ${abs('src/lib/localdb.ts')};`,
    `export * from ${abs('src/lib/media/private-files.ts')};`,
    `export { sweepOrphanFormUploads, _resetOrphanSweepClock } from ${abs('src/lib/media/private-files-sweep.ts')};`,
    `export { registerContentType } from ${abs('src/core/content-types.ts')};`,
    `export { POST as uploadPOST } from ${abs('src/pages/api/forms/[type]/upload.ts')};`,
  ].join('\n'));
  let M;
  try {
    M = await loadTs(path.relative(ROOT, entry), 'formuploads');
  } finally {
    await fs.rm(entry, { force: true });
  }
  const root = process.env.PRIVATE_UPLOADS_DIR;
  const { LocalDB } = M;
  await LocalDB.init();

  M.registerContentType({
    name: 'job-application', label: 'Application', visibility: 'staff', writable: 'public',
    fields: [
      { name: 'cv', rule: { type: 'file', optional: true } },
      { name: 'extras', rule: { type: 'repeater', optional: true, of: [{ name: 'doc', rule: { type: 'file', optional: true } }] } },
    ],
  });

  const store = async (seed, form) => (await M.storePrivateFile(png(seed), `f${seed}.png`, { form })).file;
  const attached = await store(1, 'job-application');
  const nested = await store(2, 'job-application');
  const orphan = await store(3, 'job-application');
  const young = await store(4, 'job-application');
  // A form whose plugin is NOT registered in this process: its records still exist.
  const unregistered = await store(5, 'retired-form');
  const unregisteredOrphan = await store(6, 'retired-form');
  const legacy = await store(7, undefined);

  await LocalDB.createCustomEntity('job-application', { cv: attached.id });
  await LocalDB.createCustomEntity('job-application', { extras: [{ doc: nested.id }] });
  await LocalDB.createCustomEntity('retired-form', { attachment: unregistered.id });

  for (const f of [attached, nested, orphan, unregistered, unregisteredOrphan, legacy]) {
    await age(root, f.id, 48);
  }
  await age(root, young.id, 1);

  // Right after load the sweep holds off for an interval: the registry of forms
  // is not populated until the first request bootstraps the plugins.
  const atBoot = await M.sweepOrphanFormUploads(Date.now());
  const presentAtBoot = await exists(root, orphan);
  M._resetOrphanSweepClock();
  const first = await M.sweepOrphanFormUploads(Date.now());
  const throttled = await M.sweepOrphanFormUploads(Date.now() + 60_000);
  const present = {};
  for (const [k, f] of Object.entries({ attached, nested, orphan, young, unregistered, unregisteredOrphan, legacy })) {
    present[k] = await exists(root, f);
  }
  const metaGone = (await M.readPrivateFileMeta(orphan.id)) === null;

  // A storage failure mid-sweep deletes NOTHING.
  const victim = await store(8, 'job-application');
  await age(root, victim.id, 48);
  const realGet = LocalDB.getCustomEntities.bind(LocalDB);
  LocalDB.getCustomEntities = async () => { throw new Error('database unavailable'); };
  const failed = await M.sweepOrphanFormUploads(Date.now(), { force: true });
  LocalDB.getCustomEntities = realGet;
  const victimSurvived = await exists(root, victim);

  // The upload route: a 1 MB quota for this form.
  await LocalDB.updateSetting(M.FORM_UPLOAD_QUOTA_KEY, 1);
  const upload = async (seed, size, ip) => {
    const form = new FormData();
    form.append('file', new Blob([png(seed, size)], { type: 'image/png' }), `u${seed}.png`);
    const url = new URL('http://cms.test/api/forms/job-application/upload');
    const res = await M.uploadPOST({
      url, params: { type: 'job-application' }, locals: { user: null, ip },
      request: new Request(url, { method: 'POST', body: form }),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const u1 = await upload(100, 600 * 1024, '10.2.0.1');
  const u2 = await upload(101, 600 * 1024, '10.2.0.2');
  const u1again = await upload(100, 600 * 1024, '10.2.0.3');

  console.log('__RESULT__' + JSON.stringify({
    atBoot, presentAtBoot,
    first, throttled, present, metaGone, failed, victimSurvived,
    u1: { status: u1.status, id: u1.body?.data?.id ?? null },
    u2: { status: u2.status, reason: u2.body?.error?.reason ?? null, code: u2.body?.error?.code ?? null,
      message: u2.body?.error?.message ?? null },
    u1again: u1again.status,
  }));
  process.exit(0);
}

/* --------------------------------------------------------------- parent --- */
let pass = 0;
let fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astrobaas-form-uploads-'));
process.env.PRIVATE_UPLOADS_DIR = dir;
const P = await loadTs('src/lib/media/private-files.ts');

/* ---- settings ---- */
{
  check('default quota is 1 GiB', P.resolveFormUploadQuota({}) === 1024 * 1024 * 1024);
  check('the setting is in MB', P.resolveFormUploadQuota({ form_upload_quota_mb: '5' }) === 5 * 1024 * 1024);
  check('0 means no quota', P.resolveFormUploadQuota({ form_upload_quota_mb: 0 }) === undefined);
  check('a negative value is a mistake, not "off"', P.resolveFormUploadQuota({ form_upload_quota_mb: -1 }) === 1024 * 1024 * 1024);
  check('nonsense falls back', P.resolveFormUploadQuota({ form_upload_quota_mb: 'big' }) === 1024 * 1024 * 1024);
  check('default grace period is 24 h', P.resolveOrphanMaxAgeMs({}) === 24 * HOUR);
  check('the grace period is at least an hour', P.resolveOrphanMaxAgeMs({ form_upload_orphan_hours: 0 }) === HOUR);
  check('the grace period is tunable', P.resolveOrphanMaxAgeMs({ form_upload_orphan_hours: 6 }) === 6 * HOUR);
}

/* ---- the quota, on disk ---- */
{
  const Q = 200; // bytes
  const ok1 = await P.storePrivateFile(png(10, 80), 'a.png', { form: 'quota-form', quotaBytes: Q });
  const ok2 = await P.storePrivateFile(png(11, 80), 'b.png', { form: 'quota-form', quotaBytes: Q });
  check('uploads under the quota are stored', ok1.ok && ok2.ok);
  check('the form is recorded with the file', ok1.file.form === 'quota-form');
  check('usage is the sum of the form\'s files', await P.formUsageBytes('quota-form') === 160);
  const over = await P.storePrivateFile(png(12, 80), 'c.png', { form: 'quota-form', quotaBytes: Q });
  check('THE BUG: an upload past the quota is refused', !over.ok && over.reason === 'quota');
  check('...with the stable message', over.error === P.QUOTA_EXCEEDED_MESSAGE);
  check('...and a stable reason code', P.QUOTA_EXCEEDED_REASON === 'forms.upload_quota_exceeded');
  check('...and nothing is written', (await P.listPrivateFiles()).every((f) => !f.original_name.startsWith('c.')));
  const again = await P.storePrivateFile(png(10, 80), 'a-again.png', { form: 'quota-form', quotaBytes: Q });
  check('bytes already stored cost nothing, even at the quota', again.ok);
  check('...and are not counted twice', await P.formUsageBytes('quota-form') === 160);
  const elsewhere = await P.storePrivateFile(png(13, 80), 'd.png', { form: 'other-form', quotaBytes: Q });
  check('another form has its own quota', elsewhere.ok);
  const unlimited = await P.storePrivateFile(png(14, 80), 'e.png', { form: 'quota-form' });
  check('no quotaBytes means no quota', unlimited.ok);
  const legacyCall = await P.storePrivateFile(png(15, 80), 'f.png');
  check('the old two-argument call still works, unrecorded', legacyCall.ok && legacyCall.file.form === undefined);

  // Concurrency: ten distinct files racing for room for five.
  const racing = await Promise.all(Array.from({ length: 10 }, (_, i) =>
    P.storePrivateFile(png(200 + i, 100), `r${i}.png`, { form: 'race-form', quotaBytes: 500 })));
  check('racing uploads never overfill the quota',
    racing.filter((r) => r.ok).length === 5 && await P.formUsageBytes('race-form') === 500);

  // A deletion frees room.
  const r0 = racing.find((r) => r.ok);
  await P.deletePrivateFile(r0.file.id);
  check('deleting a file frees its room', await P.formUsageBytes('race-form') === 400);
}

/* ---- the sweep, on disk, with the lookup injected ---- */
{
  const now = Date.now();
  const mk = async (seed, form) => (await P.storePrivateFile(png(seed), `s${seed}.png`, { form })).file;
  const oldOrphan = await mk(300, 'sweep-form');
  const oldAttached = await mk(301, 'sweep-form');
  const youngOrphan = await mk(302, 'sweep-form');
  const oldLegacy = await mk(303, undefined);
  for (const f of [oldOrphan, oldAttached, oldLegacy]) await age(dir, f.id, 30, now);
  await age(dir, youngOrphan.id, 2, now);

  let askedFor = null;
  const res = await P.sweepOrphanPrivateFiles({
    now, maxAgeMs: 24 * HOUR,
    referencedIds: async (forms) => { askedFor = [...forms]; return new Set([oldAttached.id]); },
  });
  check('an old unattached upload is removed', !(await exists(dir, oldOrphan)));
  check('...sidecar and all', (await P.readPrivateFileMeta(oldOrphan.id)) === null);
  check('an old ATTACHED upload is kept', await exists(dir, oldAttached));
  check('a YOUNG unattached upload is kept', await exists(dir, youngOrphan));
  check('an upload with no recorded form is kept', await exists(dir, oldLegacy));
  check('the lookup is asked about the candidates\' forms', JSON.stringify(askedFor) === '["sweep-form"]');
  check('the result counts both', res.removed >= 1 && res.attached >= 1 && !res.error);

  // Failure: delete nothing.
  const doomed = await mk(304, 'sweep-form');
  await age(dir, doomed.id, 30, now);
  const failed = await P.sweepOrphanPrivateFiles({
    now, maxAgeMs: 24 * HOUR,
    referencedIds: async () => { throw new Error('db down'); },
  });
  check('a failed lookup deletes NOTHING', await exists(dir, doomed) && failed.removed === 0 && /db down/.test(failed.error));

  // A sidecar pointing outside the root is never followed.
  const outside = path.join(os.tmpdir(), `astrobaas-outside-${process.pid}.png`);
  await fs.writeFile(outside, 'keep me');
  const evil = await mk(305, 'sweep-form');
  for (const y of await fs.readdir(dir)) {
    for (const m of await fs.readdir(path.join(dir, y)).catch(() => [])) {
      const p = path.join(dir, y, m, `${evil.id}.json`);
      const raw = await fs.readFile(p, 'utf8').catch(() => null);
      if (!raw) continue;
      const meta = JSON.parse(raw);
      meta.rel = path.relative(dir, outside);
      meta.created_at = new Date(now - 30 * HOUR).toISOString();
      await fs.writeFile(p, JSON.stringify(meta));
    }
  }
  await P.sweepOrphanPrivateFiles({ now, maxAgeMs: 24 * HOUR, referencedIds: async () => new Set() });
  check('a sidecar cannot aim the sweep outside the private root',
    await fs.readFile(outside, 'utf8').then((t) => t === 'keep me', () => false));
  await fs.rm(outside, { force: true });

  // Ids are found anywhere in a record, not through field definitions.
  const ids = P.privateFileIdsIn({ a: 'pf_0123456789abcdef0123', list: [{ doc: 'pf_aaaaaaaaaaaaaaaaaaaa' }], n: 3 });
  check('ids are found at the top level and nested',
    ids.includes('pf_0123456789abcdef0123') && ids.includes('pf_aaaaaaaaaaaaaaaaaaaa'));
  check('nothing is found in nothing', P.privateFileIdsIn(null).length === 0 && P.privateFileIdsIn('x').length === 0);
}
await fs.rm(dir, { recursive: true, force: true });

/* ---- the database half and the route, per driver ---- */
const here = path.dirname(fileURLToPath(import.meta.url));
const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'astrobaas-form-uploads-db-'));
const DRIVERS = [
  { name: 'lowdb', env: (d) => ({ DB_PATH: path.join(d, 'db.json') }) },
  { name: 'libsql', env: (d) => ({ DATABASE_URL: `file:${path.join(d, 'db.sqlite')}` }) },
  { name: 'relational', env: (d) => ({ DATABASE_URL: `file:${path.join(d, 'db.sqlite')}`, DATABASE_DRIVER: 'relational' }) },
];
for (const driver of DRIVERS) {
  const d = path.join(tmpRoot, driver.name);
  await fs.mkdir(path.join(d, 'uploads'), { recursive: true });
  await fs.mkdir(path.join(d, 'private'), { recursive: true });
  const env = { ...process.env };
  delete env.RATE_LIMIT_STORE;
  const run = spawnSync(process.execPath, [path.join(here, 'form-uploads.test.mjs')], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 180_000,
    env: {
      ...env, FORM_UPLOADS_CHILD: '1', NODE_ENV: 'test',
      UPLOADS_DIR: path.join(d, 'uploads'), PRIVATE_UPLOADS_DIR: path.join(d, 'private'),
      ...driver.env(d),
    },
  });
  const line = (run.stdout || '').split('\n').find((l) => l.startsWith('__RESULT__'));
  if (!line) {
    fail++;
    console.error(`✗ [${driver.name}] child produced no result\n${(run.stderr || '').slice(-1200)}`);
    continue;
  }
  const r = JSON.parse(line.slice('__RESULT__'.length));
  const t = (n, c) => check(`[${driver.name}] ${n}`, c);
  t('sweep: does not run on the tick the process boots', r.atBoot === null && r.presentAtBoot);
  t('sweep: removes exactly the two old orphans', r.first?.removed === 2 && !r.first?.error);
  t('sweep: an attached file stays', r.present.attached);
  t('sweep: a file named inside a repeater stays', r.present.nested);
  t('sweep: THE BUG — the old orphan is gone', !r.present.orphan && r.metaGone);
  t('sweep: a young orphan stays', r.present.young);
  t('sweep: a file attached to an UNREGISTERED form stays', r.present.unregistered);
  t('sweep: ...while that form\'s own orphan goes', !r.present.unregisteredOrphan);
  t('sweep: a legacy file with no recorded form stays', r.present.legacy);
  t('sweep: runs at most once an hour', r.throttled === null);
  t('sweep: a failing database deletes nothing', r.victimSurvived && r.failed?.removed === 0 && !!r.failed?.error);
  t('route: an upload under the quota is 201', r.u1.status === 201 && /^pf_/.test(r.u1.id ?? ''));
  t('route: THE BUG — past the quota is 413 with a stable reason',
    r.u2.status === 413 && r.u2.reason === 'forms.upload_quota_exceeded');
  t('route: ...not a 5xx-coded error', r.u2.code === 'BAD_REQUEST');
  t('route: re-sending stored bytes is still accepted at the quota', r.u1again === 201);
}
await fs.rm(tmpRoot, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
