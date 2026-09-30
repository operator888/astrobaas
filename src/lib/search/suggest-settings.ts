/**
 * The operator's choices for search suggestions (Settings → Reading → Search),
 * read in ONE place: the suggestion route, the search routes that count
 * popular queries, and the site's search box all ask this.
 */
import { parseBlocklist, validateBlocklist } from './popular';
import { MAX_PER_TYPE } from './suggest';

export const SUGGEST_SETTING_KEYS = {
  enabled: 'search_suggestions_enabled',
  limit: 'search_suggestions_limit',
  popular: 'search_popular_enabled',
  minCount: 'search_popular_min_count',
  blocklist: 'search_popular_blocklist',
} as const;

export interface SuggestSettings {
  enabled: boolean;
  limit: number;
  popular: boolean;
  minCount: number;
  blocklist: string[];
}

export const MIN_POPULAR_COUNT_FLOOR = 2;

export function resolveSuggestSettings(s: Record<string, unknown> | null | undefined): SuggestSettings {
  const m = s ?? {};
  const int = (v: unknown, lo: number, hi: number, dflt: number) =>
    Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi ? (v as number) : dflt;
  return {
    enabled: m[SUGGEST_SETTING_KEYS.enabled] !== false,
    limit: int(m[SUGGEST_SETTING_KEYS.limit], 1, MAX_PER_TYPE, 5),
    popular: m[SUGGEST_SETTING_KEYS.popular] !== false,
    minCount: int(m[SUGGEST_SETTING_KEYS.minCount], MIN_POPULAR_COUNT_FLOOR, 1000, 5),
    blocklist: parseBlocklist(m[SUGGEST_SETTING_KEYS.blocklist]),
  };
}

/** For settings-validate.ts. Null = fine; otherwise the reason. */
export function validateSuggestSetting(key: string, value: unknown): string | null | undefined {
  switch (key) {
    case SUGGEST_SETTING_KEYS.enabled:
    case SUGGEST_SETTING_KEYS.popular:
      return typeof value === 'boolean' ? null : 'must be on or off';
    case SUGGEST_SETTING_KEYS.limit:
      return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= MAX_PER_TYPE ? null : `must be a whole number from 1 to ${MAX_PER_TYPE}`;
    case SUGGEST_SETTING_KEYS.minCount:
      // Never below 2: a query one person typed must not be shown to everyone.
      return Number.isInteger(value) && (value as number) >= MIN_POPULAR_COUNT_FLOOR && (value as number) <= 1000 ? null : `must be a whole number from ${MIN_POPULAR_COUNT_FLOOR} to 1000`;
    case SUGGEST_SETTING_KEYS.blocklist:
      return validateBlocklist(value);
    default:
      return undefined; // not one of ours
  }
}
