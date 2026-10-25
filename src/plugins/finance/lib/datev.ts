/**
 * DATEV-Format export: "Buchungsstapel" (EXTF 700, category 21, version 13).
 *
 * This is the file a Steuerberater imports into DATEV Kanzlei-Rechnungswesen.
 * The 125 column names below are the Formatversion 13 list as published in
 * the MIT-licensed @seamless-engineering/datev-extf package (see
 * THIRD-PARTY-NOTICES.md); DATEV reads columns by POSITION, so every row is
 * padded to all 125.
 *
 * File conventions DATEV expects: Windows-1252, `;`-separated, CRLF line
 * endings (including after the last row), decimal comma with no thousands
 * separator, Belegdatum as DDMM with the year taken from the header.
 */
export const BUCHUNGSSTAPEL_COLUMNS = [
  'Umsatz (ohne Soll/Haben-Kz)', 'Soll/Haben-Kennzeichen', 'WKZ Umsatz', 'Kurs', 'Basis-Umsatz',
  'WKZ Basis-Umsatz', 'Konto', 'Gegenkonto (ohne BU-Schlüssel)', 'BU-Schlüssel', 'Belegdatum',
  'Belegfeld 1', 'Belegfeld 2', 'Skonto', 'Buchungstext', 'Postensperre', 'Diverse Adressnummer',
  'Geschäftspartnerbank', 'Sachverhalt', 'Zinssperre', 'Beleglink',
  'Beleginfo - Art 1', 'Beleginfo - Inhalt 1', 'Beleginfo - Art 2', 'Beleginfo - Inhalt 2',
  'Beleginfo - Art 3', 'Beleginfo - Inhalt 3', 'Beleginfo - Art 4', 'Beleginfo - Inhalt 4',
  'Beleginfo - Art 5', 'Beleginfo - Inhalt 5', 'Beleginfo - Art 6', 'Beleginfo - Inhalt 6',
  'Beleginfo - Art 7', 'Beleginfo - Inhalt 7', 'Beleginfo - Art 8', 'Beleginfo - Inhalt 8',
  'KOST1 - Kostenstelle', 'KOST2 - Kostenstelle', 'Kost-Menge', 'EU-Land u. UStID (Bestimmung)',
  'EU-Steuersatz (Bestimmung)', 'Abw. Versteuerungsart', 'Sachverhalt L+L', 'Funktionsergänzung L+L',
  'BU 49 Hauptfunktionstyp', 'BU 49 Hauptfunktionsnummer', 'BU 49 Funktionsergänzung',
  ...Array.from({ length: 20 }, (_, i) => [`Zusatzinformation - Art ${i + 1}`, `Zusatzinformation- Inhalt ${i + 1}`]).flat(),
  'Stück', 'Gewicht', 'Zahlweise', 'Forderungsart', 'Veranlagungsjahr', 'Zugeordnete Fälligkeit',
  'Skontotyp', 'Auftragsnummer', 'Buchungstyp', 'USt-Schlüssel (Anzahlungen)', 'EU-Land (Anzahlungen)',
  'Sachverhalt L+L (Anzahlungen)', 'EU-Steuersatz (Anzahlungen)', 'Erlöskonto (Anzahlungen)',
  'Herkunft-Kz', 'Buchungs GUID', 'KOST-Datum', 'SEPA-Mandatsreferenz', 'Skontosperre',
  'Gesellschaftername', 'Beteiligtennummer', 'Identifikationsnummer', 'Zeichnernummer',
  'Postensperre bis', 'Bezeichnung SoBil-Sachverhalt', 'Kennzeichen SoBil-Buchung', 'Festschreibung',
  'Leistungsdatum', 'Datum Zuord. Steuerperiode', 'Fälligkeit', 'Generalumkehr (GU)', 'Steuersatz',
  'Land', 'Abrechnungsreferenz', 'BVV-Position', 'EU-Land u. UStID (Ursprung)',
  'EU-Steuersatz (Ursprung)', 'Abw. Skontokonto',
] as const;

const COL = (name: (typeof BUCHUNGSSTAPEL_COLUMNS)[number]) => BUCHUNGSSTAPEL_COLUMNS.indexOf(name);

export interface DatevBooking {
  /** Positive amount in cents; direction is `sh`. */
  amount_cents: number;
  sh: 'S' | 'H';
  account: number;
  contra: number;
  /** Tax key, '' for none (and always '' on Automatikkonten). */
  bu?: string;
  date: string; // ISO
  doc_no: string;
  doc_no2?: string;
  text: string;
  service_date?: string;
  due_date?: string;
  /** EU VAT id of the recipient, for reverse-charge revenue. */
  eu_vat_id?: string;
  currency?: string;
}

export interface DatevHeader {
  consultant: number; // Beraternummer
  client: number; // Mandantennummer
  fiscalYearStart: string; // ISO date
  accountLength: number; // Sachkontenlänge
  from: string; // ISO
  to: string; // ISO
  label: string;
  chart: 'SKR03' | 'SKR04';
  createdAt?: Date;
  /** Lock the bookings in DATEV (Festschreibung). Default: 0 = not locked. */
  lock?: boolean;
}

function q(s: string): string {
  // eslint-disable-next-line no-control-regex
  return `"${String(s).replace(/[\r\n\t\u0000-\u001f]/g, ' ').replace(/"/g, '""')}"`;
}

