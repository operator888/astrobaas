#!/usr/bin/env node
/**
 * Product reviews, part 1 (C-35): text reviews, end to end.
 *
 * ## What must hold
 *
 *   - ONE public door (`POST /api/products/{ref}/reviews`): proof of work
 *     always required and single-use, honeypot, product must exist, be active
 *     and take reviews (site switch AND product switch), one review per address
 *     per product, and the SAME answer whatever happened — no oracle for "this
 *     address bought this product";
 *   - `verified_buyer` is computed by the server from PAID orders in state
 *     processing or completed, and never read from the body;
 *   - pending until approved (auto-approve for verified buyers only when the
 *     operator turns it on);
 *   - the public read returns approved reviews only and never an email — nor
 *     does the generic content read, nor the public change feed;
 *   - the generic `POST /api/content/review` door is CLOSED;
 *   - moderation (approve/reject/spam/pending/delete) is staff-only, bulk, and
 *     stamps `published_at` once;
 *   - GDPR: export includes reviews even when reviews are switched off;
 *     erasure keeps a published review's rating and drops the person, deletes
 *     unpublished ones, and tells a media module;
 *   - the media seam publishes only sanitised items, only when a module answers.
 *
 * The route half runs against all three storage drivers.
 *
 * Run with:  node tests/product-reviews.test.mjs
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTs, ROOT } from './lib/load.mjs';

function leadingZeroBits(digest, bits) {
  let remaining = bits;
  for (let i = 0; i < digest.length && remaining > 0; i++) {
    const take = Math.min(8, remaining);
    if (digest[i] >>> (8 - take) !== 0) return false;
    remaining -= take;
  }
  return remaining <= 0;
}
/** The honest solver — what /captcha.js does in a browser. */
function solve(token, bits) {
  for (let n = 0; n < 10_000_000; n++) {
    if (leadingZeroBits(crypto.createHash('sha256').update(`${token}.${n}`).digest(), bits)) return `${token}::${n}`;
  }
  throw new Error('unsolvable');
}

