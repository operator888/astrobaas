import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { validateSetting, normaliseSettingValue } from '../../../lib/settings-validate';
import { invalidateMediaBase } from '../../../lib/media-base';
import { validateSettingGroups, SETTING_GROUPS_SETTING } from '../../../core/setting-groups';
import { reloadPlugins } from '../../../plugins';
import { COMMENTS_ENABLED_SETTING, REVIEWS_ENABLED_SETTING } from '../../../core/builtin-collections';

// Setting keys must look like identifiers — rejects junk/prototype-pollution
// style keys from a mass-assignment of arbitrary object fields.
const SAFE_KEY = /^[a-zA-Z0-9_.-]{1,64}$/;

/**
 * Bounds on a setting VALUE.
 *
 * The key was already guarded; the value was not, and settings is a schemaless
 * bucket that every part of the app reads. An unbounded value is a stored
 * denial-of-service: a 10 MB `site_title` is embedded in every page render, and
 * a deeply-nested object costs CPU on every JSON round trip. Admin-only, so
 * this is defence in depth rather than a hole — but "only an admin can wreck
 * it" is a weak reason to leave a limit off.
 */
const VALUE_LIMITS = {
  /** Serialised size of any one value. */
  bytes: 64 * 1024,
  /** Nesting depth. The tax-rate table is 2 deep; 8 is generous. */
  depth: 8,
  /** Entries in an array or object value. */
  entries: 500,
} as const;

/** No control characters in stored text — see lib/validate.ts for why. */
const FORBIDDEN_CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

type ValueCheck = { ok: true } | { ok: false; reason: string };

function checkValue(value: unknown, depth = 0): ValueCheck {
  if (depth > VALUE_LIMITS.depth) return { ok: false, reason: 'nested too deeply' };
  if (value === null) return { ok: true };

  switch (typeof value) {
    case 'boolean':
      return { ok: true };
    case 'number':
      // NaN and Infinity survive JSON.parse via no route, but a client can send
      // them as strings elsewhere; a non-finite number in settings would
      // propagate into arithmetic that silently yields NaN.
      return Number.isFinite(value) ? { ok: true } : { ok: false, reason: 'must be a finite number' };
    case 'string':
      if (FORBIDDEN_CONTROLS.test(value)) return { ok: false, reason: 'contains control characters' };
      return { ok: true };
    case 'object': {
      const entries = Array.isArray(value) ? value : Object.values(value as object);
      if (entries.length > VALUE_LIMITS.entries) {
        return { ok: false, reason: `has more than ${VALUE_LIMITS.entries} entries` };
      }
      if (!Array.isArray(value)) {
        // Keys reach JSON and, for some settings, the admin DOM.
        for (const k of Object.keys(value as object)) {
          if (k.length > 128 || FORBIDDEN_CONTROLS.test(k)) {
            return { ok: false, reason: 'has an invalid property name' };
          }
        }
      }
      for (const v of entries) {
        const inner = checkValue(v, depth + 1);
        if (!inner.ok) return inner;
      }
      return { ok: true };
    }
    default:
      // undefined, function, symbol, bigint — none survive JSON, so anything
      // landing here came from somewhere unexpected.
      return { ok: false, reason: `has an unsupported type (${typeof value})` };
  }
}

/** Size check, done once on the serialised form. */
function checkSize(value: unknown): ValueCheck {
  let json: string;
  try {
    json = JSON.stringify(value) ?? '';
  } catch {
    // Circular structures cannot come from JSON.parse, but a plugin could pass
    // one to this helper; refusing beats throwing inside the request.
    return { ok: false, reason: 'is not serialisable' };
  }
  return json.length <= VALUE_LIMITS.bytes
    ? { ok: true }
    : { ok: false, reason: `is larger than ${VALUE_LIMITS.bytes} bytes` };
}

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    await LocalDB.init();
    const session = locals.user;
    if (!session || session.role !== 'admin') return ApiResponseBuilder.forbidden('Admin only');

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return ApiResponseBuilder.badRequest('Body must be a JSON object');
    }

    const updates: Record<string, any> = body;
    const results: Record<string, any> = {};

    /*
     * VALIDATE EVERYTHING FIRST, THEN WRITE.
     *
     * Settings arrive a form at a time. Validating and writing in one pass meant
     * a rejection on the fourth key left the first three already saved and the
     * rest dropped — the operator gets an error, some of their edit is live,
     * some is not, and nothing says which. Re-submitting after a fix then
     * "works", which hides it.
     */
    const entries = Object.entries(updates).filter(([key]) => SAFE_KEY.test(key));

    // The operator's DECLARED setting groups (C-127), read once for the whole
    // payload. A declared key is then checked against its declared rule, which
    // is what stops a generated form from being decoration.
    const declaredGroups = validateSettingGroups(
      (await LocalDB.getSetting(SETTING_GROUPS_SETTING))?.value,
    ).groups;

    for (const [key, value] of entries) {
      // A rejected VALUE is an error, not a silent skip: an operator who saves
      // a setting and is told "saved" while nothing changed has no way to find
      // out why. (A rejected KEY stays a silent skip — those come from
      // mass-assignment of a form, not from intent.)
      const shape = checkValue(value);
      if (!shape.ok) return ApiResponseBuilder.badRequest(`Setting "${key}" ${shape.reason}`);
      const size = checkSize(value);
      if (!size.ok) return ApiResponseBuilder.badRequest(`Setting "${key}" ${size.reason}`);

      // Shape is not enough for the keys that have a REQUIRED shape. A media
      // base saved without a scheme passes every check above and then produces
      // broken image URLs on the shop, with the admin reporting success — the
      // exact failure this validator exists to make impossible.
      const problem = validateSetting(key, value, declaredGroups);
      if (problem) return ApiResponseBuilder.badRequest(`Setting "${key}" ${problem}`);
    }

    for (const [key, value] of entries) {
      const updated = await LocalDB.updateSetting(key, normaliseSettingValue(key, value));
      results[key] = updated?.value ?? null;
    }

    // Switching a built-in collection on or off changes the CONTENT-TYPE
    // REGISTRY, which is built once per process by the plugin bootstrap. Without
    // this an operator ticks "let readers comment", sees "Settings saved", and
    // /api/content/comment keeps answering 404 until the server restarts — which
    // reads exactly like the feature not working.
    if (entries.some(([key]) => key === COMMENTS_ENABLED_SETTING || key === REVIEWS_ENABLED_SETTING)) {
      await reloadPlugins().catch((err) => {
        console.error('[astrobaas] could not reload after a collection switch:', err);
      });
    }

    // The media base is memoised per process. Without this an operator fixes the
    // setting, sees "Settings saved", and the API keeps emitting the old URLs
    // until the memo expires — which reads exactly like the fix not working.
    invalidateMediaBase();

    return ApiResponseBuilder.success(results, 'Settings updated successfully');
  } catch (error) {
    console.error('Error updating settings:', error);
    return ApiResponseBuilder.serverError('Failed to update settings');
  }
};
