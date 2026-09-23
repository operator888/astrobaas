#!/usr/bin/env node
/**
 * The buyer's printable receipt (src/lib/commerce/receipt.ts, C-39).
 *
 * The three things worth failing the build over:
 *
 *  1. The link is a CREDENTIAL for one order. If another purpose's token can be
 *     replayed as a receipt token, an unrelated link in somebody's inbox reads
 *     somebody else's purchase.
 *  2. An ERASED order must stay unreadable however valid the token is. The
 *     token was signed before the erasure and is still signed after it.
 *  3. The money on the page has to be the money that was charged. The first
 *     draft fell back to a `price_cents` field that does not exist on
 *     `OrderItem`, which would have printed 0,00 on every line.
 *
 * Run with:  node tests/receipt.test.mjs
 */
import { loadTs } from './lib/load.mjs';

// Signing needs a secret; set it before the module graph is imported.
process.env.AUTH_SECRET ||= 'receipt-test-secret-receipt-test-secret';

const R = await loadTs('src/lib/commerce/receipt.ts');
const A = await loadTs('src/lib/auth.ts');
const C = await loadTs('src/lib/commerce/order-confirmation.ts');

let pass = 0;
let fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };

const euro = (c) => `€${(c / 100).toFixed(2)}`;

const order = (o = {}) => ({
  id: 'ord_7', number: 'A-1001', status: 'paid', currency: 'EUR',
  email: 'buyer@example.com', name: 'Ρόζα Π.', address: 'Οδός 1, Αθήνα',
  created_at: '2026-03-04T10:22:31.000Z',
  items: [
    { qty: 2, name: 'Σκελετός', total_cents: 6000, variant_options: { Χρώμα: 'Μαύρο' } },
    { qty: 1, name: 'Θήκη', total_cents: 2500 },
  ],
  subtotal_cents: 8500, shipping_cents: 350, tax_cents: 2044,
  prices_include_tax: true, total_cents: 8850,
  payment_method: 'card', payment_status: 'paid',
  ...o,
});

/* ---------------------------------------------------------------- the token */
{
  const tok = R.makeReceiptToken('ord_7');
  check('a receipt token names its order', R.readReceiptToken(tok) === 'ord_7');
  check('garbage is refused, not thrown on', R.readReceiptToken('nonsense') === null);
  check('an absent token is refused', R.readReceiptToken(undefined) === null
    && R.readReceiptToken(null) === null);
  check('a tampered token is refused', R.readReceiptToken(tok.slice(0, -3) + 'aaa') === null);

  // THE replay test. Every other purpose token in this codebase is signed by
  // the same helper with the same secret; only the purpose separates them. An
  // unsubscribe link from a newsletter must not open somebody's receipt.
  const unsub = A.signPurposeToken('unsub', { oid: 'ord_7', em: 'x@y.z' }, 60_000);
  check('another purpose cannot be replayed as a receipt', R.readReceiptToken(unsub) === null);

  // And the reverse: a receipt token must not satisfy a different purpose.
  check('a receipt token is not an unsubscribe token',
    A.verifyPurposeToken('unsub', tok) === null);

  const expired = A.signPurposeToken('receipt', { oid: 'ord_7' }, -1000);
  check('an expired token is refused', R.readReceiptToken(expired) === null);

  check('the link carries the token in the query',
    R.receiptUrl('https://shop.example', 'ord_7').startsWith('https://shop.example/receipt?token='));
  check('a trailing slash on the origin does not double up',
    !R.receiptUrl('https://shop.example/', 'ord_7').includes('example//receipt'));
  // The token is base64url + a dot; encodeURIComponent must still be applied,
  // because the payload is attacker-influenced only via the order id, and an id
  // with a `&` in it would otherwise truncate the parameter.
  const weird = R.receiptUrl('https://s.example', 'a&b=c');
  check('the token is URL-encoded', R.readReceiptToken(
    new URL(weird).searchParams.get('token')) === 'a&b=c');
}

/* ------------------------------------------------------------ who may see it */
{
  check('a normal order may be shown', R.receiptIsAvailable(order()) === true);
  check('no order, no receipt', R.receiptIsAvailable(null) === false
    && R.receiptIsAvailable(undefined) === false);
  check('an ERASED order is refused whatever the token says',
    R.receiptIsAvailable(order({ erased_at: '2026-04-01' })) === false);
  check('a cancelled order is refused',
    R.receiptIsAvailable(order({ status: 'cancelled' })) === false);
  check('a pending order is still shown', R.receiptIsAvailable(order({ status: 'pending' })) === true);
}

