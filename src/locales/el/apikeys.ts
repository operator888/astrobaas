/**
 * el — admin.apikeys.*
 *
 * One file per screen. 983 keys in a single module is a file nobody can review
 * and every translator conflicts in; split by surface, a screen's strings live
 * next to each other and two people can work at once.
 *
 * The `roleX` keys are LABELS only. The role a key is minted with travels in
 * the `value` attribute of its <option> and in the JSON payload, so translating
 * the label can never change what the API is asked for.
 */
export const apikeys = {
  'admin.apikeys.title': 'Κλειδιά API',
  'admin.apikeys.intro': 'Κλειδιά Bearer για headless / cross-origin πρόσβαση και για agents. Το μυστικό εμφανίζεται μία μόνο φορά, κατά τη δημιουργία.',

  'admin.apikeys.secretWarning': 'Αντιγράψτε το κλειδί τώρα — δεν θα εμφανιστεί ξανά.',
  'admin.apikeys.copySecret': 'Αντιγραφή',

  'admin.apikeys.nameLabel': 'Όνομα',
  'admin.apikeys.namePlaceholder': 'my-frontend',
  'admin.apikeys.roleLabel': 'Ρόλος',
  'admin.apikeys.roleAdmin': 'Διαχειριστής',
  'admin.apikeys.roleEditor': 'Επιμελητής',
  'admin.apikeys.roleAuthor': 'Συντάκτης',
  'admin.apikeys.roleManager': 'Υπεύθυνος',
  'admin.apikeys.roleViewer': 'Θεατής',
  'admin.apikeys.scopesLabel': 'Πεδία πρόσβασης (προαιρετικό)',
  'admin.apikeys.scopesHelp': 'Χωρισμένα με κόμμα. Αφήστε το κενό για πλήρη πρόσβαση του ρόλου.',
  'admin.apikeys.expiresLabel': 'Λήξη σε ημέρες (προαιρετικό)',
  'admin.apikeys.createButton': 'Δημιουργία κλειδιού',

  'admin.apikeys.colName': 'Όνομα',
  'admin.apikeys.colPrefix': 'Πρόθεμα',
  'admin.apikeys.colRole': 'Ρόλος',
  'admin.apikeys.colScopes': 'Πεδία πρόσβασης',
  'admin.apikeys.colExpires': 'Λήγει',
  'admin.apikeys.colLastUsed': 'Τελευταία χρήση',
  'admin.apikeys.colActions': 'Ενέργειες',

  'admin.apikeys.loading': 'Φόρτωση…',
  'admin.apikeys.empty': 'Δεν υπάρχουν ακόμη κλειδιά.',

  'admin.apikeys.rotate': 'Ανανέωση',
  'admin.apikeys.revoke': 'Ανάκληση',
  'admin.apikeys.rotateConfirm': 'Ανανέωση αυτού του κλειδιού; Το τρέχον μυστικό παύει να ισχύει αμέσως.',
  'admin.apikeys.revokeConfirm': 'Ανάκληση του «{name}»; Η ενέργεια δεν αναιρείται.',
};

export default apikeys;
