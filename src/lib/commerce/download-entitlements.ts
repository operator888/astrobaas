/**
 * Download entitlements: who may download which purchased file, how often,
 * until when — and the signed links that let them.
 *
 * ## Why this file exists
 *
 * The roadmap said digital downloads were shipped. What shipped was a field:
 * `Product.downloads = [{ name, url }]`, published in full on the public
 * product API. No record of who bought what, no limit, no expiry, no log — and
 * the "paid" file's URL readable by anyone who asked for the catalogue. This
 * is the feature that field implied.
 *
 * ## The model
 *
 * One {@link DownloadEntitlement} per paid order line of a downloadable
 * product, stored ON THE ORDER (`Order.entitlements`). On the order because it
 * is a fact about that purchase: it is backed up, exported to the buyer and
 * erased with the order, and it needs no fourth table on three drivers.
 *
 * - **Granted** when the order reaches `processing` or `completed` — the
 *   statuses that mean "paid, being worked on" (payments/capture.ts moves a
 *   paid order to `processing`; staff move a bank-transfer order there when
 *   the money arrives). NOT on `on-hold`: a risk-held order is paid and
 *   deliberately not fulfilled until a person has looked.
 * - **Revoked** when the order is cancelled or refunded in full (the refund
 *   path moves a fully refunded order to `refunded`). Re-opening the order
 *   lifts those automatic revocations; a STAFF revocation stays.
 * - Both are also checked LIVE on every download: a link works only while the
 *   order is in a granting status, whatever the stored record says. So a
 *   missed hook, or a status written by some other path, fails closed.
 *
 * ## The count cannot be overrun
 *
 * The limit is PER FILE, as the plan states it ("limit 5: each file up to 5
 * times"): a bundle of three files with a limit of 2 lets the buyer fetch
 * each file twice. `download_count` is the total, `file_counts` per file.
 *
 * Counting is read-modify-write ("4 of 5 used, make it 5"), so two downloads
 * at once would both read 4 and both be allowed. The write is the order
 * compare-and-set primitive (`Storage.compareAndSetOrderField`, the one the
 * order-tags work introduced): it lands only if the entitlements are still
 * what this request read, and a loser re-reads and decides again. A download
 * is counted when it is GRANTED, before a byte is sent — an interrupted
 * transfer uses one of the downloads.
 *
 * ## Links
 *
 * A link is `/api/downloads/<token>`, the token an HMAC (the same purpose-
 * tagged signing every other token here uses, `signPurposeToken('download')`)
 * over the order, the entitlement and the file. It is minted when shown and
 * never stored, and it expires after `downloads_link_ttl_hours` (24 by
 * default) or at the entitlement's own expiry, whichever is first. The file's
 * real location is never in it:
 *
 * - a PRIVATE file is streamed by the core from the private uploads directory;
 * - an https file is reached by a redirect issued only after every check
 *   passes — the URL is then visible to the buyer, which is the documented
 *   cost of hosting it elsewhere.
 *
 * ## Why the email carries no download link
 *
 * Mail scanners (Outlook Safe Links, corporate gateways) fetch every link in a
 * message to check it. A counted link in an email would spend the buyer's
 * downloads before they open it. The email names the files and links to the
 * RECEIPT, whose own link has always been in the confirmation; the receipt
 * page mints fresh download links each time it is opened.
 */
import crypto from 'node:crypto';
import { LocalDB } from '../localdb';
import { signPurposeToken, verifyPurposeToken } from '../auth';
import { settingBool, settingInt, settingStr, settingsMap } from '../settings-map';
import { isErased } from './order-lookup';
import { escapeHtml as esc } from '../escape-html';
import { readPrivateFileMeta } from '../media/private-files';
import {
  DOWNLOAD_EXPIRY_DAYS_MAX, DOWNLOAD_LIMIT_MAX, normalizeDownloads, privateDownloadId,
} from '../product-fields';
import {
  ENTITLEMENT_LOG_MAX,
  type DownloadEntitlement, type DownloadLogEntry, type EntitlementRevokeReason,
  type Order, type OrderStatus, type Product, type ProductDownload,
} from '../../core/models';

