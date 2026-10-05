import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { getProductFieldDefsWithSource } from '../../../lib/commerce-service';
import {
  PRODUCT_FIELDS_SETTING, validateProductFieldDefs, productFieldIsPublic,
  planMerchantProductFieldSave,
} from '../../../core/product-fields-def';
import { recordAudit, AUDIT } from '../../../lib/audit';

/**
 * The fields this merchant declared on their products.
 *
 * GET is PUBLIC and returns **only the fields marked public** — no values, no
 * private field NAMES, and no count of how many were withheld. A headless
 * storefront needs the schema to render "Frame width: 52mm" with a label and a
 * type; it does not need to know the shop also tracks a cost price, and a
 * disclosed name is a disclosed business fact.
 *
 * This is why the staff `/api/content-types` could not simply be reused for its
 * sibling problem either — `/api/forms/[type]` exists for the same reason and
 * says so.
 *
 * The list includes fields active plugins declare (PLUGIN_HOOKS.PRODUCT_FIELD_DEFS).
 * Staff see those marked `managed: true`, because the settings editor must
 * show them read-only; a public caller sees no flag and no difference — which
 * fields a shop's plugins add is not a storefront's business.
 *
 * PUT is ADMIN. It replaces the whole MERCHANT definition list. Plugin fields
 * are not the merchant's to edit, so a submitted name a plugin currently
 * provides is refused by name rather than silently dropped.
 */
export const prerender = false;

export const GET: APIRoute = async ({ locals }) => {
  try {
    await LocalDB.init();
    const { fields: all, managed, conflicts } = await getProductFieldDefsWithSource();
    const isStaff = !!locals.user;

    // Staff see everything including the staff-only declarations — the admin
    // product form has to render them. Anonymous callers see the public half.
    const fields = (isStaff ? all : all.filter(productFieldIsPublic)).map((f) => ({
      name: f.name,
      label: f.label ?? f.name,
      help: f.help,
      rule: f.rule,
      ...(isStaff ? { visibility: f.visibility ?? 'staff' } : {}),
      ...(isStaff && managed.has(f.name) ? { managed: true } : {}),
    }));

    // Staff also learn which of their own field names a plugin wanted: theirs
    // is kept and the plugin's is inactive until they rename or remove it.
    return ApiResponseBuilder.success(isStaff ? { fields, conflicts } : { fields });
  } catch (err) {
    console.error('Product fields list error:', err);
    return ApiResponseBuilder.serverError('Failed to load product fields');
  }
};

export const PUT: APIRoute = async ({ request, locals }) => {
  try {
    await LocalDB.init();
    if (locals.user?.role !== 'admin') return ApiResponseBuilder.forbidden('Admin only');

    const body = await request.json().catch(() => null);
    const incoming = (body as { fields?: unknown })?.fields;

    const result = validateProductFieldDefs(incoming);
    if (!result.ok) {
      // Every reason, not just the first. An admin fixing a ten-field
      // definition one error per round trip is a screen nobody uses twice.
      return ApiResponseBuilder.validationError(
        'Invalid product field definitions',
        Object.fromEntries(result.errors.map((e, i) => [String(i), e])),
      );
    }

    // Plugin-owned names are refused by name. See planMerchantProductFieldSave.
    const { managed } = await getProductFieldDefsWithSource();
    const toStore = planMerchantProductFieldSave(result.fields, managed);
    if (!toStore.ok) {
      return ApiResponseBuilder.validationError(
        'Invalid product field definitions',
        Object.fromEntries(toStore.errors.map((e, i) => [String(i), e])),
      );
    }

    await LocalDB.updateSetting(PRODUCT_FIELDS_SETTING, toStore.fields);

    recordAudit(AUDIT.PRODUCT_FIELDS_UPDATE, {
      actor: locals.user?.id,
      target: PRODUCT_FIELDS_SETTING,
      metadata: {
        count: result.fields.length,
        // WHICH fields are public is the security-relevant half of this change,
        // so the trail names them rather than counting them.
        public: result.fields.filter(productFieldIsPublic).map((f) => f.name),
      },
    });

    return ApiResponseBuilder.success({ fields: result.fields }, 'Product fields saved');
  } catch (err) {
    console.error('Product fields save error:', err);
    return ApiResponseBuilder.serverError('Failed to save product fields');
  }
};
