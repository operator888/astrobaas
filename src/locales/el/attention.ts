/**
 * el — admin.attention.*
 *
 * The dashboard's attention feed. Every string here frames something the
 * operator is being asked to act on, so an untranslated one is an instruction
 * in the wrong language on the screen opened most.
 *
 * Three keys per check, named after the check's own id: `.title`, `.body` and
 * `.action`. The card carries only that id and its params — there is nowhere in
 * an AttentionCard to put a sentence, which is what stops a check being written
 * with English text and no translation. tests/attention.test.mjs asserts all
 * three exist here for every registered check.
 */
export const attention = {
  'admin.attention.heading': 'Τι χρειάζεται την προσοχή σας',
  'admin.attention.allClear': 'Δεν χρειάζεται κάτι την προσοχή σας.',
  'admin.attention.broken': 'Χρειάζεται διόρθωση',
  'admin.attention.unfinished': 'Ημιτελές',
  'admin.attention.worthKnowing': 'Καλό να ξέρετε',

  'admin.attention.site-url-unset.title': 'Ο ιστότοπος δεν γνωρίζει τη διεύθυνσή του',
  'admin.attention.site-url-unset.body': 'Οι κανονικοί σύνδεσμοι, ο χάρτης ιστότοπου και κάθε σύνδεσμος σε email δημιουργούνται από αυτήν. Όσο δεν έχει οριστεί, μαντεύονται από τον διακομιστή στον οποίο έφτασε το αίτημα.',
  'admin.attention.site-url-unset.action': 'Ορισμός διεύθυνσης',

  'admin.attention.tax-origin-unset.title': 'Ο ΦΠΑ είναι ενεργός, αλλά το κατάστημα δεν έχει χώρα',
  'admin.attention.tax-origin-unset.body': 'Η χώρα ΑΠΟ την οποία πουλά ένα κατάστημα καθορίζει κάθε συντελεστή, και δεν μαντεύεται ποτέ. Οι παραγγελίες τιμολογούνται χωρίς αυτήν.',
  'admin.attention.tax-origin-unset.action': 'Ορισμός χώρας έδρας',

  'admin.attention.schema-behind.title': 'Το σχήμα της βάσης είναι σε v{current}, ενώ η έκδοση απαιτεί v{latest}',
  'admin.attention.schema-behind.body': 'Οι μεταπτώσεις εκτελούνται στην εκκίνηση, οπότε συνήθως σημαίνει ότι κάποια απέτυχε. Δεδομένα μπορεί να διαβάζονται από κώδικα που περιμένει άλλη μορφή.',
  'admin.attention.schema-behind.action': 'Έλεγχος εργασιών',

  'admin.attention.flagged-orders.title': '{count} παραγγελίες έχουν επισημανθεί για έλεγχο',
  'admin.attention.flagged-orders.body': 'Οι ενδείξεις κινδύνου δεν απορρίπτουν ποτέ παραγγελία — ζητούν μόνο ανθρώπινο έλεγχο. Αυτές παραμένουν ανοιχτές.',
  'admin.attention.flagged-orders.action': 'Έλεγχος τους',

  'admin.attention.active-out-of-stock.title': '{count} προϊόντα εμφανίζονται αλλά είναι εξαντλημένα',
  'admin.attention.active-out-of-stock.body': 'Οι πελάτες τα βρίσκουν και δεν μπορούν να τα αγοράσουν. Σκόπιμο αν δέχεστε προπαραγγελίες· αλλιώς είναι αδιέξοδα στον κατάλογο.',
  'admin.attention.active-out-of-stock.action': 'Άνοιγμα καταλόγου',

  'admin.attention.overdue-scheduled-posts.title': '{count} προγραμματισμένα άρθρα δεν δημοσιεύτηκαν',
  'admin.attention.overdue-scheduled-posts.body': 'Η ημερομηνία δημοσίευσης πέρασε και παραμένουν προγραμματισμένα. Όποιος τα έγραψε πιστεύει ότι είναι ζωντανά.',
  'admin.attention.overdue-scheduled-posts.action': 'Άνοιγμα άρθρων',

  'admin.attention.brand-spellings.title': '{count} μάρκες χρειάζονται απόφαση για τη γραφή τους',
  'admin.attention.brand-spellings.body': 'Οι πελάτες δεν επηρεάζονται — το φιλτράρισμα τις θεωρεί ήδη μία μάρκα. Αυτές είναι όσες κανένας κανόνας δεν μπορούσε να κρίνει με ασφάλεια.',
  'admin.attention.brand-spellings.action': 'Άνοιγμα καταλόγου',

  'admin.attention.assistant-error.title': 'Ο βοηθός AI επέστρεψε σφάλμα την τελευταία φορά',
  'admin.attention.assistant-error.body': 'Ένα κλειδί μπορεί να έληξε, να ανακλήθηκε ή να εξάντλησε το υπόλοιπό του. Ο πάροχος {provider} ανέφερε: «{detail}»',
  'admin.attention.assistant-error.action': 'Έλεγχος ρυθμίσεων',

  'admin.attention.orders-need-refund.title': '{count} παραγγελίες πληρώθηκαν αφού είχαν ακυρωθεί',
  'admin.attention.orders-need-refund.body': 'Η πληρωμή ήρθε αφού η παραγγελία είχε ακυρωθεί και τα προϊόντα της πουληθεί, οπότε δεν θα αποσταλεί τίποτα. Επιστρέψτε τα χρήματα στους πελάτες ή αναπληρώστε το απόθεμα και ανοίξτε ξανά τις παραγγελίες.',
  'admin.attention.orders-need-refund.action': 'Άνοιγμα παραγγελιών',

  'admin.attention.payment-return-urls.title': 'Οι πελάτες που πληρώνουν θα επέστρεφαν σε σελίδα που δεν υπάρχει',
  'admin.attention.payment-return-urls.body': 'Μετά την πληρωμή με κάρτα, PayPal ή Klarna, οι αγοραστές επιστρέφουν στη Διεύθυνση ιστότοπου — που είναι κενή ή είναι η διεύθυνση αυτού του CMS αντί για το ηλεκτρονικό σας κατάστημα.',
  'admin.attention.payment-return-urls.action': 'Ορισμός διεύθυνσης ιστότοπου',
};
