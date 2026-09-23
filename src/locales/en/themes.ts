/**
 * en — admin.themes.*
 *
 * One file per screen. 983 keys in a single module is a file nobody can review
 * and every translator conflicts in; split by surface, a screen's strings live
 * next to each other and two people can work at once.
 *
 * `admin.themes.scale.<group>.*` mirrors the enum vocabulary in
 * src/lib/theme-tokens.ts: `<group>.label` names the control, and one key per
 * enum KEY names the option. The stored value is the enum key and never this
 * text — the page renders `<option value={key}>{label}</option>` — so a
 * translated option cannot change what gets saved. A key added to
 * theme-tokens.ts with no entry here falls back to showing the raw enum key,
 * which is what the control did before it was translated.
 */
export const themes = {
  'admin.themes.title': 'Themes',
  'admin.themes.subtitle':
    'Switch the active theme and customize its colors and typography. Changes apply to the public site immediately.',

  // Install from a manifest
  'admin.themes.installTitle': 'Install a theme',
  'admin.themes.installHelp':
    'Paste a theme manifest (JSON). A manifest carries design tokens, a stylesheet and section patterns — data only, so it installs without rebuilding. It cannot run code, but it does decide how every page looks: install from sources you would take a stylesheet from.',
  'admin.themes.install': 'Install',

  // Installed list
  'admin.themes.installedTitle': 'Installed Themes',
  'admin.themes.installedBadge': 'Installed',
  'admin.themes.activeBadge': 'Active',
  'admin.themes.version': 'Version {version}',
  'admin.themes.byAuthor': 'by {author}',
  'admin.themes.declarativeSummary': 'Installed theme — {parts}. Uses the built-in templates.',
  'admin.themes.partTokens': 'tokens',
  'admin.themes.partStylesheet': 'stylesheet',
  'admin.themes.partPatterns_one': '{count} pattern',
  'admin.themes.partPatterns_other': '{count} patterns',
  'admin.themes.tokensOnly': 'Design tokens only — uses the built-in templates.',
  'admin.themes.overridesCount': 'Overrides {count} of {total} templates:',
  'admin.themes.activate': 'Activate',
  'admin.themes.uninstall': 'Uninstall',

  // Customizer
  'admin.themes.customizeHeading': 'Customize: {name}',
  'admin.themes.siteIdentity': 'Site Identity',
  'admin.themes.siteTitle': 'Site Title',
  'admin.themes.tagline': 'Tagline',
  'admin.themes.colors': 'Colors',
  'admin.themes.colorPrimary': 'Primary Color',
  'admin.themes.colorSecondary': 'Secondary Color',
  'admin.themes.colorAccent': 'Accent Color',
  'admin.themes.colorBackground': 'Background Color',
  'admin.themes.colorText': 'Text Color',
  'admin.themes.typography': 'Typography',
  'admin.themes.headingFont': 'Heading Font',
  'admin.themes.bodyFont': 'Body Font',
  'admin.themes.presets': 'Presets',
  'admin.themes.presetsHelp': 'Applies colours, type, shape and spacing together. Save to keep it.',
  'admin.themes.baseFontSize': 'Base font size',
  'admin.themes.colorSchemeHelp':
    '"auto" follows the visitor’s device and shows a toggle in the header.',

  // Style scales — labels
  'admin.themes.scale.typeScale.label': 'Type scale',
  'admin.themes.scale.headingWeight.label': 'Heading weight',
  'admin.themes.scale.radius.label': 'Corner radius',
  'admin.themes.scale.density.label': 'Spacing',
  'admin.themes.scale.shadow.label': 'Shadows',
  'admin.themes.scale.containerWidth.label': 'Content width',
  'admin.themes.scale.buttonStyle.label': 'Buttons',
  'admin.themes.scale.headerStyle.label': 'Header',
  'admin.themes.scale.colorScheme.label': 'Colour scheme',

  // Style scales — options
  'admin.themes.scale.typeScale.compact': 'Compact',
  'admin.themes.scale.typeScale.normal': 'Normal',
  'admin.themes.scale.typeScale.spacious': 'Spacious',
  'admin.themes.scale.headingWeight.normal': 'Normal',
  'admin.themes.scale.headingWeight.medium': 'Medium',
  'admin.themes.scale.headingWeight.semibold': 'Semibold',
  'admin.themes.scale.headingWeight.bold': 'Bold',
  'admin.themes.scale.radius.none': 'None',
  'admin.themes.scale.radius.sm': 'Small',
  'admin.themes.scale.radius.md': 'Medium',
  'admin.themes.scale.radius.lg': 'Large',
  'admin.themes.scale.radius.full': 'Maximum',
  'admin.themes.scale.density.compact': 'Compact',
  'admin.themes.scale.density.normal': 'Normal',
  'admin.themes.scale.density.roomy': 'Roomy',
  'admin.themes.scale.shadow.none': 'None',
  'admin.themes.scale.shadow.soft': 'Soft',
  'admin.themes.scale.shadow.strong': 'Strong',
  'admin.themes.scale.containerWidth.narrow': 'Narrow',
  'admin.themes.scale.containerWidth.normal': 'Normal',
  'admin.themes.scale.containerWidth.wide': 'Wide',
  'admin.themes.scale.containerWidth.full': 'Full width',
  'admin.themes.scale.buttonStyle.solid': 'Solid',
  'admin.themes.scale.buttonStyle.outline': 'Outline',
  'admin.themes.scale.buttonStyle.soft': 'Soft',
  'admin.themes.scale.buttonStyle.pill': 'Pill',
  'admin.themes.scale.headerStyle.minimal': 'Minimal',
  'admin.themes.scale.headerStyle.centered': 'Centered',
  'admin.themes.scale.headerStyle.split': 'Split',
  'admin.themes.scale.headerStyle.masthead': 'Masthead',
  'admin.themes.scale.colorScheme.light': 'Light',
  'admin.themes.scale.colorScheme.dark': 'Dark',
  'admin.themes.scale.colorScheme.auto': 'Auto',

  // Custom CSS
  'admin.themes.customCss': 'Custom CSS',
  // `{file}` is a constant <code> element supplied by the page, not user input.
  // One sentence with a placeholder rather than a before/after pair: German puts
  // the verb after the filename and English puts a comma there, and a split
  // string cannot express both.
  'admin.themes.customCssHelp':
    'Appended to {file}, so it overrides the tokens above. Served as a stylesheet (never inlined), which keeps it working under the strict Content-Security-Policy.',
  'admin.themes.customCssLimit': '/{max} characters.',
  'admin.themes.customCssStripped': 'is stripped.',

  'admin.themes.save': 'Save Changes',

  // Live preview
  'admin.themes.livePreview': 'Live Preview',
  'admin.themes.previewPostTitle': 'Sample Blog Post',
  'admin.themes.previewBody': 'This preview reflects your theme settings.',
  'admin.themes.previewLink': 'Links use the primary color.',
  'admin.themes.previewPrimary': 'Primary',
  'admin.themes.previewAccent': 'Accent',

  // Browser-side messages (window.t — no plural support)
  'admin.themes.presetApplied': 'Preset applied — press Save to keep it.',
  'admin.themes.saved': 'Saved. Reloading…',
  'admin.themes.saveFailed': 'Save failed.',
  'admin.themes.activateFailed': 'Activation failed',
  'admin.themes.manifestRequired': 'Paste a theme manifest first.',
  'admin.themes.invalidJson': 'That is not valid JSON: {message}',
  'admin.themes.installed': 'Installed. Reloading…',
  'admin.themes.installFailed': 'Install failed',
  'admin.themes.installRejected': 'This theme was not installed:',
  'admin.themes.patternRejected': 'Pattern “{name}” — {reason}',
  'admin.themes.youWrote': 'You wrote:',
  'admin.themes.sanitizerKeeps': 'The sanitizer keeps:',
  'admin.themes.uninstallConfirm':
    'Uninstall “{name}”? Its styles and patterns stop being offered. Your content is not touched.',
  'admin.themes.uninstallFailed': 'Uninstall failed',
};

export default themes;
