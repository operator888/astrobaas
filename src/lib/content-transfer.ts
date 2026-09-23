/**
 * Taking your own content out and putting it back (C-91).
 *
 * ## One shape for posts, pages and every custom collection
 *
 * The roadmap phrased this as "bulk CSV import for content types", which reads
 * like a feature for custom types only. Splitting it that way would have meant
 * two exporters, two importers and two sets of rules about what a boolean looks
 * like in a spreadsheet — and this codebase's most reliable bug is a rule fixed
 * in one place and missed in its sibling. So a "collection" here is `post`,
 * `page`, or any registered content type, and everything below takes one.
 *
 * ## What the CSV shape is, and why it is not the storage shape
 *
 * A spreadsheet cell is a string. The columns are therefore FLAT: an array is
 * JSON, a boolean is `true`/`false`, a date is ISO-8601. `serialiseCell` and
 * `parseCell` are inverses, and the round-trip test says so — because "export,
 * open in Excel, fix twenty rows, import" is the actual workflow and a lossy
 * step in it destroys content.
 *
 * A repeater is JSON in one cell. That is honest rather than good: a nested
 * structure has no flat representation, and inventing `items.0.name` columns
 * would produce a file no spreadsheet can round-trip either.
 *
 * ## Import is an UPSERT keyed on slug (or id)
 *
 * Matched by `id` when the row has one, else by `slug`. Not by row position and
 * never by title: an operator who sorts their spreadsheet before importing must
 * not overwrite different records, and two posts may legitimately share a title.
 *
 * A row that matches nothing is a create. That is what makes the file an
 * operator edited in Excel usable as an import.
 *
 * ## Nothing here writes
 *
 * `planContentImport` returns what WOULD happen, per row, with the problems.
 * The endpoint applies it. That split is what lets the admin screen show a
 * preview before an operator commits to changing four hundred records — and
 * what lets this be tested without a database.
 */
import type { ContentTypeDefinition } from '../core/content-types';
import { schemaForContentType } from '../core/content-types';
import { STATUS_KEY } from '../core/moderation';
import { validate } from './validate';
import { parseCsv, toCsv } from './csv';

/** `post` and `page` are not registered content types; they are the built-in one. */
export const BUILTIN_COLLECTIONS = ['post', 'page'] as const;

/**
 * The columns a post or page round-trips through.
 *
 * `views` is deliberately absent: it is a counter this install maintains, and a
 * re-import that reset it would silently destroy analytics. `created_at` too —
 * the storage layer owns it.
 */
export const POST_COLUMNS = [
  'id', 'title', 'slug', 'status', 'excerpt', 'content',
  'category_id', 'tags', 'featured_image', 'locale', 'translation_of',
  'meta_title', 'meta_description', 'focus_keyphrase', 'noindex', 'pinned', 'menu_order',
  'publish_date',
] as const;

export type CollectionKind = 'post' | 'page' | 'custom';

export function collectionKind(name: string): CollectionKind {
  return name === 'post' || name === 'page' ? name : 'custom';
}

/** Columns for any collection. One function, so an exporter and an importer cannot disagree. */
export function transferColumns(name: string, def?: ContentTypeDefinition): string[] {
  if (collectionKind(name) !== 'custom') return [...POST_COLUMNS];
  const cols = ['id', ...(def?.fields ?? []).map((f) => f.name)];
  // A moderated collection's state is part of its content: exporting comments
  // without knowing which were approved produces a file that cannot be put back.
  if (def?.moderated) cols.push(STATUS_KEY);
  return cols;
}

/** A cell, from a stored value. */
export function serialiseCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value) || (typeof value === 'object')) return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

/**
 * A stored value, from a cell — guided by the field's declared type.
 *
 * The type matters because a spreadsheet erases it. `0` in a boolean column is
 * `false`, `0` in a number column is zero, and `0` in a string column is the
 * character. Guessing from the text alone gets one of those three wrong every
 * time.
 */
