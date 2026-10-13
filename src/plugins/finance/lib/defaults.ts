import type { CompanyProfile, FinanceSettings } from './types';
import { DEFAULT_SERIES } from './numbering';

export const DEFAULT_COMPANY: CompanyProfile = {
  name: '', street: '', zip: '', city: '', country: 'DE', email: '', phone: '', contact_person: '',
  small_business: false, vat_basis: 'soll', chart: 'SKR03', fiscal_year_start_month: 1,
  default_payment_days: 14, default_currency: 'EUR', document_language: 'de', accent_color: '#1d4ed8',
};

export const DEFAULT_SETTINGS: FinanceSettings = {
  series: DEFAULT_SERIES,
  texts: {
    invoice_intro: 'Vielen Dank für Ihren Auftrag. Wir berechnen Ihnen folgende Leistungen:',
    invoice_closing: 'Mit freundlichen Grüßen',
    quote_intro: 'Gerne unterbreiten wir Ihnen folgendes Angebot:',
    quote_closing: 'Wir freuen uns auf Ihre Rückmeldung.',
    credit_note_intro: 'Hiermit korrigieren wir die unten genannte Rechnung wie folgt:',
    email_subject: '{type} {number} von {company}',
    email_body: 'Guten Tag,\n\nanbei erhalten Sie {type} {number} über {amount}.\n\nSie können das Dokument auch hier abrufen:\n{link}\n\nMit freundlichen Grüßen\n{company}',
  },
  dunning: {
    level_days: [7, 21, 35],
    fees_cents: [0, 500, 1000],
    titles: ['Zahlungserinnerung', '1. Mahnung', '2. Mahnung'],
    texts: [
      'sicher ist es Ihrer Aufmerksamkeit entgangen: Für die unten aufgeführte Rechnung konnten wir bisher keinen Zahlungseingang feststellen. Bitte überweisen Sie den offenen Betrag bis zum {pay_by}. Sollte sich Ihre Zahlung mit diesem Schreiben überschnitten haben, betrachten Sie es bitte als gegenstandslos.',
      'leider konnten wir trotz unserer Zahlungserinnerung bisher keinen Zahlungseingang feststellen. Wir bitten Sie, den offenen Betrag zuzüglich Mahngebühr bis zum {pay_by} zu überweisen.',
      'trotz wiederholter Aufforderung ist der unten aufgeführte Betrag weiterhin offen. Bitte begleichen Sie ihn bis spätestens {pay_by}. Andernfalls sehen wir uns gezwungen, weitere Schritte einzuleiten.',
    ],
    charge_interest: false,
    // Basiszinssatz §247 BGB — changes every 1 January and 1 July; keep it current.
    base_rate_percent: 1.27,
  },
  auto_invoice_shop_orders: false,
  account_overrides: {},
  datev_use_personal_accounts: true,
  next_debitor: 10001,
  next_kreditor: 70001,
};
