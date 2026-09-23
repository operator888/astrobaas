import type { APIRoute } from 'astro';
import { canSeeOthersDrafts } from '../../../lib/visibility';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { validate } from '../../../lib/validate';
import { isCommerceEnabled } from '../../../lib/commerce-service';
import { getContentType, getContentTypes, contentTypeIsPublic } from '../../../core/content-types';
import { ensurePluginsBootstrapped } from '../../../plugins';
import {
  clampChangeLimit,
  decodeChangeCursor,
  encodeChangeCursor,
  isChangeWindowTruncated,
  type ChangeCursor,
  type ContentChangeMeta,
} from '../../../core/change-feed';
import type { ContentChange } from '../../../core/models';

/** Entity types that only exist because a shop does. */
const COMMERCE_ENTITY_TYPES = new Set(['product', 'order']);

/**
 * Built-in entity types a public caller is allowed to know changed.
 *
 * `order` is NOT one of them. It used to be: stripped of snapshots and field
 * names, an order event still gave anyone who polled this feed every order's
 * id, the moment it was placed and each moment it changed — the shop's order
 * volume and rhythm, sale by sale, which is business data no storefront needs.
 * Revalidation keys on catalogue and content; an order changes nothing a
 * storefront renders. Staff still see order events (the editorial path does
 * not consult this list).
 */
const PUBLIC_CORE_TYPES = new Set(['post', 'category', 'product', 'theme', 'setting', 'user']);

/**
 * Types a public caller may know CHANGED, but not WHICH FIELDS changed.
 *
 * An order is not a public record. That it changed is already visible here
 * (and has been, while the shop is on); the field names would add the story —
 * `payment_status`, then `tracking_number`, then `erased_at` — which narrates
 * one customer's order, down to their erasure request, to anyone who asks. A
 * user record is the same. Field names are for records whose content is public
 * anyway, where they let a storefront skip a revalidation.
 */
const PUBLIC_TYPES_WITHOUT_FIELDS = new Set(['order', 'user']);

/**
 * May a caller with no editorial privilege see that THIS entity type changed?
 *
 * Custom collections are the risk. A public FORM is `writable: 'public'` with
 * `visibility: 'staff'` — anyone may submit, only staff may read — so its
 * create events, even stripped to metadata, are precisely the existence oracle
 * (the type name, an id, the timing and volume of submissions) that the forms
 * design refuses everywhere else. A public caller sees a custom type's changes
 * only when that type is readable by the public in the first place.
 */
function publicMaySeeType(entityType: string): boolean {
  if (PUBLIC_CORE_TYPES.has(entityType)) return true;
  const def = getContentType(entityType);
  // Unknown-to-the-registry types are core/plugin bookkeeping, not custom
  // collections; leave those to the core allow-list above (they are not here).
  if (!def) return false;
  return contentTypeIsPublic(def);
}

/**
 * Every entity type a non-editorial caller may see, as an ALLOW-LIST for the
 * storage read.
 *
 * The rules are the two that were here before, unchanged — the commerce master
 * switch and publicMaySeeType — applied to every type that could possibly be
 * visible (the core list plus every registered collection). What changed is
 * WHERE they apply: they used to filter the rows after the whole feed had been
 * read. Pushed into the read, a page is full of rows the caller may see, and
 * `has_more` means "more you may see" rather than "more rows, some of which
 * were someone else's form submissions" — which was itself a count of them.
 *
 * An allow-list, not a deny-list: a type nobody considered — a plugin's
 * bookkeeping, a collection deleted since its changes were recorded — is not
 * on it, and so is not shown.
 */
function publicChangeTypes(commerceOn: boolean): string[] {
  const candidates = new Set<string>([...PUBLIC_CORE_TYPES, ...getContentTypes().map((d) => d.name)]);
  return [...candidates].filter((type) => {
    // The commerce master switch reaches this feed too. This route is public
    // and NOT matched by the middleware's COMMERCE_API gate, so on a shop that
    // was switched off it would still hand anonymous callers `product` and
    // `order` change events — leaking that the install is a shop, its entity
    // ids, and the timing and volume of catalogue and order activity. That is
    // exactly the "look like one that never had a shop" guarantee the switch
    // exists to keep. Staff still see everything (they run the shop); everyone
    // else sees commerce rows dropped when the shop is off.
    if (!commerceOn && COMMERCE_ENTITY_TYPES.has(type)) return false;
    // A non-editorial caller never learns that a staff-only custom
    // collection changed — not even its metadata. This is what stops a
    // public form (writable public, readable staff) leaking its submissions,
    // their ids and their timing through this feed.
    return publicMaySeeType(type);
  });
}

/**
 * What a non-editorial caller receives for one change: an explicit allow-list
 * of keys, built fresh, so nothing the store attaches to an entry later can
 * reach this caller by default.
 *
 * The feed stores FULL entity snapshots (localdb.ts appendChange) — draft
 * bodies, and orders with customer name, email, phone and address. It used to
 * hand all of that to anyone with a session, which is authentication used as
 * authorization: a `viewer`, or a scoped `posts:read` API key, read every
 * order's PII and every author's unpublished work.
 *
 * This is the same mistake src/lib/visibility.ts was written to abolish, on a
 * route that never imported it — which is the lesson from Phase D: fixing the
 * routes you looked at is not the same as fixing the rule.
 *
 * Snapshots require the editorial roles that are already trusted with other
 * people's drafts. Everyone else gets the timeline only: what changed and when,
 * and — for records that are public anyway — which fields, never what they
 * said. The storage read is ALREADY metadata-only for these callers (on the
 * relational driver the snapshot never leaves the database); this projection
 * is the second lock, not the only one.
 */
