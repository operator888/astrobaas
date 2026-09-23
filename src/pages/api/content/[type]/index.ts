import type { APIRoute } from 'astro';
import { LocalDB } from '../../../../lib/localdb';
import { ApiResponseBuilder } from '../../../../lib/api-response';
import { validate } from '../../../../lib/validate';
import {
  getContentType, schemaForSubmission, contentTypeIsPublic, contentTypeAcceptsPublicWrites,
} from '../../../../core/content-types';
import { ensurePluginsBootstrapped } from '../../../../plugins';
import { fireEvent } from '../../../../lib/webhooks';
import { publicSubmissionGate, spamFields } from '../../../../lib/public-submission';
import { checkReferences, resolveMediaUrls } from '../../../../lib/content-refs';
import { notifySubmission, submitterReplyTo } from '../../../../lib/submission-notify';
import { visibleEntries, initialStatus, STATUS_KEY } from '../../../../core/moderation';
import { boughtProduct } from '../../../../lib/commerce/order-lookup';
import { REVIEWS_TYPE } from '../../../../core/builtin-collections';
import { parseListPaging, pagingMeta, takePage } from '../../../../lib/list-paging';

import {
  TAXONOMIES_SETTING, TERMS_FIELD, validateTaxonomies, cleanTerms,
} from '../../../../core/taxonomy';

// Generic CRUD for plugin-registered custom content types. The collection and
// its field schema come from registerContentType(); records are validated
// against that schema and stored via the generic custom-entity storage.
//
// GET  /api/content/<type>        — list (public; read).
// POST /api/content/<type>        — create. Admin/editor by default; ANYONE
//                                   when the type declares writable: 'public',
//                                   which is what turns a content type into a
//                                   public form. CSRF via middleware either way.


export const GET: APIRoute = async ({ params, url, locals }) => {
  try {
    await LocalDB.init();
    await ensurePluginsBootstrapped();
    const type = String(params.type || '');
    const def = getContentType(type);
    if (!def) return ApiResponseBuilder.notFound('Content type');

    // D2-4: custom collections used to be world-readable with no way to say
    // otherwise. A type is now private unless it declares `visibility: 'public'`.
    //
    // 404 rather than 403, and the same 404 an unregistered type gets: whether
    // a private collection EXISTS is itself information. "job-application"
    // returning 403 while "nonsense" returns 404 tells an anonymous prober
    // which plugins are installed and what they store.
    if (!contentTypeIsPublic(def) && !locals.user) {
      return ApiResponseBuilder.notFound('Content type');
    }

    const stored = await LocalDB.getCustomEntities(type);
    // Per-record approval (C-142, C-35). `visibility` is collection-wide and
    // cannot express "the approved rows and not the pending ones", which is the
    // whole of comment and review moderation. Staff see every state, including
    // rejected — a queue that hides what it rejected cannot be reviewed.
    const all = visibleEntries(stored as { data?: Record<string, unknown> }[], {
      moderated: def.moderated === true,
      staff: Boolean(locals.user),
    }) as typeof stored;

    const sp = new URL(url).searchParams;

    // FIELD FILTERS (C-128, and what comments and reviews are built on).
    //
    // `?where.post_id=abc` narrows to records whose declared field holds that
    // value. Before this the endpoint took only limit/offset/page, so "the
    // comments on THIS post" meant fetching the whole collection and filtering
    // in the client — which on a shop with four thousand comments is four
    // thousand rows to render three.
    //
    // Deliberately narrow:
    //  · only DECLARED fields, so a filter cannot probe `_status` or any other
    //    key the server sets and reads as authority;
    //  · only equality, compared as strings. A query language here would need
    //    an evaluator on a schemaless store, and every operator it grew would
    //    be one more thing to get right on three drivers;
    //  · applied AFTER the visibility filter, so a filter can never widen what
    //    a caller may see.
    const declaredNames = new Set(def.fields.map((f) => f.name));
    const wheres: [string, string][] = [];
    for (const [key, value] of sp.entries()) {
      if (!key.startsWith('where.')) continue;
      const field = key.slice('where.'.length);
      // An undeclared name is IGNORED rather than an error: a storefront that
      // sends a stale filter should get the unfiltered list, not a 400 that
      // takes the page down. It cannot leak, because an ignored filter only
      // ever widens toward what the caller could already see.
      if (declaredNames.has(field)) wheres.push([field, value]);
    }
    const filtered = wheres.length === 0
      ? all
      : all.filter((e) => wheres.every(([field, want]) => {
        const v = (e as { data?: Record<string, unknown> }).data?.[field];
        // An array field matches if ANY item does — a `tags` filter asking for
        // one tag is the obvious reading, and the alternative (the whole array
        // stringified) matches nothing anybody would type.
        if (Array.isArray(v)) return v.some((item) => String(item) === want);
        return v !== undefined && v !== null && String(v) === want;
      }));

    // Same paging as /api/posts, from the same helper. With no `limit` the
    // page is capped at MAX_UNPAGED_ITEMS (1000): a comments collection with
    // no query string used to be resolved and serialised in full on every
    // anonymous request. See lib/list-paging.ts.
    const paging = parseListPaging(sp);
    const total = filtered.length;
    let items = takePage(filtered, paging);
    // After paging, so a page of twenty costs one media read rather than the
    // whole collection's worth.
    items = await resolveMediaUrls(def, items as { data?: Record<string, unknown> }[]) as typeof items;

    return ApiResponseBuilder.success(items, 'Entities retrieved successfully',
      pagingMeta(paging, items.length, total));
  } catch (err) {
    console.error('Custom content list error:', err);
    return ApiResponseBuilder.serverError('Failed to fetch entities');
  }
};

