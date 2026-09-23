import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { canAuthorPosts } from '../../../lib/auth';
import { locales, defaultLocale } from '../../../lib/i18n';
import { TRANSLATABLE_PRODUCT_FIELDS } from '../../../lib/i18n/catalogue-translations';
import { isCommerceEnabled } from '../../../lib/commerce-service';
import { postGaps, catalogueGaps, partialTranslations } from '../../../lib/i18n/status';
import type { Post, Product } from '../../../core/models';

/**
 * What is still to translate.
 *
 * Open to any staff member who can write content, not just admins: the person
 * who actually does the translating is usually an editor or an author, and a
 * backlog only they cannot see is a backlog nobody works through.
 *
 * There is nothing sensitive here — titles and counts of the site's own
 * content — but it is not public either, because an unfinished translation is
 * a work-in-progress and a list of them is a map of what is not ready.
 */
export const prerender = false;

export const GET: APIRoute = async ({ locals }) => {
  try {
    if (!locals.user) return ApiResponseBuilder.unauthorized();
    if (!canAuthorPosts(locals.user.role)) {
      return ApiResponseBuilder.forbidden('Your role cannot see the translation backlog');
    }
    await LocalDB.init();

    const all = locales();
    const base = defaultLocale();

    const posts = (await LocalDB.getPosts()) as Post[];
    // Products live behind the commerce switch. On a site that is not a shop,
    // reading them would report a catalogue backlog for a catalogue that does
    // not exist — the comment now matches the code: an empty list when the
    // shop is off.
    const products = (await isCommerceEnabled())
      ? (await LocalDB.getProducts()) as Product[]
      : [];

    return ApiResponseBuilder.success({
      defaultLocale: base,
      locales: all,
      posts: postGaps(posts, all, base),
      products: catalogueGaps(products, all, base),
      partial: partialTranslations(products, all, base, TRANSLATABLE_PRODUCT_FIELDS),
    });
  } catch (err) {
    console.error('Translation status error:', err);
    return ApiResponseBuilder.serverError('Failed to work out the translation status');
  }
};
