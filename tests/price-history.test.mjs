#!/usr/bin/env node
/**
 * Price history and the EU Omnibus reference price
 * (src/lib/commerce/price-history.ts).
 *
 * The rule: when a trader announces a price REDUCTION they must also state the
 * LOWEST price applied in at least the 30 days before it. Not the previous
 * price and not the highest — the lowest, so a shop cannot raise a price for a
 * week and then "discount" back to normal.
 *
 * Two properties carry the whole thing, and both are easy to get wrong:
 *
 *  1. A point that STARTED before the window still counts, because the price it
 *     set was live inside the window. Pruning strictly at 30 days deletes the
 *     very figure the rule asks for.
 *  2. `null` means "cannot be evidenced" and the caller must render nothing.
 *     Announcing a reference price the shop cannot prove is the offence.
 *
 * Run with:  node tests/price-history.test.mjs
 */
import { loadTs } from './lib/load.mjs';

const H = await loadTs('src/lib/commerce/price-history.ts');

let pass = 0;
let fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-06-01T12:00:00.000Z');
const ago = (d) => new Date(NOW - d * DAY).toISOString();

/* ------------------------------------------------------------- recording */
{
  const first = H.recordPrice(undefined, 10000, NOW);
  check('the first price is recorded', first.length === 1 && first[0].p === 10000);

  // A save that does not move the price must not append. Otherwise editing a
  // description every day fills the window with identical observations and the
  // field grows without bound.
  const same = H.recordPrice(first, 10000, NOW + DAY);
  check('an unchanged price appends nothing', same.length === 1);

  const moved = H.recordPrice(first, 8000, NOW + DAY);
  check('a changed price appends', moved.length === 2 && moved[1].p === 8000);

  // Back to a price it held before is still a change in time.
  const back = H.recordPrice(moved, 10000, NOW + 2 * DAY);
  check('returning to an earlier price is a new observation', back.length === 3);

  check('a null or unusable price records nothing',
    H.recordPrice(first, null, NOW).length === 1
    && H.recordPrice(first, undefined, NOW).length === 1
    && H.recordPrice(first, Number.NaN, NOW).length === 1);

  // Corrupt input must not throw — this field is read on every product render.
  check('a corrupt field reads as empty rather than throwing',
    H.readPoints('nonsense').length === 0
    && H.readPoints(null).length === 0
    && H.readPoints([{ nope: 1 }, { p: 'x', at: 'y' }]).length === 0);
  check('...and a partially corrupt field keeps the usable points',
    H.readPoints([{ p: 500, at: ago(1) }, { junk: true }]).length === 1);
}

/* ------------------------------------------------ THE PRUNING SUBTLETY */
{
  // A price set 90 days ago and never changed IS the price that was live 29
  // days ago. Pruning it because its timestamp is old deletes the answer.
  const old = [{ p: 7000, at: ago(90) }];
  const pruned = H.prunePoints(old, NOW);
  check('the point spanning the window boundary is KEPT', pruned.length === 1);
  check('...and it is still the lowest price of the last 30 days',
    H.lowestPriceSince(old, NOW, 30) === 7000);

  // With something inside the window, the old point is still the reference if
  // it was lower.
  const mixed = [{ p: 5000, at: ago(90) }, { p: 9000, at: ago(10) }];
  check('a straddling point competes with points inside the window',
    H.lowestPriceSince(mixed, NOW, 30) === 5000);

  // But only ONE point before the window is worth keeping.
  const many = [{ p: 100, at: ago(300) }, { p: 200, at: ago(200) }, { p: 300, at: ago(100) },
                { p: 400, at: ago(5) }];
  const kept = H.prunePoints(many, NOW);
  check('only the most recent pre-window point is kept', kept.length === 2 && kept[0].p === 300);

  const capped = H.prunePoints(
    Array.from({ length: 400 }, (_, i) => ({ p: 1000 + i, at: ago(30 - i * 0.05) })), NOW);
  check('the field is hard-capped', capped.length <= H.PRICE_HISTORY_MAX);
}

/* --------------------------------------------- the lowest, not the previous */
{
  // THE SHAPE THE RULE EXISTS TO STOP: raise the price, then "discount" back to
  // what it always was. The reference must be the LOW, not the price just
  // before the reduction.
  const gamed = [
    { p: 10000, at: ago(28) },   // the real, long-standing price
    { p: 14000, at: ago(5) },    // raised for a few days
  ];
  check('the reference is the LOWEST in the window, not the previous price',
    H.lowestPriceSince(gamed, NOW, 30) === 10000);

  check('no history means no reference, never a guess',
    H.lowestPriceSince(undefined, NOW, 30) === null
    && H.lowestPriceSince([], NOW, 30) === null);
}

/* --------------------------------------------------- what may be displayed */
{
  const hist = [{ p: 10000, at: ago(20) }, { p: 8000, at: ago(1) }];

  check('a product NOT on sale states no reference',
    H.omnibusReference({ on_sale: false, price_cents: 8000, price_history: hist }, NOW) === null);

  check('a product on sale states the prior low',
    H.omnibusReference({ on_sale: true, price_cents: 8000, price_history: hist }, NOW) === 10000);

  // "was €80, now €80" is the misleading claim the rule targets.
  check('a reference equal to the current price is refused',
    H.omnibusReference({ on_sale: true, price_cents: 8000,
      price_history: [{ p: 8000, at: ago(10) }] }, NOW) === null);

  // And one BELOW the current price would be a lie in the other direction.
  check('a reference lower than the current price is refused',
    H.omnibusReference({ on_sale: true, price_cents: 9000,
      price_history: [{ p: 7000, at: ago(10) }] }, NOW) === null);

  check('no history means nothing is announced',
    H.omnibusReference({ on_sale: true, price_cents: 8000 }, NOW) === null);

  // THE WHOLE POINT OF THE RULE, and the answer is a REFUSAL. A shop sold at
  // 100 for a month, raised to 140 for five days, then "discounted" to 110. The
  // lowest price of the prior 30 days is 100 — BELOW the so-called reduced
  // price — so there is no genuine reduction to announce and nothing may be
  // stated. Returning 140 here would hand the shop the deception the rule
  // exists to stop; returning 100 would advertise a "was" above a "now" that is
  // higher still.
  check('a price raised before a fake reduction yields NO reference at all',
    H.omnibusReference({ on_sale: true, price_cents: 11000, price_history: [
      { p: 10000, at: ago(28) },
      { p: 14000, at: ago(5) },
      { p: 11000, at: ago(1) },
    ] }, NOW) === null);

  // The same shop discounting BELOW its real prior low can announce it, and the
  // reference is that real low — never the inflated interim price.
  check('a genuine reduction states the real prior low, not the inflated one',
    H.omnibusReference({ on_sale: true, price_cents: 9000, price_history: [
      { p: 10000, at: ago(28) },
      { p: 14000, at: ago(5) },
      { p: 9000, at: ago(1) },
    ] }, NOW) === 10000);

  // And the reduction's own run, however often re-recorded, is never evidence.
  check('the current reduction is excluded from its own evidence',
    H.omnibusReference({ on_sale: true, price_cents: 8000, price_history: [
      { p: 12000, at: ago(20) },
      { p: 8000, at: ago(3) },
      { p: 8000, at: ago(2) },
    ] }, NOW) === 12000);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