/* ------------------------------------------------------------------ the money */
{
  const v = R.receiptView(order(), euro);
  check('the order number is shown', v.number === 'A-1001');
  check('the date is a date, not a timestamp', v.date === '2026-03-04');
  check('both lines are present', v.lines.length === 2);
  // The regression the first draft would have shipped.
  check('a line total is the stored line total', v.lines[0].total === '€60.00');
  check('...for every line', v.lines[1].total === '€25.00');
  check('no line prints as zero', !v.lines.some((l) => l.total === '€0.00'));
  check('quantities are the stored quantities', v.lines[0].qty === 2 && v.lines[1].qty === 1);
  check('the frozen variant options are shown', v.lines[0].options === 'Χρώμα: Μαύρο');
  check('a simple line has no options', v.lines[1].options === '');
  check('the total is the stored total', v.total === '€88.50');
  check('the subtotal is shown', v.subtotal === '€85.00');
  check('shipping is shown', v.shipping === '€3.50');
  check('VAT is shown', v.tax === '€20.44');
  check('VAT-inclusive pricing is stated', v.taxIncluded === true);
  check('the VAT note mentions shipping when there is shipping', v.taxCoversShipping === true);
  check('a paid order says so', v.paymentState === 'paid');
}

/* ---- the payment line: three states, and one of them is silence ---- */
{
  check('an explicitly unpaid order says so',
    R.receiptView(order({ payment_status: 'unpaid' }), euro).paymentState === 'unpaid');
  // The live regression: a COMPLETED order with no payment_status at all — which
  // is what seeded and operator-entered orders look like — printed "Not yet
  // paid" across the bottom of the receipt. Absence is not evidence of unpaid.
  const unknown = order({ status: 'completed' });
  delete unknown.payment_status;
  check('an order with NO payment status claims nothing',
    R.receiptView(unknown, euro).paymentState === 'unknown');
  check('...and specifically does not claim unpaid',
    R.receiptView(unknown, euro).paymentState !== 'unpaid');
}

/* ---- rows that carry no information are omitted, not printed as zero ---- */
{
  const v = R.receiptView(order({ discount_cents: 0, shipping_cents: 0 }), euro);
  check('a zero discount is omitted', v.discount === null);
  check('zero shipping is omitted', v.shipping === null);
  check('...and then the VAT note does not claim to cover shipping', v.taxCoversShipping === false);
  const d = R.receiptView(order({ discount_cents: 500 }), euro);
  check('a real discount is shown', d.discount === '€5.00');
}

/* ---- the per-line VAT rate, and when it must NOT be trusted ---- */
{
  const withBreakdown = order({
    line_totals: [
      { name: 'Σκελετός', tax_rate_bp: 2400 },
      { name: 'Θήκη', tax_rate_bp: 600 },
    ],
  });
  const v = R.receiptView(withBreakdown, euro);
  check('the per-line VAT rate is shown', v.lines[0].vatRate === '24%');
  check('a second rate is shown per line', v.lines[1].vatRate === '6%');

  // A breakdown whose names do not line up is a breakdown for a different
  // order shape. Showing the wrong rate is worse than showing none.
  const mismatched = R.receiptView(order({
    line_totals: [{ name: 'Something else', tax_rate_bp: 2400 }],
  }), euro);
  check('a mismatched breakdown shows no rate', mismatched.lines[0].vatRate === null);
  // A SHORT breakdown must not shift rates onto the wrong lines.
  const short = R.receiptView(order({
    line_totals: [{ name: 'Σκελετός', tax_rate_bp: 2400 }],
  }), euro);
  check('a short breakdown rates only the line it covers',
    short.lines[0].vatRate === '24%' && short.lines[1].vatRate === null);
  check('no breakdown at all means no rates',
    R.receiptView(order(), euro).lines.every((l) => l.vatRate === null));
}

/* ---- an empty or malformed order must render, not throw ---- */
{
  const v = R.receiptView({ id: 'x', number: 'B-2', currency: 'EUR', total_cents: 0, email: '', items: [], created_at: '' }, euro);
  check('an order with no lines still renders', Array.isArray(v.lines) && v.lines.length === 0);
  check('...with a total of zero', v.total === '€0.00');
  check('...and no VAT row', v.tax === null);
}

/* ------------------------------- the link actually reaches the buyer (C-39) */
{
  const link = R.receiptUrl('https://shop.example', 'ord_7');
  const m = C.buildOrderConfirmation(order(), { siteTitle: 'Shop', receiptLink: link });
  check('the confirmation email carries the receipt link', m.text.includes(link));
  check('...in the HTML part too', m.html.includes(link));
  check('...as a real anchor', m.html.includes(`<a href="${link}"`));

  const without = C.buildOrderConfirmation(order(), { siteTitle: 'Shop' });
  check('no origin, no receipt paragraph', !without.text.includes('/receipt?token='));
  check('...and no empty anchor in the HTML', !without.html.includes('print your receipt'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
