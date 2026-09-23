/**
 * el — admin.orders.*
 *
 * One file per screen. 983 keys in a single module is a file nobody can review
 * and every translator conflicts in; split by surface, a screen's strings live
 * next to each other and two people can work at once.
 *
 * The status and payment labels below are LABELS ONLY. The values they describe
 * ('pending', 'on-hold', …) are the API's vocabulary and stay in the `value=`
 * attribute and the data-* attributes, untranslated — the select still posts
 * `on-hold` however the option reads.
 */
export const orders = {
  'admin.orders.title': 'Παραγγελίες',
  'admin.orders.subtitle': 'Παραγγελίες πελατών και εκτέλεση',
  'admin.orders.statTotal': 'Σύνολο παραγγελιών',
  'admin.orders.statOpen': 'Ανοιχτές (σε αναμονή / σε επεξεργασία)',
  'admin.orders.statRevenue': 'Έσοδα από ολοκληρωμένες',
  'admin.orders.empty': 'Δεν υπάρχουν ακόμη παραγγελίες.',

  // Fulfilment status — one label per ORDER_STATUSES value.
  'admin.orders.statusPending': 'σε αναμονή',
  'admin.orders.statusProcessing': 'σε επεξεργασία',
  'admin.orders.statusOnHold': 'σε αναστολή',
  'admin.orders.statusCompleted': 'ολοκληρώθηκε',
  'admin.orders.statusCancelled': 'ακυρώθηκε',
  'admin.orders.statusRefunded': 'επιστράφηκε',
  'admin.orders.statusFailed': 'απέτυχε',

  // Payment status — tracked separately from fulfilment.
  'admin.orders.paymentPaid': '✓ πληρώθηκε',
  'admin.orders.paymentPending': '⋯ αναμονή πληρωμής',
  'admin.orders.paymentFailed': '✕ η πληρωμή απέτυχε',
  'admin.orders.paymentRefunded': '↩ επιστράφηκε',
  'admin.orders.paymentUnpaid': 'απλήρωτη',

  'admin.orders.methodBankTransfer': '🏦 κατάθεση',
  'admin.orders.prescription': 'Συνταγή',
  'admin.orders.prescriptionDelete': 'διαγραφή',
  'admin.orders.trackingCarrier': 'Μεταφορική',
  'admin.orders.trackingNumber': 'Αριθμός αποστολής',
  'admin.orders.trackingSend': 'Αποθήκευση & ειδοποίηση',
  'admin.orders.trackingUpdate': 'Ενημέρωση',
  'admin.orders.trackingFailed': 'Δεν ήταν δυνατή η αποθήκευση των στοιχείων αποστολής.',
  'admin.orders.shippedOn': 'Απεστάλη {date}',
  'admin.orders.staffNotePlaceholder': 'Σημείωση καταστήματος — δεν τη βλέπει ο πελάτης',
  'admin.orders.staffNoteFailed': 'Δεν ήταν δυνατή η αποθήκευση της σημείωσης.',
  'admin.orders.prescriptionDeleteConfirm': 'Οριστική διαγραφή της συνταγής στην παραγγελία {number}; Είναι δεδομένο υγείας που το σύστημα διατηρεί σκόπιμα ακόμη και μετά από διαγραφή πελάτη — διαγράψτε το μόνο όταν έχει παρέλθει ο χρόνος τήρησης. Δεν αναιρείται.',
  'admin.orders.prescriptionDeleteFailed': 'Δεν ήταν δυνατή η διαγραφή της συνταγής.',
  'admin.orders.note': 'Σημείωση: {note}',

  'admin.orders.refundedAmount': '−{amount} επιστράφηκαν',
  'admin.orders.refundRemaining': 'απομένουν {amount}',
  'admin.orders.statusLocked': 'Ο ρόλος σας επιτρέπει προβολή παραγγελιών, όχι αλλαγή κατάστασης. Αυτό μπορεί να το κάνει διαχειριστής ή συντάκτης.',
  'admin.orders.refund': 'Επιστροφή χρημάτων…',
  'admin.orders.refundInProviderDashboard': 'Επιστροφή χρημάτων από τον πίνακα {provider}',

  'admin.orders.needsRefund': 'Χρειάζεται επιστροφή χρημάτων — πληρώθηκε μετά την ακύρωση, χωρίς απόθεμα',
  'admin.orders.declines': 'Απορριφθείσες προσπάθειες κάρτας: {count}',
  'admin.orders.riskHeld': 'Σε αναμονή για έλεγχο (κίνδυνος)',
  'admin.orders.riskFlagged': 'Επισήμανση κινδύνου',
  'admin.orders.holdExpired': 'Έληξε ο χρόνος πληρωμής',

  // Browser-side (window.t): no plural support, so nothing here takes a count.
  'admin.orders.updateFailed': 'Η ενημέρωση απέτυχε',
  'admin.orders.refundPromptTitle': 'Επιστροφή χρημάτων για την παραγγελία {number} μέσω {provider}.',
  'admin.orders.refundPromptMax': 'Μπορούν να επιστραφούν έως {amount} {currency}.',
  'admin.orders.refundPromptEnter': 'Δώστε ποσό ή αφήστε το κενό για επιστροφή και των {amount} {currency}.',
  'admin.orders.amountInvalid': 'Δώστε θετικό ποσό.',
  'admin.orders.amountTooHigh': 'Αυτό υπερβαίνει τα {amount} {currency} που απομένουν για επιστροφή.',
  'admin.orders.refundFullAmount': '{amount} {currency} (πλήρης)',
  'admin.orders.refundConfirm': 'Να επιστραφούν {amount} στον πελάτη; Η ενέργεια δεν αναιρείται από εδώ.',
  'admin.orders.refunding': 'Γίνεται επιστροφή…',
  'admin.orders.refundFailed': 'Η επιστροφή χρημάτων απέτυχε',
};

export default orders;
