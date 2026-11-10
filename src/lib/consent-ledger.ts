/**
 * The consent ledger — proof of who agreed to what, under which text, when.
 *
 * ## Why a ledger and not a flag
 *
 * GDPR Art. 7(1): the controller must be able to DEMONSTRATE that the person
 * consented. A `subscribed: true` flag demonstrates nothing — not when, not to
 * which wording, not whether it was later taken back. So every decision is a
 * row, and the current state is READ from the rows:
 *
 *   - a grant is a row with `granted: true`;
 *   - a double-opt-in confirmation is a NEW row with `confirmed_at` set;
 *   - a withdrawal is a NEW row with `granted: false`.
 *
 * ## Append-only, and why that is enforced rather than hoped for
 *
 * A ledger that can be edited proves only what it says today. So there is no
 * update and no delete anywhere in the storage surface for these rows; the
 * relational driver additionally refuses both with triggers; and
 * `tests/consent-ledger.test.mjs` snapshots every row as it is written and
 * fails if any of them differs at the end of a full run of normal operation.
 *
 * The ONE rewrite is the erasure (`pseudonymiseConsentRows`, called from
 * `gdpr.ts`). Erasure does not delete these rows, deliberately: proof that
 * consent existed is itself a legal obligation (Art. 7(1), Art. 5(2)), and
 * Art. 17(3)(b) and (e) exempt what is kept to meet a legal obligation or to
 * defend a claim — "you emailed me without consent" is exactly such a claim.
 * What goes is the person: the address becomes `sha256:<hex>` of itself, and
 * ip and ua are removed. If the person later disputes a mailing, hashing the
 * address they give finds their rows again; nothing else can. That is
 * pseudonymous, not anonymous, and the erase report says so.
 *
 * ## Storage
 *
 * Its own collection on every driver (`consentLedger` in the document drivers,
 * the `consent_ledger` table in the relational one), never a custom entity:
 * custom-entity writes go into the PUBLIC content change feed, which would
 * publish who agreed to what to anyone polling `/api/content/changes`. It is
 * also never capped — the oldest rows are the ones a dispute needs.
 *
 * ## "The latest row"
 *
 * Means the latest WRITTEN, not the largest timestamp: a grant and its
 * confirmation are routinely written inside one millisecond. The drivers
 * return rows in write order, and everything here reads them that way.
 *
 * Pure module: no storage, no network. The service that writes rows and acts
 * on them is `consent-service.ts`.
 */
import crypto from 'node:crypto';
import type { ConsentLedgerRow } from '../core/models';

/** Purposes core knows by name. Others are accepted if they are well-formed. */
export const KNOWN_PURPOSES = ['game_terms', 'newsletter'] as const;

/** The purpose whose confirmed consent IS a newsletter subscription. */
export const NEWSLETTER_PURPOSE = 'newsletter';

/** Prefix on a pseudonymised address. The relational trigger keys on it too. */
export const ERASED_PREFIX = 'sha256:';

const PURPOSE_RE = /^[a-z][a-z0-9_.:-]{0,63}$/;
const SOURCE_RE = /^[a-z0-9][a-z0-9_.:@/-]{0,79}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const IP_RE = /^[0-9a-fA-F:.]{2,45}$/;
/** Longer than any consent text a form shows, short enough to bound one row. */
export const MAX_TEXT = 20_000;
export const MAX_UA = 512;

/**
 * sha256 of the EXACT text, as UTF-8 bytes, in hex.
 *
 * Exact means exact: no trimming, no case folding, no Unicode normalisation.
 * The hash is evidence that THIS wording was shown, and two wordings that a
 * normaliser would merge (a precomposed `ά` and `α` + combining accent, say)
 * are, as far as a court is concerned, two texts. The same string always gives
 * the same hash — that is the property a recorder relies on to say "these
 * people all saw version 3".
 */
export function textHash(text: string): string {
  return crypto.createHash('sha256').update(Buffer.from(String(text), 'utf8')).digest('hex');
}

/** Lower-case, trimmed. Addresses are compared this way everywhere. */
export function normaliseConsentEmail(raw: unknown): string {
  return String(raw ?? '').trim().toLowerCase();
}

/**
 * A stable pseudonym for an address: sha256 (hex) of the normalised address.
 *
 * What goes into webhooks (`email_hash`) and, prefixed, into an erased row.
 * Unsalted on purpose: the point is that the shop — or the person, or an ESP —
 * can compute it from an address they already hold, and match it. It is NOT
 * anonymisation; anyone with a list of addresses can test them.
 */
export function emailHash(email: string): string {
  return crypto.createHash('sha256').update(normaliseConsentEmail(email), 'utf8').digest('hex');
}

/** Thrown for input a recorder must fix. `field` names what was wrong. */
export class ConsentInputError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = 'ConsentInputError';
    this.field = field;
  }
}

