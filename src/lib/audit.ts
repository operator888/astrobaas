/**
 * Security audit trail. `recordAudit()` is fire-and-forget — it never throws and
 * never blocks the request that triggered it, so adding an audit line to a
 * handler is a one-liner with no error handling. Records go to the same pluggable
 * storage as everything else (so they're durable on libSQL) and are viewable by
 * admins at GET /api/audit.
 *
 * NEVER put secrets/tokens/passwords in `metadata` — this log may be read by any
 * admin.
 */
import { LocalDB } from './localdb';

/** Canonical action names (use these so the log stays greppable/consistent). */
export const AUDIT = {
  LOGIN_SUCCESS: 'auth.login.success',
  LOGIN_FAILED: 'auth.login.failed',
  LOGIN_THROTTLED: 'auth.login.throttled',
  PASSWORD_RESET: 'auth.password_reset',
  APIKEY_CREATE: 'apikey.create',
  APIKEY_REVOKE: 'apikey.revoke',
  APIKEY_ROTATE: 'apikey.rotate',
  /** A key's trust changed in place — today only `forward_client_ip` (S3.6). */
  APIKEY_UPDATE: 'apikey.update',
  WEBHOOK_CREATE: 'webhook.create',
  WEBHOOK_DELETE: 'webhook.delete',
  USER_UPDATE: 'user.update',
  /** An operator changed what a role may do (C-138). */
  ROLE_CAPS_UPDATE: 'role.capabilities.update',
  /**
   * An admin started or stopped acting as another user (C-141).
   *
   * The two BRACKET a window in which everything else was audited as the
   * impersonated user — the request genuinely was them. These entries are what
   * attributes that window to a person, which is why both directions are
   * recorded and why the actor on both is the real admin.
   */
  USER_SWITCH_START: 'user.switch.start',
  USER_SWITCH_END: 'user.switch.end',
  POST_RESTORE: 'post.restore',
  // Deleting a prescription off an order line. Audited because it destroys
  // Article 9 health data that this system deliberately RETAINS through a
  // subject erasure — so the one act that removes it must be attributable.
  ORDER_RX_DELETE: 'order.prescription.delete',
  ORDER_SHIPPED: 'order.shipped',
  PLUGIN_INSTALL: 'plugin.install',
  PLUGIN_UNINSTALL: 'plugin.uninstall',
  TWOFA_ENABLED: 'auth.2fa.enabled',
  TWOFA_DISABLED: 'auth.2fa.disabled',
  TWOFA_FAILED: 'auth.2fa.failed',
  TWOFA_BACKUP_USED: 'auth.2fa.backup_used',
  PAYMENT_CAPTURED: 'payment.captured',
  PAYMENT_FAILED: 'payment.failed',
  PAYMENT_REFUNDED: 'payment.refunded',
  /** Verified as genuinely from the provider, but wrong about this order. */
  PAYMENT_REJECTED: 'payment.rejected',
  PAYMENT_WEBHOOK_INVALID: 'payment.webhook.invalid',
  /**
   * A WordPress export was performed against this install. Audited because it
   * is the single most consequential content operation there is — it creates
   * posts, pages, categories, media and site-wide redirects in one call, and
   * it cannot be undone.
   */
  /**
   * A data-subject request was actioned. Both directions are recorded: an
   * export because assembling everything about a named person is itself an act
   * somebody may have to account for, an erasure because it is irreversible and
   * a supervisory authority may ask when it happened.
   */
  /**
   * A media file was swapped for another under the same id. Audited because it
   * REWRITES stored post and product content to point at the new file — that
   * is a content migration, and an operator should be able to see when one ran.
   */
  MEDIA_REPLACE: 'media.replace',
  PRIVACY_EXPORT: 'privacy.subject.export',
  PRIVACY_ERASE: 'privacy.subject.erase',
  CONTENT_IMPORT: 'content.import',
  POST_CREATE: 'post.create',
  POST_DUPLICATE: 'post.duplicate',
  POST_UPDATE: 'post.update',
  POST_DELETE: 'post.delete',
  PRODUCT_CREATE: 'product.create',
  PRODUCT_UPDATE: 'product.update',
  PRODUCT_DELETE: 'product.delete',
  /** Value matches what is already stored — renaming it would orphan history. */
  ORDER_STATUS: 'order.status_changed',
  /** An operator sent money back through the provider. */
  REFUND_ISSUED: 'payment.refund.issued',
  REFUND_FAILED: 'payment.refund.failed',

  /**
   * Legacy-URL redirects.
   *
   * Audited because a redirect is a public, search-visible change to how the
   * site behaves that a MANAGER can make without a deploy — which is the point
   * of the feature and also why it needs a trail. A rule pointing a live
   * category at a competitor would otherwise leave no record of who added it.
   */
  REDIRECT_CREATE: 'redirect.create',
  REDIRECT_UPDATE: 'redirect.update',
  REDIRECT_DELETE: 'redirect.delete',

  /**
   * Admin-defined content types.
   *
   * Audited because a definition change ALTERS THE API SURFACE — a collection
   * appears, disappears, or goes public — without a deploy, which is the
   * feature and also exactly the kind of change that needs a trail.
   */
  CONTENT_TYPES_UPDATE: 'content_types.update',
  /**
   * Operator-defined taxonomies (C-128).
   *
   * Audited for the same reason a content-type change is: it alters what every
   * editor sees on every record, without a deploy.
   */
  TAXONOMIES_UPDATE: 'taxonomies.update',
  /** Exchange rates. A money change, so it gets its own action rather than
   *  disappearing into a generic settings save. */
  CURRENCY_RATES_UPDATE: 'currency.rates.update',
  /** A human departed from the tax engine on a placed order. */
  ORDER_TAX_OVERRIDE: 'order.tax.override',
  /** Which merchant-declared product fields exist, and which are PUBLIC. */
  PRODUCT_FIELDS_UPDATE: 'product_fields.update',
} as const;

