#!/usr/bin/env node
/**
 * The receipt, as a file the buyer keeps.
 *
 * ## What is checked, and what cannot be
 *
 * A PDF's text is written as glyph indexes into a SUBSETTED font, so the bytes
 * do not contain the words. Searching the output for "Σύνολο" would find
 * nothing however correct the document is, and a test that cannot fail is
 * worse than no test. So this asserts the things that can be asserted and says
 * plainly what it leaves to the eye:
 *
 *  - **Greek must not throw.** This is the real regression test for the
 *    embedded font, and it is a strong one. PDF's 14 standard fonts are
 *    WinAnsi; `drawText` on a Greek string with one of them raises "cannot
 *    encode". So if anybody ever swaps the TTF for `StandardFonts.Helvetica`
 *    to save 750 KB, this file stops passing rather than shipping receipts
 *    full of empty boxes to Greek customers.
 *  - **Pagination is real**, because a 40-line order is not exotic and a
 *    receipt whose last lines fall off the page is not a receipt.
 *  - **The wrapper is pure and nasty inputs are its job** — a catalogue is
 *    full of 40-character codes with no spaces in them.
 *  - **The filename cannot carry a quote or a newline**, because the order
 *    number is operator-controlled and lands in a header.
 *
 * What is NOT checked here: that the words are in the right places. That was
 * verified by rendering and looking, and the layout is stable code with no
 * branches a test could meaningfully pin.
 *
 * Run with:  node tests/receipt-pdf.test.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { loadTs, ROOT } from './lib/load.mjs';

const P = await loadTs('src/lib/commerce/receipt-pdf.ts');
const S = await loadTs('src/lib/i18n/public-strings.ts');
const F = await loadTs('src/lib/commerce/receipt-font.ts');

const font = new Uint8Array(await fs.readFile(path.join(ROOT, 'public/fonts/DejaVuSans.ttf')));

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) pass++;
  else {
    fail++;
    console.error(`✗ ${name}`);
  }
}
async function checkAsync(name, fn) {
  try {
    check(name, await fn());
  } catch (err) {
    fail++;
    console.error(`✗ ${name}: ${err.message}`);
  }
}

const LINE = { name: 'Product', qty: 1, total: '9,90 €', vatRate: '24%', options: '' };
const VIEW = {
  number: 'AB-1042',
  date: '2026-09-23',
  lines: [LINE],
  subtotal: '9,90 €', discount: null, shipping: null, tax: '1,92 €',
  total: '9,90 €', taxIncluded: true, taxCoversShipping: false,
  paymentMethod: 'Card', paymentState: 'paid',
};
const PARTIES = { seller: 'Example Ltd', sellerAddress: 'Somewhere 1', sellerVat: 'EL123', buyer: 'A Buyer', buyerAddress: 'Elsewhere 2' };
const render = (view, locale = 'en', parties = PARTIES) =>
  P.receiptPdfBytes(view, S.publicStrings(locale).receipt, parties, font);

// ────────────────────────────────────────────────────────────── it is a PDF

await checkAsync('the output is a PDF', async () => {
  const bytes = await render(VIEW);
  return Buffer.from(bytes.slice(0, 5)).toString('latin1') === '%PDF-' && bytes.length > 2000;
});

await checkAsync('the font is embedded, not referenced', async () => {
  // FontFile2 is the TrueType program itself. Without it a reader substitutes
  // whatever font it happens to have, which is how a receipt opens correctly
  // on the machine that made it and wrongly everywhere else.
  //
  // Read through the object graph rather than by searching the bytes: pdf-lib
  // writes object STREAMS, so the name is compressed and a byte search finds
  // nothing however correct the file is. The first version of this test did
  // exactly that and failed against a good PDF.
  const doc = await PDFDocument.load(await render(VIEW));
  const objects = doc.context.enumerateIndirectObjects().map(([, obj]) => String(obj));
  return objects.some((o) => o.includes('FontFile2'))
    // Type0/CIDFontType2 is the composite form — the one that can address more
    // than 256 glyphs, which is what Greek beyond Latin-1 requires.
    && objects.some((o) => o.includes('CIDFontType2'));
});

await checkAsync('subsetting keeps a one-line receipt small', async () => {
  // The source font is ~750 KB. If subsetting ever silently stops, this is
  // where it shows up — an emailed receipt should not be a megabyte.
  const bytes = await render(VIEW);
  return bytes.length < 120_000;
});

// ─────────────────────────────────────────────────── the font is the point

await checkAsync('Greek renders instead of throwing', async () => {
  const greek = {
    ...VIEW,
    number: 'ΑΒ-1042',
    lines: [{ name: 'Γυαλιά ηλίου', qty: 1, total: '149,00 €', vatRate: '24%', options: 'Χρώμα: Μαύρο' }],
    paymentMethod: 'Κάρτα',
  };
  const bytes = await render(greek, 'el', { ...PARTIES, seller: 'Οπτικά Α.Ε.', buyer: 'Θεόδωρος Παπαδόπουλος' });
  return bytes.length > 2000;
});

await checkAsync('German renders too', async () => {
  const bytes = await render({ ...VIEW, lines: [{ ...LINE, name: 'Sonnenbrille größer' }] }, 'de');
  return bytes.length > 2000;
});

// ───────────────────────────────────────────────────────────── pagination

await checkAsync('a short receipt is one page', async () => {
  const doc = await PDFDocument.load(await render(VIEW));
  return doc.getPageCount() === 1;
});

await checkAsync('a long receipt paginates rather than running off the page', async () => {
  const many = { ...VIEW, lines: Array.from({ length: 40 }, (_, i) => ({ ...LINE, name: `Product ${i + 1}` })) };
  const doc = await PDFDocument.load(await render(many));
  return doc.getPageCount() >= 2;
});

await checkAsync('a receipt with no lines still produces a document', async () => {
  // An order can be all shipping, or every line can have been removed. The
  // file must still exist — a 500 on a receipt link is worse than a thin page.
  const doc = await PDFDocument.load(await render({ ...VIEW, lines: [] }));
  return doc.getPageCount() === 1;
});

// ──────────────────────────────────────────────────────────── the wrapper

check('wrap: an ordinary sentence breaks at spaces', (() => {
  const lines = P.wrap('one two three four five six seven eight', { widthOfTextAtSize: (s) => s.length * 6 }, 10, 60);
  return lines.length > 1 && lines.every((l) => l.length * 6 <= 60);
})());

check('wrap: a word longer than the column is broken, not run off the edge', (() => {
  const lines = P.wrap('AAAAAAAAAAAAAAAAAAAAAAAA', { widthOfTextAtSize: (s) => s.length * 6 }, 10, 60);
  return lines.length > 1 && lines.every((l) => l.length * 6 <= 60);
})());

check('wrap: an explicit newline is kept', (() => {
  const lines = P.wrap('first\nsecond', { widthOfTextAtSize: (s) => s.length * 2 }, 10, 400);
  return lines.length === 2 && lines[0] === 'first' && lines[1] === 'second';
})());

check('wrap: empty input is one empty line, never zero', (() => {
  // Zero lines would collapse a row and silently shift every number below it.
  const lines = P.wrap('', { widthOfTextAtSize: () => 0 }, 10, 100);
  return lines.length === 1;
})());

// ───────────────────────────────────────────────────────────── the filename

check('the filename keeps a normal order number', P.receiptPdfFilename('AB-1042') === 'receipt-AB-1042.pdf');
for (const [input, why] of [
  ['AB"1042', 'a quote would end the header value'],
  ['AB\r\n1042', 'CRLF would inject a header'],
  ['ΑΒ-1042', 'non-ASCII is not safe in a bare filename'],
  ['../../etc/passwd', 'a path must not survive'],
]) {
  const out = P.receiptPdfFilename(input);
  check(`the filename is safe: ${why}`, /^receipt-?[A-Za-z0-9_-]*\.pdf$/.test(out));
}
check('a number with nothing usable still gets a name', P.receiptPdfFilename('««»»') === 'receipt.pdf');
check('a missing number still gets a name', P.receiptPdfFilename(undefined) === 'receipt.pdf');

// ────────────────────────────────────────────────────────────── the font file

await checkAsync('the font ships where a release will find it', async () => {
  // public/ is the one directory `astro build` copies into dist/client, which
  // is why the font lives there. The mail test learned this the expensive way.
  const stat = await fs.stat(path.join(ROOT, 'public/fonts/DejaVuSans.ttf'));
  return stat.size > 100_000;
});

await checkAsync('the loader finds it, and caches it', async () => {
  F.resetReceiptFont();
  const first = await F.receiptFontBytes();
  const second = await F.receiptFontBytes();
  return first.length > 100_000 && first === second;
});

await checkAsync('its licence travels with it', async () => {
  const text = await fs.readFile(path.join(ROOT, 'public/fonts/DejaVuSans-LICENSE.txt'), 'utf8');
  return text.includes('Bitstream');
});

console.log(`\nreceipt-pdf: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
