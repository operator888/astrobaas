#!/usr/bin/env node
/**
 * Multi-currency: the rate table, the converter, and the one property that
 * makes the whole design correct.
 *
 * THE PROPERTY: after converting a priced basket, `totalsReconcile()` must
 * still hold. That is not a nice-to-have — it is the difference between an
 * invoice whose lines add up to the amount charged and one that does not, and
 * the failure is the kind an accountant finds months later.
 *
 * It is easy to get wrong in a way that looks right: convert every figure
 * independently, including the total, and each one rounds on its own, so the
 * total can miss the sum of its parts by a cent. The converter therefore
 * converts only ATOMIC amounts and DERIVES every aggregate — and the test below
 * is fuzzed across many rates and baskets, because a single hand-picked example
 * passes under both designs.
 *
 * Run with:  node tests/currency-rates.test.mjs
 */
import { loadTs } from './lib/load.mjs';

const C = await loadTs('src/lib/commerce/currency-rates.ts');
const T = await loadTs('src/lib/commerce/totals.ts');
const M = await loadTs('src/lib/money-format.ts');

let pass = 0;
let fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };

/* ---------------------------------------------------- exponents */
{
  check('a two-decimal currency has 100 minor units', M.minorUnits('EUR') === 100);
  check('a zero-decimal currency has 1', M.minorUnits('JPY') === 1);
  // The half that was missing: minorUnits could only answer 1 or 100, so a
  // dinar shop displayed a tenth of what it charged.
  check('a THREE-decimal currency has 1000', M.minorUnits('BHD') === 1000);
  check('...and formats with three places', M.moneyPlain(123456, 'KWD') === '123.456');
  check('...while euros still get two', M.moneyPlain(123456, 'EUR') === '1234.56');
  check('...and yen get none', M.moneyPlain(123456, 'JPY') === '123456');
  check('an unknown code falls back to two places', M.minorUnits('ZZZ') === 100);
}

/* ---------------------------------------------------- the rate table */
{
  const now = Date.parse('2026-09-04T12:00:00.000Z');
  const fresh = new Date(now - 3600_000).toISOString();
  const old = new Date(now - 40 * 24 * 3600_000).toISOString();

  const s = C.resolveCurrencySettings({
    [C.CURRENCY_KEYS.rates]: [
      { code: 'usd', rate_ppm: 1_087_000, updated_at: fresh },
      { code: 'GBP', rate_ppm: 850_000, updated_at: old },
      { code: 'CHF', rate_ppm: 950_000, updated_at: fresh, enabled: false },
      // Every one of these must be DROPPED, not defaulted.
      { code: 'EUR', rate_ppm: 1_000_000, updated_at: fresh },   // the base
      { code: 'US', rate_ppm: 1_000_000, updated_at: fresh },    // not ISO-3
      { code: 'JPY', rate_ppm: 0, updated_at: fresh },           // below the floor
      { code: 'AUD', rate_ppm: 'not a number', updated_at: fresh },
      { code: 'USD', rate_ppm: 2_000_000, updated_at: fresh },   // duplicate
      'nonsense',
    ],
  }, 'EUR', now);

  check('a good rate is kept and the code upper-cased',
    s.rates.find((r) => r.code === 'USD')?.rate_ppm === 1_087_000);
  check('the BASE currency is never given a rate', !s.rates.some((r) => r.code === 'EUR'));
  check('a non-ISO code is dropped', !s.rates.some((r) => r.code === 'US'));
  check('a zero rate is DROPPED, not defaulted to 1.0',
    !s.rates.some((r) => r.code === 'JPY'));
  check('an unparseable rate is dropped', !s.rates.some((r) => r.code === 'AUD'));
  check('a duplicate keeps the FIRST', s.rates.filter((r) => r.code === 'USD').length === 1
    && s.rates.find((r) => r.code === 'USD').rate_ppm === 1_087_000);
  check('a non-object row is dropped', s.rates.length === 3);

  check('a recent rate is not stale', s.rates.find((r) => r.code === 'USD').stale === false);
  check('a 40-day-old rate is stale', s.rates.find((r) => r.code === 'GBP').stale === true);

  check('rateFor finds an enabled currency', C.rateFor(s, 'usd')?.rate_ppm === 1_087_000);
  check('rateFor refuses a DISABLED one', C.rateFor(s, 'CHF') === null);
  check('rateFor refuses the base', C.rateFor(s, 'EUR') === null);
  check('rateFor refuses an unknown code', C.rateFor(s, 'CAD') === null);
  check('offeredCurrencies lists the base first',
    C.offeredCurrencies(s)[0] === 'EUR' && C.offeredCurrencies(s).includes('USD')
    && !C.offeredCurrencies(s).includes('CHF'));

  // The stored value can be the STRING "true" — /api/settings/update coerces
  // only its known BOOLEAN_KEYS, so `=== true` would read it as off.
  check('a stringy "true" still blocks checkout',
    C.resolveCurrencySettings({ [C.CURRENCY_KEYS.staleBlocksCheckout]: 'true' }, 'EUR', now)
      .staleBlocksCheckout === true);
  check('absent means it does not block',
    C.resolveCurrencySettings({}, 'EUR', now).staleBlocksCheckout === false);
}

