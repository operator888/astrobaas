/**
 * Custom content types.
 *
 * Plugins call `registerContentType()` (typically in their `activate()`) to add
 * a named collection — "product", "event", "doc", etc. — beyond the built-in
 * Post/Category/User. Records are stored generically in DatabaseSchema.custom
 * and validated against the declared field schema using the same `validate()`
 * the rest of the app uses. This is the minimal-but-real "unlimited content"
 * primitive; richer field types/relations can layer on later without changing
 * this registration contract.
 *
 * @alpha
 */
import type { FieldRule } from '../lib/validate';
import { buildFieldRule, buildFieldPresentation, buildSteps, FIELD_TYPES } from './field-rule-build';

export interface ContentTypeField {
  name: string;
  rule: FieldRule;
  /**
   * What a person reads: "Seats left" for `seats_left`. Optional; screens fall
   * back to a readable form of the name. Presentation only, like `step`, so
   * the validator never sees it. It used to be dropped on save, so a theme or
   * plugin that sent labels got raw field names on every screen.
   */
  label?: string;
  /**
   * Which step of a multi-step form this field belongs to (C-22).
   *
   * 1-based, and absent means step 1 — so an existing single-step type keeps
   * rendering as one form without anyone editing it. Purely presentational:
   * `schemaForContentType` strips a field down to its `rule`, so the validator
   * never sees this and could not be confused by it.
   */
  step?: number;
  /**
   * Show this field only when an EARLIER field holds a given value (C-22/C-125).
   *
   * One condition, one operator. That is not a placeholder for a richer
   * expression language: a condition that can reference a later field can form
   * a cycle, and a condition with `and`/`or` needs an evaluator on both the
   * client and the server that cannot disagree. Targeting an earlier field
   * makes cycles impossible by construction, and equality is the only operator
   * whose client and server answers are the same string comparison.
   *
   * IMPORTANT: this is presentation, never authorization. The whole definition
   * is served to the browser, so a field only staff should see must be a field
   * the type does not declare — not a field the form hides.
   */
  showIf?: FieldCondition;
}

/** One equality condition. See {@link ContentTypeField.showIf}. */
export interface FieldCondition {
  /** The name of an EARLIER field in the same type. */
  field: string;
  /** The value that reveals the dependent field. Compared as a string. */
  equals: string | number | boolean;
}

/**
 * Who may READ a custom collection.
 *
 * - `public` — anyone, no credentials. Site content a frontend renders.
 * - `staff`  — any signed-in user (or an API key scoped to `content`).
 */
export type ContentTypeVisibility = 'public' | 'staff';

/**
 * Who may CREATE an entry in a collection.
 *
 * - `staff`  — admins and editors, signed in. The default, and the only
 *   behaviour that existed before.
 * - `public` — anyone, no credentials. This is what turns a content type into
 *   a FORM: an enquiry, a job application, an RSVP, a support request.
 *
 * Separate from `visibility` on purpose, because the two answer different
 * questions and the dangerous combination is real. A contact form is
 * `writable: 'public'` and `visibility: 'staff'` — anyone may send one, nobody
 * may read the others. Declaring both `public` publishes every submission to
 * the open web, which is right for a guestbook and a data breach for a job
 * application. One field could not express that difference, so there are two.
 */
export type ContentTypeWritePolicy = 'public' | 'staff';

