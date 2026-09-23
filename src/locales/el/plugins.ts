/**
 * el — admin.plugins.*
 *
 * One file per screen. 983 keys in a single module is a file nobody can review
 * and every translator conflicts in; split by surface, a screen's strings live
 * next to each other and two people can work at once.
 *
 * The inline <em>/<strong> tags are part of the sentence and move with it —
 * in Greek the emphasised word is rarely where English puts it. {env},
 * {module}, {path} and {doc} are supplied by the page: they are code, not text.
 */
export const plugins = {
  'admin.plugins.title': 'Πρόσθετα',
  'admin.plugins.intro':
    'Ενεργοποιήστε ή απενεργοποιήστε τα ενσωματωμένα πρόσθετα. {active} από {total} ενεργά. Η ενεργοποίηση διατηρείται μετά από επανεκκίνηση.',

  // ---- the two-tier explainer ----
  'admin.plugins.tiersHeading': 'Δύο επίπεδα.',
  'admin.plugins.tiersBundled':
    'Τα <em>ενσωματωμένα</em> πρόσθετα είναι έμπιστα modules TypeScript που μεταγλωττίζονται από το {path} — για να προστεθεί ένα ακόμη απαιτείται νέο build.',
  'admin.plugins.tiersDeclarative':
    'Τα <em>δηλωτικά</em> πρόσθετα είναι manifest JSON που μπορείτε να εγκαταστήσετε εδώ, αμέσως: προσθέτουν meta tags, CSS, τύπους περιεχομένου και webhooks χωρίς να εκτελούν κώδικα.',
  'admin.plugins.tiersDocs': 'Δείτε το {doc}.',

  // ---- active in the database, but nothing loaded ----
  'admin.plugins.orphanedTitle_one': 'Ένα πρόσθετο είναι ενεργοποιημένο αλλά δεν είναι εγκατεστημένο',
  'admin.plugins.orphanedTitle_other': 'Υπάρχουν πρόσθετα ενεργοποιημένα αλλά μη εγκατεστημένα',
  'admin.plugins.orphanedBody':
    'Αυτά είναι σημειωμένα ως ενεργά στη βάση δεδομένων του ιστότοπου, αλλά δεν έχει φορτωθεί κώδικας για αυτά — επομένως <strong>ό,τι κάνουν δεν συμβαίνει, σιωπηλά</strong>. Οι παραγγελίες και το περιεχόμενο εξακολουθούν να γίνονται δεκτά· απλώς δεν ελέγχονται.',
  'admin.plugins.orphanedCause':
    'Η συνήθης αιτία είναι μια ανάπτυξη που δεν εγκατέστησε ένα εξωτερικό module. Εγκαταστήστε το, δηλώστε το στο {env} και έπειτα κάντε επανεκκίνηση.',
  'admin.plugins.orphanedOptical':
    'Για τον κλάδο των οπτικών αυτό είναι το {module} — μέχρι να επανέλθει, <strong>οι συνταγές δεν επαληθεύονται</strong>.',

  // ---- install panel ----
  'admin.plugins.installPanel': 'Εγκατάσταση πρόσθετου',
  'admin.plugins.installedCount_one': '{count} εγκατεστημένο',
  'admin.plugins.installedCount_other': '{count} εγκατεστημένα',
  'admin.plugins.registryAvailable': 'το μητρώο είναι διαθέσιμο',
  'admin.plugins.registryDisabled': 'το μητρώο είναι απενεργοποιημένο',

  'admin.plugins.fromRegistry': 'Από το επιμελημένο μητρώο',
  'admin.plugins.browseRegistry': 'Περιήγηση στο μητρώο',
  'admin.plugins.registryHint':
    'Τα manifest λαμβάνονται μέσω HTTPS και το άθροισμα ελέγχου SHA-256 τους επαληθεύεται πριν εγκατασταθεί οτιδήποτε.',

  'admin.plugins.fromManifest': 'Από manifest',
  'admin.plugins.manifestHint':
    'Επικολλήστε ένα manifest πρόσθετου (JSON). Επικυρώνεται πριν από την εγκατάσταση — άκυρα ή μη ασφαλή manifest απορρίπτονται με αιτιολογία.',
  'admin.plugins.validateInstall': 'Επικύρωση και εγκατάσταση',

  // ---- the plugin list ----
  'admin.plugins.empty': 'Δεν υπάρχουν ενσωματωμένα πρόσθετα.',
  'admin.plugins.statusActive': 'Ενεργό',
  'admin.plugins.statusInactive': 'Ανενεργό',
  'admin.plugins.kindDeclarative': 'Δηλωτικό',
  'admin.plugins.kindBundled': 'Ενσωματωμένο',
  'admin.plugins.byAuthor': 'από {author}',
  'admin.plugins.hooks': 'hooks: {hooks}',
  'admin.plugins.noHooks': 'κανένα',
  'admin.plugins.capabilities': 'δυνατότητες: {list}',
  'admin.plugins.source': 'πηγή: {source}',
  'admin.plugins.requires': 'απαιτεί: {list}',
  'admin.plugins.activate': 'Ενεργοποίηση',
  'admin.plugins.deactivate': 'Απενεργοποίηση',
  'admin.plugins.uninstall': 'Απεγκατάσταση',
  'admin.plugins.uninstallTitle': 'Απεγκατάσταση αυτού του δηλωτικού πρόσθετου',

  // ---- browser-side (window.t: no plurals) ----
  'admin.plugins.toggleFailed': 'Η αλλαγή κατάστασης του πρόσθετου απέτυχε',
  'admin.plugins.uninstallConfirm':
    'Απεγκατάσταση του «{name}»;\n\nΟι τύποι περιεχομένου του παύουν να εξυπηρετούνται και όσα webhooks δημιούργησε διαγράφονται. Οι υπάρχουσες εγγραφές ΔΕΝ διαγράφονται.',
  'admin.plugins.uninstallFailed': 'Η απεγκατάσταση του πρόσθετου απέτυχε',
  'admin.plugins.pasteFirst': 'Επικολλήστε πρώτα ένα manifest.',
  'admin.plugins.invalidJson': 'Μη έγκυρο JSON: {message}',
  'admin.plugins.installedFlash': 'Εγκαταστάθηκε το {id} v{version}. Γίνεται επαναφόρτωση…',
  'admin.plugins.installFailed': 'Η εγκατάσταση απέτυχε',
  'admin.plugins.registryEmpty': 'Το μητρώο δεν έχει ακόμη πρόσθετα.',
  'admin.plugins.install': 'Εγκατάσταση',
  'admin.plugins.verifying': 'Γίνεται επαλήθευση…',
  'admin.plugins.fetchManifestFailed': 'Δεν ήταν δυνατή η λήψη του manifest',
  'admin.plugins.loading': 'Γίνεται φόρτωση…',
  'admin.plugins.registryReadFailed': 'Δεν ήταν δυνατή η ανάγνωση του μητρώου',
};

export default plugins;
