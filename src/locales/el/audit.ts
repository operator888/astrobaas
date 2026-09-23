/**
 * el — admin.audit.*
 *
 * One file per screen. 983 keys in a single module is a file nobody can review
 * and every translator conflicts in; split by surface, a screen's strings live
 * next to each other and two people can work at once.
 */
export const audit = {
  'admin.audit.title': 'Αρχείο καταγραφής',
  'admin.audit.intro':
    'Ποιος έκανε τι. Συνδέσεις και συμβάντα ασφαλείας, καθώς και αλλαγές σε περιεχόμενο και πωλήσεις — άρθρα και προϊόντα που δημιουργήθηκαν, τροποποιήθηκαν ή διαγράφηκαν, και αλλαγές κατάστασης παραγγελιών. Οι αλλαγές σε τιμή, απόθεμα και κατάσταση καταγράφουν την προηγούμενη και τη νέα τιμή· κάθε άλλο πεδίο καταγράφεται μόνο με το ΟΝΟΜΑ του, ώστε αυτό να μη γίνει ποτέ δεύτερο αντίγραφο του περιεχομένου σας.',
  'admin.audit.filterAction': 'Ενέργεια',
  'admin.audit.filterActor': 'Ποιος',
  'admin.audit.actorPlaceholder': 'οποιοσδήποτε χρήστης',
  'admin.audit.filterFrom': 'Από',
  'admin.audit.filterTo': 'Έως',
  'admin.audit.apply': 'Φιλτράρισμα',
  'admin.audit.clear': 'Καθαρισμός',
  'admin.audit.colWhen': 'Πότε',
  'admin.audit.colAction': 'Ενέργεια',
  'admin.audit.colActor': 'Χρήστης',
  'admin.audit.colTarget': 'Αντικείμενο',
  'admin.audit.colIp': 'IP',
  'admin.audit.loading': 'Φόρτωση…',
  'admin.audit.empty': 'Δεν υπάρχουν συμβάντα με αυτά τα φίλτρα.',
  'admin.audit.count_one': '{count} συμβάν',
  'admin.audit.count_other': '{count} συμβάντα',
  'admin.audit.countCapped': '{count} συμβάντα (όριο — περιορίστε τις ημερομηνίες)',
};

export default audit;