/* ------------------------------------------------------------ settings --- */

/** Settings keys — exported so the admin form and the reader cannot drift. */
export const DOWNLOAD_SETTING_KEYS = {
  /** Downloads per entitlement when the product sets none. 0 = unlimited. */
  limit: 'downloads_limit_default',
  /** Days an entitlement lasts when the product sets none. 0 = never expires. */
  expiryDays: 'downloads_expiry_days_default',
  /** Hours one signed link stays valid. */
  linkTtlHours: 'downloads_link_ttl_hours',
} as const;

/** Unlimited by default; a merchant who wants a cap sets one. */
export const DEFAULT_DOWNLOAD_LIMIT = 0;
/** Ninety days: long enough to come back for a file, short enough to end. */
export const DEFAULT_DOWNLOAD_EXPIRY_DAYS = 90;
/** One day. A link is a bearer credential; the receipt mints a new one. */
export const DEFAULT_LINK_TTL_HOURS = 24;
/** A link may be valid for a month at most. */
export const MAX_LINK_TTL_HOURS = 24 * 30;

export interface DownloadSettings {
  /** 0 = unlimited. */
  limit: number;
  /** 0 = never. */
  expiryDays: number;
  linkTtlHours: number;
}

/** The shop defaults from a settings map. Junk reads as the default; 0 is kept. */
export function resolveDownloadSettings(settings: Record<string, unknown> | null | undefined): DownloadSettings {
  const s = settings ?? {};
  return {
    limit: settingInt(s[DOWNLOAD_SETTING_KEYS.limit], DEFAULT_DOWNLOAD_LIMIT, { min: 0, max: DOWNLOAD_LIMIT_MAX }),
    expiryDays: settingInt(s[DOWNLOAD_SETTING_KEYS.expiryDays], DEFAULT_DOWNLOAD_EXPIRY_DAYS, { min: 0, max: DOWNLOAD_EXPIRY_DAYS_MAX }),
    linkTtlHours: settingInt(s[DOWNLOAD_SETTING_KEYS.linkTtlHours], DEFAULT_LINK_TTL_HOURS, { min: 1, max: MAX_LINK_TTL_HOURS }),
  };
}

/* --------------------------------------------------------------- rules --- */

/** The order statuses in which a buyer's downloads work. */
export const ENTITLED_STATUSES: readonly OrderStatus[] = ['processing', 'completed'];

/** Is this order, as it is NOW, one whose buyer may download? */
export function orderGrantsDownloads(order: Pick<Order, 'status' | 'payment_status'> | null | undefined): boolean {
  if (!order) return false;
  if (isErased(order)) return false;
  if (order.payment_status === 'refunded') return false;
  return ENTITLED_STATUSES.includes(order.status);
}

/** Why an order no longer grants, for the automatic revocation. */
function revokeReasonFor(order: Pick<Order, 'status' | 'payment_status'>): EntitlementRevokeReason | null {
  if (order.status === 'refunded' || order.payment_status === 'refunded') return 'refunded';
  if (order.status === 'cancelled' || order.status === 'failed') return 'cancelled';
  return null;
}

const AUTOMATIC_REASONS: ReadonlySet<EntitlementRevokeReason> = new Set(['refunded', 'cancelled']);

/** Does this product sell files? */
export function isDownloadableProduct(p: Pick<Product, 'downloadable' | 'downloads'> | null | undefined): boolean {
  return !!p && p.downloadable === true && Array.isArray(p.downloads) && normalizeDownloads(p.downloads).length > 0;
}

/** The limit a new entitlement for this product gets. `null` = unlimited. */
export function effectiveLimit(p: Pick<Product, 'download_limit'>, d: DownloadSettings): number | null {
  const own = typeof p.download_limit === 'number' && Number.isFinite(p.download_limit) && p.download_limit >= 0
    ? Math.floor(p.download_limit) : null;
  const n = own ?? d.limit;
  return n > 0 ? n : null;
}

