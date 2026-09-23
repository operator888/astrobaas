#!/usr/bin/env node
/**
 * The two sweeps that send mail to a customer: the unpaid-order reminder and
 * the back-in-stock notice.
 *
 * Both are governed by pure predicates, and every `false` in them is a message
 * NOT sent to a real person — so each reason is asserted separately rather than
 * folded into one "it works" check.
 *
 * Run with:  node tests/recovery-restock.test.mjs
 */
import { loadTs } from './lib/load.mjs';

const A = await loadTs('src/lib/commerce/abandonment.ts');
const W = await loadTs('src/lib/commerce/stock-waitlist.ts');

let pass = 0;
let fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };

const HOUR = 3_600_000;
const NOW = Date.parse('2026-06-10T12:00:00.000Z');
const agoH = (h) => new Date(NOW - h * HOUR).toISOString();

const abandon3 = { enabled: true, days: 3 };
const on = { enabled: true, afterHours: 24 };
const order = (o = {}) => ({
  id: 'o1', status: 'pending', payment_status: 'unpaid', payment_method: 'bank-transfer',
  email: 'buyer@example.com', created_at: agoH(30), ...o,
});

/* ------------------------------------------------------- recovery settings */
{
  check('recovery is OFF unless an operator turns it on',
    A.resolveRecoverySettings({}, abandon3).enabled === false);
  check('...and the string "true" turns it on, like every other toggle',
    A.resolveRecoverySettings({ [A.ABANDONMENT_KEYS.recoveryEnabled]: 'true' }, abandon3).enabled === true);
  check('an unset delay uses the documented default',
    A.resolveRecoverySettings({}, abandon3).afterHours === A.DEFAULT_RECOVERY_HOURS);

  // THE CLAMP. A reminder due after the order has already been cancelled is a
  // message about something that no longer exists.
  const late = A.resolveRecoverySettings({
    [A.ABANDONMENT_KEYS.recoveryEnabled]: true,
    [A.ABANDONMENT_KEYS.recoveryAfterHours]: 240,   // 10 days
  }, { enabled: true, days: 3 });                    // cancelled after 3
  check('a reminder cannot be scheduled after the cancellation', late.afterHours < 3 * 24);
  check('...and is pulled below it rather than refused', late.afterHours === 71);
}

/* ------------------------------------------------------- who gets reminded */
{
  const remind = (o, rec = on, ab = abandon3) => A.shouldRemind(order(o), ab, rec, NOW);

  check('an unpaid order older than the delay is reminded', remind({}) === true);
  check('...but not before the delay', remind({ created_at: agoH(2) }) === false);
  check('off means nothing is sent', remind({}, { enabled: false, afterHours: 24 }) === false);

  // Once. And the guard has to hold even when the send failed.
  check('a reminder is sent ONCE', remind({ recovery_sent_at: agoH(1) }) === false);

  check('a paid order is never chased', remind({ payment_status: 'paid' }) === false);
  check('a cancelled order is never chased', remind({ status: 'cancelled' }) === false);
  check('a completed order is never chased', remind({ status: 'completed' }) === false);
  check('an order with no address cannot be reminded',
    remind({ email: '' }) === false && remind({ email: 'nonsense' }) === false);

  // An IMPORTED order's dates describe the old shop's history, so every one of
  // them looks overdue on the day of the migration. The cancellation sweep
  // excludes them for the same reason; missing it here would mail an entire
  // migrated customer base at once.
  check('an IMPORTED order is never reminded', remind({ wp_id: 'wp-1' }) === false);

  // Too late: the same tick would cancel it.
  check('an order already due for cancellation is not reminded',
    remind({ created_at: agoH(24 * 4) }) === false);

  check('a future-dated order (clock skew) is not reminded',
    remind({ created_at: new Date(NOW + HOUR).toISOString() }) === false);

  const many = [order({ id: 'a' }), order({ id: 'b', payment_status: 'paid' }),
                order({ id: 'c', recovery_sent_at: agoH(1) })];
  check('selection picks exactly the ones that qualify',
    A.selectForReminder(many, abandon3, on, NOW).map((o) => o.id).join() === 'a');
}

/* ------------------------------------------------------------- back in stock */
{
  const p = (o = {}) => ({ status: 'active', stock: 5, manage_stock: true, in_stock: true, ...o });

  check('an active product with stock is back', W.isBackInStock(p()) === true);
  check('no stock is not back', W.isBackInStock(p({ stock: 0 })) === false);

  // Stricter than `in_stock` on purpose: telling somebody an item is back when
  // the page 404s is worse than saying nothing.
  check('a draft product is NOT announced', W.isBackInStock(p({ status: 'draft' })) === false);
  check('an archived product is NOT announced', W.isBackInStock(p({ status: 'archived' })) === false);
  check('a hidden product is NOT announced',
    W.isBackInStock(p({ catalog_visibility: 'hidden' })) === false);

  // A shop that does not count units has nothing to be out of.
  check('an untracked product is available whenever it is active',
    W.isBackInStock(p({ manage_stock: false, stock: 0 })) === true);
  check('...but still not when it is a draft',
    W.isBackInStock(p({ manage_stock: false, status: 'draft' })) === false);

  check('a missing product is not back', W.isBackInStock(null) === false
    && W.isBackInStock(undefined) === false);

  const products = new Map([
    ['in', p({ id: 'in' })],
    ['out', p({ id: 'out', stock: 0 })],
  ]);
  const rows = [
    { id: 'r1', product_id: 'in', email: 'a@example.com', created_at: '' },
    { id: 'r2', product_id: 'out', email: 'b@example.com', created_at: '' },
    { id: 'r3', product_id: 'deleted', email: 'c@example.com', created_at: '' },
  ];
  const sel = W.selectWaitlistToNotify(rows, products);
  check('only rows whose product is buyable are notified',
    sel.notify.map((r) => r.id).join() === 'r1');
  check('rows for a DELETED product are collected for cleanup',
    sel.stale.map((r) => r.id).join() === 'r3');
  check('...and a still-out-of-stock row is left waiting',
    !sel.notify.some((r) => r.id === 'r2') && !sel.stale.some((r) => r.id === 'r2'));
}

/* ------------------------------------------------------------- the address */
{
  check('an address is normalised', W.normaliseWaitlistEmail('  A@B.CO  ') === 'a@b.co');
  check('nonsense is refused', W.normaliseWaitlistEmail('nope') === null
    && W.normaliseWaitlistEmail('') === null && W.normaliseWaitlistEmail(null) === null);
  check('an absurdly long address is refused',
    W.normaliseWaitlistEmail('a'.repeat(250) + '@b.co') === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
