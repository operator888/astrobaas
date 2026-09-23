/**
 * en — admin.editor.*
 *
 * One file per screen. 983 keys in a single module is a file nobody can review
 * and every translator conflicts in; split by surface, a screen's strings live
 * next to each other and two people can work at once.
 *
 * Two things on this surface are deliberately NOT here:
 *
 *  - Section and pattern labels/descriptions. They come from
 *    `src/core/sections.ts`, the theme's pattern set and installed plugin
 *    manifests — data, not markup — so translating them belongs with those
 *    sources, not with this screen.
 *  - Modifier group names and their values. `renderModifiers()` builds the
 *    class `ab-<group>-<value>` out of exactly the strings it prints, so the
 *    label IS the program value. Translating one translates the other and the
 *    class stops matching the stylesheet.
 */
export const editor = {
  // Toolbar — inline formatting
  'admin.editor.bold': 'Bold',
  'admin.editor.italic': 'Italic',
  'admin.editor.underline': 'Underline',

  // Toolbar — headings. The button faces stay "H1"/"H2"/"H3"; only the
  // tooltips below are translated.
  'admin.editor.heading1': 'Heading 1',
  'admin.editor.heading2': 'Heading 2',
  'admin.editor.heading3': 'Heading 3',

  // Toolbar — lists
  'admin.editor.bulletList': 'Bullet List',
  'admin.editor.orderedList': 'Numbered List',

  // Toolbar — link and image
  'admin.editor.addLink': 'Add Link',
  'admin.editor.addImage': 'Add Image',

  // Toolbar — alignment
  'admin.editor.alignLeft': 'Align Left',
  'admin.editor.alignCenter': 'Align Center',
  'admin.editor.alignRight': 'Align Right',

  // Editing surface
  'admin.editor.placeholder': 'Start writing your content...',

  // prompt() dialogs, reached from the link and image buttons
  'admin.editor.linkPrompt': 'Enter URL:',
  'admin.editor.imagePrompt': 'Enter image URL:',
  'admin.editor.addEmbed': 'Embed a video or map',
  'admin.editor.embedPrompt': 'Paste a YouTube, Vimeo or OpenStreetMap link:',
  'admin.editor.embedUnknown': 'That link is not one this site can embed. Supported: YouTube, Vimeo, OpenStreetMap.',

  // Section palette
  'admin.editor.sectionsHeading': 'Sections',
  'admin.editor.sectionsHint': 'Click to insert at the cursor',
  'admin.editor.sectionFromPlugin': '{description} (from {plugin})',
  'admin.editor.fromPlugin': 'from {plugin}',

  // Pattern palette
  'admin.editor.patternsHeading': 'Patterns',
  'admin.editor.patternsHint': 'Whole layouts, ready to edit',

  // Controls for the section the caret is inside
  'admin.editor.selectedSection': 'Selected section:',
  'admin.editor.moveUp': 'Move up',
  'admin.editor.moveDown': 'Move down',
  'admin.editor.duplicate': 'Duplicate',
  'admin.editor.delete': 'Delete',
};

export default editor;
