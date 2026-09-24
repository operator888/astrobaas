/**
 * The rule the Content types builder saves for one field.
 *
 * The builder shows a few controls per field: its kind, "required", the
 * choices of an enum, the target of a link, the sub-fields of a group. It used
 * to rebuild the rule from those controls alone, so everything else a stored
 * rule carried was dropped the moment somebody opened the type and pressed
 * Save, without touching that field:
 *
 *  - `max: 400` on text, which is what makes the entries screen and the public
 *    form offer a textarea, and the length limit itself;
 *  - `min`, `max` and `int` on numbers, which are validation;
 *  - a list's `of: 'number'`, which the builder overwrote with 'string';
 *  - a repeating group's `layouts`, which the builder cannot show, so it wrote
 *    `fields: []` instead and the save was refused outright.
 *
 * Themes and plugins define types with all of these. One re-save in the admin
 * quietly changed their forms and their validation.
 *
 * So the builder now starts from the rule the field had when the form was
 * filled and overwrites only what its controls own. A field whose kind changed
 * starts clean: `max` on text means characters and on a number means a value,
 * and carrying it across would be a guess. Keys that do not apply to the kind
 * are harmless here anyway, because the server rebuilds every rule key by key
 * (core/field-rule-build.ts) and keeps only what the kind has.
 */

/** A field rule as the builder handles it: plain JSON. */
export type RuleJson = { type: string; [key: string]: unknown };

/**
 * `edited` is what the controls produce: `type`, `optional` when "required" is
 * unticked, `values` for a choice, `to` for a link, `fields` for a group.
 * `stored` is the rule before editing, or undefined for a new field.
 */
export function mergeFieldRule(stored: RuleJson | undefined, edited: RuleJson): RuleJson {
  if (!stored || stored.type !== edited.type) {
    // A list needs to say what it holds; the builder has no control for it.
    return edited.type === 'array' && edited.of === undefined ? { ...edited, of: 'string' } : edited;
  }

  const out: RuleJson = { ...stored, ...edited };

  // "required" is a control, so its absence in `edited` is an answer.
  if (edited.optional !== true) delete out.optional;

  if (out.type === 'array' && out.of === undefined) out.of = 'string';

  if (out.type === 'repeater' && Array.isArray(stored.layouts) && stored.layouts.length > 0) {
    // The builder cannot show layouts, so what it read back for this group is
    // not an edit of them. Keep them, and never send `fields` beside them:
    // a group has one or the other.
    out.layouts = stored.layouts;
    delete out.fields;
  }
  return out;
}