export interface AuditDetails {
  actor?: string;
  target?: string;
  ip?: string;
  metadata?: Record<string, any>;
}

/** Record a security event. Fire-and-forget; safe to call anywhere. */
export function recordAudit(action: string, details: AuditDetails = {}): void {
  LocalDB.createAuditEvent({
    action,
    actor: details.actor ?? 'anonymous',
    target: details.target,
    ip: details.ip,
    metadata: details.metadata,
  }).catch(() => {});
}

/**
 * Fields whose BEFORE and AFTER values may be recorded verbatim.
 *
 * Deliberately a tiny allow-list, not a deny-list. An audit entry is read by
 * whoever is investigating something and is retained far longer than a request
 * log, so it must not become a second copy of the data — a post body, a
 * customer address or a settings value has no business being duplicated there.
 *
 * These are non-secret scalars, and they are exactly what an operator asks
 * about: "who dropped the price", "who cancelled that order", "who took it out
 * of stock". Everything else is recorded as a NAME only, which answers "what
 * did they touch" without copying it.
 *
 * `tests/smoke.mjs` asserts the audit log carries no secrets. Adding a field
 * here that could hold one breaks that, which is the intended tripwire.
 */
const VALUED_FIELDS = new Set([
  'status', 'price_cents', 'regular_price_cents', 'sale_price_cents',
  'stock', 'in_stock', 'on_sale', 'role', 'requires_prescription',
]);

/** A single field's change, safe to store. */
export interface FieldChange { field: string; from?: unknown; to?: unknown }

/**
 * What changed between two records, in a form safe to keep for ever.
 *
 * Compares only keys PRESENT in `after`, so a partial update reports the fields
 * the writer actually sent rather than every field that differs from a default.
 * Values appear only for `VALUED_FIELDS`; everything else contributes its name.
 *
 * Returns an empty array when nothing changed — callers skip recording, because
 * an audit trail full of "saved, changed nothing" entries is one nobody reads.
 */
export function summariseChanges(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
): FieldChange[] {
  if (!after) return [];
  const out: FieldChange[] = [];
  for (const [field, next] of Object.entries(after)) {
    if (field === 'updated_at' || field === 'id') continue;
    const prev = before ? before[field] : undefined;
    // JSON comparison so nested values (images, variants) are compared by
    // content rather than by reference — a reference check would report every
    // array as changed on every save.
    if (JSON.stringify(prev) === JSON.stringify(next)) continue;
    out.push(VALUED_FIELDS.has(field) ? { field, from: prev, to: next } : { field });
  }
  return out;
}
