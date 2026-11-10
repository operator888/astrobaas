/**
 * An invoice or credit-memo RECORD as a PDF — the receipt pipeline, reused.
 *
 * Same engine as `receipt-pdf.ts`: pdf-lib, the embedded DejaVu font passed
 * in (Greek is mojibake in the 14 standard fonts — see receipt-font.ts), the
 * same `wrap()`, the same page geometry. No I/O here, so a test renders a
 * record with no filesystem.
 *
 * ## What the page claims, and what it may not
 *
 * The heading and the first line follow the record's STATE, never a choice
 * made here:
 *
 *  - issued by an issuer → "Invoice" / "Credit note", with the issuer's
 *    document number and identifiers. That number is the only document number
 *    this file ever prints.
 *  - anything else (no issuer, a failed issue, issued elsewhere, a draft) →
 *    "Invoice record" / "Credit memo record", the line saying it is NOT a tax
 *    document, and no document number. The shop's internal reference, when it
 *    has one, is printed under a label that says it is not an invoice number.
 *
 * AstroBaaS is not a fiscal device (owner decision, see `Address.tax_id`). A
 * PDF that looked like an invoice without anyone having issued one would be
 * the liability `receipt.ts` describes, with a number on it.
 */
import { PDFDocument, rgb, type PDFPage } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { wrap } from './receipt-pdf';
import { isIssuedDocument } from './invoice-records-rules';
import type { InvoiceDocument, InvoiceParty } from '../../core/models';
import type { PublicStrings } from '../i18n/public-strings';
import { fill } from '../i18n/public-strings';

export interface InvoicePdfContext {
  strings: PublicStrings['invoice'];
  /** The order's human number, e.g. OG-1042. */
  orderNumber: string;
  /** Formats minor units in the record's currency. */
  money: (cents: number) => string;
  /** The issuer's display name, when one issued it. */
  issuerLabel?: string;
  /**
   * Test seam: every string drawn is pushed here. A PDF's text is glyph ids
   * in a subsetted font, so the bytes cannot be searched for words (see
   * tests/receipt-pdf.test.mjs); this is how a test proves what the page SAYS.
   */
  trace?: string[];
}

const PAGE = { width: 595.28, height: 841.89 };
const MARGIN = 56;
const INK = rgb(0.06, 0.09, 0.13);
const MUTED = rgb(0.42, 0.45, 0.5);
const RULE = rgb(0.85, 0.87, 0.89);
const ALERT = rgb(0.6, 0.1, 0.1);

/** `receiptPdfFilename`'s rule: only characters that cannot break the header. */
export function invoicePdfFilename(doc: Pick<InvoiceDocument, 'id' | 'kind'>, orderNumber: unknown): string {
  const base = doc.kind === 'credit_memo' ? 'credit-memo' : 'invoice-record';
  const n = String(orderNumber ?? '').replace(/[^A-Za-z0-9_-]/g, '');
  const k = /\.((?:inv|cm)-\d+)$/.exec(doc.id)?.[1] ?? '';
  return `${base}${n ? `-${n}` : ''}${k ? `-${k}` : ''}.pdf`;
}

/** The heading and disclaimer a record's state calls for. Exported so the test names them. */
export function invoiceHeading(doc: InvoiceDocument, s: PublicStrings['invoice']): { heading: string; disclaimer: string | null } {
  const issued = isIssuedDocument(doc);
  const memo = doc.kind === 'credit_memo';
  return {
    heading: issued ? (memo ? s.memoHeading : s.invoiceHeading) : (memo ? s.memoRecordHeading : s.recordHeading),
    disclaimer: issued ? null : s.notTaxDocument,
  };
}

function partyLines(p: InvoiceParty | undefined, s: PublicStrings['invoice']): string[] {
  if (!p) return [];
  return [
    p.name ?? '',
    p.company ?? '',
    p.address ?? '',
    p.country && !(p.address ?? '').includes(p.country) ? p.country : '',
    p.tax_id ? `${s.taxId}: ${p.tax_id}` : '',
  ].filter(Boolean);
}

