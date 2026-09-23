/**
 * Data-subject rights: access (Article 15) and erasure (Article 17).
 *
 * Somebody emails the shop asking what it holds about them, or asking for it
 * to be deleted. The operator has a month to answer, and answering by hand
 * means opening five screens and hoping they remembered all of them.
 *
 * ## The decision this file is built around
 *
 * **Erasure is not deletion of everything.** An order is a commercial record
 * with a statutory retention period — five years in Greece, six to ten
 * elsewhere — and deleting it to satisfy an erasure request breaks a legal
 * obligation the shop cannot waive. Article 17(3)(b) says exactly this: the
 * right to erasure does not apply where processing is necessary for compliance
 * with a legal obligation.
 *
 * But keeping the order with the buyer's name, address and phone number on it
 * is not erasure either. So orders are **pseudonymised**: the totals, the line
 * items, the dates and the tax stay, and everything identifying the person is
 * replaced. The books still add up; the person is gone from them.
 *
 * ## Pseudonymised, NOT anonymised — and the difference is legal
 *
 * This file used to say "anonymised" throughout. It is not, and claiming so to
 * a supervisory authority would be a false statement. `payment_reference` is a
 * live pointer into the payment provider's own record, which still holds the
 * buyer's name and email: one lookup in their dashboard re-identifies the
 * order. Recital 26 asks whether identification is possible by any means
 * REASONABLY LIKELY, and a dashboard the operator logs into every day is
 * reasonably likely.
 *
 * That is lawful — Art 17(3)(b) and (e) permit retaining it — but it is
 * retention, not anonymisation, and the wording everywhere in this feature now
 * says so.
 *
 * Everything else — the customer record, contact messages, the newsletter
 * subscription, form submissions — is deleted outright.
 *
 * ## What this deliberately does NOT do
 *
 * It does not verify that the requester is who they say they are. Identity
 * verification is the controller's job and it is not a technical one: the
 * operator confirms the request through a channel they trust and then runs
 * this. Building a self-serve "delete my data" button, reachable by anyone who
 * knows an email address, would turn a compliance feature into a way to erase
 * a competitor's customer.
 */
import crypto from 'node:crypto';
import { LocalDB } from './localdb';
import { getContentTypes } from '../core/content-types';
import type { ContactMessage, Customer, EmailLogEntry, Order, Subscriber, User } from '../core/models';
import { fieldsOfType, valuesAt } from './field-walk';
import { deletePrivateFile } from './media/private-files';

/** Everything one email address appears in. */
export interface SubjectData {
  email: string;
  generated_at: string;
  customer: Customer | null;
  orders: Order[];
  messages: ContactMessage[];
  newsletter: Subscriber | null;
  /**
   * The staff account, if the address has one — SAFE FIELDS ONLY.
   *
   * A concrete type rather than Omit<User, …>: an Omit deny-list would keep
   * silently re-admitting each new secret field added to User (that is exactly
   * how two_factor leaked). This names what a subject may see, so a field is
   * absent unless it is listed.
   */
  account: Pick<User, 'id' | 'name' | 'email' | 'role' | 'status' | 'avatar' | 'last_login' | 'created_at' | 'updated_at'> | null;
  /** Entries in custom collections whose fields carry this address. */
  submissions: { type: string; label: string; entries: unknown[] }[];
  /**
   * Emails this install sent to the address.
   *
   * Included because the log holds recipient addresses, which makes it
   * personal data — and a store of personal data outside the tooling built to
   * answer requests about personal data is exactly the gap this file exists to
   * close. Subjects and outcomes only; the log never held the bodies.
   */
  emails: EmailLogEntry[];
  /**
   * Counts of the transient operational records that mention this address —
   * change-feed snapshots and webhook deliveries. Reported as counts rather
   * than dumped: they are internal bookkeeping, not something the subject
   * authored, but the operator (and an access request) should know they exist
   * and that erasure clears them.
   */
  operational: { changeFeed: number; webhookDeliveries: number };
}

export interface EraseReport {
  email: string;
  performed_at: string;
  /** Records removed entirely. */
  deleted: { customers: number; messages: number; newsletter: number; submissions: number; emails: number; changeFeed: number; webhookDeliveries: number };
  /**
   * Orders kept, with everything identifying the person replaced. Retained
   * because a shop must be able to produce its accounts.
   */
  ordersAnonymised: number;
  /**
   * A staff account, if the address has one. NEVER touched automatically —
   * see the note in `eraseSubject`.
   */
  staffAccountFound: boolean;
  notes: string[];
}

/** Case-insensitive, whitespace-trimmed. Addresses are compared this way everywhere. */
export function normaliseEmail(raw: unknown): string {
  return String(raw ?? '').trim().toLowerCase();
}

