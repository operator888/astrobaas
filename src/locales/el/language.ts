/**
 * el — admin.language.*
 *
 * One file per screen. 983 keys in a single module is a file nobody can review
 * and every translator conflicts in; split by surface, a screen's strings live
 * next to each other and two people can work at once.
 */
export const language = {
  'admin.language.label': 'Γλώσσα διαχείρισης',
  'admin.language.help': 'Η γλώσσα του περιβάλλοντος διαχείρισης. Δεν αλλάζει τη γλώσσα του περιεχομένου σας.',
  'admin.language.followSite': 'Προεπιλογή ιστότοπου',
  'admin.language.incomplete': '{missing} από {total} μηνύματα δεν έχουν μεταφραστεί ακόμη και θα εμφανίζονται στα αγγλικά.',
};

export default language;
