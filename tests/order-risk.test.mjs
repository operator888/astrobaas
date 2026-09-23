#!/usr/bin/env node
/**
 * Local order risk signals.
 *
 * Three properties, and none of them is "does it detect fraud" — it cannot, and
 * claiming otherwise would be the dishonest part:
 *
 *  1. **Nothing is ever rejected.** `riskFields` only ever ADDS. A scorer that
 *     could refuse an order would eventually refuse the best order of the
 *     month, and the buyer would be told nothing.
 *  2. **An ordinary order carries no risk fields at all** — not zeroes, not
 *     `flagged: false`. The exception has to look like an exception.
 *  3. **The raw IP is never stored.** Only an HMAC, and only when there is a
 *     real secret to key it with. Absent means unknown, never "no match".
 *
 * Run with:  node tests/order-risk.test.mjs
 */
import { loadTs } from './lib/load.mjs';

const R = await loadTs('src/lib/commerce/order-risk.ts');

let pass = 0;
let fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };

const NOW = Date.parse('2026-09-07T12:00:00.000Z');
const ago = (min) => new Date(NOW - min * 60_000).toISOString();

const ORDER = (over = {}) => ({
  total_cents: 12000, email: 'buyer@example.com', name: 'Maria', phone: '+30 210 0000000',
  items: [{ qty: 1 }], ...over,
});

/* ---------------------------------------------------- the IP is never raw */
{
  const h = R.hashIp('203.0.113.9', 'a-secret-at-least-16-chars-long');
  check('an ip hashes to a fixed-width token', typeof h === 'string' && h.length === 32);
  check('...that does not contain the address', !h.includes('203') && !h.includes('113'));
  check('...and is stable, so equality comparison works',
    h === R.hashIp('203.0.113.9', 'a-secret-at-least-16-chars-long'));
  check('...but differs per install, so hashes are not portable',
    h !== R.hashIp('203.0.113.9', 'a-different-secret-16-chars'));
  check('a different address hashes differently',
    h !== R.hashIp('203.0.113.10', 'a-secret-at-least-16-chars-long'));

  // Absent must mean UNKNOWN, so there is no placeholder to collide on.
  check('no address yields undefined, not a placeholder', R.hashIp(undefined, 'a-secret-at-least-16') === undefined);
  check('a weak or absent secret yields undefined rather than a weak hash',
    R.hashIp('203.0.113.9', 'short') === undefined && R.hashIp('203.0.113.9', undefined) === undefined);
}

/* ---------------------------------------------------- an ordinary order */
{
  const v = R.scoreOrder({ order: ORDER(), history: [], nowMs: NOW });
  check('an ordinary order scores low', v.score < R.RISK_THRESHOLD);
  check('...and is not flagged', v.flagged === false);

  const fields = R.riskFields(v);
  check('an unflagged order stores NO risk fields at all',
    Object.keys(fields).length === 0);
  check('...not even flagged:false', !('risk_flagged' in fields));

  // The hash IS stored even when unflagged — it is what makes the NEXT order's
  // velocity check possible, and it is not itself a risk claim.
  const withIp = R.riskFields(v, 'abc123');
  check('the ip hash is stored regardless, so future velocity works',
    withIp.ip_hash === 'abc123' && !('risk_flagged' in withIp));
}

/* ---------------------------------------------------- velocity */
{
  const history = Array.from({ length: 4 }, (_, i) => ({
    email: 'buyer@example.com', total_cents: 5000, created_at: ago(i * 5), status: 'pending',
  }));
  const v = R.scoreOrder({ order: ORDER(), history, nowMs: NOW });
  check('repeated orders from one email in minutes is a signal',
    v.signals.some((s) => s.code === 'velocity_email'));
  check('...and the reason says how many and over what window',
    v.reasons.some((r) => /orders from this email in the last 30 minutes/.test(r)));

  // The same orders spread over days must NOT trip it.
  const old = history.map((h, i) => ({ ...h, created_at: new Date(NOW - i * 86_400_000).toISOString() }));
  check('the same orders spread over days do not',
    !R.scoreOrder({ order: ORDER(), history: old, nowMs: NOW })
      .signals.some((s) => s.code === 'velocity_email'));

  // Several DIFFERENT emails from one network is the stronger signal.
  const manyEmails = ['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com'].map((email, i) => ({
    email, ip_hash: 'same-net', total_cents: 5000, created_at: ago(i), status: 'pending',
  }));
  const vi = R.scoreOrder({ order: ORDER(), ipHash: 'same-net', history: manyEmails, nowMs: NOW });
  check('several different emails from one network is a signal',
    vi.signals.some((s) => s.code === 'many_emails_one_ip'));

  // Without a hash there is nothing to compare, and it must not guess.
  check('no ip hash means no ip-based signals',
    !R.scoreOrder({ order: ORDER(), history: manyEmails, nowMs: NOW })
      .signals.some((s) => s.code.includes('ip')));
}

