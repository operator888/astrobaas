/**
 * Fields a MERCHANT declares on their products.
 *
 * ## Reusing the field vocabulary, not inventing a third one
 *
 * A product field is the same idea as a content-type field and a declared
 * setting: a name and a `FieldRule`. So this reuses `ContentTypeField` and
 * `buildFieldRule`, exactly as `core/setting-groups.ts` already does — and that
 * file says why in its own words: a parallel list of field types "is the
 * sibling gap that lost `ref` and `media` from the manifest door for months".
 * This is the third owner of one vocabulary, and a kind added to the builder is
 * available to all three by construction.
 *
 * ## Why a product is NOT a content type
 *
 * The obvious alternative is `registerContentType('product', …)`, and it is
 * wrong. `product` is a reserved name, and a Product is a first-class row with
 * derived pricing, stock reservation, slug uniqueness, order lines pointing at
 * it and a shared writable allow-list. Custom entities are validated as a whole
 * record in a generic collection. What is reused here is the FIELD layer; the
 * ENTITY layer stays exactly where it is.
 *
 * ## Where the values live, and why there is only one bag
 *
 * Values go in `Product.custom`, one object. The tempting alternative — a
 * public bag and a private bag, the way declared settings use a `public_`
 * key prefix — fails OPEN at the worst moment: flip a field from public to
 * private and its value sits in the public bag until someone re-saves every
 * product. One bag plus a read-time projection driven by the definitions fails
 * CLOSED, because the very next read stops publishing it.
 *
 * NOT `Product.attributes`. Those are variant AXES: `ProductVariant.options`
 * keys into them and `OrderItem.variant_options` freezes copies at purchase.
 * Putting merchant metadata there would invent phantom variant axes and make
 * every variable product unbuyable.
 */
import type { ContentTypeField } from './content-types';
import type { FieldRule } from '../lib/validate';
import { buildFieldRule } from './field-rule-build';

/** Stored in one setting. Passes the existing SAFE_KEY guard unchanged. */
export const PRODUCT_FIELDS_SETTING = 'product_fields';

/** The same ceiling a content type gets. A catalogue form beyond this is a form nobody fills in. */
export const MAX_PRODUCT_FIELDS = 40;

const FIELD_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,40}$/;

/**
 * Names a merchant may not take.
 *
 * There is no technical collision — values are nested under `custom` — so this
 * exists for a human reason: a second `sku` that never appears in the SKU
 * column, never exports, and never matches a barcode scan is worse than being
 * told the name is taken.
 */
const RESERVED_NAMES = new Set([
  'id', 'name', 'slug', 'sku', 'gtin', 'description', 'short_description',
  'price_cents', 'regular_price_cents', 'sale_price_cents', 'on_sale',
  'stock', 'in_stock', 'categories', 'brand', 'images', 'attributes',
  'variants', 'type', 'status', 'tags', 'weight_grams', 'custom',
  'created_at', 'updated_at', 'i18n',
  // Prototype-pollution names. `validate.ts` is prototype-safe, but a
  // definition must not lean on that.
  '__proto__', 'constructor', 'prototype',
]);

export interface ProductFieldDef extends ContentTypeField {
  /** Human label for the admin form. Falls back to the name. */
  label?: string;
  /** One line under the input. */
  help?: string;
  /**
   * Who may read the VALUE. **Absent means staff**, and the word must be exactly
   * `'public'` — a typo fails closed.
   *
   * Deny-by-default matters more here than almost anywhere else in the product:
   * the field a merchant is most likely to add first is a cost price.
   */
  visibility?: 'public' | 'staff';
}

export interface ProductFieldValidation {
  ok: boolean;
  fields: ProductFieldDef[];
  errors: string[];
}

/** True only for the exact word. Anything else — including 'Public' — is staff. */
export function productFieldIsPublic(f: ProductFieldDef | undefined): boolean {
  return f?.visibility === 'public';
}

/**
 * Rebuild the stored definitions, key by key.
 *
 * Never a cast. The mapped type on `built` below means that adding a key to
 * `ProductFieldDef` and forgetting it here is a COMPILE error rather than a
 * field that silently never round-trips — the same guard
 * `validateSettingGroups` uses.
 */
