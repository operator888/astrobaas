import type { APIRoute } from 'astro';
import { LocalDB } from '../../../../lib/localdb';
import { ApiResponseBuilder } from '../../../../lib/api-response';
import { publicSubmissionGate } from '../../../../lib/public-submission';
import {
  WAITLIST_TYPE, WAITLIST_MAX_PER_PRODUCT, normaliseWaitlistEmail, isBackInStock,
} from '../../../../lib/commerce/stock-waitlist';
import { allowRecipient, WAITLIST_SIGNUP_BUDGET } from '../../../../lib/recipient-throttle';

/**
 * `POST /api/products/{id}/notify-me` — tell me when this is back.
 *
 * A sold-out product is a customer who came to buy and left. This is the one
 * thing that turns that visit into a sale later, and it is the storefront's
 * button, so it is public and cookie-less like the newsletter box.
 *
 * ## One message, not a subscription
 *
 * The row is deleted the moment the notice is sent, so there is nothing to
 * unsubscribe from. That is also why this does NOT use double opt-in the way
 * the newsletter does: the newsletter puts a stranger on an ongoing list, which
 * is why typing somebody else's address there had to be neutralised. Here the
 * worst a mistyped address achieves is one message about one product, and
 * requiring a confirmation click for a single transactional notice would lose
 * most of the people it is meant to serve.
 *
 * It still goes through the shared public gate — the same rate limit, honeypot
 * and optional challenge every other public form uses.
 *
 * ## Answers the same way whether it stored anything or not
 *
 * An address already waiting, a product that is already in stock, a product
 * that does not exist: all "we'll let you know". Distinguishing them would turn
 * this into a way to ask which products exist and who is waiting for them.
 */
export const prerender = false;

export const POST: APIRoute = async ({ params, request, locals }) => {
  try {
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;

    // Its OWN rate-limit bucket. This used to pass `surface: 'newsletter'`, so
    // the two forms shared one per-IP budget: a shopper who asked about three
    // sold-out sizes could no longer join the mailing list, and a script
    // hammering one door silently closed the other. The captcha switch stays
    // the newsletter's — the operator configures "email capture forms" once.
    const gate = await publicSubmissionGate({
      surface: 'notify-me', ip: locals.ip ?? 'unknown', body,
      captchaSurface: 'newsletter', score: false,
    });
    if (gate.kind === 'rate-limited') {
      return ApiResponseBuilder.error(429, 'Too many requests. Please try again later.');
    }
    if (gate.kind === 'silent') return ApiResponseBuilder.success(null, 'We will let you know');
    if (gate.kind === 'challenge-failed') {
      return ApiResponseBuilder.forbidden('Please try again (anti-spam check failed)');
    }

    const email = normaliseWaitlistEmail(body?.email);
    // A malformed address is the one thing worth saying out loud: the visitor
    // mistyped and can fix it. Everything else stays indistinguishable.
    if (!email) return ApiResponseBuilder.badRequest('A valid email address is required');

    // PER RECIPIENT, before anything is looked up. A signup sends nothing today,
    // but every stored row is one email on the day its product returns — so an
    // address signed up to five thousand products is five thousand emails to
    // somebody who never asked. Over the budget, the answer is the same "we'll
    // let you know" and nothing is stored. See lib/recipient-throttle.ts.
    if (!(await allowRecipient(WAITLIST_SIGNUP_BUDGET, email))) {
      return ApiResponseBuilder.success(null, 'We will let you know');
    }

    await LocalDB.init();
    const id = String((params as { id: string }).id ?? '');
    // One product by id, not the whole catalogue for every signup.
    const product = id ? await LocalDB.getProduct(id) : undefined;

    // Already back, no such product, already waiting — one answer for all three.
    if (!product || isBackInStock(product)) {
      return ApiResponseBuilder.success(null, 'We will let you know');
    }

    const rows = await LocalDB.getCustomEntities(WAITLIST_TYPE) as {
      id: string; data?: Record<string, unknown> }[];
    const forProduct = rows.filter((r) => r.data?.product_id === id);
    if (forProduct.some((r) => r.data?.email === email)) {
      return ApiResponseBuilder.success(null, 'We will let you know');
    }
    // A ceiling per product, so a bot cannot grow the table without bound. The
    // caller is told nothing: from outside this is the same "we'll let you know".
    if (forProduct.length >= WAITLIST_MAX_PER_PRODUCT) {
      return ApiResponseBuilder.success(null, 'We will let you know');
    }

    const variant = typeof body?.variant_id === 'string' ? body.variant_id.slice(0, 120) : undefined;
    await LocalDB.createCustomEntity(WAITLIST_TYPE, {
      product_id: id,
      variant_id: variant,
      email,
      created_at: new Date().toISOString(),
    });

    return ApiResponseBuilder.success(null, 'We will let you know');
  } catch (err) {
    console.error('Stock notify signup error:', err);
    return ApiResponseBuilder.serverError('Could not record that request');
  }
};
