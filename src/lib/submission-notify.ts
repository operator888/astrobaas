/**
 * Telling the shop that somebody filled in a form.
 *
 * ## Why this is one module and not two call sites
 *
 * There are two ways a form reaches this CMS — the built-in contact endpoint,
 * and a content type with `writable: 'public'` — and only the second one ever
 * sent an email. The first stored the message and returned, so a shop whose
 * contact page is the built-in one heard nothing at all until somebody opened
 * the admin inbox.
 *
 * Two paths, one behaviour, implemented once: the sibling gap this codebase
 * keeps finding. In particular the RECIPIENT has to be resolved the same way,
 * or an operator sets `contact_notify_email` and gets notified about one kind
 * of submission and not the other, with nothing anywhere explaining the
 * difference.
 *
 * ## What is in the email, and what is not
 *
 * The submitted values, as plain text. Never HTML: a submission is attacker-
 * controlled text, and the only way to be certain it cannot become markup in
 * somebody's mail client is for the message to have no markup at all.
 *
 * Values are truncated. A 40 kB paste in a message field should not become a
 * 40 kB email to every member of staff — the full text is in the admin, which
 * is where a reply happens anyway.
 */
import { LocalDB } from './localdb';
import { sendEmail, emailChannelActive } from './email';
import { renderStoredTemplate } from './email-templates';

/** How much of any one field travels in the notification. */
export const MAX_FIELD_CHARS = 500;

/**
 * Settings consulted for the notification address, in order.
 *
 * Returns null when none holds a usable address, which is a fresh install's
 * ordinary state and not an error worth logging on every submission.
 */
export const RECIPIENT_KEYS = [
  // The dedicated one, for a shop that wants submissions to go somewhere other
  // than the operator's own address.
  'contact_notify_email',
  // What the public contact page already displays.
  'contact_email',
  // The operator's address. LAST, and the reason this chain exists: the first
  // version read only `contact_notify_email` and `site_email`, and NEITHER is
  // written by any screen in the admin — so the notification resolved to null
  // on every install and nothing was ever sent. A fallback chain that ends at a
  // key the settings form actually saves means an existing install starts
  // working without anyone configuring anything.
  'admin_email',
] as const;

export async function submissionRecipient(): Promise<string | null> {
  for (const key of RECIPIENT_KEYS) {
    const raw = (await LocalDB.getSetting(key))?.value;
    if (typeof raw !== 'string') continue;
    const to = raw.trim();
    if (to.includes('@')) return to;
  }
  return null;
}

/** One `label: value` line per field, truncated and never interpolated. */
export function submissionLines(fields: readonly { name: string; value: unknown }[]): string {
  return fields
    .map(({ name, value }) => `${name}: ${String(value ?? '').slice(0, MAX_FIELD_CHARS)}`)
    .join('\n');
}

/**
 * The address a reply to a content-type submission should go to: the value of
 * the first field the DEFINITION declares as an email address, or undefined.
 *
 * Read from the definition, never from whichever submitted key looks like an
 * address — a submitter must not be able to choose which field is "theirs".
 */
export function submitterReplyTo(
  fields: readonly { name: string; rule: { type: string } }[],
  values: Record<string, unknown>,
): string | undefined {
  const field = fields.find((f) => f.rule.type === 'email');
  const value = field ? values[field.name] : undefined;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export interface SubmissionNotice {
  /** What was submitted, e.g. "contact message" or a content type's label. */
  what: string;
  fields: readonly { name: string; value: unknown }[];
  /** Where to find it, in words. Appended so a reader knows where to reply. */
  whereToFind: string;
  /**
   * The submitter's own address, when the form asked for one — so the site
   * owner can press Reply and reach the person who wrote. sendEmail drops it for
   * the EMAIL_REPLY_TO default if it is not a usable address, so a visitor
   * cannot use this field to put anything else into a header.
   */
  replyTo?: string;
}

/**
 * Send the notification. Never throws.
 *
 * A submission is already stored by the time this runs. A mail transport that
 * is down must not turn a successful form post into an error for the visitor,
 * who would then submit again — and the shop would have two copies of a message
 * and still no email.
 */
export async function notifySubmission(notice: SubmissionNotice): Promise<void> {
  try {
    if (!emailChannelActive()) return;
    const to = await submissionRecipient();
    if (!to) return;

    // Operator-editable wording (C-112). The placeholders are the SITE's own
    // label and link, never anything from the submission — a subject built
    // from attacker-controlled text is a header-injection surface, and that
    // property survives templating because the parameters are chosen here.
    const mail = await renderStoredTemplate('submission_notice', {
      site_title: (await LocalDB.getSetting('site_title'))?.value ?? 'your site',
      what: notice.what,
      admin_link: notice.whereToFind,
    }, (key) => LocalDB.getSetting(key));

    await sendEmail({
      to,
      subject: mail!.subject,
      // The submitted FIELDS are appended rather than templated: they are the
      // one part an operator must not be able to move into the subject, and
      // the one part that is a stranger's text.
      text: `${mail!.text}\n\n${submissionLines(notice.fields)}`,
      ...(notice.replyTo ? { replyTo: notice.replyTo } : {}),
    });
  } catch (err) {
    console.error(
      `Submission notification failed:`,
      err instanceof Error ? err.message : err,
    );
  }
}
