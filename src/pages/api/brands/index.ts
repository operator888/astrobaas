import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { validate, slugify, stableHash } from '../../../lib/validate';
import { buildBrandDirectory, normalizeBrand } from '../../../lib/commerce/brand';
import { canManageCatalog } from '../../../lib/auth';
import { projectAll, TRANSLATABLE_TAXONOMY_FIELDS } from '../../../lib/i18n/catalogue-translations';
import { contentLocale } from '../../../lib/i18n/resolve';
import { mediaBaseFor } from '../../../lib/media-base';
import { withPublicCache } from '../../../lib/http-cache';

/**
 * GET /api/brands — public.
 *
 * ## Why this used to return `[]` on a shop full of brands
 *
 * `brands` is a real table with real CRUD, and NOTHING populates it. A product's
 * `brand` is a free-text string typed into the admin form; creating a Brand
 * RECORD needs a hand-rolled POST, and no import path does it. So a shop with
 * 447 products and 62 makers got a 200 and an empty array — and a storefront
 * author built a brands menu against it before noticing it is always empty.
 *
 * An endpoint that answers honestly-but-uselessly is worse than no endpoint:
 * `[]` looks like "this shop has no brands", not like "this table is unused".
 *
 * ## What it returns now
 *
 * The UNION of what the catalogue says and what an operator curated:
 *
 *  - every maker with products, grouped by `brandKey` so `Rayban`, `RAYBAN` and
 *    `Ray-Ban` are ONE entry rather than three;
 *  - plus any curated Brand record, which contributes a logo, a slug and
 *    translations — the things a derived brand cannot have.
 *
 * Each entry carries `count`, so a storefront can render a brands menu or an
 * A–Z page without downloading the whole catalogue to derive them.
 *
 * `count` is a promise about `?brand=`: the number beside a brand is the number
 * of products `GET /api/products?brand=<slug>` returns, because both group by
 * the same key. A listing that grouped differently from the filter would show
 * `Ray-Ban (1)` next to `Rayban (16)` and hand you 17 from either.
 *
 * And the slug is resolved back by the SAME directory that assigned it, not
 * re-folded. Re-folding lost `Straße` (slug `strasse`), every Greek name (slug
 * `gyalia-opsi`) and every curated slug of an operator's choosing (`rb`): the
 * brand was listed with a count, and its link returned nothing.
 *
 * ADDITIVE: `id`, `name`, `slug`, `logo`, `created_at` and `updated_at` are
 * unchanged for curated rows, so a client reading the old shape still works. A
 * DERIVED brand has no `id` and no timestamps — it is not a record, and
 * inventing one would be inventing data.
 */
export const GET: APIRoute = async ({ url, request, locals }) => {
  try {
    await LocalDB.init();
    const brands = await LocalDB.getBrands();
    const locale = contentLocale(null, url.searchParams.get('locale'));

    // ONE directory, shared with `listProducts` and the collection rules: every
    // maker with ACTIVE products (a count that included drafts would send a
    // shopper to a page with fewer products than the menu promised), plus every
    // curated record, one entry per key, each with a unique slug.
    //
    // Identity comes from the STORED records, never the translated ones. Keying
    // on a translated name split a brand in two the moment its name was
    // translated — `Όψη` in Greek, `Opsi` in English — into a count-0 curated
    // entry beside the derived one, both publishing the slug `opsi`.
    const directory = buildBrandDirectory(await LocalDB.getProducts(), brands);
    // Presentation in the locale. Sorted AFTER projecting, and IN the locale:
    // sorting first would order a German list by English names, and
    // `localeCompare` without the locale puts Greek accented letters wrong.
    const localised = new Map(
      projectAll(brands, locale, TRANSLATABLE_TAXONOMY_FIELDS).map((b) => [b.id, b]),
    );

    const out: Record<string, unknown>[] = directory.entries.map((e) => {
      // `spellings` rides along so an operator or an integrator can SEE the
      // variants rather than wonder why one maker was typed four ways.
      if (!e.curated || !e.record) {
        return { name: e.name, slug: e.slug, count: e.count, key: e.key, spellings: e.spellings, curated: false };
      }
      // A curated record WINS on presentation — its name is the one somebody
      // chose deliberately, and it carries the logo and the translations. It
      // does not win on `count`, which is a fact about products.
      const b = e.record;
      return {
        count: e.count,
        key: e.key,
        spellings: e.spellings,
        id: b.id,
        name: localised.get(b.id)?.name ?? b.name,
        slug: e.slug,
        ...(b.logo ? { logo: b.logo } : {}),
        created_at: b.created_at,
        updated_at: b.updated_at,
        curated: true,
      };
    }).sort((a, b) => String(a.name).localeCompare(String(b.name), locale));
    // `logo` is a media path relative to this CMS.
    return withPublicCache(ApiResponseBuilder.success(out, undefined, {
      media_base: await mediaBaseFor(request),
      total: out.length,
      // How many makers exist only as text on products. An operator seeing
      // "62 of 62 uncurated" knows the table is unused; seeing 0 knows it is
      // maintained. The number the old empty array could never convey.
      uncurated: out.filter((b) => !b.curated).length,
    }), { request, locals });
  } catch (err) {
    console.error('Brands list error:', err);
    return ApiResponseBuilder.serverError('Failed to list brands');
  }
};

