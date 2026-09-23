import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { canAuthorPosts } from '../../../lib/auth';
import { mediaBaseFor } from '../../../lib/media-base';
import { withAbsoluteMedia } from '../../../lib/media-url';
import { matchesSearch } from '../../../lib/text-search';
import { inFolder, folderCounts } from '../../../lib/media/folders';

/** Enough to fill a grid twice over without being a page-weight problem. */
const DEFAULT_PAGE_SIZE = 48;
/** A caller asking for more than this is asking for the whole-library problem back. */
const MAX_PAGE_SIZE = 200;

export const GET: APIRoute = async ({ locals, url, request }) => {
  try {
    // Removing this route from the public allow-list stopped anonymous
    // enumeration, but left every authenticated principal able to list the
    // library — including a `viewer`, whom middleware bounces out of the whole
    // admin UI, and any scoped API key. The route needs its own check: the
    // allow-list decides who may KNOCK, not who may read.
    // `canAuthorPosts`, not a hand-written role list.
    //
    // The list here read `admin | editor | author` and was never updated when
    // `manager` was added, so a shop manager could UPLOAD an image
    // (media/upload.ts already gates on canAuthorPosts, which includes them)
    // and then not see it: the library listed nothing and the product form's
    // image picker came back empty. Upload and read disagreed about who counts
    // as staff, which is the same rule expressed twice — this codebase's most
    // reliable bug.
    //
    // Asking the predicate means the next role added is right here by
    // construction rather than by somebody remembering.
    if (!canAuthorPosts(locals.user?.role)) {
      return ApiResponseBuilder.forbidden('Media library is staff-only');
    }
    await LocalDB.init();
    const all = await LocalDB.getMedia();

    // Search SERVER-side.
    //
    // The library was returned whole, with no way to ask for less, so the admin
    // had to fetch all of it before it could filter — 948 items on the
    // production shop, which then rendered ~1,900 <img> elements and produced
    // 33 HTTP 503s in a minute for one manager opening the picker.
    //
    // Matching uses the SAME folded comparison as the rest of the admin, over
    // `original_name` first: the uploader randomises the stored `filename`
    // (a74bbfad551aabf7.webp), so searching that matches nothing a person would
    // ever type.
    const q = String(url.searchParams.get('q') ?? '').trim();
    const searched = q
      ? all.filter((m) => matchesSearch([m.original_name, m.alt_text, m.filename], q))
      : all;

    // `?folder=` (C-61). Tested with `has`, not by truthiness: an EMPTY value
    // is a real request — the unfiled bucket — and is not the same as "no
    // filter at all". Truthiness would make "show me what is unfiled"
    // indistinguishable from "show me everything".
    const matched = url.searchParams.has('folder')
      ? inFolder(searched, String(url.searchParams.get('folder') ?? ''))
      : searched;

    const total = matched.length;

    // No paging parameters at all → the whole list, exactly as before.
    //
    // This route is staff-only so the blast radius is small, but "small" is not
    // "none": the product form's picker and the media screen both call it, and
    // a caller that passes nothing must not silently receive a first page it
    // did not ask for and cannot detect.
    const rawLimit = url.searchParams.get('limit');
    const rawOffset = url.searchParams.get('offset');
    /*
     * BACKWARDS COMPATIBILITY, and why it is shaped like this.
     *
     * `url` and `thumb_url` keep meaning exactly what they meant: a path
     * relative to this CMS. Every existing consumer — the admin library, the
     * product picker, the MCP tool, the smoke suite that does `${BASE}${d.url}`
     * — keeps working untouched.
     *
     * Two things are ADDED beside them, because neither alone is sufficient:
     *
     *   `url_absolute` on each record, because that is what a storefront hands
     *   straight to next/image. A base alone would force every consumer to
     *   write its own join, and getting the trailing slash wrong there is the
     *   bug we are fixing.
     *
     *   `meta.media_base` on the envelope, because a record field cannot help
     *   with the media paths that are NOT media records — `images[].src` on a
     *   product, `featured_image` on a post, and the `<img src="/uploads/…">`
     *   inside sanitised post HTML. Those need a base the client can join
     *   itself.
     *
     * `media_base` is null when nothing usable is configured. That is a real
     * answer meaning "I do not know my own address" — the deep health check
     * reports it as a fault rather than letting the relative paths pass for
     * configuration.
     */
    const base = await mediaBaseFor(request);

    // The whole list, exactly as before — but only when nothing was ASKED for.
    // `?folder=` has to be in this condition: without it the shortcut returns
    // the unfiltered library and the filter appears to do nothing, which is the
    // write-only-phantom failure this row exists to fix, one level up.
    if (rawLimit === null && rawOffset === null && !q && !url.searchParams.has('folder')) {
      return ApiResponseBuilder.success(
        all.map((m) => withAbsoluteMedia(m, base)),
        'Media retrieved successfully',
        { total: all.length, media_base: base, folders: folderCounts(all) },
      );
    }

    const limit = Math.min(Math.max(Number(rawLimit ?? DEFAULT_PAGE_SIZE) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const offset = Math.max(Number(rawOffset ?? 0) || 0, 0);
    const page = matched.slice(offset, offset + limit);

    return ApiResponseBuilder.success(page.map((m) => withAbsoluteMedia(m, base)), 'Media retrieved successfully', {
      total,
      limit,
      offset,
      media_base: base,
      // Counted over the WHOLE library, not the filtered page: a sidebar that
      // renumbered itself every time somebody clicked a folder would say the
      // folder they are in is the only one with anything in it.
      folders: folderCounts(all),
      // Saves a client doing the arithmetic, and makes "is there more" a fact
      // rather than an inference from a short page.
      has_more: offset + page.length < total,
    });
  } catch (err) {
    console.error('Media list error:', err);
    return ApiResponseBuilder.serverError('Failed to fetch media');
  }
};
