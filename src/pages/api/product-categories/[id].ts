import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { validate } from '../../../lib/validate';
import { canManageCatalog } from '../../../lib/auth';
import { parentProblem } from '../../../lib/commerce/category-tree';
import { recordAudit, AUDIT } from '../../../lib/audit';
import { saveProduct } from '../../../lib/commerce-service';

export const prerender = false;

/**
 * Edit and delete one product category.
 *
 * Storage has had `updateProductCategory` and `deleteProductCategory` all
 * along; nothing exposed them. So a category, once created, could not be
 * renamed, moved under another, reordered or removed — from the admin or from
 * the API — and the product form's "create them under Categories" pointed at
 * the BLOG categories screen. /admin/product-categories is built on these two.
 *
 * ## The slug does not change
 *
 * Products hold their categories by SLUG. Renaming a slug would silently empty
 * the category of every product in it, and change its storefront URL. The
 * NAME changes freely; a slug is fixed once created. To change one, create the
 * new category and delete the old — which untags, never deletes, products.
 */

type Update = { name?: string; parent_slug?: string | null; position?: number; slug?: string };

/** PUT /api/product-categories/[id] — rename, move, reorder. */
export const PUT: APIRoute = async ({ params, request, locals }) => {
  try {
    if (!canManageCatalog(locals.user?.role)) {
      return ApiResponseBuilder.forbidden('Your role cannot manage product categories');
    }
    await LocalDB.init();
    const all = await LocalDB.getProductCategories();
    const existing = all.find((c) => c.id === params.id);
    if (!existing) return ApiResponseBuilder.notFound('Product category');

    const body = await request.json().catch(() => null);
    // `parent_slug: null` means "move to the top level", so it is let through
    // the schema as an empty string and read that way below.
    const raw = body && typeof body === 'object' ? { ...(body as Record<string, unknown>) } : body;
    if (raw && typeof raw === 'object' && (raw as Update).parent_slug === null) (raw as Update).parent_slug = '';
    const result = validate<Update>(raw, {
      name: { type: 'string', min: 1, max: 120, optional: true },
      parent_slug: { type: 'string', max: 120, optional: true },
      position: { type: 'number', min: -100000, max: 100000, optional: true },
      slug: { type: 'string', max: 120, optional: true },
    });
    if (!result.ok) return ApiResponseBuilder.validationError('Invalid category payload', result.errors);
    const b = result.value;

    if (b.slug !== undefined && b.slug !== existing.slug) {
      return ApiResponseBuilder.badRequest(
        'A category\'s slug cannot be changed — products are filed under it. Rename it instead, or create a new category and delete this one.',
      );
    }

    const updates: Partial<typeof existing> = {};
    if (b.name !== undefined) {
      if (!b.name.trim()) return ApiResponseBuilder.badRequest('A category needs a name');
      updates.name = b.name.trim();
    }
    if (b.position !== undefined) updates.position = Math.trunc(b.position);
    if (b.parent_slug !== undefined) {
      const parent = (b.parent_slug ?? '').trim() || undefined;
      const problem = parentProblem(existing.slug, parent, all);
      if (problem) return ApiResponseBuilder.badRequest(problem);
      updates.parent_slug = parent;
    }
    if (Object.keys(updates).length === 0) return ApiResponseBuilder.badRequest('Nothing to change');

    const updated = await LocalDB.updateProductCategory(existing.id, updates);
    if (!updated) return ApiResponseBuilder.notFound('Product category');
    recordAudit(AUDIT.PRODUCT_CATEGORY_UPDATE, {
      actor: locals.user?.id ?? 'unknown',
      target: existing.id,
      ip: locals.ip,
      metadata: { slug: existing.slug, ...updates },
    });
    return ApiResponseBuilder.success(updated, 'Product category updated');
  } catch (err) {
    console.error('Product category update error:', err);
    return ApiResponseBuilder.serverError('Failed to update product category');
  }
};

/**
 * DELETE /api/product-categories/[id]
 *
 * Refused while the category has subcategories: deleting a parent would either
 * orphan them or silently delete a branch of the catalogue, and neither is
 * something to do without being asked. Products in it are UNTAGGED, never
 * deleted — the response says how many, so the admin can tell the operator.
 */
export const DELETE: APIRoute = async ({ params, locals }) => {
  try {
    if (!canManageCatalog(locals.user?.role)) {
      return ApiResponseBuilder.forbidden('Your role cannot manage product categories');
    }
    await LocalDB.init();
    const all = await LocalDB.getProductCategories();
    const existing = all.find((c) => c.id === params.id);
    if (!existing) return ApiResponseBuilder.notFound('Product category');

    const children = all.filter((c) => c.parent_slug === existing.slug);
    if (children.length) {
      return ApiResponseBuilder.error(
        409,
        `"${existing.name}" has ${children.length} subcategor${children.length === 1 ? 'y' : 'ies'}. Move or delete ${children.length === 1 ? 'it' : 'them'} first.`,
      );
    }

    /*
     * Untag through saveProduct, not a raw storage write, so each change is a
     * normal product save: the after-save hooks run, `product.updated`
     * webhooks fire and the audit log records it. A search index or a
     * storefront that rebuilds on those events would otherwise keep listing
     * products under a category that no longer exists.
     *
     * Re-read per product rather than from one early snapshot, so a product
     * saved by someone else meanwhile keeps their edit — only the slug goes.
     * The category row is deleted LAST: if an untag fails, the category is
     * still there and the delete can simply be repeated.
     */
    let untagged = 0;
    const tagged = (await LocalDB.getProducts()).filter((p) => (p.categories ?? []).includes(existing.slug));
    for (const { id } of tagged) {
      const fresh = await LocalDB.getProduct(id);
      const cats = fresh?.categories ?? [];
      if (!fresh || !cats.includes(existing.slug)) continue;
      const saved = await saveProduct({ categories: cats.filter((s) => s !== existing.slug) }, id, String(locals.user?.id ?? 'unknown'));
      if (!saved.ok) {
        return ApiResponseBuilder.error(saved.status ?? 500, `Could not remove "${existing.name}" from a product (${saved.message}). The category was not deleted; try again.`);
      }
      untagged++;
    }
    await LocalDB.deleteProductCategory(existing.id);
    recordAudit(AUDIT.PRODUCT_CATEGORY_DELETE, {
      actor: locals.user?.id ?? 'unknown',
      target: existing.id,
      ip: locals.ip,
      metadata: { slug: existing.slug, name: existing.name, untagged },
    });
    return ApiResponseBuilder.success(
      { id: existing.id, untagged },
      untagged
        ? `Deleted. ${untagged} product${untagged === 1 ? ' was' : 's were'} in it and ${untagged === 1 ? 'is' : 'are'} now uncategorised there — nothing else about ${untagged === 1 ? 'it' : 'them'} changed.`
        : 'Deleted.',
    );
  } catch (err) {
    console.error('Product category delete error:', err);
    return ApiResponseBuilder.serverError('Failed to delete product category');
  }
};
