/**
 * el — admin.messages.*
 *
 * One file per screen. 983 keys in a single module is a file nobody can review
 * and every translator conflicts in; split by surface, a screen's strings live
 * next to each other and two people can work at once.
 */
export const messages = {
  'admin.messages.title': 'Μηνύματα',
  'admin.messages.subtitle': 'Υποβολές φόρμας επικοινωνίας και συνδρομητές newsletter',

  // Stat cards
  'admin.messages.statTotal': 'Σύνολο μηνυμάτων',
  'admin.messages.statUnread': 'Μη αναγνωσμένα',
  'admin.messages.statSubscribers': 'Συνδρομητές',

  // Contact messages list
  'admin.messages.contactHeading': 'Μηνύματα επικοινωνίας',
  'admin.messages.empty': 'Δεν υπάρχουν μηνύματα ακόμη.',
  'admin.messages.newBadge': 'Νέο',
  'admin.messages.subject': 'Θέμα: {subject}',
  'admin.messages.markRead': 'Σήμανση ως αναγνωσμένου',
  'admin.messages.markUnread': 'Σήμανση ως μη αναγνωσμένου',
  'admin.messages.delete': 'Διαγραφή',

  // Subscribers list
  'admin.messages.subscribersHeading_one': 'Συνδρομητής newsletter ({count})',
  'admin.messages.subscribersHeading_other': 'Συνδρομητές newsletter ({count})',
  'admin.messages.subscribersEmpty': 'Δεν υπάρχουν συνδρομητές ακόμη.',
  'admin.messages.subscriberRemove': 'Αφαίρεση',
  'admin.messages.subscriberRemoveConfirm': 'Να αφαιρεθεί το {email} από τη λίστα; Οι παραγγελίες και τα μηνύματά του παραμένουν.',
  'admin.messages.subscriberRemoveFailed': 'Δεν ήταν δυνατή η αφαίρεση του συνδρομητή.',

  // Browser-side (window.t — no plural support, no interpolation used here)
  'admin.messages.deleteConfirm': 'Διαγραφή αυτού του μηνύματος;',
  'admin.messages.deleteFailed': 'Η διαγραφή απέτυχε',
  'admin.messages.updateFailed': 'Η ενημέρωση απέτυχε',
};

export default messages;