/** Does this stored value hold the address we are looking for? */
function mentionsEmail(value: unknown, email: string): boolean {
  if (typeof value === 'string') return value.trim().toLowerCase() === email;
  if (Array.isArray(value)) return value.some((v) => mentionsEmail(v, email));
  return false;
}

/**
 * Custom-collection entries that carry this address.
 *
 * Only fields the type declared as `email` are searched. A free-text message
 * that happens to mention an address is somebody else's data as much as
 * theirs, and a substring sweep across every field would hand a requester
 * other people's enquiries — a data breach performed in the name of a data
 * request.
 */
async function findSubmissions(email: string): Promise<SubjectData['submissions']> {
  const out: SubjectData['submissions'] = [];
  for (const def of getContentTypes()) {
    // fieldsOfType, not a flat filter. An email address inside a repeater item
    // is still that person's address, and a sweep that could not see it would
    // answer a subject-access request with "we hold nothing about you" while
    // holding it — which is the one failure mode of this function that is
    // itself a breach.
    const emailFields = fieldsOfType(def, 'email');
    if (emailFields.length === 0) continue;
    const entries = (await LocalDB.getCustomEntities(def.name)) as { id: string; data?: Record<string, unknown> }[];
    const mine = entries.filter((e) => emailFields.some(
      (w) => valuesAt(w, e.data).some((v) => mentionsEmail(v, email)),
    ));
    if (mine.length > 0) out.push({ type: def.name, label: def.label, entries: mine });
  }
  return out;
}

/**
 * Everything this install holds about one address.
 *
 * The shape is deliberately readable rather than compact: the output is
 * something a person receives and reads, and in a dispute it is the evidence
 * that the request was answered.
 */
export async function collectSubjectData(rawEmail: string): Promise<SubjectData> {
  const email = normaliseEmail(rawEmail);
  await LocalDB.init();

  const customers = (await LocalDB.getCustomers()) as Customer[];
  const customer = customers.find((c) => normaliseEmail(c.email) === email) ?? null;

  const allOrders = (await LocalDB.getOrders()) as Order[];
  // By email AND by customer id: an order placed as a guest carries the
  // address but no customer, and one placed later while signed in carries the
  // id. Matching only one of the two misses half of somebody's history.
  const orders = allOrders.filter(
    (o) => normaliseEmail(o.email) === email || (!!customer && o.customer_id === customer.id),
  );

  const messages = ((await LocalDB.getMessages()) as ContactMessage[])
    .filter((m) => normaliseEmail(m.email) === email);

  const newsletter = ((await LocalDB.getSubscribers()) as Subscriber[])
    .find((s) => normaliseEmail(s.email) === email) ?? null;

  const account = ((await LocalDB.getUsers()) as User[])
    .find((u) => normaliseEmail(u.email) === email) ?? null;

  return {
    email,
    generated_at: new Date().toISOString(),
    customer,
    orders,
    messages,
    newsletter,
    // Credential material never leaves the server, an export least of all.
    // A DENY-list (strip password_hash/password_salt) missed two_factor — the
    // live TOTP secret and the backup-code hashes — which then went into the
    // JSON handed to whoever asked. An ALLOW-list cannot miss the next secret
    // field added to User: only these safe fields are copied, everything else
    // (credentials, session_version, whatever comes later) is dropped by
    // omission.
    account: account ? {
      id: account.id,
      name: account.name,
      email: account.email,
      role: account.role,
      status: account.status,
      avatar: account.avatar,
      last_login: account.last_login,
      created_at: account.created_at,
      updated_at: account.updated_at,
    } : null,
    submissions: await findSubmissions(email),
    emails: ((await LocalDB.getEmailLog(2000)) as EmailLogEntry[])
      .filter((e) => normaliseEmail(e.to) === email),
    operational: {
      // Counted where the rows are, by the same substring rule the erasure
      // deletes by (deleteContentChangesFor). Not a page of the feed: a
      // subject-access answer has to cover EVERY retained entry, and a page
      // would quietly report "…of the newest hundred". Not the whole feed
      // loaded either: on the relational driver that pulled every retained
      // snapshot — full orders and products — into memory to count a handful.
      changeFeed: await LocalDB.countContentChangesFor(email),
      webhookDeliveries: ((await LocalDB.getWebhookDeliveries({ limit: 1000 })) as unknown[])
        .filter((d) => JSON.stringify(d).toLowerCase().includes(email)).length,
    },
  };
}

/**
 * A single-use, inert address for one erased order.
 *
 * Random rather than derived: derived from the order id would be reversible by
 * anyone holding both, which is every operator and anyone reading a backup.
 */
function erasedToken(): string {
  return `erased+${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}@invalid`;
}

/**
 * What a pseudonymised order looks like.
 *
 * Exported and pure so the test can state the property directly: nothing
 * identifying survives, and nothing financial is touched.
 */
