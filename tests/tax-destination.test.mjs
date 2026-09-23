#!/usr/bin/env node
/**
 * Destination-based tax resolution, and the manual override.
 *
 * The property this file exists to defend: **a rate that is owed and missing
 * resolves to `null`, never to 0 and never to the origin's rate.** Both
 * fallbacks are wrong in a way nobody notices — 0 under-charges the buyer's own
 * tax authority, and the origin rate charges a German buyer Greek VAT — and
 * both produce an invoice that looks entirely plausible. That is what makes
 * them dangerous, and why the engine refuses instead.
 *
 * The second property is the override's: it may choose a RULE, never a NUMBER,
 * so `net + tax = total` keeps holding on a stored order and the figure stays
 * explicable from the rate years later.
 *
 * Run with:  node tests/tax-destination.test.mjs
 */
import { loadTs } from './lib/load.mjs';

const T = await loadTs('src/lib/commerce/tax.ts');
const O = await loadTs('src/lib/commerce/tax-override.ts');
const TOT = await loadTs('src/lib/commerce/totals.ts');

let pass = 0;
let fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };

const SETTINGS = (over = {}) => T.resolveTaxSettings({
  tax_enabled: true,
  shop_country: 'GR',
  tax_destination_mode: 'oss',
  tax_reverse_charge_enabled: true,
  tax_rates: [
    { class: 'standard', label: 'Standard', rate_bp: 2400 },
    { class: 'reduced', label: 'Reduced', rate_bp: 1300 },
    { class: 'standard', rate_bp: 1900, country: 'DE' },
    { class: 'standard', rate_bp: 1700, country: 'GR', postcodes: ['63086'] },
  ],
  ...over,
});

/* ---------------------------------------------------- the origin never defaults */
{
  const noOrigin = T.resolveTaxSettings({ tax_enabled: true, tax_destination_mode: 'oss' });
  check('an unset shop country leaves destination mode OFF', noOrigin.destinationMode === 'off');
  check('...and the origin stays undefined rather than guessing GR',
    noOrigin.originCountry === undefined);
  // Guessing the seller's country would invent a tax position.
  const t = T.resolveTaxTreatment({ settings: noOrigin, destination: { country: 'DE' } });
  check('...so a foreign destination still resolves domestic', t.kind === 'domestic');
}

/* ---------------------------------------------------- resolution */
{
  const s = SETTINGS();
  const at = (dest, vat, classes = ['standard']) =>
    T.resolveTaxTreatment({ settings: s, destination: { country: dest }, customerTaxId: vat, classes });

  check('domestic stays domestic', at('GR').kind === 'domestic');
  check('an EU B2C sale uses the DESTINATION', at('DE').kind === 'destination');
  check('...naming the jurisdiction', at('DE').jurisdiction === 'DE');
  check('an EU B2B sale with a VAT id is reverse charge', at('DE', 'DE123456789').kind === 'reverse-charge');
  check('outside the EU is an export', at('US').kind === 'export');
  check('...and so is the UK', at('GB').kind === 'export');

  // A domestic VAT id is NOT reverse charge — a Greek business buying from a
  // Greek shop pays Greek VAT.
  check('a DOMESTIC VAT id does not trigger reverse charge',
    at('GR', 'EL123456789').kind === 'domestic');

  // No destination yet: a cart asks for totals before an address exists.
  check('no destination resolves domestic (a cart before checkout)',
    T.resolveTaxTreatment({ settings: s, classes: ['standard'] }).kind === 'domestic');

  // THE ONE THAT MATTERS.
  const missing = at('FR');
  check('a destination with NO rate on file is not-configured', missing.kind === 'not-configured');
  check('...and names the country and the classes so the operator can fix it',
    missing.missing?.country === 'FR' && missing.missing?.classes.includes('standard'));
  check('...and yields NULL, never 0 and never the origin rate',
    T.rateForTreatment(s, missing, 'standard') === null);

  /*
   * The DESTINATION branch, called directly.
   *
   * The assertion above goes through 'not-configured', which `rateForTreatment`
   * short-circuits before it ever reaches the destination lookup — so it passed
   * even when that lookup was mutated to fall back to the origin rate. This
   * exercises the branch itself: a caller that resolved 'destination' for a
   * country with no row must still get null, because the alternative is
   * charging a French buyer Greek VAT.
   */
  check('a DESTINATION with no row on file is null, not the origin rate',
    T.rateForTreatment(s, { kind: 'destination', jurisdiction: 'FR' }, 'standard') === null);
  check('...and not zero either',
    T.rateForTreatment(s, { kind: 'destination', jurisdiction: 'FR' }, 'standard') !== 0);

  // A class present domestically but absent for the destination.
  const partly = at('DE', undefined, ['standard', 'reduced']);
  check('a class missing for the destination is caught even when another is present',
    partly.kind === 'not-configured' && partly.missing?.classes.includes('reduced')
    && !partly.missing?.classes.includes('standard'));
}

