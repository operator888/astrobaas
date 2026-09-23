/**
 * Settings an operator DECLARES (C-127) — ACF's options pages.
 *
 * ## What was missing, precisely
 *
 * The settings store is a hardened but schemaless bucket: the key shape, the
 * value size, its depth and its entry count are all bounded, and about eight
 * keys have a required shape hand-listed in `lib/settings-validate.ts`. Every
 * settings control in the product is bespoke markup for a key somebody wrote by
 * hand. There was no way to say "this install also stores an opening-hours
 * table and a booking email", and therefore no way to render a form for it or
 * to enforce anything about what it holds.
 *
 * ## Reusing the field vocabulary, not inventing a second one
 *
 * A settings field is the same idea as a content-type field: a name and a
 * `FieldRule`. So this reuses `ContentTypeField` and `buildFieldRule`, and a
 * kind added to one is available to the other by construction. The alternative
 * — a parallel list of settings field types — is the sibling gap that lost
 * `ref` and `media` from the manifest door for months.
 *
 * ## Storage, and the reason for the prefix
 *
 * Each field is one setting, keyed `group.<groupId>.<fieldName>` — which passes
 * the existing `SAFE_KEY` guard unchanged. A group marked `public` keys its
 * fields `public_group.<groupId>.<fieldName>` instead, because
 * `isPublicSetting` already discloses the `public_` prefix to anonymous
 * callers. That is the whole headless story: no new endpoint, and a decoupled
 * storefront reads a declared group from `GET /api/settings/get` like any
 * other public setting.
 *
 * Deny by default: a group is private unless its author says otherwise, the
 * same rule a content type follows.
 *
 * ## Enforcement is the point
 *
 * A generated form without a server-side check is decoration —
 * `POST /api/settings/update` would still accept any shape that passes the
 * generic size limit. `settingRuleFor()` below is what
 * `lib/settings-validate.ts` consults, so a declared key is validated by its
 * declared rule wherever it is written from.
 */
import type { ContentTypeField } from './content-types';
import { buildFieldRule } from './field-rule-build';
import type { FieldRule } from '../lib/validate';

/** Where the operator's declared groups live. Mirrors ADMIN_CONTENT_TYPES_SETTING. */
export const SETTING_GROUPS_SETTING = 'admin_setting_groups';

/** The key prefix a private group's fields use. */
export const GROUP_KEY_PREFIX = 'group.';
/** …and the one a public group uses, which `isPublicSetting` already discloses. */
export const PUBLIC_GROUP_KEY_PREFIX = 'public_group.';

export const MAX_SETTING_GROUPS = 12;
export const MAX_FIELDS_PER_GROUP = 24;

const GROUP_ID_RE = /^[a-z][a-z0-9-]{1,30}$/;
const FIELD_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,40}$/;

export interface SettingGroup {
  /** Kebab-case, unique. Part of every one of the group's storage keys. */
  id: string;
  label: string;
  description?: string;
  /**
   * May an anonymous caller read this group's values?
   *
   * Absent means NO. A settings group is where an operator puts the things the
   * product does not have a field for, and some of those are a booking mailbox
   * or a warehouse address. Defaulting to public would publish them.
   */
  public?: boolean;
  fields: ContentTypeField[];
}

export interface SettingGroupValidation {
  ok: boolean;
  groups: SettingGroup[];
  errors: string[];
}

/** The storage key one declared field is written to. */
export function settingKeyFor(group: Pick<SettingGroup, 'id' | 'public'>, fieldName: string): string {
  const prefix = group.public ? PUBLIC_GROUP_KEY_PREFIX : GROUP_KEY_PREFIX;
  return `${prefix}${group.id}.${fieldName}`;
}

/**
 * The rule a declared key must satisfy, or `null` if no group declares it.
 *
 * This is what makes the generated form more than decoration: without it,
 * `POST /api/settings/update` accepts any shape that fits the generic size
 * limit, and a "number" field happily stores the word "later".
 */
