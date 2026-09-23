/**
 * el — admin.categories.*
 *
 * One file per screen. 983 keys in a single module is a file nobody can review
 * and every translator conflicts in; split by surface, a screen's strings live
 * next to each other and two people can work at once.
 */
export const categories = {
  'admin.categories.pageTitle': 'Κατηγορίες',
  'admin.categories.title': 'Κατηγορίες',
  'admin.categories.addButton': 'Προσθήκη κατηγορίας',

  // Form
  'admin.categories.formTitleAdd': 'Νέα κατηγορία',
  'admin.categories.formTitleEdit': 'Επεξεργασία κατηγορίας',
  'admin.categories.nameLabel': 'Όνομα',
  'admin.categories.namePlaceholder': 'Εισαγάγετε όνομα κατηγορίας',
  'admin.categories.slugLabel': 'Slug',
  'admin.categories.slugHint': 'Φιλική προς URL εκδοχή του ονόματος',
  'admin.categories.descriptionLabel': 'Περιγραφή',
  'admin.categories.descriptionPlaceholder': 'Προαιρετική περιγραφή',
  'admin.categories.submitAdd': 'Προσθήκη κατηγορίας',
  'admin.categories.submitUpdate': 'Ενημέρωση κατηγορίας',
  'admin.categories.cancel': 'Ακύρωση',

  // List
  'admin.categories.searchPlaceholder': 'Αναζήτηση κατηγοριών...',
  'admin.categories.count_one': '{count} κατηγορία',
  'admin.categories.count_other': '{count} κατηγορίες',
  'admin.categories.colName': 'Όνομα',
  'admin.categories.colSlug': 'Slug',
  'admin.categories.colDescription': 'Περιγραφή',
  'admin.categories.colPosts': 'Άρθρα',
  'admin.categories.colActions': 'Ενέργειες',
  'admin.categories.postCount_one': '{count} άρθρο',
  'admin.categories.postCount_other': '{count} άρθρα',
  'admin.categories.edit': 'Επεξεργασία',
  'admin.categories.delete': 'Διαγραφή',

  // Empty state
  'admin.categories.emptyTitle': 'Δεν βρέθηκαν κατηγορίες',
  'admin.categories.emptyBody': 'Ξεκινήστε δημιουργώντας την πρώτη σας κατηγορία.',
  'admin.categories.emptyAction': 'Προσθήκη κατηγορίας',

  // Messages
  'admin.categories.nameRequired': 'Το όνομα είναι υποχρεωτικό.',
  'admin.categories.saved': 'Η κατηγορία «{name}» αποθηκεύτηκε.',
  'admin.categories.saveFailed': 'Η αποθήκευση απέτυχε: {error}',
  'admin.categories.deleteConfirm': 'Είστε βέβαιοι ότι θέλετε να διαγράψετε την κατηγορία «{name}»;',
  'admin.categories.deleted': 'Η κατηγορία «{name}» διαγράφηκε.',
  'admin.categories.deleteFailed': 'Η διαγραφή απέτυχε: {error}',
};

export default categories;