export interface ContentTypeDefinition {
  /** Unique collection id, kebab-case (e.g. "product"). Becomes the API path. */
  name: string;
  /** Human label (singular), e.g. "Product". */
  label: string;
  /** Optional plural label for UI. */
  labelPlural?: string;
  /** Field schema — validated on create/update. */
  fields: ContentTypeField[];
  /**
   * Does a PUBLIC submission to this type wait for approval? (C-142, C-35)
   *
   * Absent means no, which is the behaviour every existing type has.
   *
   * `visibility` is collection-wide and cannot express this: `'public'`
   * publishes every row including one posted thirty seconds ago, which is why
   * comments and product reviews were each blocked on a primitive rather than
   * on a feature. See core/moderation.ts.
   *
   * Only meaningful with `writable: 'public'` — a staff-only collection has
   * nothing to moderate, because a colleague typing an entry IS the approval.
   */
  moderated?: boolean;
  /**
   * Titles for a multi-step form (C-22). Absent means one step.
   *
   * The COUNT is what matters: a field naming a step beyond this list is
   * refused at definition time, so a form can never have a step nobody can
   * reach. The titles are shown above each step's fields.
   */
  steps?: { title: string }[];
  /**
   * Read policy for this collection. **Defaults to `staff`** — a type is
   * private until its author says otherwise.
   *
   * Deny-by-default is deliberate and it is a change from the original
   * behaviour, where every registered type was world-readable at
   * `GET /api/content/<name>` with no way to say otherwise (audit item D2-4).
   * That default is fine for "event" or "doc" and a data breach for
   * "job-application" or "enquiry" — and the failure is silent, because a
   * plugin author who never thinks about visibility gets the leaking option.
   *
   * Requiring the word `public` costs one line and makes the author decide
   * once, in the place where they know the answer.
   */
  visibility?: ContentTypeVisibility;
  /**
   * Write policy. **Defaults to `staff`** — deny-by-default, like `visibility`.
   *
   * Setting this to `public` opens an anonymous POST endpoint on the internet.
   * The handler pairs it with a honeypot, the local proof-of-work check and a
   * per-IP rate limit, but the decision itself is the operator's and it is
   * never inferred: a type that says nothing accepts nothing from strangers.
   */
  writable?: ContentTypeWritePolicy;
  /**
   * Email the site's admin address when a public submission arrives.
   *
   * Only meaningful with `writable: 'public'`, and only when an email channel
   * is configured. A form nobody is told about is a form nobody answers.
   */
  notifyOnSubmission?: boolean;
}

/**
 * May an anonymous caller read this collection?
 *
 * A single function so the list route, the entity route and anything added
 * later cannot disagree — the sibling-gap failure this codebase repeats.
 */
export function contentTypeIsPublic(def: ContentTypeDefinition | undefined): boolean {
  return def?.visibility === 'public';
}

/**
 * May an anonymous caller CREATE an entry here?
 *
 * The same single-predicate discipline as `contentTypeIsPublic`, for the same
 * reason: the route, the middleware and the admin screen must not be able to
 * disagree about who may post. Requires the exact word — an absent, misspelled
 * or hostile value means no.
 */
export function contentTypeAcceptsPublicWrites(def: ContentTypeDefinition | undefined): boolean {
  return def?.writable === 'public';
}

const registry = new Map<string, ContentTypeDefinition>();

const NAME_RE = /^[a-z][a-z0-9-]{1,40}$/;
/** Names reserved by built-in collections / routes. */
/**
 * Names CORE ships a collection under (C-142, C-35).
 *
 * Reserved against an operator and against a plugin — a custom `comment` type
 * would shadow the real one and the shadow check would report it as a clash
 * nobody could act on. Core registers them through `registerContentType(def,
 * { builtin: true })`, which is the only way past this list.
 */
export const BUILTIN_COLLECTION_NAMES = new Set(['comment', 'comments', 'review', 'reviews']);

const RESERVED = new Set([...BUILTIN_COLLECTION_NAMES, 'post', 'posts', 'category', 'categories', 'user', 'users', 'media', 'theme', 'themes', 'setting', 'settings', 'plugin', 'plugins', 'auth', 'backup', 'content', 'search', 'newsletter', 'contact', 'messages', 'product', 'products', 'brand', 'brands', 'product-category', 'product-categories', 'order', 'orders', 'customer', 'customers', 'changes']);

/** Register (or replace) a custom content type. Idempotent per name. */
export function registerContentType(
  def: ContentTypeDefinition,
  opts: { builtin?: boolean } = {},
): void {
  if (!NAME_RE.test(def.name)) {
    throw new Error(`Invalid content type name "${def.name}" (use kebab-case, 2-41 chars).`);
  }
  // A built-in collection registers under a name that is reserved against
  // everybody else. The flag is the ONLY way past the list, and it is not
  // reachable from a plugin manifest or the admin builder — both of which go
  // through the validators below, which have no such escape.
  if (RESERVED.has(def.name) && !(opts.builtin && BUILTIN_COLLECTION_NAMES.has(def.name))) {
    throw new Error(`Content type name "${def.name}" is reserved.`);
  }
  // A typo must not silently become the permissive option. `visibility: 'publik'`
  // would otherwise fail the `=== 'public'` test and quietly lock the collection,
  // or — with the comparison written the other way — quietly open it.
  if (def.visibility !== undefined && def.visibility !== 'public' && def.visibility !== 'staff') {
    throw new Error(`Content type "${def.name}": visibility must be "public" or "staff".`);
  }
  // The SAME guard for writable — its own sibling gap. A mis-cased or
  // mistyped `writable` slipping through to the deny-by-default predicate would
  // be the safe direction, but a typo silently deciding a security boundary is
  // exactly what the visibility guard above exists to prevent, so writable
  // gets it too.
  if (def.writable !== undefined && def.writable !== 'public' && def.writable !== 'staff') {
    throw new Error(`Content type "${def.name}": writable must be "public" or "staff".`);
  }
  registry.set(def.name, def);
}