export function settingRuleFor(groups: readonly SettingGroup[], key: string): FieldRule | null {
  for (const g of groups) {
    const prefix = g.public ? PUBLIC_GROUP_KEY_PREFIX : GROUP_KEY_PREFIX;
    if (!key.startsWith(`${prefix}${g.id}.`)) continue;
    const name = key.slice(prefix.length + g.id.length + 1);
    const field = g.fields.find((f) => f.name === name);
    if (field) return field.rule;
  }
  return null;
}

/**
 * Validate operator-authored groups, as hard as a hostile manifest.
 *
 * The admin screen is trusted UI; the STORED VALUE outlives it. It can arrive
 * through the settings API, a restore, or a hand edit, so every group is
 * rebuilt key by key and anything unrecognised is dropped — the same discipline
 * `validateContentTypeDefinitions` applies, for the same reason.
 */
export function validateSettingGroups(raw: unknown): SettingGroupValidation {
  const errors: string[] = [];
  const push = (m: string) => { errors.push(m); };
  const groups: SettingGroup[] = [];

  if (raw === null || raw === undefined || raw === '') return { ok: true, groups: [], errors: [] };
  if (!Array.isArray(raw)) return { ok: false, groups: [], errors: ['groups must be an array'] };
  if (raw.length > MAX_SETTING_GROUPS) {
    return { ok: false, groups: [], errors: [`too many groups (max ${MAX_SETTING_GROUPS})`] };
  }

  const seenIds = new Set<string>();
  raw.forEach((g: unknown, i: number) => {
    if (!g || typeof g !== 'object' || Array.isArray(g)) return push(`groups[${i}] must be an object`);
    const grp = g as Record<string, unknown>;

    const id = grp.id;
    if (typeof id !== 'string' || !GROUP_ID_RE.test(id)) {
      return push(`groups[${i}].id must be kebab-case, 2-31 chars`);
    }
    if (seenIds.has(id)) return push(`groups[${i}].id "${id}" appears twice`);
    seenIds.add(id);

    if (typeof grp.label !== 'string' || !grp.label.trim()) return push(`groups[${i}].label is required`);
    if (grp.public !== undefined && typeof grp.public !== 'boolean') {
      return push(`groups[${i}].public must be true or false`);
    }
    if (!Array.isArray(grp.fields) || grp.fields.length === 0) {
      return push(`groups[${i}].fields must be a non-empty array`);
    }
    if (grp.fields.length > MAX_FIELDS_PER_GROUP) {
      return push(`groups[${i}] has too many fields (max ${MAX_FIELDS_PER_GROUP})`);
    }

    const fields: ContentTypeField[] = [];
    const seenNames = new Set<string>();
    for (let j = 0; j < grp.fields.length; j += 1) {
      const f = grp.fields[j] as Record<string, unknown> | null;
      if (!f || typeof f !== 'object') return push(`groups[${i}].fields[${j}] must be an object`);
      const name = f.name;
      if (typeof name !== 'string' || !FIELD_NAME_RE.test(name)) {
        return push(`groups[${i}].fields[${j}].name is invalid`);
      }
      if (seenNames.has(name)) return push(`groups[${i}].fields[${j}].name "${name}" appears twice`);
      seenNames.add(name);
      const rule = buildFieldRule(f.rule, `groups[${i}].fields[${j}]`, push);
      if (!rule) return;
      if (rule.type === 'repeater') {
        // A repeater's value is a list of records. The settings store holds one
        // JSON value per key and bounds it, so this would work — but a settings
        // screen that grows a nested list editor is a content type wearing a
        // disguise, and the product already has content types.
        return push(`groups[${i}].fields[${j}]: a repeating group belongs in a content type, not in settings`);
      }
      fields.push({ name, rule });
    }

    const built: { [K in keyof Required<SettingGroup>]: SettingGroup[K] } = {
      id,
      label: String(grp.label).trim().slice(0, 80),
      description: typeof grp.description === 'string' ? grp.description.trim().slice(0, 300) : undefined,
      public: grp.public === true ? true : undefined,
      fields,
    };
    groups.push(built);
  });

  return { ok: errors.length === 0, groups: errors.length === 0 ? groups : [], errors };
}
