/**
 * Invoices, credit notes, quotes and payment reminders as PDF.
 *
 * Laid out on DIN 5008 form B lines so the recipient address sits in a C5/DL
 * window envelope, with the legally required footer (§14 UStG, §35a GmbHG) on
 * every page. Drawn directly with pdf-lib — no headless browser — and
 * finished as PDF/A-3b, with the e-invoice XML embedded when one is passed
 * (ZUGFeRD / Factur-X).
 *
 * The font is the same embedded DejaVu Sans the shop receipts use, so Greek
 * and every Latin accent render; the 14 standard PDF fonts would both fail
 * that and break PDF/A (they are not embedded).
 */
import { PDFDocument, degrees, rgb, type PDFFont, type PDFImage, type PDFPage, type RGB } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import type { CompanyProfile, FinanceDocument } from './types';
import { DOC_STRINGS, unitLabel } from './strings';
import { formatAmount, formatDate, formatMoney, formatQty, legalName } from './format';
import { treatmentNote } from './tax';
import { makePdfA3, type FacturxLevel } from './facturx';
import { epcPayload, qrEncode } from './qr';

const MM = 72 / 25.4;
const W = 595.28;
const H = 841.89;
const LEFT = 25 * MM;
const RIGHT = W - 20 * MM;
const CONTENT = RIGHT - LEFT;
const FOOTER_TOP = 30 * MM;
const INK = rgb(0.1, 0.11, 0.14);
const MUTED = rgb(0.42, 0.45, 0.5);
const RULE = rgb(0.82, 0.84, 0.87);
const ZEBRA = rgb(0.965, 0.97, 0.975);

function hexColor(hex: string | undefined, fallback: RGB): RGB {
  const m = (hex ?? '').match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return fallback;
  return rgb(parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255);
}

export function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const out: string[] = [];
  for (const paragraph of String(text ?? '').split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) { line = candidate; continue; }
      if (line) out.push(line);
      if (font.widthOfTextAtSize(word, size) <= maxWidth) { line = word; continue; }
      let chunk = '';
      for (const ch of word) {
        if (font.widthOfTextAtSize(chunk + ch, size) > maxWidth) { out.push(chunk); chunk = ch; } else chunk += ch;
      }
      line = chunk;
    }
    out.push(line);
  }
  return out;
}

interface Ctx {
  pdf: PDFDocument;
  font: PDFFont;
  page: PDFPage;
  y: number;
  accent: RGB;
  lang: 'de' | 'en';
  s: (typeof DOC_STRINGS)['de'];
  company: CompanyProfile;
  continuationTitle: string;
  logo?: PDFImage;
}

function text(c: Ctx, str: string, x: number, y: number, size = 9, opts: { color?: RGB; bold?: boolean; align?: 'left' | 'right' } = {}) {
  const w = c.font.widthOfTextAtSize(str, size);
  const xx = opts.align === 'right' ? x - w : x;
  const color = opts.color ?? INK;
  c.page.drawText(str, { x: xx, y, size, font: c.font, color });
  // Faux bold: one embedded face keeps the file small; a second stroke 0.3 pt
  // to the right reads as bold on screen and in print.
  if (opts.bold) c.page.drawText(str, { x: xx + Math.max(0.25, size * 0.03), y, size, font: c.font, color });
}