function publicEntry(c: ContentChange | ContentChangeMeta): ContentChangeMeta {
  const entry: ContentChangeMeta = {
    id: c.id,
    entity_type: c.entity_type,
    entity_id: c.entity_id,
    action: c.action,
    timestamp: c.timestamp,
  };
  if (Array.isArray(c.fields) && !PUBLIC_TYPES_WITHOUT_FIELDS.has(c.entity_type)) entry.fields = c.fields;
  return entry;
}

/**
 * The change feed: what changed, newest first, one bounded page at a time.
 *
 * Public, anonymous, and polled by headless storefronts to decide what to
 * revalidate — so it must answer cheaply however large the install is, and
 * must keep answering the way those storefronts already expect.
 *
 *   ?since=<ISO>    only changes after this instant (exclusive). Optional —
 *                   a storefront that omits it gets the newest page, never a
 *                   400.
 *   ?limit=<n>      page size, 1–CHANGE_PAGE_MAX (1,000). Defaults to the
 *                   maximum, which is also the retention cap: a client that
 *                   has never heard of paging receives exactly what the
 *                   document drivers always returned, and never more.
 *   ?cursor=<c>     `meta.next_cursor` from the previous page, passed back
 *                   unchanged. Pages walk OLDER; stop when `meta.has_more` is
 *                   false.
 *
 * `meta.truncated` is true when retention has evicted a change this caller
 * would have been shown, inside the window it asked for — the one signal that a
 * poller fell behind, because counting entries cannot work (the retention cap
 * counts types the caller is never shown).
 *
 * It used to read the whole feed and filter afterwards. On the relational
 * driver — which never pruned, and wrote a full snapshot on every product and
 * order save — that was one full-table read per anonymous request. See
 * core/change-feed.ts for the three bounds that replaced it.
 */
export const GET: APIRoute = async ({ url, locals }) => {
  try {
    await LocalDB.init();
    // The registry has to be populated to answer visibility questions below.
    await ensurePluginsBootstrapped();
    const params = new URL(url).searchParams;
    // Echoed as sent. The store compares a normalised form (see
    // normalizeChangeSince), but `meta.since` has always been the caller's own
    // value, and a client comparing it to what it sent must keep matching.
    const since = params.get('since') || undefined;
    const limit = clampChangeLimit(params.get('limit'));

    let before: ChangeCursor | undefined;
    const rawCursor = params.get('cursor');
    if (rawCursor) {
      const decoded = decodeChangeCursor(rawCursor);
      // A 400, not a fresh first page. A paging client that sent a mangled
      // cursor and was quietly handed page one again would loop forever, and
      // re-revalidate the whole window on every lap. Only a client that pages
      // sends a cursor, so this cannot break one that does not.
      if (!decoded) {
        return ApiResponseBuilder.badRequest(
          'Invalid cursor: pass meta.next_cursor from the previous page back unchanged.',
        );
      }
      before = decoded;
    }

    const user = locals.user;
    const editorial = canSeeOthersDrafts(user);
    const page = await LocalDB.getContentChangesPage({
      since,
      before,
      limit,
      // Staff see every type (they run the shop and its forms); everyone else
      // gets the allow-list, applied inside the read.
      types: editorial ? undefined : publicChangeTypes(await isCommerceEnabled()),
      // Snapshots only for the editorial roles — and for nobody else are they
      // even read: on the relational driver they stay in the database.
      snapshots: editorial,
    });
    const payload = editorial ? page.items : page.items.map(publicEntry);

    return ApiResponseBuilder.success(payload, 'Content changes retrieved successfully', {
      since: since ?? null,
      count: payload.length,
      now: new Date().toISOString(),
      // Additive. A client that ignores these gets the same newest-first list
      // it always did; one that reads them can page.
      limit,
      has_more: page.hasMore,
      next_cursor: page.nextCursor ? encodeChangeCursor(page.nextCursor) : null,
      // Did retention evict something this caller would have been shown,
      // after its `since`? From the record of the caller's OWN types only — a
      // mark across every type would let anyone binary-search `since` for the
      // volume and timing of staff-only writes (recordPrunedChanges). On EVERY
      // page, so the last page of a walk also reports pruning that happened
      // while the walk was in progress. Additive, like the three above.
      truncated: isChangeWindowTruncated(page.prunedThrough, since),
    });
  } catch (err) {
    console.error('Content changes GET error:', err);
    return ApiResponseBuilder.serverError('Failed to fetch content changes');
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    await LocalDB.init();
    // Writing to the change feed is an editorial/bookkeeping action — read-only
    // viewers (and anonymous callers) may not inject records into it.
    const session = locals.user;
    if (!session || (session.role !== 'admin' && session.role !== 'editor')) {
      return ApiResponseBuilder.forbidden('Only admins and editors can record changes');
    }
    const body = await request.json().catch(() => null);
    const result = validate<{
      entity_type: 'post' | 'theme' | 'setting' | 'category' | 'user';
      entity_id: string;
      action: 'create' | 'update' | 'delete';
    }>(body, {
      entity_type: { type: 'enum', values: ['post', 'theme', 'setting', 'category', 'user'] },
      entity_id: { type: 'id' },
      action: { type: 'enum', values: ['create', 'update', 'delete'] },
    });
    if (!result.ok) return ApiResponseBuilder.validationError('Invalid payload', result.errors);
    const v = result.value;
    const change = await LocalDB.recordContentChange(
      v.entity_type,
      v.entity_id,
      v.action,
      (body as any)?.changes ?? null,
    );
    return ApiResponseBuilder.created(change, 'Content change recorded successfully');
  } catch (err) {
    console.error('Content changes POST error:', err);
    return ApiResponseBuilder.serverError('Failed to record content change');
  }
};
