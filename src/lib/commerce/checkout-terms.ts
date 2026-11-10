/**
 * Checkout consent: "I agree to the Terms & Conditions".
 *
 * Pure — no storage, no clock unless passed — so every rule is testable on its
 * own and the route, the service and the admin form read ONE definition.
 *
 * Three decisions, each of which the owner can reverse by flipping a setting:
 *
 *  1. The requirement is OFF by default. A live storefront that has never sent
 *     `terms_accepted` would otherwise start receiving 400s the moment this
 *     shipped, on a shop whose owner never asked for it. The merchant switches
 *     it on (`checkout_terms_required`) when their storefront renders the box.
 *
 *  2. What is stored is what the buyer SENT. `true` is acceptance, `false` is
 *     an explicit "no" (possible only while the requirement is off), and ABSENT
 *     means we do not know — an order from before this existed, an import, or
 *     a storefront that has no box. Absent is never read as "accepted", and is
 *     never backfilled: a legal record that was invented later is worse than
 *     none.
 *
 *  3. The timestamp is the SERVER's. A client-supplied time would make the
 *     record worthless as evidence, so it is not read from the request.
 */
import { settingBool } from '../settings-map';

/** Settings keys, exported so the admin form, the validator and the reader cannot drift. */
export const CHECKOUT_TERMS_KEYS = {
  required: 'checkout_terms_required',
  label: 'checkout_terms_label',
  url: 'checkout_terms_url',
} as const;

/** Shown by a storefront when the merchant has not written their own. */
export const DEFAULT_TERMS_LABEL = 'I agree to the Terms & Conditions';
export const MAX_TERMS_LABEL_LENGTH = 200;
export const MAX_TERMS_URL_LENGTH = 500;

export interface CheckoutTermsSettings {
  /** True: a checkout from a shopper without `terms_accepted: true` is refused. */
  required: boolean;
  /** Plain text. A storefront must render it as TEXT, never as HTML. */
  label: string;
  /** Where the full terms live; null when the merchant set none. */
  url: string | null;
}

/**
 * A terms link a storefront may put in an `href`: an absolute http(s) address
 * or a site-relative path. Anything else (`javascript:`, `data:`, a
 * protocol-relative `//host`) is refused rather than guessed at.
 */
export function isTermsUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (!v || v.length > MAX_TERMS_URL_LENGTH || /[\u0000-\u001f\u007f\s]/.test(v)) return false;
  if (v.startsWith('/')) return !v.startsWith('//') && !v.startsWith('/\\');
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

export function resolveCheckoutTermsSettings(
  settings: Record<string, unknown> | null | undefined,
): CheckoutTermsSettings {
  const map = settings ?? {};
  const rawLabel = map[CHECKOUT_TERMS_KEYS.label];
  const label = typeof rawLabel === 'string' ? rawLabel.trim().slice(0, MAX_TERMS_LABEL_LENGTH) : '';
  const rawUrl = map[CHECKOUT_TERMS_KEYS.url];
  return {
    required: settingBool(map[CHECKOUT_TERMS_KEYS.required], false),
    label: label || DEFAULT_TERMS_LABEL,
    url: isTermsUrl(rawUrl) ? rawUrl.trim() : null,
  };
}

/**
 * A consent flag as a client sent it.
 *
 * Only a real boolean, or nothing, is accepted. The string "true" is refused
 * rather than coerced: a consent record must reflect an act the client meant,
 * and `"false"` being truthy is exactly the bug a lenient parser ships.
 */
export function parseConsentFlag(raw: unknown): { ok: true; value: boolean | undefined } | { ok: false } {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw === 'boolean') return { ok: true, value: raw };
  return { ok: false };
}

/** The fields to write onto an order. Absent flags write nothing. */
export function consentFields(
  input: { terms_accepted?: boolean; privacy_accepted?: boolean },
  nowIso: string,
): { terms_accepted?: boolean; terms_accepted_at?: string; privacy_accepted?: boolean; privacy_accepted_at?: string } {
  const out: ReturnType<typeof consentFields> = {};
  if (typeof input.terms_accepted === 'boolean') {
    out.terms_accepted = input.terms_accepted;
    // A timestamp for an acceptance only: "when did they say no" is not a fact
    // anyone needs, and a field that is set for both reads as both.
    if (input.terms_accepted) out.terms_accepted_at = nowIso;
  }
  if (typeof input.privacy_accepted === 'boolean') {
    out.privacy_accepted = input.privacy_accepted;
    if (input.privacy_accepted) out.privacy_accepted_at = nowIso;
  }
  return out;
}
