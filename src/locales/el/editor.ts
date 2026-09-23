/**
 * el — admin.editor.*
 *
 * One file per screen. 983 keys in a single module is a file nobody can review
 * and every translator conflicts in; split by surface, a screen's strings live
 * next to each other and two people can work at once.
 *
 * See the en catalogue for what this surface deliberately leaves untranslated:
 * section/pattern labels come from data, and modifier names double as class
 * fragments.
 */
export const editor = {
  // Toolbar — inline formatting
  'admin.editor.bold': 'Έντονα',
  'admin.editor.italic': 'Πλάγια',
  'admin.editor.underline': 'Υπογράμμιση',

  // Toolbar — headings
  'admin.editor.heading1': 'Επικεφαλίδα 1',
  'admin.editor.heading2': 'Επικεφαλίδα 2',
  'admin.editor.heading3': 'Επικεφαλίδα 3',

  // Toolbar — lists
  'admin.editor.bulletList': 'Λίστα με κουκκίδες',
  'admin.editor.orderedList': 'Αριθμημένη λίστα',

  // Toolbar — link and image
  'admin.editor.addLink': 'Προσθήκη συνδέσμου',
  'admin.editor.addImage': 'Προσθήκη εικόνας',

  // Toolbar — alignment
  'admin.editor.alignLeft': 'Στοίχιση αριστερά',
  'admin.editor.alignCenter': 'Στοίχιση στο κέντρο',
  'admin.editor.alignRight': 'Στοίχιση δεξιά',

  // Editing surface
  'admin.editor.placeholder': 'Ξεκινήστε να γράφετε το περιεχόμενό σας…',

  // prompt() dialogs, reached from the link and image buttons
  'admin.editor.linkPrompt': 'Εισαγάγετε τη διεύθυνση URL:',
  'admin.editor.imagePrompt': 'Εισαγάγετε τη διεύθυνση URL της εικόνας:',
  'admin.editor.addEmbed': 'Ενσωμάτωση βίντεο ή χάρτη',
  'admin.editor.embedPrompt': 'Επικολλήστε έναν σύνδεσμο YouTube, Vimeo ή OpenStreetMap:',
  'admin.editor.embedUnknown': 'Αυτός ο σύνδεσμος δεν μπορεί να ενσωματωθεί. Υποστηρίζονται: YouTube, Vimeo, OpenStreetMap.',

  // Section palette
  'admin.editor.sectionsHeading': 'Ενότητες',
  'admin.editor.sectionsHint': 'Κάντε κλικ για εισαγωγή στο σημείο του δρομέα',
  'admin.editor.sectionFromPlugin': '{description} (από {plugin})',
  'admin.editor.fromPlugin': 'από {plugin}',

  // Pattern palette
  'admin.editor.patternsHeading': 'Μοτίβα',
  'admin.editor.patternsHint': 'Ολοκληρωμένες διατάξεις, έτοιμες για επεξεργασία',

  // Controls for the section the caret is inside
  'admin.editor.selectedSection': 'Επιλεγμένη ενότητα:',
  'admin.editor.moveUp': 'Μετακίνηση επάνω',
  'admin.editor.moveDown': 'Μετακίνηση κάτω',
  'admin.editor.duplicate': 'Δημιουργία αντιγράφου',
  'admin.editor.delete': 'Διαγραφή',
};

export default editor;
