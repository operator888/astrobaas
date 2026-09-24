/**
 * Rebuilding one field rule, for BOTH definition doors.
 *
 * ## The gap this closes
 *
 * A content type can arrive two ways: an operator builds one on
 * `/admin/content-types`, or a plugin declares one in its manifest. Those two
 * doors were validated by two different pieces of code, and they had already
 * drifted apart in two ways that matter:
 *
 *  - **Different vocabularies.** The admin builder accepted twelve field kinds
 *    including `ref` and `media`; the manifest validator's own `FIELD_TYPES`
 *    set listed ten and rejected exactly those two. A plugin therefore could
 *    not declare the two kinds that make a collection real -- an event naming
 *    its venue, a team member having a photograph.
 *
 *  - **One door rebuilt, the other CAST.** `validateContentTypeDefinitions`
 *    reconstructed every rule from the parts its type actually has, so an
 *    unknown key on a stored rule could never reach `validate()`.
 *    `manifestContentTypes` wrote `(ct.fields ?? []) as ContentTypeField[]`.
 *    The manifest validator checked only that `rule.type` was a known string,
 *    so an enum whose values contained a NUL, a `ref` whose `to` named
 *    nothing, an array with no `of`, a `min` above its `max` -- all of them
 *    passed the door and reached the validator unexamined.
 *
 * Six of the remaining roadmap capabilities want to add something to a field
 * rule. Adding it to a loop that is written twice, in two vocabularies, one of
 * which is bypassed by a cast, is how the next gap gets built.
 *
 * ## Shape
 *
 * `buildFieldRule` is pure and reports through a callback rather than throwing,
 * because both callers accumulate every error and report them together -- a
 * builder that stops at the first mistake makes an operator fix a ten-field
 * type ten times.
 */
import type { FieldRule } from '../lib/validate';

/** Collection names: kebab-case. The same rule the collections themselves use. */
const COLLECTION_NAME_RE = /^[a-z][a-z0-9-]{1,40}$/;

/**
 * Control characters and NUL, refused inside an enum's VALUES.
 *
 * In the definition, not only in entries: the enum branch of `validate()`
 * checks membership, so a NUL baked into a declared value would be stored
 * through it without ever being examined.
 */
const CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/** Every field kind either door accepts. ONE vocabulary, deliberately. */
export const FIELD_TYPES = [
  'string', 'number', 'boolean', 'id', 'slug', 'email', 'url',
  'enum', 'array', 'date', 'ref', 'media', 'file', 'repeater',
] as const;

export type FieldTypeName = (typeof FIELD_TYPES)[number];

export const FIELD_TYPE_SET: ReadonlySet<string> = new Set(FIELD_TYPES);

export const MAX_ENUM_VALUES = 50;
export const MAX_ENUM_VALUE_LENGTH = 120;
/** Sub-fields inside one repeater (or one of its layouts). */
export const MAX_REPEATER_FIELDS = 20;
/** Named layouts one flexible-content repeater may offer. */
export const MAX_LAYOUTS = 12;

/**
 * Field names a repeater ITEM may not use.
 *
 * `_layout` is the discriminator a flexible-content item carries, so a declared
 * field of that name would be clobbered by the writer and would make the item
 * unreadable. Same reasoning as `hp_url` and `pow_token` at the top level.
 */
const RESERVED_ITEM_NAMES = new Set(['_layout', '_status', 'hp_url', 'pow_token', '__proto__', 'constructor', 'prototype']);

const SUB_FIELD_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,40}$/;

/**
 * Rebuild the fields inside a repeater or one of its layouts.
 *
 * `nested` is true here, which is what refuses a repeater inside a repeater.
 * ONE level is a decision, not a limitation: it removes the recursion-depth
 * question, the cycle question, and the "how deep does the GDPR sweep walk"
 * question all at once — and that last one is not academic, because a person's
 * email address nested two levels down is a subject-access request that
 * answers "we hold nothing about you".
 */
function buildSubFields(
  raw: unknown,
  where: string,
  push: (message: string) => void,
): { name: string; rule: FieldRule }[] | null {
  if (!Array.isArray(raw) || raw.length === 0) {
    push(`${where}.fields must be a non-empty array`);
    return null;
  }
  if (raw.length > MAX_REPEATER_FIELDS) {
    push(`${where} has too many fields (max ${MAX_REPEATER_FIELDS})`);
    return null;
  }
  const out: { name: string; rule: FieldRule }[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i += 1) {
    const f = raw[i] as Record<string, unknown> | null;
    if (!f || typeof f !== 'object') {
      push(`${where}.fields[${i}] must be an object`);
      return null;
    }
    const name = f.name;
    if (typeof name !== 'string' || !SUB_FIELD_NAME_RE.test(name)) {
      push(`${where}.fields[${i}].name is invalid`);
      return null;
    }
    if (RESERVED_ITEM_NAMES.has(name)) {
      push(`${where}.fields[${i}].name "${name}" is reserved`);
      return null;
    }
    if (seen.has(name)) {
      push(`${where}.fields[${i}].name "${name}" appears twice`);
      return null;
    }
    seen.add(name);
    const rule = buildFieldRule(f.rule, `${where}.fields[${i}]`, push);
    if (!rule) return null;
    if (rule.type === 'repeater') {
      push(`${where}.fields[${i}]: a repeater cannot contain a repeater`);
      return null;
    }
    out.push({ name, rule });
  }
  return out;
}

