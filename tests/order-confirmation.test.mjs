#!/usr/bin/env node
/**
 * The customer's order confirmation (src/lib/commerce/order-confirmation.ts).
 *
 * This exists because it did not, while the scoreboard said it did. The buyer
 * received nothing — and on a bank-transfer order that means the order is
 * unpayable, because they have no account number and no reference.
 *
 * Run with:  node tests/order-confirmation.test.mjs
 */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const cacheDir = path.join(root, 'node_modules', '.cache');
await fs.mkdir(cacheDir, { recursive: true });
const out = path.join(cacheDir, `astrobaas-orderconf-${process.pid}.mjs`);
await build({
  entryPoints: [path.join(root, 'src/lib/commerce/order-confirmation.ts')],
  bundle: true, format: 'esm', platform: 'node', packages: 'external',
  outfile: out, logLevel: 'silent',
});
const C = await import(pathToFileURL(out).href);
await fs.rm(out, { force: true });

let pass = 0;
let fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };

const order = (o = {}) => ({
  id: 'ord_1', number: 'A-1001', status: 'pending', currency: 'EUR',
  total_cents: 8500, email: 'buyer@example.com',
  items: [
    { qty: 2, name: 'Σκελετός μεταλλικός', total_cents: 6000 },
    { qty: 1, name: 'Θήκη', total_cents: 2500 },
  ],
  payment_method: 'bank-transfer', payment_status: 'unpaid',
  ...o,
});

const IBAN = 'Bank: Alpha\nIBAN: GR16 0110 1250 0000 0001 2300 695\nHolder: Example Optics';

/* ---- the message a buyer actually needs ---- */
{
  const m = C.buildOrderConfirmation(order(), { siteTitle: 'Optiki Gwnia' });
  check('it goes to the buyer', m.to === 'buyer@example.com');
  check('the subject carries the order number', m.subject.includes('A-1001'));
  check('...and the shop name', m.subject.includes('Optiki Gwnia'));
  check('every line item is listed', m.text.includes('Σκελετός μεταλλικός') && m.text.includes('Θήκη'));
  check('quantities are shown', m.text.includes('2 ×'));
  check('the total is shown', m.text.includes('85'));
  check('there is an HTML part too', m.html.includes('<table'));
}

/* ---- the bank-transfer case, which is why this is urgent ---- */
{
  const withIban = C.buildOrderConfirmation(order(), { instructions: IBAN });
  check('bank details are included when the shop has configured them',
    withIban.text.includes('GR16 0110 1250 0000 0001 2300 695'));
  // Without a reference the shop cannot match the money to the order.
  check('...with the order number as the payment reference',
    withIban.text.includes('Reference: A-1001'));
  check('...and the buyer is told to quote it',
    /quoting the order number/i.test(withIban.text));

  // The honest wording when the shop has NOT configured them. Promising details
  // that are not in the email would be worse than admitting a human follows up.
  const without = C.buildOrderConfirmation(order(), {});
  check('with no configured details, it does NOT promise details below',
    !/details below/i.test(without.text));
  check('...it says a human will be in touch',
    /contact you with payment details/i.test(without.text));
}

/* ---- what happens next depends on how they are paying ---- */
{
  const cod = C.buildOrderConfirmation(order({ payment_method: 'cod' }), {});
  check('cash on delivery says pay on delivery', /pay when the order is delivered/i.test(cod.text));

  const paid = C.buildOrderConfirmation(order({ payment_status: 'paid' }), {});
  check('an already-paid order says we have your payment',
    /have your payment/i.test(paid.text));
  check('...and does NOT ask for a transfer', !/Transfer the total/i.test(paid.text));

  // A paid order must not carry an IBAN — that invites a second payment.
  const paidWithIban = C.buildOrderConfirmation(
    order({ payment_status: 'paid' }), { instructions: IBAN });
  check('a paid order still shows no "transfer the total" instruction',
    !/Transfer the total/i.test(paidWithIban.text));
}

