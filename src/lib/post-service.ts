/**
 * Post mutation service — the single implementation of "update a post" and
 * "delete a post", shared by the RESTful routes (`/api/posts/[slug]`) and the
 * legacy body-based shims (`/api/posts/update`, `/api/posts/delete`). Centralizing
 * it keeps access control, plugin hooks, sanitization, and webhook dispatch
 * identical no matter which route is called.
 */
import { LocalDB, isSlugTakenError } from './localdb';
import { recordAudit, AUDIT, summariseChanges } from './audit';
import { sanitizeHtml } from './sanitize';
import { canPublishPosts, canManageAllPosts } from './auth';
import { pluginManager } from './plugin-system';
import { fireEvent } from './webhooks';
import { validate, type Schema } from './validate';
import { isReservedSlug, reservedSlugMessage } from './reserved-slugs';
import { isKnownLocale, locales } from './i18n';
import { captureRevision } from './revisions';
import { ApiResponseBuilder } from './api-response';
import type { Post } from '../core/models';
import { settingBool } from './settings-map';
import { TAXONOMIES_SETTING, TERMS_FIELD, validateTaxonomies, cleanTerms } from '../core/taxonomy';

/** The session shape the middleware attaches to `locals.user`. */
export interface SessionUser {
  id: string;
  role: string;
}

/** Discriminated result so callers can map cleanly to HTTP responses. */
export type PostServiceResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: 400 | 401 | 403 | 404 | 422; message: string; details?: unknown };

/**
 * Editable post fields (all optional — this is a partial update). The `id` is
 * passed separately (from the path or the request body), never validated here.
 */
export const POST_UPDATE_FIELDS: Schema = {
  title: { type: 'string', min: 1, max: 200, optional: true },
  slug: { type: 'string', min: 1, max: 80, pattern: /^[a-z0-9-]+$/, optional: true },
  content: { type: 'string', max: 200000, optional: true },
  // Without this, validate() silently drops the key — it copies only fields the
  // schema names. That is precisely how four "setting that changes nothing"
  // bugs reached production in this codebase.
  kind: { type: 'enum', values: ['post', 'page'], optional: true },
  excerpt: { type: 'string', max: 600, optional: true },
  featured_image: { type: 'string', max: 500, optional: true },
  status: { type: 'enum', values: ['draft', 'review', 'scheduled', 'published', 'trashed'], optional: true },
  author_id: { type: 'id', optional: true },
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
};

/**
 * Resolve a post reference that may be either its `id` or its `slug` (so REST
 * paths like `/api/posts/{ref}` accept either). Tries id first.
 */
export async function resolvePostRef(ref: string): Promise<Post | null> {
  if (!ref) return null;
  const byId = await LocalDB.getPost(ref);
  if (byId) return byId;
  const posts = await LocalDB.getPosts();
  return posts.find(p => p.slug === ref) ?? null;
}

/** Slugs are capped at 80 chars by the create schema; leave room for a suffix. */
const SLUG_MAX = 80;

/**
 * A slug no existing post is using.
 *
 * Extracted because there are now TWO create paths (POST /api/posts and
 * duplicate), and slug uniqueness lives nowhere else: no storage driver has a
 * unique index — `sql-storage.ts` stores every table as `(id, data)` — so this
 * function IS the constraint. Two implementations of it would be two different
 * constraints.
 *
 * The suffix loop replaces a single-shot `Date.now()` suffix that could
 * collide with itself: two duplicates created in the same millisecond produced
 * the same "unique" slug and nothing rejected it. Duplicate is precisely the
 * button people click twice.
 */
