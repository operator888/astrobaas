/** Printed words on documents, German and English. */
export const DOC_STRINGS = {
  de: {
    invoice: 'Rechnung', credit_note: 'Gutschrift / Rechnungskorrektur', quote: 'Angebot', dunning: 'Zahlungserinnerung',
    number: { invoice: 'Rechnungsnr.', credit_note: 'Gutschriftsnr.', quote: 'Angebotsnr.' },
    date: 'Datum', customerNo: 'Kundennr.', serviceDate: 'Leistungsdatum', servicePeriod: 'Leistungszeitraum',
    dueDate: 'Fällig am', validUntil: 'Gültig bis', refersTo: 'Bezieht sich auf Rechnung', page: 'Seite',
    pos: 'Pos.', description: 'Beschreibung', qty: 'Menge', unit: 'Einheit', unitPrice: 'Einzelpreis', total: 'Gesamt',
    net: 'Nettobetrag', vat: 'zzgl. USt.', gross: 'Gesamtbetrag', grossIncl: 'Gesamtbetrag (inkl. USt.)',
    discount: 'Rabatt', vatId: 'USt-IdNr.', taxNo: 'Steuernr.', yourVatId: 'Ihre USt-IdNr.',
    bank: 'Bankverbindung', contact: 'Kontakt', register: 'Handelsregister', md: 'Geschäftsführer',
    payWithin: (days: number, date: string) => `Zahlbar innerhalb von ${days} Tagen bis zum ${date} ohne Abzug.`,
    payReference: (n: string) => `Bitte geben Sie bei der Zahlung die Rechnungsnummer ${n} an.`,
    alreadyPaid: 'Bereits bezahlt', openAmount: 'Offener Betrag', fee: 'Mahngebühr', interest: 'Verzugszinsen',
    dunningTable: 'Offene Rechnungen', retention: '',
  },
  en: {
    invoice: 'Invoice', credit_note: 'Credit note', quote: 'Quotation', dunning: 'Payment reminder',
    number: { invoice: 'Invoice no.', credit_note: 'Credit note no.', quote: 'Quote no.' },
    date: 'Date', customerNo: 'Customer no.', serviceDate: 'Date of supply', servicePeriod: 'Service period',
    dueDate: 'Due date', validUntil: 'Valid until', refersTo: 'Refers to invoice', page: 'Page',
    pos: 'Pos.', description: 'Description', qty: 'Qty', unit: 'Unit', unitPrice: 'Unit price', total: 'Amount',
    net: 'Net amount', vat: 'VAT', gross: 'Total', grossIncl: 'Total (incl. VAT)',
    discount: 'Discount', vatId: 'VAT ID', taxNo: 'Tax no.', yourVatId: 'Your VAT ID',
    bank: 'Bank details', contact: 'Contact', register: 'Commercial register', md: 'Managing director',
    payWithin: (days: number, date: string) => `Payable within ${days} days, by ${date}, without deduction.`,
    payReference: (n: string) => `Please quote invoice number ${n} with your payment.`,
    alreadyPaid: 'Already paid', openAmount: 'Amount due', fee: 'Reminder fee', interest: 'Default interest',
    dunningTable: 'Open invoices', retention: '',
  },
} as const;

export type DocStrings = (typeof DOC_STRINGS)['de'] | (typeof DOC_STRINGS)['en'];

/** UN/ECE Rec 20 unit codes → printed label. */
export const UNITS: Record<string, { de: string; en: string }> = {
  HUR: { de: 'Std.', en: 'hrs' },
  DAY: { de: 'Tag(e)', en: 'day(s)' },
  WEE: { de: 'Woche(n)', en: 'week(s)' },
  MON: { de: 'Monat(e)', en: 'month(s)' },
  ANN: { de: 'Jahr(e)', en: 'year(s)' },
  MIN: { de: 'Min.', en: 'min' },
  C62: { de: 'Stk.', en: 'pcs' },
  H87: { de: 'Stk.', en: 'pcs' },
  LS: { de: 'pauschal', en: 'flat' },
  KGM: { de: 'kg', en: 'kg' },
  MTR: { de: 'm', en: 'm' },
  E48: { de: 'Leistung', en: 'service' },
};

export function unitLabel(code: string, lang: 'de' | 'en'): string {
  return UNITS[code]?.[lang] ?? code;
}