/**
 * `{ verified_buyer: true }` when this review's author actually bought the
 * product, otherwise `{}`.
 *
 * Returns an object rather than a boolean so the caller spreads it: a
 * `verified_buyer: false` on every unverified review is a column of falses that
 * makes the true ones no easier to find, and it invites a reader to treat the
 * absence of proof as proof of absence.
 */
async function verifiedBuyerStamp(
  type: string,
  values: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (type !== REVIEWS_TYPE) return {};
  try {
    const orders = await LocalDB.getOrders();
    return boughtProduct(orders, values.author_email, values.product_id)
      ? { verified_buyer: true }
      : {};
  } catch {
    // A commerce read that fails must not lose the review. An unstamped review
    // is the honest fallback: it claims nothing.
    return {};
  }
}

export const POST: APIRoute = async ({ params, request, locals }) => {
  try {
    await LocalDB.init();
    await ensurePluginsBootstrapped();
    const type = String(params.type || '');
    const def = getContentType(type);
    const session = locals.user;

    if (!def) return ApiResponseBuilder.notFound('Content type');

    // STAFF (admin/editor) always take the authoring path — a colleague typing
    // an entry in the admin is not a public submission and must not be stamped
    // submitted_at or made to pass the honeypot. This is checked FIRST, so it
    // wins for a public-write type too.
    const isStaff = session?.role === 'admin' || session?.role === 'editor';

    if (!isStaff && contentTypeAcceptsPublicWrites(def)) {
      // Everyone else on a public-write type — anonymous, OR a signed-in author
      // or viewer who filled in the public form — goes through the submission
      // path. The audit caught that a logged-in non-staff user was refused for
      // being logged in; the writable check running before the session gate is
      // the fix.
      return submitPublicly(def, type, request, locals);
    }

    if (!session) {
      // Anonymous, and the type did NOT open itself. 404 rather than 403, and
      // the same 404 an unregistered type gets: whether a collection exists is
      // itself information, and "job-application returns 403 while nonsense
      // returns 404" tells a prober what this site stores.
      return ApiResponseBuilder.notFound('Content type');
    }

    if (!isStaff) {
      return ApiResponseBuilder.forbidden('Only admins and editors can create content');
    }

    const body = await request.json().catch(() => null);
    // schemaForSubmission, not schemaForContentType: a field whose showIf
    // condition is not met is OPTIONAL for this record and its submitted value
    // is dropped. Without the first half a form that correctly hid a required
    // field answers "x is required" and cannot be submitted at all; without the
    // second, a caller fills in the branch it never took.
    const staffSub = schemaForSubmission(def, (body ?? {}) as Record<string, unknown>);
    const result = validate(staffSub.values, staffSub.schema);
    if (!result.ok) return ApiResponseBuilder.validationError(`Invalid ${def.label}`, result.errors);

    const dangling = await checkReferences(def, result.value as Record<string, unknown>);
    if (dangling) return ApiResponseBuilder.validationError(`Invalid ${def.label}`, dangling);

    // Custom taxonomies (C-128), on collections that declared they apply.
    //
    // `appliesTo` accepted `product` and any content type name, and only posts
    // and pages could ever carry a term — so the admin's term counter showed
    // "Ray-Ban (0)" permanently and no record outside those two could be filed
    // under anything. The definition said one thing and two write paths did
    // another.
    //
    // STAFF ONLY: the public submission path below deliberately does not read
    // terms. A stranger filling in a contact form has no business filing it
    // under a taxonomy, and the field would be one more thing to validate on
    // an anonymous surface.
    const taxonomyDefs = validateTaxonomies((await LocalDB.getSetting(TAXONOMIES_SETTING))?.value).defs;
    const cleanedTerms = cleanTerms((body as Record<string, unknown> | null)?.[TERMS_FIELD], taxonomyDefs, type);

    const created = await LocalDB.createCustomEntity(type, {
      ...(result.value as Record<string, any>),
      ...(cleanedTerms ? { [TERMS_FIELD]: cleanedTerms } : {}),
      // A colleague typing an entry IS the approval — see core/moderation.ts.
      ...(def.moderated ? { [STATUS_KEY]: initialStatus({ moderated: true, staff: true }) } : {}),
    });
    if (!created) return ApiResponseBuilder.serverError('Could not create entity');
    fireEvent('content.created', { type, entity: created }).catch(() => {});
    return ApiResponseBuilder.created(created, `${def.label} created successfully`);
  } catch (err) {
    console.error('Custom content create error:', err);
    return ApiResponseBuilder.serverError('Failed to create entity');
  }
};

