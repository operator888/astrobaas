/**
 * el — admin.profile.*
 *
 * One file per screen. 983 keys in a single module is a file nobody can review
 * and every translator conflicts in; split by surface, a screen's strings live
 * next to each other and two people can work at once.
 */
export const profile = {
  'admin.profile.pageTitle': 'Προφίλ',
  'admin.profile.title': 'Το προφίλ σας',
  'admin.profile.subtitle': 'Ενημερώστε το όνομα, το email ή τον κωδικό σας.',

  'admin.profile.nameLabel': 'Όνομα',
  'admin.profile.emailLabel': 'Email',
  'admin.profile.roleLabel': 'Ρόλος',
  'admin.profile.saveChanges': 'Αποθήκευση αλλαγών',

  'admin.profile.passwordHeading': 'Αλλαγή κωδικού',
  'admin.profile.newPassword': 'Νέος κωδικός',
  'admin.profile.passwordHint': 'Τουλάχιστον 8 χαρακτήρες.',
  'admin.profile.confirmPassword': 'Επιβεβαίωση κωδικού',
  'admin.profile.updatePassword': 'Ενημέρωση κωδικού',

  'admin.profile.twoFactorHeading': 'Έλεγχος ταυτότητας δύο παραγόντων',
  'admin.profile.twoFactorIntro':
    'Προσθέστε έναν χρονικά μεταβαλλόμενο κωδικό μίας χρήσης από εφαρμογή authenticator (Google Authenticator, 1Password, Aegis…) ως δεύτερο βήμα στη σύνδεση.',
  'admin.profile.twoFactorNeedsEmail': 'Η σύνδεση δύο παραγόντων χρειάζεται πρώτα ενεργό κανάλι email — είναι ο δρόμος ανάκτησης αν χάσετε τον authenticator. Ρυθμίστε το email (π.χ. το πρόσθετο SMTP2GO) και επιστρέψτε εδώ.',
  'admin.profile.enableTwoFactor': 'Ενεργοποίηση δύο παραγόντων',

  'admin.profile.setupStep1': 'Προσθέστε αυτό το μυστικό κλειδί στην εφαρμογή authenticator:',
  'admin.profile.setupStep2': 'Ή επικολλήστε αυτό το URI ρύθμισης στην εφαρμογή:',
  'admin.profile.setupStep3': 'Εισαγάγετε τον 6ψήφιο κωδικό που εμφανίζει για επιβεβαίωση:',
  'admin.profile.confirmEnable': 'Επιβεβαίωση και ενεργοποίηση',

  'admin.profile.backupCodesIntro':
    'Ο έλεγχος δύο παραγόντων είναι ενεργός. Αποθηκεύστε αυτούς τους εφεδρικούς κωδικούς σε ασφαλές μέρος — ο καθένας λειτουργεί μία φορά και δεν θα εμφανιστούν ξανά.',
  'admin.profile.backupCodesDone': 'Τους αποθήκευσα',

  'admin.profile.disableIntro':
    'Για να απενεργοποιήσετε τον έλεγχο δύο παραγόντων, εισαγάγετε έναν τρέχοντα κωδικό authenticator ή έναν εφεδρικό κωδικό.',
  'admin.profile.disableTwoFactor': 'Απενεργοποίηση δύο παραγόντων',

  // Browser-side (window.t): no plural support, so nothing here takes a count.
  'admin.profile.saveFailed': 'Η αποθήκευση απέτυχε: {error}',
  'admin.profile.profileUpdated': 'Το προφίλ ενημερώθηκε.',
  'admin.profile.passwordTooShort': 'Ο κωδικός πρέπει να έχει τουλάχιστον 8 χαρακτήρες.',
  'admin.profile.passwordMismatch': 'Οι κωδικοί δεν ταιριάζουν.',
  'admin.profile.passwordChangeFailed': 'Η αλλαγή κωδικού απέτυχε: {error}',
  'admin.profile.passwordUpdated': 'Ο κωδικός ενημερώθηκε.',
  'admin.profile.statusEnabled': 'Ενεργό',
  'admin.profile.statusDisabled': 'Ανενεργό',
  'admin.profile.setupFailed': 'Δεν ήταν δυνατή η έναρξη της ρύθμισης.',
  'admin.profile.enterCode': 'Εισαγάγετε τον 6ψήφιο κωδικό από την εφαρμογή σας.',
  'admin.profile.invalidCode': 'Μη έγκυρος κωδικός.',
  'admin.profile.enterDisableCode':
    'Εισαγάγετε έναν τρέχοντα κωδικό ή έναν εφεδρικό κωδικό για απενεργοποίηση.',
  'admin.profile.twoFactorDisabled': 'Ο έλεγχος δύο παραγόντων απενεργοποιήθηκε.',
};

export default profile;