export function validEmail(raw: unknown): string {
  const email = normaliseConsentEmail(raw);
  if (!email || email.length > 200 || !EMAIL_RE.test(email) || /[\r\n]/.test(email)) {
    throw new ConsentInputError('email', 'a valid email address is required');
  }
  return email;
}

export function validPurpose(raw: unknown): string {
  const purpose = String(raw ?? '');
  if (!PURPOSE_RE.test(purpose)) {
    throw new ConsentInputError('purpose', 'purpose must be a lower-case identifier such as "newsletter"');
  }
  return purpose;
}

export function validSource(raw: unknown): string {
  const source = String(raw ?? '');
  if (!SOURCE_RE.test(source)) {
    throw new ConsentInputError('source', 'source must name who recorded this, e.g. "campaign-games"');
  }
  return source;
}

/**
 * ip and ua, kept only when they are what they claim to be.
 *
 * Optional: core's own flows record neither (see the newsletter routes). A
 * plugin that passes them is expected to have them from the core's client
 * helper; this is the last line, not the first — a malformed ip is dropped
 * rather than stored, a ua is stripped of control characters and capped.
 */
export function cleanClient(ip: unknown, ua: unknown): { ip?: string; ua?: string } {
  const out: { ip?: string; ua?: string } = {};
  if (typeof ip === 'string' && IP_RE.test(ip.trim())) out.ip = ip.trim();
  if (typeof ua === 'string') {
    // eslint-disable-next-line no-control-regex
    const cleaned = ua.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_UA);
    if (cleaned) out.ua = cleaned;
  }
  return out;
}

/** What a recorder passes. `text` is hashed and never stored. */
export interface ConsentRecordInput {
  email: string;
  purpose: string;
  granted: boolean;
  version: string | number;
  text: string;
  ip?: string;
  ua?: string;
  source: string;
}

/** Validate a record() call and build the row it appends. Throws ConsentInputError. */
export function buildGrantRow(input: ConsentRecordInput, id: string, at: string): ConsentLedgerRow {
  if (!input || typeof input !== 'object') throw new ConsentInputError('input', 'an object is required');
  const email = validEmail(input.email);
  const purpose = validPurpose(input.purpose);
  if (typeof input.granted !== 'boolean') {
    // Strictly boolean: `"false"` is truthy, and a consent ledger is the last
    // place a string should be read as a yes.
    throw new ConsentInputError('granted', 'granted must be true or false');
  }
  const version = typeof input.version === 'number' && Number.isFinite(input.version)
    ? String(input.version)
    : typeof input.version === 'string' ? input.version.trim() : '';
  if (!version || version.length > 64) throw new ConsentInputError('version', 'version is required (at most 64 characters)');
  if (typeof input.text !== 'string' || input.text.length === 0 || input.text.length > MAX_TEXT) {
    throw new ConsentInputError('text', `text is the exact wording shown, 1–${MAX_TEXT} characters`);
  }
  const source = validSource(input.source);
  return {
    id, email, purpose, granted: input.granted, version,
    text_hash: textHash(input.text), at, source,
    ...cleanClient(input.ip, input.ua),
  };
}

/** The state of one (email, purpose), read from its rows in write order. */
export interface ConsentState {
  /** The latest row, or null when nothing was ever recorded. */
  latest: ConsentLedgerRow | null;
  /** The latest row is a grant. */
  granted: boolean;
  /**
   * A confirmation was written after the last withdrawal, and the latest row is
   * still a grant: granted AND confirmed AND not withdrawn since.
   */
  confirmed: boolean;
  /** That confirmation row, when there is one. */
  confirmation: ConsentLedgerRow | null;
  /** The latest row is a withdrawal. */
  withdrawn: boolean;
}

/**
 * Reduce rows (already narrowed to one email and purpose, in write order).
 *
 * A NEW grant written after a confirmation (somebody signs up again, perhaps
 * under a newer text) does not unconfirm them: nothing was withdrawn. Only a
 * withdrawal resets confirmation; after one, a fresh grant needs a fresh
 * confirmation.
 */
export function consentState(rows: readonly ConsentLedgerRow[]): ConsentState {
  const latest = rows.length ? rows[rows.length - 1] : null;
  let lastWithdrawal = -1;
  rows.forEach((r, i) => { if (r.granted === false) lastWithdrawal = i; });
  let confirmation: ConsentLedgerRow | null = null;
  for (let i = rows.length - 1; i > lastWithdrawal; i--) {
    if (rows[i].granted === true && typeof rows[i].confirmed_at === 'string' && rows[i].confirmed_at) {
      confirmation = rows[i];
      break;
    }
  }
  const granted = latest?.granted === true;
  return {
    latest,
    granted,
    confirmed: granted && confirmation !== null,
    confirmation: granted ? confirmation : null,
    withdrawn: latest?.granted === false,
  };
}