export function anonymisedOrderFields(order: Order): Partial<Order> {
  return {
    // A PER-ORDER token, not a shared constant.
    //
    // `erased@erased.invalid` was the same string on every erased order of
    // every install — and it is written in a public repository, which makes it
    // a published credential. `findOrderForEmail` matches on the stored
    // address, so that constant plus an order number retrieved somebody's
    // erased order; `boughtProduct` uses the same match, so it also minted a
    // "verified buyer" stamp on a review. An audit found it.
    //
    // `.invalid` is reserved by RFC 2606 and can never receive mail, so the
    // token is inert as an address. The randomness only has to make two erased
    // orders unlinkable and the value unguessable; the real protection is the
    // `erased_at` gate below, which makes the address unusable even if known.
    email: erasedToken(),
    name: 'Erased at the customer’s request',
    phone: '',
    address: '',
    // THE STRUCTURED ADDRESSES GO WHOLE.
    //
    // Clearing the flat `address` string above used to be the whole job, and
    // the moment `shipping_address` and `billing_address` existed it stopped
    // being: those objects carry a recipient name, a company, a delivery phone
    // and a ΑΦΜ, none of which the flat string ever held. Erasing the one-line
    // rendering while leaving the fields it was rendered FROM would be an
    // erasure that reads as complete and is not.
    //
    // This is the sibling-gap shape, and the test that "covered" erasure could
    // not have caught it: it asserts on `address` by name, so it would have
    // gone on passing while the new objects sat there untouched.
    //
    // No country is preserved here even though the country has a fiscal
    // purpose — `shipping_country` below already carries the place of supply,
    // and a half-emptied address object with one field left in it is an
    // invitation for the next reader to wonder what else survived.
    shipping_address: undefined,
    billing_address: undefined,
    // The buyer's free-text note is their words and often their identity.
    note: '',
    // THE PRESCRIPTION STAYS. This is an owner decision, and it reverses what
    // this function used to do.
    //
    // A γνωμάτευση frozen onto a line is Article 9 health data, and the first
    // version stripped it on the reasoning that special-category data should
    // not survive an erasure request. The owner — who runs the two optical
    // shops this software was written for — has since answered the question
    // that was blocking it: the prescriptions ARE to be retained, and the
    // optician decides when one goes.
    //
    // That is lawful under Article 17(3)(b): the right to erasure does not
    // apply where processing is necessary to comply with a legal obligation
    // requiring retention. It is also the practical answer — the prescription
    // is the record that settles a dispute about a remake, and the lab worked
    // from it.
    //
    // What makes it defensible is that everything IDENTIFYING has gone by the
    // time this line runs: the name, the address, the phone, the email and the
    // customer link are all cleared above, so what remains is a clinical
    // measurement attached to an order number. The erase report says so in
    // words, because a report that silently retained health data would be
    // useless to an operator answering a supervisory authority.
    //
    // Deleting one is a deliberate act on the orders screen, not a side effect
    // of somebody else's erasure request.
    items: order.items ?? [],
    // The link to the customer record goes too — that record is about to be
    // deleted, and a dangling id is a worse trace than none.
    customer_id: undefined,
    // The POSTCODE goes, and the country stays.
    //
    // The postcode has no fiscal purpose — whatever it priced is retained as a
    // figure in `shipping_cents` — and on a record that also carries the exact
    // basket, the total and the timestamp it is the strongest re-identification
    // handle left. The free-text `address` was already cleared and this was
    // not, which made clearing it half a measure.
    //
    // `shipping_country` stays: it is the VAT place of supply, and the figure
    // in `tax_cents` cannot be explained to an inspector without it.
    shipping_postcode: undefined,
    // The gate. Nothing public may reach an order carrying this — see
    // `commerce/order-lookup.ts`. A DATE rather than a timestamp so a subject's
    // orders do not cluster into one second; see the note on the field.
    erased_at: new Date().toISOString().slice(0, 10),
  };
}

/**
 * Perform an erasure.
 *
 * Reports what happened rather than returning a boolean: this is a legal act,
 * the operator has to be able to say what was done, and "it worked" is not an
 * answer to a supervisory authority.
 */
