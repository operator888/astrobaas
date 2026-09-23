/**
 * en — admin.tools.*
 *
 * One file per screen. 983 keys in a single module is a file nobody can review
 * and every translator conflicts in; split by surface, a screen's strings live
 * next to each other and two people can work at once.
 *
 * `{db}` and `{uploads}` are markup placeholders filled by the page with a
 * `<code>` element — the path inside it is a literal and must not be
 * translated, but its position in the sentence differs per language.
 */
export const tools = {
  'admin.tools.title': 'Tools',
  'admin.tools.subtitle': 'Operational utilities for your site.',

  'admin.tools.backupHeading': 'Backup',
  'admin.tools.backupDesc':
    'Download a single JSON file containing {db} and every file under {uploads}. Files larger than 10 MB are skipped.',
  'admin.tools.backupDownload': 'Download backup',

  'admin.tools.restoreHeading': 'Restore',
  'admin.tools.restoreDesc': 'Upload a backup file produced by this same version of AstroBaaS.',
  'admin.tools.restoreWarning':
    'This will overwrite your current database and any media files with the same name.',
  'admin.tools.restoreSubmit': 'Restore from file',
  'admin.tools.restoreConfirm': 'This will overwrite your current site. Continue?',
  'admin.tools.restoreInvalidJson': 'Selected file is not valid JSON.',
  'admin.tools.restoreInProgress': 'Restoring…',
  'admin.tools.restoreFailed': 'Restore failed: {error}',
  // Phrased without a plural: this one is read by window.t, which has no
  // plural support.
  'admin.tools.restoreComplete': 'Restore complete. Written: {restored}, skipped: {skipped}.',

  'admin.tools.sectionsHeading': 'Section health',
  'admin.tools.sectionsDesc':
    'Sections are CSS classes stored inside your content, so removing or renaming one in code leaves published pages carrying a class this build can no longer style. Nothing is changed here — this only reports what is there.',
  'admin.tools.statScanned': 'Records scanned',
  'admin.tools.statUsingSections': 'Using sections',
  'admin.tools.statNeedingAttention': 'Needing attention',

  'admin.tools.orphanedHeading': 'From plugins that are not active',
  'admin.tools.inRecords_one': '— in {count} record',
  'admin.tools.inRecords_other': '— in {count} records',
  'admin.tools.orphanedNote':
    'Nothing is at risk. This markup is preserved on save and simply renders unstyled; reinstalling or reactivating the plugin restores its appearance.',

  'admin.tools.sectionsAllKnown': 'Every section class in your content is one this build can style.',
  'admin.tools.unknownHeading': 'Unrecognised classes',
  'admin.tools.affectedHeading': 'Affected content',
  'admin.tools.affectedTruncated': 'Showing the first 50 of {total}.',
  'admin.tools.affectedNote':
    'Nothing has been altered. Either restore the missing section in code, or open each record and rebuild that part from the current palette — saving a record drops classes this build does not recognise.',
  'admin.tools.usageSummary': 'Which sections are in use',

  'admin.tools.patternsHeading': 'Patterns',
  'admin.tools.patternsDesc':
    'Ready-made layouts offered in the editor. A pattern is only offered if its markup survives the sanitizer exactly — one that did not would let you build a page and lose part of it on save.',
  'admin.tools.patternsAvailable_one': '{countStrong} available (theme: {theme}, {tier}).',
  'admin.tools.patternsAvailable_other': '{countStrong} available (theme: {theme}, {tier}).',
  'admin.tools.patternsRejectedHeading': 'Not offered',

  'admin.tools.otherHeading': 'Other',
  'admin.tools.otherDesc':
    'To reset everything to the bundled seed data, stop the server, delete {db}, and start it again. It will be re-seeded with the built-in starter content.',
};

export default tools;
