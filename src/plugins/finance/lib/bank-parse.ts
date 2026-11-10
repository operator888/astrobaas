/**
 * Bank statement import: camt.053 (XML), MT940 and CSV.
 *
 * Every German bank exports at least one of these from online banking, which
 * makes file import the one bank connection that works with every bank, for
 * free, with no third party holding credentials. (A live FinTS / PSD2 feed is
 * on the roadmap; it changes how transactions ARRIVE, not anything below.)
 *
 * Output is one normalised shape. Amounts are signed cents: positive = money
 * in. The fingerprint makes re-importing an overlapping statement harmless.
 */
import { createHash } from 'node:crypto';
import { child, children, findAll, parseXml, path, text, type XmlNode } from './xml';
import { decimalToCents, parseAmountToCents, parseDate } from './format';

export interface ParsedTx {
  booking_date: string;
  value_date?: string;
  amount_cents: number;
  currency: string;
  counterparty_name?: string;
  counterparty_iban?: string;
  purpose: string;
  end_to_end_id?: string;
  bank_reference?: string;
  fingerprint: string;
}

export interface ParsedStatement {
  format: 'camt053' | 'mt940' | 'csv';
  iban?: string;
  transactions: ParsedTx[];
  warnings: string[];
}

export function fingerprint(t: Omit<ParsedTx, 'fingerprint'>, iban = ''): string {
  // The bank's own reference is the best key when present; otherwise the
  // combination that two different real transactions practically never share.
  const basis = t.bank_reference
    ? `${iban}|ref|${t.bank_reference}|${t.amount_cents}`
    : `${iban}|${t.booking_date}|${t.amount_cents}|${t.counterparty_iban ?? ''}|${t.purpose.replace(/\s+/g, ' ').trim()}|${t.end_to_end_id ?? ''}`;
  return createHash('sha256').update(basis).digest('hex').slice(0, 32);
}

/* ------------------------------ camt.053 ------------------------------ */

function camtDate(n: XmlNode | undefined): string | undefined {
  const v = text(child(n, 'Dt')) || text(child(n, 'DtTm'));
  return v ? v.slice(0, 10) : undefined;
}

