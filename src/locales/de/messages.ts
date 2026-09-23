/**
 * de — admin.messages.*
 *
 * One file per screen. 983 keys in a single module is a file nobody can review
 * and every translator conflicts in; split by surface, a screen's strings live
 * next to each other and two people can work at once.
 */
export const messages = {
  'admin.messages.title': 'Nachrichten',
  'admin.messages.subtitle': 'Kontaktformular-Einsendungen und Newsletter-Abonnenten',

  // Stat cards
  'admin.messages.statTotal': 'Nachrichten gesamt',
  'admin.messages.statUnread': 'Ungelesen',
  'admin.messages.statSubscribers': 'Abonnenten',

  // Contact messages list
  'admin.messages.contactHeading': 'Kontaktnachrichten',
  'admin.messages.empty': 'Noch keine Nachrichten.',
  'admin.messages.newBadge': 'Neu',
  'admin.messages.subject': 'Betreff: {subject}',
  'admin.messages.markRead': 'Als gelesen markieren',
  'admin.messages.markUnread': 'Als ungelesen markieren',
  'admin.messages.delete': 'Löschen',

  // Subscribers list
  'admin.messages.subscribersHeading_one': 'Newsletter-Abonnent ({count})',
  'admin.messages.subscribersHeading_other': 'Newsletter-Abonnenten ({count})',
  'admin.messages.subscribersEmpty': 'Noch keine Abonnenten.',
  'admin.messages.subscriberRemove': 'Entfernen',
  'admin.messages.subscriberRemoveConfirm': '{email} von der Liste nehmen? Bestellungen und Nachrichten bleiben erhalten.',
  'admin.messages.subscriberRemoveFailed': 'Abonnent konnte nicht entfernt werden.',

  // Browser-side (window.t — no plural support, no interpolation used here)
  'admin.messages.deleteConfirm': 'Diese Nachricht löschen?',
  'admin.messages.deleteFailed': 'Löschen fehlgeschlagen',
  'admin.messages.updateFailed': 'Aktualisierung fehlgeschlagen',
};

export default messages;