/* ---------------------------------------------------- rates */
{
  const s = SETTINGS();
  const dom = { kind: 'domestic', jurisdiction: 'GR' };
  const de = { kind: 'destination', jurisdiction: 'DE' };
  check('the domestic rate is the origin ladder', T.rateForTreatment(s, dom, 'standard') === 2400);
  check('the destination rate is the destination ladder', T.rateForTreatment(s, de, 'standard') === 1900);
  check('reverse charge is zero', T.rateForTreatment(s, { kind: 'reverse-charge' }, 'standard') === 0);
  check('export is zero', T.rateForTreatment(s, { kind: 'export' }, 'standard') === 0);

  // A special territory, expressed as a postcode row rather than a second table.
  check('a postcode row beats the country-wide row',
    T.rateForTreatment(s, dom, 'standard', '63086') === 1700);
  check('...and a different postcode does not', T.rateForTreatment(s, dom, 'standard', '10563') === 2400);

  // Tax disabled short-circuits everything.
  const off = T.resolveTaxSettings({ tax_enabled: false });
  check('tax switched off is 0 regardless of treatment',
    T.rateForTreatment(off, de, 'standard') === 0);
}

/* ---------------------------------------------------- the rate table */
{
  const s = T.resolveTaxSettings({
    tax_enabled: true, shop_country: 'GR',
    tax_rates: [
      { class: 'standard', rate_bp: 2400 },
      { class: 'standard', rate_bp: 1900, country: 'de' },
      // Each of these must be DROPPED, never fall through to domestic.
      { class: 'namecountry', rate_bp: 2100, country: 'Germany' },
      { class: 'shortcountry', rate_bp: 2100, country: 'D' },
      { class: 'bad', rate_bp: -5 },
      { class: 'bad2', rate_bp: 'nonsense' },
    ],
  });
  check('a country code is upper-cased', s.rates.some((r) => r.country === 'DE'));
  /*
   * A UNIQUE class, deliberately.
   *
   * The first version of this used class 'standard', which the domestic row
   * already occupies — so a bad-country row that fell through to domestic was
   * dropped as a DUPLICATE rather than as a bad country, and the assertion
   * passed for the wrong reason. With its own class there is nothing to
   * collide with, so the row survives if and only if the country check fails.
   */
  check('a country NAME is dropped, not treated as domestic',
    !s.rates.some((r) => r.class === 'namecountry'));
  check('a one-letter country code is dropped too',
    !s.rates.some((r) => r.class === 'shortcountry'));
  check('a negative rate is dropped', !s.rates.some((r) => r.class === 'bad'));
  check('an unparseable rate is dropped', !s.rates.some((r) => r.class === 'bad2'));
  // The dedupe key is the PAIR, so the same class in two countries survives.
  check('the same class in two countries is two rows',
    s.rates.filter((r) => r.class === 'standard').length === 2);
}

/* ---------------------------------------------------- VAT id shape */
{
  check('a well-formed VAT id parses', T.looksLikeVatId('DE123456789').country === 'DE');
  check('...ignoring spaces and dots', T.looksLikeVatId('el 123.456-789').normalised === 'EL123456789');
  check('a phone number is not a VAT id', T.looksLikeVatId('+302101234567').ok === false);
  check('too short is refused', T.looksLikeVatId('DE1').ok === false);
  check('a non-string is refused', T.looksLikeVatId(undefined).ok === false);
}