/* ---------------------------------------------------------------- child --- */
if (process.env.PRODUCT_REVIEWS_CHILD) {
  const entry = path.join(ROOT, 'node_modules', '.cache', `product-reviews-entry-${process.pid}.ts`);
  await fs.mkdir(path.dirname(entry), { recursive: true });
  const abs = (rel) => JSON.stringify(path.join(ROOT, rel));
  await fs.writeFile(entry, [
    `export { LocalDB } from ${abs('src/lib/localdb.ts')};`,
    `export { GET as reviewsGET, POST as reviewsPOST } from ${abs('src/pages/api/products/[id]/reviews.ts')};`,
    `export { GET as queueGET } from ${abs('src/pages/api/reviews/index.ts')};`,
    `export { POST as moderatePOST } from ${abs('src/pages/api/reviews/moderate.ts')};`,
    `export { GET as contentListGET, POST as contentPOST } from ${abs('src/pages/api/content/[type]/index.ts')};`,
    `export { GET as contentOneGET, PUT as contentPUT } from ${abs('src/pages/api/content/[type]/[id].ts')};`,
    `export { GET as changesGET } from ${abs('src/pages/api/content/changes.ts')};`,
    `export { GET as challengeGET } from ${abs('src/pages/api/captcha/challenge.ts')};`,
    `export { GET as productGET } from ${abs('src/pages/api/products/[id].ts')};`,
    `export { collectSubjectData, eraseSubject } from ${abs('src/lib/gdpr.ts')};`,
    `export { ensurePluginsBootstrapped } from ${abs('src/plugins/index.ts')};`,
    `export { pluginManager, PLUGIN_HOOKS } from ${abs('src/lib/plugin-system.ts')};`,
  ].join('\n'));
  let M;
  try {
    M = await loadTs(path.relative(ROOT, entry), 'productreviews');
  } finally {
    await fs.rm(entry, { force: true });
  }
  const { LocalDB } = M;
  await LocalDB.init();

  const out = [];
  const t = (name, cond, detail) => out.push([name, Boolean(cond), cond ? '' : JSON.stringify(detail ?? null)?.slice(0, 400)]);

  const call = async (handler, { method = 'GET', pathname, query = '', body, params = {}, user = null, ip = '10.0.0.1' }) => {
    const url = new URL(`http://cms.test${pathname}${query ? `?${query}` : ''}`);
    const init = { method, headers: { 'Content-Type': 'application/json' } };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await handler({ url, params, locals: { user, ip }, request: new Request(url, init) });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, body: json, text };
  };
  const ADMIN = { id: 'u-admin', role: 'admin', email: 'admin@shop.test', name: 'Admin' };
  const MANAGER = { id: 'u-mgr', role: 'manager', email: 'mgr@shop.test', name: 'Mgr' };
  const AUTHOR = { id: 'u-author', role: 'author', email: 'author@shop.test', name: 'Author' };

  const pow = async () => {
    const c = await call(M.challengeGET, { pathname: '/api/captcha/challenge', query: 'surface=reviews' });
    return c.body?.data?.enabled ? solve(c.body.data.token, c.body.data.bits) : null;
  };
  let ipN = 0;
  const submit = async (ref, fields, opts = {}) => {
    ipN += 1;
    const token = opts.noPow ? undefined : (opts.token ?? await pow());
    return call(M.reviewsPOST, {
      method: 'POST', pathname: `/api/products/${ref}/reviews`, params: { id: ref },
      body: { ...fields, ...(token ? { pow_token: token } : {}) }, ip: `10.2.${Math.floor(ipN / 200)}.${ipN % 200}`,
    });
  };
  const stored = async () => LocalDB.getCustomEntities('review');

  /* -- GDPR before the type is ever registered (reviews switched off) -- */
  {
    await LocalDB.createCustomEntity('review', {
      product_id: 'gone', author_name: 'Early', author_email: 'early@example.com', rating: 4, body: 'Written long ago', _status: 'approved',
    });
    const data = await M.collectSubjectData('Early@Example.com');
    t('GDPR: reviews are exported even while reviews are switched OFF (type not registered)',
      Array.isArray(data.reviews) && data.reviews.length === 1, data.reviews);
    t('GDPR: ...and not double-counted as a generic form submission',
      !data.submissions.some((g) => g.type === 'review'), data.submissions);
  }

  /* -- fixtures -- */
  const product = await LocalDB.createProduct({
    name: 'Round frames', slug: 'round-frames', status: 'active', price_cents: 9000, stock: 5, manage_stock: true, in_stock: true, categories: [],
  });
  const closed = await LocalDB.createProduct({
    name: 'No reviews here', slug: 'no-reviews', status: 'active', price_cents: 100, stock: 5, in_stock: true, categories: [], reviews_enabled: false,
  });
  const draft = await LocalDB.createProduct({
    name: 'Secret draft', slug: 'secret-draft', status: 'draft', price_cents: 100, stock: 5, in_stock: true, categories: [],
  });
  const other = await LocalDB.createProduct({
    name: 'Square frames', slug: 'square-frames', status: 'active', price_cents: 100, stock: 5, in_stock: true, categories: [],
  });
  const order = (number, email, status, payment_status, pid = product.id) => LocalDB.createOrder({
    number, status, payment_status, email, currency: 'EUR', total_cents: 9000, subtotal_cents: 9000,
    items: [{ product_id: pid, name: 'Line', qty: 1, total_cents: 9000 }],
  });
  await order('R-1', 'buyer@example.com', 'processing', 'paid');
  await order('R-2', 'cancelled@example.com', 'cancelled', 'paid');
  await order('R-3', 'unpaid@example.com', 'pending', 'unpaid');
  await order('R-4', 'done@example.com', 'completed', 'paid');
  await order('R-5', 'auto@example.com', 'completed', 'paid', other.id);

  /* -- site switch OFF: the door is shut -- */
  {
    const r = await submit(product.id, { rating: 5, author_name: 'A', author_email: 'a@example.com', body: 'Lovely frames' });
    t('site switch OFF: a submission is a 404', r.status === 404, r);
  }

  await LocalDB.updateSetting('reviews_enabled', true);
  await M.ensurePluginsBootstrapped();

  // A stand-in media module, to prove the seam and its bouncer.
  const removed = [];
  M.pluginManager.registerPlugin({
    id: 'test-review-media', name: 'Test media', version: '1.0.0', description: 'test',
    filters: {
      [M.PLUGIN_HOOKS.REVIEW_MEDIA]: (media, ctx) => (ctx.review.title === 'With photos'
        ? [...media,
          { kind: 'image', url: 'https://cdn.example.com/a.jpg', alt: 'Front' },
          { kind: 'image', url: 'javascript:alert(1)' },
          { kind: 'audio', url: 'https://cdn.example.com/a.mp3' },
          { kind: 'video', url: '/uploads/v.mp4', thumbnail_url: 'data:image/png;base64,xx' }]
        : media),
    },
    actions: {
      [M.PLUGIN_HOOKS.AFTER_REVIEW_DELETE]: (review, ctx) => { removed.push(`${review.id}:${ctx.reason}`); },
    },
  });
  M.pluginManager.activatePlugin('test-review-media');

  /* -- the gate -- */
  {
    const challenge = await call(M.challengeGET, { pathname: '/api/captcha/challenge', query: 'surface=reviews' });
    t('PoW: a challenge is minted for `reviews` with NO setting — always on', challenge.body?.data?.enabled === true, challenge.body);

    const noPow = await submit(product.id, { rating: 5, author_name: 'A', author_email: 'nopow@example.com', body: 'No proof' }, { noPow: true });
    t('PoW: a submission without a proof is refused (403)', noPow.status === 403, noPow);

    const token = await pow();
    const first = await submit(product.id, { rating: 5, author_name: 'Buyer', author_email: 'Buyer@Example.com', body: 'Great fit, would buy again.', title: 'Love them', verified_buyer: false, _status: 'approved', locale: 'xx-nonsense' }, { token });
    t('submit: 201 { received: true }, nothing else', first.status === 201
      && JSON.stringify(first.body?.data) === JSON.stringify({ received: true }), first);
    const replay = await submit(product.id, { rating: 5, author_name: 'R', author_email: 'replay@example.com', body: 'Replayed proof' }, { token });
    t('PoW: a solved proof is single-use (replay refused)', replay.status === 403, replay);

    const hp = await submit(product.id, { rating: 5, author_name: 'Bot', author_email: 'bot@example.com', body: 'Buy pills', hp_url: 'http://spam' });
    t('honeypot: the bot is told SUCCESS, identically', hp.status === 201 && JSON.stringify(hp.body) === JSON.stringify(first.body), hp);

    const rows = await stored();
    const mine = rows.find((r) => r.data?.author_email === 'buyer@example.com');
    t('stored: pending, whatever the body said about _status', mine?.data?._status === 'pending', mine?.data);
    t('stored: verified_buyer computed TRUE from a paid, processing order (the body said false)', mine?.data?.verified_buyer === true, mine?.data);
    t('stored: the email is normalised', !!mine);
    t('stored: an unknown locale becomes the site default', mine?.data?.locale === 'en', mine?.data?.locale);
    t('stored: the honeypot hit stored nothing', !rows.some((r) => r.data?.author_email === 'bot@example.com'));
    t('stored: the replay stored nothing', !rows.some((r) => r.data?.author_email === 'replay@example.com'));

    const forged = await submit(product.id, { rating: 4, author_name: 'Liar', author_email: 'unpaid@example.com', body: 'I totally bought it', verified_buyer: true });
    const cancelled = await submit(product.id, { rating: 2, author_name: 'C', author_email: 'cancelled@example.com', body: 'Paid then cancelled' });
    const done = await submit(product.id, { rating: 3, author_name: 'D', author_email: 'done@example.com', body: 'Completed order' });
    const rows2 = await stored();
    const by = (e) => rows2.find((r) => r.data?.author_email === e)?.data;
    t('verified: an UNPAID order proves nothing, and a posted verified_buyer:true is dropped',
      forged.status === 201 && by('unpaid@example.com') && by('unpaid@example.com').verified_buyer === undefined, by('unpaid@example.com'));
    t('verified: a paid-then-CANCELLED order proves nothing', cancelled.status === 201 && by('cancelled@example.com')?.verified_buyer === undefined, by('cancelled@example.com'));
    t('verified: a paid COMPLETED order counts', done.status === 201 && by('done@example.com')?.verified_buyer === true, by('done@example.com'));

    const before = (await stored()).length;
    const dup = await submit(product.id, { rating: 1, author_name: 'Buyer again', author_email: 'buyer@example.com', body: 'Changed my mind' });
    t('duplicate: same address, same product — the SAME answer, and nothing stored',
      dup.status === 201 && JSON.stringify(dup.body) === JSON.stringify(first.body) && (await stored()).length === before, dup);

    const bad = await submit(product.id, { rating: 6, author_name: 'X', author_email: 'x@example.com', body: 'Six stars' });
    t('validation: a rating of 6 is refused by the rule (422)', bad.status === 422, bad);
    const frac = await submit(product.id, { rating: 4.5, author_name: 'X', author_email: 'x@example.com', body: 'Four and a half' });
    t('validation: a fractional rating is refused', frac.status === 422, frac);
    const noMail = await submit(product.id, { rating: 4, author_name: 'X', body: 'No email given' });
    t('validation: the email is required on the public door', noMail.status === 422, noMail);

    const off = await submit(closed.id, { rating: 5, author_name: 'X', author_email: 'x@example.com', body: 'Closed product' });
    t('product switch: reviews_enabled:false is a 404', off.status === 404, off);
    const dr = await submit(draft.id, { rating: 5, author_name: 'X', author_email: 'x@example.com', body: 'Draft product' });
    t('a DRAFT product is the same 404 (no existence oracle)', dr.status === 404, dr);
    const ghost = await submit('no-such-product', { rating: 5, author_name: 'X', author_email: 'x@example.com', body: 'Ghost' });
    t('an unknown product is the same 404', ghost.status === 404, ghost);
    const bySlug = await submit('round-frames', { rating: 4, author_name: 'Slug', author_email: 'slug@example.com', body: 'Found by slug', title: 'With photos' });
    t('the product may be named by its slug', bySlug.status === 201, bySlug);
  }

  /* -- the generic door is closed -- */
  {
    const r = await call(M.contentPOST, {
      method: 'POST', pathname: '/api/content/review', params: { type: 'review' },
      body: { product_id: product.id, author_name: 'Side door', author_email: 's@example.com', rating: 5, body: 'Through the side door' },
    });
    t('POST /api/content/review (anonymous) is a 404 — the side door is shut', r.status === 404, r);
    t('...and stored nothing', !(await stored()).some((x) => x.data?.author_email === 's@example.com'));
  }

  /* -- reading, before and after approval -- */
  {
    const pub0 = await call(M.reviewsGET, { pathname: `/api/products/${product.id}/reviews`, params: { id: product.id } });
    t('public read: pending reviews are NOT listed', pub0.status === 200 && pub0.body?.data?.reviews?.length === 0, pub0.body);
    t('public read: accepting_reviews is true', pub0.body?.data?.accepting_reviews === true);

    // An author may not moderate.
    const ids = (await stored()).filter((r) => r.data?.product_id === product.id).map((r) => r.id);
    const denied = await call(M.moderatePOST, { method: 'POST', pathname: '/api/reviews/moderate', body: { ids, action: 'approve' }, user: AUTHOR });
    t('moderate: an AUTHOR is refused (403)', denied.status === 403, denied);
    const anon = await call(M.moderatePOST, { method: 'POST', pathname: '/api/reviews/moderate', body: { ids, action: 'approve' } });
    t('moderate: anonymous is refused (401)', anon.status === 401, anon);
    const junk = await call(M.moderatePOST, { method: 'POST', pathname: '/api/reviews/moderate', body: { ids, action: 'publish-everything' }, user: ADMIN });
    t('moderate: an unknown action is a 422', junk.status === 422, junk);

    const approve = await call(M.moderatePOST, { method: 'POST', pathname: '/api/reviews/moderate', body: { ids: [...ids, 'ghost-id'], action: 'approve' }, user: MANAGER });
    t('moderate: a MANAGER approves in bulk; an unknown id is reported, not fatal',
      approve.status === 200 && approve.body?.data?.updated?.length === ids.length
        && JSON.stringify(approve.body?.data?.missing) === '["ghost-id"]', approve.body);
    const after = await stored();
    const firstPublished = after.find((r) => r.data?.author_email === 'buyer@example.com')?.data?.published_at;
    t('moderate: approval stamps published_at and moderated_at', !!firstPublished && !!after[0]?.data?.moderated_at || after.some((r) => r.data?.moderated_at), firstPublished);

    const pub = await call(M.reviewsGET, { pathname: `/api/products/round-frames/reviews`, params: { id: 'round-frames' } });
    const list = pub.body?.data?.reviews ?? [];
    t('public read: approved reviews are listed (by slug too)', pub.status === 200 && list.length === ids.length, pub.body);
    t('public read: NO email, order number, spam score or moderation state anywhere in the response',
      !/@example\.com/.test(pub.text) && !pub.text.includes('_status') && !pub.text.includes('order_number') && !pub.text.includes('spam_'), pub.text.slice(0, 300));
    const agg = pub.body?.data?.aggregate;
    // ratings: buyer 5, unpaid 4, cancelled 2, done 3, slug 4
    t('aggregate: count, average to one decimal, and the count per star',
      agg?.count === 5 && agg?.average === 3.6 && agg?.histogram?.['4'] === 2 && agg?.histogram?.['1'] === 0, agg);
    const fives = await call(M.reviewsGET, { pathname: `/api/products/${product.id}/reviews`, query: 'rating=4', params: { id: product.id } });
    t('public read: ?rating= filters', fives.body?.data?.reviews?.length === 2 && fives.body.data.reviews.every((r) => r.rating === 4), fives.body?.data?.reviews);
    const ver = await call(M.reviewsGET, { pathname: `/api/products/${product.id}/reviews`, query: 'verified=1', params: { id: product.id } });
    t('public read: ?verified=1 filters to verified buyers', ver.body?.data?.reviews?.length === 2 && ver.body.data.reviews.every((r) => r.verified_buyer === true));
    const paged = await call(M.reviewsGET, { pathname: `/api/products/${product.id}/reviews`, query: 'limit=2&page=2&sort=rating_desc', params: { id: product.id } });
    t('public read: paged, with the total before paging', paged.body?.data?.reviews?.length === 2 && paged.body?.meta?.total === 5
      && paged.body.data.reviews[0].rating === 4, paged.body);
    const withMedia = list.find((r) => r.title === 'With photos');
    t('media seam: a module\'s items are attached, SANITISED (unsafe URL, unknown kind, data: thumb dropped)',
      JSON.stringify(withMedia?.media) === JSON.stringify([
        { kind: 'image', url: 'https://cdn.example.com/a.jpg', alt: 'Front' },
        { kind: 'video', url: '/uploads/v.mp4' },
      ]), withMedia);
    t('media seam: a review the module says nothing about carries no `media` key', list.filter((r) => r.title !== 'With photos').every((r) => !('media' in r)));

    const draftRead = await call(M.reviewsGET, { pathname: `/api/products/${draft.id}/reviews`, params: { id: draft.id } });
    t('public read: a draft product is a 404', draftRead.status === 404);

    // The generic read of the collection, anonymous: approved rows, no email.
    const generic = await call(M.contentListGET, { pathname: '/api/content/review', params: { type: 'review' } });
    t('GET /api/content/review (anonymous): rows are returned...', generic.status === 200 && (generic.body?.data?.length ?? 0) >= 5, generic.status);
    t('...WITHOUT author_email or order_number (private fields)', !generic.text.includes('author_email') && !/@example\.com/.test(generic.text), generic.text.slice(0, 300));
    const oneId = list[0]?.id;
    const genericOne = await call(M.contentOneGET, { pathname: `/api/content/review/${oneId}`, params: { type: 'review', id: oneId } });
    t('GET /api/content/review/{id} (anonymous): no email either', genericOne.status === 200 && !genericOne.text.includes('author_email'), genericOne.text.slice(0, 200));
    const staffOne = await call(M.contentOneGET, { pathname: `/api/content/review/${oneId}`, params: { type: 'review', id: oneId }, user: ADMIN });
    t('...while an admin still sees it', staffOne.text.includes('author_email'));

    // The PUBLIC change feed.
    const feed = await call(M.changesGET, { pathname: '/api/content/changes', query: 'limit=1000' });
    // A moderated collection is NOT in the anonymous feed: its rows are written
    // on arrival, pending and spam included, and a missing `create` would tell
    // a poller that a submission was dropped as a duplicate.
    t('public change feed: NO review rows at all for an anonymous poller', feed.status === 200 && !feed.body?.data?.some((c) => c.entity_type === 'review'), feed.text.slice(0, 300));
    t('...and NO reviewer email reaches it', !/@example\.com/.test(feed.text), feed.text.slice(0, 300));
    const staffFeed = await call(M.changesGET, { pathname: '/api/content/changes', query: 'limit=1000', user: ADMIN });
    t('...while staff still see review changes', staffFeed.body?.data?.some((c) => c.entity_type === 'review'));

    // A private field cannot be FILTERED on by someone who cannot read it.
    const all = await call(M.contentListGET, { pathname: '/api/content/review', params: { type: 'review' } });
    const probe = await call(M.contentListGET, { pathname: '/api/content/review', query: 'where.author_email=done%40example.com', params: { type: 'review' } });
    t('where.author_email is IGNORED for an anonymous caller (no "did this address review?" answer)',
      probe.body?.meta?.total === all.body?.meta?.total && all.body?.meta?.total >= 2, [probe.body?.meta, all.body?.meta]);
    const probe2 = await call(M.contentListGET, { pathname: '/api/content/review', query: 'where.order_number=R-4', params: { type: 'review' } });
    t('where.order_number is ignored too', probe2.body?.meta?.total === all.body?.meta?.total);
    const staffProbe = await call(M.contentListGET, { pathname: '/api/content/review', query: 'where.author_email=done%40example.com', params: { type: 'review' }, user: ADMIN });
    t('...while staff can filter on it', staffProbe.body?.meta?.total === 1, staffProbe.body?.meta);
    t('the generic public read carries no spam signal', !generic.text.includes('spam_'));

    // The staff queue.
    const q = await call(M.queueGET, { pathname: '/api/reviews', query: 'status=all', user: MANAGER });
    t('queue: staff see every row WITH the email, and per-state counts',
      q.status === 200 && q.text.includes('buyer@example.com') && q.body?.meta?.counts?.approved >= 5, q.body?.meta);
    t('queue: product names for the page', q.body?.meta?.products?.[product.id] === 'Round frames', q.body?.meta?.products);
    const qa = await call(M.queueGET, { pathname: '/api/reviews', user: AUTHOR });
    t('queue: an author is refused', qa.status === 403);
    const qv = await call(M.queueGET, { pathname: '/api/reviews', query: 'status=approved&verified=yes', user: ADMIN });
    t('queue: filters (status + verified)', qv.body?.data?.length === 2, qv.body?.data?.length);

    // Spam, re-queue, published_at is NOT re-stamped.
    const buyerRow = (await stored()).find((r) => r.data?.author_email === 'buyer@example.com');
    await call(M.moderatePOST, { method: 'POST', pathname: '/api/reviews/moderate', body: { ids: [buyerRow.id], action: 'spam' }, user: ADMIN });
    const pub2 = await call(M.reviewsGET, { pathname: `/api/products/${product.id}/reviews`, params: { id: product.id } });
    t('spam: a review marked spam leaves the public list and the aggregate',
      pub2.body?.data?.reviews?.length === 4 && pub2.body?.data?.aggregate?.count === 4, pub2.body?.data?.aggregate);
    await new Promise((r) => setTimeout(r, 15));
    await call(M.moderatePOST, { method: 'POST', pathname: '/api/reviews/moderate', body: { ids: [buyerRow.id], action: 'approve' }, user: ADMIN });
    const again = (await LocalDB.getCustomEntity('review', buyerRow.id))?.data;
    t('re-approval keeps the FIRST published_at', again?.published_at === firstPublished && again?._status === 'approved', again);
    t('spam via the generic PUT is accepted too (one state list)', (await call(M.contentPUT, {
      method: 'PUT', pathname: `/api/content/review/${buyerRow.id}`, params: { type: 'review', id: buyerRow.id }, body: { _status: 'spam' }, user: ADMIN,
    })).status === 200);
    const viaPut = (await LocalDB.getCustomEntity('review', buyerRow.id))?.data;
    t('...and stamps moderated_at the same way the queue does', viaPut?._status === 'spam' && viaPut?.published_at === firstPublished && !!viaPut?.moderated_at, viaPut);
    await call(M.moderatePOST, { method: 'POST', pathname: '/api/reviews/moderate', body: { ids: [buyerRow.id], action: 'approve' }, user: ADMIN });
  }

  /* -- auto-approve: off by default, then on; the answer never changes -- */
  {
    const firstAnswer = await submit(other.id, { rating: 5, author_name: 'Pending', author_email: 'stranger@example.com', body: 'Not a buyer here' });
    await LocalDB.updateSetting('reviews_auto_approve_verified', true);
    const auto = await submit(other.id, { rating: 5, author_name: 'Auto', author_email: 'auto@example.com', body: 'Bought these, love them' });
    const notVerified = await submit(other.id, { rating: 1, author_name: 'Nope', author_email: 'nobody@example.com', body: 'Never bought them' });
    const rows = await stored();
    const st = (e) => rows.find((r) => r.data?.author_email === e)?.data?._status;
    t('auto-approve ON: a verified buyer is published at once', st('auto@example.com') === 'approved', st('auto@example.com'));
    t('auto-approve ON: an unverified review still waits', st('nobody@example.com') === 'pending');
    t('auto-approve ON: the stranger before it was pending (off by default)', st('stranger@example.com') === 'pending');
    t('NO ORACLE: published-at-once and pending answer byte-identically',
      auto.status === notVerified.status && JSON.stringify(auto.body) === JSON.stringify(notVerified.body)
      && JSON.stringify(auto.body) === JSON.stringify(firstAnswer.body), [auto.body, notVerified.body]);
    await LocalDB.updateSetting('reviews_auto_approve_verified', false);
  }

  /* -- delete tells the media module -- */
  {
    const victim = (await stored()).find((r) => r.data?.author_email === 'nobody@example.com');
    const del = await call(M.moderatePOST, { method: 'POST', pathname: '/api/reviews/moderate', body: { ids: [victim.id], action: 'delete' }, user: ADMIN });
    t('delete: the row is gone', del.status === 200 && !(await LocalDB.getCustomEntity('review', victim.id)));
    t('delete: AFTER_REVIEW_DELETE fired with reason "deleted"', removed.includes(`${victim.id}:deleted`), removed);
  }

  /* -- GDPR erasure -- */
  {
    const aggBefore = (await call(M.reviewsGET, { pathname: `/api/products/${product.id}/reviews`, params: { id: product.id } })).body?.data?.aggregate;
    // A second, unpublished review by the same person, on another product.
    await LocalDB.createCustomEntity('review', {
      product_id: other.id, author_name: 'Buyer', author_email: 'buyer@example.com', rating: 1, body: 'Pending one', _status: 'pending',
    });
    const exp = await M.collectSubjectData('buyer@example.com');
    t('GDPR export: both of the person\'s reviews, any state', exp.reviews.length === 2, exp.reviews.length);
    const published = exp.reviews.find((r) => r.data?._status === 'approved');
    const report = await M.eraseSubject('buyer@example.com');
    t('GDPR erase: one anonymised, one deleted, reported', report.reviewsAnonymised === 1 && report.deleted.reviews === 1, report);
    const kept = await LocalDB.getCustomEntity('review', published.id);
    t('GDPR erase: the published review keeps its rating and product...', kept?.data?.rating === 5 && kept?.data?.product_id === product.id, kept?.data);
    t('...and loses name, email, title, body and order number',
      ['author_name', 'author_email', 'title', 'body', 'order_number'].every((k) => kept?.data?.[k] === undefined) && typeof kept?.data?.erased_at === 'string', kept?.data);
    const aggAfter = (await call(M.reviewsGET, { pathname: `/api/products/${product.id}/reviews`, params: { id: product.id } })).body;
    t('GDPR erase: the aggregate does NOT move', JSON.stringify(aggAfter?.data?.aggregate) === JSON.stringify(aggBefore), [aggBefore, aggAfter?.data?.aggregate]);
    t('GDPR erase: the anonymised review is no longer LISTED', !aggAfter?.data?.reviews?.some((r) => r.id === published.id));
    t('GDPR erase: the media module was told, for both', removed.filter((x) => x.endsWith(':erased')).length === 2, removed);
    const exp2 = await M.collectSubjectData('buyer@example.com');
    t('GDPR: a second export finds nothing', exp2.reviews.length === 0);
    const feed = await call(M.changesGET, { pathname: '/api/content/changes', query: 'limit=1000', user: ADMIN });
    t('GDPR erase: no change-feed snapshot (even the staff one) still holds the address', !feed.text.includes('buyer@example.com'));
  }

  /* -- the site switch reaches EVERY public reader -- */
  {
    const on = await call(M.productGET, { pathname: `/api/products/${product.id}`, params: { id: product.id } });
    t('product route: aggregateRating present while reviews are on', on.status === 200 && on.text.includes('AggregateRating'), on.text.slice(0, 200));
    await LocalDB.updateSetting('reviews_enabled', false);
    const off = await call(M.productGET, { pathname: `/api/products/${product.id}`, params: { id: product.id } });
    const offList = await call(M.reviewsGET, { pathname: `/api/products/${product.id}/reviews`, params: { id: product.id } });
    t('site switch OFF: no aggregateRating from rows collected before', off.status === 200 && !off.text.includes('AggregateRating'), off.text.slice(0, 200));
    t('site switch OFF: the reviews route agrees (count 0, not accepting)',
      offList.body?.data?.aggregate?.count === 0 && offList.body?.data?.accepting_reviews === false, offList.body?.data);
  }

  console.log('__RESULT__' + JSON.stringify(out));
  process.exit(0);
}

