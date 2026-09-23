/**
 * el — admin.webhooks.*
 *
 * One file per screen. 983 keys in a single module is a file nobody can review
 * and every translator conflicts in; split by surface, a screen's strings live
 * next to each other and two people can work at once.
 */
export const webhooks = {
  'admin.webhooks.title': 'Webhooks',
  'admin.webhooks.intro': 'Λαμβάνετε ένα υπογεγραμμένο POST όταν αλλάζει το περιεχόμενο. Το μυστικό υπογραφής εμφανίζεται μία μόνο φορά, κατά την καταχώριση.',

  // Secret disclosure
  'admin.webhooks.secretWarning': 'Αντιγράψτε τώρα το μυστικό υπογραφής — δεν θα εμφανιστεί ξανά.',
  'admin.webhooks.copy': 'Αντιγραφή',

  // Registration form
  'admin.webhooks.urlLabel': 'URL τερματικού σημείου',
  'admin.webhooks.eventsLabel': 'Συμβάντα',
  // {all} and {prefix} are code samples supplied by the page, not translated.
  'admin.webhooks.eventsHint': 'Χωρισμένα με κόμμα. Χρησιμοποιήστε {all} για όλα ή μπαλαντέρ της μορφής {prefix}.',
  'admin.webhooks.register': 'Καταχώριση webhook',

  // Webhook table
  'admin.webhooks.colUrl': 'URL',
  'admin.webhooks.colEvents': 'Συμβάντα',
  'admin.webhooks.colActive': 'Ενεργό',
  'admin.webhooks.colActions': 'Ενέργειες',
  'admin.webhooks.loading': 'Φόρτωση…',
  'admin.webhooks.empty': 'Δεν υπάρχουν ακόμη webhooks.',
  'admin.webhooks.yes': 'Ναι',
  'admin.webhooks.no': 'Όχι',
  'admin.webhooks.viewDeliveries': 'Παραδόσεις',
  'admin.webhooks.delete': 'Διαγραφή',
  'admin.webhooks.deleteConfirm': 'Να διαγραφεί το webhook για {url};',

  // Deliveries table
  'admin.webhooks.deliveriesTitle': 'Πρόσφατες παραδόσεις',
  'admin.webhooks.deliveriesTitleFiltered': 'Παραδόσεις για το επιλεγμένο webhook',
  'admin.webhooks.colEvent': 'Συμβάν',
  'admin.webhooks.colStatus': 'Κατάσταση',
  'admin.webhooks.colAttempts': 'Προσπάθειες',
  'admin.webhooks.colLastCode': 'Τελευταίος κωδικός',
  'admin.webhooks.colWhen': 'Πότε',
  'admin.webhooks.deliveriesEmpty': 'Δεν υπάρχουν ακόμη παραδόσεις.',
  'admin.webhooks.redeliver': 'Επαναποστολή',

  // Delivery status LABELS. The stored values stay 'success' / 'failed' /
  // 'pending' — deliveryRow() still branches on the raw value for its colour.
  'admin.webhooks.statusSuccess': 'Επιτυχία',
  'admin.webhooks.statusFailed': 'Αποτυχία',
  'admin.webhooks.statusPending': 'Σε εκκρεμότητα',
};

export default webhooks;
