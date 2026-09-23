/**
 * en — admin.plugins.*
 *
 * One file per screen. 983 keys in a single module is a file nobody can review
 * and every translator conflicts in; split by surface, a screen's strings live
 * next to each other and two people can work at once.
 *
 * A few strings carry inline <em>/<strong> and are rendered with `set:html`.
 * The emphasis sits mid-sentence and moves when the sentence is reordered, so
 * splitting it out into separate keys would force Greek and German word order
 * to follow English. Tags that carry CLASSES are passed in as parameters
 * ({env}, {module}, {path}, {doc}) instead — class names have no business in a
 * translator's file, and neither does an env var name that must never change.
 */
export const plugins = {
  'admin.plugins.title': 'Plugins',
  'admin.plugins.intro':
    'Enable or disable bundled plugins. {active} of {total} active. Activation persists across restarts.',

  // ---- the two-tier explainer ----
  'admin.plugins.tiersHeading': 'Two tiers.',
  'admin.plugins.tiersBundled':
    '<em>Bundled</em> plugins are trusted TypeScript modules compiled in from {path} — adding one needs a rebuild.',
  'admin.plugins.tiersDeclarative':
    '<em>Declarative</em> plugins are JSON manifests you can install here, right now: they add meta tags, CSS, content types, and webhooks without executing any code.',
  'admin.plugins.tiersDocs': 'See {doc}.',

  // ---- active in the database, but nothing loaded ----
  'admin.plugins.orphanedTitle_one': 'A plugin is switched on but not installed',
  'admin.plugins.orphanedTitle_other': 'Plugins are switched on but not installed',
  'admin.plugins.orphanedBody':
    "These are marked active in this site's database, but no code for them is loaded — so <strong>everything they do is silently not happening</strong>. Orders and content are still being accepted; they are simply not being checked.",
  'admin.plugins.orphanedCause':
    'The usual cause is a deploy that did not install an external module. Install it and name it in {env}, then restart.',
  'admin.plugins.orphanedOptical':
    'For the eyewear vertical that is {module} — until it is back, <strong>prescriptions are not being validated</strong>.',

  // ---- install panel ----
  'admin.plugins.installPanel': 'Install a plugin',
  'admin.plugins.installedCount_one': '{count} installed',
  'admin.plugins.installedCount_other': '{count} installed',
  'admin.plugins.registryAvailable': 'registry available',
  'admin.plugins.registryDisabled': 'registry disabled',

  'admin.plugins.fromRegistry': 'From the curated registry',
  'admin.plugins.browseRegistry': 'Browse registry',
  'admin.plugins.registryHint':
    'Manifests are fetched over HTTPS and their SHA-256 checksum is verified before anything is installed.',

  'admin.plugins.fromManifest': 'From a manifest',
  'admin.plugins.manifestHint':
    'Paste a plugin manifest (JSON). It is validated before install — invalid or unsafe manifests are rejected with reasons.',
  'admin.plugins.validateInstall': 'Validate & install',

  // ---- the plugin list ----
  'admin.plugins.empty': 'No plugins are bundled.',
  'admin.plugins.statusActive': 'Active',
  'admin.plugins.statusInactive': 'Inactive',
  'admin.plugins.kindDeclarative': 'Declarative',
  'admin.plugins.kindBundled': 'Bundled',
  'admin.plugins.byAuthor': 'by {author}',
  'admin.plugins.hooks': 'hooks: {hooks}',
  'admin.plugins.noHooks': 'none',
  'admin.plugins.capabilities': 'capabilities: {list}',
  'admin.plugins.source': 'source: {source}',
  'admin.plugins.requires': 'requires: {list}',
  'admin.plugins.activate': 'Activate',
  'admin.plugins.deactivate': 'Deactivate',
  'admin.plugins.uninstall': 'Uninstall',
  'admin.plugins.uninstallTitle': 'Uninstall this declarative plugin',

  // ---- browser-side (window.t: no plurals) ----
  'admin.plugins.toggleFailed': 'Failed to toggle plugin',
  'admin.plugins.uninstallConfirm':
    'Uninstall "{name}"?\n\nIts content types stop being served and any webhooks it created are deleted. Existing records are NOT deleted.',
  'admin.plugins.uninstallFailed': 'Failed to uninstall plugin',
  'admin.plugins.pasteFirst': 'Paste a manifest first.',
  'admin.plugins.invalidJson': 'Not valid JSON: {message}',
  'admin.plugins.installedFlash': 'Installed {id} v{version}. Reloading…',
  'admin.plugins.installFailed': 'Install failed',
  'admin.plugins.registryEmpty': 'The registry has no plugins yet.',
  'admin.plugins.install': 'Install',
  'admin.plugins.verifying': 'Verifying…',
  'admin.plugins.fetchManifestFailed': 'Could not fetch the manifest',
  'admin.plugins.loading': 'Loading…',
  'admin.plugins.registryReadFailed': 'Could not read the registry',
};

export default plugins;