/** POST /api/brands — create (admin/editor). */
export const POST: APIRoute = async ({ request, locals }) => {
  try {
    await LocalDB.init();
    const session = locals.user;
    if (!session || !canManageCatalog(session.role)) {
      return ApiResponseBuilder.forbidden('Your role cannot manage brands');
    }
    const body = await request.json().catch(() => null);
    const result = validate<{ name: string; slug?: string; logo?: string }>(body, {
      name: { type: 'string', min: 1, max: 120 },
      slug: { type: 'string', min: 1, max: 120, pattern: /^[a-z0-9-]+$/, optional: true },
      logo: { type: 'string', max: 1000, optional: true },
    });
    if (!result.ok) return ApiResponseBuilder.validationError('Invalid brand payload', result.errors);
    // Tidied the same way a product's brand is, so a curated record and the
    // products naming it cannot differ by a trailing space.
    const name = normalizeBrand(result.value.name);
    if (!name) return ApiResponseBuilder.badRequest('A brand needs a name');
    const chosen = result.value.slug;
    const base = chosen || slugify(name);
    const existing = await LocalDB.getBrands();
    // A slug is a promise that `?brand=<slug>` leads to THIS brand. Two ways
    // to break it: a second record for the same maker (a duplicate), or a slug
    // another brand already answers to — a record holding it, a listed brand
    // publishing it, or a brand whose NAME it is (`rb` while RB exists). A
    // curated slug wins in the listing, so the second would silently re-point
    // that brand's links and filters at this record.
    // Drafts included: a brand whose products are not live yet will publish
    // its slug the day they are, and must not lose it to this record now.
    const directory = buildBrandDirectory(await LocalDB.getProducts(), existing, { includeDrafts: true });
    const own = directory.keyOfRecord({ name, slug: base });
    const verdict = (s: string): { duplicate?: true; other?: string } => {
      const holder = existing.find((b) => b.slug === s);
      if (holder && directory.keyOfRecord(holder) === own) return { duplicate: true };
      const other = holder?.name ?? directory.slugTakenBy(s, { name, slug: s })?.name;
      return other ? { other } : {};
    };
    let slug = base;
    let v = verdict(slug);
    if (v.other && !chosen) {
      // Generated rather than chosen: disambiguate exactly as the listing
      // would, and re-check — a double-submitted form must not store the same
      // suffixed slug twice.
      const suffixed = `${base}-${stableHash(own)}`;
      slug = suffixed;
      v = verdict(slug);
      for (let n = 2; v.other; n++) {
        slug = `${suffixed}-${n}`;
        v = verdict(slug);
      }
    }
    if (v.duplicate) {
      return ApiResponseBuilder.badRequest('A brand with that slug already exists');
    }
    if (v.other) {
      return ApiResponseBuilder.badRequest(
        `The slug "${slug}" already leads to the brand "${v.other}". Choose another slug.`,
      );
    }
    const brand = await LocalDB.createBrand({ name, slug, logo: result.value.logo });
    return ApiResponseBuilder.created(brand, 'Brand created');
  } catch (err) {
    console.error('Brand create error:', err);
    return ApiResponseBuilder.serverError('Failed to create brand');
  }
};