export function parseCell(raw: string, type: string | undefined): unknown {
  const s = String(raw ?? '');
  if (s === '') return undefined;
  switch (type) {
    case 'boolean': {
      const v = s.trim().toLowerCase();
      // A spreadsheet writes any of these for a tick, depending on locale and
      // on whether the column was ever a formula.
      if (['true', '1', 'yes', 'y', 'on'].includes(v)) return true;
      if (['false', '0', 'no', 'n', 'off', ''].includes(v)) return false;
      return s;
    }
    case 'number': {
      const n = Number(s.trim());
      return Number.isFinite(n) ? n : s;
    }
    case 'array':
    case 'repeater': {
      const t = s.trim();
      if (t.startsWith('[') || t.startsWith('{')) {
        try { return JSON.parse(t); } catch { /* fall through to the split */ }
      }
      // A human editing a spreadsheet writes `red, green`, not `["red","green"]`.
      return t.split(',').map((p) => p.trim()).filter(Boolean);
    }
    default:
      return s;
  }
}

/** The field types of a collection, by column name. */
export function columnTypes(name: string, def?: ContentTypeDefinition): Record<string, string> {
  if (collectionKind(name) !== 'custom') {
    return {
      tags: 'array', noindex: 'boolean', pinned: 'boolean', menu_order: 'number',
    };
  }
  const out: Record<string, string> = {};
  for (const f of def?.fields ?? []) out[f.name] = f.rule.type;
  return out;
}

/** Rows ready for `toCsv` or for JSON, from stored records. */
export function rowsForExport(
  name: string,
  records: readonly Record<string, unknown>[],
  def?: ContentTypeDefinition,
): Record<string, string>[] {
  const cols = transferColumns(name, def);
  return records.map((r) => {
    const out: Record<string, string> = {};
    for (const c of cols) out[c] = serialiseCell(r[c]);
    return out;
  });
}

export function exportCsv(
  name: string,
  records: readonly Record<string, unknown>[],
  def?: ContentTypeDefinition,
): string {
  return toCsv(transferColumns(name, def), rowsForExport(name, records, def));
}

export interface ImportRowPlan {
  /** 1-based, counting the header as row 1 — which is what the spreadsheet shows. */
  line: number;
  action: 'create' | 'update' | 'skip';
  /** The existing record's id, when this is an update. */
  id?: string;
  values: Record<string, unknown>;
  problem?: string;
}

export interface ImportPlan {
  columns: string[];
  /** Columns in the file that this collection has no field for. */
  unknownColumns: string[];
  rows: ImportRowPlan[];
  creates: number;
  updates: number;
  skipped: number;
}

/** The maximum rows one import may carry. Matches the catalogue importer's bound. */
export const MAX_IMPORT_ROWS = 10_000;

/**
 * Work out what an import WOULD do, without doing any of it.
 *
 * `existing` is the collection as it stands, used only to decide create vs
 * update. Passed in rather than read here so this stays a pure function — the
 * preview in the admin and the apply in the endpoint run the identical code,
 * which is the only way the preview can be trusted.
 */