function footer(c: Ctx) {
  const co = c.company;
  const s = c.s;
  const size = 6.8;
  const colW = CONTENT / 4;
  const top = FOOTER_TOP - 6;
  c.page.drawLine({ start: { x: LEFT, y: FOOTER_TOP }, end: { x: RIGHT, y: FOOTER_TOP }, thickness: 0.5, color: RULE });
  const cols: string[][] = [
    [legalName(co), co.street, `${co.zip} ${co.city}`, co.country !== 'DE' ? co.country : ''],
    [co.phone ? `Tel. ${co.phone}` : '', co.email, co.website ?? ''],
    co.iban ? [co.bank_name ?? s.bank, `IBAN ${co.iban.replace(/(.{4})/g, '$1 ').trim()}`, co.bic ? `BIC ${co.bic}` : ''] : [],
    [
      co.managing_directors ? `${s.md}: ${co.managing_directors}` : '',
      [co.register_court, co.register_number].filter(Boolean).join(' '),
      co.vat_id ? `${s.vatId} ${co.vat_id}` : '',
      co.tax_number ? `${s.taxNo} ${co.tax_number}` : '',
    ],
  ];
  cols.forEach((lines, i) => {
    let y = top;
    for (const l of lines.filter(Boolean)) {
      for (const w of wrapText(l, c.font, size, colW - 6)) {
        text(c, w, LEFT + i * colW, y, size, { color: MUTED });
        y -= size + 2;
      }
    }
  });
}

function newPage(c: Ctx, first: boolean) {
  c.page = c.pdf.addPage([W, H]);
  footer(c);
  if (c.logo) {
    const maxW = 50 * MM;
    const maxH = 18 * MM;
    const scale = Math.min(maxW / c.logo.width, maxH / c.logo.height, 1);
    const w = c.logo.width * scale;
    const h = c.logo.height * scale;
    c.page.drawImage(c.logo, { x: RIGHT - w, y: H - 12 * MM - h, width: w, height: h });
  } else if (first) {
    text(c, legalName(c.company), RIGHT, H - 22 * MM, 15, { color: c.accent, bold: true, align: 'right' });
    if (c.company.tagline) text(c, c.company.tagline, RIGHT, H - 22 * MM - 13, 8.5, { color: MUTED, align: 'right' });
  }
  if (first) {
    c.y = H - 45 * MM;
  } else {
    c.y = H - 35 * MM;
    text(c, c.continuationTitle, LEFT, c.y, 9, { color: MUTED });
    c.y -= 16;
  }
}

function ensure(c: Ctx, needed: number, onBreak?: () => void) {
  if (c.y - needed >= FOOTER_TOP + 14) return;
  newPage(c, false);
  onBreak?.();
}

async function embedLogo(pdf: PDFDocument, dataUrl?: string): Promise<PDFImage | undefined> {
  if (!dataUrl) return undefined;
  const m = dataUrl.match(/^data:image\/(png|jpe?g);base64,(.+)$/i);
  if (!m) return undefined;
  try {
    const bytes = Buffer.from(m[2], 'base64');
    return m[1].toLowerCase() === 'png' ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
  } catch {
    return undefined; // a broken logo must never stop an invoice
  }
}

function addressBlock(c: Ctx, recipient: FinanceDocument['recipient']) {
  const co = c.company;
  // DIN 5008 B: return-address line, then the address field.
  const sender = [legalName(co), co.street, `${co.zip} ${co.city}`].filter(Boolean).join(' · ');
  text(c, sender, LEFT, c.y, 6.5, { color: MUTED });
  c.page.drawLine({ start: { x: LEFT, y: c.y - 2.5 }, end: { x: LEFT + Math.min(85 * MM, c.font.widthOfTextAtSize(sender, 6.5)), y: c.y - 2.5 }, thickness: 0.3, color: MUTED });
  let y = c.y - 16;
  const lines = [
    recipient.name, recipient.supplement, recipient.street,
    [recipient.zip, recipient.city].filter(Boolean).join(' '),
    recipient.country && recipient.country !== (co.country || 'DE') ? countryName(recipient.country, c.lang) : '',
  ].filter(Boolean) as string[];
  for (const l of lines) {
    for (const w of wrapText(l, c.font, 10, 85 * MM)) {
      text(c, w, LEFT, y, 10);
      y -= 13;
    }
  }
}

function countryName(code: string, lang: 'de' | 'en'): string {
  try {
    return new Intl.DisplayNames([lang], { type: 'region' }).of(code.toUpperCase())?.toUpperCase() ?? code;
  } catch {
    return code;
  }
}