/* ---------------------------------------------------- value, relative to the shop */
{
  const history = Array.from({ length: 6 }, (_, i) => ({
    email: `past${i}@example.com`, total_cents: 10000, created_at: ago(i * 1000), status: 'completed',
  }));
  const big = R.scoreOrder({ order: ORDER({ total_cents: 90000 }), history, nowMs: NOW });
  check('an order far above the shop average is a signal',
    big.signals.some((s) => s.code === 'unusual_value'));
  // Relative, not absolute: the same figure at a shop that sells spectacles is
  // ordinary, and an absolute threshold would flag every second order there.
  const spectacles = Array.from({ length: 6 }, (_, i) => ({
    email: `past${i}@example.com`, total_cents: 80000, created_at: ago(i * 1000), status: 'completed',
  }));
  check('...and the SAME figure is not, at a shop whose average is high',
    !R.scoreOrder({ order: ORDER({ total_cents: 90000 }), history: spectacles, nowMs: NOW })
      .signals.some((s) => s.code === 'unusual_value'));
  check('a shop with too little history gets no value signal at all',
    !R.scoreOrder({ order: ORDER({ total_cents: 900000 }), history: history.slice(0, 2), nowMs: NOW })
      .signals.some((s) => s.code === 'unusual_value'));
}

/* ---------------------------------------------------- addresses */
{
  const v = R.scoreOrder({
    order: ORDER({ shipping_address: { country: 'DE' }, billing_address: { country: 'GR' } }),
    originCountry: 'GR', history: [], nowMs: NOW,
  });
  check('delivery and billing in different countries is a signal',
    v.signals.some((s) => s.code === 'country_mismatch'));
  check('...and shipping abroad is context, worth only one point',
    v.signals.find((s) => s.code === 'foreign_destination')?.points === 1);

  check('a domestic order raises neither',
    R.scoreOrder({
      order: ORDER({ shipping_address: { country: 'GR' }, billing_address: { country: 'GR' } }),
      originCountry: 'GR', history: [], nowMs: NOW,
    }).signals.length === 0);
}

/* ---------------------------------------------------- basket + contact */
{
  const bulk = R.scoreOrder({ order: ORDER({ items: [{ qty: 25 }] }), history: [], nowMs: NOW });
  check('a bulk quantity is a signal', bulk.signals.some((s) => s.code === 'bulk_quantity'));

  const noPhone = R.scoreOrder({
    order: ORDER({ phone: undefined, shipping_address: { line1: 'Ερμού 15' } }),
    history: [], nowMs: NOW,
  });
  check('a delivery with no phone is a signal — a courier that cannot call is a failed delivery',
    noPhone.signals.some((s) => s.code === 'no_phone'));
  check('...and it is worth only one point, because it is operational not fraud',
    noPhone.signals.find((s) => s.code === 'no_phone').points === 1);
}

/* ---------------------------------------------------- flagging */
{
  const history = Array.from({ length: 4 }, (_, i) => ({
    email: 'buyer@example.com', ip_hash: 'net', total_cents: 5000, created_at: ago(i), status: 'pending',
  }));
  const v = R.scoreOrder({
    order: ORDER({ items: [{ qty: 30 }], shipping_address: { country: 'DE' }, billing_address: { country: 'GR' } }),
    ipHash: 'net', history, originCountry: 'GR', nowMs: NOW,
  });
  check('several signals together cross the threshold', v.flagged === true);

  const fields = R.riskFields(v, 'net');
  check('a flagged order stores the score', fields.risk_score === v.score);
  check('...the flag', fields.risk_flagged === true);
  check('...the human-readable reasons', Array.isArray(fields.risk_reasons) && fields.risk_reasons.length > 0);
  check('...and the stable codes for filtering',
    Array.isArray(fields.risk_signals) && fields.risk_signals.includes('velocity_email'));

  /* NOTHING IS EVER REJECTED. There is no field that could refuse an order. */
  check('riskFields can only ever ADD fields — there is no refusal',
    !('status' in fields) && !('rejected' in fields) && !('blocked' in fields));
  const src = await (await import('node:fs/promises')).readFile('src/lib/commerce/order-risk.ts', 'utf8');
  check('...and the module contains no reject/block path at all',
    !/\breject\b|\bblock\b|throw new Error/i.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '')));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