/* ---------------------------------------------------- conversion arithmetic */
{
  // 10.00 EUR at 1.087 -> 10.87 USD
  check('a simple conversion is exact',
    C.convertMinorUnits(1000, 'EUR', 'USD', 1_087_000) === 1087);

  // THE EXPONENT CASE. 10.00 EUR at 160 JPY/EUR is 1600 yen = 1600 minor units,
  // not 160000: converting minor-to-minor without the exponents is out by 100x.
  check('converting into a ZERO-decimal currency respects the exponent',
    C.convertMinorUnits(1000, 'EUR', 'JPY', 160_000_000) === 1600);
  check('...and back out of one',
    C.convertMinorUnits(1600, 'JPY', 'EUR', 6250) === 1000);
  check('converting into a THREE-decimal currency respects it too',
    C.convertMinorUnits(1000, 'EUR', 'KWD', 306_000) === 3060);

  check('a zero amount converts to zero', C.convertMinorUnits(0, 'EUR', 'USD', 1_087_000) === 0);
  check('a refund (negative) converts symmetrically',
    C.convertMinorUnits(-1000, 'EUR', 'USD', 1_087_000) === -1087);

  // Precision: a total far above 2^53 / 1e6 would lose cents through floats.
  const big = 900_000_000_000;
  check('a very large amount does not lose precision to floats',
    C.convertMinorUnits(big, 'EUR', 'USD', 1_087_000) === 978_300_000_000);
}

/* ------------------------------------------- THE property: reconciliation */
{
  const tax = {
    enabled: true, prices_include_tax: false, default_class: 'standard',
    rates: [{ class: 'standard', rate_bp: 2400 }],
  };
  const mkLine = (i, price, qty) => ({
    product_id: `p${i}`, name: `Item ${i}`, qty, unit_price_cents: price,
    tax_class: 'standard', tax_status: 'taxable', requires_shipping: true, weight_grams: 100,
  });

  // Fuzzed, because ONE hand-picked basket passes under the naive design too.
  // These prices and rates are chosen to land on rounding boundaries often.
  let checked = 0;
  let reconciled = 0;
  let sameAsNaive = 0;
  const rates = [1_087_000, 850_000, 1_333_333, 160_000_000, 306_000, 7, 999_999];
  const currencies = ['USD', 'GBP', 'CHF', 'JPY', 'KWD', 'SEK', 'PLN'];

  for (let seed = 1; seed <= 60; seed++) {
    const lines = [];
    for (let i = 0; i < (seed % 4) + 1; i++) {
      lines.push(mkLine(i, 333 + seed * 7 + i * 101, (i % 3) + 1));
    }
    const base = T.calculateTotals({
      lines, tax,
      discount_cents: seed % 5 === 0 ? 137 : 0,
      shipping_cents: seed % 3 === 0 ? 499 : 0,
    });
    if (!T.totalsReconcile(base)) { check(`base basket ${seed} reconciles`, false); continue; }

    for (let r = 0; r < rates.length; r++) {
      const converted = C.convertTotals(base, 'EUR', currencies[r], rates[r]);
      checked++;
      if (T.totalsReconcile(converted)) reconciled++;

      // How the naive design would have done it, for contrast: convert the
      // total on its own. Count how often that DISAGREES with the sum of the
      // converted parts — if it never disagreed, this test would be proving
      // nothing.
      const naiveTotal = C.convertMinorUnits(base.total_cents, 'EUR', currencies[r], rates[r]);
      if (naiveTotal !== converted.total_cents) sameAsNaive++;
    }
  }

  check(`every converted basket reconciles (${reconciled}/${checked})`, reconciled === checked);
  // The test has teeth only if the naive approach would actually have failed.
  check(`...and the naive "convert the total directly" would have differed at least once (${sameAsNaive} times)`,
    sameAsNaive > 0);
}

/* ---------------------------------------------------- conversion is a no-op at parity */
{
  const tax = { enabled: false, prices_include_tax: false, default_class: '', rates: [] };
  const base = T.calculateTotals({
    lines: [{ product_id: 'p', name: 'x', qty: 2, unit_price_cents: 1500, requires_shipping: false }],
    tax,
  });
  const same = C.convertTotals(base, 'EUR', 'EUR', 1_000_000);
  check('converting at 1.0 into the same currency changes nothing',
    same.total_cents === base.total_cents && same.subtotal_cents === base.subtotal_cents);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