/**
 * Rebuild a stored/declared rule into one `validate()` can be trusted with.
 *
 * Returns `null` when the rule is unusable -- every reason has already been
 * reported through `push`, prefixed with `where` so the message names the
 * field by position rather than leaving the operator to count.
 *
 * The rebuild is the point: the returned object is constructed key by key from
 * the parts THIS type actually has, so nothing the caller did not examine can
 * survive into the schema.
 */
export function buildFieldRule(
  raw: unknown,
  where: string,
  push: (message: string) => void,
): FieldRule | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    push(`${where}.rule must be an object`);
    return null;
  }
  const r = raw as Record<string, unknown>;
  const type = r.type;
  if (typeof type !== 'string' || !FIELD_TYPE_SET.has(type)) {
    push(`${where}.rule.type must be one of: ${FIELD_TYPES.join(', ')}`);
    return null;
  }

  const rule: Record<string, unknown> = { type };
  if (r.optional === true) rule.optional = true;

  if (type === 'string' || type === 'number') {
    if (r.min !== undefined) {
      if (typeof r.min !== 'number' || !Number.isFinite(r.min)) {
        push(`${where}.rule.min must be a number`);
        return null;
      }
      rule.min = r.min;
    }
    if (r.max !== undefined) {
      if (typeof r.max !== 'number' || !Number.isFinite(r.max)) {
        push(`${where}.rule.max must be a number`);
        return null;
      }
      rule.max = r.max;
    }
    if (typeof rule.min === 'number' && typeof rule.max === 'number' && rule.min > rule.max) {
      push(`${where}: min exceeds max`);
      return null;
    }
  }

  if (type === 'number' && r.int === true) rule.int = true;

  if (type === 'enum') {
    const values = r.values;
    if (!Array.isArray(values) || values.length === 0 || values.length > MAX_ENUM_VALUES
      || !values.every((v) => typeof v === 'string' && v.length <= MAX_ENUM_VALUE_LENGTH && !CONTROLS.test(v))) {
      push(`${where}: enum needs 1-${MAX_ENUM_VALUES} string values with no control characters`);
      return null;
    }
    rule.values = [...values];
  }

  if (type === 'ref') {
    // The collection it points AT, validated with the collection name rule so a
    // ref can never name something that could not exist. Whether it currently
    // exists is a different question, deliberately: types are defined in any
    // order, and a definition that fails because a sibling has not registered
    // yet is a builder that works only if you use it in the right sequence.
    if (typeof r.to !== 'string' || !COLLECTION_NAME_RE.test(r.to)) {
      push(`${where}: ref needs a "to" collection name`);
      return null;
    }
    rule.to = r.to;
  }

  if (type === 'array') {
    rule.of = r.of === 'number' ? 'number' : 'string';
    if (typeof r.max === 'number' && Number.isFinite(r.max)) rule.max = r.max;
  }

  if (type === 'repeater') {
    // Either the same shape for every item (`fields`), or a CHOICE of named
    // shapes (`layouts`) — which is ACF's flexible content, expressed as one
    // rule rather than a second feature. Both at once is ambiguous: an item
    // would have two shapes and no rule for picking.
    const hasLayouts = Array.isArray(r.layouts) && r.layouts.length > 0;
    if (hasLayouts && r.fields !== undefined) {
      push(`${where}: a repeater has either fields or layouts, not both`);
      return null;
    }
    if (hasLayouts) {
      const layouts = r.layouts as unknown[];
      if (layouts.length > MAX_LAYOUTS) {
        push(`${where} has too many layouts (max ${MAX_LAYOUTS})`);
        return null;
      }
      const built: { name: string; label: string; fields: { name: string; rule: FieldRule }[] }[] = [];
      const seen = new Set<string>();
      for (let i = 0; i < layouts.length; i += 1) {
        const l = layouts[i] as Record<string, unknown> | null;
        if (!l || typeof l !== 'object') {
          push(`${where}.layouts[${i}] must be an object`);
          return null;
        }
        const name = l.name;
        if (typeof name !== 'string' || !COLLECTION_NAME_RE.test(name)) {
          push(`${where}.layouts[${i}].name must be kebab-case`);
          return null;
        }
        if (seen.has(name)) {
          push(`${where}.layouts[${i}].name "${name}" appears twice`);
          return null;
        }
        seen.add(name);
        const label = typeof l.label === 'string' && l.label.trim() ? l.label.trim().slice(0, 80) : name;
        const fields = buildSubFields(l.fields, `${where}.layouts[${i}]`, push);
        if (!fields) return null;
        built.push({ name, label, fields });
      }
      rule.layouts = built;
    } else {
      const fields = buildSubFields(r.fields, where, push);
      if (!fields) return null;
      rule.fields = fields;
    }
    for (const bound of ['min', 'max'] as const) {
      const n = r[bound];
      if (n === undefined) continue;
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) {
        push(`${where}.rule.${bound} must be a whole number`);
        return null;
      }
      rule[bound] = n;
    }
    if (typeof rule.min === 'number' && typeof rule.max === 'number' && rule.min > rule.max) {
      push(`${where}: min exceeds max`);
      return null;
    }
  }

  return rule as FieldRule;
}

