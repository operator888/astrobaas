/**
 * Operator-editable wording for the emails this site sends (C-112).
 *
 * ## What the row was actually asking for
 *
 * Templates already existed — one per event, in code. The gap is that a shop
 * cannot change a word of them. "Your order has been received" arrives in
 * English on a Greek shop, and the only fix is a deploy.
 *
 * ## Wording, not delivery
 *
 * A template supplies a SUBJECT and a BODY. It does not decide who is written
 * to, when, or whether the mail is sent at all — those stay in the code that
 * knows. That boundary is what stops "the operator can edit the emails" from
 * becoming "the operator can accidentally stop the password reset from being
 * sent".
 *
 * ## Required placeholders are the whole safety story
 *
 * A password-reset email without its link is a support ticket the operator
 * cannot see coming: the mail sends, it looks fine, and it is useless. So each
 * template declares which placeholders it CANNOT do without, and a body missing
 * one is refused at save time with the reason.
 *
 * Rendering has a second door: a stored template that somehow fails validation
 * — written before a placeholder was added, say — falls back to the built-in
 * default rather than sending something broken. Refusing to send would turn an
 * editing mistake into a customer never hearing from the shop.
 *
 * ## Plain text, deliberately
 *
 * These are transactional emails; the ones that reach an inbox reliably are the
 * ones that look like a person wrote them. HTML here would mean a sanitizer, a
 * second rendering path, and an operator able to paste a tracking pixel into
 * the password reset.
 */
import { headerSafe } from './email-mime';

export interface EmailTemplateDef {
  id: string;
  label: string;
  /** When this is sent, in a sentence an operator can act on. */
  when: string;
  /** Every placeholder this template is given. */
  placeholders: readonly string[];
  /** Without these the email does not do its job. Enforced on save. */
  required: readonly string[];
  defaultSubject: string;
  defaultBody: string;
  /**
   * Only the subject is editable.
   *
   * For an email whose body is a structured DOCUMENT rather than prose — an
   * itemised order, with a plain-text and an HTML rendering that have to agree.
   * Letting an operator retype that would hand them responsibility for
   * reproducing the line items and the total correctly, and the failure would
   * show up in a customer's inbox after the money had moved.
   */
  subjectOnly?: boolean;
}

/**
 * The catalogue.
 *
 * Only emails whose WORDING an operator would want to change. The bounce
 * notice, the health probe and the newsletter campaign body are absent: the
 * first two are for the operator's own eyes and the third is already composed
 * per send.
 */