/**
 * A submission from a stranger.
 *
 * Three gates, in the order that spends the least on the traffic most likely
 * to be junk: the rate limit first (no parsing), then the honeypot (no
 * hashing), then the proof-of-work.
 *
 * The stored record is built ONLY from the type's declared fields —
 * `validate()` copies nothing it was not asked for — so a submitter cannot
 * introduce a field, overwrite an id, or set a status the form does not have.
 */
async function submitPublicly(
  def: NonNullable<ReturnType<typeof getContentType>>,
  type: string,
  request: Request,
  locals: App.Locals,
): Promise<Response> {
  const body = await request.json().catch(() => null);
  const raw = (body && typeof body === 'object' && !Array.isArray(body))
    ? body as Record<string, unknown>
    : {};

  // ONE gate, shared with /api/contact and /api/newsletter. The three used to
  // be written separately and had drifted — see lib/public-submission.ts.
  const gate = await publicSubmissionGate({
    surface: type, ip: locals.ip ?? 'unknown', body: raw, captchaSurface: 'forms',
  });
  if (gate.kind === 'rate-limited') {
    return ApiResponseBuilder.error(429, 'Too many submissions. Please try again later.');
  }
  if (gate.kind === 'silent') {
    // The honeypot was filled. Success on purpose: a bot told it failed tries
    // again with the field removed, and the operator learns nothing either way.
    return ApiResponseBuilder.created({ id: null }, `${def.label} received`);
  }
  if (gate.kind === 'challenge-failed') {
    return ApiResponseBuilder.forbidden('Please try again (anti-spam check failed)');
  }

  // Same rule as the staff path above, and it matters more here: this is the
  // door a stranger's browser posts through, and the browser is not the only
  // thing that can. A hidden field's value is dropped rather than stored.
  const publicSub = schemaForSubmission(def, raw as Record<string, unknown>);
  const result = validate(publicSub.values, publicSub.schema);
  if (!result.ok) return ApiResponseBuilder.validationError(`Invalid ${def.label}`, result.errors);

  // A stranger may not point a record at something that does not exist — nor
  // probe for which ids DO exist by watching which references are accepted,
  // which is why this answers with the same shape as any other invalid field.
  const dangling = await checkReferences(def, result.value as Record<string, unknown>);
  if (dangling) return ApiResponseBuilder.validationError(`Invalid ${def.label}`, dangling);

  const created = await LocalDB.createCustomEntity(type, {
    ...(result.value as Record<string, any>),
    // Marks the record as having come from outside, which is what the admin
    // screen sorts on and what an operator needs to tell a form submission
    // from something a colleague typed. Set HERE, never taken from the body.
    submitted_at: new Date().toISOString(),
    // Pending, when the type asks for approval. Stamped HERE and never taken
    // from the body: `_status` is reserved precisely so a submitter cannot
    // post their own approval.
    ...(def.moderated ? { [STATUS_KEY]: 'pending' } : {}),
    // The verified-buyer stamp on a review (C-35). Server-side, always.
    //
    // `verified_buyer` is deliberately NOT a declared field, which is what
    // makes this safe: `validate()` copies nothing it was not asked for, so a
    // posted `verified_buyer: true` is already gone by the time we get here.
    // It is the only field on a review that means anything on its own — a
    // rating without it is a stranger's opinion.
    ...(await verifiedBuyerStamp(type, result.value as Record<string, unknown>)),
    // The spam score, and ONLY when there is something to say (C-79). Nothing
    // is rejected on it: the submission is stored and flagged so a person
    // decides. Rejecting on a heuristic means the one enquiry that mattered is
    // the one that vanished, and the sender was told it went through.
    ...spamFields(gate.spam),
  });
  if (!created) return ApiResponseBuilder.serverError('Could not save your submission');

  fireEvent('content.submitted', { type, entity: created }).catch(() => {});
  if (def.notifyOnSubmission) void notifyStaff(def, type, created);

  // The submitter is told it arrived and nothing else. Returning the stored
  // record would hand back whatever else lives on it — and on a type that is
  // publicly writable but not publicly readable, that is the whole point.
  return ApiResponseBuilder.created({ id: created.id }, `${def.label} received`);
}