export function validateProductFieldDefs(raw: unknown): ProductFieldValidation {
  const errors: string[] = [];
  const push = (m: string) => { errors.push(m); };
  const fields: ProductFieldDef[] = [];

  if (raw === null || raw === undefined || raw === '') return { ok: true, fields: [], errors: [] };
  if (!Array.isArray(raw)) return { ok: false, fields: [], errors: ['product fields must be an array'] };
  if (raw.length > MAX_PRODUCT_FIELDS) {
    return { ok: false, fields: [], errors: [`too many product fields (max ${MAX_PRODUCT_FIELDS})`] };
  }

  const seen = new Set<string>();
  raw.forEach((f: unknown, i: number) => {
    if (!f || typeof f !== 'object' || Array.isArray(f)) return push(`fields[${i}] must be an object`);
    const def = f as Record<string, unknown>;

    const name = def.name;
    if (typeof name !== 'string' || !FIELD_NAME_RE.test(name)) {
      return push(`fields[${i}].name must start with a letter or underscore and be 1-41 chars`);
    }
    if (seen.has(name)) return push(`fields[${i}].name "${name}" appears twice`);
    if (RESERVED_NAMES.has(name)) {
      return push(`fields[${i}].name "${name}" is already a product field`);
    }
    seen.add(name);

    const rule = buildFieldRule(def.rule, `fields[${i}]`, push);
    if (!rule) return;
    if (rule.type === 'file') {
      // `file` means a private upload from a stranger through a public form,
      // resolved through readPrivateFileMeta. A product is not a public form,
      // and a product image belongs in the gallery.
      return push(`fields[${i}]: a file upload belongs on a public form, not on a product — use "media"`);
    }

    if (def.visibility !== undefined && def.visibility !== 'public' && def.visibility !== 'staff') {
      // Named rather than silently coerced: a mis-spelled visibility that
      // defaulted quietly would be a staff-only cost price on a public page.
      return push(`fields[${i}].visibility must be exactly "public" or "staff"`);
    }

    const built: { [K in keyof Required<ProductFieldDef>]: ProductFieldDef[K] } = {
      name,
      rule,
      label: typeof def.label === 'string' && def.label.trim()
        ? def.label.trim().slice(0, 80) : undefined,
      help: typeof def.help === 'string' && def.help.trim()
        ? def.help.trim().slice(0, 200) : undefined,
      visibility: def.visibility === 'public' ? 'public' : undefined,
      // Inherited from ContentTypeField. Neither is meaningful on a product
      // form — there are no steps and no conditional reveal here — so they are
      // dropped rather than carried as decoration that implies behaviour.
      step: undefined,
      showIf: undefined,
    };
    // Drop the undefined keys so a stored definition is the minimum that
    // describes it, and two equal definitions serialise identically.
    const clean = Object.fromEntries(
      Object.entries(built).filter(([, v]) => v !== undefined),
    ) as unknown as ProductFieldDef;
    fields.push(clean);
  });

  return { ok: errors.length === 0, fields: errors.length ? [] : fields, errors };
}

export interface MergedProductFieldDefs {
  /** Merchant fields a plugin does not shadow, in their order, then the plugin fields. */
  fields: ProductFieldDef[];
  /** Names provided by a plugin. The merchant editor shows these read-only. */
  managed: Set<string>;
  /** Why a plugin definition was dropped. For the log, never for a buyer. */
  errors: string[];
  /**
   * Names a plugin declares that the merchant already defined themselves. The
   * merchant's field wins, the plugin's is inactive, and the settings screen
   * says so — a clash that is only in the server log is a clash nobody fixes.
   */
  conflicts: string[];
}

/**
 * The merchant's fields plus the ones active plugins declare through
 * `PLUGIN_HOOKS.PRODUCT_FIELD_DEFS`.
 *
 * Plugin definitions come through the SAME door as the merchant's —
 * `validateProductFieldDefs`, one definition at a time — so a plugin gets the
 * same vocabulary, the same reserved names and the same fail-closed visibility,
 * and nothing it sends can be more than a merchant could have typed.
 *
 * One at a time because the failure modes differ. A merchant saving a list
 * wants the whole list refused and every reason shown; a plugin is code the
 * merchant cannot edit, and one malformed definition in it must not take the
 * merchant's own fields — or the plugin's other fields — down with it. The bad
 * one is dropped and reported; the rest stand.
 *
 * On a name collision the MERCHANT wins, and the plugin's field is inactive.
 * Letting the plugin win looked natural (its code depends on its rule) and is
 * a leak: the merchant's field may be staff-only, holding values somebody
 * typed as private notes, and the plugin's definition would re-declare those
 * stored values public — or re-type them so every product carrying one stops
 * saving. Installing a plugin must never change what an existing field
 * publishes. The clash is reported in `conflicts`; the merchant resolves it by
 * renaming or removing their own field, knowingly.
 *
 * Anything that is not an array — a filter that returned nothing, a plugin
 * that returned an object — is treated as no plugin fields.
 */
