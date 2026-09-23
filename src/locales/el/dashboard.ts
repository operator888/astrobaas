/**
 * el — admin.dashboard.*
 *
 * One file per screen. 983 keys in a single module is a file nobody can review
 * and every translator conflicts in; split by surface, a screen's strings live
 * next to each other and two people can work at once.
 */
export const dashboard = {
  'admin.dashboard.title': 'Πίνακας ελέγχου',

  // Default-password banner. Split around the <code>admin@local</code> chip and
  // the /admin/profile link, both of which are values and stay untranslated —
  // so every language ends its sentence AT the link rather than wrapping it.
  'admin.dashboard.defaultPasswordTitle': 'Προσοχή:',
  'admin.dashboard.defaultPasswordBefore': 'ο προεπιλεγμένος λογαριασμός',
  'admin.dashboard.defaultPasswordAfter': 'εξακολουθεί να υπάρχει. Αλλάξτε τον κωδικό πρόσβασης στο',

  'admin.dashboard.welcome': 'Καλώς ήρθατε, {name}!',
  'admin.dashboard.subtitle': 'Δείτε τι συμβαίνει σήμερα στον ιστότοπό σας.',
  /** Shown in the greeting when the signed-in account has no name set. */
  'admin.dashboard.defaultUserName': 'Διαχειριστής',

  // Commerce cards
  'admin.dashboard.openOrders': 'Ανοιχτές παραγγελίες',
  'admin.dashboard.ordersTotal': '{count} συνολικά',
  'admin.dashboard.revenuePaid': 'Έσοδα (εξοφλημένα)',
  'admin.dashboard.revenuePaidHint': 'μόνο εξοφλημένες παραγγελίες',
  'admin.dashboard.products': 'Προϊόντα',
  'admin.dashboard.productsHint': 'στον κατάλογο',
  'admin.dashboard.outOfStock': 'Εξαντλημένα',
  'admin.dashboard.needsRestocking': 'χρειάζεται αναπλήρωση',
  'admin.dashboard.allInStock': 'όλα διαθέσιμα',

  // Content stats
  'admin.dashboard.totalPosts': 'Σύνολο άρθρων',
  'admin.dashboard.authors_one': '{count} συντάκτης',
  'admin.dashboard.authors_other': '{count} συντάκτες',
  'admin.dashboard.published': 'Δημοσιευμένα',
  'admin.dashboard.publishedShare': '{percent}% όλων των άρθρων',
  'admin.dashboard.drafts': 'Πρόχειρα',
  'admin.dashboard.mediaFiles_one': '{count} αρχείο πολυμέσων',
  'admin.dashboard.mediaFiles_other': '{count} αρχεία πολυμέσων',
  'admin.dashboard.totalViews': 'Σύνολο προβολών',
  'admin.dashboard.viewsHint': 'σε όλα τα δημοσιευμένα άρθρα',

  // Recent posts
  'admin.dashboard.recentPosts': 'Πρόσφατα άρθρα',
  'admin.dashboard.viewAll': 'Προβολή όλων',
  'admin.dashboard.noPosts': 'Δεν υπάρχουν άρθρα ακόμη.',
  'admin.dashboard.createFirstPost': 'Δημιουργία πρώτου άρθρου →',
  'admin.dashboard.postViews_one': '{count} προβολή',
  'admin.dashboard.postViews_other': '{count} προβολές',

  // Post status badge. The badge COLOUR and this label are both derived from
  // post.status; nothing matches on the label, so only the label is translated.
  'admin.dashboard.status.published': 'Δημοσιευμένο',
  'admin.dashboard.status.draft': 'Πρόχειρο',
  'admin.dashboard.status.scheduled': 'Προγραμματισμένο',
  'admin.dashboard.status.trashed': 'Στον κάδο',

  // Sidebar
  'admin.dashboard.quickActions': 'Γρήγορες ενέργειες',
  'admin.dashboard.newPost': 'Νέο άρθρο',
  'admin.dashboard.uploadMedia': 'Μεταφόρτωση πολυμέσων',
  'admin.dashboard.manageCategories': 'Διαχείριση κατηγοριών',
  'admin.dashboard.recentActivity': 'Πρόσφατη δραστηριότητα',
  'admin.dashboard.noActivity': 'Καμία δραστηριότητα ακόμη.',

  // Activity lines. Greek puts the passive verb first — 'Δημιουργήθηκε άρθρο' —
  // which is exactly why each verb is a whole sentence with {entity} inside it
  // rather than two halves glued together in English order.
  'admin.dashboard.activity.created': 'Δημιουργήθηκε {entity}',
  'admin.dashboard.activity.updated': 'Ενημερώθηκε {entity}',
  'admin.dashboard.activity.deleted': 'Διαγράφηκε {entity}',

  // Entity names, keyed by EntityType (kebab-case types become lowerCamelCase).
  // Lower case: in Greek these land mid-sentence, after the verb.
  'admin.dashboard.entity.post': 'άρθρο',
  'admin.dashboard.entity.theme': 'θέμα',
  'admin.dashboard.entity.setting': 'ρύθμιση',
  'admin.dashboard.entity.category': 'κατηγορία',
  'admin.dashboard.entity.user': 'χρήστης',
  'admin.dashboard.entity.plugin': 'πρόσθετο',
  'admin.dashboard.entity.product': 'προϊόν',
  'admin.dashboard.entity.brand': 'μάρκα',
  'admin.dashboard.entity.productCategory': 'κατηγορία προϊόντων',
  'admin.dashboard.entity.order': 'παραγγελία',
  'admin.dashboard.entity.customer': 'πελάτης',
  'admin.dashboard.entity.media': 'αρχείο πολυμέσων',

  // Relative timestamps
  'admin.dashboard.time.justNow': 'μόλις τώρα',
  'admin.dashboard.time.minutes_one': 'πριν από {count} λεπτό',
  'admin.dashboard.time.minutes_other': 'πριν από {count} λεπτά',
  'admin.dashboard.time.hours_one': 'πριν από {count} ώρα',
  'admin.dashboard.time.hours_other': 'πριν από {count} ώρες',
  'admin.dashboard.time.days_one': 'πριν από {count} ημέρα',
  'admin.dashboard.time.days_other': 'πριν από {count} ημέρες',
};

export default dashboard;