export const EMAIL_TEMPLATES: readonly EmailTemplateDef[] = [
  {
    id: 'order_confirmation',
    label: 'Order confirmation',
    when: 'To the customer, as soon as an order is placed.',
    placeholders: ['site_title', 'order_number', 'customer_name', 'order_total', 'order_lines', 'payment_instructions'],
    required: ['order_number'],
    subjectOnly: true,
    defaultSubject: '{{site_title}} — order {{order_number}}',
    defaultBody: [
      'Hello {{customer_name}},',
      '',
      'Thank you for your order {{order_number}}.',
      '',
      '{{order_lines}}',
      '',
      'Total: {{order_total}}',
      '',
      '{{payment_instructions}}',
      '',
      '{{site_title}}',
    ].join('\n'),
  },
  {
    id: 'stock_back',
    label: 'Back in stock',
    when: 'Once, to somebody who asked to be told when a sold-out product returned.',
    placeholders: ['site_title', 'product_name', 'product_url'],
    required: ['product_name'],
    subjectOnly: true,
    defaultSubject: '{{site_title}} — {{product_name}} is back in stock',
    defaultBody: [
      '{{product_name}} is back in stock.',
      '',
      '{{product_url}}',
      '',
      '{{site_title}}',
    ].join('\n'),
  },
  {
    id: 'order_recovery',
    label: 'Unpaid order reminder',
    when: 'Once, to a customer whose order is still unpaid — before it is cancelled.',
    placeholders: ['site_title', 'order_number', 'order_total', 'days_left', 'payment_instructions'],
    required: ['order_number'],
    subjectOnly: true,
    defaultSubject: '{{site_title}} — your order {{order_number}} is waiting',
    defaultBody: [
      'Your order {{order_number}} is still waiting for payment.',
      '',
      'Total: {{order_total}}',
      '',
      '{{payment_instructions}}',
      '',
      '{{site_title}}',
    ].join('\n'),
  },
  {
    id: 'order_shipped',
    label: 'Order shipped',
    when: 'To the customer, the first time tracking is recorded on their order.',
    placeholders: ['site_title', 'order_number', 'carrier', 'tracking_number'],
    required: ['order_number'],
    subjectOnly: true,
    defaultSubject: '{{site_title}} — order {{order_number}} is on its way',
    defaultBody: [
      'Your order {{order_number}} is on its way.',
      '',
      'Carrier: {{carrier}}',
      'Tracking number: {{tracking_number}}',
      '',
      '{{site_title}}',
    ].join('\n'),
  },
  {
    id: 'password_reset',
    label: 'Password reset',
    when: 'When somebody asks to reset their password.',
    placeholders: ['site_title', 'reset_link', 'expires_in'],
    // Without the link the mail sends, looks fine, and is useless.
    required: ['reset_link'],
    defaultSubject: 'Reset your {{site_title}} password',
    defaultBody: [
      'Somebody asked to reset the password for this account.',
      '',
      '{{reset_link}}',
      '',
      'The link works for {{expires_in}}. If it was not you, ignore this email — nothing has changed.',
    ].join('\n'),
  },
  {
    id: 'magic_link',
    label: 'Sign-in link',
    when: 'When somebody signs in with a link instead of a password.',
    placeholders: ['site_title', 'sign_in_link', 'expires_in'],
    required: ['sign_in_link'],
    defaultSubject: 'Your sign-in link',
    defaultBody: [
      'Here is your link to sign in to {{site_title}}:',
      '',
      '{{sign_in_link}}',
      '',
      'It works once, for {{expires_in}}. If you did not ask for it, ignore this email.',
    ].join('\n'),
  },
  {
    id: 'newsletter_confirm',
    label: 'Newsletter confirmation',
    when: 'To a new subscriber, to confirm they meant to subscribe.',
    placeholders: ['site_title', 'confirm_link'],
    // Double opt-in without a confirm link is a subscriber who can never be
    // mailed and a list that looks broken.
    required: ['confirm_link'],
    defaultSubject: 'Confirm your subscription to {{site_title}}',
    defaultBody: [
      'Please confirm you want to receive emails from {{site_title}}:',
      '',
      '{{confirm_link}}',
      '',
      'If you did not ask for this, ignore this email and you will not hear from us again.',
    ].join('\n'),
  },
  {
    id: 'submission_notice',
    label: 'New form submission',
    when: 'To the site owner, when somebody sends a form.',
    placeholders: ['site_title', 'what', 'admin_link'],
    required: [],
    defaultSubject: 'New {{what}} on your site',
    defaultBody: [
      'Somebody sent a {{what}} through {{site_title}}.',
      '',
      '{{admin_link}}',
      '',
      'The message itself is not included here on purpose — it is in the admin, where access is controlled.',
    ].join('\n'),
  },
] as const;

export function getEmailTemplate(id: string): EmailTemplateDef | undefined {
  return EMAIL_TEMPLATES.find((t) => t.id === id);
}

/** The settings key one template's override lives under. */
export function emailTemplateKey(id: string): string {
  return `email_template_${id}`;
}

export interface EmailTemplateOverride {
  subject: string;
  body: string;
}

const PLACEHOLDER = /\{\{\s*([a-z0-9_]+)\s*\}\}/gi;

/** Every placeholder a string uses, lower-cased and de-duplicated. */
export function placeholdersIn(text: string): string[] {
  return [...new Set([...String(text ?? '').matchAll(PLACEHOLDER)].map((m) => m[1].toLowerCase()))];
}

/**
 * Why this edit cannot be saved, or `null`.
 *
 * Every message names the specific thing to fix. "Invalid template" is a
 * message an operator can only respond to by giving up.
 */