/* --------------------------------------------------------------- parent --- */
let pass = 0;
let fail = 0;
const check = (n, c, detail) => { if (c) pass++; else { fail++; console.error(`✗ ${n}${detail ? `\n    ${detail}` : ''}`); } };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ---- pure rules ---- */
{
  const R = await loadTs('src/lib/reviews.ts');
  const O = await loadTs('src/lib/commerce/order-lookup.ts');
  const B = await loadTs('src/core/builtin-collections.ts');

  // The gate.
  const on = { [B.REVIEWS_ENABLED_SETTING]: true };
  check('open: site on, active product, no product flag', R.reviewsOpenFor(on, { status: 'active' }) === true);
  check('closed: site switch off (the default)', R.reviewsOpenFor({}, { status: 'active' }) === false);
  check('closed: site switch stored as the STRING "false"', R.reviewsOpenFor({ reviews_enabled: 'false' }, { status: 'active' }) === false);
  check('closed: the product said no', R.reviewsOpenFor(on, { status: 'active', reviews_enabled: false }) === false);
  check('closed: a draft', R.reviewsOpenFor(on, { status: 'draft' }) === false);
  check('closed: no product', R.reviewsOpenFor(on, null) === false);

  // Verified buyer, by order state.
  const o = (status, payment_status, email = 'a@x.com') => ({ email, status, payment_status, items: [{ product_id: 'p' }] });
  check('verified: paid + processing', O.boughtProduct([o('processing', 'paid')], 'a@x.com', 'p') === true);
  check('verified: paid + completed', O.boughtProduct([o('completed', 'paid')], 'A@X.com ', 'p') === true);
  for (const s of ['cancelled', 'refunded', 'on-hold', 'failed', 'pending']) {
    check(`NOT verified: paid + ${s}`, O.boughtProduct([o(s, 'paid')], 'a@x.com', 'p') === false);
  }
  check('NOT verified: completed but unpaid', O.boughtProduct([o('completed', 'unpaid')], 'a@x.com', 'p') === false);
  check('NOT verified: another product', O.boughtProduct([o('completed', 'paid')], 'a@x.com', 'q') === false);

  // Validation.
  const v = R.validateReviewSubmission({ product_id: 'other', rating: 5, author_name: 'A', author_email: ' A@X.com ', body: 'Good', verified_buyer: true, _status: 'approved', media: [{ url: 'x' }] }, 'p1');
  check('validate: the product id comes from the PATH, not the body', v.ok && v.value.product_id === 'p1');
  check('validate: verified_buyer, _status and media are DROPPED', v.ok && !('verified_buyer' in v.value) && !('_status' in v.value) && !('media' in v.value));
  check('validate: the email is normalised', v.ok && v.value.author_email === 'a@x.com');
  check('validate: the email is required here', !R.validateReviewSubmission({ rating: 5, author_name: 'A', body: 'Good' }, 'p1').ok);
  for (const rating of [0, 6, 2.5, 'five', null, -1]) {
    check(`validate: rating ${JSON.stringify(rating)} refused`, !R.validateReviewSubmission({ rating, author_name: 'A', author_email: 'a@x.com', body: 'Good' }, 'p1').ok);
  }
  check('validate: an over-long title is refused', !R.validateReviewSubmission({ rating: 5, author_name: 'A', author_email: 'a@x.com', body: 'Good', title: 'x'.repeat(121) }, 'p1').ok);
  check('validate: an over-long body is refused', !R.validateReviewSubmission({ rating: 5, author_name: 'A', author_email: 'a@x.com', body: 'x'.repeat(4001) }, 'p1').ok);

  // Duplicates.
  const row = (id, data) => ({ id, data, created_at: `2026-01-0${id.length}T00:00:00Z` });
  const rows = [row('a', { product_id: 'p', author_email: 'a@x.com', _status: 'rejected' })];
  check('duplicate: a REJECTED review may be rewritten', R.alreadyReviewed(rows, 'a@x.com', 'p') === false);
  check('duplicate: a pending one may not', R.alreadyReviewed([row('a', { product_id: 'p', author_email: 'a@x.com', _status: 'pending' })], 'a@x.com', 'p') === true);
  check('duplicate: spam counts as already reviewed', R.alreadyReviewed([row('a', { product_id: 'p', author_email: 'A@x.com', _status: 'spam' })], 'a@x.com', 'p') === true);
  check('duplicate: per product', R.alreadyReviewed([row('a', { product_id: 'q', author_email: 'a@x.com', _status: 'pending' })], 'a@x.com', 'p') === false);

  // The allow-list projection.
  const pub = R.toPublicReview({ id: 'r1', created_at: '2026-01-01T00:00:00Z', data: {
    product_id: 'p', rating: 4, body: 'Nice', author_name: 'A', author_email: 'a@x.com', order_number: 'N-1',
    _status: 'approved', spam_score: 7, spam_flagged: true, spam_reasons: ['links'], verified_buyer: true, locale: 'el', submitted_at: '2026-01-02T00:00:00Z', future_secret: 'x',
  } });
  check('public projection: an ALLOW-list — nothing private, nothing unknown',
    eq(Object.keys(pub).sort(), ['author_name', 'body', 'created_at', 'id', 'locale', 'product_id', 'rating', 'verified_buyer']), Object.keys(pub));
  check('public projection: created_at is the submission time', pub.created_at === '2026-01-02T00:00:00Z');

  // The list and the aggregate.
  const lr = [
    row('a', { product_id: 'p', rating: 5, _status: 'approved', submitted_at: '2026-01-01' }),
    row('bb', { product_id: 'p', rating: 3, _status: 'approved', submitted_at: '2026-01-03' }),
    row('ccc', { product_id: 'p', rating: 1, _status: 'pending', submitted_at: '2026-01-04' }),
    row('dddd', { product_id: 'p', rating: 4, _status: 'approved', erased_at: '2026-02-01', submitted_at: '2026-01-02' }),
    row('eeeee', { product_id: 'q', rating: 2, _status: 'approved' }),
    row('ffffff', { product_id: 'p', rating: 2, _status: 'spam' }),
  ];
  const q = R.parsePublicReviewQuery(new URLSearchParams(''));
  const listed = R.publicReviewList(lr, 'p', q);
  check('list: approved, not erased, this product, newest first', eq(listed.items.map((r) => r.id), ['bb', 'a']) && listed.total === 2, listed.items.map((r) => r.id));
  const agg = R.reviewAggregate(lr, 'p');
  check('aggregate: the ERASED review still counts (its rating was kept)', agg.count === 3 && agg.average === 4, agg);
  check('query: nonsense is ignored, never an error', eq(R.parsePublicReviewQuery(new URLSearchParams('rating=9&sort=evil&limit=-3')), { sort: 'recent', limit: 10, offset: 0 }));
  check('query: limit is capped at 50', R.parsePublicReviewQuery(new URLSearchParams('limit=5000')).limit === 50);

  // The admin side.
  check('admin query: opens on PENDING', R.parseAdminReviewQuery(new URLSearchParams('')).status === 'pending');
  check('admin query: an unknown status falls back to pending', R.parseAdminReviewQuery(new URLSearchParams('status=deleted')).status === 'pending');
  check('admin query: spam is a status', R.parseAdminReviewQuery(new URLSearchParams('status=spam')).status === 'spam');
  check('counts: every state', eq(R.reviewStatusCounts(lr), { pending: 1, approved: 4, rejected: 0, spam: 1 }), R.reviewStatusCounts(lr));
  for (const a of R.REVIEW_ACTIONS) {
    let threw = false;
    try { R.stateForAction(a); } catch { threw = true; }
    check(`every action maps to a state or delete: ${a}`, !threw);
  }
  check('only "delete" deletes', R.REVIEW_ACTIONS.filter((a) => R.stateForAction(a) === null).join() === 'delete');

  const p1 = R.reviewModerationPatch({ _status: 'pending' }, 'approved', 'T1');
  check('approve: stamps published_at and moderated_at', p1._status === 'approved' && p1.published_at === 'T1' && p1.moderated_at === 'T1');
  const p2 = R.reviewModerationPatch({ _status: 'rejected', published_at: 'T1' }, 'approved', 'T2');
  check('re-approve: published_at is NOT re-stamped', !('published_at' in p2) && p2.moderated_at === 'T2');
  check('no change: no patch', eq(R.reviewModerationPatch({ _status: 'spam' }, 'spam', 'T3'), {}));

  // The media bouncer.
  check('media: non-array is nothing', eq(R.sanitiseReviewMedia(null), []) && eq(R.sanitiseReviewMedia({ kind: 'image' }), []));
  check('media: protocol-relative URLs are refused', eq(R.sanitiseReviewMedia([{ kind: 'image', url: '//evil.example/x.png' }]), []));
  check('media: capped', R.sanitiseReviewMedia(Array.from({ length: 40 }, () => ({ kind: 'image', url: '/a.jpg' }))).length === 12);

  // The erasure patch.
  const anon = R.anonymisedReviewPatch('T');
  check('erasure patch: removes every personal field and keeps the rating',
    ['author_name', 'author_email', 'order_number', 'title', 'body'].every((k) => k in anon && anon[k] === undefined)
      && !('rating' in anon) && !('product_id' in anon) && anon.erased_at === 'T');
}

