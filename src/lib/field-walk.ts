/**
 * Walking a content type's fields — including the nested ones.
 *
 * ## Why this exists before the repeater does
 *
 * Three places filter a definition's fields by rule type, and all three were
 * written as `def.fields.filter(f => f.rule.type === X)`:
 *
 *  - `refFields` / `mediaFields` in `content-refs.ts`, which decide what a
 *    write path must check exists and what a read path must resolve to a URL;
 *  - `emailFields` inside `gdpr.ts`, which is how a data subject is FOUND.
 *
 * Flat by construction, every one of them. The moment a repeater field can
 * hold a group with an `email` in it, that third one stops seeing a person's
 * address — and the failure is a GDPR request that answers "we hold nothing
 * about you" while holding it. That is not a bug to fix after shipping the
 * repeater; it is the reason this module is written first.
 *
 * ## One level, deliberately
 *
 * A repeater may not contain a repeater. That is enforced in the definition
 * validators, and it means this walk is a loop rather than a recursion, with
 * no depth limit to choose and no cycle to guard against.
 *
 * ## Paths
 *
 * A nested field's path is `parent[].child` — the `[]` says the parent is a
 * list, so a reader knows the value is per-item rather than singular. The path
 * is for messages and for `valuesAt`, never for storage: the stored shape is
 * ordinary nested JSON.
 */
import type { ContentTypeDefinition, ContentTypeField } from '../core/content-types';

export interface WalkedField {
  /** The field itself. */
  field: ContentTypeField;
  /** `undefined` at the top level, or the repeater field it lives inside. */
  parent?: ContentTypeField;
  /** `field.name`, or `parent[].field.name`. */
  path: string;
  /** The layout this field belongs to, for a repeater with named layouts. */
  layout?: string;
}

/** The rule shape a repeater has. Kept here so callers need not cast. */
export interface RepeaterRule {
  type: 'repeater';
  fields?: ContentTypeField[];
  layouts?: { name: string; label: string; fields: ContentTypeField[] }[];
  min?: number;
  max?: number;
}

export function isRepeater(field: ContentTypeField): boolean {
  return field.rule.type === 'repeater';
}

/** Every sub-field a repeater can hold, across all of its layouts. */
export function repeaterFields(field: ContentTypeField): { field: ContentTypeField; layout?: string }[] {
  const rule = field.rule as unknown as RepeaterRule;
  if (rule.type !== 'repeater') return [];
  const out: { field: ContentTypeField; layout?: string }[] = [];
  for (const f of rule.fields ?? []) out.push({ field: f });
  for (const l of rule.layouts ?? []) for (const f of l.fields) out.push({ field: f, layout: l.name });
  return out;
}

/**
 * Every field on a type, top level and nested, in declaration order.
 *
 * The top-level repeater itself is yielded too: a caller counting fields, or
 * rendering them, needs to know it is there.
 */
export function walkFields(def: ContentTypeDefinition): WalkedField[] {
  const out: WalkedField[] = [];
  for (const field of def.fields) {
    out.push({ field, path: field.name });
    for (const child of repeaterFields(field)) {
      out.push({
        field: child.field,
        parent: field,
        path: `${field.name}[].${child.field.name}`,
        layout: child.layout,
      });
    }
  }
  return out;
}

/** Every field of a given rule type, nested ones included. */
export function fieldsOfType(def: ContentTypeDefinition, type: string): WalkedField[] {
  return walkFields(def).filter((w) => w.field.rule.type === type);
}

/**
 * Every value stored at a walked field's path, flattened.
 *
 * A top-level field yields at most one value; a nested one yields the child's
 * value from every item of the repeater. Callers that ask "does this record
 * mention this address" want all of them, and want them without each of them writing
 * the same two-level loop.
 */
export function valuesAt(walked: WalkedField, data: Record<string, unknown> | undefined): unknown[] {
  if (!data) return [];
  if (!walked.parent) {
    const v = data[walked.field.name];
    return v === undefined ? [] : [v];
  }
  const items = data[walked.parent.name];
  if (!Array.isArray(items)) return [];
  const out: unknown[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    // A layout-tagged item only carries the fields of ITS layout, so a field
    // belonging to another layout is legitimately absent rather than missing.
    if (walked.layout && (item as Record<string, unknown>)._layout !== walked.layout) continue;
    const v = (item as Record<string, unknown>)[walked.field.name];
    if (v !== undefined) out.push(v);
  }
  return out;
}

/**
 * Write a value back at a walked path, in place.
 *
 * Used by the read-time resolvers (a media id becoming a URL), which need to
 * enrich a nested item as readily as a top-level field. Mutates `data` because
 * that is what every existing resolver does; copying a whole record to set one
 * sibling key would be a different change with different consequences.
 */
export function setAt(
  walked: WalkedField,
  data: Record<string, unknown>,
  compute: (value: unknown) => Record<string, unknown> | undefined,
): void {
  if (!walked.parent) {
    const extra = compute(data[walked.field.name]);
    if (extra) Object.assign(data, extra);
    return;
  }
  const items = data[walked.parent.name];
  if (!Array.isArray(items)) return;
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    if (walked.layout && rec._layout !== walked.layout) continue;
    const extra = compute(rec[walked.field.name]);
    if (extra) Object.assign(rec, extra);
  }
}
