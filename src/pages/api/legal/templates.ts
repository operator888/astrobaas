import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { sanitizeHtml } from '../../../lib/sanitize';
import { isKnownLocale, defaultLocale } from '../../../lib/i18n';
import { isReservedSlug } from '../../../lib/reserved-slugs';
import { pagesOnly } from '../../../lib/post-kind';
import { recordAudit, AUDIT } from '../../../lib/audit';
import { resolveCommerceEnabled } from '../../../lib/commerce-settings';
import {
  LEGAL_TEMPLATES, LEGAL_TEMPLATE_LOCALES, getLegalTemplate, renderLegalTemplate,
  type LegalTemplateLocale,
} from '../../../lib/legal/templates';

/**
 * The legal-template library: list what can be activated, and activate one.
 *
 * Activation is CREATING A DRAFT PAGE — nothing more magical, on purpose.
 * The operator's trader details are substituted in (missing ones become
 * visible [fill in] markers), the body goes through the same sanitizer as
 * every page save, and the result lands in the normal posts editor for
 * review. It is a draft because a legal text nobody read before publishing
 * is a liability with a byline; the screen says so too.
 *
 * Locale versions of one template are linked into the standard translation
 * set (`translation_of` → the first activation), so hreflang and the
 * language switcher treat them as the same document — which they are.
 *
 * Admin-only: these pages speak for the business.
 */
export const prerender = false;

async function settingsMap(): Promise<Record<string, unknown>> {
  const rows = await LocalDB.getSettings();
  const map: Record<string, unknown> = {};
  for (const r of rows) map[r.key] = r.value;
  return map;
}

export const GET: APIRoute = async ({ locals }) => {
  try {
    const user = locals.user;
    if (!user || user.role !== 'admin') return ApiResponseBuilder.forbidden();
    await LocalDB.init();
    const map = await settingsMap();
    const commerceOn = resolveCommerceEnabled(map);
    const pages = pagesOnly(await LocalDB.getPosts()).filter((p) => p.status !== 'trashed');

    const data = LEGAL_TEMPLATES
      .filter((t) => commerceOn || !t.commerceOnly)
      .map((t) => ({
        id: t.id,
        label: t.label,
        commerce_only: !!t.commerceOnly,
        locales: LEGAL_TEMPLATE_LOCALES.map((loc) => {
          const rendered = renderLegalTemplate(t.id, loc, map);
          const existing = pages.find((p) => p.slug === t.locales[loc].slug);
          return {
            locale: loc,
            title: t.locales[loc].title,
            slug: t.locales[loc].slug,
            activated: existing ? { id: existing.id, status: existing.status } : null,
            missing: rendered?.missing ?? [],
          };
        }),
      }));
    return ApiResponseBuilder.success(data);
  } catch (err) {
    console.error('Legal templates list error:', err);
    return ApiResponseBuilder.serverError('Could not list legal templates');
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const user = locals.user;
    if (!user || user.role !== 'admin') return ApiResponseBuilder.forbidden();
    await LocalDB.init();

    const body = await request.json().catch(() => null);
    const id = String((body as any)?.id ?? '');
    const locale = String((body as any)?.locale ?? '');

    const template = getLegalTemplate(id);
    if (!template) return ApiResponseBuilder.badRequest('Unknown template');
    if (!(LEGAL_TEMPLATE_LOCALES as readonly string[]).includes(locale)) {
      return ApiResponseBuilder.badRequest('This template has no text in that language');
    }
    if (!isKnownLocale(locale) && locale !== defaultLocale()) {
      return ApiResponseBuilder.badRequest('This site does not serve that language');
    }

    const map = await settingsMap();
    if (template.commerceOnly && !resolveCommerceEnabled(map)) {
      return ApiResponseBuilder.badRequest('This template is for shops — turn commerce on first');
    }

    const rendered = renderLegalTemplate(id, locale as LegalTemplateLocale, map);
    if (!rendered) return ApiResponseBuilder.badRequest('Unknown template');

    // One activation per template+locale. A second one would shadow the
    // first at a suffixed slug and split the translation set.
    const pages = pagesOnly(await LocalDB.getPosts()).filter((p) => p.status !== 'trashed');
    if (pages.some((p) => p.slug === rendered.slug)) {
      return ApiResponseBuilder.error(409, 'Already activated — edit the existing page instead', undefined, { code: 'ALREADY_ACTIVATED' });
    }
    if (isReservedSlug(rendered.slug)) {
      // Template slugs are chosen not to collide; this guards future edits.
      return ApiResponseBuilder.serverError('Template slug collides with a built-in route');
    }

    // Join the translation set of a sibling locale, if one exists.
    const siblingSlugs = LEGAL_TEMPLATE_LOCALES
      .filter((l) => l !== locale)
      .map((l) => template.locales[l].slug);
    const sibling = pages.find((p) => siblingSlugs.includes(p.slug));
    const translationOf = sibling ? (sibling.translation_of ?? sibling.id) : undefined;

    const created = await LocalDB.createPost({
      title: rendered.title,
      slug: rendered.slug,
      content: sanitizeHtml(rendered.contentHtml),
      status: 'draft',
      kind: 'page',
      author_id: user.id,
      tags: [],
      locale,
      ...(translationOf ? { translation_of: translationOf } : {}),
      views: 0,
    } as any);

    recordAudit(AUDIT.POST_CREATE, {
      actor: user.id,
      target: created.slug || created.id,
      metadata: { title: created.title, status: 'draft', kind: 'page', legal_template: id },
    });

    return ApiResponseBuilder.created(
      { id: created.id, slug: created.slug, missing: rendered.missing },
      rendered.missing.length > 0
        ? 'Draft created — fill in the highlighted details before publishing'
        : 'Draft created — review and publish when ready',
    );
  } catch (err) {
    console.error('Legal template activate error:', err);
    return ApiResponseBuilder.serverError('Could not activate template');
  }
};