/** One exportable contact: granted, confirmed, and not withdrawn since. */
export interface ExportedContact {
  email: string;
  /** When the confirmation was written. */
  confirmed_at: string;
  version: string;
  text_hash: string;
  source: string;
}

/**
 * Who may be exported for `purpose`: ONLY contacts whose consent is granted
 * AND confirmed AND not withdrawn since. Pseudonymised (erased) rows are never
 * a contact. Takes every row of that purpose in write order.
 */
export function exportableContacts(rows: readonly ConsentLedgerRow[]): ExportedContact[] {
  const byEmail = new Map<string, ConsentLedgerRow[]>();
  for (const r of rows) {
    if (r.email.startsWith(ERASED_PREFIX)) continue;
    const list = byEmail.get(r.email);
    if (list) list.push(r);
    else byEmail.set(r.email, [r]);
  }
  const out: ExportedContact[] = [];
  for (const [email, list] of byEmail) {
    const s = consentState(list);
    if (!s.confirmed || !s.confirmation) continue;
    out.push({
      email,
      confirmed_at: s.confirmation.confirmed_at as string,
      version: s.confirmation.version,
      text_hash: s.confirmation.text_hash,
      source: s.confirmation.source,
    });
  }
  return out.sort((a, b) => a.email.localeCompare(b.email));
}

/**
 * Addresses whose latest row for the purpose is a WITHDRAWAL. Takes every row
 * of one purpose in write order. The campaign sender skips these even if a
 * subscriber row somehow survived the withdrawal — the ledger outranks the list.
 */
export function withdrawnEmails(rows: readonly ConsentLedgerRow[]): Set<string> {
  const latest = new Map<string, boolean>();
  for (const r of rows) latest.set(r.email, r.granted);
  return new Set([...latest].filter(([, granted]) => granted === false).map(([email]) => email));
}

/**
 * The newsletter wording core records when a form sends none of its own.
 *
 * The footer box, the contact-form tick and the popup show no consent text of
 * their own, so this is what the person's click on the confirmation link
 * agreed to. A headless storefront that shows its own wording sends it as
 * `consent_text` + `consent_version` with the signup, and that is recorded
 * instead.
 */
export const DEFAULT_NEWSLETTER_CONSENT = {
  version: 'core-newsletter-1',
  text: 'Send me the newsletter by email. I can unsubscribe at any time with the link in every message.',
} as const;

/**
 * What a subscriber who joined before this ledger existed is recorded under.
 *
 * Their double opt-in happened (a subscriber row only ever came from a
 * confirmation click), but the wording they saw was not kept. The row says
 * exactly that rather than pretending to a text it cannot prove.
 */
export const MIGRATION_CONSENT = {
  version: 'pre-ledger',
  text: 'Confirmed by double opt-in before the consent ledger existed; the wording shown at the time was not recorded.',
} as const;

/** What the migration needs from storage — the Storage interface, narrowed. */
export interface LedgerMigrationStorage {
  getSubscribers(): Promise<{ email: string; created_at: string }[]>;
  getConsentRows(query?: { email?: string; purpose?: string }): Promise<ConsentLedgerRow[]>;
  appendConsentRow(row: ConsentLedgerRow): Promise<ConsentLedgerRow>;
}

/**
 * Record every existing subscriber as a confirmed `newsletter` consent
 * (`source: 'migration'`), so the export rule — granted AND confirmed — does
 * not silently drop the whole list the day the ledger arrives.
 *
 * One row each: a grant that is also the confirmation (`confirmed_at` = when
 * the subscriber row was created, which was the confirmation click — core only
 * ever created one there). IDEMPOTENT: an address with ANY newsletter row
 * already is skipped, so a second run writes nothing, and a person who
 * withdrew before this ran is never re-granted by it. Returns rows written.
 */
export async function migrateSubscribersToLedger(storage: LedgerMigrationStorage): Promise<number> {
  const subscribers = await storage.getSubscribers();
  const seen = new Set(
    (await storage.getConsentRows({ purpose: NEWSLETTER_PURPOSE })).map((r) => r.email),
  );
  const hash = textHash(MIGRATION_CONSENT.text);
  let written = 0;
  // Oldest first, so the ledger's write order matches the order they joined.
  const ordered = [...subscribers].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  for (const sub of ordered) {
    const email = normaliseConsentEmail(sub.email);
    if (!email || !EMAIL_RE.test(email) || email.length > 200 || seen.has(email)) continue;
    const when = typeof sub.created_at === 'string' && !Number.isNaN(Date.parse(sub.created_at))
      ? sub.created_at
      : new Date().toISOString();
    await storage.appendConsentRow({
      id: `cl_${crypto.randomUUID()}`, email, purpose: NEWSLETTER_PURPOSE, granted: true,
      version: MIGRATION_CONSENT.version, text_hash: hash,
      at: when, source: 'migration', confirmed_at: when,
    });
    seen.add(email);
    written += 1;
  }
  return written;
}
