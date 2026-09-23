/**
 * EU right of withdrawal — Consumer Rights Directive 2011/83/EU.
 *
 * **This is a compliance aid, not legal advice.** It generates the standard
 * texts the Directive itself supplies (the model instructions in Annex I(A) and
 * the model withdrawal form in Annex I(B)) from the trader details an operator
 * configures. Member States transpose the Directive with variations, some goods
 * are exempt, and a shop selling digital content or services has extra duties.
 * An operator still has to check their own jurisdiction. The code says so in
 * the rendered output too, so nobody mistakes a generated page for advice.
 *
 * What the Directive actually requires of a distance seller to a consumer, and
 * what this module therefore models:
 *
 *  - **14 days** to withdraw without giving any reason (Art. 9). The clock runs
 *    from delivery for goods, from conclusion of the contract for services.
 *  - **Failure to inform extends the period by 12 months** (Art. 10). That is
 *    why the notice is not optional decoration: getting it wrong turns a
 *    14-day exposure into a 12-month-and-14-day one.
 *  - **A model withdrawal form must be provided** (Art. 6(1)(h), Annex I(B)).
 *  - **Trader identity, address and contact details** must be given (Art. 6(1)(b–c)).
 *  - **The order button must state the payment obligation** (Art. 8(2)) — in
 *    practice "Order with obligation to pay" or equally unambiguous wording. A
 *    button saying only "Confirm" does not bind the consumer.
 *  - **Refund within 14 days of being informed** (Art. 13), using the same
 *    payment means the consumer used.
 *  - **Exemptions exist** (Art. 16): made-to-measure goods, sealed goods
 *    unsealed after delivery for health/hygiene reasons, perishables, and more.
 *
 * Everything here is pure so the generated text and the period arithmetic are
 * unit-testable without a database.
 */

import { withdrawalStringsFor } from './legal/withdrawal-locales';
import { settingBool } from './settings-map';

/** Settings keys, exported so the admin form and the reader cannot drift. */
export const WITHDRAWAL_KEYS = {
  enabled: 'withdrawal_enabled',
  days: 'withdrawal_days',
  traderName: 'trader_legal_name',
  traderAddress: 'trader_address',
  traderEmail: 'trader_email',
  traderPhone: 'trader_phone',
  /** Free text: categories this shop treats as exempt under Art. 16. */
  exemptions: 'withdrawal_exemptions',
  /** Who pays return postage. The Directive requires this to be stated. */
  returnCosts: 'withdrawal_return_costs',
} as const;

/** The Directive's minimum. An operator may grant longer, never shorter. */
export const WITHDRAWAL_MINIMUM_DAYS = 14;
/** A sane ceiling so a typo cannot create a 10-year return policy. */
export const WITHDRAWAL_MAXIMUM_DAYS = 365;

export type ReturnCostBearer = 'customer' | 'trader';

export interface WithdrawalPolicy {
  enabled: boolean;
  /** Never below the statutory 14. */
  days: number;
  traderName: string;
  traderAddress: string;
  traderEmail: string;
  traderPhone: string;
  exemptions: string;
  returnCosts: ReturnCostBearer;
}

/** Which trader fields the Directive requires before the notice is meaningful. */
export const REQUIRED_TRADER_FIELDS = ['traderName', 'traderAddress', 'traderEmail'] as const;

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * Resolve the policy from settings. Pure and clamped.
 *
 * The clamp only ever moves the period UP to the statutory minimum. An operator
 * who types 7 does not get a 7-day policy that silently breaks the law — they
 * get 14. Granting more than the minimum is allowed, so the ceiling is generous.
 */
export function resolveWithdrawalPolicy(
  settings: Record<string, unknown> | null | undefined,
): WithdrawalPolicy {
  const map = settings ?? {};
  const rawDays = map[WITHDRAWAL_KEYS.days];
  const parsed = typeof rawDays === 'string' ? Number(rawDays) : rawDays;
  let days = WITHDRAWAL_MINIMUM_DAYS;
  if (typeof parsed === 'number' && Number.isFinite(parsed)) {
    days = Math.min(WITHDRAWAL_MAXIMUM_DAYS, Math.max(WITHDRAWAL_MINIMUM_DAYS, Math.floor(parsed)));
  }

  return {
    // settingBool, not `!== false`. The admin form posts a real boolean, but
    // the relational driver stores every setting as TEXT, so it comes back as
    // the STRING "false" — which is not `false`, and an operator who switched
    // the withdrawal notice off still had it published. Default true: the
    // Directive's notice is on unless somebody explicitly turns it off.
    enabled: settingBool(map[WITHDRAWAL_KEYS.enabled], true),
    days,
    traderName: str(map[WITHDRAWAL_KEYS.traderName]),
    traderAddress: str(map[WITHDRAWAL_KEYS.traderAddress]),
    traderEmail: str(map[WITHDRAWAL_KEYS.traderEmail]),
    traderPhone: str(map[WITHDRAWAL_KEYS.traderPhone]),
    exemptions: str(map[WITHDRAWAL_KEYS.exemptions]),
    returnCosts: map[WITHDRAWAL_KEYS.returnCosts] === 'trader' ? 'trader' : 'customer',
  };
}

