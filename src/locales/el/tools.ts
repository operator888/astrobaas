/**
 * el — admin.tools.*
 *
 * One file per screen. 983 keys in a single module is a file nobody can review
 * and every translator conflicts in; split by surface, a screen's strings live
 * next to each other and two people can work at once.
 *
 * `{db}` and `{uploads}` are markup placeholders filled by the page with a
 * `<code>` element — the path inside it is a literal and must not be
 * translated, but its position in the sentence differs per language.
 */
export const tools = {
  'admin.tools.title': 'Εργαλεία',
  'admin.tools.subtitle': 'Λειτουργικά εργαλεία για τον ιστότοπό σας.',

  'admin.tools.backupHeading': 'Αντίγραφο ασφαλείας',
  'admin.tools.backupDesc':
    'Κατεβάστε ένα ενιαίο αρχείο JSON που περιέχει το {db} και κάθε αρχείο μέσα στο {uploads}. Τα αρχεία μεγαλύτερα από 10 MB παραλείπονται.',
  'admin.tools.backupDownload': 'Λήψη αντιγράφου',

  'admin.tools.restoreHeading': 'Επαναφορά',
  'admin.tools.restoreDesc':
    'Ανεβάστε ένα αρχείο αντιγράφου ασφαλείας που δημιουργήθηκε από την ίδια έκδοση του AstroBaaS.',
  'admin.tools.restoreWarning':
    'Αυτό θα αντικαταστήσει την τρέχουσα βάση δεδομένων σας και όσα αρχεία πολυμέσων έχουν το ίδιο όνομα.',
  'admin.tools.restoreSubmit': 'Επαναφορά από αρχείο',
  'admin.tools.restoreConfirm': 'Αυτό θα αντικαταστήσει τον τρέχοντα ιστότοπό σας. Συνέχεια;',
  'admin.tools.restoreInvalidJson': 'Το επιλεγμένο αρχείο δεν είναι έγκυρο JSON.',
  'admin.tools.restoreInProgress': 'Γίνεται επαναφορά…',
  'admin.tools.restoreFailed': 'Η επαναφορά απέτυχε: {error}',
  // Phrased without a plural: this one is read by window.t, which has no
  // plural support.
  'admin.tools.restoreComplete':
    'Η επαναφορά ολοκληρώθηκε. Γράφτηκαν: {restored}, παραλείφθηκαν: {skipped}.',

  'admin.tools.sectionsHeading': 'Υγεία ενοτήτων',
  'admin.tools.sectionsDesc':
    'Οι ενότητες αποθηκεύονται ως κλάσεις CSS μέσα στο περιεχόμενό σας, οπότε η αφαίρεση ή η μετονομασία μιας ενότητας στον κώδικα αφήνει τις δημοσιευμένες σελίδες να φέρουν μια κλάση που αυτή η έκδοση δεν μπορεί πλέον να μορφοποιήσει. Εδώ δεν αλλάζει τίποτα — απλώς αναφέρεται τι υπάρχει.',
  'admin.tools.statScanned': 'Εγγραφές που σαρώθηκαν',
  'admin.tools.statUsingSections': 'Χρησιμοποιούν ενότητες',
  'admin.tools.statNeedingAttention': 'Χρειάζονται προσοχή',

  'admin.tools.orphanedHeading': 'Από πρόσθετα που δεν είναι ενεργά',
  'admin.tools.inRecords_one': '— σε {count} εγγραφή',
  'admin.tools.inRecords_other': '— σε {count} εγγραφές',
  'admin.tools.orphanedNote':
    'Δεν κινδυνεύει τίποτα. Αυτό το markup διατηρείται κατά την αποθήκευση και απλώς εμφανίζεται χωρίς στυλ· η επανεγκατάσταση ή η επανενεργοποίηση του πρόσθετου επαναφέρει την εμφάνισή του.',

  'admin.tools.sectionsAllKnown':
    'Κάθε κλάση ενότητας στο περιεχόμενό σας είναι κλάση που αυτή η έκδοση μπορεί να μορφοποιήσει.',
  'admin.tools.unknownHeading': 'Μη αναγνωρισμένες κλάσεις',
  'admin.tools.affectedHeading': 'Επηρεαζόμενο περιεχόμενο',
  'admin.tools.affectedTruncated': 'Εμφανίζονται οι πρώτες 50 από {total}.',
  'admin.tools.affectedNote':
    'Δεν έχει αλλάξει τίποτα. Είτε επαναφέρετε στον κώδικα την ενότητα που λείπει, είτε ανοίξτε κάθε εγγραφή και ξαναφτιάξτε αυτό το τμήμα από την τρέχουσα παλέτα — η αποθήκευση μιας εγγραφής αφαιρεί τις κλάσεις που αυτή η έκδοση δεν αναγνωρίζει.',
  'admin.tools.usageSummary': 'Ποιες ενότητες χρησιμοποιούνται',

  'admin.tools.patternsHeading': 'Μοτίβα',
  'admin.tools.patternsDesc':
    'Έτοιμες διατάξεις που προσφέρονται στον επεξεργαστή. Ένα μοτίβο προσφέρεται μόνο αν το markup του περνά ακέραιο από τον sanitizer — ένα που δεν περνά θα σας άφηνε να φτιάξετε μια σελίδα και να χάσετε μέρος της κατά την αποθήκευση.',
  'admin.tools.patternsAvailable_one': '{countStrong} διαθέσιμο (θέμα: {theme}, {tier}).',
  'admin.tools.patternsAvailable_other': '{countStrong} διαθέσιμα (θέμα: {theme}, {tier}).',
  'admin.tools.patternsRejectedHeading': 'Δεν προσφέρονται',

  'admin.tools.otherHeading': 'Άλλα',
  'admin.tools.otherDesc':
    'Για να επαναφέρετε τα πάντα στα αρχικά δεδομένα, σταματήστε τον διακομιστή, διαγράψτε το {db} και ξεκινήστε τον ξανά. Θα δημιουργηθεί εκ νέου με το ενσωματωμένο αρχικό περιεχόμενο.',
};

export default tools;
