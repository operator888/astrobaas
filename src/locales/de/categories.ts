/**
 * de — admin.categories.*
 *
 * One file per screen. 983 keys in a single module is a file nobody can review
 * and every translator conflicts in; split by surface, a screen's strings live
 * next to each other and two people can work at once.
 */
export const categories = {
  'admin.categories.pageTitle': 'Kategorien',
  'admin.categories.title': 'Kategorien',
  'admin.categories.addButton': 'Kategorie hinzufügen',

  // Form
  'admin.categories.formTitleAdd': 'Neue Kategorie hinzufügen',
  'admin.categories.formTitleEdit': 'Kategorie bearbeiten',
  'admin.categories.nameLabel': 'Name',
  'admin.categories.namePlaceholder': 'Kategorienamen eingeben',
  'admin.categories.slugLabel': 'Slug',
  'admin.categories.slugHint': 'URL-freundliche Fassung des Namens',
  'admin.categories.descriptionLabel': 'Beschreibung',
  'admin.categories.descriptionPlaceholder': 'Optionale Beschreibung',
  'admin.categories.submitAdd': 'Kategorie hinzufügen',
  'admin.categories.submitUpdate': 'Kategorie aktualisieren',
  'admin.categories.cancel': 'Abbrechen',

  // List
  'admin.categories.searchPlaceholder': 'Kategorien durchsuchen...',
  'admin.categories.count_one': '{count} Kategorie',
  'admin.categories.count_other': '{count} Kategorien',
  'admin.categories.colName': 'Name',
  'admin.categories.colSlug': 'Slug',
  'admin.categories.colDescription': 'Beschreibung',
  'admin.categories.colPosts': 'Beiträge',
  'admin.categories.colActions': 'Aktionen',
  'admin.categories.postCount_one': '{count} Beitrag',
  'admin.categories.postCount_other': '{count} Beiträge',
  'admin.categories.edit': 'Bearbeiten',
  'admin.categories.delete': 'Löschen',

  // Empty state
  'admin.categories.emptyTitle': 'Keine Kategorien gefunden',
  'admin.categories.emptyBody': 'Erstellen Sie zunächst Ihre erste Kategorie.',
  'admin.categories.emptyAction': 'Kategorie hinzufügen',

  // Messages
  'admin.categories.nameRequired': 'Der Name ist erforderlich.',
  'admin.categories.saved': 'Die Kategorie „{name}“ wurde gespeichert.',
  'admin.categories.saveFailed': 'Speichern fehlgeschlagen: {error}',
  'admin.categories.deleteConfirm': 'Möchten Sie die Kategorie „{name}“ wirklich löschen?',
  'admin.categories.deleted': 'Die Kategorie „{name}“ wurde gelöscht.',
  'admin.categories.deleteFailed': 'Löschen fehlgeschlagen: {error}',
};

export default categories;
