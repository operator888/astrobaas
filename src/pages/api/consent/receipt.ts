import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { sharedRateLimitStore } from '../../../lib/rate-limit';
import { CONSENT_VERSION, normaliseGrants } from '../../../lib/consent';
import type { ConsentReceipt } from '../../../core/models';

/**
 * Record that a consent decision was made.
 *
 * Article 7(1): the controller must be able to demonstrate that consent was
 * given. The obvious implementation — log the IP and user agent with every
 * decision — answers a privacy obligation by collecting more personal data,
 * and each of those rows then becomes subject to access and erasure requests
 * of its own.
 *
 * So this stores the decision and nothing else: which categories, under which
 * version of the text, at what time, under an opaque id the BROWSER generated.
 * That id lives in the visitor's own consent cookie, so the person who made
 * the decision holds the only reference to it. Nothing here can be linked back
 * to anyone by the operator, by an attacker who reads the table, or by us.
 *
 * The id is not trusted for anything: it is an opaque handle, checked for
 * shape, and a receipt for an id somebody invented proves nothing and harms
 * nothing.
 */
export const prerender = false;

/** UUID v4 as the browser's `crypto.randomUUID()` produces it. */
const RECEIPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Per-address ceiling.
 *
 * Generous, because changing your mind about cookies is a thing people do, and
 * a shared office address is one address. Bounded, because this is an
 * unauthenticated write and the table it fills is the evidence for everybody
 * else's decisions.
 */
const WINDOW_MS = 60 * 60 * 1000;
const LIMIT = 60;

/**
 * Read the trail. Admin only.
 *
 * `?id=…` fetches the one receipt a visitor is quoting; without it, the most
 * recent decisions. Neither can be turned into a person — that is the point of
 * the design — so this is a compliance record rather than an analytics feed,
 * and it should not be read as one.
 */
export const GET: APIRoute = async ({ url, locals }) => {
  try {
    if (!locals.user) return ApiResponseBuilder.unauthorized();
    if (locals.user.role !== 'admin') {
      return ApiResponseBuilder.forbidden('Only an administrator can read the consent trail');
    }
    await LocalDB.init();

    const sp = new URL(url).searchParams;
    const id = sp.get('id');
    if (id) {
      if (!RECEIPT_ID.test(id)) return ApiResponseBuilder.badRequest('That is not a receipt id');
      const one = await LocalDB.getConsentReceipt(id);
      if (!one) return ApiResponseBuilder.notFound('Receipt');
      return ApiResponseBuilder.success(one, 'Receipt found');
    }

    const limitRaw = Number(sp.get('limit'));
    const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 100;
    const recent = await LocalDB.getConsentReceipts(limit);
    return ApiResponseBuilder.success(recent, undefined, { count: recent.length, limit });
  } catch (err) {
    console.error('Consent trail read error:', err);
    return ApiResponseBuilder.serverError('Failed to read the consent trail');
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const allowed = await sharedRateLimitStore().hit(
      `consent:${locals.ip}`, WINDOW_MS, LIMIT,
    );
    // Answered as success. A visitor's banner must never show an error because
    // the shop is recording too many receipts — their decision is already
    // stored in their own cookie, which is what actually governs what loads.
    if (!allowed) return ApiResponseBuilder.success({ recorded: false }, 'Consent recorded');

    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const id = String(body?.id ?? '');
    if (!RECEIPT_ID.test(id)) {
      return ApiResponseBuilder.badRequest('A receipt id is required');
    }

    // The version is what the visitor's browser was showing. A decision made
    // against text we have since replaced is still a fact about what they
    // agreed to, so it is recorded as given rather than overwritten. But a
    // version that is absent falls back to the current one, while a version
    // that is PRESENT and out of range (0, negative, non-integer, or from the
    // future) is a malformed receipt, not evidence to launder — refused.
    let version = CONSENT_VERSION;
    if (body?.version !== undefined && body?.version !== null) {
      const raw = Number(body.version);
      if (!Number.isInteger(raw) || raw < 1 || raw > CONSENT_VERSION) {
        return ApiResponseBuilder.badRequest('Invalid consent version');
      }
      version = raw;
    }

    // `normaliseGrants` drops anything that is not a known category and always
    // includes `necessary`, so a receipt reads as the complete state rather
    // than as "the extras" — and a body full of invented category names
    // produces a receipt saying `necessary` and nothing else.
    const granted = normaliseGrants(Array.isArray(body?.granted) ? body.granted as unknown[] : []);

    await LocalDB.init();
    const receipt: ConsentReceipt = {
      id,
      granted,
      version,
      created_at: new Date().toISOString(),
    };
    await LocalDB.createConsentReceipt(receipt);

    return ApiResponseBuilder.success({ recorded: true }, 'Consent recorded');
  } catch (err) {
    console.error('Consent receipt error:', err);
    // Still a success to the visitor: the banner has done its job either way,
    // and an error here would be a broken page over a bookkeeping failure.
    return ApiResponseBuilder.success({ recorded: false }, 'Consent recorded');
  }
};
