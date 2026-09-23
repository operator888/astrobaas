/**
 * el — admin.media.*
 *
 * One file per screen. 983 keys in a single module is a file nobody can review
 * and every translator conflicts in; split by surface, a screen's strings live
 * next to each other and two people can work at once.
 */
export const media = {
  // Page chrome
  'admin.media.title': 'Βιβλιοθήκη πολυμέσων',
  'admin.media.subtitle': 'Διαχειριστείτε τις εικόνες, τα βίντεο και τα υπόλοιπα αρχεία πολυμέσων',

  // Upload area
  'admin.media.uploadHeading': 'Μεταφόρτωση πολυμέσων',
  'admin.media.uploadHint': 'Σύρετε και αφήστε αρχεία εδώ ή κάντε κλικ για επιλογή',
  'admin.media.uploadFormats': 'Εικόνες: JPG, PNG, GIF, WebP (έως {image} MB) · Βίντεο: MP4, WebM (έως {video} MB)',
  'admin.media.uploading': 'Μεταφόρτωση…',
  'admin.media.uploadDone': 'Ολοκληρώθηκε',
  'admin.media.uploadFailed': 'Η μεταφόρτωση απέτυχε: {error}',

  // Toolbar
  'admin.media.searchPlaceholder': 'Αναζήτηση πολυμέσων…',
  'admin.media.gridView': 'Προβολή πλέγματος',
  'admin.media.listView': 'Προβολή λίστας',

  // Grid / list state
  'admin.media.loading': 'Φόρτωση…',
  'admin.media.empty': 'Δεν υπάρχουν πολυμέσα ακόμη. Μεταφορτώστε ένα αρχείο παραπάνω.',

  // List columns
  'admin.media.colFile': 'Αρχείο',
  'admin.media.colType': 'Τύπος',
  'admin.media.colSize': 'Μέγεθος',
  'admin.media.colDate': 'Ημερομηνία',
  'admin.media.colActions': 'Ενέργειες',

  // Row actions. These are LABELS only — the click handler dispatches on
  // data-action="select" / data-action="delete", never on the text or title.
  'admin.media.insert': 'Εισαγωγή στο άρθρο',
  'admin.media.select': 'Επιλογή',
  'admin.media.addAlt': 'Περιγραφή',
  'admin.media.altPrompt': 'Περιγράψτε την εικόνα για κάποιον που δεν τη βλέπει. Αφήστε το κενό αν είναι διακοσμητική.',
  'admin.media.altFailed': 'Δεν αποθηκεύτηκε η περιγραφή',
  'admin.media.replace': 'Αντικατάσταση',
  'admin.media.replaceConfirm': 'Να αντικατασταθεί το αρχείο; Οι σελίδες και τα προϊόντα που το χρησιμοποιούν θα ενημερωθούν στο νέο, και το παλιό αρχείο διαγράφεται.',
  'admin.media.replaceFailed': 'Δεν ήταν δυνατή η αντικατάσταση: {error}',
  'admin.media.replaced': 'Αντικαταστάθηκε. Ενημερώθηκαν {posts} σελίδα(ες) και {products} προϊόν(τα).',
  'admin.media.delete': 'Διαγραφή',
  'admin.media.deleteConfirm': 'Είστε βέβαιοι ότι θέλετε να διαγράψετε αυτό το αρχείο πολυμέσων;',
  'admin.media.deleteFailed': 'Η διαγραφή απέτυχε: {error}',

  // File sizes. Only the spelled-out unit is translatable; KB/MB/GB are
  // international symbols and stay as they are in every locale.
  'admin.media.unitBytes': 'bytes',
  'admin.media.loadMore': 'Φόρτωση περισσότερων',
  'admin.media.rateLimited': 'Υπέρβαση ορίου — νέα προσπάθεια σε {seconds}δ…',
};

export default media;