/** The expiry days a new entitlement for this product gets. `null` = never. */
export function effectiveExpiryDays(p: Pick<Product, 'download_expiry_days'>, d: DownloadSettings): number | null {
  const own = typeof p.download_expiry_days === 'number' && Number.isFinite(p.download_expiry_days) && p.download_expiry_days >= 0
    ? Math.floor(p.download_expiry_days) : null;
  const n = own ?? d.expiryDays;
  return n > 0 ? n : null;
}

export type EntitlementState = 'active' | 'expired' | 'exhausted' | 'revoked' | 'inactive';

/**
 * What an entitlement is right now. `inactive` = the ORDER does not grant
 * downloads at the moment (unpaid, on hold, cancelled, refunded, erased).
 * Precedence: order first, then a revocation, then expiry, then the count.
 */
export function entitlementState(
  ent: DownloadEntitlement,
  order: Pick<Order, 'status' | 'payment_status'>,
  now: number = Date.now(),
): EntitlementState {
  // A refunded or cancelled order reads as REVOKED, not as "not paid yet":
  // telling a refunded buyer to wait for their payment would be false.
  if (!orderGrantsDownloads(order)) return !isErased(order) && revokeReasonFor(order) ? 'revoked' : 'inactive';
  if (ent.revoked_at) return 'revoked';
  if (ent.expires_at && Date.parse(ent.expires_at) <= now) return 'expired';
  const files = Array.isArray(ent.files) ? ent.files : [];
  if (ent.download_limit !== null && files.length > 0
    && files.every((_, i) => fileDownloadCount(ent, i) >= (ent.download_limit as number))) return 'exhausted';
  return 'active';
}

