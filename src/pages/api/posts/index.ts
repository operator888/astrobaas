import type { APIRoute } from 'astro';
import { withFeaturedMediaKind, buildMediaKindIndex } from '../../../lib/media-kind';
import { recordAudit, AUDIT } from '../../../lib/audit';
import type { Post } from '../../../core/models';
import { visibilityQuery } from '../../../lib/visibility';
import { LocalDB } from '../../../lib/localdb';
import { pluginManager } from '../../../lib/plugin-system';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { validate, slugify } from '../../../lib/validate';
import { sanitizeHtml } from '../../../lib/sanitize';
import {
  renderContentHtml, renderTitle, mediaFactsForHtml, applyMediaFacts,
} from '../../../lib/content-render';
import { canAuthorPosts, canPublishPosts } from '../../../lib/auth';
import { fireEvent } from '../../../lib/webhooks';
import { normalizeLocale, isKnownLocale, defaultLocale, locales } from '../../../lib/i18n';
import { isReservedSlug, reservedSlugMessage } from '../../../lib/reserved-slugs';
import { mediaBaseFor } from '../../../lib/media-base';
import { uniqueSlug, reviewRequired } from '../../../lib/post-service';
import { TAXONOMIES_SETTING, TERMS_FIELD, validateTaxonomies, cleanTerms } from '../../../core/taxonomy';
import { parseListPaging, pagingMeta } from '../../../lib/list-paging';

