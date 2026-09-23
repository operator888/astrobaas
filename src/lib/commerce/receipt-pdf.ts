/**
 * A receipt as a PDF file, produced by the server.
 *
 * ## Why this exists when a print view already does
 *
 * The print view covers reading and Save-as-PDF, and for a long time that was
 * the whole answer — a server-side PDF used to mean a headless browser, which
 * is 300 MB on every self-host to lay out a page the reader's own browser can
 * lay out for free. That argument still holds against rendering ARTICLES.
 *
 * It does not hold for a receipt, because a receipt is a FILE somebody keeps:
 * attached to an order email, filed with an accountant, uploaded to an expense
 * tool. "Open this link and press print" is not a file, and a link that stops
 * working when the shop moves host is worse than not offering one. So this
 * draws the receipt directly — no browser, no HTML, ~40 KB of output.
 *
 * ## One source of truth
 *
 * It takes a `ReceiptView` — the same struct `receipt.astro` renders — and the
 * same localized strings. Nothing here reads an order, formats money, or
 * decides whether a receipt may be shown: those answers already exist and
 * having two of them is how a PDF comes to disagree with the page it was
 * printed from.
 *
 * ## The font is not optional
 *
 * PDF's 14 standard fonts are WinAnsi — Latin-1 and nothing else. A Greek
 * receipt drawn in Helvetica is mojibake, and this project's first users are
 * Greek. So a Unicode TTF is embedded, subsetted to the glyphs actually used,
 * which is why the output stays small even though the source font is ~750 KB.
 *
 * It is passed IN rather than read here: this module does no I/O, which is what
 * lets a test render a receipt without a filesystem and what keeps the "where
 * does the font live in a release" question in one place (`receipt-font.ts`).
 */
import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import type { ReceiptView } from './receipt';
import type { PublicStrings } from '../i18n/public-strings';

export interface ReceiptPdfParties {
  seller: string;
  sellerAddress?: string;
  sellerVat?: string;
  buyer?: string;
  buyerAddress?: string;
}

/** A4 in points, and the margins everything else is measured from. */
const PAGE = { width: 595.28, height: 841.89 };
const MARGIN = 56;
const INK = rgb(0.06, 0.09, 0.13);
const MUTED = rgb(0.42, 0.45, 0.5);
const RULE = rgb(0.85, 0.87, 0.89);

/**
 * Break `text` into lines that fit `maxWidth`.
 *
 * pdf-lib draws a string; it does not lay one out. A word longer than the
 * column — a 40-character product code with no spaces, which is exactly what a
 * catalogue contains — is broken by character rather than allowed to run off
 * the page, because a receipt that loses its right-hand edge is not a receipt.
 */
export function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const out: string[] = [];
  for (const paragraph of String(text ?? '').split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) out.push(line);
      if (font.widthOfTextAtSize(word, size) <= maxWidth) {
        line = word;
        continue;
      }
      // Too long even alone: break it.
      let chunk = '';
      for (const ch of word) {
        if (font.widthOfTextAtSize(chunk + ch, size) > maxWidth) {
          out.push(chunk);
          chunk = ch;
        } else chunk += ch;
      }
      line = chunk;
    }
    out.push(line);
  }
  return out.length ? out : [''];
}

/**
 * The filename the download carries.
 *
 * An order number is operator-controlled text — `order_prefix` is a setting —
 * so it arrives as a string that may hold a quote, a newline or a non-ASCII
 * character. All three either break `Content-Disposition` or let it be forged,
 * so it is reduced to the characters that cannot: letters, digits, dash,
 * underscore. A number that is entirely something else leaves a usable generic
 * name rather than an empty one.
 */
export function receiptPdfFilename(number: unknown): string {
  const cleaned = String(number ?? '').replace(/[^A-Za-z0-9_-]/g, '');
  return cleaned ? `receipt-${cleaned}.pdf` : 'receipt.pdf';
}