/** Downloads counted for one file. */
export function fileDownloadCount(ent: DownloadEntitlement, fileIndex: number): number {
  const n = Array.isArray(ent.file_counts) ? Number(ent.file_counts[fileIndex]) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Downloads left — for one file, or (no index) the most any file has left —
 * or null for unlimited.
 */
export function remainingDownloads(ent: DownloadEntitlement, fileIndex?: number): number | null {
  if (ent.download_limit === null) return null;
  const limit = ent.download_limit;
  const left = (i: number) => Math.max(0, limit - fileDownloadCount(ent, i));
  if (fileIndex !== undefined) return left(fileIndex);
  const files = Array.isArray(ent.files) ? ent.files : [];
  return files.length ? Math.max(...files.map((_, i) => left(i))) : 0;
}

function newEntitlementId(): string {
  return `ent_${crypto.randomBytes(12).toString('hex')}`;
}

/** A fresh entitlement for one order line. Pure apart from the random id. */
export function buildEntitlement(
  lineIndex: number,
  line: { name?: string; product_id?: string },
  product: Pick<Product, 'id' | 'downloads' | 'download_limit' | 'download_expiry_days'>,
  settings: DownloadSettings,
  now: number,
): DownloadEntitlement {
  const days = effectiveExpiryDays(product, settings);
  return {
    id: newEntitlementId(),
    line: lineIndex,
    product_id: String(line.product_id ?? product.id),
    name: String(line.name ?? 'Download'),
    files: normalizeDownloads(product.downloads),
    download_limit: effectiveLimit(product, settings),
    download_count: 0,
    file_counts: normalizeDownloads(product.downloads).map(() => 0),
    expires_at: days === null ? null : new Date(now + days * 86_400_000).toISOString(),
    granted_at: new Date(now).toISOString(),
  };
}

/**
 * The entitlements an order SHOULD have, given its status now. Returns null
 * when nothing would change. Pure: the products are looked up by the caller.
 *
 *  - granting status: every downloadable line without one gets one, and an
 *    automatic revocation (refund/cancel) is lifted — the order was re-opened;
 *  - refunded/cancelled: every live entitlement is revoked with that reason;
 *  - anything else (pending, on-hold): nothing changes.
 */
export function planEntitlements(
  order: Order,
  products: ReadonlyMap<string, Product>,
  settings: DownloadSettings,
  now: number,
): { next: DownloadEntitlement[]; granted: DownloadEntitlement[] } | null {
  const current = Array.isArray(order.entitlements) ? order.entitlements : [];
  if (isErased(order)) return null;
  if (orderGrantsDownloads(order)) {
    let changed = false;
    const next = current.map((e) => {
      if (e.revoked_at && e.revoked_reason && AUTOMATIC_REASONS.has(e.revoked_reason)) {
        changed = true;
        const { revoked_at: _a, revoked_reason: _b, ...rest } = e;
        return rest as DownloadEntitlement;
      }
      return e;
    });
    const granted: DownloadEntitlement[] = [];
    const haveLine = new Set(current.map((e) => e.line));
    (Array.isArray(order.items) ? order.items : []).forEach((line, i) => {
      if (haveLine.has(i) || !line?.product_id) return;
      const product = products.get(line.product_id);
      if (!product || !isDownloadableProduct(product)) return;
      const ent = buildEntitlement(i, line, product, settings, now);
      granted.push(ent);
      next.push(ent);
      changed = true;
    });
    return changed ? { next, granted } : null;
  }
  const reason = revokeReasonFor(order);
  if (!reason) return null;
  let changed = false;
  const at = new Date(now).toISOString();
  const next = current.map((e) => {
    if (e.revoked_at) return e;
    changed = true;
    return { ...e, revoked_at: at, revoked_reason: reason };
  });
  return changed ? { next, granted: [] } : null;
}

/* ---------------------------------------------------------- the writes --- */

/** Rounds a write may lose before giving up. Each loss is someone else's write landing. */
const MAX_ATTEMPTS = 12;

async function readSettings(): Promise<Record<string, unknown>> {
  return settingsMap((await LocalDB.getSettings()) as { key: string; value: unknown }[]);
}

async function productsFor(order: Order): Promise<Map<string, Product>> {
  const out = new Map<string, Product>();
  for (const line of Array.isArray(order.items) ? order.items : []) {
    const id = line?.product_id;
    if (!id || out.has(id)) continue;
    const p = (await LocalDB.getProduct(id)) as Product | null;
    if (p) out.set(id, p);
  }
  return out;
}

export interface ReconcileResult {
  order: Order | null;
  /** Entitlements created by THIS call — what a "your downloads" email announces. */
  granted: DownloadEntitlement[];
}

/**
 * Bring an order's entitlements in line with its status (see planEntitlements).
 * Idempotent and safe to call from anywhere — after a status change, and on
 * read wherever a buyer or staff looks, so an order that reached a paid status
 * by a path that did not call this still gets its downloads.
 */
export async function reconcileEntitlements(orderId: string, now: number = Date.now()): Promise<ReconcileResult> {
  const settings = resolveDownloadSettings(await readSettings());
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const order = (await LocalDB.getOrder(orderId)) as Order | null;
    if (!order) return { order: null, granted: [] };
    const plan = planEntitlements(order, await productsFor(order), settings, now);
    if (!plan) return { order, granted: [] };
    const stored = (order as { entitlements?: unknown }).entitlements;
    const w = await LocalDB.compareAndSetOrderField(orderId, 'entitlements', stored, plan.next);
    if (w.outcome === 'applied') return { order: w.order, granted: plan.granted };
    if (w.outcome === 'missing') return { order: null, granted: [] };
  }
  return { order: (await LocalDB.getOrder(orderId)) as Order | null, granted: [] };
}

/**
 * Run after an order's status changed: grant or revoke, and announce new
 * downloads to the buyer. Never throws — a status change must not fail
 * because the downloads could not be updated (the live check covers it).
 */
export async function afterOrderStatusChange(order: Order): Promise<Order> {
  try {
    const r = await reconcileEntitlements(order.id);
    // Not awaited: a slow mail server must not hold up a status change — a
    // payment webhook waits on this. notifyDownloadsReady never throws.
    if (r.granted.length && r.order) void notifyDownloadsReady(r.order, r.granted);
    return r.order ?? order;
  } catch (err) {
    console.error('[downloads] could not update entitlements:', err instanceof Error ? err.message : err);
    return order;
  }
}

