import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { buildCookieDeclaration } from '../../../lib/cookie-declaration';

/**
 * GET /api/consent/cookies — the cookie declaration for THIS install.
 *
 * Public, and it has to be. Both live storefronts are decoupled: they render
 * their own privacy pages and never load `/cookies` from this origin. A
 * declaration only the CMS's own templates could show would be a legal document
 * that exists on the wrong domain — the exact API-path gap this codebase keeps
 * finding, in the one place where the consequence is regulatory rather than
 * cosmetic.
 *
 * Nothing here is sensitive. Every fact in the response is already observable by
 * anyone who opens the site with devtools: which cookies get set, by whom, and
 * for how long. Publishing it in a readable form is the point of the exercise.
 *
 * A provider whose tracking ID is missing or malformed is absent, because it is
 * absent from the page too — `buildCookieDeclaration` re-validates through the
 * same `validateAnalyticsId` that decides whether the script is emitted at all.
 */
export const GET: APIRoute = async () => {
  try {
    await LocalDB.init();
    const settings = await LocalDB.getSettings();
    const d = buildCookieDeclaration(settings as { key: string; value: unknown }[]);
    return ApiResponseBuilder.success(
      {
        cookies: d.all,
        // The caveats travel WITH the data. A storefront that renders the rows
        // and drops these is publishing a completeness claim this CMS did not
        // make — so they are part of the payload, not a note in the docs.
        incomplete: d.incomplete,
        opaque_containers: d.opaqueContainers,
        cookieless_providers: d.providers.filter((p) => p.facts.cookieless).map((p) => p.provider.label),
        vendor_docs: d.providers.map((p) => ({
          provider: p.provider.label,
          url: p.facts.cookieDocsUrl ?? p.provider.helpUrl,
        })),
      },
      'Cookie declaration retrieved successfully',
    );
  } catch (err) {
    console.error('Cookie declaration error:', err);
    return ApiResponseBuilder.serverError('Failed to build the cookie declaration');
  }
};