/** All registered custom content types. */
export function getContentTypes(): ContentTypeDefinition[] {
  return Array.from(registry.values());
}

/** Look up one by name, or undefined. */
export function getContentType(name: string): ContentTypeDefinition | undefined {
  return registry.get(name);
}

/** Build a validate() Schema from a content type's field list. */
export function schemaForContentType(def: ContentTypeDefinition): Record<string, FieldRule> {
  const schema: Record<string, FieldRule> = {};
  for (const f of def.fields) schema[f.name] = f.rule;
  return schema;
}

/**
 * Is this field's condition satisfied by these values?
 *
 * Compared as STRINGS on both sides. The browser sends `"yes"` from a select
 * and `"true"` from a checkbox; the definition may hold the boolean `true` or
 * the number `1`. A strict comparison would make a condition that plainly
 * reads as satisfied evaluate as false, and the operator would have no way to
 * tell which of the two spellings the code wanted.
 *
 * An unset value never satisfies a condition — a field whose parent has not
 * been answered yet is not shown.
 */
export function conditionHolds(cond: FieldCondition | undefined, values: Record<string, unknown>): boolean {
  if (!cond) return true;
  const actual = values[cond.field];
  if (actual === undefined || actual === null) return false;
  return String(actual) === String(cond.equals);
}

/**
 * The fields that are IN PLAY for these values (C-22, C-125).
 *
 * One function, two features: a multi-step form asks it what to render on the
 * step the visitor is on, and the admin entry screen asks it what to show
 * beside a record being edited. Those were two separate plans, and two
 * implementations of one `showIf` shape is exactly how the client and the
 * server come to disagree about whether a field was required.
 */
export function visibleFields(
  def: ContentTypeDefinition,
  values: Record<string, unknown>,
): ContentTypeField[] {
  // Walked in DECLARATION ORDER, against the values of the fields already
  // decided visible — not against the raw submission.
  //
  // A plain filter over the raw values leaks a whole branch. Given
  // `b showIf a=go` and `c showIf b=on`, a caller posting
  // `{a:'stop', b:'on', c:'sneaky'}` gets `b` hidden (a is not 'go') and then
  // `c` VISIBLE, because `values.b` is still 'on' — so `c`'s value survives
  // into a record whose whole branch was never shown. A condition may only
  // name an EARLIER field, so one forward pass reaches the fixpoint.
  const effective: Record<string, unknown> = {};
  const out: ContentTypeField[] = [];
  for (const f of def.fields) {
    if (!conditionHolds(f.showIf, effective)) continue;
    out.push(f);
    if (Object.prototype.hasOwnProperty.call(values ?? {}, f.name)) {
      effective[f.name] = values[f.name];
    }
  }
  return out;
}

/**
 * The schema to validate a SUBMISSION against, given what was submitted.
 *
 * Two things happen to a hidden field, and both are necessary:
 *
 *  - **It becomes optional.** Otherwise a form that correctly hid a required
 *    field produces `"x is required"` and the visitor cannot submit at all —
 *    conditional logic without this is not a feature, it is a broken form.
 *  - **Its submitted value is DROPPED.** A browser is not the only thing that
 *    can POST here. Without this, a bot fills in the branch it never took and
 *    the record carries an answer to a question it was never asked.
 *
 * `validate()` itself is untouched: it stays the pure, form-unaware validator
 * every hand-written schema in this codebase uses.
 */
export function schemaForSubmission(
  def: ContentTypeDefinition,
  values: Record<string, unknown>,
): { schema: Record<string, FieldRule>; values: Record<string, unknown> } {
  const shown = new Set(visibleFields(def, values).map((f) => f.name));
  const schema: Record<string, FieldRule> = {};
  for (const f of def.fields) {
    schema[f.name] = shown.has(f.name) ? f.rule : { ...f.rule, optional: true };
  }
  const kept: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values ?? {})) {
    // A key that is not a field at all is left alone: validate() drops it, and
    // the form's own meta-fields (the honeypot, the proof-of-work answer) pass
    // through here on their way to being read by the caller.
    if (!schema[k] || shown.has(k)) kept[k] = v;
  }
  return { schema, values: kept };
}

/** How many steps this type has. Absent or empty means one. */
export function stepCount(def: ContentTypeDefinition): number {
  return Math.max(1, def.steps?.length ?? 1);
}