export type StaffAction = 'revoke' | 'restore' | 'reset' | 'grant';

export type StaffActionResult =
  | { ok: true; order: Order; entitlements: DownloadEntitlement[] }
  | { ok: false; status: 404 | 409 | 422 | 503; message: string };

/**
 * A staff action on one entitlement — `revoke`, `restore` (undo a revocation
 * of any reason; the live order check still applies) and `reset` (the count
 * back to 0, the log kept). `grant` reconciles the whole order, for an order
 * that predates this feature or reached a paid status by another path.
 */
export async function staffEntitlementAction(
  orderId: string,
  action: StaffAction,
  entitlementId?: string,
  now: number = Date.now(),
): Promise<StaffActionResult> {
  if (action === 'grant') {
    const r = await reconcileEntitlements(orderId, now);
    if (!r.order) return { ok: false, status: 404, message: 'Order not found' };
    if (r.granted.length) await notifyDownloadsReady(r.order, r.granted).catch(() => {});
    return { ok: true, order: r.order, entitlements: r.order.entitlements ?? [] };
  }
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const order = (await LocalDB.getOrder(orderId)) as Order | null;
    if (!order) return { ok: false, status: 404, message: 'Order not found' };
    if (isErased(order)) return { ok: false, status: 409, message: 'This order was erased; its downloads cannot be changed' };
    const current = Array.isArray(order.entitlements) ? order.entitlements : [];
    const idx = current.findIndex((e) => e.id === entitlementId);
    if (idx < 0) return { ok: false, status: 404, message: 'Entitlement not found' };
    const e = current[idx];
    let updated: DownloadEntitlement;
    if (action === 'revoke') {
      if (e.revoked_at && e.revoked_reason === 'staff') return { ok: true, order, entitlements: current };
      updated = { ...e, revoked_at: new Date(now).toISOString(), revoked_reason: 'staff' };
    } else if (action === 'restore') {
      if (!e.revoked_at) return { ok: true, order, entitlements: current };
      const { revoked_at: _a, revoked_reason: _b, ...rest } = e;
      updated = rest as DownloadEntitlement;
    } else if (action === 'reset') {
      if (e.download_count === 0 && !(e.file_counts ?? []).some((n) => n > 0)) return { ok: true, order, entitlements: current };
      updated = { ...e, download_count: 0, file_counts: (e.files ?? []).map(() => 0) };
    } else {
      return { ok: false, status: 422, message: 'Unknown action' };
    }
    const next = current.slice();
    next[idx] = updated;
    const w = await LocalDB.compareAndSetOrderField(orderId, 'entitlements', (order as { entitlements?: unknown }).entitlements, next);
    if (w.outcome === 'applied') return { ok: true, order: w.order, entitlements: w.order.entitlements ?? [] };
    if (w.outcome === 'missing') return { ok: false, status: 404, message: 'Order not found' };
  }
  return { ok: false, status: 503, message: 'The order was being changed at the same time; try again' };
}

/* --------------------------------------------------------------- links --- */

const PURPOSE = 'download';

/** A signed link token for one file of one entitlement. Never stored. */
export function makeDownloadToken(
  orderId: string,
  ent: Pick<DownloadEntitlement, 'id' | 'expires_at'>,
  fileIndex: number,
  ttlMs: number,
  now: number = Date.now(),
): string {
  let ttl = ttlMs;
  if (ent.expires_at) {
    const left = Date.parse(ent.expires_at) - now;
    if (Number.isFinite(left)) ttl = Math.max(1000, Math.min(ttl, left));
  }
  return signPurposeToken(PURPOSE, { oid: String(orderId), eid: ent.id, f: fileIndex }, ttl);
}

export interface DownloadTokenClaims { orderId: string; entitlementId: string; fileIndex: number }

