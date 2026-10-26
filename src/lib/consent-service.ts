/**
 * Writing to the consent ledger, and what a newsletter decision does.
 *
 * The rules live in `consent-ledger.ts` (pure); this is the one place rows are
 * appended. Every writer goes through here — the newsletter routes, the admin
 * withdrawal, the public withdrawal link and the plugin host
 * (`host.consent.*`) — so "a confirmed newsletter consent subscribes, a
 * withdrawal unsubscribes" is decided once.
 *
 * ## Newsletter = the `newsletter` purpose
 *
 * The subscriber list is kept as it was (campaigns, the admin screen and the
 * ESP webhooks all read it), and this module keeps it in step with the ledger:
 *
 *   - a CONFIRMATION of `newsletter` consent adds the address, fires
 *     `subscriber.confirmed` (the existing ESP event) and `newsletter.subscribed`
 *     (`{ email_hash, source, at }` — never the raw address);
 *   - a WITHDRAWAL removes every row for the address and fires
 *     `subscriber.unsubscribed`.
 *
 * A grant alone subscribes nobody. That is the double opt-in, and it is why a
 * plugin calling `confirm({ purpose: 'newsletter' })` for somebody who never
 * ticked the newsletter box gets `{ confirmed: false }` and changes nothing.
 *
 * ## One process at a time per address
 *
 * `confirm` reads the latest row and then appends; two confirmations of one
 * address racing in the same process are serialised so the second sees the
 * first's row. Across instances the worst case is a duplicate confirmation
 * row — harmless, because every effect here is idempotent.
 */
import crypto from 'node:crypto';
import type { ConsentLedgerRow } from '../core/models';
import { LocalDB } from './localdb';
import { fireEvent } from './webhooks';
import {
  buildGrantRow, cleanClient, consentState, emailHash, exportableContacts,
  validEmail, validPurpose, validSource, NEWSLETTER_PURPOSE, ERASED_PREFIX,
  type ConsentRecordInput, type ConsentState, type ExportedContact,
} from './consent-ledger';

const locks = new Map<string, Promise<unknown>>();

/** Run `fn` after any earlier call for the same key has settled. */
async function serialised<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  locks.set(key, run);
  try {
    return await run;
  } finally {
    if (locks.get(key) === run) locks.delete(key);
  }
}

const newRowId = () => `cl_${crypto.randomUUID()}`;

async function append(row: ConsentLedgerRow): Promise<ConsentLedgerRow> {
  await LocalDB.init();
  return LocalDB.appendConsentRow(row) as Promise<ConsentLedgerRow>;
}

/**
 * Every row for one address (all purposes), in write order.
 *
 * When there are none under the address, the rows an ERASURE kept for it are
 * returned instead — found by hashing the address, which is the promise the
 * erase report makes ("hashing the same address finds them again").
 */
export async function consentRowsFor(rawEmail: string): Promise<ConsentLedgerRow[]> {
  await LocalDB.init();
  const email = validEmail(rawEmail);
  const rows = await LocalDB.getConsentRows({ email }) as ConsentLedgerRow[];
  if (rows.length) return rows;
  return LocalDB.getConsentRows({ email: `${ERASED_PREFIX}${emailHash(email)}` }) as Promise<ConsentLedgerRow[]>;
}

/** The current state of one (email, purpose). */
export async function consentStateFor(rawEmail: string, rawPurpose: string): Promise<ConsentState> {
  await LocalDB.init();
  const rows = await LocalDB.getConsentRows({ email: validEmail(rawEmail), purpose: validPurpose(rawPurpose) });
  return consentState(rows as ConsentLedgerRow[]);
}

/* ------------------------------------------------- newsletter effects --- */

/**
 * Put a CONFIRMED address on the list.
 *
 * Idempotent: a link clicked twice, or a prefetching mail client that opens it
 * before the human does, must not create a second row — and there is no
 * unique index on any driver, so uniqueness lives in the write.
 */
async function subscribeConfirmed(email: string, source: string, at: string): Promise<void> {
  const existing = await LocalDB.getSubscribers();
  const already = (existing as { email?: string }[]).some(
    (s) => typeof s?.email === 'string' && s.email.trim().toLowerCase() === email,
  );
  if (!already) {
    await LocalDB.createSubscriber(email);
    // ESP sync (C-113). Fired only on a FIRST confirmation: a second click
    // must not re-import the address, and the double-opt-in click is the
    // only moment at which forwarding it to a third party is lawful.
    // Fire-and-forget, like every other event — a subscriber must not fail
    // to be recorded because somebody's automation is down.
    void fireEvent('subscriber.confirmed', { email, confirmed_at: at });
    // The same moment, without the address: what an integration that needs
    // to COUNT or correlate signups — a campaign plugin, an analytics sink —
    // gets, so it never has to hold the address itself.
    void fireEvent('newsletter.subscribed', { email_hash: emailHash(email), source, at });
  }
}