/* ---------------------------------------------------- reconciliation still holds */
{
  const s = SETTINGS();
  const lines = [
    { product_id: 'a', name: 'A', qty: 1, unit_price_cents: 10000, tax_class: 'standard', tax_status: 'taxable', requires_shipping: true },
    { product_id: 'b', name: 'B', qty: 2, unit_price_cents: 2500, tax_class: 'standard', tax_status: 'taxable', requires_shipping: true },
  ];
  for (const [label, treatment] of [
    ['domestic', { kind: 'domestic', jurisdiction: 'GR' }],
    ['destination', { kind: 'destination', jurisdiction: 'DE' }],
    ['reverse-charge', { kind: 'reverse-charge' }],
    ['export', { kind: 'export' }],
  ]) {
    const t = TOT.calculateTotals({ lines, tax: s, treatment, shipping_cents: 500 });
    check(`totals reconcile under ${label}`, TOT.totalsReconcile(t));
  }

  // The rate actually differs, or the test above proves nothing.
  const dom = TOT.calculateTotals({ lines, tax: s, treatment: { kind: 'domestic', jurisdiction: 'GR' } });
  const des = TOT.calculateTotals({ lines, tax: s, treatment: { kind: 'destination', jurisdiction: 'DE' } });
  check('a destination sale is actually taxed differently', dom.tax_cents !== des.tax_cents);
  const exp = TOT.calculateTotals({ lines, tax: s, treatment: { kind: 'export' } });
  check('an export carries no tax', exp.tax_cents === 0);

  // Absent treatment == today's behaviour, so nothing that exists changes.
  const legacy = TOT.calculateTotals({ lines, tax: s, shipping_cents: 500 });
  check('an absent treatment is identical to domestic',
    legacy.tax_cents === TOT.calculateTotals({
      lines, tax: s, treatment: { kind: 'domestic', jurisdiction: 'GR' }, shipping_cents: 500,
    }).tax_cents);
}

/* ---------------------------------------------------- the override */
{
  const s = SETTINGS();
  const lines = [
    { product_id: 'a', name: 'A', qty: 1, unit_price_cents: 10000, line_subtotal_cents: 10000,
      discount_cents: 0, net_cents: 10000, tax_cents: 2400, tax_rate_bp: 2400, total_cents: 12400 },
    { product_id: 'b', name: 'B', qty: 1, unit_price_cents: 5000, line_subtotal_cents: 5000,
      discount_cents: 0, net_cents: 5000, tax_cents: 1200, tax_rate_bp: 2400, total_cents: 6200 },
  ];

  const noReason = O.applyTaxOverride(lines, s, { scope: 'order', exempt: true }, 'u1');
  check('an override with NO REASON is refused', noReason.ok === false);
  check('...saying why a reason is required', /reason/i.test(noReason.error));

  const both = O.applyTaxOverride(lines, s, { scope: 'order', exempt: true, tax_class: 'reduced', reason: 'x' }, 'u1');
  check('exempt AND a class together is refused', both.ok === false);

  const unknown = O.applyTaxOverride(lines, s, { scope: 'order', tax_class: 'invented', reason: 'x' }, 'u1');
  check('an unknown class is refused rather than falling back to the default',
    unknown.ok === false);

  const exempt = O.applyTaxOverride(lines, s, { scope: 'order', exempt: true, reason: 'Charity, letter on file' }, 'u1');
  check('an order-wide exemption applies', exempt.ok && exempt.tax_cents === 0);
  check('...to every line', exempt.ok && exempt.lines.every((l) => l.tax_cents === 0));
  check('...keeping net + tax = total', exempt.ok
    && exempt.lines.every((l) => l.total_cents === l.net_cents + l.tax_cents));
  check('...marking the lines as human-chosen', exempt.ok
    && exempt.lines.every((l) => l.tax_rate_source === 'override'));
  check('...and recording what the ENGINE had said',
    exempt.ok && exempt.record.was_rate_bp === 2400 && exempt.record.now_rate_bp === 0);
  check('...with the actor and the reason', exempt.ok
    && exempt.record.actor === 'u1' && exempt.record.reason === 'Charity, letter on file');

  const oneLine = O.applyTaxOverride(lines, s, { scope: 'line', line_index: 1, tax_class: 'reduced', reason: 'Medical device' }, 'u2');
  check('a LINE override touches only that line',
    oneLine.ok && oneLine.lines[0].tax_cents === 2400 && oneLine.lines[1].tax_rate_bp === 1300);
  check('...and leaves the untouched line unmarked',
    oneLine.ok && oneLine.lines[0].tax_rate_source === undefined);

  const oob = O.applyTaxOverride(lines, s, { scope: 'line', line_index: 9, reason: 'x', exempt: true }, 'u1');
  check('an out-of-range line index is refused', oob.ok === false);

  // It may choose a RULE, never a NUMBER — there is nowhere to put an amount.
  const srcText = await (await import('node:fs/promises')).readFile('src/lib/commerce/tax-override.ts', 'utf8');
  check('the override accepts no amount field',
    !/tax_cents\s*\?:|amount_cents|rate_bp\s*\?:/.test(srcText.split('export interface OverrideRequest')[1].split('}')[0]));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