export async function eraseSubject(rawEmail: string): Promise<EraseReport> {
  const email = normaliseEmail(rawEmail);
  await LocalDB.init();

  const report: EraseReport = {
    email,
    performed_at: new Date().toISOString(),
    deleted: { customers: 0, messages: 0, newsletter: 0, submissions: 0, emails: 0, changeFeed: 0, webhookDeliveries: 0 },
    ordersAnonymised: 0,
    staffAccountFound: false,
    notes: [],
  };

  const data = await collectSubjectData(email);

  // Orders FIRST, while the customer record still exists to match against.
  for (const order of data.orders) {
    await LocalDB.updateOrder(order.id, anonymisedOrderFields(order));
    report.ordersAnonymised += 1;
  }
  if (report.ordersAnonymised > 0) {
    report.notes.push(
      `${report.ordersAnonymised} order(s) were kept with their identifying fields removed, `
      + 'rather than deleted: a shop must be able to produce its accounts and to defend a '
      + 'chargeback or a conformity claim, and Article 17(3)(b) and (e) do not require erasing '
      + 'records kept for those purposes. '
      // Said plainly, because an operator may repeat this sentence to a
      // supervisory authority and it must be true. The payment reference is a
      // live pointer into the provider's record, which still names the buyer.
      + 'These records are PSEUDONYMISED, not anonymous: the payment reference still resolves to '
      + 'the buyer inside the payment provider. They remain personal data and stay within scope '
      + 'of your retention policy.',
    );

    // Said separately and plainly, because it is the one place this erasure
    // KEEPS special-category data. An operator may have to repeat this sentence
    // to a supervisory authority, and a report that quietly retained health
    // data would leave them unable to.
    const withRx = data.orders.reduce(
      (n, o) => n + (o.items ?? []).filter((line) => 'prescription' in line && line.prescription).length,
      0,
    );
    if (withRx > 0) {
      report.notes.push(
        `${withRx} order line(s) keep the prescription they were ordered with. This is health `
        + 'data under Article 9 and it is RETAINED deliberately, under Article 17(3)(b): an '
        + 'optician has a professional obligation to keep the practitioner\'s prescription, and '
        + 'it is the record that settles a later dispute about a remake. Everything identifying '
        + 'has been removed from these orders, so what remains is a clinical measurement against '
        + 'an order number. If your retention period for prescriptions has expired, delete them '
        + 'individually from the order in Orders — that is a separate, deliberate action.',
      );
    }
  }

  if (data.customer) {
    await LocalDB.deleteCustomer(data.customer.id);
    report.deleted.customers = 1;
  }

  for (const m of data.messages) {
    await LocalDB.deleteMessage(m.id);
    report.deleted.messages += 1;
  }

  if (data.newsletter) {
    await LocalDB.deleteSubscriber(data.newsletter.id);
    report.deleted.newsletter = 1;
  }

  // The send log. Deleted rather than anonymised: unlike an order it is a
  // convenience, not a record anyone is required to keep.
  report.deleted.emails = await LocalDB.deleteEmailLogFor(email);

  // Two transient operational stores that hold FULL snapshots — the change
  // feed and webhook delivery records — carry the pre-erasure order and
  // submission data (name, email, phone, address) and must be purged too, or
  // the erasure leaves a copy of exactly what it just deleted a poll or a
  // webhook-log screen away.
  report.deleted.changeFeed = await LocalDB.deleteContentChangesFor(email);
  report.deleted.webhookDeliveries = await LocalDB.deleteWebhookDeliveriesFor(email);

  for (const group of data.submissions) {
    const def = getContentTypes().find((d) => d.name === group.type);
    const fileFields = def ? fieldsOfType(def, 'file') : [];
    for (const entry of group.entries as { id: string; data?: Record<string, unknown> }[]) {
      // The BYTES first, then the record. An attachment left on disk after the
      // record naming it is gone is an erasure that did not erase — and it is
      // then unreachable from the admin, so nobody would ever find it to
      // delete by hand. The file is deleted first because failing after the
      // record is gone would leave no way to know which file to remove.
      for (const walked of fileFields) {
        for (const id of valuesAt(walked, entry.data)) {
          await deletePrivateFile(id).catch(() => false);
        }
      }
      await LocalDB.deleteCustomEntity(group.type, entry.id);
      report.deleted.submissions += 1;
    }
  }

  // A staff account is NOT deleted here, deliberately and loudly.
  //
  // Deleting a user orphans everything they authored, and an address with a
  // login is usually a colleague rather than a customer — an erasure request
  // matching one is far more likely to be a coincidence than an instruction to
  // remove a member of staff. The operator is told and decides.
  if (data.account) {
    report.staffAccountFound = true;
    report.notes.push(
      'This address also has a staff account. It was NOT removed: deleting a user orphans the '
      + 'content they wrote, and an erasure request rarely means "delete my colleague". '
      + 'Remove it under Users if that is what was asked for.',
    );
  }

  if (report.ordersAnonymised === 0
    && report.deleted.customers === 0
    && report.deleted.messages === 0
    && report.deleted.newsletter === 0
    && report.deleted.submissions === 0
    && report.deleted.emails === 0
    && report.deleted.changeFeed === 0
    && report.deleted.webhookDeliveries === 0) {
    report.notes.push('Nothing was found for this address. There is nothing to erase.');
  }

  return report;
}