export const MAX_STEPS = 10;
export const MAX_STEP_TITLE = 80;

/**
 * Validate a field's presentation extras: its step, and its condition.
 *
 * Separate from `buildFieldRule` because these are NOT part of the rule —
 * `schemaForContentType` strips a field to its `rule`, so the validator never
 * sees them and cannot be confused by them. Putting form presentation on
 * `FieldRule` would leak forms into the pure validator that posts, contact,
 * commerce and the newsletter all share.
 *
 * `earlier` is the set of field names declared BEFORE this one. A condition may
 * only name one of those, which makes a cycle impossible by construction rather
 * than by a cycle check somebody has to remember to run.
 */
export function buildFieldPresentation(
  raw: Record<string, unknown>,
  where: string,
  steps: number,
  earlier: ReadonlySet<string>,
  push: (message: string) => void,
): { label?: string; step?: number; showIf?: { field: string; equals: string | number | boolean } } | null {
  const out: { label?: string; step?: number; showIf?: { field: string; equals: string | number | boolean } } = {};

  if (raw.label !== undefined) {
    if (typeof raw.label !== 'string') {
      push(`${where}.label must be a string`);
      return null;
    }
    // Rendered as text everywhere, never as HTML; control characters are
    // dropped so a label cannot break a line or a table cell.
    const label = raw.label.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80);
    if (label) out.label = label;
  }

  if (raw.step !== undefined) {
    const n = raw.step;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > steps) {
      push(`${where}.step must be a whole number between 1 and ${steps}`);
      return null;
    }
    // 1 is the default, so it is not stored — an existing single-step type and
    // a type whose author typed "1" produce the same definition.
    if (n > 1) out.step = n;
  }

  if (raw.showIf !== undefined) {
    const c = raw.showIf;
    if (!c || typeof c !== 'object' || Array.isArray(c)) {
      push(`${where}.showIf must be an object`);
      return null;
    }
    const cond = c as Record<string, unknown>;
    if (typeof cond.field !== 'string' || !cond.field) {
      push(`${where}.showIf.field is required`);
      return null;
    }
    if (!earlier.has(cond.field)) {
      // Not merely "must exist": must come EARLIER. Two fields each waiting on
      // the other is a form where neither ever appears, and it looks correct
      // in the builder.
      push(`${where}.showIf.field must name a field declared BEFORE this one`);
      return null;
    }
    const v = cond.equals;
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
      push(`${where}.showIf.equals must be a string, number or boolean`);
      return null;
    }
    if (typeof v === 'string' && v.length > 200) {
      push(`${where}.showIf.equals is too long`);
      return null;
    }
    out.showIf = { field: cond.field, equals: v };
  }

  return out;
}

/** Validate the step-title list. Returns the rebuilt list, or null on error. */
export function buildSteps(
  raw: unknown,
  where: string,
  push: (message: string) => void,
): { title: string }[] | undefined | null {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length === 0) {
    push(`${where}.steps must be a non-empty array`);
    return null;
  }
  if (raw.length > MAX_STEPS) {
    push(`${where} has too many steps (max ${MAX_STEPS})`);
    return null;
  }
  const out: { title: string }[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const s = raw[i] as Record<string, unknown> | null;
    if (!s || typeof s !== 'object' || typeof s.title !== 'string' || !s.title.trim()) {
      push(`${where}.steps[${i}].title is required`);
      return null;
    }
    out.push({ title: s.title.trim().slice(0, MAX_STEP_TITLE) });
  }
  // One step is the same as none: not stored, so an author who added a single
  // step and an author who added none get the same definition.
  return out.length > 1 ? out : undefined;
}
