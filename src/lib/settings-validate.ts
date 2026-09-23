/**
 * Per-KEY validation for settings.
 *
 * Settings are a schemaless bucket: `api/settings/update.ts` checks the shape of
 * a value (type, size, depth, control characters) and writes anything whose key
 * looks like an identifier. That is the right default for a store plugins extend
 * — but it means a URL-shaped setting was guarded only by `type="url"` in the
 * admin form, which is client-side and therefore not a guard at all.
 *
 * The cost of that is specific and was paid in production: a media base URL
 * saved as `cms.example.com` (no scheme) or `https://cms.example.com/` (trailing
 * slash) produces media URLs that are subtly wrong, the API reports success, and
 * the shop finds out from a customer that its product photos are broken.
 *
 * So the keys whose value has a REQUIRED SHAPE are declared here, and a bad one
 * is refused at save time with a sentence the shop owner can act on.
 */

import { normaliseOrigin } from './site-url';
import { validateRobotsBody } from './robots-txt';
import { validateSynonyms } from './search/expander';
import { validate } from './validate';
import { settingRuleFor, type SettingGroup } from '../core/setting-groups';
import { SHOP_CURRENCY_KEY } from './commerce-settings';

export interface SettingProblem {
  key: string;
  message: string;
}

/**
 * Keys that must hold an absolute http(s) origin, or nothing at all.
 *
 * Empty is always allowed: clearing a setting is how an operator says "fall back
 * to the default", and refusing that would trap them with a value they cannot
 * remove.
 */
const ORIGIN_KEYS: ReadonlySet<string> = new Set([
  // Where the site lives: canonical links, sitemap, feed.
  'site_url',
  // Where THIS CMS answers: /uploads and /api. See lib/media-url.ts.
  'public_site_url',
  // The byline link. Already http(s)-only by intent; now by enforcement.
  'site_author_url',
]);

/**
 * Check one setting.
 *
 * Returns a message when the value is unusable, or null when it is fine.
 * Deliberately narrow: this validates the keys with a required SHAPE, and says
 * nothing about the rest, so adding a plugin setting still needs no registration
 * here.
 */
/**
 * Keys that must hold a real boolean (or a clearing empty value).
 *
 * The readers of these keys are strict — `resolveCommerceEnabled` treats the
 * string "false" as off — but refusing the write is still worth it: a stored
 * `"false"` that *reads* as off would sit in the table looking like a choice
 * the operator made, and the next reader added might use `!!`.
 */
const BOOLEAN_KEYS: ReadonlySet<string> = new Set([
  'commerce_enabled',
  // The two email toggles. Their READERS are now all `settingBool`, so an
  // install already holding the string "true" works; these entries stop new
  // writes from storing a string at all, which is what let the sender and the
  // admin screen drift apart in the first place.
  //
  // This narrows the API contract for these two keys: a caller sending the
  // NUMBER 1 or the string "on" now gets a 400 naming the problem, where
  // before it was stored as-is and read as truthy. That is the point — the
  // silent version is what shipped a shop that believed it was being notified
  // of every sale and never was.
  'sale_notify_enabled',
  'order_confirmation_enabled',
  // The rest of the same sweep. Every one of these had a reader testing
  // `=== true` or `!== false` against a value the settings API will happily
  // store as a string. `tax_prices_include_tax` was the worst: `"false" !==
  // false` is TRUE, so a shop that chose tax-exclusive pricing was charged
  // tax-inclusive — wrong by the whole VAT rate on every line.
  'tax_enabled',
  'tax_prices_include_tax',
  'maintenance_enabled',
  'orders_abandon_enabled',
  // Now that a checkbox writes it, the same coercion the other toggles get.
  'orders_recovery_enabled',
  // The opt-in risk hold (hardening step 4): a stored "false" must read as off.
  'orders_risk_hold_enabled',
  'popup_enabled',
  // Every reader of this one uses `!!value`, so the STRING "false" would be
  // truthy: an operator turning the toggle off through the API would take
  // their whole site out of search results and be told it succeeded.
  'discourage_indexing',
  // Same reason: every reader uses a truthy test, so a stored string "false"
  // would silently keep the outbound sweep running after the operator turned
  // it off — and this one makes requests to other people's servers.
  'link_check_external',
]);

/**
 * `captcha_surfaces` must be an array of known surface ids. Kept in sync with
 * CAPTCHA_SURFACES by value (imported here would make settings-validate
 * depend on the captcha module for five strings); the resolver drops unknown
 * ids anyway — this rule exists so the admin form hears about a typo instead
 * of silently protecting nothing.
 */
const CAPTCHA_SURFACE_IDS = new Set(['contact', 'newsletter', 'login', 'forgot', 'forms', 'checkout', 'magic-link']);