export async function uniqueSlug(base: string, existing?: readonly Post[]): Promise<string> {
  const posts = existing ?? (await LocalDB.getPosts());
  const taken = new Set(posts.map((p) => p.slug));
  const root = base.slice(0, SLUG_MAX);
  if (!taken.has(root)) return root;
  for (let n = 2; n <= 200; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${root.slice(0, SLUG_MAX - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  // Two hundred copies of one slug is not a naming problem any more; fall back
  // to something that cannot collide rather than looping forever.
  const rand = Math.random().toString(36).slice(2, 8);
  return `${root.slice(0, SLUG_MAX - 7)}-${rand}`;
}

/**
 * Validate + apply a partial update to a post. `rawUpdates` is the unvalidated
 * field bag (the request body, minus any id). Enforces the same access control
 * as before: editors/admins edit any post, authors only their own, and only
 * editors/admins may reassign authorship.
 */
export async function updatePost(
  id: string,
  rawUpdates: unknown,
  session: SessionUser | null | undefined,
): Promise<PostServiceResult<Post>> {
  if (!session) return { ok: false, status: 401, message: 'Unauthorized' };

  // `null` means CLEAR, and it is separated out before validation because a
  // typed rule would reject it.
  //
  // Without this there is no way to REMOVE an optional value: omitting the key
  // is indistinguishable from "leave it alone" to a merging update, so an
  // author who emptied the Manual order box kept the old number and the help
  // text ("Leave empty and this post falls back to date order") was a false
  // statement they could not act on. Only fields the editor can genuinely empty
  // are clearable; `title` and `slug` are not on the list, because a post with
  // no slug is unreachable rather than tidy.
  const CLEARABLE = new Set([
    'menu_order', 'focus_keyphrase', 'meta_title', 'meta_description',
    'excerpt', 'featured_image', 'category_id', 'translation_of',
  ]);
  // An EMPTY STRING is a value, not an absence, for the fields where empty is a
  // thing an author can legitimately mean. `validate` treats '' exactly like
  // undefined — which is right for "is this required?" and wrong here: an
  // author who selected the whole body and pressed delete got 200 OK and the
  // old article still stored. Nothing failed, nothing was logged, and the text
  // came back the next time they opened it.
  //
  // Held separately from the null/CLEAR list because the outcomes differ: a
  // cleared field is REMOVED, an emptied one is stored as ''. A post with an
  // empty body still has a body.
  const EMPTIABLE = new Set(['content', 'excerpt', 'meta_title', 'meta_description', 'focus_keyphrase']);
  const emptied: string[] = [];
  const cleared: string[] = [];
  const incoming = rawUpdates && typeof rawUpdates === 'object' ? { ...(rawUpdates as Record<string, unknown>) } : {};
  for (const key of Object.keys(incoming)) {
    if (incoming[key] === null && CLEARABLE.has(key)) {
      cleared.push(key);
      delete incoming[key];
    } else if (incoming[key] === '' && EMPTIABLE.has(key)) {
      emptied.push(key);
      delete incoming[key];
    }
  }

  const result = validate<Record<string, unknown>>(incoming, POST_UPDATE_FIELDS);
  if (!result.ok) return { ok: false, status: 422, message: 'Invalid post payload', details: result.errors };
  const updates = result.value;

  // Reject an unconfigured locale rather than coercing it — silently filing a
  // post under the wrong language is worse than a 422.
  if (updates.locale !== undefined && !isKnownLocale(updates.locale)) {
    return {
      ok: false,
      status: 422,
      message: 'Invalid post payload',
      details: { locale: `unknown locale "${String(updates.locale)}" (configured: ${locales().join(', ')})` },
    };
  }

  const existing = await LocalDB.getPost(id);
  if (!existing) return { ok: false, status: 404, message: 'Post not found' };

  // Same rule as create, and it has to be re-checked here because BOTH inputs
  // can change: renaming a page's slug to `about`, and converting an existing
  // post that already has that slug into a page. Checking only `updates.slug`
  // would miss the second, which is the sibling-gap failure this codebase keeps
  // repeating.
  const nextKind = updates.kind ?? existing.kind;
  const nextSlug = (updates.slug as string | undefined) ?? existing.slug;
  if (nextKind === 'page' && isReservedSlug(nextSlug)) {
    return {
      ok: false,
      status: 422,
      message: 'Invalid post payload',
      details: { slug: reservedSlugMessage(nextSlug) },
    };
  }
  // A slug another record already holds is REFUSED, not silently suffixed.
  // Create may quietly disambiguate (nobody typed that slug — it came from a
  // title), but on update the author typed it, and renaming their choice
  // without telling them is worse than saying no. Products already answer 400
  // here; posts accepted the collision, and two records sharing a slug means
  // every resolver takes whichever was created first — the second becomes
  // unreachable at its own URL, and the sitemap and the page can end up
  // describing different records.
  if (updates.slug !== undefined && nextSlug !== existing.slug) {
    const clash = (await LocalDB.getPosts()).find(p => p.slug === nextSlug && p.id !== existing.id);
    if (clash) {
      return {
        ok: false,
        status: 400,
        message: 'Invalid post payload',
        details: { slug: `"${nextSlug}" is already used by another post or page.` },
      };
    }
  }
  if (!canManageAllPosts(session.role) && existing.author_id !== session.id) {
    return { ok: false, status: 403, message: 'You can only modify your own posts' };
  }

  // EDITORIAL REVIEW (C-150). Off unless the operator turned it on, so every
  // existing install is byte-identical until somebody opts in.
  //
  // REFUSED, never silently downgraded to draft. Quietly coercing the status
  // would be the "setting that changes nothing" shape this codebase keeps
  // finding: the author presses Publish, is told it worked, and the post is
  // not live — with nothing anywhere saying why.
  if (await reviewRequired() && updates.status === 'published' && !canPublishPosts(session.role)) {
    return {
      ok: false,
      status: 403,
      message: 'This site holds posts for review. Set the status to "review" and an editor will publish it.',
    };
  }
  // Only admins/editors may reassign authorship.
  if (updates.author_id && !canManageAllPosts(session.role)) delete updates.author_id;

  // Snapshot the CURRENT content before it is overwritten, so the newest
  // revision is always "what this looked like before the last edit".
  await captureRevision(existing, session.id, 'edit');

  // Plugins may mutate/validate before persistence; content sanitized AFTER so a
  // plugin can't smuggle unsafe HTML.
  const filtered = pluginManager.applyFilters('before_post_save', { ...updates }, { isNew: false });
  if (typeof filtered.content === 'string') filtered.content = sanitizeHtml(filtered.content);
  // Undefined, not absent: the storage layer merges, so the key has to be
  // PRESENT and undefined for the merge to overwrite it. JSON serialisation
  // then drops it, which is the same shape a record that never had the field
  // has — so a cleared post is indistinguishable from one written before the
  // field existed, which is exactly right.
  for (const key of cleared) (filtered as Record<string, unknown>)[key] = undefined;
  // Stored as '', not removed — see EMPTIABLE above. Applied AFTER the filter
  // chain so a plugin cannot resurrect a body the author deleted, and after
  // the sanitizer, which has nothing to do on an empty string anyway.
  for (const key of emptied) (filtered as Record<string, unknown>)[key] = '';

  // Custom taxonomies (C-128), on the UPDATE path as well as create — the
  // sibling-gap failure this codebase keeps repeating is a rule applied to one
  // and not the other, and here it would mean terms could be set on a new post
  // and never changed on an existing one.
  //
  // Read from the RAW body, because `terms` is a map whose valid keys depend on
  // this install's settings and no static schema rule can express that.
  // Present-but-empty means "remove them all", so `undefined` is written rather
  // than the key being skipped — the storage layer merges, so an absent key
  // would silently keep the old assignment.
  const rawTerms = (incoming as Record<string, unknown>)[TERMS_FIELD]
    ?? (rawUpdates as Record<string, unknown> | null)?.[TERMS_FIELD];
  if (rawTerms !== undefined) {
    const taxonomyDefs = validateTaxonomies((await LocalDB.getSetting(TAXONOMIES_SETTING))?.value).defs;
    const collection = nextKind === 'page' ? 'page' : 'post';
    (filtered as Record<string, unknown>)[TERMS_FIELD] = cleanTerms(rawTerms, taxonomyDefs, collection);
  }

  // The pre-check above catches the ordinary case and gives a helpful message;
  // this catches the concurrent one, where the storage layer refuses inside its
  // own write. Same answer either way — the caller should not be able to tell
  // which guard fired.
  let updated;
  try {
    updated = await LocalDB.updatePost(id, filtered);
  } catch (err) {
    if (isSlugTakenError(err)) {
      return {
        ok: false,
        status: 400,
        message: 'Invalid post payload',
        details: { slug: `"${err.slug}" is already used by another post or page.` },
      };
    }
    throw err;
  }
  if (!updated) return { ok: false, status: 404, message: 'Post not found' };
  // Who changed what. Recorded here rather than in each route because three
  // routes reach this function, and three copies of one rule is how two of them
  // silently stop recording.
  const changes = summariseChanges(existing as unknown as Record<string, unknown>, filtered);
  if (changes.length) {
    recordAudit(AUDIT.POST_UPDATE, {
      actor: session.id,
      target: updated.slug || id,
      metadata: { changes, title: updated.title },
    });
  }
  pluginManager.doAction('after_post_save', updated);
  fireEvent('post.updated', updated).catch(() => {});
  return { ok: true, data: updated };
}

/** Delete a post by id, with the same ownership rules as update. */
export async function deletePost(
  id: string,
  session: SessionUser | null | undefined,
): Promise<PostServiceResult<null>> {
  if (!session) return { ok: false, status: 401, message: 'Unauthorized' };

  const existing = await LocalDB.getPost(id);
  if (!existing) return { ok: false, status: 404, message: 'Post not found' };
  if (!canManageAllPosts(session.role) && existing.author_id !== session.id) {
    return { ok: false, status: 403, message: 'You can only delete your own posts' };
  }

  const deleted = await LocalDB.deletePost(id);
  if (!deleted) return { ok: false, status: 404, message: 'Post not found' };
  // Revisions are meaningless without their post, and they hold draft text —
  // don't leave orphans behind.
  await LocalDB.deletePostRevisions(id).catch(() => 0);
  // A deletion is the entry most likely to be looked up later, and the post is
  // gone — so the trail keeps enough to identify WHAT was deleted, never its
  // body.
  recordAudit(AUDIT.POST_DELETE, {
    actor: session.id,
    target: existing.slug || id,
    metadata: { title: existing.title, status: existing.status },
  });
  pluginManager.doAction('after_post_delete', existing);
  fireEvent('post.deleted', { id: existing.id, slug: existing.slug, title: existing.title }).catch(() => {});
  return { ok: true, data: null };
}

/** Map a failed service result to the house error Response. */
export function postErrorResponse(r: Extract<PostServiceResult<unknown>, { ok: false }>): Response {
  switch (r.status) {
    case 401:
      return ApiResponseBuilder.unauthorized(r.message);
    case 403:
      return ApiResponseBuilder.forbidden(r.message);
    case 404:
      return ApiResponseBuilder.notFound('Post');
    case 422:
      return ApiResponseBuilder.validationError(r.message, r.details);
    default:
      return ApiResponseBuilder.badRequest(r.message, r.details);
  }
}

/**
 * Does this install hold posts for review before publishing? (C-150)
 *
 * Read through `settingBool` so the relational driver's TEXT `"false"` is a
 * real false — the same class of bug that made the EU withdrawal notice publish
 * itself after an operator switched it off.
 *
 * Default OFF. Turning it on silently would break every author on an existing
 * install at the moment of an upgrade.
 */
export async function reviewRequired(): Promise<boolean> {
  try {
    return settingBool((await LocalDB.getSetting(EDITORIAL_REVIEW_SETTING))?.value, false);
  } catch {
    // A settings read that fails must not lock authors out of publishing. The
    // shipped policy is "no review", so that is what a failure degrades to.
    return false;
  }
}

/** The setting that governs it. */
export const EDITORIAL_REVIEW_SETTING = 'editorial_review_required';