function infoBlock(c: Ctx, rows: [string, string][]) {
  const x = 125 * MM;
  let y = H - 50 * MM;
  for (const [label, value] of rows) {
    if (!value) continue;
    text(c, label, x, y, 8.5, { color: MUTED });
    text(c, value, RIGHT, y, 8.5, { align: 'right' });
    y -= 12.5;
  }
}

/**
 * GiroCode (EPC QR) under an invoice: a banking app scans it and prefills the
 * transfer with IBAN, amount and invoice number — the cheapest way to make a
 * customer pay on time. Only for an unpaid EUR invoice with a valid IBAN.
 */
function drawGiroCode(c: Ctx, doc: FinanceDocument) {
  const co = c.company;
  if (doc.type !== 'invoice' || doc.currency !== 'EUR' || !doc.number || !co.iban) return;
  const open = doc.totals.gross_cents - (doc.paid_cents ?? 0);
  const payload = epcPayload({
    name: co.account_holder || legalName(co), iban: co.iban, bic: co.bic,
    amount_cents: open, reference: `${c.s.invoice} ${doc.number}`,
  });
  if (!payload) return;
  const matrix = qrEncode(new TextEncoder().encode(payload));
  const quiet = 2;
  const side = 27 * MM;
  const mod = side / (matrix.length + quiet * 2);
  ensure(c, side + 8);
  const top = c.y;
  c.page.drawRectangle({ x: LEFT, y: top - side, width: side, height: side, color: rgb(1, 1, 1) });
  for (let y = 0; y < matrix.length; y++) {
    for (let x = 0; x < matrix.length; x++) {
      if (!matrix[y][x]) continue;
      c.page.drawRectangle({
        x: LEFT + (x + quiet) * mod, y: top - (y + quiet + 1) * mod,
        width: mod + 0.02, height: mod + 0.02, color: rgb(0, 0, 0),
      });
    }
  }
  for (const [i, l] of wrapText(c.s.giroCode, c.font, 8, CONTENT - side - 14).entries()) {
    text(c, l, LEFT + side + 12, top - 16 - i * 11, 8, { color: MUTED });
  }
  c.y = top - side - 8;
}

export interface RenderOptions {
  fontBytes: Uint8Array;
  customerNumber?: string;
  /** E-invoice XML to embed (ZUGFeRD). */
  xml?: string;
  level?: FacturxLevel;
  now?: Date;
}

/** Column anchors: `qty`, `unitPrice` and `total` are RIGHT edges; the rest left edges. */
const COLS = (() => {
  const total = RIGHT;
  const unitPrice = RIGHT - 75;
  const unit = RIGHT - 182;
  const qty = unit - 8;
  const desc = LEFT + 26;
  return { pos: LEFT, desc, descW: qty - 42 - desc, qty, unit, unitPrice, total };
})();

function tableHeader(c: Ctx) {
  const s = c.s;
  c.page.drawRectangle({ x: LEFT - 4, y: c.y - 5, width: CONTENT + 8, height: 17, color: c.accent, opacity: 0.1 });
  text(c, s.pos, COLS.pos, c.y, 8, { bold: true });
  text(c, s.description, COLS.desc, c.y, 8, { bold: true });
  text(c, s.qty, COLS.qty, c.y, 8, { bold: true, align: 'right' });
  text(c, s.unit, COLS.unit, c.y, 8, { bold: true });
  text(c, s.unitPrice, COLS.unitPrice, c.y, 8, { bold: true, align: 'right' });
  text(c, s.total, COLS.total, c.y, 8, { bold: true, align: 'right' });
  c.y -= 20;
}