/* ---- captcha: `reviews` is always on and not on the operator's tick-list ---- */
{
  const C = await loadTs('src/lib/captcha.ts');
  check('captcha: `reviews` is a surface the challenge endpoint accepts', C.isCaptchaSurface('reviews') === true);
  check('captcha: ...but NOT a setting an operator can untick', !C.CAPTCHA_SURFACES.includes('reviews'));
  check('captcha: a setting naming it changes nothing', !C.resolveCaptchaSurfaces({ captcha_surfaces: ['reviews'] }).has('reviews'));
  check('captcha: unknown surfaces still refused', C.isCaptchaSurface('nonsense') === false);
}

/* ---- the attention card, the screen's access rule, the nav link ---- */
{
  const A = await loadTs('src/lib/admin/attention.ts');
  const ctx = (over) => ({ settings: {}, commerceEnabled: true, role: 'manager', pendingReviews: { count: 3, oldest: '2026-01-01T00:00:00Z' }, ...over });
  const card = A.runAttention(ctx({})).find((c) => c.id === 'pending-reviews');
  check('attention: waiting reviews raise a card for a manager', card?.params?.count === 3 && card?.action?.href === '/admin/reviews' && card?.since === '2026-01-01T00:00:00Z', card);
  check('attention: none waiting, no card', !A.runAttention(ctx({ pendingReviews: { count: 0 } })).some((c) => c.id === 'pending-reviews'));
  check('attention: commerce off, no card', !A.runAttention(ctx({ commerceEnabled: false })).some((c) => c.id === 'pending-reviews'));
  check('attention: an AUTHOR (who cannot open the queue) is not shown it', !A.runAttention(ctx({ role: 'author' })).some((c) => c.id === 'pending-reviews'));

  const AA = await loadTs('src/lib/admin-access.ts');
  for (const [role, want] of [['admin', true], ['editor', true], ['manager', true], ['author', false], [undefined, false]]) {
    check(`/admin/reviews for ${role}: ${want}`, AA.canOpenAdminPage('/admin/reviews', role) === want);
  }

  // The translations behind the card exist in every locale.
  for (const loc of ['en', 'el', 'de']) {
    const L = await loadTs(`src/locales/${loc}/attention.ts`);
    const cat = L.attention;
    check(`attention text in ${loc}`, ['title', 'body', 'action'].every((k) => typeof cat[`admin.attention.pending-reviews.${k}`] === 'string'));
  }
  const en = (await loadTs('src/locales/en/reviews.ts')).reviews;
  for (const loc of ['el', 'de']) {
    const other = (await loadTs(`src/locales/${loc}/reviews.ts`)).reviews;
    check(`review-queue strings: ${loc} has every key en has`, eq(Object.keys(other).sort(), Object.keys(en).sort()));
  }
}