export function parseCamt053(xml: string): ParsedStatement {
  const doc = parseXml(xml);
  const stmts = findAll(doc, 'Stmt');
  const warnings: string[] = [];
  const out: ParsedTx[] = [];
  let iban: string | undefined;
  for (const st of stmts) {
    const stIban = text(path(st, 'Acct', 'Id', 'IBAN')) || undefined;
    iban = iban ?? stIban;
    for (const e of children(st, 'Ntry')) {
      const status = text(child(e, 'Sts')) || text(path(e, 'Sts', 'Cd'));
      if (status && status !== 'BOOK') continue; // pending / info entries are not bookings
      const amtNode = child(e, 'Amt');
      const credit = text(child(e, 'CdtDbtInd')) === 'CRDT';
      // CdtDbtInd already states the direction of a reversal entry itself
      // (a returned direct debit is CRDT); RvslInd only labels it.
      const sign = credit ? 1 : -1;
      const entryCents = decimalToCents(text(amtNode)) ?? 0;
      const booking = camtDate(child(e, 'BookgDt')) ?? '';
      const value = camtDate(child(e, 'ValDt'));
      const addtl = text(child(e, 'AddtlNtryInf'));
      const txs = findAll(child(e, 'NtryDtls'), 'TxDtls');
      const bankRef = text(child(e, 'AcctSvcrRef')) || undefined;
      const one = (tx: XmlNode | undefined, cents: number, idx: number) => {
        const parties = child(tx, 'RltdPties');
        // The counterparty is whoever is NOT us: the debtor of money coming in.
        const party = credit ? (child(parties, 'Dbtr') ?? child(parties, 'UltmtDbtr')) : (child(parties, 'Cdtr') ?? child(parties, 'UltmtCdtr'));
        const name = text(child(party, 'Nm')) || text(path(party, 'Pty', 'Nm'));
        const acct = credit ? child(parties, 'DbtrAcct') : child(parties, 'CdtrAcct');
        const ustrd = children(child(tx, 'RmtInf'), 'Ustrd').map(text).join(' ');
        const strdRef = text(path(tx, 'RmtInf', 'Strd', 'CdtrRefInf', 'Ref'));
        const purpose = [ustrd, strdRef, ustrd ? '' : addtl].filter(Boolean).join(' ').trim();
        const e2e = text(path(tx, 'Refs', 'EndToEndId'));
        const base = {
          booking_date: booking,
          value_date: value,
          amount_cents: sign * cents,
          currency: amtNode?.attrs.Ccy || 'EUR',
          counterparty_name: name || undefined,
          counterparty_iban: text(path(acct, 'Id', 'IBAN')) || undefined,
          purpose: purpose || addtl,
          end_to_end_id: e2e && e2e !== 'NOTPROVIDED' ? e2e : undefined,
          bank_reference: bankRef ? (txs.length > 1 ? `${bankRef}#${idx}` : bankRef) : undefined,
        };
        out.push({ ...base, fingerprint: fingerprint(base, stIban) });
      };
      if (txs.length <= 1) one(txs[0], entryCents, 0);
      else {
        // A batch booking: one entry on the statement, several payments in it.
        txs.forEach((tx, i) => {
          const amt = text(path(tx, 'AmtDtls', 'TxAmt', 'Amt')) || text(child(tx, 'Amt'));
          const c = decimalToCents(amt);
          if (c === null) warnings.push(`Batch entry ${bankRef ?? booking} has a part without an amount; skipped.`);
          else one(tx, c, i);
        });
      }
    }
  }
  if (!stmts.length) warnings.push('No <Stmt> found — is this a camt.053 file? (camt.052/054 are not statements.)');
  return { format: 'camt053', iban, transactions: out, warnings };
}

/* ------------------------------ MT940 ------------------------------ */

function mtDate(yymmdd: string): string {
  const yy = Number(yymmdd.slice(0, 2));
  const y = yy >= 80 ? 1900 + yy : 2000 + yy;
  return `${y}-${yymmdd.slice(2, 4)}-${yymmdd.slice(4, 6)}`;
}

/** Split German :86: structured content (?20…?29, ?32/33 name, ?31 IBAN). */
function parse86(raw: string): { purpose: string; name?: string; iban?: string; e2e?: string } {
  const body = raw.replace(/\r?\n/g, '');
  if (!/^\d{3}\?/.test(body)) return { purpose: body.trim() };
  const fields: Record<string, string> = {};
  for (const m of body.slice(3).matchAll(/\?(\d{2})([^?]*)/g)) fields[m[1]] = (fields[m[1]] ?? '') + m[2];
  const purposeRaw = ['20', '21', '22', '23', '24', '25', '26', '27', '28', '29', '60', '61', '62', '63']
    .map((k) => fields[k] ?? '').join('');
  // SEPA keywords inside the purpose: SVWZ+ is the free text, EREF+ the end-to-end id.
  const svwz = purposeRaw.match(/SVWZ\+(.*?)(?=(EREF|KREF|MREF|CRED|DEBT|ABWA|ABWE|IBAN|BIC)\+|$)/);
  const eref = purposeRaw.match(/EREF\+(.*?)(?=(SVWZ|KREF|MREF|CRED|DEBT|ABWA|ABWE)\+|$)/);
  return {
    purpose: (svwz ? svwz[1] : purposeRaw).trim(),
    name: ((fields['32'] ?? '') + (fields['33'] ?? '')).trim() || undefined,
    iban: (fields['31'] ?? '').trim() || undefined,
    e2e: eref && eref[1].trim() !== 'NOTPROVIDED' ? eref[1].trim() : undefined,
  };
}

