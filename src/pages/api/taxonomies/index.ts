import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { recordAudit, AUDIT } from '../../../lib/audit';
import {
  TAXONOMIES_SETTING, TERM_COLLECTION, validateTaxonomies,
  termSlug, isTermSlug, getTaxonomy, termCounts,
} from '../../../core/taxonomy';
import { canAuthorPosts } from '../../../lib/auth';

export const prerender = false;

/**
 * GET    /api/taxonomies                   — definitions (+ terms, + counts)
 * PUT    /api/taxonomies                   — replace the definitions
 * POST   /api/taxonomies?taxonomy=brand    — add a term
 * DELETE /api/taxonomies?taxonomy=…&term=… — remove a term
 *
 * ## Definitions are admin, terms are editorial
 *
 * Adding "Ray-Ban" is something whoever stocks the shelves does every week.
 * Adding a whole taxonomy changes what every editor sees on every record, and
 * is closer to changing a content type — which is already admin-only for the
 * same reason.
 *
 * ## Nothing here is destructive
 *
 * Removing a term deletes its record and leaves every assignment alone. A post
 * still carrying it degrades to nothing — `cleanTerms` drops a slug with no
 * definition behind it — rather than the delete rewriting four hundred posts,
 * which is a migration disguised as a button. Re-creating the term brings the
 * assignments straight back, which is the behaviour an operator who deleted the
 * wrong row needs.
 */

const isAdmin = (locals: App.Locals) => locals.user?.role === 'admin';

async function readDefs(): Promise<ReturnType<typeof validateTaxonomies>['defs']> {
  return validateTaxonomies((await LocalDB.getSetting(TAXONOMIES_SETTING))?.value).defs;
}

export const GET: APIRoute = async ({ url, locals }) => {
  try {
    if (!locals.user) return ApiResponseBuilder.unauthorized();
    await LocalDB.init();
    const defs = await readDefs();
    const stored = await LocalDB.getCustomEntities(TERM_COLLECTION);
    const terms = stored.map((r: any) => ({ id: r.id, ...(r.data ?? {}) }));

    // Counts are computed against ONE collection at a time: "how many posts"
    // and "how many products" are different questions, and a single number
    // adding them together answers neither.
    const collection = new URL(url).searchParams.get('collection') ?? '';
    let counts: Record<string, Record<string, number>> = {};
    if (collection === 'post' || collection === 'page') {
      const posts = await LocalDB.getPosts();
      const rows = posts.filter((p: any) => ((p.kind ?? 'post') === collection));
      counts = Object.fromEntries(defs.map((d) => [d.slug, termCounts(rows, d.slug)]));
    } else if (collection) {
      const rows = await LocalDB.getCustomEntities(collection);
      counts = Object.fromEntries(defs.map((d) => [d.slug, termCounts(rows.map((r: any) => r.data ?? {}), d.slug)]));
    }

    return ApiResponseBuilder.success({ taxonomies: defs, terms, counts }, 'Taxonomies');
  } catch (err) {
    console.error('Taxonomy read error:', err);
    return ApiResponseBuilder.serverError('Could not read the taxonomies');
  }
};

export const PUT: APIRoute = async ({ request, locals }) => {
  try {
    if (!isAdmin(locals)) return ApiResponseBuilder.forbidden('Only an admin can define taxonomies');
    await LocalDB.init();
    const body = await request.json().catch(() => null) as { taxonomies?: unknown } | null;

    // The WHOLE set, because two of the rules — duplicate slugs, the count
    // bound — are properties of the set and a patch cannot express a removal.
    const checked = validateTaxonomies(body?.taxonomies);
    if (!checked.ok) return ApiResponseBuilder.badRequest(checked.errors.join('; '));

    await LocalDB.updateSetting(TAXONOMIES_SETTING, checked.defs);
    // Audited for the same reason a content-type change is: it alters what
    // every editor sees on every record, without a deploy.
    recordAudit(AUDIT.TAXONOMIES_UPDATE, {
      actor: locals.user!.id,
      target: TAXONOMIES_SETTING,
      metadata: { count: checked.defs.length, slugs: checked.defs.map((d) => d.slug) },
    });
    return ApiResponseBuilder.success({ taxonomies: checked.defs }, 'Taxonomies saved');
  } catch (err) {
    console.error('Taxonomy write error:', err);
    return ApiResponseBuilder.serverError('Could not save the taxonomies');
  }
};