export async function renderDocumentPdf(doc: FinanceDocument, company: CompanyProfile, opts: RenderOptions): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(opts.fontBytes, { subset: true });
  const lang = company.document_language || 'de';
  const s = DOC_STRINGS[lang] as (typeof DOC_STRINGS)['de'];
  const title = s[doc.type];
  const numberLabel = s.number[doc.type];
  const c: Ctx = {
    pdf, font, page: undefined as unknown as PDFPage, y: 0,
    accent: hexColor(company.accent_color, rgb(0.11, 0.3, 0.55)), lang, s, company,
    continuationTitle: `${title} ${doc.number ?? ''}`.trim(),
    logo: await embedLogo(pdf, company.logo_data_url),
  };
  newPage(c, true);
  addressBlock(c, doc.recipient);

  const period = doc.service_date && doc.service_date_end
    ? `${formatDate(doc.service_date, lang)} – ${formatDate(doc.service_date_end, lang)}` : '';
  infoBlock(c, [
    [numberLabel, doc.number ?? (lang === 'de' ? 'ENTWURF' : 'DRAFT')],
    [s.date, formatDate(doc.issue_date, lang)],
    [s.customerNo, opts.customerNumber ?? ''],
    [s.yourRef, doc.reference ?? ''],
    [period ? s.servicePeriod : s.serviceDate, period || (doc.type !== 'quote' ? formatDate(doc.service_date || doc.issue_date, lang) : '')],
    [doc.type === 'quote' ? s.validUntil : s.dueDate, formatDate(doc.type === 'quote' ? doc.valid_until : doc.type === 'invoice' ? doc.due_date : undefined, lang)],
    [s.refersTo, doc.refers_to_number ?? ''],
    [s.yourVatId, doc.tax_treatment !== 'domestic' && doc.tax_treatment !== 'small_business' ? (doc.recipient.vat_id ?? '') : ''],
  ]);

  c.y = H - 103 * MM;
  text(c, `${doc.title || title} ${doc.number ?? ''}`.trim(), LEFT, c.y, 15, { bold: true });
  c.y -= 22;
  if (doc.intro) {
    for (const l of wrapText(doc.intro, font, 9.5, CONTENT)) {
      ensure(c, 13);
      text(c, l, LEFT, c.y, 9.5);
      c.y -= 13;
    }
    c.y -= 8;
  }

  // Table.
  tableHeader(c);
  const byId = new Map(doc.totals.lines.map((l) => [l.id, l]));
  let pos = 0;
  let zebra = false;
  for (const line of doc.lines) {
    const descLines = line.description ? wrapText(line.description, font, 8, COLS.descW) : [];
    const nameLines = wrapText(line.name || '', font, 9, COLS.descW);
    const periodLine = line.period_start && line.period_end
      ? `${formatDate(line.period_start, lang)} – ${formatDate(line.period_end, lang)}` : '';
    const rowH = nameLines.length * 12 + descLines.length * 10.5 + (periodLine ? 10.5 : 0) + 7;
    ensure(c, rowH, () => tableHeader(c));
    if (line.type === 'text') {
      nameLines.forEach((l, i) => text(c, l, COLS.desc, c.y - i * 12, 9, { bold: true }));
      let yy = c.y - nameLines.length * 12;
      for (const d of descLines) { text(c, d, COLS.desc, yy, 8, { color: MUTED }); yy -= 10.5; }
      c.y -= rowH;
      continue;
    }
    pos += 1;
    zebra = !zebra;
    if (zebra) c.page.drawRectangle({ x: LEFT - 4, y: c.y - rowH + 9, width: CONTENT + 8, height: rowH, color: ZEBRA });
    const computed = byId.get(line.id);
    text(c, String(pos), COLS.pos, c.y, 9);
    nameLines.forEach((l, i) => text(c, l, COLS.desc, c.y - i * 12, 9));
    let yy = c.y - nameLines.length * 12;
    for (const d of descLines) { text(c, d, COLS.desc, yy, 8, { color: MUTED }); yy -= 10.5; }
    if (periodLine) text(c, periodLine, COLS.desc, yy, 8, { color: MUTED });
    text(c, formatQty(line.quantity, lang), COLS.qty, c.y, 9, { align: 'right' });
    text(c, unitLabel(line.unit, lang), COLS.unit, c.y, 9);
    const unitPrice = formatAmount(line.unit_price_cents, lang);
    text(c, unitPrice, COLS.unitPrice, c.y, 9, { align: 'right' });
    if (line.discount_percent) {
      text(c, `−${formatQty(line.discount_percent, lang)} %`, COLS.unitPrice, c.y - 10.5, 7.5, { color: MUTED, align: 'right' });
    }
    // In gross mode the line shows the gross amount the user typed.
    const lineAmount = doc.price_mode === 'gross'
      ? Math.round((computed?.net_cents ?? 0) * (1 + (computed?.rate ?? 0) / 100))
      : computed?.net_cents ?? 0;
    text(c, formatAmount(lineAmount, lang), COLS.total, c.y, 9, { align: 'right' });
    c.y -= rowH;
  }
  c.page.drawLine({ start: { x: LEFT, y: c.y + 6 }, end: { x: RIGHT, y: c.y + 6 }, thickness: 0.6, color: RULE });
  c.y -= 8;

  // Totals.
  const t = doc.totals;
  const cur = doc.currency;
  const labelX = RIGHT - 230;
  ensure(c, 40 + t.groups.length * 13);
  text(c, s.net, labelX, c.y, 9);
  text(c, formatMoney(t.net_cents, cur, lang), RIGHT, c.y, 9, { align: 'right' });
  c.y -= 13;
  for (const g of t.groups) {
    if (g.rate === 0 && doc.tax_treatment !== 'domestic') continue;
    const label = `${s.vat} ${formatQty(g.rate, lang)} %${t.groups.length > 1 ? ` (${formatAmount(g.net_cents, lang)})` : ''}`;
    text(c, label, labelX, c.y, 9);
    text(c, formatMoney(g.tax_cents, cur, lang), RIGHT, c.y, 9, { align: 'right' });
    c.y -= 13;
  }
  c.page.drawLine({ start: { x: labelX, y: c.y + 9 }, end: { x: RIGHT, y: c.y + 9 }, thickness: 0.6, color: INK });
  c.y -= 3;
  text(c, t.tax_cents ? s.grossIncl : s.gross, labelX, c.y, 10.5, { bold: true });
  text(c, formatMoney(t.gross_cents, cur, lang), RIGHT, c.y, 10.5, { bold: true, align: 'right' });
  c.y -= 24;

  const paragraphs: string[] = [];
  const note = treatmentNote(doc.tax_treatment, lang);
  if (note) paragraphs.push(note);
  if (doc.type === 'invoice' && doc.due_date) {
    paragraphs.push(doc.payment_terms_text || s.payWithin(doc.payment_days ?? 14, formatDate(doc.due_date, lang)));
    if (doc.number) paragraphs.push(s.payReference(doc.number));
  }
  if (doc.closing) paragraphs.push(doc.closing);
  for (const p of paragraphs) {
    const lines = wrapText(p, font, 9, CONTENT);
    ensure(c, lines.length * 12.5 + 6);
    for (const l of lines) { text(c, l, LEFT, c.y, 9); c.y -= 12.5; }
    c.y -= 6;
  }

  drawGiroCode(c, doc);
  finishPages(c, doc.status === 'draft');
  const created = opts.now ?? new Date();
  makePdfA3(pdf, {
    title: `${title} ${doc.number ?? ''}`.trim(), author: legalName(company), created,
    xml: opts.xml, level: opts.level,
  });
  return pdf.save({ useObjectStreams: false, updateFieldAppearances: false });
}