export function parseMt940(input: string): ParsedStatement {
  const warnings: string[] = [];
  const out: ParsedTx[] = [];
  let iban: string | undefined;
  let currency = 'EUR';
  // Fields begin at line start with :NN[A]:
  const tokens = [...input.replace(/\r\n/g, '\n').matchAll(/^:(\d{2}[A-Z]?):([\s\S]*?)(?=^:\d{2}[A-Z]?:|^-\s*$|(?![\s\S]))/gm)];
  let pending: Omit<ParsedTx, 'fingerprint'> | null = null;
  const flush = () => {
    if (pending) out.push({ ...pending, fingerprint: fingerprint(pending, iban) });
    pending = null;
  };
  for (const [, tag, valueRaw] of tokens) {
    const value = valueRaw.trim();
    if (tag === '25') {
      const v = value.replace(/\s+/g, '');
      iban = /^[A-Z]{2}\d{2}/.test(v) ? v : iban;
    } else if (tag === '60F' || tag === '60M') {
      const m = value.match(/^[CD]\d{6}([A-Z]{3})/);
      if (m) currency = m[1];
    } else if (tag === '61') {
      flush();
      const m = value.match(/^(\d{6})(\d{4})?(R?[CD])([A-Z])?(\d+,\d{0,2})N?([A-Z0-9]{3})([^/\n]*)(?:\/\/([^\n]*))?/);
      if (!m) {
        warnings.push(`Unreadable :61: line "${value.slice(0, 40)}"; skipped.`);
        continue;
      }
      const valueDate = mtDate(m[1]);
      let bookingDate = valueDate;
      if (m[2]) {
        // Booking date has no year: take the value date's, adjusting across New Year.
        let y = Number(valueDate.slice(0, 4));
        const bm = Number(m[2].slice(0, 2));
        const vm = Number(valueDate.slice(5, 7));
        if (bm === 12 && vm === 1) y -= 1;
        if (bm === 1 && vm === 12) y += 1;
        bookingDate = `${y}-${m[2].slice(0, 2)}-${m[2].slice(2, 4)}`;
      }
      const dc = m[3];
      const cents = parseAmountToCents(m[5]) ?? 0;
      const credit = dc === 'C' || dc === 'RD';
      pending = {
        booking_date: bookingDate,
        value_date: valueDate,
        amount_cents: credit ? cents : -cents,
        currency,
        purpose: '',
        bank_reference: m[8]?.trim() || undefined,
      };
    } else if (tag === '86' && pending) {
      const p = parse86(value);
      pending.purpose = p.purpose;
      pending.counterparty_name = p.name;
      pending.counterparty_iban = p.iban;
      pending.end_to_end_id = p.e2e;
    }
  }
  flush();
  if (!out.length) warnings.push('No :61: transactions found.');
  return { format: 'mt940', iban, transactions: out, warnings };
}

/* ------------------------------ CSV ------------------------------ */

