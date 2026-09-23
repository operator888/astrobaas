/**
 * de — admin.tools.*
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
  'admin.tools.title': 'Werkzeuge',
  'admin.tools.subtitle': 'Betriebswerkzeuge für Ihre Website.',

  'admin.tools.backupHeading': 'Sicherung',
  'admin.tools.backupDesc':
    'Laden Sie eine einzelne JSON-Datei herunter, die {db} sowie jede Datei unter {uploads} enthält. Dateien, die größer als 10 MB sind, werden übersprungen.',
  'admin.tools.backupDownload': 'Sicherung herunterladen',

  'admin.tools.restoreHeading': 'Wiederherstellung',
  'admin.tools.restoreDesc':
    'Laden Sie eine Sicherungsdatei hoch, die von derselben Version von AstroBaaS erstellt wurde.',
  'admin.tools.restoreWarning':
    'Dies überschreibt Ihre aktuelle Datenbank und alle Mediendateien mit demselben Namen.',
  'admin.tools.restoreSubmit': 'Aus Datei wiederherstellen',
  'admin.tools.restoreConfirm': 'Dies überschreibt Ihre aktuelle Website. Fortfahren?',
  'admin.tools.restoreInvalidJson': 'Die ausgewählte Datei ist kein gültiges JSON.',
  'admin.tools.restoreInProgress': 'Wird wiederhergestellt…',
  'admin.tools.restoreFailed': 'Wiederherstellung fehlgeschlagen: {error}',
  // Phrased without a plural: this one is read by window.t, which has no
  // plural support.
  'admin.tools.restoreComplete':
    'Wiederherstellung abgeschlossen. Geschrieben: {restored}, übersprungen: {skipped}.',

  'admin.tools.sectionsHeading': 'Zustand der Abschnitte',
  'admin.tools.sectionsDesc':
    'Abschnitte werden als CSS-Klassen in Ihren Inhalten gespeichert. Wird eine Klasse im Code entfernt oder umbenannt, tragen veröffentlichte Seiten weiterhin eine Klasse, die dieser Build nicht mehr gestalten kann. Hier wird nichts verändert — es wird lediglich berichtet, was vorhanden ist.',
  'admin.tools.statScanned': 'Geprüfte Datensätze',
  'admin.tools.statUsingSections': 'Mit Abschnitten',
  'admin.tools.statNeedingAttention': 'Erfordern Aufmerksamkeit',

  'admin.tools.orphanedHeading': 'Aus Plugins, die nicht aktiv sind',
  'admin.tools.inRecords_one': '— in {count} Datensatz',
  'admin.tools.inRecords_other': '— in {count} Datensätzen',
  'admin.tools.orphanedNote':
    'Es besteht kein Risiko. Dieses Markup bleibt beim Speichern erhalten und wird lediglich ohne Gestaltung dargestellt; durch erneutes Installieren oder Aktivieren des Plugins kehrt sein Erscheinungsbild zurück.',

  'admin.tools.sectionsAllKnown':
    'Jede Abschnittsklasse in Ihren Inhalten kann von diesem Build gestaltet werden.',
  'admin.tools.unknownHeading': 'Nicht erkannte Klassen',
  'admin.tools.affectedHeading': 'Betroffene Inhalte',
  'admin.tools.affectedTruncated': 'Es werden die ersten 50 von {total} angezeigt.',
  'admin.tools.affectedNote':
    'Es wurde nichts verändert. Stellen Sie entweder den fehlenden Abschnitt im Code wieder her, oder öffnen Sie jeden Datensatz und bauen Sie diesen Teil aus der aktuellen Palette neu auf — beim Speichern eines Datensatzes werden Klassen entfernt, die dieser Build nicht kennt.',
  'admin.tools.usageSummary': 'Welche Abschnitte verwendet werden',

  'admin.tools.patternsHeading': 'Vorlagen',
  'admin.tools.patternsDesc':
    'Fertige Layouts, die im Editor angeboten werden. Eine Vorlage wird nur angeboten, wenn ihr Markup den Sanitizer unverändert übersteht — andernfalls könnten Sie eine Seite aufbauen und beim Speichern einen Teil davon verlieren.',
  'admin.tools.patternsAvailable_one': '{countStrong} verfügbar (Theme: {theme}, {tier}).',
  'admin.tools.patternsAvailable_other': '{countStrong} verfügbar (Theme: {theme}, {tier}).',
  'admin.tools.patternsRejectedHeading': 'Nicht angeboten',

  'admin.tools.otherHeading': 'Sonstiges',
  'admin.tools.otherDesc':
    'Um alles auf die mitgelieferten Startdaten zurückzusetzen, stoppen Sie den Server, löschen Sie {db} und starten Sie ihn erneut. Die eingebauten Startinhalte werden dann neu angelegt.',
};

export default tools;