function ddmm(iso: string): string {
  return `${iso.slice(8, 10)}${iso.slice(5, 7)}`;
}

function ddmmyyyy(iso: string): string {
  return `${iso.slice(8, 10)}${iso.slice(5, 7)}${iso.slice(0, 4)}`;
}

function amount(cents: number): string {
  const abs = Math.abs(Math.round(cents));
  return `${Math.floor(abs / 100)},${String(abs % 100).padStart(2, '0')}`;
}

/** Belegfeld 1: max 36 chars from [A-Za-z0-9$&%*+-/]. */
export function belegfeld(s: string): string {
  return s.replace(/[^A-Za-z0-9$&%*+\-/]/g, '').slice(0, 36);
}

function stamp(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}${p(d.getUTCMilliseconds(), 3)}`;
}

export function headerLine(h: DatevHeader): string {
  const created = stamp(h.createdAt ?? new Date());
  const iso = (s: string) => s.replace(/-/g, '');
  const fields = [
    q('EXTF'), '700', '21', q('Buchungsstapel'), '13', created, '', q('RE'), q('ECWS Billing'), q(''),
    String(h.consultant), String(h.client), iso(h.fiscalYearStart), String(h.accountLength),
    iso(h.from), iso(h.to), q(h.label.slice(0, 30)), q(''), '1', '0', h.lock ? '1' : '0', q('EUR'),
    '', q(''), '', '', q(h.chart === 'SKR04' ? '04' : '03'), '', '', q(''), q(''),
  ];
  return fields.join(';');
}

export function bookingRow(b: DatevBooking): string {
  const row: string[] = new Array(BUCHUNGSSTAPEL_COLUMNS.length).fill('');
  row[COL('Umsatz (ohne Soll/Haben-Kz)')] = amount(b.amount_cents);
  row[COL('Soll/Haben-Kennzeichen')] = q(b.sh);
  row[COL('WKZ Umsatz')] = q(b.currency ?? 'EUR');
  row[COL('Konto')] = String(b.account);
  row[COL('Gegenkonto (ohne BU-Schlüssel)')] = String(b.contra);
  row[COL('BU-Schlüssel')] = b.bu ? q(b.bu) : '';
  row[COL('Belegdatum')] = ddmm(b.date);
  row[COL('Belegfeld 1')] = q(belegfeld(b.doc_no));
  row[COL('Belegfeld 2')] = b.doc_no2 ? q(b.doc_no2.slice(0, 12)) : '';
  row[COL('Buchungstext')] = q(b.text.slice(0, 60));
  if (b.eu_vat_id) row[COL('EU-Land u. UStID (Bestimmung)')] = q(b.eu_vat_id.replace(/\s+/g, '').slice(0, 15));
  if (b.service_date) {
    row[COL('Leistungsdatum')] = ddmmyyyy(b.service_date);
    // DATEV requires the tax-period date whenever a Leistungsdatum is given;
    // the document date is the period the VAT falls into (Soll-Versteuerung).
    row[COL('Datum Zuord. Steuerperiode')] = ddmmyyyy(b.date);
  }
  if (b.due_date) row[COL('Fälligkeit')] = ddmmyyyy(b.due_date);
  return row.join(';');
}

export function buildBuchungsstapel(h: DatevHeader, bookings: readonly DatevBooking[]): string {
  if (bookings.length > 99_999) throw new Error('DATEV allows at most 99,999 bookings per file; export a shorter period.');
  for (const b of bookings) {
    if (b.date < h.from || b.date > h.to) throw new Error(`Booking ${b.doc_no} (${b.date}) is outside the export period.`);
  }
  const lines = [headerLine(h), BUCHUNGSSTAPEL_COLUMNS.join(';'), ...bookings.map(bookingRow)];
  return `${lines.join('\r\n')}\r\n`;
}

/* ---------------------------- Windows-1252 ---------------------------- */

const CP1252_HIGH: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87,
  0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91,
  0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98,
  0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};

/** Encode to Windows-1252; anything outside it becomes '?' (Greek names → transliterate first). */
export function encodeCp1252(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  let n = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80 || (cp >= 0xa0 && cp <= 0xff)) out[n++] = cp;
    else out[n++] = CP1252_HIGH[cp] ?? 0x3f;
  }
  return out.slice(0, n);
}

/** Minimal Greek → Latin transliteration so Greek customer names survive CP1252. */
export function latinize(s: string): string {
  const map: Record<string, string> = {
    α: 'a', β: 'v', γ: 'g', δ: 'd', ε: 'e', ζ: 'z', η: 'i', θ: 'th', ι: 'i', κ: 'k', λ: 'l', μ: 'm',
    ν: 'n', ξ: 'x', ο: 'o', π: 'p', ρ: 'r', σ: 's', ς: 's', τ: 't', υ: 'y', φ: 'f', χ: 'ch', ψ: 'ps', ω: 'o',
  };
  // Only Greek letters are touched: Latin accents (é, ü) exist in CP1252 and stay.
  return s.replace(/[Ͱ-Ͽἀ-῿]/g, (c) => {
    const base = c.normalize('NFD')[0];
    const lower = base.toLowerCase();
    const t = map[lower];
    if (!t) return c;
    return base === lower ? t : t[0].toUpperCase() + t.slice(1);
  });
}