const pct = (bp: number) => {
  const v = bp / 100;
  return `${Number.isInteger(v) ? v : v.toFixed(2)}%`;
};

export async function invoicePdfBytes(
  doc: InvoiceDocument,
  ctx: InvoicePdfContext,
  fontBytes: Uint8Array,
  /** For a credit memo: the parties of the record it credits. */
  parties?: { seller?: InvoiceParty; buyer?: InvoiceParty },
): Promise<Uint8Array> {
  const s = ctx.strings;
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(fontBytes, { subset: true });

  const right = PAGE.width - MARGIN;
  const width = right - MARGIN;
  let page: PDFPage = pdf.addPage([PAGE.width, PAGE.height]);
  let y = PAGE.height - MARGIN;

  // Every string goes through here, so `ctx.trace` sees exactly what was drawn.
  const draw = (str: string, x: number, size: number, color: typeof INK) => {
    ctx.trace?.push(str);
    page.drawText(str, { x, y, size, font, color });
  };
  const text = (str: string, x: number, size: number, color = INK) => draw(str, x, size, color);
  const textRight = (str: string, xEnd: number, size: number, color = INK) =>
    draw(str, xEnd - font.widthOfTextAtSize(str, size), size, color);
  const rule = () => page.drawLine({ start: { x: MARGIN, y }, end: { x: right, y }, thickness: 0.75, color: RULE });
  // A continuation page names its record, as the receipt's does.
  const room = (needed: number) => {
    if (y - needed >= MARGIN) return;
    page = pdf.addPage([PAGE.width, PAGE.height]);
    y = PAGE.height - MARGIN - 14;
    text(`${s.record}: ${doc.id} · ${s.orderNo}: ${ctx.orderNumber}`, MARGIN, 9, MUTED);
    y -= 10;
    rule();
    y -= 18;
  };
  const para = (str: string, size: number, color = INK) => {
    for (const l of wrap(str, font, size, width)) {
      room(size + 3);
      text(l, MARGIN, size, color);
      y -= size + 3;
    }
  };

  // ---- heading and what this document is --------------------------------
  const { heading, disclaimer } = invoiceHeading(doc, s);
  y -= 24;
  text(heading, MARGIN, 22);
  y -= 18;
  if (doc.status === 'draft') para(s.draft, 10, ALERT);
  if (doc.status === 'cancelled') para(s.cancelled, 10, ALERT);
  if (disclaimer) para(disclaimer, 9.5, ALERT);

  if (isIssuedDocument(doc) && doc.issuer) {
    if (doc.issuer.number) para(`${s.documentNo}: ${doc.issuer.number}`, 11);
    if (ctx.issuerLabel) para(fill(s.issuedBy, { issuer: ctx.issuerLabel }), 9, MUTED);
    for (const [k, v] of Object.entries(doc.issuer.identifiers ?? {})) para(`${k}: ${v}`, 8.5, MUTED);
  }
  if (doc.issued_externally) {
    para(doc.issued_externally.number
      ? fill(s.issuedElsewhereAs, { number: doc.issued_externally.number })
      : s.issuedElsewhere, 9, MUTED);
  }
  if (doc.internal_reference) para(`${s.internalReference}: ${doc.internal_reference}`, 9, MUTED);
  if (doc.kind === 'credit_memo') para(fill(s.credits, { id: doc.invoice_record_id }), 9, MUTED);

  // ---- parties ------------------------------------------------------------
  y -= 8;
  const seller = doc.kind === 'invoice' ? doc.seller : parties?.seller;
  const buyer = doc.kind === 'invoice' ? doc.buyer : parties?.buyer;
  const half = width / 2 - 8;
  const startY = y;
  const column = (x: number, title: string, body: string[]) => {
    y = startY;
    text(title, x, 9, MUTED);
    y -= 13;
    for (const raw of body) {
      for (const l of wrap(raw, font, 10, half)) {
        text(l, x, 10);
        y -= 13;
      }
    }
    return y;
  };
  const sy = column(MARGIN, s.seller, partyLines(seller, s));
  const by = column(MARGIN + half + 16, s.buyer, partyLines(buyer, s));
  y = Math.min(sy, by) - 8;

  room(30);
  text(`${s.orderNo}: ${ctx.orderNumber}`, MARGIN, 10);
  textRight(`${s.date}: ${String(doc.finalised_at ?? doc.created_at).slice(0, 10)}`, right, 10);
  y -= 13;
  text(`${s.record}: ${doc.id}`, MARGIN, 8.5, MUTED);
  y -= 10;
  rule();
  y -= 16;

  // ---- lines ----------------------------------------------------------------
  const colQty = right - 230;
  const colVat = right - 170;
  const colNet = right - 85;
  const colTotal = right;
  const nameWidth = colQty - MARGIN - 40;
  text(s.item, MARGIN, 9, MUTED);
  textRight(s.qty, colQty, 9, MUTED);
  textRight(s.vatRate, colVat, 9, MUTED);
  textRight(s.net, colNet, 9, MUTED);
  textRight(s.amount, colTotal, 9, MUTED);
  y -= 6;
  rule();
  y -= 14;
  const showRates = doc.vat.length > 0;
  for (const l of doc.lines) {
    const names = wrap(l.description, font, 10, nameWidth);
    room(13 * names.length + 6);
    const top = y;
    for (const n of names) {
      text(n, MARGIN, 10);
      y -= 13;
    }
    const after = y;
    y = top;
    textRight(l.qty === undefined ? '' : String(l.qty), colQty, 10);
    textRight(showRates ? pct(l.tax_rate_bp) : '', colVat, 10, MUTED);
    textRight(ctx.money(l.net_cents), colNet, 10);
    textRight(ctx.money(l.total_cents), colTotal, 10);
    y = after - 4;
  }
  y -= 2;
  rule();
  y -= 18;

  // ---- VAT by rate ----------------------------------------------------------
  if (showRates) {
    room(16 * (doc.vat.length + 2));
    text(s.vatAnalysis, MARGIN, 10);
    y -= 15;
    text(s.vatRate, MARGIN, 9, MUTED);
    textRight(s.base, colNet, 9, MUTED);
    textRight(s.vat, colTotal, 9, MUTED);
    y -= 13;
    for (const row of doc.vat) {
      room(14);
      text(pct(row.rate_bp), MARGIN, 10);
      textRight(ctx.money(row.base_cents), colNet, 10);
      textRight(ctx.money(row.tax_cents), colTotal, 10);
      y -= 14;
    }
    y -= 6;
  } else {
    para(s.vatIncomplete, 8.5, MUTED);
    y -= 6;
  }
  if (doc.kind === 'invoice' && doc.vat_complete === false && showRates) {
    para(s.vatIncomplete, 8.5, MUTED);
    y -= 4;
  }

  // ---- totals -----------------------------------------------------------------
  const totalRow = (label: string, value: string, size = 10, color = INK) => {
    room(size + 6);
    text(label, colVat - 60, size, color);
    textRight(value, colTotal, size, color);
    y -= size + 5;
  };
  totalRow(s.netTotal, ctx.money(doc.net_cents), 10, MUTED);
  totalRow(s.vat, ctx.money(doc.tax_cents), 10, MUTED);
  totalRow(s.total, ctx.money(doc.total_cents), 13);

  const pages = pdf.getPages();
  if (pages.length > 1) {
    pages.forEach((p, i) => {
      const label = `${i + 1} / ${pages.length}`;
      p.drawText(label, { x: right - font.widthOfTextAtSize(label, 8.5), y: MARGIN - 18, size: 8.5, font, color: MUTED });
    });
  }
  return pdf.save();
}
