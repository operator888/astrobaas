/**
 * Settings rows → a lookup object, and the small coercions every reader needs.
 *
 * ## Why this file exists
 *
 * Eleven places built this map, in **three incompatible spellings**:
 *
 * ```ts
 * const map: Record<string, unknown> = Object.create(null);   // payments, commerce
 * const map: Record<string, any> = {};                        // sitemap, rss, page-view
 * Object.fromEntries(rows.map(r => [r.key, r.value]))         // contact, themes
 * ```
 *
 * The difference is not cosmetic. **Settings keys are operator-supplied**, so a
 * plain `{}` inherits `Object.prototype`: a lookup of `constructor`,
 * `toString` or `__proto__` returns a function instead of `undefined`, and
 * `map.constructor` is truthy on every install that never configured anything.
 * Half the copies got that right by accident and half did not, and the next
 * copy was a coin flip.
 *
 * ## Everything here is pure
 *
 * No `LocalDB` — the caller passes the rows it already has. Every settings read
 * in this codebase is async while `applyFilters` is synchronous, so a module
 * that reached for the database could not be called from the places that need
 * it most.
 */

/** What `LocalDB.getSettings()` returns, narrowed to what a reader uses. */
export interface SettingRow {
  key: string;
  value: unknown;
}

/**
 * Build the lookup.
 *
 * Null-prototype, always. See the note above: with a plain object, a site whose
 * operator never touched settings still answers truthily to `map.constructor`,
 * and a `?? default` on it silently keeps the function.
 */
export function settingsMap(rows: readonly SettingRow[] | null | undefined): Record<string, unknown> {
  const map: Record<string, unknown> = Object.create(null);
  for (const row of rows ?? []) {
    if (row && typeof row.key === 'string') map[row.key] = row.value;
  }
  return map;
}

/**
 * A stored value as a trimmed string, or `fallback`.
 *
 * Five private `str()` helpers already exist across the tree and they disagree —
 * one returns `undefined`, one returns `''`, one does not trim. This is the one
 * that settings readers use.
 */
export function settingStr(value: unknown, fallback = ''): string {
  if (typeof value === 'string') {
    const t = value.trim();
    return t === '' ? fallback : t;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return fallback;
}

/**
 * A stored value as a boolean.
 *
 * The truthy list is not decoration. Settings arrive from a JSON API, a form
 * post and a database written by an earlier version, so the same intent shows up
 * as `true`, `"true"`, `"1"`, `1` and `"on"`. Every reader in this codebase that
 * used a bare `!!` had the same bug: the STRING `"false"` is truthy, so an
 * operator turning something off through the API was told it succeeded and it
 * stayed on.
 */
export function settingBool(value: unknown, fallback = false): boolean {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const s = String(value).trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'on' || s === 'yes') return true;
  if (s === 'false' || s === '0' || s === 'off' || s === 'no') return false;
  return fallback;
}

/**
 * A stored value as an integer, clamped.
 *
 * **Not set is checked before not a number**, because `Number(null)` and
 * `Number('')` are both `0` — a cleared field would otherwise read as a
 * deliberate zero, which for a "how many" setting means "off". An operator who
 * emptied a box and one who typed `0` must not be told apart by luck.
 */
export function settingInt(
  value: unknown,
  fallback: number,
  bounds: { min?: number; max?: number } = {},
): number {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  let i = Math.trunc(n);
  if (bounds.min !== undefined) i = Math.max(bounds.min, i);
  if (bounds.max !== undefined) i = Math.min(bounds.max, i);
  return i;
}

/**
 * A stored value as an array of non-empty strings.
 *
 * Accepts a real array or a comma-separated string, because both are written:
 * the admin screens post arrays, `.env`-derived defaults and hand-edited rows
 * are comma-separated.
 */
export function settingList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : String(value ?? '').split(',');
  const out: string[] = [];
  for (const v of raw) {
    const s = typeof v === 'string' ? v.trim() : String(v ?? '').trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}
