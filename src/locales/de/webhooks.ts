/**
 * de — admin.webhooks.*
 *
 * One file per screen. 983 keys in a single module is a file nobody can review
 * and every translator conflicts in; split by surface, a screen's strings live
 * next to each other and two people can work at once.
 */
export const webhooks = {
  'admin.webhooks.title': 'Webhooks',
  'admin.webhooks.intro': 'Erhalten Sie ein signiertes POST, sobald sich Inhalte ändern. Das Signaturgeheimnis wird nur einmal bei der Registrierung angezeigt.',

  // Secret disclosure
  'admin.webhooks.secretWarning': 'Kopieren Sie das Signaturgeheimnis jetzt — es wird nicht erneut angezeigt.',
  'admin.webhooks.copy': 'Kopieren',

  // Registration form
  'admin.webhooks.urlLabel': 'Endpunkt-URL',
  'admin.webhooks.eventsLabel': 'Ereignisse',
  // {all} and {prefix} are code samples supplied by the page, not translated.
  'admin.webhooks.eventsHint': 'Durch Kommas getrennt. Verwenden Sie {all} für alle oder einen Platzhalter der Form {prefix}.',
  'admin.webhooks.register': 'Webhook registrieren',

  // Webhook table
  'admin.webhooks.colUrl': 'URL',
  'admin.webhooks.colEvents': 'Ereignisse',
  'admin.webhooks.colActive': 'Aktiv',
  'admin.webhooks.colActions': 'Aktionen',
  'admin.webhooks.loading': 'Wird geladen…',
  'admin.webhooks.empty': 'Noch keine Webhooks vorhanden.',
  'admin.webhooks.yes': 'Ja',
  'admin.webhooks.no': 'Nein',
  'admin.webhooks.viewDeliveries': 'Zustellungen',
  'admin.webhooks.delete': 'Löschen',
  'admin.webhooks.deleteConfirm': 'Den Webhook für {url} wirklich löschen?',

  // Deliveries table
  'admin.webhooks.deliveriesTitle': 'Letzte Zustellungen',
  'admin.webhooks.deliveriesTitleFiltered': 'Zustellungen für den ausgewählten Webhook',
  'admin.webhooks.colEvent': 'Ereignis',
  'admin.webhooks.colStatus': 'Status',
  'admin.webhooks.colAttempts': 'Versuche',
  'admin.webhooks.colLastCode': 'Letzter Statuscode',
  'admin.webhooks.colWhen': 'Zeitpunkt',
  'admin.webhooks.deliveriesEmpty': 'Noch keine Zustellungen vorhanden.',
  'admin.webhooks.redeliver': 'Erneut zustellen',

  // Delivery status LABELS. The stored values stay 'success' / 'failed' /
  // 'pending' — deliveryRow() still branches on the raw value for its colour.
  'admin.webhooks.statusSuccess': 'Erfolgreich',
  'admin.webhooks.statusFailed': 'Fehlgeschlagen',
  'admin.webhooks.statusPending': 'Ausstehend',
};

export default webhooks;
