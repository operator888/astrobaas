/**
 * de — admin.media.*
 *
 * One file per screen. 983 keys in a single module is a file nobody can review
 * and every translator conflicts in; split by surface, a screen's strings live
 * next to each other and two people can work at once.
 */
export const media = {
  // Page chrome
  'admin.media.title': 'Medienbibliothek',
  'admin.media.subtitle': 'Verwalten Sie Ihre Bilder, Videos und weitere Mediendateien',

  // Upload area
  'admin.media.uploadHeading': 'Medien hochladen',
  'admin.media.uploadHint': 'Dateien hierher ziehen und ablegen oder klicken, um Dateien auszuwählen',
  'admin.media.uploadFormats': 'Bilder: JPG, PNG, GIF, WebP (max. {image} MB) · Video: MP4, WebM (max. {video} MB)',
  'admin.media.uploading': 'Wird hochgeladen…',
  'admin.media.uploadDone': 'Fertig',
  'admin.media.uploadFailed': 'Hochladen fehlgeschlagen: {error}',

  // Toolbar
  'admin.media.searchPlaceholder': 'Medien durchsuchen…',
  'admin.media.gridView': 'Rasteransicht',
  'admin.media.listView': 'Listenansicht',

  // Grid / list state
  'admin.media.loading': 'Wird geladen…',
  'admin.media.empty': 'Noch keine Medien vorhanden. Laden Sie oben eine Datei hoch.',

  // List columns
  'admin.media.colFile': 'Datei',
  'admin.media.colType': 'Typ',
  'admin.media.colSize': 'Größe',
  'admin.media.colDate': 'Datum',
  'admin.media.colActions': 'Aktionen',

  // Row actions. These are LABELS only — the click handler dispatches on
  // data-action="select" / data-action="delete", never on the text or title.
  'admin.media.insert': 'In den Beitrag einfügen',
  'admin.media.select': 'Auswählen',
  'admin.media.addAlt': 'Beschreiben',
  'admin.media.altPrompt': 'Beschreiben Sie das Bild für jemanden, der es nicht sehen kann. Leer lassen, wenn es dekorativ ist.',
  'admin.media.altFailed': 'Beschreibung konnte nicht gespeichert werden',
  'admin.media.replace': 'Ersetzen',
  'admin.media.replaceConfirm': 'Diese Datei ersetzen? Seiten und Produkte, die sie verwenden, werden auf die neue umgestellt, und die alte Datei wird entfernt.',
  'admin.media.replaceFailed': 'Datei konnte nicht ersetzt werden: {error}',
  'admin.media.replaced': 'Ersetzt. {posts} Seite(n) und {products} Produkt(e) wurden aktualisiert.',
  'admin.media.delete': 'Löschen',
  'admin.media.deleteConfirm': 'Möchten Sie diese Mediendatei wirklich löschen?',
  'admin.media.deleteFailed': 'Löschen fehlgeschlagen: {error}',

  // File sizes. Only the spelled-out unit is translatable; KB/MB/GB are
  // international symbols and stay as they are in every locale.
  'admin.media.unitBytes': 'Bytes',
  'admin.media.loadMore': 'Mehr laden',
  'admin.media.rateLimited': 'Ratenlimit erreicht — neuer Versuch in {seconds}s…',
};

export default media;