/** What a token names, or null for a forged, expired or malformed one. */
export function readDownloadToken(token: string | null | undefined): DownloadTokenClaims | null {
  const p = verifyPurposeToken(PURPOSE, token);
  if (!p) return null;
  const { oid, eid, f } = p as { oid?: unknown; eid?: unknown; f?: unknown };
  if (typeof oid !== 'string' || !oid || oid.length > 200) return null;
  if (typeof eid !== 'string' || !/^ent_[0-9a-f]{24}$/.test(eid)) return null;
  if (typeof f !== 'number' || !Number.isInteger(f) || f < 0 || f > 1000) return null;
  return { orderId: oid, entitlementId: eid, fileIndex: f };
}

/** The relative link a token is served at. */
export function downloadPath(token: string): string {
  return `/api/downloads/${encodeURIComponent(token)}`;
}

/* ------------------------------------------------------------ download --- */

export type DownloadRefusal =
  | 'link_invalid' | 'not_available' | 'revoked' | 'expired' | 'limit_reached' | 'file_missing' | 'busy';

export type ClaimResult =
  | { ok: true; file: ProductDownload; entitlement: DownloadEntitlement; order: Order }
  | { ok: false; code: DownloadRefusal; status: number; message: string };

const REFUSALS: Record<DownloadRefusal, { status: number; message: string }> = {
  link_invalid: { status: 403, message: 'This download link is invalid or has expired. Open your receipt for a fresh link.' },
  not_available: { status: 403, message: 'These downloads are not available for this order.' },
  revoked: { status: 403, message: 'Access to this download has been withdrawn.' },
  expired: { status: 403, message: 'Access to this download has expired.' },
  limit_reached: { status: 403, message: 'The download limit for this purchase has been reached.' },
  file_missing: { status: 404, message: 'This file is no longer available. Please contact the shop.' },
  busy: { status: 503, message: 'Too many downloads at once; try again in a moment.' },
};

export function refusal(code: DownloadRefusal): { ok: false; code: DownloadRefusal; status: number; message: string } {
  return { ok: false, code, ...REFUSALS[code] };
}

/**
 * The file an entitlement's slot points at NOW: the product's current file
 * of the same name when there is one (a merchant fixed the URL), else the
 * copy frozen at grant (the product was deleted or the file renamed).
 */
export async function resolveEntitlementFile(ent: DownloadEntitlement, fileIndex: number): Promise<ProductDownload | null> {
  const frozen = ent.files?.[fileIndex];
  if (!frozen) return null;
  const product = (await LocalDB.getProduct(ent.product_id).catch(() => null)) as Product | null;
  const live = product ? normalizeDownloads(product.downloads).find((d) => d.name === frozen.name) : undefined;
  return live ?? frozen;
}

/**
 * Check a link and COUNT the download — one step, compare-and-set, so two
 * downloads at once can never both take the last one. Returns the file to
 * serve; the caller streams or redirects.
 */
export async function claimDownload(
  token: string | null | undefined,
  ip: string | null | undefined,
  now: number = Date.now(),
): Promise<ClaimResult> {
  const claims = readDownloadToken(token);
  if (!claims) return refusal('link_invalid');
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const order = (await LocalDB.getOrder(claims.orderId)) as Order | null;
    if (!order || isErased(order)) return refusal('not_available');
    const current = Array.isArray(order.entitlements) ? order.entitlements : [];
    const idx = current.findIndex((e) => e.id === claims.entitlementId);
    if (idx < 0) return refusal('not_available');
    const ent = current[idx];
    const state = entitlementState(ent, order, now);
    if (state === 'inactive') return refusal('not_available');
    if (state === 'revoked') return refusal('revoked');
    if (state === 'expired') return refusal('expired');
    if (state === 'exhausted') return refusal('limit_reached');
    // The limit is per file: this file's own count decides.
    if (ent.download_limit !== null && fileDownloadCount(ent, claims.fileIndex) >= ent.download_limit) {
      return refusal('limit_reached');
    }
    const file = await resolveEntitlementFile(ent, claims.fileIndex);
    if (!file) return refusal('file_missing');
    // A private file that is gone is refused BEFORE it is counted: a buyer
    // must not spend a download on a file the shop lost.
    const pf = privateDownloadId(file.url);
    if (pf && !(await readPrivateFileMeta(pf))) return refusal('file_missing');

    const entry: DownloadLogEntry = { at: new Date(now).toISOString(), file: ent.files[claims.fileIndex]?.name ?? file.name };
    if (ip) entry.ip = String(ip).slice(0, 64);
    const log = [...(Array.isArray(ent.log) ? ent.log : []), entry].slice(-ENTITLEMENT_LOG_MAX);
    const fileCounts = (ent.files ?? []).map((_, i) => fileDownloadCount(ent, i));
    fileCounts[claims.fileIndex] = (fileCounts[claims.fileIndex] ?? 0) + 1;
    const updated: DownloadEntitlement = {
      ...ent, download_count: (ent.download_count || 0) + 1, file_counts: fileCounts, log,
    };
    const next = current.slice();
    next[idx] = updated;
    const w = await LocalDB.compareAndSetOrderField(order.id, 'entitlements', (order as { entitlements?: unknown }).entitlements, next);
    if (w.outcome === 'applied') return { ok: true, file, entitlement: updated, order: w.order };
    if (w.outcome === 'missing') return refusal('not_available');
    // 'changed': another download (or a staff action) landed; decide again.
  }
  return refusal('busy');
}