/**
 * Drop every registered content type. Called before re-running plugin bootstrap
 * so a type belonging to an uninstalled plugin doesn't linger in-process.
 */
export function clearContentTypes(): void {
  registry.clear();
}

/** Test helper (alias of clearContentTypes). */
export function _clearContentTypes(): void {
  clearContentTypes();
}

/* ------------------------------------------------------------------ *
 * Admin-defined types
 * ------------------------------------------------------------------ */

/**
 * Field kinds the ADMIN BUILDER offers.
 *
 * The same set the manifest validator accepts, deliberately: an admin-defined
 * type and a manifest-defined one register through the same door, and two
 * different vocabularies for one registry is the sibling-gap bug with a UI.
 */
/**
 * Field types the admin builder offers.
 *
 * `ref` and `media` are the two that make a collection-only site real: without
 * them an "event" cannot name its venue and a "team member" cannot have a
 * photograph, so every non-trivial type ends up storing a URL somebody pasted
 * and nothing keeps it true.
 */
//
// ONE list, shared with the manifest door. It used to be spelled here and
// again as `FIELD_TYPES` in manifest.ts, and the two had drifted: the manifest
// copy lacked `ref` and `media`, so a plugin could not declare the two kinds
// that make a collection real.
export const ADMIN_FIELD_TYPES = FIELD_TYPES;

const FIELD_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,40}$/;
const MAX_ADMIN_TYPES = 20;
const MAX_FIELDS_PER_TYPE = 40;

export interface ContentTypeValidation {
  ok: boolean;
  defs: ContentTypeDefinition[];
  errors: string[];
}

/**
 * Validate admin-authored definitions, exactly as hard as a hostile manifest.
 *
 * The admin screen is trusted UI, but the STORED VALUE outlives the screen: it
 * can arrive via the settings API, a restore, or a hand edit, so it gets the
 * manifest's discipline — rebuilt field by field, unknown keys dropped, and a
 * bad value named by position rather than silently skipped.
 */