/**
 * Tell somebody a submission arrived.
 *
 * Best-effort and fire-and-forget: a form that fails because the mail server
 * is down is a worse outcome than a notification nobody gets. The failure is
 * logged, and the entry is in the admin either way.
 */
async function notifyStaff(
  def: NonNullable<ReturnType<typeof getContentType>>,
  type: string,
  entity: Record<string, any>,
): Promise<void> {
  // Field VALUES are quoted as data, never interpolated into anything that
  // renders — the shared helper sends plain text only, so a submission
  // containing markup is just text. The field list comes from the DEFINITION,
  // not from the body, so nothing a submitter invented can appear here.
  //
  // createCustomEntity NESTS the field values under entity.data. Reading
  // entity[f.name] listed every field as empty, so every notification was
  // blank; the flat fallback covers a caller that passes the values directly.
  const fieldValues = (entity.data ?? entity) as Record<string, unknown>;
  // Reply-To: the first field the DEFINITION declares as an email address, so
  // the reply reaches whoever filled the form in. The validator has already
  // held the value to that rule; sendEmail checks it again before writing it
  // into a header, and falls back to EMAIL_REPLY_TO if it would not do.
  const submitter = submitterReplyTo(def.fields, fieldValues);
  await notifySubmission({
    what: `${def.label} submission`,
    fields: def.fields.map((f) => ({ name: f.name, value: fieldValues[f.name] })),
    whereToFind: `See it in the admin under Custom content → ${def.labelPlural ?? def.label}.`,
    ...(submitter ? { replyTo: submitter } : {}),
  });
}