export function mergeProductFieldDefs(
  merchant: readonly ProductFieldDef[],
  pluginRaw: unknown,
): MergedProductFieldDefs {
  const errors: string[] = [];
  const plugin: ProductFieldDef[] = [];
  const managed = new Set<string>();
  const conflicts: string[] = [];
  const merchantNames = new Set(merchant.map((f) => f.name));

  if (pluginRaw !== undefined && pluginRaw !== null && !Array.isArray(pluginRaw)) {
    errors.push('plugin product fields must be an array; ignored');
  }
  const raw: unknown[] = Array.isArray(pluginRaw) ? pluginRaw : [];

  raw.forEach((def, i) => {
    const label = `plugin fields[${i}]`;
    if (plugin.length >= MAX_PRODUCT_FIELDS) {
      errors.push(`${label}: more than ${MAX_PRODUCT_FIELDS} plugin product fields; dropped`);
      return;
    }
    const one = validateProductFieldDefs([def]);
    if (!one.ok || one.fields.length !== 1) {
      for (const e of one.errors) errors.push(e.replace(/^fields\[0\]/, label));
      return;
    }
    const f = one.fields[0];
    if (managed.has(f.name)) {
      // Two plugins claiming one name: the first registered keeps it, and the
      // second is told, rather than one silently reinterpreting the other's data.
      errors.push(`${label}.name "${f.name}" is already provided by another plugin; dropped`);
      return;
    }
    if (merchantNames.has(f.name)) {
      if (!conflicts.includes(f.name)) conflicts.push(f.name);
      errors.push(`${label}.name "${f.name}" is already one of the shop's own product fields; the shop's field is kept and the plugin's is not active`);
      return;
    }
    managed.add(f.name);
    plugin.push(f);
  });

  return { fields: [...merchant, ...plugin], managed, errors, conflicts };
}

/**
 * What a merchant's save of the definition list actually stores.
 *
 * `submitted` is the already-validated list from the editor. A submitted name
 * a plugin currently provides is REFUSED, by name — the editor shows it
 * read-only, so one arriving here is a stale form or a script, and dropping it
 * quietly would report "saved" for a row that was not.
 *
 * (A merchant field that CLASHES with a plugin's is not in `managed` — the
 * merchant's wins — so it stays editable and is stored like any other.)
 */
export function planMerchantProductFieldSave(
  submitted: readonly ProductFieldDef[],
  managed: ReadonlySet<string>,
): ProductFieldValidation & { taken: string[] } {
  const taken = submitted.filter((f) => managed.has(f.name)).map((f) => f.name);
  if (taken.length) {
    return {
      ok: false,
      fields: [],
      taken,
      errors: taken.map((n) => `"${n}" is provided by a plugin and cannot be defined here`),
    };
  }
  return { ok: true, fields: [...submitted], errors: [], taken };
}

/** The validator schema for the `custom` bag, from the declared fields. */
export function schemaForProductFields(fields: readonly ProductFieldDef[]): Record<string, FieldRule> {
  const schema: Record<string, FieldRule> = {};
  for (const f of fields) schema[f.name] = f.rule;
  return schema;
}

/**
 * Strip a product's custom bag down to what an anonymous caller may see.
 *
 * Definition-driven and deny-by-default: a value whose field is not declared,
 * or is declared staff-only, does not appear. An UNDECLARED key is dropped from
 * the public view but LEFT IN STORAGE by the write path — deleting a definition
 * must not destroy the data somebody spent an afternoon entering.
 */
export function publicCustomFields(
  custom: Record<string, unknown> | undefined,
  fields: readonly ProductFieldDef[],
): Record<string, unknown> | undefined {
  if (!custom) return undefined;
  const allowed = new Set(fields.filter(productFieldIsPublic).map((f) => f.name));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(custom)) {
    if (allowed.has(k)) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}