function finishPages(c: Ctx, draft: boolean) {
  const pages = c.pdf.getPages();
  pages.forEach((p, i) => {
    const label = `${c.s.page} ${i + 1}/${pages.length}`;
    const w = c.font.widthOfTextAtSize(label, 7.5);
    p.drawText(label, { x: RIGHT - w, y: FOOTER_TOP + 6, size: 7.5, font: c.font, color: MUTED });
    if (draft) {
      p.drawText(c.lang === 'de' ? 'ENTWURF' : 'DRAFT', {
        x: 150, y: 300, size: 96, font: c.font, color: rgb(0.85, 0.2, 0.2), opacity: 0.12, rotate: degrees(35),
      });
    }
  });
}

export interface DunningInput {
  level: number;
  title: string;
  body: string;
  date: string;
  recipient: FinanceDocument['recipient'];
  invoices: { number: string; date: string; due_date?: string; gross_cents: number; paid_cents: number }[];
  fee_cents: number;
  interest_cents: number;
  currency: string;
  pay_by: string;
  customerNumber?: string;
}

export async function renderDunningPdf(d: DunningInput, company: CompanyProfile, opts: RenderOptions): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(opts.fontBytes, { subset: true });
  const lang = company.document_language || 'de';
  const s = DOC_STRINGS[lang] as (typeof DOC_STRINGS)['de'];
  const c: Ctx = {
    pdf, font, page: undefined as unknown as PDFPage, y: 0,
    accent: hexColor(company.accent_color, rgb(0.11, 0.3, 0.55)), lang, s, company,
    continuationTitle: d.title, logo: await embedLogo(pdf, company.logo_data_url),
  };
  newPage(c, true);
  addressBlock(c, d.recipient);
  infoBlock(c, [[s.date, formatDate(d.date, lang)], [s.customerNo, d.customerNumber ?? '']]);
  c.y = H - 103 * MM;
  text(c, d.title, LEFT, c.y, 15, { bold: true });
  c.y -= 22;
  for (const l of wrapText(d.body, font, 9.5, CONTENT)) { ensure(c, 13); text(c, l, LEFT, c.y, 9.5); c.y -= 13; }
  c.y -= 10;
  text(c, s.dunningTable, LEFT, c.y, 9, { bold: true });
  c.y -= 16;
  let open = 0;
  for (const inv of d.invoices) {
    ensure(c, 14);
    const o = inv.gross_cents - inv.paid_cents;
    open += o;
    text(c, inv.number, LEFT, c.y, 9);
    text(c, formatDate(inv.date, lang), LEFT + 110, c.y, 9);
    text(c, inv.due_date ? `${s.dueDate} ${formatDate(inv.due_date, lang)}` : '', LEFT + 180, c.y, 9, { color: MUTED });
    text(c, formatMoney(o, d.currency, lang), RIGHT, c.y, 9, { align: 'right' });
    c.y -= 14;
  }
  const rows: [string, number][] = [];
  if (d.fee_cents) rows.push([s.fee, d.fee_cents]);
  if (d.interest_cents) rows.push([s.interest, d.interest_cents]);
  for (const [label, cents] of rows) {
    text(c, label, LEFT, c.y, 9);
    text(c, formatMoney(cents, d.currency, lang), RIGHT, c.y, 9, { align: 'right' });
    c.y -= 14;
  }
  c.page.drawLine({ start: { x: RIGHT - 190, y: c.y + 9 }, end: { x: RIGHT, y: c.y + 9 }, thickness: 0.6, color: INK });
  c.y -= 3;
  text(c, s.openAmount, RIGHT - 190, c.y, 10.5, { bold: true });
  text(c, formatMoney(open + d.fee_cents + d.interest_cents, d.currency, lang), RIGHT, c.y, 10.5, { bold: true, align: 'right' });
  finishPages(c, false);
  makePdfA3(pdf, { title: d.title, author: legalName(company), created: opts.now ?? new Date() });
  return pdf.save({ useObjectStreams: false, updateFieldAppearances: false });
}

export function pdfFilename(prefix: string, number: string | undefined): string {
  const cleaned = String(number ?? '').replace(/[^A-Za-z0-9_-]/g, '');
  return cleaned ? `${prefix}-${cleaned}.pdf` : `${prefix}.pdf`;
}
