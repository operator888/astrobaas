/**
 * el — admin.users.*
 *
 * One file per screen. 983 keys in a single module is a file nobody can review
 * and every translator conflicts in; split by surface, a screen's strings live
 * next to each other and two people can work at once.
 *
 * The `{count}` strings are phrased to avoid plural agreement — they are used
 * from `window.t`, which has no plural support. `admin.users.confirmBulkDelete`
 * ends in the Greek question mark ';', which is not a Latin semicolon.
 */
export const users = {
  'admin.users.title': 'Χρήστες',
  'admin.users.subtitle': 'Διαχείριση λογαριασμών χρηστών και δικαιωμάτων',
  'admin.users.addUser': 'Προσθήκη χρήστη',

  'admin.users.statTotal': 'Σύνολο χρηστών',
  'admin.users.statActive': 'Ενεργοί χρήστες',
  'admin.users.statAdmins': 'Διαχειριστές',
  'admin.users.statInactive': 'Ανενεργοί',

  'admin.users.searchPlaceholder': 'Αναζήτηση χρηστών...',
  'admin.users.allRoles': 'Όλοι οι ρόλοι',
  'admin.users.allStatuses': 'Όλες οι καταστάσεις',
  'admin.users.bulkActions': 'Μαζικές ενέργειες',
  'admin.users.deleteSelected': 'Διαγραφή επιλεγμένων ({count})',

  'admin.users.role.admin': 'Διαχειριστής',
  'admin.users.role.editor': 'Συντάκτης',
  'admin.users.role.author': 'Αρθρογράφος',
  'admin.users.role.manager': 'Υπεύθυνος',
  'admin.users.role.viewer': 'Θεατής',

  'admin.users.status.active': 'Ενεργός',
  'admin.users.status.inactive': 'Ανενεργός',

  'admin.users.colUser': 'Χρήστης',
  'admin.users.colRole': 'Ρόλος',
  'admin.users.colStatus': 'Κατάσταση',
  'admin.users.colPosts': 'Άρθρα',
  'admin.users.colLastLogin': 'Τελευταία σύνδεση',
  'admin.users.colActions': 'Ενέργειες',

  'admin.users.selectAll': 'Επιλογή όλων των χρηστών',
  'admin.users.selectUser': 'Επιλογή {name}',

  'admin.users.edit': 'Επεξεργασία',
  'admin.users.resetPassword': 'Επαναφορά κωδικού',
  'admin.users.delete': 'Διαγραφή',

  'admin.users.modalAddTitle': 'Νέος χρήστης',
  'admin.users.modalEditTitle': 'Επεξεργασία χρήστη',
  'admin.users.closeModal': 'Κλείσιμο',
  'admin.users.fieldName': 'Ονοματεπώνυμο',
  'admin.users.fieldEmail': 'Email',
  'admin.users.fieldRole': 'Ρόλος',
  'admin.users.fieldStatus': 'Κατάσταση',
  'admin.users.fieldPassword': 'Κωδικός πρόσβασης',
  'admin.users.cancel': 'Άκυρο',
  'admin.users.saveUser': 'Αποθήκευση χρήστη',

  'admin.users.passwordRequired': 'Απαιτείται κωδικός πρόσβασης για τους νέους χρήστες.',
  'admin.users.saveFailed': 'Η αποθήκευση απέτυχε: {error}',
  'admin.users.userUpdated': 'Ο χρήστης ενημερώθηκε.',
  'admin.users.userCreated': 'Ο χρήστης δημιουργήθηκε.',
  'admin.users.confirmDelete': 'Σίγουρα θέλετε να διαγράψετε αυτόν τον χρήστη;',
  'admin.users.deleteFailed': 'Η διαγραφή απέτυχε: {error}',
  'admin.users.userDeleted': 'Ο χρήστης διαγράφηκε.',
  'admin.users.promptNewPassword': 'Εισαγάγετε νέο κωδικό πρόσβασης (τουλάχιστον 8 χαρακτήρες):',
  'admin.users.passwordTooShort': 'Ο κωδικός πρόσβασης είναι πολύ σύντομος.',
  'admin.users.resetFailed': 'Η επαναφορά απέτυχε: {error}',
  'admin.users.passwordUpdated': 'Ο κωδικός πρόσβασης ενημερώθηκε.',
  'admin.users.confirmBulkDelete': 'Διαγραφή των επιλεγμένων χρηστών ({count}); Η ενέργεια δεν αναιρείται.',
  'admin.users.bulkDeleted': 'Διαγραφές: {count}.',
  'admin.users.bulkDeletedWithFailures': 'Διαγραφές: {count}, αποτυχίες: {failed}.',
};

export default users;
