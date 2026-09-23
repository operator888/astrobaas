/**
 * de — admin.orders.*
 *
 * One file per screen. 983 keys in a single module is a file nobody can review
 * and every translator conflicts in; split by surface, a screen's strings live
 * next to each other and two people can work at once.
 *
 * The status and payment labels below are LABELS ONLY. The values they describe
 * ('pending', 'on-hold', …) are the API's vocabulary and stay in the `value=`
 * attribute and the data-* attributes, untranslated — the select still posts
 * `on-hold` however the option reads.
 */
export const orders = {
  'admin.orders.title': 'Bestellungen',
  'admin.orders.subtitle': 'Kundenbestellungen und Auftragsabwicklung',
  'admin.orders.statTotal': 'Bestellungen insgesamt',
  'admin.orders.statOpen': 'Offen (ausstehend / in Bearbeitung)',
  'admin.orders.statRevenue': 'Umsatz aus abgeschlossenen Bestellungen',
  'admin.orders.empty': 'Noch keine Bestellungen vorhanden.',

  // Fulfilment status — one label per ORDER_STATUSES value.
  'admin.orders.statusPending': 'ausstehend',
  'admin.orders.statusProcessing': 'in Bearbeitung',
  'admin.orders.statusOnHold': 'angehalten',
  'admin.orders.statusCompleted': 'abgeschlossen',
  'admin.orders.statusCancelled': 'storniert',
  'admin.orders.statusRefunded': 'erstattet',
  'admin.orders.statusFailed': 'fehlgeschlagen',

  // Payment status — tracked separately from fulfilment.
  'admin.orders.paymentPaid': '✓ bezahlt',
  'admin.orders.paymentPending': '⋯ Zahlung ausstehend',
  'admin.orders.paymentFailed': '✕ Zahlung fehlgeschlagen',
  'admin.orders.paymentRefunded': '↩ erstattet',
  'admin.orders.paymentUnpaid': 'unbezahlt',

  'admin.orders.methodBankTransfer': '🏦 Überweisung',
  'admin.orders.prescription': 'Rezept',
  'admin.orders.prescriptionDelete': 'löschen',
  'admin.orders.trackingCarrier': 'Versanddienst',
  'admin.orders.trackingNumber': 'Sendungsnummer',
  'admin.orders.trackingSend': 'Speichern & benachrichtigen',
  'admin.orders.trackingUpdate': 'Sendungsdaten aktualisieren',
  'admin.orders.trackingFailed': 'Sendungsdaten konnten nicht gespeichert werden.',
  'admin.orders.shippedOn': 'Versandt am {date}',
  'admin.orders.staffNotePlaceholder': 'Interne Notiz — für den Kunden nicht sichtbar',
  'admin.orders.staffNoteFailed': 'Notiz konnte nicht gespeichert werden.',
  'admin.orders.prescriptionDeleteConfirm': 'Rezept zu Bestellung {number} endgültig löschen? Es sind Gesundheitsdaten, die das System bei einer Kundenlöschung bewusst behält — löschen Sie sie erst nach Ablauf Ihrer Aufbewahrungsfrist. Nicht widerrufbar.',
  'admin.orders.prescriptionDeleteFailed': 'Rezept konnte nicht gelöscht werden.',
  'admin.orders.note': 'Notiz: {note}',

  'admin.orders.refundedAmount': '−{amount} erstattet',
  'admin.orders.refundRemaining': '{amount} verbleibend',
  'admin.orders.statusLocked': 'Ihre Rolle erlaubt das Ansehen von Bestellungen, aber nicht das Ändern des Bestellstatus. Ein Administrator oder Redakteur kann dies tun.',
  'admin.orders.refund': 'Erstatten…',
  'admin.orders.refundInProviderDashboard': 'Erstattung im Dashboard von {provider} vornehmen',

  'admin.orders.needsRefund': 'Erstattung nötig — nach der Stornierung bezahlt, kein Bestand mehr',
  'admin.orders.declines': 'Abgelehnte Kartenversuche: {count}',
  'admin.orders.riskHeld': 'Zur Prüfung zurückgestellt (Risiko)',
  'admin.orders.riskFlagged': 'Risiko markiert',
  'admin.orders.holdExpired': 'Zahlungsfrist abgelaufen',

  // Browser-side (window.t): no plural support, so nothing here takes a count.
  'admin.orders.updateFailed': 'Aktualisierung fehlgeschlagen',
  'admin.orders.refundPromptTitle': 'Bestellung {number} über {provider} erstatten.',
  'admin.orders.refundPromptMax': 'Es können bis zu {amount} {currency} erstattet werden.',
  'admin.orders.refundPromptEnter': 'Geben Sie einen Betrag ein oder lassen Sie das Feld leer, um den gesamten Betrag von {amount} {currency} zu erstatten.',
  'admin.orders.amountInvalid': 'Geben Sie einen positiven Betrag ein.',
  'admin.orders.amountTooHigh': 'Das übersteigt die noch erstattungsfähigen {amount} {currency}.',
  'admin.orders.refundFullAmount': '{amount} {currency} (vollständig)',
  'admin.orders.refundConfirm': 'Sollen {amount} an die Kundin oder den Kunden zurückerstattet werden? Dies kann hier nicht rückgängig gemacht werden.',
  'admin.orders.refunding': 'Erstattung läuft…',
  'admin.orders.refundFailed': 'Erstattung fehlgeschlagen',
};

export default orders;