export function parseCsv(input: string): string[][] {
  const text = input.replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const delim = (firstLine.match(/;/g)?.length ?? 0) >= (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else q = false;
      } else field += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

/** Header aliases across German banks (Sparkasse, DKB, ING, Commerzbank, N26, Qonto, Kontist…). */
const CSV_COLUMNS: Record<string, string[]> = {
  booking_date: ['buchungstag', 'buchungsdatum', 'datum', 'booking date', 'date', 'buchung', 'settlement date'],
  value_date: ['valutadatum', 'valuta', 'wertstellung', 'value date'],
  amount: ['betrag', 'betrag (eur)', 'umsatz', 'amount', 'amount (eur)', 'betrag in eur'],
  credit: ['haben', 'eingang', 'credit'],
  debit: ['soll', 'ausgang', 'debit'],
  currency: ['währung', 'waehrung', 'currency', 'wkz'],
  name: ['name zahlungsbeteiligter', 'beguenstigter/zahlungspflichtiger', 'begünstigter/zahlungspflichtiger', 'auftraggeber/empfänger', 'auftraggeber / begünstigter', 'zahlungsempfänger', 'empfänger', 'auftraggeber', 'payee', 'counterparty', 'name', 'counterparty name'],
  iban: ['iban zahlungsbeteiligter', 'kontonummer/iban', 'iban', 'kontonummer', 'counterparty iban', 'account number'],
  purpose: ['verwendungszweck', 'buchungstext', 'purpose', 'reference', 'description', 'payment reference', 'zahlungsreferenz'],
  e2e: ['end-to-end-referenz', 'end to end id', 'eref'],
};

export function parseBankCsv(input: string): ParsedStatement {
  const rows = parseCsv(input);
  const warnings: string[] = [];
  // Some banks put account info above the real header; find the header row.
  const headerIdx = rows.findIndex((r) => {
    const low = r.map((c) => c.trim().toLowerCase());
    return CSV_COLUMNS.booking_date.some((a) => low.includes(a))
      && (CSV_COLUMNS.amount.some((a) => low.includes(a)) || CSV_COLUMNS.credit.some((a) => low.includes(a)));
  });
  if (headerIdx === -1) {
    return { format: 'csv', transactions: [], warnings: ['No header row with a date and an amount column was found.'] };
  }
  const header = rows[headerIdx].map((c) => c.trim().toLowerCase());
  const col = (k: string) => {
    for (const alias of CSV_COLUMNS[k]) {
      const i = header.indexOf(alias);
      if (i !== -1) return i;
    }
    return -1;
  };
  const ci = {
    booking: col('booking_date'), value: col('value_date'), amount: col('amount'),
    credit: col('credit'), debit: col('debit'), currency: col('currency'), name: col('name'),
    iban: col('iban'), purpose: col('purpose'), e2e: col('e2e'),
  };
  const out: ParsedTx[] = [];
  for (const r of rows.slice(headerIdx + 1)) {
    const get = (i: number) => (i >= 0 ? (r[i] ?? '').trim() : '');
    const date = parseDate(get(ci.booking));
    if (!date) continue;
    let cents: number | null;
    if (ci.amount >= 0) cents = parseAmountToCents(get(ci.amount));
    else {
      const c = parseAmountToCents(get(ci.credit)) ?? 0;
      const d = parseAmountToCents(get(ci.debit)) ?? 0;
      cents = c - Math.abs(d);
    }
    if (cents === null) {
      warnings.push(`Row dated ${date} has no readable amount; skipped.`);
      continue;
    }
    const base = {
      booking_date: date,
      value_date: parseDate(get(ci.value)) ?? undefined,
      amount_cents: cents,
      currency: get(ci.currency) || 'EUR',
      counterparty_name: get(ci.name) || undefined,
      counterparty_iban: get(ci.iban).replace(/\s+/g, '') || undefined,
      purpose: get(ci.purpose),
      end_to_end_id: get(ci.e2e) || undefined,
    };
    out.push({ ...base, fingerprint: fingerprint(base) });
  }
  return { format: 'csv', transactions: out, warnings };
}

/**
 * Two genuinely identical rows in one statement (two €9.99 card payments to
 * the same shop on the same day) must not collapse into one. The n-th
 * repetition gets its ordinal folded into the fingerprint; re-importing the
 * same file produces the same ordinals, so it still deduplicates.
 */
export function distinctFingerprints(st: ParsedStatement): ParsedStatement {
  const seen = new Map<string, number>();
  for (const t of st.transactions) {
    const n = seen.get(t.fingerprint) ?? 0;
    seen.set(t.fingerprint, n + 1);
    if (n > 0) t.fingerprint = createHash('sha256').update(`${t.fingerprint}#${n}`).digest('hex').slice(0, 32);
  }
  return st;
}

/** Detect the format from content and parse. */
export function parseStatement(content: string): ParsedStatement {
  const head = content.slice(0, 2000);
  if (/<Document[\s>]/.test(head) || /camt\.05/.test(head)) return distinctFingerprints(parseCamt053(content));
  if (/^:20:/m.test(head) || /:61:/.test(content.slice(0, 20000))) return distinctFingerprints(parseMt940(content));
  return distinctFingerprints(parseBankCsv(content));
}
