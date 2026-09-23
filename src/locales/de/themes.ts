/**
 * de — admin.themes.*
 *
 * One file per screen. 983 keys in a single module is a file nobody can review
 * and every translator conflicts in; split by surface, a screen's strings live
 * next to each other and two people can work at once.
 *
 * `admin.themes.scale.<group>.*` translates only the LABEL of each enum option;
 * the stored value stays the English enum key from src/lib/theme-tokens.ts.
 */
export const themes = {
  'admin.themes.title': 'Designs',
  'admin.themes.subtitle':
    'Wechseln Sie das aktive Design und passen Sie seine Farben und Typografie an. Änderungen wirken sich sofort auf die öffentliche Website aus.',

  // Install from a manifest
  'admin.themes.installTitle': 'Design installieren',
  'admin.themes.installHelp':
    'Fügen Sie ein Design-Manifest (JSON) ein. Ein Manifest enthält Design-Tokens, ein Stylesheet und Abschnittsmuster — ausschließlich Daten, es lässt sich also ohne neuen Build installieren. Es kann keinen Code ausführen, bestimmt aber das Aussehen jeder Seite: Installieren Sie nur aus Quellen, von denen Sie auch ein Stylesheet übernehmen würden.',
  'admin.themes.install': 'Installieren',

  // Installed list
  'admin.themes.installedTitle': 'Installierte Designs',
  'admin.themes.installedBadge': 'Installiert',
  'admin.themes.activeBadge': 'Aktiv',
  'admin.themes.version': 'Version {version}',
  'admin.themes.byAuthor': 'von {author}',
  'admin.themes.declarativeSummary':
    'Installiertes Design — {parts}. Verwendet die integrierten Vorlagen.',
  'admin.themes.partTokens': 'Tokens',
  'admin.themes.partStylesheet': 'Stylesheet',
  'admin.themes.partPatterns_one': '{count} Muster',
  'admin.themes.partPatterns_other': '{count} Muster',
  'admin.themes.tokensOnly': 'Nur Design-Tokens — verwendet die integrierten Vorlagen.',
  'admin.themes.overridesCount': 'Überschreibt {count} von {total} Vorlagen:',
  'admin.themes.activate': 'Aktivieren',
  'admin.themes.uninstall': 'Deinstallieren',

  // Customizer
  'admin.themes.customizeHeading': 'Anpassen: {name}',
  'admin.themes.siteIdentity': 'Website-Identität',
  'admin.themes.siteTitle': 'Website-Titel',
  'admin.themes.tagline': 'Slogan',
  'admin.themes.colors': 'Farben',
  'admin.themes.colorPrimary': 'Primärfarbe',
  'admin.themes.colorSecondary': 'Sekundärfarbe',
  'admin.themes.colorAccent': 'Akzentfarbe',
  'admin.themes.colorBackground': 'Hintergrundfarbe',
  'admin.themes.colorText': 'Textfarbe',
  'admin.themes.typography': 'Typografie',
  'admin.themes.headingFont': 'Schriftart für Überschriften',
  'admin.themes.bodyFont': 'Schriftart für Fließtext',
  'admin.themes.presets': 'Voreinstellungen',
  'admin.themes.presetsHelp':
    'Wendet Farben, Typografie, Formen und Abstände gemeinsam an. Zum Behalten speichern.',
  'admin.themes.baseFontSize': 'Basisschriftgröße',
  'admin.themes.colorSchemeHelp':
    '"auto" folgt dem Gerät der Besucherin oder des Besuchers und zeigt einen Umschalter im Kopfbereich.',

  // Style scales — labels
  'admin.themes.scale.typeScale.label': 'Typografische Skala',
  'admin.themes.scale.headingWeight.label': 'Schriftstärke der Überschriften',
  'admin.themes.scale.radius.label': 'Eckenradius',
  'admin.themes.scale.density.label': 'Abstände',
  'admin.themes.scale.shadow.label': 'Schatten',
  'admin.themes.scale.containerWidth.label': 'Inhaltsbreite',
  'admin.themes.scale.buttonStyle.label': 'Schaltflächen',
  'admin.themes.scale.headerStyle.label': 'Kopfbereich',
  'admin.themes.scale.colorScheme.label': 'Farbschema',

  // Style scales — options
  'admin.themes.scale.typeScale.compact': 'Kompakt',
  'admin.themes.scale.typeScale.normal': 'Normal',
  'admin.themes.scale.typeScale.spacious': 'Weit',
  'admin.themes.scale.headingWeight.normal': 'Normal',
  'admin.themes.scale.headingWeight.medium': 'Mittel',
  'admin.themes.scale.headingWeight.semibold': 'Halbfett',
  'admin.themes.scale.headingWeight.bold': 'Fett',
  'admin.themes.scale.radius.none': 'Keiner',
  'admin.themes.scale.radius.sm': 'Klein',
  'admin.themes.scale.radius.md': 'Mittel',
  'admin.themes.scale.radius.lg': 'Groß',
  'admin.themes.scale.radius.full': 'Maximal',
  'admin.themes.scale.density.compact': 'Kompakt',
  'admin.themes.scale.density.normal': 'Normal',
  'admin.themes.scale.density.roomy': 'Großzügig',
  'admin.themes.scale.shadow.none': 'Keine',
  'admin.themes.scale.shadow.soft': 'Weich',
  'admin.themes.scale.shadow.strong': 'Kräftig',
  'admin.themes.scale.containerWidth.narrow': 'Schmal',
  'admin.themes.scale.containerWidth.normal': 'Normal',
  'admin.themes.scale.containerWidth.wide': 'Breit',
  'admin.themes.scale.containerWidth.full': 'Volle Breite',
  'admin.themes.scale.buttonStyle.solid': 'Gefüllt',
  'admin.themes.scale.buttonStyle.outline': 'Umrandet',
  'admin.themes.scale.buttonStyle.soft': 'Dezent',
  'admin.themes.scale.buttonStyle.pill': 'Pillenform',
  'admin.themes.scale.headerStyle.minimal': 'Minimal',
  'admin.themes.scale.headerStyle.centered': 'Zentriert',
  'admin.themes.scale.headerStyle.split': 'Geteilt',
  'admin.themes.scale.headerStyle.masthead': 'Titelkopf',
  'admin.themes.scale.colorScheme.light': 'Hell',
  'admin.themes.scale.colorScheme.dark': 'Dunkel',
  'admin.themes.scale.colorScheme.auto': 'Automatisch',

  // Custom CSS
  'admin.themes.customCss': 'Eigenes CSS',
  'admin.themes.customCssHelp':
    'Wird an {file} angehängt und überschreibt damit die Tokens oben. Es wird als Stylesheet ausgeliefert (niemals inline eingebettet), wodurch es unter der strengen Content-Security-Policy weiterhin funktioniert.',
  'admin.themes.customCssLimit': '/{max} Zeichen.',
  'admin.themes.customCssStripped': 'wird entfernt.',

  'admin.themes.save': 'Änderungen speichern',

  // Live preview
  'admin.themes.livePreview': 'Live-Vorschau',
  'admin.themes.previewPostTitle': 'Beispiel-Blogbeitrag',
  'admin.themes.previewBody': 'Diese Vorschau spiegelt Ihre Design-Einstellungen wider.',
  'admin.themes.previewLink': 'Links verwenden die Primärfarbe.',
  'admin.themes.previewPrimary': 'Primär',
  'admin.themes.previewAccent': 'Akzent',

  // Browser-side messages (window.t — no plural support)
  'admin.themes.presetApplied': 'Voreinstellung angewendet — zum Behalten speichern.',
  'admin.themes.saved': 'Gespeichert. Wird neu geladen…',
  'admin.themes.saveFailed': 'Speichern fehlgeschlagen.',
  'admin.themes.activateFailed': 'Aktivierung fehlgeschlagen',
  'admin.themes.manifestRequired': 'Fügen Sie zuerst ein Design-Manifest ein.',
  'admin.themes.invalidJson': 'Das ist kein gültiges JSON: {message}',
  'admin.themes.installed': 'Installiert. Wird neu geladen…',
  'admin.themes.installFailed': 'Installation fehlgeschlagen',
  'admin.themes.installRejected': 'Dieses Design wurde nicht installiert:',
  'admin.themes.patternRejected': 'Muster „{name}“ — {reason}',
  'admin.themes.youWrote': 'Sie haben geschrieben:',
  'admin.themes.sanitizerKeeps': 'Die Bereinigung behält:',
  'admin.themes.uninstallConfirm':
    '„{name}“ deinstallieren? Seine Stile und Muster werden dann nicht mehr angeboten. Ihre Inhalte bleiben unberührt.',
  'admin.themes.uninstallFailed': 'Deinstallation fehlgeschlagen',
};

export default themes;
