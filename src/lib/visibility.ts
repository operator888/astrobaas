/**
 * Who is allowed to SEE what.
 *
 * ## Why this file exists
 *
 * AstroBaaS enforces authorization in middleware and route handlers over a
 * storage layer that is identity-blind: `getPosts()` takes no caller, and the
 * relational driver runs `SELECT data FROM posts` with no predicate. That is a
 * legitimate design — but it has one specific failure mode, and this project
 * has already been bitten by it twice.
 *
 * With database-enforced row-level security, a handler that forgets its check
 * returns nothing. Here, a handler that forgets its check returns EVERYTHING.
 * `GET /api/settings/get` once returned the whole settings table publicly,
 * including `smtp_password` and `stripe_secret_key`. `GET /api/media/get`
 * enumerated every uploaded file to anonymous callers. Both were a missing
 * line in one route.
 *
 * So rather than build Postgres-style RLS — which is 15-25 days of work for a
 * system that is single-tenant by design — this closes the CLASS of bug: one
 * place that decides visibility, which every collection read goes through, so
 * the decision is made once and reviewed once instead of re-derived per route.
 *
 * ## The rule for editorial content
 *
 * | role     | published | own drafts | others' drafts |
 * |----------|-----------|------------|----------------|
 * | anonymous| yes       | —          | no             |
 * | viewer   | yes       | —          | no             |
 * | author   | yes       | yes        | **no**         |
 * | editor   | yes       | yes        | yes            |
 * | admin    | yes       | yes        | yes            |
 *
 * `author` is the one that changed. Any authenticated user previously saw every
 * unpublished body in the system, which makes the role meaningless: an author
 * could read an embargoed announcement, an unpublished price change, or a
 * colleague's half-written draft.
 *
 * Editors and admins keep full sight, because reviewing others' drafts is the
 * job those roles exist for.
 */
import type { Role } from '../core/models';

/** The caller, as far as visibility is concerned. */
export interface Viewer {
  id?: string;
  role?: Role;
}

/** Roles that may read content they do not own. */
const EDITORIAL_ROLES: readonly Role[] = ['admin', 'editor'];

export function canSeeOthersDrafts(viewer: Viewer | null | undefined): boolean {
  return !!viewer?.role && EDITORIAL_ROLES.includes(viewer.role);
}

/** Anything with a status and an author. Structural, so it fits posts and pages. */
interface Authored {
  status?: string;
  author_id?: string;
}

/**
 * Filter a collection of editorial records to what `viewer` may see.
 *
 * Deny-by-default: an unrecognised role sees published content only. A new role
 * added to the union without being considered here loses access rather than
 * gaining it, which is the safe direction to fail.
 */
export function visibleContent<T extends Authored>(items: T[], viewer: Viewer | null | undefined): T[] {
  if (canSeeOthersDrafts(viewer)) return items;

  const ownerId = viewer?.id;
  return items.filter((item) => {
    if (item.status === 'published') return true;
    // An author keeps sight of their own work in progress.
    return !!ownerId && item.author_id === ownerId;
  });
}

/** Single-record form. `null` means "not visible", which callers turn into a 404. */
export function visibleOne<T extends Authored>(item: T | null | undefined, viewer: Viewer | null | undefined): T | null {
  if (!item) return null;
  return visibleContent([item], viewer).length ? item : null;
}

/**
 * Why a record is hidden — for tests and audit messages, never for API
 * responses. Telling an anonymous caller "this exists but is a draft" confirms
 * the slug, which is exactly what a 404 is meant to withhold.
 */
export function explainHidden(item: Authored, viewer: Viewer | null | undefined): string {
  if (canSeeOthersDrafts(viewer)) return 'visible';
  if (item.status === 'published') return 'visible';
  if (!viewer?.id) return 'unpublished, and the caller is anonymous';
  if (item.author_id === viewer.id) return 'visible';
  return `unpublished, and owned by ${item.author_id ?? 'nobody'} rather than ${viewer.id}`;
}

/**
 * The same rule, projected onto a storage query so it can be pushed down.
 *
 * Kept HERE beside `visibleContent` rather than in the API route, because the
 * two must always agree: if the filter says "published, or your own drafts" and
 * the query says only "published", an author's list silently loses their own
 * work. One rule, two renderings of it, in one file where a change to either is
 * visible next to the other.
 *
 * Returns `undefined` for a viewer who may see everything, which is exactly
 * "no visibility clause" to the query builder.
 */
export function visibilityQuery(
  viewer: Viewer | null | undefined,
): { publishedOnly: true; orAuthorId?: string } | undefined {
  if (canSeeOthersDrafts(viewer)) return undefined;
  const ownerId = viewer?.id;
  return ownerId ? { publishedOnly: true, orAuthorId: ownerId } : { publishedOnly: true };
}