export async function receiptPdfBytes(
  view: ReceiptView,
  strings: PublicStrings['receipt'],
  parties: ReceiptPdfParties,
  fontBytes: Uint8Array,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(fontBytes, { subset: true });

  const right = PAGE.width - MARGIN;
  const width = right - MARGIN;
  let page: PDFPage = doc.addPage([PAGE.width, PAGE.height]);
  let y = PAGE.height - MARGIN;

  /**
   * Start a new page when the next block would not fit, and say on it which
   * receipt it belongs to.
   *
   * A receipt is a document people file, and a filed document comes apart. A
   * continuation page with no order number on it is a page nobody can put back
   * — which is the whole reason invoices have ever carried a header on every
   * sheet.
   */
  const room = (needed: number) => {
    if (y - needed >= MARGIN) return;
    page = doc.addPage([PAGE.width, PAGE.height]);
    y = PAGE.height - MARGIN - 14;
    page.drawText(`${strings.orderNo}: ${view.number}`, { x: MARGIN, y, size: 9, font, color: MUTED });
    y -= 10;
    page.drawLine({ start: { x: MARGIN, y }, end: { x: right, y }, thickness: 0.75, color: RULE });
    y -= 18;
  };
  const text = (s: string, x: number, size: number, color = INK) => {
    page.drawText(s, { x, y, size, font, color });
  };
  const textRight = (s: string, xEnd: number, size: number, color = INK) => {
    page.drawText(s, { x: xEnd - font.widthOfTextAtSize(s, size), y, size, font, color });
  };
  const rule = () => {
    page.drawLine({ start: { x: MARGIN, y }, end: { x: right, y }, thickness: 0.75, color: RULE });
  };

  // ---- heading -------------------------------------------------------------
  y -= 24;
  text(strings.heading, MARGIN, 22);
  y -= 16;
  for (const line of wrap(strings.notInvoice, font, 8.5, width)) {
    text(line, MARGIN, 8.5, MUTED);
    y -= 11;
  }

  // ---- who, and which order ------------------------------------------------
  y -= 10;
  const half = width / 2 - 8;
  const startY = y;
  const column = (x: number, heading: string, body: string[]) => {
    y = startY;
    text(heading, x, 9, MUTED);
    y -= 13;
    for (const raw of body) {
      for (const line of wrap(raw, font, 10, half)) {
        text(line, x, 10);
        y -= 13;
      }
    }
    return y;
  };
  const sellerY = column(MARGIN, strings.seller, [
    parties.seller,
    parties.sellerAddress || '',
    parties.sellerVat ? `VAT: ${parties.sellerVat}` : '',
  ].filter(Boolean));
  const buyerY = column(MARGIN + half + 16, strings.billedTo, [
    parties.buyer || '',
    parties.buyerAddress || '',
  ].filter(Boolean));
  y = Math.min(sellerY, buyerY) - 8;

  text(`${strings.orderNo}: ${view.number}`, MARGIN, 10);
  textRight(`${strings.date}: ${view.date}`, right, 10);
  y -= 14;
  rule();
  y -= 16;

  // ---- lines ---------------------------------------------------------------
  const colQty = right - 210;
  const colVat = right - 140;
  const colTotal = right;
  const nameWidth = colQty - MARGIN - 60;

  text(strings.item, MARGIN, 9, MUTED);
  textRight(strings.qty, colQty, 9, MUTED);
  textRight(strings.vatRate, colVat, 9, MUTED);
  textRight(strings.lineTotal, colTotal, 9, MUTED);
  y -= 6;
  rule();
  y -= 14;

  for (const line of view.lines) {
    const nameLines = wrap(line.name, font, 10, nameWidth);
    const optionLines = line.options ? wrap(line.options, font, 8.5, nameWidth) : [];
    room(13 * nameLines.length + 11 * optionLines.length + 8);

    const rowTop = y;
    for (const l of nameLines) {
      text(l, MARGIN, 10);
      y -= 13;
    }
    for (const l of optionLines) {
      text(l, MARGIN, 8.5, MUTED);
      y -= 11;
    }
    // The numbers sit on the row's FIRST line, not its last: a two-line product
    // name would otherwise push its own price down next to the line below it.
    const after = y;
    y = rowTop;
    textRight(String(line.qty), colQty, 10);
    textRight(line.vatRate ?? '', colVat, 10, MUTED);
    textRight(line.total, colTotal, 10);
    y = after - 4;
  }

  y -= 4;
  rule();
  y -= 16;

  // ---- totals --------------------------------------------------------------
  const totalRow = (label: string, value: string, size = 10, color = INK) => {
    room(16);
    text(label, colQty - 120, size, color);
    textRight(value, colTotal, size, color);
    y -= size + 5;
  };
  if (view.subtotal) totalRow(strings.subtotal, view.subtotal, 10, MUTED);
  if (view.discount) totalRow(strings.discount, view.discount, 10, MUTED);
  if (view.shipping) totalRow(strings.shipping, view.shipping, 10, MUTED);
  if (view.tax) totalRow(strings.vat, view.tax, 10, MUTED);
  totalRow(strings.total, view.total, 13);

  if (view.taxIncluded) {
    y -= 2;
    const note = view.taxCoversShipping ? strings.vatWithShipping : strings.vatIncluded;
    for (const l of wrap(note, font, 8.5, width)) {
      room(12);
      text(l, MARGIN, 8.5, MUTED);
      y -= 11;
    }
  }

  // ---- how it was paid -----------------------------------------------------
  //
  // `unknown` prints nothing at all. An order can carry no payment status, and
  // reading that absence as "unpaid" puts a false statement across the bottom
  // of a completed order's receipt — the same rule the view model states, kept
  // here so the PDF cannot drift from the page.
  if (view.paymentState !== 'unknown') {
    y -= 6;
    room(16);
    const paid = view.paymentState === 'paid';
    text(paid ? `${strings.paidWith}: ${view.paymentMethod}` : strings.unpaid, MARGIN, 10, paid ? INK : MUTED);
  }

  /*
   * Page numbers, stamped at the end because that is the only moment the total
   * is known. Digits and a slash rather than a translated "page 2 of 3": it
   * reads the same in every locale this project serves, and it is one fewer
   * string that can be missing in one of them.
   */
  const pages = doc.getPages();
  if (pages.length > 1) {
    pages.forEach((p, i) => {
      const label = `${i + 1} / ${pages.length}`;
      p.drawText(label, {
        x: right - font.widthOfTextAtSize(label, 8.5),
        y: MARGIN - 18,
        size: 8.5,
        font,
        color: MUTED,
      });
    });
  }

  return doc.save();
}