export const POST: APIRoute = async ({ request, url, locals }) => {
  try {
    if (!locals.user) return ApiResponseBuilder.unauthorized();
    // Whoever may write content may add a term: it is the same act as typing a
    // category, and gating it on admin would mean the person stocking shelves
    // has to ask somebody else to add a brand.
    if (!canAuthorPosts(locals.user.role)) {
      return ApiResponseBuilder.forbidden('Your role cannot add terms');
    }
    await LocalDB.init();
    const defs = await readDefs();

    const body = await request.json().catch(() => null) as { taxonomy?: unknown; name?: unknown; slug?: unknown; description?: unknown } | null;
    const taxonomy = String(body?.taxonomy ?? new URL(url).searchParams.get('taxonomy') ?? '').trim();
    const def = getTaxonomy(defs, taxonomy);
    if (!def) return ApiResponseBuilder.notFound('Taxonomy');

    const name = String(body?.name ?? '').trim();
    if (!name) return ApiResponseBuilder.badRequest('A term needs a name');
    // The operator may supply a slug; otherwise it is derived by the SAME
    // function the admin form uses, so a term added either way is stored once.
    const slug = String(body?.slug ?? '').trim() || termSlug(name);
    if (!isTermSlug(slug)) {
      // A name in a script the slug rule does not cover — Chinese, Japanese,
      // Korean, Arabic — reduces to nothing. That is a real limitation, and the
      // message says so and says what to do, rather than quoting an empty
      // string back at somebody who did nothing wrong.
      return slug
        ? ApiResponseBuilder.badRequest(`"${slug}" is not a usable slug — lowercase letters, digits and hyphens (Greek and Cyrillic are fine).`)
        : ApiResponseBuilder.badRequest(`"${name}" does not produce a usable web address. Supply a "slug" of your own — letters, digits and hyphens.`);
    }

    const existing = await LocalDB.getCustomEntities(TERM_COLLECTION);
    if (existing.some((r: any) => r.data?.taxonomy === taxonomy && r.data?.slug === slug)) {
      // Idempotent rather than an error: two editors adding "Ray-Ban" at the
      // same moment is normal, and the second must not see a failure.
      return ApiResponseBuilder.success({ taxonomy, slug, name }, 'That term already exists');
    }

    await LocalDB.createCustomEntity(TERM_COLLECTION, {
      taxonomy,
      slug,
      name: name.slice(0, 80),
      description: String(body?.description ?? '').trim().slice(0, 300) || undefined,
    });
    return ApiResponseBuilder.created({ taxonomy, slug, name }, 'Term added');
  } catch (err) {
    console.error('Term create error:', err);
    return ApiResponseBuilder.serverError('Could not add that term');
  }
};

export const DELETE: APIRoute = async ({ url, locals }) => {
  try {
    if (!isAdmin(locals)) return ApiResponseBuilder.forbidden('Only an admin can remove terms');
    await LocalDB.init();
    const params = new URL(url).searchParams;
    const taxonomy = String(params.get('taxonomy') ?? '').trim();
    const slug = String(params.get('term') ?? '').trim();
    if (!taxonomy || !slug) return ApiResponseBuilder.badRequest('taxonomy and term are required');

    const existing = await LocalDB.getCustomEntities(TERM_COLLECTION);
    const match = existing.find((r: any) => r.data?.taxonomy === taxonomy && r.data?.slug === slug);
    if (!match) return ApiResponseBuilder.notFound('Term');

    // The record only. Assignments are deliberately left in place — see the
    // note at the top of this file.
    await LocalDB.deleteCustomEntity(TERM_COLLECTION, match.id);
    return ApiResponseBuilder.success({ taxonomy, slug }, 'Term removed');
  } catch (err) {
    console.error('Term delete error:', err);
    return ApiResponseBuilder.serverError('Could not remove that term');
  }
};
