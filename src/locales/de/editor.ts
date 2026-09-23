/**
 * de — admin.editor.*
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
  'admin.editor.bold': 'Fett',
  'admin.editor.italic': 'Kursiv',
  'admin.editor.underline': 'Unterstrichen',

  // Toolbar — headings
  'admin.editor.heading1': 'Überschrift 1',
  'admin.editor.heading2': 'Überschrift 2',
  'admin.editor.heading3': 'Überschrift 3',

  // Toolbar — lists
  'admin.editor.bulletList': 'Aufzählungsliste',
  'admin.editor.orderedList': 'Nummerierte Liste',

  // Toolbar — link and image
  'admin.editor.addLink': 'Link einfügen',
  'admin.editor.addImage': 'Bild einfügen',

  // Toolbar — alignment
  'admin.editor.alignLeft': 'Linksbündig ausrichten',
  'admin.editor.alignCenter': 'Zentriert ausrichten',
  'admin.editor.alignRight': 'Rechtsbündig ausrichten',

  // Editing surface
  'admin.editor.placeholder': 'Beginnen Sie, Ihren Inhalt zu schreiben …',

  // prompt() dialogs, reached from the link and image buttons
  'admin.editor.linkPrompt': 'Geben Sie die URL ein:',
  'admin.editor.imagePrompt': 'Geben Sie die Bild-URL ein:',
  'admin.editor.addEmbed': 'Video oder Karte einbetten',
  'admin.editor.embedPrompt': 'Fügen Sie einen YouTube-, Vimeo- oder OpenStreetMap-Link ein:',
  'admin.editor.embedUnknown': 'Dieser Link kann nicht eingebettet werden. Unterstützt: YouTube, Vimeo, OpenStreetMap.',

  // Section palette
  'admin.editor.sectionsHeading': 'Abschnitte',
  'admin.editor.sectionsHint': 'Klicken Sie, um an der Cursorposition einzufügen',
  'admin.editor.sectionFromPlugin': '{description} (aus {plugin})',
  'admin.editor.fromPlugin': 'aus {plugin}',

  // Pattern palette
  'admin.editor.patternsHeading': 'Muster',
  'admin.editor.patternsHint': 'Vollständige Layouts, bereit zur Bearbeitung',

  // Controls for the section the caret is inside
  'admin.editor.selectedSection': 'Ausgewählter Abschnitt:',
  'admin.editor.moveUp': 'Nach oben verschieben',
  'admin.editor.moveDown': 'Nach unten verschieben',
  'admin.editor.duplicate': 'Duplizieren',
  'admin.editor.delete': 'Löschen',
};

export default editor;