/* ---- injection: order and settings values reach a header and HTML ---- */
{
  // The classic mail-header injection. The order number is generated but the
  // shop title is operator-authored, and both land in the subject.
  const evil = C.buildOrderConfirmation(
    order({ number: 'A-1\nBcc: attacker@evil.test' }),
    { siteTitle: 'Shop\r\nX-Injected: yes' },
  );
  check('a newline in the order number cannot add a header',
    !evil.subject.includes('\n') && !evil.subject.includes('\r'));
  check('...nor can one in the shop title',
    !/X-Injected/.test(evil.subject.split('\n')[0]) || !evil.subject.includes('\n'));

  const markup = C.buildOrderConfirmation(
    order({ items: [{ qty: 1, name: '<img src=x onerror=alert(1)>', total_cents: 100 }] }), {});
  check('a product name cannot inject markup into the HTML part',
    !markup.html.includes('<img src=x') && markup.html.includes('&lt;img'));

  const evilInstructions = C.buildOrderConfirmation(
    order(), { instructions: '</pre><script>alert(1)</script>' });
  check('operator-authored instructions cannot break out of their block',
    !evilInstructions.html.includes('<script>'));
}

/* ---- no address, no email ---- */
{
  // An operator taking an order on the phone may capture no address. That is
  // not an error worth failing a checkout over.
  check('an order with no email produces nothing',
    C.buildOrderConfirmation(order({ email: '' }), {}) === null);
  check('...and neither does a malformed one',
    C.buildOrderConfirmation(order({ email: 'not-an-address' }), {}) === null);
  check('whitespace is not an address',
    C.buildOrderConfirmation(order({ email: '   ' }), {}) === null);
}

/* ---- degenerate orders do not throw ---- */
{
  check('an order with no items still confirms',
    C.buildOrderConfirmation(order({ items: [] }), {}).text.includes('A-1001'));
  check('a missing items array is survived',
    C.buildOrderConfirmation(order({ items: undefined }), {}) !== null);
  check('a missing number falls back to the id',
    C.buildOrderConfirmation(order({ number: undefined }), {}).subject.includes('ord_1'));
  check('a line with no total falls back to price × qty',
    C.buildOrderConfirmation(
      order({ items: [{ qty: 3, name: 'x', price_cents: 500 }] }), {}).text.includes('15'));
}

/* ---- the switch ---- */
{
  let sent = 0;
  const deps = (settings) => ({
    readSettings: async () => settings,
    send: async () => { sent += 1; },
    instructionsFor: () => undefined,
  });

  sent = 0;
  await C.sendOrderConfirmation(order(), deps({}));
  // A shop that takes an order and does not confirm it is broken, so the safe
  // default is to send.
  check('it sends by default, with no setting present', sent === 1);

  sent = 0;
  await C.sendOrderConfirmation(order(), deps({ order_confirmation_enabled: false }));
  check('an explicit false turns it off', sent === 0);

  sent = 0;
  await C.sendOrderConfirmation(order(), deps({ order_confirmation_enabled: true }));
  check('an explicit true keeps it on', sent === 1);
}

/* ---- a broken mail transport must never fail a checkout ---- */
{
  // The order is already committed and the customer has already committed to
  // pay. Losing the confirmation is bad; losing the order is worse.
  let threw = false;
  try {
    await C.sendOrderConfirmation(order(), {
      readSettings: async () => ({}),
      send: async () => { throw new Error('SMTP is down'); },
      instructionsFor: () => undefined,
    });
  } catch { threw = true; }
  check('a send failure is swallowed, not propagated', !threw);

  let threw2 = false;
  try {
    await C.sendOrderConfirmation(order(), {
      readSettings: async () => { throw new Error('db down'); },
      send: async () => {},
      instructionsFor: () => undefined,
    });
  } catch { threw2 = true; }
  check('a settings failure is swallowed too', !threw2);
}

/* ---- the instructions have a real source now ---- */
{
  // THE BLOCKER: ManualMethodDef.instructions was reachable only by a PLUGIN,
  // so on a core install the built-in bank-transfer method could never carry an
  // IBAN — and this email promised details with nowhere to come from. Both live
  // shops take bank transfers with no such plugin.
  let captured = null;
  await C.sendOrderConfirmation(order(), {
    readSettings: async () => ({ payment_instructions_bank_transfer: IBAN }),
    send: async (m) => { captured = m; },
    // What the wiring now does: settings first.
    instructionsFor: (id) => (id === 'bank-transfer' ? IBAN : undefined),
  });
  check('an IBAN configured in settings reaches the customer',
    captured && captured.text.includes('GR16 0110 1250 0000 0001 2300 695'));
  check('...with the order number as the reference',
    captured && captured.text.includes('Reference: A-1001'));

  let none = null;
  await C.sendOrderConfirmation(order(), {
    readSettings: async () => ({}),
    send: async (m) => { none = m; },
    instructionsFor: () => undefined,
  });
  check('with nothing configured it promises no details',
    none && !/details below/i.test(none.text));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