/**
 * Take an address off the list.
 *
 * Every matching row, not the first: nothing in any driver enforces
 * uniqueness, so a list that somehow holds a duplicate must still end up with
 * the person gone rather than half-gone.
 */
async function unsubscribeAll(email: string): Promise<void> {
  const all = await LocalDB.getSubscribers();
  const matches = (all as { id?: string; email?: string }[]).filter(
    (row) => typeof row?.email === 'string' && row.email.trim().toLowerCase() === email,
  );
  for (const m of matches) {
    if (m.id) await LocalDB.deleteSubscriber(m.id);
  }
  // ONE event for the person, not one per duplicate row (C-113). This is the
  // event that must reach the ESP: an unsubscribe this site honours and
  // Mailchimp does not is the shape that ends in a spam complaint, which is
  // why an integration built on the confirm event alone would be worse than
  // none at all. Fire-and-forget — somebody's automation being down must not
  // stop a person leaving.
  // Fired whether or not a row was here to delete.
  //
  // Gating it on `matches.length` looked tidy and was the named failure: the
  // reader clicks unsubscribe, the row goes, the webhook delivery to the ESP
  // fails, they keep receiving ESP mail, they click the link in the NEXT
  // message — and this time there is no row, so no event, so they are
  // permanently un-removable from the ESP. An unsubscribe is idempotent at
  // every ESP, so a duplicate costs nothing and a missing one costs a spam
  // complaint.
  void fireEvent('subscriber.unsubscribed', { email, unsubscribed_at: new Date().toISOString() });
}

/* ---------------------------------------------------------- the API --- */

/**
 * Record a decision — `host.consent.record`.
 *
 * Appends one row and returns its id, the hash of the text, and the time. A
 * grant subscribes nobody (that needs `confirmConsent`); a `granted: false`
 * for `newsletter` is a withdrawal and takes the address off the list.
 * Throws `ConsentInputError` for input the recorder must fix.
 */
export async function recordConsent(input: ConsentRecordInput): Promise<{ id: string; text_hash: string; at: string }> {
  const row = buildGrantRow(input, newRowId(), new Date().toISOString());
  return serialised(`${row.email}\u0000${row.purpose}`, async () => {
    const saved = await append(row);
    if (saved.purpose === NEWSLETTER_PURPOSE && saved.granted === false) await unsubscribeAll(saved.email);
    return { id: saved.id, text_hash: saved.text_hash, at: saved.at };
  });
}

/**
 * Confirm a double opt-in — `host.consent.confirm`.
 *
 * Confirms ONLY when the latest row for (email, purpose) is a grant.
 * Otherwise — nothing recorded, or the latest row is a withdrawal — it writes
 * nothing and answers `{ confirmed: false }`. Already confirmed since the last
 * withdrawal: `{ confirmed: true }`, and nothing new is written.
 *
 * The confirmation row copies the version and text hash of the grant it
 * confirms, so the row a dispute turns on carries the wording by itself.
 */
export async function confirmConsent(input: {
  email: string; purpose: string; source: string; ip?: string; ua?: string;
}): Promise<{ confirmed: boolean }> {
  if (!input || typeof input !== 'object') return { confirmed: false };
  const email = validEmail(input.email);
  const purpose = validPurpose(input.purpose);
  const source = validSource(input.source);
  return serialised(`${email}\u0000${purpose}`, async () => {
    await LocalDB.init();
    const rows = await LocalDB.getConsentRows({ email, purpose }) as ConsentLedgerRow[];
    const state = consentState(rows);
    if (!state.granted || !state.latest) return { confirmed: false };
    // Already confirmed, and the latest row IS that confirmation: a second
    // click. Anything else — a newer grant on top of an old confirmation — is
    // a new text being confirmed, and gets its own row.
    if (state.confirmed && state.latest === state.confirmation) {
      if (purpose === NEWSLETTER_PURPOSE) await subscribeConfirmed(email, source, state.latest.confirmed_at as string);
      return { confirmed: true };
    }
    const at = new Date().toISOString();
    const row: ConsentLedgerRow = {
      id: newRowId(), email, purpose, granted: true,
      version: state.latest.version, text_hash: state.latest.text_hash,
      at, source, confirmed_at: at,
      ...cleanClient(input.ip, input.ua),
    };
    await append(row);
    if (purpose === NEWSLETTER_PURPOSE) await subscribeConfirmed(email, source, at);
    return { confirmed: true };
  });
}