export const GET: APIRoute = async ({ url, locals, request }) => {
  try {
    await LocalDB.init();
    const sp = new URL(url).searchParams;
    const status = sp.get('status');
    const category = sp.get('category');
    // Paging, shared with /api/content/{type}. A request with NO limit is now
    // capped at MAX_UNPAGED_ITEMS (1000) instead of rendering the whole blog —
    // see lib/list-paging.ts for why the ceiling is that high, and why an
    // explicit limit is untouched.
    const paging = parseListPaging(sp);
    const { offset } = paging;
    const user = locals.user;

    // Filtering happens in the storage layer now, not after loading every row.
    // Semantics are defined once in src/core/post-query.ts and the drivers
    // agree with it (asserted by the cross-driver test in the smoke suite), so
    // the response is unchanged — this only stops the work happening in the
    // wrong place.
    //
    // ?kind= selects what this list is FOR. The default is articles only,
    // deliberately: existing headless storefronts call this endpoint to render
    // their blog, and silently growing that response by a set of dateless
    // "About"-style pages would change what a live site renders without anyone
    // touching it. Anything unrecognised falls back to the default rather than
    // erroring, so a typo cannot empty a production listing.
    const kindParam = sp.get('kind');
    const localeParam = sp.get('locale');

    const { items, total } = await LocalDB.queryPosts({
      kind: kindParam === 'page' ? 'page' : kindParam === 'all' ? 'all' : 'post',
      ...(status ? { status } : {}),
      ...(category ? { categoryId: category } : {}),
      // ?author= (C-153). `authorId` already reaches both drivers — the admin's
      // "my posts" view uses it — and was simply never exposed, so an author
      // archive had no way to ask for one person's posts without pulling the
      // whole collection.
      ...(sp.get('author') ? { authorId: String(sp.get('author')) } : {}),
      // ?locale= narrows to one language. Unknown values normalize to the
      // default rather than returning nothing, and posts written before i18n
      // (no `locale`) count as the default, so single-locale installs are
      // unaffected.
      ...(localeParam ? { locale: normalizeLocale(localeParam) } : {}),
      // Visibility, decided in one place (src/lib/visibility.ts) and projected
      // onto the query by the same module. This used to be `if (!user)`, which
      // meant ANY authenticated user — an `author`, a `viewer` — saw every
      // unpublished body in the system. Authentication is not authorization.
      ...(visibilityQuery(user) ? { visibility: visibilityQuery(user)! } : {}),
      // ALWAYS a limit now, so the storage layer stops early on every driver —
      // the relational one pages in SQL. `take` is the caller's limit, or the
      // unpaged ceiling when they sent none.
      limit: paging.take,
      offset,
      sort: 'created_desc',
    });

    // NOTE: this hook now receives the PAGE rather than every post, which is
    // unavoidable once the database does the paging. Nothing implements it —
    // it is declared in plugin-system.ts and used only here — so no behaviour
    // changes today, but the contract is narrower and PLUGIN_DEVELOPMENT says so.
    let pageItems: Post[] = pluginManager.applyFilters('api_posts_get', items);

    // Raw content/title, rendered alongside — see the note in
    // [slug]/index.ts. A list response feeds the admin table, and anything
    // derived that shares a name with a stored field eventually gets saved back.
    // Anchored and dimensioned, exactly like the SSR pages: a decoupled
    // storefront rendering this html needs the same heading ids the CMS's own
    // pages publish — or a link to #how-it-works works on one and not the other
    // — and the same width/height, or its Core Web Vitals are worse purely for
    // being decoupled.
    //
    // Rendered first, then looked up ONCE for the whole page. Per-post would be
    // one read of the media library per article in the response.
    // renderContentHtml, not a local pipeline: this route ran filters and
    // anchors WITHOUT the sanitizer or the lazy hints, so a post_content
    // filter's markup reached a headless storefront untouched and its images
    // loaded eagerly. The media read stays batched — one query for the page.
    const rendered = pageItems.map((post) => renderContentHtml(post, (post as { locale?: string }).locale).html);
    const mediaFacts = await mediaFactsForHtml(rendered);
    // One media read for the page, joined to every featured image — the same
    // batching the content-media pass above already does, for the same reason.
    const mediaIndex = buildMediaKindIndex(await LocalDB.getMedia());
    pageItems = pageItems.map((post, i) => withFeaturedMediaKind({
      ...post,
      content_rendered: applyMediaFacts(rendered[i], mediaFacts),
      title_rendered: renderTitle(post),
    }, mediaIndex));

    return ApiResponseBuilder.success(pageItems, 'Posts retrieved successfully', {
      // `featured_image`, and every <img src="/uploads/…"> inside the sanitised
      // post HTML, are relative to this CMS. A decoupled storefront needs the
      // origin to join them to.
      media_base: await mediaBaseFor(request),
      // total/count/limit/offset/page/hasMore, in the same shape as before.
      // `limit` stays null when none was sent; `hasMore` is now true whenever
      // the unpaged ceiling cut the list, which is the one case it used to hide.
      ...pagingMeta(paging, pageItems.length, total),
    });
  } catch (err) {
    console.error('Posts list error:', err);
    return ApiResponseBuilder.serverError('Failed to fetch posts');
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    await LocalDB.init();
    const body = await request.json().catch(() => null);
    const result = validate<{
      title: string;
      slug?: string;
      content?: string;
      excerpt?: string;
      featured_image?: string;
      status?: 'draft' | 'review' | 'scheduled' | 'published' | 'trashed';
      kind?: 'post' | 'page';
      publish_date?: string;
      category_id?: string;
      tags?: string[];
      meta_title?: string;
      meta_description?: string;
      noindex?: boolean;
      focus_keyphrase?: string;
      pinned?: boolean;
      menu_order?: number;
      locale?: string;
      translation_of?: string;
    }>(body, {
      title: { type: 'string', min: 1, max: 200 },
      slug: { type: 'string', min: 1, max: 80, pattern: /^[a-z0-9-]+$/, optional: true },
      content: { type: 'string', max: 200000, optional: true },
      excerpt: { type: 'string', max: 600, optional: true },
      featured_image: { type: 'string', max: 500, optional: true },
      status: { type: 'enum', values: ['draft', 'review', 'scheduled', 'published', 'trashed'], optional: true },
      // A standalone page ("About", "Contact") versus a dated blog entry. This
      // has to be settable at CREATE time, not only on update: the admin's Type
      // selector posts it here, and without it a new page was stored as a post,
      // 404'd at its own URL and appeared under /blog.
      kind: { type: 'enum', values: ['post', 'page'], optional: true },
      publish_date: { type: 'string', max: 40, optional: true },
      category_id: { type: 'id', optional: true },
      tags: { type: 'array', of: 'string', max: 20, optional: true },
      meta_title: { type: 'string', max: 200, optional: true },
      meta_description: { type: 'string', max: 400, optional: true },
      noindex: { type: 'boolean', optional: true },
      focus_keyphrase: { type: 'string', max: 120, optional: true },
      pinned: { type: 'boolean', optional: true },
      menu_order: { type: 'number', optional: true },
      locale: { type: 'string', max: 12, optional: true },
      translation_of: { type: 'id', optional: true },
    });
    if (!result.ok) {
      return ApiResponseBuilder.validationError('Invalid post payload', result.errors);
    }
    // An explicit locale must be one we actually serve — silently coercing a
    // typo to the default would file the post under the wrong language.
    if (result.value.locale !== undefined && !isKnownLocale(result.value.locale)) {
      return ApiResponseBuilder.validationError('Invalid post payload', {
        locale: `unknown locale "${result.value.locale}" (configured: ${locales().join(', ')})`,
      });
    }

    // Author is taken from the authenticated session, not the request body.
    const user = locals.user;
    if (!user) return ApiResponseBuilder.unauthorized();
    if (!canAuthorPosts(user.role)) {
      return ApiResponseBuilder.forbidden('Your role cannot create posts');
    }

    const data = result.value;

    // Terms are cleaned against the DEFINITIONS, not against the payload:
    // a taxonomy this install does not define, one that does not apply to this
    // kind of record, or a slug that is not a slug, is dropped rather than
    // stored. That is what stops a client inventing a taxonomy by writing to
    // it, and what makes a deleted taxonomy degrade to nothing.
    // Read from the RAW body rather than through the schema: `terms` is a
    // map whose valid keys depend on this install's settings, which no static
    // rule can express — and adding an `object` rule to the shared validator
    // for one caller would widen it for every other schema in the codebase.
    // `cleanTerms` is the check, and it rejects every wrong shape including
    // "not an object at all".
    const taxonomyDefs = validateTaxonomies((await LocalDB.getSetting(TAXONOMIES_SETTING))?.value).defs;
    const cleaned = cleanTerms(
      (body as Record<string, unknown> | null)?.[TERMS_FIELD],
      taxonomyDefs,
      data.kind === 'page' ? 'page' : 'post',
    );

    // EDITORIAL REVIEW (C-150), on the create path too — an author who cannot
    // publish an existing post must not be able to CREATE one already
    // published. Refused rather than downgraded to draft: silently coercing
    // the status tells the author it worked while the post is not live.
    if (data.status === 'published' && !canPublishPosts(user.role) && await reviewRequired()) {
      return ApiResponseBuilder.forbidden(
        'This site holds posts for review. Create it as a draft, or set the status to "review" '
        + 'and an editor will publish it.',
      );
    }

    let slug = data.slug || slugify(data.title);

    // A Page is routed at `/{slug}` by a rest-parameter catch-all, and Astro
    // orders routes statically: a built-in file always wins. So a Page slugged
    // `about` is not a shadow, it is unreachable — it saves, lists, and links
    // like any other page while `/about` keeps serving the built-in one.
    // Refusing here is the only point at which the author can be told.
    //
    // Only Pages are affected: an article lives under `/blog/{slug}`, where no
    // built-in route competes.
    if (data.kind === 'page' && isReservedSlug(slug)) {
      return ApiResponseBuilder.validationError('Invalid post payload', {
        slug: reservedSlugMessage(slug),
      });
    }

    // Uniqueness lives in ONE function, shared with the duplicate route — no
    // storage driver has a unique index, so that function is the constraint.
    slug = await uniqueSlug(slug);

    // Let plugins mutate/validate the post before persistence. Content is
    // sanitized AFTER this filter, so a plugin can't smuggle unsafe HTML.
    const draft = pluginManager.applyFilters('before_post_save', {
      title: data.title,
      slug,
      content: data.content ?? '',
      excerpt: data.excerpt,
      featured_image: data.featured_image,
      status: data.status ?? 'draft',
      // Only stored when explicitly asked for. Leaving it absent (rather than
      // writing 'post') keeps every existing record and every existing client
      // byte-identical — `kind` is read as "page if it says page".
      ...(data.kind ? { kind: data.kind } : {}),
      publish_date: data.publish_date,
      author_id: user.id,
      category_id: data.category_id,
      tags: data.tags ?? [],
      meta_title: data.meta_title,
      meta_description: data.meta_description,
      ...(data.noindex ? { noindex: true } : {}),
      // Absent rather than false/0, so a row that was never pinned is byte-
      // identical to every row written before pinning existed — which is what
      // makes the new default ordering a no-op on an existing site.
      ...(data.focus_keyphrase?.trim() ? { focus_keyphrase: data.focus_keyphrase.trim() } : {}),
      ...(data.pinned ? { pinned: true } : {}),
      ...(Number.isFinite(data.menu_order as number) ? { menu_order: Math.trunc(data.menu_order as number) } : {}),
      // Every new post is stamped with a locale (explicit, else the default) so
      // the content model stays consistent from here on.
      locale: data.locale ?? defaultLocale(),
      ...(data.translation_of ? { translation_of: data.translation_of } : {}),
      // Absent when nothing survives cleaning, so a record with no terms is
      // byte-identical to every row written before taxonomies existed.
      ...(cleaned ? { [TERMS_FIELD]: cleaned } : {}),
      views: 0,
    }, { isNew: true });

    const created = await LocalDB.createPost({
      ...draft,
      content: sanitizeHtml(draft.content ?? ''),
      author_id: user.id, // never overridable by a plugin
    });

    // Creation is audited HERE rather than in a service, because unlike update
    // and delete there is no shared post-service entry point to hang it on.
    recordAudit(AUDIT.POST_CREATE, {
      actor: user.id,
      target: created.slug || created.id,
      metadata: { title: created.title, status: created.status, kind: created.kind ?? 'post' },
    });
    pluginManager.doAction('after_post_save', created);
    // Fire-and-forget outbound webhook (never blocks the response).
    fireEvent('post.created', created).catch(() => {});
    return ApiResponseBuilder.created(created, 'Post created successfully');
  } catch (err) {
    console.error('Post create error:', err);
    return ApiResponseBuilder.serverError('Failed to create post');
  }
};