/* ---- wiring that only a text check can see ---- */
{
  const read = (rel) => fs.readFile(path.join(ROOT, rel), 'utf8');
  const R = await loadTs('src/lib/reviews.ts');
  const settingsPage = await read('src/pages/admin/settings/index.astro');
  check('settings: the checkbox is named after the key the route reads',
    settingsPage.includes(`name="${R.REVIEW_AUTO_APPROVE_SETTING}"`), R.REVIEW_AUTO_APPROVE_SETTING);
  check('settings: ...and save() sends it', new RegExp(`'reviews_enabled', '${R.REVIEW_AUTO_APPROVE_SETTING}'`).test(settingsPage));
  const SV = await loadTs('src/lib/settings-validate.ts');
  check('settings: auto-approve must be a real on/off', SV.validateSetting(R.REVIEW_AUTO_APPROVE_SETTING, 'yes please') !== null);
  check('settings: ...and the STRING "false" is stored as false, never as a truthy string',
    SV.normaliseSettingValue(R.REVIEW_AUTO_APPROVE_SETTING, 'false') === false);
  const mw = await read('src/middleware.ts');
  const re = '/^\\/api\\/products\\/[^/]+\\/reviews\\/?$/,';
  check('middleware: the review route is listed as a public GET, a public write AND a cross-origin public write',
    mw.split(re).length - 1 === 3, mw.split(re).length - 1);
  const api = await read('src/pages/openapi.json.ts');
  for (const p of ["'/api/products/{id}/reviews'", "'/api/reviews'", "'/api/reviews/moderate'"]) {
    check(`openapi: ${p}`, api.includes(p));
  }
  const doc = await read('PLUGIN_DEVELOPMENT.md');
  check('PLUGIN_DEVELOPMENT.md documents the media seam', doc.includes('`REVIEW_MEDIA`') && doc.includes('`AFTER_REVIEW_DELETE`') && doc.includes('private: true'));
}

