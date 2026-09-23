/**
 * de — admin.plugins.*
 *
 * One file per screen. 983 keys in a single module is a file nobody can review
 * and every translator conflicts in; split by surface, a screen's strings live
 * next to each other and two people can work at once.
 *
 * The inline <em>/<strong> tags are part of the sentence and move with it.
 * {env}, {module}, {path} and {doc} are supplied by the page: they are code,
 * not text, and must read identically in every locale.
 *
 * Compounds are written out in full — "Die Registry konnte nicht gelesen
 * werden", not a clipped "Registry-Fehler". A label that wraps is a layout
 * problem to fix in the layout.
 */
export const plugins = {
  'admin.plugins.title': 'Plugins',
  'admin.plugins.intro':
    'Aktivieren oder deaktivieren Sie mitgelieferte Plugins. {active} von {total} aktiv. Die Aktivierung bleibt über Neustarts hinweg erhalten.',

  // ---- the two-tier explainer ----
  'admin.plugins.tiersHeading': 'Zwei Stufen.',
  'admin.plugins.tiersBundled':
    '<em>Mitgelieferte</em> Plugins sind vertrauenswürdige TypeScript-Module, die aus {path} einkompiliert werden — ein weiteres hinzuzufügen erfordert einen neuen Build.',
  'admin.plugins.tiersDeclarative':
    '<em>Deklarative</em> Plugins sind JSON-Manifeste, die Sie hier und sofort installieren können: Sie fügen Meta-Tags, CSS, Inhaltstypen und Webhooks hinzu, ohne Code auszuführen.',
  'admin.plugins.tiersDocs': 'Siehe {doc}.',

  // ---- active in the database, but nothing loaded ----
  'admin.plugins.orphanedTitle_one': 'Ein Plugin ist eingeschaltet, aber nicht installiert',
  'admin.plugins.orphanedTitle_other': 'Plugins sind eingeschaltet, aber nicht installiert',
  'admin.plugins.orphanedBody':
    'Diese sind in der Datenbank dieser Website als aktiv markiert, es ist jedoch kein Code für sie geladen — <strong>alles, was sie tun, findet also unbemerkt nicht statt</strong>. Bestellungen und Inhalte werden weiterhin angenommen; sie werden lediglich nicht geprüft.',
  'admin.plugins.orphanedCause':
    'Die übliche Ursache ist ein Deployment, das ein externes Modul nicht installiert hat. Installieren Sie es, tragen Sie es in {env} ein und starten Sie anschließend neu.',
  'admin.plugins.orphanedOptical':
    'Für die Optik-Branche ist das {module} — bis es wieder da ist, <strong>werden Rezepte nicht geprüft</strong>.',

  // ---- install panel ----
  'admin.plugins.installPanel': 'Ein Plugin installieren',
  'admin.plugins.installedCount_one': '{count} installiert',
  'admin.plugins.installedCount_other': '{count} installiert',
  'admin.plugins.registryAvailable': 'Registry verfügbar',
  'admin.plugins.registryDisabled': 'Registry deaktiviert',

  'admin.plugins.fromRegistry': 'Aus der kuratierten Registry',
  'admin.plugins.browseRegistry': 'Registry durchsuchen',
  'admin.plugins.registryHint':
    'Manifeste werden über HTTPS abgerufen und ihre SHA-256-Prüfsumme wird verifiziert, bevor irgendetwas installiert wird.',

  'admin.plugins.fromManifest': 'Aus einem Manifest',
  'admin.plugins.manifestHint':
    'Fügen Sie ein Plugin-Manifest (JSON) ein. Es wird vor der Installation validiert — ungültige oder unsichere Manifeste werden mit Begründung abgelehnt.',
  'admin.plugins.validateInstall': 'Validieren und installieren',

  // ---- the plugin list ----
  'admin.plugins.empty': 'Es sind keine Plugins mitgeliefert.',
  'admin.plugins.statusActive': 'Aktiv',
  'admin.plugins.statusInactive': 'Inaktiv',
  'admin.plugins.kindDeclarative': 'Deklarativ',
  'admin.plugins.kindBundled': 'Mitgeliefert',
  'admin.plugins.byAuthor': 'von {author}',
  'admin.plugins.hooks': 'Hooks: {hooks}',
  'admin.plugins.noHooks': 'keine',
  'admin.plugins.capabilities': 'Fähigkeiten: {list}',
  'admin.plugins.source': 'Quelle: {source}',
  'admin.plugins.requires': 'benötigt: {list}',
  'admin.plugins.activate': 'Aktivieren',
  'admin.plugins.deactivate': 'Deaktivieren',
  'admin.plugins.uninstall': 'Deinstallieren',
  'admin.plugins.uninstallTitle': 'Dieses deklarative Plugin deinstallieren',

  // ---- browser-side (window.t: no plurals) ----
  'admin.plugins.toggleFailed': 'Das Umschalten des Plugins ist fehlgeschlagen',
  'admin.plugins.uninstallConfirm':
    '„{name}“ deinstallieren?\n\nSeine Inhaltstypen werden nicht mehr ausgeliefert und alle von ihm erstellten Webhooks werden gelöscht. Vorhandene Datensätze werden NICHT gelöscht.',
  'admin.plugins.uninstallFailed': 'Die Deinstallation des Plugins ist fehlgeschlagen',
  'admin.plugins.pasteFirst': 'Fügen Sie zuerst ein Manifest ein.',
  'admin.plugins.invalidJson': 'Kein gültiges JSON: {message}',
  'admin.plugins.installedFlash': '{id} v{version} installiert. Wird neu geladen…',
  'admin.plugins.installFailed': 'Installation fehlgeschlagen',
  'admin.plugins.registryEmpty': 'Die Registry enthält noch keine Plugins.',
  'admin.plugins.install': 'Installieren',
  'admin.plugins.verifying': 'Wird verifiziert…',
  'admin.plugins.fetchManifestFailed': 'Das Manifest konnte nicht abgerufen werden',
  'admin.plugins.loading': 'Wird geladen…',
  'admin.plugins.registryReadFailed': 'Die Registry konnte nicht gelesen werden',
};

export default plugins;