/* ----------------------------------------------------------- the buyer --- */

export interface BuyerDownloadFile {
  name: string;
  href: string | null;
  /** Downloads left for this file; null = unlimited. */
  remaining: number | null;
}
export interface BuyerDownload {
  name: string;
  state: EntitlementState;
  files: BuyerDownloadFile[];
  /** null = unlimited. */
  remaining: number | null;
  limit: number | null;
  expires_at: string | null;
}

/**
 * What the buyer sees: each entitlement with its state and, when active, a
 * freshly signed link per file. Never the file's location, never the log.
 */
export function buyerDownloads(
  order: Order,
  linkTtlHours: number,
  opts: { origin?: string; now?: number } = {},
): BuyerDownload[] {
  const now = opts.now ?? Date.now();
  const base = (opts.origin ?? '').replace(/\/$/, '');
  return (Array.isArray(order.entitlements) ? order.entitlements : []).map((ent) => {
    const state = entitlementState(ent, order, now);
    return {
      name: ent.name,
      state,
      files: (ent.files ?? []).map((f, i) => {
        const left = remainingDownloads(ent, i);
        return {
          name: f.name,
          href: state === 'active' && left !== 0
            ? `${base}${downloadPath(makeDownloadToken(order.id, ent, i, linkTtlHours * 3_600_000, now))}`
            : null,
          remaining: left,
        };
      }),
      remaining: remainingDownloads(ent),
      limit: ent.download_limit,
      expires_at: ent.expires_at,
    };
  });
}

/** Does this order hold (or will it, once paid) any downloads? */
export async function orderHasDownloadableLines(order: Order): Promise<boolean> {
  if (Array.isArray(order.entitlements) && order.entitlements.length) return true;
  for (const p of (await productsFor(order)).values()) if (isDownloadableProduct(p)) return true;
  return false;
}

/* --------------------------------------------------------------- GDPR --- */

/**
 * Entitlements after an erasure: kept as the shop's record of what was
 * delivered (counts and times), every IP address removed, and every one
 * revoked — an erased order's downloads end with it.
 */
export function anonymisedEntitlements(ents: DownloadEntitlement[] | undefined, now: number = Date.now()): DownloadEntitlement[] | undefined {
  if (!Array.isArray(ents) || ents.length === 0) return undefined;
  const at = new Date(now).toISOString();
  return ents.map((e) => ({
    ...e,
    revoked_at: e.revoked_at ?? at,
    revoked_reason: 'erased' as const,
    log: (Array.isArray(e.log) ? e.log : []).map(({ at: when, file }) => ({ at: when, file })),
  }));
}

/* -------------------------------------------------------------- email --- */

export interface DownloadsReadyEmail { to: string; subject: string; text: string; html: string }

const headerSafe = (v: string) => v.replace(/[\r\n]+/g, ' ').trim();