export function validateSetting(
  key: string,
  value: unknown,
  /**
   * The operator's declared setting groups (C-127), when the caller has them.
   *
   * Optional because most callers validate a built-in key and have no reason to
   * read the groups. Passing them is what turns a generated form from
   * decoration into enforcement: without this, POST /api/settings/update
   * accepts any shape that fits the generic size limit, so a field declared as
   * a number happily stores the word "later".
   */
  groups: readonly SettingGroup[] = [],
): string | null {
  const declared = settingRuleFor(groups, key);
  if (declared) {
    // Unset and empty mean "not filled in", exactly as they do for a built-in
    // key — a settings screen has no way to express "absent" other than an
    // empty box, and refusing that would make an optional field unclearable.
    if (value === null || value === undefined || value === '') {
      return declared.optional === false ? 'is required' : null;
    }
    const res = validate({ v: value }, { v: { ...declared, optional: true } });
    return res.ok ? null : (res.errors.v ?? 'is not valid').replace(/^v /, '');
  }

  // robots.txt rules. Checked for size and characters, never for vocabulary:
  // the format has a long vendor-specific tail (Crawl-delay, Clean-param, Host)
  // and a validator that only knew the directives someone thought of would
  // reject the exact line an operator came here to add.
  if (key === 'robots_txt') return validateRobotsBody(value);
  // Same shape: refuse what is a mistake rather than a typo. The parser drops
  // an unreadable LINE, so one bad rule must not take search down.
  if (key === 'search_synonyms') return validateSynonyms(value);

  if (key === 'captcha_surfaces') {
    if (value === null || value === undefined || value === '') return null;
    if (!Array.isArray(value)) return 'must be a list of form names';
    const bad = value.filter((v) => typeof v !== 'string' || !CAPTCHA_SURFACE_IDS.has(v));
    if (bad.length > 0) return `unknown form name: ${bad.map((b) => JSON.stringify(b)).join(', ')}`;
    return null;
  }
  // The shop currency is frozen onto every future order, so a typo here is not
  // a display bug — it is a wrong code on real invoices until somebody notices.
  // Refused at the door rather than silently falling back, because an operator
  // who typed "€" or "eur0" should be told, not quietly overruled.
  if (key === SHOP_CURRENCY_KEY) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value !== 'string') return 'must be a three-letter currency code, for example EUR';
    return /^[A-Za-z]{3}$/.test(value.trim())
      ? null
      : 'must be a three-letter ISO 4217 code, for example EUR, GBP or JPY';
  }
  if (BOOLEAN_KEYS.has(key)) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'boolean') return null;
    if (value === 'true' || value === 'false' || value === '1' || value === '0') return null;
    return 'must be on or off (true or false)';
  }
  if (!ORIGIN_KEYS.has(key)) return null;

  // Unset and empty both mean "use the default".
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;

  if (typeof value !== 'string') {
    return 'must be a web address, for example https://example.com';
  }
  if (normaliseOrigin(value)) return null;

  const raw = value.trim();
  // Name the actual mistake. "Invalid URL" sends an operator to a search engine;
  // "it needs to start with https://" sends them back to the field.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    return `must start with https:// or http:// — try "https://${raw.replace(/^\/+/, '')}"`;
  }
  return 'must be an http:// or https:// web address, for example https://example.com';
}

/** Check a whole update payload, so an operator sees every problem at once. */
export function validateSettings(
  updates: Record<string, unknown>,
  groups: readonly SettingGroup[] = [],
): SettingProblem[] {
  const problems: SettingProblem[] = [];
  for (const [key, value] of Object.entries(updates)) {
    const message = validateSetting(key, value, groups);
    if (message) problems.push({ key, message });
  }
  return problems;
}

/**
 * Normalise a value on the way in, for the keys where a canonical form exists.
 *
 * `https://cms.example.com/` and `https://cms.example.com` must not be two
 * different stored values — one of them would produce `//uploads/...` in every
 * media URL. Storing the canonical form means the readers never have to care.
 */
export function normaliseSettingValue(key: string, value: unknown): unknown {
  // Stored upper-case, so `resolveShopCurrency` and every reader see one
  // spelling rather than "eur", "Eur" and "EUR" being three shop currencies.
  if (key === SHOP_CURRENCY_KEY && typeof value === 'string' && value.trim()) {
    return value.trim().toUpperCase();
  }
  if (BOOLEAN_KEYS.has(key)) {
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
    return value;
  }
  if (!ORIGIN_KEYS.has(key)) return value;
  if (typeof value !== 'string') return value;
  if (value.trim() === '') return '';
  return normaliseOrigin(value) ?? value;
}