/**
 * Withdraw — `host.consent.withdraw`, the unsubscribe link, the admin button.
 *
 * Appends a `granted: false` row carrying the version and text hash of what is
 * being withdrawn (empty when nothing was ever granted — a person may object
 * before they were ever asked, and that is worth recording too). A repeat
 * withdrawal writes no second row. For `newsletter`, the address leaves the
 * list and the ESP event fires every time — see `unsubscribeAll`.
 */
export async function withdrawConsent(input: { email: string; purpose: string; source: string }): Promise<void> {
  if (!input || typeof input !== 'object') throw new Error('withdrawConsent: an object is required');
  const email = validEmail(input.email);
  const purpose = validPurpose(input.purpose);
  const source = validSource(input.source);
  await serialised(`${email}\u0000${purpose}`, async () => {
    await LocalDB.init();
    const rows = await LocalDB.getConsentRows({ email, purpose }) as ConsentLedgerRow[];
    const state = consentState(rows);
    if (!state.withdrawn) {
      await append({
        id: newRowId(), email, purpose, granted: false,
        version: state.latest?.version ?? '', text_hash: state.latest?.text_hash ?? '',
        at: new Date().toISOString(), source,
      });
    }
    if (purpose === NEWSLETTER_PURPOSE) await unsubscribeAll(email);
  });
}

/**
 * The double opt-in from core's own signup forms, at the moment of the click.
 *
 * The signup itself stores nothing (see newsletter-confirm.ts — holding an
 * address nobody has confirmed is the problem), so the GRANT is written here,
 * from the version and text hash the signed link carries, and confirmed at
 * once. Two rows: what was agreed to, and that the owner of the inbox said yes.
 * The grant's `at` is when the link was minted — the signup — not the click.
 *
 * A link minted BEFORE a withdrawal is dead: somebody who left must not be put
 * back on the list because an old email was opened again (by them, or by a
 * mail scanner that follows links). It writes nothing and answers
 * `{ confirmed: false }`; signing up again mints a new link, which works.
 *
 * A second click of a link already confirmed writes nothing. A confirmed
 * subscriber who signs up again under DIFFERENT wording gets that wording's
 * grant and confirmation recorded.
 */
export async function confirmNewsletterSignup(
  rawEmail: string,
  consent: { version: string; text_hash: string; issued_at?: string },
): Promise<{ confirmed: boolean }> {
  const email = validEmail(rawEmail);
  const issued = consent.issued_at && !Number.isNaN(Date.parse(consent.issued_at)) ? consent.issued_at : null;
  const proceed = await serialised(`${email}\u0000${NEWSLETTER_PURPOSE}`, async () => {
    await LocalDB.init();
    const rows = await LocalDB.getConsentRows({ email, purpose: NEWSLETTER_PURPOSE }) as ConsentLedgerRow[];
    // Any withdrawal written after this link was minted kills the link.
    if (rows.some((r) => r.granted === false && (!issued || Date.parse(r.at) >= Date.parse(issued)))) return false;
    const state = consentState(rows);
    const sameWording = (r: ConsentLedgerRow | null) =>
      !!r && r.text_hash === consent.text_hash && r.version === consent.version;
    if (state.confirmed && sameWording(state.confirmation)) return true;
    // Not re-granted when the latest row is this same grant, still unconfirmed
    // (a click that failed half-way and is retried).
    const sameGrant = state.granted && sameWording(state.latest) && !state.latest?.confirmed_at;
    if (!sameGrant) {
      await append({
        id: newRowId(), email, purpose: NEWSLETTER_PURPOSE, granted: true,
        version: consent.version, text_hash: consent.text_hash,
        at: issued ?? new Date().toISOString(), source: 'newsletter_form',
      });
    }
    return true;
  });
  if (!proceed) return { confirmed: false };
  // Already confirmed under this wording: confirmConsent writes nothing and
  // only keeps the list in step (idempotent). Otherwise it appends the
  // confirmation row.
  return confirmConsent({ email, purpose: NEWSLETTER_PURPOSE, source: 'newsletter_confirm_link' });
}

/** The newsletter export: granted AND confirmed AND not withdrawn since. */
export async function newsletterExport(): Promise<ExportedContact[]> {
  await LocalDB.init();
  return exportableContacts(await LocalDB.getConsentRows({ purpose: NEWSLETTER_PURPOSE }) as ConsentLedgerRow[]);
}

/** May this address be sent newsletter mail? The export rule, for one address. */
export async function isNewsletterContact(rawEmail: string): Promise<boolean> {
  try {
    return (await consentStateFor(rawEmail, NEWSLETTER_PURPOSE)).confirmed;
  } catch {
    return false;
  }
}