/**
 * The "your downloads are ready" email. Pure. Lists the files and links to
 * the receipt's downloads section — never a counted link (see the header).
 * Returns null when there is no address or no receipt link to send.
 */
export function buildDownloadsReadyEmail(
  order: Pick<Order, 'email' | 'number' | 'id'>,
  ents: readonly DownloadEntitlement[],
  opts: { siteTitle?: string; receiptLink?: string },
): DownloadsReadyEmail | null {
  const to = String(order.email ?? '').trim();
  if (!to || !to.includes('@') || !opts.receiptLink || ents.length === 0) return null;
  const shop = headerSafe(opts.siteTitle?.trim() || 'Your order');
  const number = headerSafe(String(order.number ?? order.id ?? ''));
  const link = `${opts.receiptLink}#downloads`;
  const terms = (e: DownloadEntitlement) => {
    const parts: string[] = [];
    if (e.download_limit !== null) parts.push(`${e.download_limit} download${e.download_limit === 1 ? '' : 's'} per file`);
    if (e.expires_at) parts.push(`until ${e.expires_at.slice(0, 10)}`);
    return parts.length ? ` (${parts.join(', ')})` : '';
  };
  const text = [
    `Your downloads for order ${number} are ready.`,
    ``,
    ...ents.flatMap((e) => [`${e.name}${terms(e)}`, ...e.files.map((f) => `  - ${f.name}`)]),
    ``,
    `Download them from your receipt: ${link}`,
    `Each link there is valid for a limited time; open the receipt again for fresh ones.`,
    ``,
    shop,
  ].join('\n');
  const html = [
    `<p>Your downloads for order <strong>${esc(number)}</strong> are ready.</p>`,
    ...ents.map((e) => `<p><strong>${esc(e.name)}</strong>${esc(terms(e))}</p><ul>${e.files.map((f) => `<li>${esc(f.name)}</li>`).join('')}</ul>`),
    `<p><a href="${esc(link)}">Download your files</a></p>`,
    `<p>Each link there is valid for a limited time; open the receipt again for fresh ones.</p>`,
    `<p>${esc(shop)}</p>`,
  ].join('\n');
  return { to, subject: headerSafe(`${shop} — your downloads for order ${number}`), text, html };
}

/** Emails of this kind one address may receive per hour. */
export const DOWNLOAD_EMAILS_PER_RECIPIENT_PER_HOUR = 5;

/**
 * Send the downloads email for newly granted entitlements. Follows the
 * customer-email switch (`order_confirmation_enabled`: a shop whose
 * storefront mails its own customers turns that off) and a per-recipient
 * hourly budget. Never throws.
 */
export async function notifyDownloadsReady(order: Order, granted: readonly DownloadEntitlement[]): Promise<void> {
  try {
    if (!granted.length) return;
    const settings = await readSettings();
    if (settingBool(settings.order_confirmation_enabled, true) === false) return;
    const origin = settingStr(settings.public_site_url) || settingStr(settings.site_url) || settingStr(process.env.SITE_URL);
    if (!origin) return;
    const { receiptUrl } = await import('./receipt');
    const msg = buildDownloadsReadyEmail(order, granted, {
      siteTitle: settingStr(settings.site_title) || undefined,
      receiptLink: receiptUrl(origin, String(order.id)),
    });
    if (!msg) return;
    const { sharedRateLimitStore } = await import('../rate-limit');
    const digest = crypto.createHash('sha256').update(`downloads|${msg.to.toLowerCase()}`).digest('hex').slice(0, 32);
    const res = await sharedRateLimitStore().consume(`downloads-email:${digest}`, 3_600_000, DOWNLOAD_EMAILS_PER_RECIPIENT_PER_HOUR);
    if (!res.allowed) return;
    const { sendEmail } = await import('../email');
    await sendEmail(msg);
  } catch (err) {
    console.error('[downloads] email failed:', err instanceof Error ? err.message : err);
  }
}

/** The shop defaults, read from storage. For routes and pages. */
export async function loadDownloadSettings(): Promise<DownloadSettings> {
  return resolveDownloadSettings(await readSettings());
}