/**
 * Trader fields still missing.
 *
 * Surfaced in the admin, because a withdrawal notice with a blank address is
 * worse than none: it looks compliant while failing the Art. 6 information duty
 * that the 12-month extension in Art. 10 punishes.
 */
export function missingTraderFields(policy: WithdrawalPolicy): string[] {
  const labels: Record<(typeof REQUIRED_TRADER_FIELDS)[number], string> = {
    traderName: 'Legal name',
    traderAddress: 'Postal address',
    traderEmail: 'Contact email',
  };
  return REQUIRED_TRADER_FIELDS.filter((f) => policy[f] === '').map((f) => labels[f]);
}

/** Is the notice complete enough to publish? */
export function policyIsPublishable(policy: WithdrawalPolicy): boolean {
  return policy.enabled && missingTraderFields(policy).length === 0;
}

/**
 * Deadline for a given order, as an ISO date.
 *
 * The Directive runs the period from the day AFTER the triggering event
 * (Art. 9(2)); day zero is the delivery/conclusion day itself. Getting the
 * off-by-one wrong here shortens a consumer's statutory right by a day.
 */
export function withdrawalDeadline(startIso: string, days: number): string | null {
  const start = Date.parse(startIso);
  if (!Number.isFinite(start)) return null;
  const d = new Date(start);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + days + 1);
  return d.toISOString().slice(0, 10);
}

/** The trader block reused by both generated texts. */
function traderBlock(p: WithdrawalPolicy): string {
  const lines = [p.traderName, p.traderAddress, p.traderEmail];
  if (p.traderPhone) lines.push(p.traderPhone);
  return lines.filter(Boolean).join('\n');
}

/**
 * Model instructions on withdrawal, after Annex I(A).
 *
 * Returned as plain text: it is inserted into HTML by the caller, which escapes
 * it. Building HTML here would put operator-supplied trader details into markup
 * at the point of generation, which is how a settings field becomes stored XSS.
 */
export function withdrawalInstructions(p: WithdrawalPolicy, locale = 'en'): string {
  // Falls back to English when the locale has no text OR when its text has not
  // been checked against the Directive — see withdrawal-locales.ts. Serving a
  // legal notice nobody has read is the failure that gate exists to prevent.
  const { strings: T } = withdrawalStringsFor(locale);
  const days = String(p.days);
  const returnCosts = p.returnCosts === 'trader' ? T.returnCostsTrader : T.returnCostsCustomer;

  return [
    T.rightTitle,
    '',
    T.rightIntro.replace('{days}', days),
    '',
    T.periodExpires.replace('{days}', days),
    '',
    T.informUs,
    '',
    traderBlock(p),
    '',
    T.unequivocal,
    '',
    T.deadlineNotice,
    '',
    T.effectsTitle,
    '',
    T.reimburse,
    '',
    T.sameMeans,
    '',
    returnCosts,
    '',
    T.diminishedValue,
    // The exemptions are the OPERATOR's own words, in whatever language they
    // wrote them. Not translated, and not translatable: paraphrasing a trader's
    // own legal exclusions would be inventing terms on their behalf.
    ...(p.exemptions ? ['', T.exceptionsTitle, '', p.exemptions] : []),
  ].join('\n');
}

/** Model withdrawal form, after Annex I(B). Plain text; the caller escapes it. */
export function modelWithdrawalForm(p: WithdrawalPolicy, locale = 'en'): string {
  const { strings: T } = withdrawalStringsFor(locale);
  return [
    T.formTitle,
    '',
    T.formOnlyIf,
    '',
    T.formTo,
    traderBlock(p),
    '',
    T.formNotice,
    '',
    T.formOrderedOn,
    T.formConsumerName,
    T.formConsumerAddress,
    T.formSignature,
    T.formDate,
    '',
    T.formDeleteAsAppropriate,
  ].join('\n');
}

/**
 * Label for the order-confirmation button.
 *
 * Art. 8(2): the button must be labelled so the consumer explicitly
 * acknowledges that ordering entails an obligation to pay. "Confirm" or
 * "Continue" alone does not bind them — an unlabelled button can leave the
 * contract unenforceable, so this is exported for storefronts to use verbatim.
 */
export const ORDER_BUTTON_LABEL = 'Order with obligation to pay';

/**
 * The same label, in the buyer's language.
 *
 * Article 8(2) is about what the CONSUMER understands, so an English button on
 * a German checkout does not discharge it. Falls back to English for an
 * unverified locale, like the rest of this text.
 */
export function orderButtonLabel(locale = 'en'): string {
  return withdrawalStringsFor(locale).strings.orderButtonLabel;
}