/* ---- routes, per driver ---- */
const here = path.dirname(fileURLToPath(import.meta.url));
const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'astrobaas-product-reviews-'));
const DRIVERS = [
  { name: 'lowdb', env: (d) => ({ DB_PATH: path.join(d, 'db.json') }) },
  { name: 'libsql', env: (d) => ({ DATABASE_URL: `file:${path.join(d, 'db.sqlite')}` }) },
  { name: 'relational', env: (d) => ({ DATABASE_URL: `file:${path.join(d, 'db.sqlite')}`, DATABASE_DRIVER: 'relational' }) },
];
const perDriver = {};
for (const driver of DRIVERS) {
  const dir = path.join(tmpRoot, driver.name);
  await fs.mkdir(path.join(dir, 'uploads'), { recursive: true });
  const env = { ...process.env };
  delete env.RATE_LIMIT_STORE;
  delete env.DATABASE_URL;
  delete env.DATABASE_DRIVER;
  delete env.DB_PATH;
  const run = spawnSync(process.execPath, [path.join(here, 'product-reviews.test.mjs')], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 240_000,
    env: {
      ...env, PRODUCT_REVIEWS_CHILD: '1', NODE_ENV: 'test', SITE_URL: 'https://shop.example.com',
      AUTH_SECRET: 'test-secret-'.padEnd(40, 'x'), CAPTCHA_BITS: '8',
      UPLOADS_DIR: path.join(dir, 'uploads'), ...driver.env(dir),
    },
  });
  const line = (run.stdout || '').split('\n').find((l) => l.startsWith('__RESULT__'));
  if (!line) {
    fail++;
    console.error(`✗ [${driver.name}] child produced no result\n${(run.stderr || '').slice(-2000)}`);
    continue;
  }
  const results = JSON.parse(line.slice('__RESULT__'.length));
  perDriver[driver.name] = results.map(([n, ok]) => `${n}=${ok}`);
  for (const [name, ok, detail] of results) check(`[${driver.name}] ${name}`, ok, detail);
}
// The three drivers must not merely each pass — they must AGREE, check by check.
const names = Object.keys(perDriver);
if (names.length === 3) {
  check('all three drivers produced the same results', eq(perDriver.lowdb, perDriver.libsql) && eq(perDriver.lowdb, perDriver.relational));
}

await fs.rm(tmpRoot, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
