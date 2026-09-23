/**
 * el — admin.themes.*
 *
 * One file per screen. 983 keys in a single module is a file nobody can review
 * and every translator conflicts in; split by surface, a screen's strings live
 * next to each other and two people can work at once.
 *
 * `admin.themes.scale.<group>.*` translates only the LABEL of each enum option;
 * the stored value stays the English enum key from src/lib/theme-tokens.ts.
 */
export const themes = {
  'admin.themes.title': 'Θέματα',
  'admin.themes.subtitle':
    'Αλλάξτε το ενεργό θέμα και προσαρμόστε τα χρώματα και την τυπογραφία του. Οι αλλαγές εφαρμόζονται αμέσως στον δημόσιο ιστότοπο.',

  // Install from a manifest
  'admin.themes.installTitle': 'Εγκατάσταση θέματος',
  'admin.themes.installHelp':
    'Επικολλήστε ένα manifest θέματος (JSON). Ένα manifest περιέχει tokens σχεδίασης, ένα φύλλο στυλ και μοτίβα ενοτήτων — μόνο δεδομένα, οπότε εγκαθίσταται χωρίς νέο build. Δεν μπορεί να εκτελέσει κώδικα, καθορίζει όμως την εμφάνιση κάθε σελίδας: εγκαταστήστε το μόνο από πηγές από τις οποίες θα παίρνατε φύλλο στυλ.',
  'admin.themes.install': 'Εγκατάσταση',

  // Installed list
  'admin.themes.installedTitle': 'Εγκατεστημένα θέματα',
  'admin.themes.installedBadge': 'Εγκατεστημένο',
  'admin.themes.activeBadge': 'Ενεργό',
  'admin.themes.version': 'Έκδοση {version}',
  'admin.themes.byAuthor': 'από {author}',
  'admin.themes.declarativeSummary':
    'Εγκατεστημένο θέμα — {parts}. Χρησιμοποιεί τα ενσωματωμένα πρότυπα.',
  'admin.themes.partTokens': 'tokens',
  'admin.themes.partStylesheet': 'φύλλο στυλ',
  'admin.themes.partPatterns_one': '{count} μοτίβο',
  'admin.themes.partPatterns_other': '{count} μοτίβα',
  'admin.themes.tokensOnly': 'Μόνο tokens σχεδίασης — χρησιμοποιεί τα ενσωματωμένα πρότυπα.',
  'admin.themes.overridesCount': 'Αντικαθιστά {count} από {total} πρότυπα:',
  'admin.themes.activate': 'Ενεργοποίηση',
  'admin.themes.uninstall': 'Απεγκατάσταση',

  // Customizer
  'admin.themes.customizeHeading': 'Προσαρμογή: {name}',
  'admin.themes.siteIdentity': 'Ταυτότητα ιστότοπου',
  'admin.themes.siteTitle': 'Τίτλος ιστότοπου',
  'admin.themes.tagline': 'Σύνθημα',
  'admin.themes.colors': 'Χρώματα',
  'admin.themes.colorPrimary': 'Κύριο χρώμα',
  'admin.themes.colorSecondary': 'Δευτερεύον χρώμα',
  'admin.themes.colorAccent': 'Χρώμα τονισμού',
  'admin.themes.colorBackground': 'Χρώμα φόντου',
  'admin.themes.colorText': 'Χρώμα κειμένου',
  'admin.themes.typography': 'Τυπογραφία',
  'admin.themes.headingFont': 'Γραμματοσειρά επικεφαλίδων',
  'admin.themes.bodyFont': 'Γραμματοσειρά κειμένου',
  'admin.themes.presets': 'Έτοιμα στυλ',
  'admin.themes.presetsHelp':
    'Εφαρμόζει μαζί χρώματα, τυπογραφία, σχήματα και αποστάσεις. Αποθηκεύστε για να διατηρηθεί.',
  'admin.themes.baseFontSize': 'Βασικό μέγεθος γραμματοσειράς',
  'admin.themes.colorSchemeHelp':
    'Το "auto" ακολουθεί τη συσκευή του επισκέπτη και εμφανίζει διακόπτη στην κεφαλίδα.',

  // Style scales — labels
  'admin.themes.scale.typeScale.label': 'Κλίμακα τυπογραφίας',
  'admin.themes.scale.headingWeight.label': 'Βάρος επικεφαλίδων',
  'admin.themes.scale.radius.label': 'Στρογγυλότητα γωνιών',
  'admin.themes.scale.density.label': 'Αποστάσεις',
  'admin.themes.scale.shadow.label': 'Σκιές',
  'admin.themes.scale.containerWidth.label': 'Πλάτος περιεχομένου',
  'admin.themes.scale.buttonStyle.label': 'Κουμπιά',
  'admin.themes.scale.headerStyle.label': 'Κεφαλίδα',
  'admin.themes.scale.colorScheme.label': 'Χρωματικό σχήμα',

  // Style scales — options
  'admin.themes.scale.typeScale.compact': 'Πυκνή',
  'admin.themes.scale.typeScale.normal': 'Κανονική',
  'admin.themes.scale.typeScale.spacious': 'Ευρύχωρη',
  'admin.themes.scale.headingWeight.normal': 'Κανονικό',
  'admin.themes.scale.headingWeight.medium': 'Μεσαίο',
  'admin.themes.scale.headingWeight.semibold': 'Ημίπαχο',
  'admin.themes.scale.headingWeight.bold': 'Έντονο',
  'admin.themes.scale.radius.none': 'Καμία',
  'admin.themes.scale.radius.sm': 'Μικρή',
  'admin.themes.scale.radius.md': 'Μεσαία',
  'admin.themes.scale.radius.lg': 'Μεγάλη',
  'admin.themes.scale.radius.full': 'Μέγιστη',
  'admin.themes.scale.density.compact': 'Πυκνές',
  'admin.themes.scale.density.normal': 'Κανονικές',
  'admin.themes.scale.density.roomy': 'Άνετες',
  'admin.themes.scale.shadow.none': 'Χωρίς',
  'admin.themes.scale.shadow.soft': 'Απαλές',
  'admin.themes.scale.shadow.strong': 'Έντονες',
  'admin.themes.scale.containerWidth.narrow': 'Στενό',
  'admin.themes.scale.containerWidth.normal': 'Κανονικό',
  'admin.themes.scale.containerWidth.wide': 'Πλατύ',
  'admin.themes.scale.containerWidth.full': 'Πλήρες πλάτος',
  'admin.themes.scale.buttonStyle.solid': 'Συμπαγή',
  'admin.themes.scale.buttonStyle.outline': 'Με περίγραμμα',
  'admin.themes.scale.buttonStyle.soft': 'Απαλά',
  'admin.themes.scale.buttonStyle.pill': 'Οβάλ',
  'admin.themes.scale.headerStyle.minimal': 'Λιτή',
  'admin.themes.scale.headerStyle.centered': 'Κεντραρισμένη',
  'admin.themes.scale.headerStyle.split': 'Μοιρασμένη',
  'admin.themes.scale.headerStyle.masthead': 'Πανό',
  'admin.themes.scale.colorScheme.light': 'Φωτεινό',
  'admin.themes.scale.colorScheme.dark': 'Σκοτεινό',
  'admin.themes.scale.colorScheme.auto': 'Αυτόματο',

  // Custom CSS
  'admin.themes.customCss': 'Προσαρμοσμένο CSS',
  'admin.themes.customCssHelp':
    'Προστίθεται στο {file}, οπότε υπερισχύει των tokens παραπάνω. Σερβίρεται ως φύλλο στυλ (ποτέ ενσωματωμένο), κάτι που το διατηρεί λειτουργικό υπό την αυστηρή Content-Security-Policy.',
  'admin.themes.customCssLimit': '/{max} χαρακτήρες.',
  'admin.themes.customCssStripped': 'αφαιρείται.',

  'admin.themes.save': 'Αποθήκευση αλλαγών',

  // Live preview
  'admin.themes.livePreview': 'Ζωντανή προεπισκόπηση',
  'admin.themes.previewPostTitle': 'Δείγμα άρθρου',
  'admin.themes.previewBody': 'Η προεπισκόπηση αντικατοπτρίζει τις ρυθμίσεις του θέματός σας.',
  'admin.themes.previewLink': 'Οι σύνδεσμοι χρησιμοποιούν το κύριο χρώμα.',
  'admin.themes.previewPrimary': 'Κύριο',
  'admin.themes.previewAccent': 'Τονισμός',

  // Browser-side messages (window.t — no plural support)
  'admin.themes.presetApplied': 'Το στυλ εφαρμόστηκε — πατήστε Αποθήκευση για να διατηρηθεί.',
  'admin.themes.saved': 'Αποθηκεύτηκε. Γίνεται επαναφόρτωση…',
  'admin.themes.saveFailed': 'Η αποθήκευση απέτυχε.',
  'admin.themes.activateFailed': 'Η ενεργοποίηση απέτυχε',
  'admin.themes.manifestRequired': 'Επικολλήστε πρώτα ένα manifest θέματος.',
  'admin.themes.invalidJson': 'Αυτό δεν είναι έγκυρο JSON: {message}',
  'admin.themes.installed': 'Εγκαταστάθηκε. Γίνεται επαναφόρτωση…',
  'admin.themes.installFailed': 'Η εγκατάσταση απέτυχε',
  'admin.themes.installRejected': 'Αυτό το θέμα δεν εγκαταστάθηκε:',
  'admin.themes.patternRejected': 'Μοτίβο “{name}” — {reason}',
  'admin.themes.youWrote': 'Γράψατε:',
  'admin.themes.sanitizerKeeps': 'Ο καθαριστής διατηρεί:',
  'admin.themes.uninstallConfirm':
    'Απεγκατάσταση του “{name}”; Τα στυλ και τα μοτίβα του παύουν να προσφέρονται. Το περιεχόμενό σας δεν επηρεάζεται.',
  'admin.themes.uninstallFailed': 'Η απεγκατάσταση απέτυχε',
};

export default themes;
