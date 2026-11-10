/**
 * el — admin.invoices.* (see en/invoices.ts).
 *
 * «Εγγραφή», όχι «τιμολόγιο», όπου δεν το εξέδωσε πάροχος: το AstroBaaS δεν
 * είναι φορολογικός μηχανισμός.
 */
export const invoices = {
  'admin.invoices.heading': 'Εγγραφές τιμολόγησης',
  'admin.invoices.none': 'Δεν υπάρχει ακόμη εγγραφή.',
  'admin.invoices.kindInvoice': 'Εγγραφή πώλησης',
  'admin.invoices.kindMemo': 'Εγγραφή πίστωσης',
  'admin.invoices.stateDraft': 'Πρόχειρο',
  'admin.invoices.stateFinal': 'Οριστική',
  'admin.invoices.stateCancelled': 'Ακυρωμένη',
  'admin.invoices.stateIssuing': 'Σε έκδοση',
  'admin.invoices.stateIssued': 'Εκδόθηκε',
  'admin.invoices.stateIssueFailed': 'Η έκδοση απέτυχε',
  'admin.invoices.stateIssuedElsewhere': 'Εκδόθηκε αλλού',
  'admin.invoices.issuerNumber': 'Αρ. παραστατικού {number}',
  'admin.invoices.externalNumber': 'Αλλού με αρ. {number}',
  'admin.invoices.internalReference': 'Εσωτ. αναφορά {ref} (όχι αριθμός τιμολογίου)',
  'admin.invoices.credits': 'πιστώνει {id}',
  'admin.invoices.vatIncomplete': 'Η παραγγελία δεν έχει ανάλυση ΦΠΑ που να συμφωνεί',
  'admin.invoices.pdf': 'PDF',
  'admin.invoices.create': 'Δημιουργία εγγραφής',
  'admin.invoices.createFinal': 'Δημιουργία οριστικής εγγραφής',
  'admin.invoices.finalise': 'Οριστικοποίηση',
  'admin.invoices.cancel': 'Ακύρωση προχείρου',
  'admin.invoices.credit': 'Πλήρης πίστωση',
  'admin.invoices.markExternal': 'Εκδόθηκε αλλού…',
  'admin.invoices.retry': 'Νέα αποστολή στον πάροχο',
  'admin.invoices.notTaxDocument': 'Δεν έχει οριστεί πάροχος έκδοσης: οι εγγραφές δεν είναι φορολογικά παραστατικά.',
  'admin.invoices.issuerInUse': 'Έκδοση μέσω {issuer}.',
  'admin.invoices.markExternalPrompt': 'Αριθμός του παραστατικού που εκδόθηκε αλλού (προαιρετικό):',
  'admin.invoices.creditConfirm': 'Πλήρης πίστωση της εγγραφής; Δεν επιστρέφονται χρήματα· χρησιμοποιήστε το για διόρθωση και μετά δημιουργήστε νέα εγγραφή.',
  'admin.invoices.finaliseConfirm': 'Οριστικοποίηση της εγγραφής; Μια οριστική εγγραφή δεν αλλάζει ποτέ.',
  'admin.invoices.declined': 'Δεν εκδόθηκε — το απέρριψε: {reasons}',
  'admin.invoices.retryAt': 'Αυτόματη νέα προσπάθεια μετά τις {at} (προσπάθεια {n} από {max})',
  'admin.invoices.retryExhausted': 'Οι αυτόματες προσπάθειες εξαντλήθηκαν· στείλτε το ξανά χειροκίνητα.',
  'admin.invoices.issuedLate': 'επιβεβαιώθηκε καθυστερημένα',
  'admin.invoices.failed': 'Οι εγγραφές τιμολόγησης δεν ενημερώθηκαν.',
};

export default invoices;