export function planContentImport(
  name: string,
  rows: readonly Record<string, string>[],
  existing: readonly Record<string, unknown>[],
  def?: ContentTypeDefinition,
): ImportPlan {
  const cols = transferColumns(name, def);
  const types = columnTypes(name, def);
  // Matched CASE-INSENSITIVELY, mapping back to the field's real name.
  //
  // `parseCsv` lower-cases headers (a spreadsheet round trip capitalises them,
  // so being strict would reject a file this same install exported) while a
  // content-type field may legitimately be `firstName` or `SKU`. The two never
  // met: every capitalised column was reported as unknown and its value
  // dropped — a create then failed "firstName is required" and an update wrote
  // an empty object while reporting "Imported 20 records". Lossy, and silent,
  // which is the combination the module docblock says must not happen.
  const known = new Map(cols.map((c) => [c.toLowerCase(), c]));
  const schema = collectionKind(name) === 'custom' && def ? schemaForContentType(def) : null;

  const byId = new Map<string, Record<string, unknown>>();
  const bySlug = new Map<string, Record<string, unknown>>();
  for (const r of existing) {
    if (typeof r.id === 'string') byId.set(r.id, r);
    if (typeof r.slug === 'string' && r.slug) bySlug.set(r.slug.toLowerCase(), r);
  }

  const seenColumns = new Set<string>();
  for (const row of rows) for (const k of Object.keys(row)) seenColumns.add(k);

  const plan: ImportRowPlan[] = [];
  let creates = 0, updates = 0, skipped = 0;

  rows.forEach((row, idx) => {
    const line = idx + 2;
    const values: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(row)) {
      const field = known.get(key.toLowerCase());
      if (!field || field === 'id') continue;
      const v = parseCell(raw, types[field]);
      // Stored under the FIELD's own spelling, not the file's — otherwise a
      // header typed `FirstName` would write a second, wrong key.
      if (v !== undefined) values[field] = v;
    }

    const id = String(row.id ?? '').trim();
    const slug = String(row.slug ?? '').trim().toLowerCase();
    const match = (id && byId.get(id)) || (slug && bySlug.get(slug)) || null;

    // An id in the file that matches NOTHING here is a mistake worth stopping
    // for — it usually means the file came from a different install, and
    // treating it as a create would silently duplicate every record.
    if (id && !byId.get(id)) {
      plan.push({ line, action: 'skip', values, problem: `no record has id "${id}" on this install` });
      skipped += 1;
      return;
    }

    if (!match && !slug && collectionKind(name) !== 'custom') {
      plan.push({ line, action: 'skip', values, problem: 'a new post needs a slug' });
      skipped += 1;
      return;
    }

    // Custom collections are validated against their OWN schema — the same one
    // the API enforces, so an import cannot write a record the API would refuse.
    //
    // CREATES **AND** UPDATES. The first version validated creates only, so a
    // row whose slug matched an existing record wrote straight through:
    // unbounded strings, wrong types, control characters, and any reserved key
    // in the column list. Create-versus-update is the sibling gap this module's
    // own header names as the codebase's most reliable bug, and it was in the
    // module that names it.
    if (schema) {
      // An update is a PATCH: only the columns present in the file are being
      // written, so a required field the row does not carry is not missing —
      // it is simply not being changed. Validating the partial bag against the
      // full schema would refuse every legitimate partial update.
      const partial = match
        ? Object.fromEntries(Object.entries(schema).filter(([k]) => k in values))
        : schema;
      const result = validate(values, partial);
      if (!result.ok) {
        plan.push({ line, action: 'skip', values, problem: Object.values(result.errors).join('; ') });
        skipped += 1;
        return;
      }
      const checked = result.value as Record<string, unknown>;
      // The moderation state is NOT a schema field, so `validate` strips it —
      // which meant exporting a moderated collection and importing it published
      // every comment that had been rejected. Carried across explicitly, and
      // only when the file actually supplied it.
      if (def?.moderated && values[STATUS_KEY] !== undefined) checked[STATUS_KEY] = values[STATUS_KEY];
      if (match) {
        plan.push({ line, action: 'update', id: String(match.id), values: checked });
        updates += 1;
      } else {
        plan.push({ line, action: 'create', values: checked });
        creates += 1;
      }
      return;
    }

    if (match) {
      plan.push({ line, action: 'update', id: String(match.id), values });
      updates += 1;
    } else {
      plan.push({ line, action: 'create', values });
      creates += 1;
    }
  });

  return {
    columns: cols,
    unknownColumns: [...seenColumns].filter((c) => !known.has(c.toLowerCase())),
    rows: plan,
    creates,
    updates,
    skipped,
  };
}

/** Read an uploaded file of either format into rows. Throws with a readable message. */
export function readImportRows(body: string, format: 'csv' | 'json'): Record<string, string>[] {
  if (format === 'csv') {
    const table = parseCsv(body);
    if (!table.headers.length) throw new Error('The file has no header row.');
    return table.rows;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error('That is not valid JSON.');
  }
  const rows = Array.isArray(parsed) ? parsed : (parsed as { rows?: unknown })?.rows;
  if (!Array.isArray(rows)) throw new Error('Expected an array of records, or an object with a "rows" array.');
  return rows.map((r) => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(r ?? {})) out[k.toLowerCase()] = serialiseCell(v);
    return out;
  });
}
