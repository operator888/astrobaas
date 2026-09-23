#!/usr/bin/env node
/**
 * The audit-log filter spec (src/core/audit-query.ts).
 *
 * This is one rule with two implementations — a JS filter for the document
 * drivers and SQL for the relational one — which is the shape that already
 * produced a silent bug here once (`?locale=`, where both were wrong in the
 * same direction). These assertions pin the SPEC; tests/smoke.mjs compares the
 * two implementations against each other on real data.
 *
 * Run with:  node tests/audit-query.test.mjs
 */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cacheDir = path.join(here, '..', 'node_modules', '.cache');
await fs.mkdir(cacheDir, { recursive: true });
const out = path.join(cacheDir, `astrobaas-auditq-${process.pid}.mjs`);
await build({
  entryPoints: [path.join(here, '..', 'src/core/audit-query.ts')],
  bundle: true, format: 'esm', platform: 'node', packages: 'external',
  outfile: out, logLevel: 'silent',
});
const { applyAuditQuery, auditEventMatches, normalizeBound } = await import(pathToFileURL(out).href);
await fs.rm(out, { force: true });

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) pass++; else { fail++; console.error(`✗ ${name}`); } };

const ev = (id, action, actor, created_at) => ({ id, action, actor, created_at, target: null, ip: '1.2.3.4' });
const EVENTS = [
  ev('a', 'auth.login.success', 'user-maria', '2026-08-20T09:00:00.000Z'),
  ev('b', 'auth.login.failed',  'user-maria', '2026-08-21T10:00:00.000Z'),
  ev('c', 'payment.refund.issued', 'user-kostas', '2026-08-22T11:00:00.000Z'),
  ev('d', 'user.update', 'apikey:AB12CD34', '2026-08-24T23:30:00.000Z'),
  ev('e', 'auth.2fa.enabled', 'USER-Maria', '2026-08-24T08:00:00.000Z'),
];

/* ---------------- action is a PREFIX ---------------- */
{
  const ids = (q) => applyAuditQuery(EVENTS, q).map((e) => e.id);
  check('a full action still matches itself exactly',
    JSON.stringify(ids({ action: 'auth.login.failed' })) === JSON.stringify(['b']));
  // The reason for prefix matching: an admin should not need the whole
  // vocabulary before they can look at anything.
  check('"auth." matches every authentication event',
    JSON.stringify(ids({ action: 'auth.' }).sort()) === JSON.stringify(['a', 'b', 'e']));
  check('"auth.login." narrows to logins',
    JSON.stringify(ids({ action: 'auth.login.' }).sort()) === JSON.stringify(['a', 'b']));
  check('an unmatched prefix returns nothing, not everything', ids({ action: 'nope.' }).length === 0);
  check('a blank action is not a filter', ids({ action: '   ' }).length === EVENTS.length);
}

/* ---------------- actor is a case-insensitive SUBSTRING ---------------- */
{
  const ids = (q) => applyAuditQuery(EVENTS, q).map((e) => e.id).sort();
  check('actor matches regardless of case',
    JSON.stringify(ids({ actor: 'user-maria' })) === JSON.stringify(['a', 'b', 'e']));
  check('actor matches on a partial id',
    JSON.stringify(ids({ actor: 'maria' })) === JSON.stringify(['a', 'b', 'e']));
  // API keys record `apikey:<id>` — a partial is what someone actually has to
  // hand when following up on one line in the table.
  check('an API-key actor is findable by part of its id',
    JSON.stringify(ids({ actor: 'AB12' })) === JSON.stringify(['d']));
  check('an unmatched actor returns nothing', ids({ actor: 'nobody' }).length === 0);
}

/* ---------------- dates, and the trap in the upper bound ---------------- */
{
  const ids = (q) => applyAuditQuery(EVENTS, q).map((e) => e.id).sort();
  check('from is inclusive',
    JSON.stringify(ids({ from: '2026-08-22' })) === JSON.stringify(['c', 'd', 'e']));

  // THE bug this normalisation exists to prevent. A date input yields
  // "2026-08-24", which as an instant is midnight — used raw as an upper bound
  // it excludes almost all of that day. Event 'd' is at 23:30 on the 24th.
  check('to is inclusive of the WHOLE day, not midnight',
    JSON.stringify(ids({ to: '2026-08-24' })) === JSON.stringify(['a', 'b', 'c', 'd', 'e']));
  check('normalizeBound pushes a date-only upper bound to end of day',
    normalizeBound('2026-08-24', 'end') === '2026-08-24T23:59:59.999Z');
  check('…and leaves a lower bound at midnight',
    normalizeBound('2026-08-24', 'start') === '2026-08-24T00:00:00.000Z');
  check('a full timestamp is passed through untouched',
    normalizeBound('2026-08-24T12:00:00.000Z', 'end') === '2026-08-24T12:00:00.000Z');
  check('an empty bound is not a filter',
    normalizeBound('', 'end') === undefined && normalizeBound(undefined, 'start') === undefined);

  check('a range bounds both ends',
    JSON.stringify(ids({ from: '2026-08-21', to: '2026-08-22' })) === JSON.stringify(['b', 'c']));
}

/* ---------------- ordering and the cap ---------------- */
{
  const ordered = applyAuditQuery(EVENTS, {}).map((e) => e.id);
  check('newest first', ordered[0] === 'd' && ordered[ordered.length - 1] === 'a');

  // Ordering must happen BEFORE the cap. Capping first returns an arbitrary
  // subset and then sorts it — which looks identical and is wrong.
  const capped = applyAuditQuery(EVENTS, { limit: 2 }).map((e) => e.id);
  check('the cap keeps the NEWEST, not the first found',
    JSON.stringify(capped) === JSON.stringify(['d', 'e']));
  check('limit 0 is not a cap', applyAuditQuery(EVENTS, { limit: 0 }).length === EVENTS.length);

  // Two events in the same millisecond must come back in a stable order, or the
  // cross-driver comparison reports two correct answers as different.
  const tie = [ev('x', 'a.b', 'u', '2026-08-25T00:00:00.000Z'), ev('y', 'a.b', 'u', '2026-08-25T00:00:00.000Z')];
  const once = applyAuditQuery(tie, {}).map((e) => e.id);
  const twice = applyAuditQuery([...tie].reverse(), {}).map((e) => e.id);
  check('ties break on id, so the order is stable across drivers',
    JSON.stringify(once) === JSON.stringify(twice));
}

/* ---------------- combining, and robustness ---------------- */
{
  const combined = applyAuditQuery(EVENTS, { action: 'auth.', actor: 'maria', from: '2026-08-21' });
  check('filters combine as AND',
    JSON.stringify(combined.map((e) => e.id).sort()) === JSON.stringify(['b', 'e']));
  check('no query returns everything', applyAuditQuery(EVENTS).length === EVENTS.length);
  check('a malformed event does not throw',
    auditEventMatches({}, { action: 'auth.' }) === false
    && auditEventMatches({ action: 'auth.x', actor: null, created_at: null }, {}) === true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