export function templateProblem(def: EmailTemplateDef, edit: EmailTemplateOverride): string | null {
  const subject = String(edit?.subject ?? '').trim();
  const body = String(edit?.body ?? '').trim();
  if (!subject) return 'The subject cannot be empty.';
  // A subject-only template keeps the built-in body, so an empty one here is
  // the normal case rather than a mistake.
  if (!body && !def.subjectOnly) return 'The message cannot be empty.';
  if (subject.length > 200) return 'The subject is too long (200 characters at most).';
  if (body.length > 20_000) return 'The message is too long (20,000 characters at most).';

  // A subject is a header. CR/LF in one is how an injected header gets added,
  // and this is an operator-supplied string.
  if (/[\r\n]/.test(edit.subject)) return 'The subject cannot contain a line break.';

  const known = new Set(def.placeholders.map((p) => p.toLowerCase()));
  const used = [...placeholdersIn(subject), ...placeholdersIn(body)];
  const unknown = used.filter((p) => !known.has(p));
  if (unknown.length) {
    return `This email has no ${unknown.map((u) => `{{${u}}}`).join(', ')}. Available: ${def.placeholders.map((p) => `{{${p}}}`).join(', ')}.`;
  }

  // A required placeholder must be in the BODY. The first version of this
  // accepted it in the subject too, which was worse than useless: it let an
  // operator save a password reset whose body says "contact support" and whose
  // SUBJECT LINE carries the live token — into MTA logs, notification previews
  // and lock-screen banners, where a subject is the one part that travels
  // furthest and is logged most.
  //
  // `subjectOnly` templates are checked against their built-in body, which is
  // the body that will actually be sent.
  const inBody = new Set(placeholdersIn(def.subjectOnly ? def.defaultBody : body));
  const missing = def.required.filter((r) => !inBody.has(r.toLowerCase()));
  if (missing.length) {
    return `${missing.map((m) => `{{${m}}}`).join(', ')} has to stay in the message — without it this email does not do its job.`;
  }

  // A SECRET does not belong in a subject line, wherever else it appears.
  const secretInSubject = def.required.filter(
    (r) => /link|token|code|password/i.test(r) && placeholdersIn(subject).includes(r.toLowerCase()),
  );
  if (secretInSubject.length) {
    return `${secretInSubject.map((m) => `{{${m}}}`).join(', ')} cannot go in the subject — a subject line is logged by mail servers and shown on lock screens.`;
  }
  return null;
}

/** Read a stored override, or `null` when there is none or it is unusable. */
export function readOverride(def: EmailTemplateDef, raw: unknown): EmailTemplateOverride | null {
  if (!raw) return null;
  let value: unknown = raw;
  if (typeof value === 'string') {
    // The relational driver stores settings as TEXT, so a saved object comes
    // back as its JSON. Same shape the other object-valued settings handle.
    try { value = JSON.parse(value); } catch { return null; }
  }
  if (!value || typeof value !== 'object') return null;
  const edit = {
    subject: String((value as any).subject ?? ''),
    body: String((value as any).body ?? ''),
  };
  // The second door. A template written before a placeholder was renamed would
  // otherwise send a customer `{{order_no}}` verbatim.
  return templateProblem(def, edit) ? null : edit;
}

/**
 * Fill a template.
 *
 * A placeholder with no value becomes the empty string rather than staying as
 * `{{customer_name}}`, because an unfilled placeholder in a customer's inbox
 * is worse than a slightly awkward sentence. Values are inserted verbatim —
 * this is plain text, and there is nothing to escape.
 */
export function fillTemplate(text: string, params: Record<string, unknown>): string {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(params ?? {})) {
    lower[k.toLowerCase()] = v === null || v === undefined ? '' : String(v);
  }
  return String(text ?? '').replace(PLACEHOLDER, (_, name: string) => lower[String(name).toLowerCase()] ?? '');
}

export interface RenderedEmail {
  subject: string;
  text: string;
  /** True when the operator's own wording was used. Surfaced in the preview. */
  customised: boolean;
}

/**
 * The subject and body to send.
 *
 * `settingValue` is what the settings table holds for this template, passed in
 * rather than read here — this stays pure, so every caller and every test runs
 * the identical code.
 */
export function renderEmailTemplate(
  id: string,
  params: Record<string, unknown>,
  settingValue?: unknown,
): RenderedEmail | null {
  const def = getEmailTemplate(id);
  if (!def) return null;
  const override = readOverride(def, settingValue);
  const subject = fillTemplate(override?.subject ?? def.defaultSubject, params);
  // A subject-only template never takes its body from the override, even if
  // one somehow got stored — the built-in document is the one that agrees with
  // the HTML rendering beside it.
  const text = fillTemplate(def.subjectOnly ? def.defaultBody : (override?.body ?? def.defaultBody), params);
  return {
    // headerSafe last, so an operator's subject and a filled-in value are both
    // flattened — a customer name containing a newline is the injection here.
    subject: headerSafe(subject),
    text,
    customised: override !== null,
  };
}

/**
 * Render a template using the settings table, for a caller inside a request.
 *
 * Exists so the five senders share one line rather than five copies of
 * "read the setting, call the renderer, fall back". A read that fails does not
 * stop the email: the built-in wording goes out instead, because a database
 * hiccup must not swallow a password reset.
 */
export async function renderStoredTemplate(
  id: string,
  params: Record<string, unknown>,
  readSetting: (key: string) => Promise<{ value?: unknown } | null | undefined>,
): Promise<RenderedEmail | null> {
  let stored: unknown;
  try {
    stored = (await readSetting(emailTemplateKey(id)))?.value;
  } catch {
    stored = undefined;
  }
  return renderEmailTemplate(id, params, stored);
}