export function validateContentTypeDefinitions(raw: unknown): ContentTypeValidation {
  const errors: string[] = [];
  const defs: ContentTypeDefinition[] = [];
  const push = (m: string) => { errors.push(m); };

  if (!Array.isArray(raw)) {
    return { ok: false, defs: [], errors: ['definitions must be an array'] };
  }
  if (raw.length > MAX_ADMIN_TYPES) {
    return { ok: false, defs: [], errors: [`too many types (max ${MAX_ADMIN_TYPES})`] };
  }

  const seen = new Set<string>();
  raw.forEach((ct: any, i: number) => {
    if (!ct || typeof ct !== 'object') return push(`types[${i}] must be an object`);
    const name = ct.name;
    if (typeof name !== 'string' || !NAME_RE.test(name)) return push(`types[${i}].name must be kebab-case, 2–41 chars`);
    if (RESERVED.has(name)) return push(`types[${i}].name "${name}" is reserved`);
    if (seen.has(name)) return push(`types[${i}].name "${name}" appears twice`);
    seen.add(name);
    if (typeof ct.label !== 'string' || !ct.label.trim()) return push(`types[${i}].label is required`);
    if (ct.visibility !== undefined && ct.visibility !== 'public' && ct.visibility !== 'staff') {
      return push(`types[${i}].visibility must be "public" or "staff"`);
    }
    if (ct.writable !== undefined && ct.writable !== 'public' && ct.writable !== 'staff') {
      return push(`types[${i}].writable must be "public" or "staff"`);
    }
    if (ct.notifyOnSubmission !== undefined && typeof ct.notifyOnSubmission !== 'boolean') {
      return push(`types[${i}].notifyOnSubmission must be true or false`);
    }
    if (ct.moderated !== undefined && typeof ct.moderated !== 'boolean') {
      return push(`types[${i}].moderated must be true or false`);
    }
    if (!Array.isArray(ct.fields) || ct.fields.length === 0) return push(`types[${i}].fields must be a non-empty array`);
    if (ct.fields.length > MAX_FIELDS_PER_TYPE) return push(`types[${i}] has too many fields (max ${MAX_FIELDS_PER_TYPE})`);

    // Steps first: a field naming step 4 has to be checked against a list
    // that exists, or a form ships with a step nobody can reach.
    const steps = buildSteps(ct.steps, `types[${i}]`, push);
    if (steps === null) return;
    const stepCountForType = Math.max(1, steps?.length ?? 1);

    const fields: ContentTypeField[] = [];
    const fseen = new Set<string>();
    // Media fields synthesise <name>_url and <name>_alt on read. A declared
    // field with one of those names would be overwritten by the resolver (and
    // an editor round-trip would then persist the resolved URL over it), so
    // the collision is refused. Collected first because a media field may be
    // declared after its colliding sibling.
    const mediaNames = new Set(
      (ct.fields as { name?: unknown; rule?: { type?: unknown } }[])
        .filter((f) => f?.rule?.type === 'media' && typeof f.name === 'string')
        .map((f) => f.name as string),
    );
    for (let j = 0; j < ct.fields.length; j += 1) {
      const f: any = ct.fields[j];
      if (!f || typeof f !== 'object') return push(`types[${i}].fields[${j}] must be an object`);
      if (typeof f.name !== 'string' || !FIELD_NAME_RE.test(f.name)) return push(`types[${i}].fields[${j}].name is invalid`);
      // Names that collide with Object.prototype members read as "present" off
      // a JSON body even when omitted, and __proto__ reparents a plain result
      // object — both defeat validate()'s absent-check. validate() is now
      // prototype-safe, but refusing these names keeps a definition from ever
      // depending on that, at no cost to any real field.
      if (f.name === '__proto__' || f.name === 'constructor' || f.name === 'prototype') {
        return push(`types[${i}].fields[${j}].name "${f.name}" is reserved`);
      }
      // hp_url and pow_token are the form's own meta-fields: the honeypot and
      // the proof-of-work answer. A declared field of that name would be
      // clobbered by the submission handler (or worse, the honeypot's presence
      // would drop every real entry), so the collision is refused at build time.
      // Set by the server and read as authority. A declared field of this name
      // would let a submitter post their own approval, which is the moderation
      // feature exactly inverted.
      if (f.name === '_status') {
        return push(`types[${i}].fields[${j}].name "_status" is reserved for the approval state`);
      }
      if (f.name === 'hp_url' || f.name === 'pow_token') {
        return push(`types[${i}].fields[${j}].name "${f.name}" is reserved for the form's anti-spam fields`);
      }
      if (fseen.has(f.name)) return push(`types[${i}] field "${f.name}" appears twice`);
      const base = f.name.replace(/_(?:url|alt)$/, '');
      if (base !== f.name && mediaNames.has(base)) {
        return push(`types[${i}] field "${f.name}" collides with the media field "${base}" (which supplies ${base}_url and ${base}_alt on read)`);
      }
      // The set of names declared BEFORE this one, captured before this field
      // joins it. `fseen` is also the duplicate check, so it has to gain the
      // name here — but a condition that could name the field it sits on is a
      // field that never appears, and it reads as correct in the builder.
      const earlier = new Set(fseen);
      fseen.add(f.name);
      const r: any = f.rule;
      // buildFieldRule, shared with the MANIFEST door. It used to be spelled
      // out here and cast over there, so a plugin's rule reached validate()
      // unexamined while an operator's was rebuilt key by key.
      const rule = buildFieldRule(r, `types[${i}].fields[${j}]`, push);
      if (!rule) return;
      // `earlier` holds exactly the fields declared BEFORE this one, which is
      // what makes a showIf cycle impossible rather than merely unlikely.
      const presentation = buildFieldPresentation(f, `types[${i}].fields[${j}]`, stepCountForType, earlier, push);
      if (!presentation) return;
      fields.push({ name: f.name, rule, ...presentation });
    }

    // Annotated with a mapped type over `keyof Required<…>`, which strips the
    // `?` markers and so makes every key REQUIRED TO BE PRESENT while leaving
    // its value's type alone. `manifestContentTypes()` does the same, for the
    // reason recorded there: `visibility` was declared, validated, and then
    // silently dropped by a hand-written copy exactly like this one, and a
    // manifest asking for a public collection registered a private one with
    // nothing anywhere to explain it. Adding a field to
    // `ContentTypeDefinition` and forgetting it here is now a compile error.
    const def: { [K in keyof Required<ContentTypeDefinition>]: ContentTypeDefinition[K] } = {
      name,
      label: String(ct.label).slice(0, 80),
      labelPlural: typeof ct.labelPlural === 'string' ? ct.labelPlural.slice(0, 80) : undefined,
      fields,
      steps,
      visibility: ct.visibility,
      writable: ct.writable,
      notifyOnSubmission: ct.notifyOnSubmission === true ? true : undefined,
      moderated: ct.moderated === true ? true : undefined,
    };
    defs.push(def);
  });

  return { ok: errors.length === 0, defs, errors };
}

/** The settings key admin-defined types persist under. Not world-readable. */
export const ADMIN_CONTENT_TYPES_SETTING = 'custom_content_types';
