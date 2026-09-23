/**
 * Sections — the "blocks" vocabulary, expressed as CSS classes.
 *
 * ## Why classes and not a block tree
 *
 * A block editor normally stores a JSON tree and renders `content` from it.
 * That was rejected here for one decisive reason: a live headless storefront
 * reads `Post.content` as HTML over the API. Making `content` a projection of a
 * `blocks` field puts a brand-new renderer upstream of a production shop, and
 * re-creates the exact failure this codebase already had — a derived value
 * stored under the source-of-truth key.
 *
 * WordPress's own block format is not available either: its blocks are HTML
 * comments, and `sanitize-html` deletes comments. Adopting the format would
 * mean deleting a shipped XSS test.
 *
 * So a section is **an allow-listed class on an already-allow-listed tag**.
 * `Post.content` stays a sanitized HTML string, byte-for-byte what the author
 * typed. Nothing downstream changes: revisions, autosave, search, RSS, the MCP
 * tools, the SDK and the OpenAPI contract all still see `content: string`.
 *
 * The trade is real and worth stating: a theme can RESTYLE a section but cannot
 * RESTRUCTURE it, because there is no tree to walk. One root class per section
 * keeps a mechanical `ab-hero → {type:'hero'}` parse available if that day ever
 * comes.
 *
 * ## Why the templates are literals
 *
 * Void elements are written self-closed (`<img … />`) because that is the form
 * `sanitize-html` normalises to. A template that does not match the sanitizer's
 * output is not wrong, but it means what the author inserted is not quite what
 * gets stored — and the test that guards this vocabulary asserts an exact
 * round trip, which is the property worth having.
 *
 * `template` is a build-time constant. Nothing interpolates into it, so a
 * section can never carry executable content or operator data. The inserter
 * pastes it with `execCommand('insertHTML', …)`, which does not evaluate
 * scripts, and the sanitizer would strip one anyway.
 *
 * ## The prefix is permanent
 *
 * `ab-` ends up in stored HTML on live sites. Renaming it later breaks real
 * content, so it is fixed. Anything a plugin contributes is namespaced further
 * (`ab-x-<pluginId>-*`) so a third party cannot shadow a core section.
 */

/** Modifier group: a control name → the suffixes it may take. */
export type SectionModifiers = Record<string, readonly string[]>;

export interface SectionDef {
  /** Root class is `ab-${name}`. Lowercase, hyphenated. */
  name: string;
  /** Shown in the inserter. */
  label: string;
  /** One line explaining when to reach for it. */
  description: string;
  /**
   * Optional variants, rendered as a `<select>` in the editor.
   * `{ cols: ['2','3','4'] }` produces the classes `ab-cols-2|3|4`.
   */
  modifiers?: SectionModifiers;
  /**
   * Child classes this section legitimately contains, e.g. `ab-col`.
   *
   * Structure is NOT enforced — a string-to-string pass cannot know ancestry.
   * It does not need to: `sections.css` scopes every part to its parent
   * (`.ab-columns > .ab-col`), so an orphaned part is an unstyled `<div>`
   * rather than broken layout. Degrading to plain readable content is the
   * whole point of building on classes.
   */
  parts?: readonly string[];
  /** Build-time literal. Never interpolated. */
  template: string;
}

/**
 * Bump when the vocabulary changes in a way a stored document would notice.
 * Adding a section is additive and does not need a bump; removing or renaming
 * one does, because live posts already contain the class.
 */
// Bumped when the vocabulary GAINS or LOSES a class: a theme compiled against
// version 1 has no styles for `ab-table` or `ab-video`, and a version that
// never moves cannot tell it so.
export const SECTION_VOCAB_VERSION = 2;

/** The `ab-` prefix, in one place so the allow-list and the inserter agree. */
export const SECTION_PREFIX = 'ab-';

/**
 * Namespace for sections contributed by an installed plugin.
 *
 * `ab-x-<pluginId>-<name>`. The `x` marks "extension" and makes the namespace
 * unmistakable in stored HTML, and the plugin id in the middle means two
 * plugins cannot collide with each other, nor can either shadow a core section.
 */
export const SECTION_PLUGIN_PREFIX = 'ab-x-';

/** Ids and section names are kebab-case, so the whole class is one token. */
const PLUGIN_SECTION_RE = /^ab-x-[a-z][a-z0-9]*(-[a-z0-9]+)+$/;

/** The class a plugin's section is addressed by. */
export const pluginSectionClass = (pluginId: string, name: string): string =>
  `${SECTION_PLUGIN_PREFIX}${pluginId}-${name}`;

/**
 * Whether a class belongs to the plugin section namespace.
 *
 * Deliberately a shape test rather than a lookup of installed plugins. The
 * sanitizer runs on every save, and content must not change meaning because a
 * plugin happens to be disabled at that moment: uninstalling a plugin should
 * leave its sections as unstyled but intact markup — the same degradation core
 * sections already rely on — not silently strip them from every page that used
 * them the next time anyone hits save.
 */
export const isPluginSectionClass = (cls: string): boolean => PLUGIN_SECTION_RE.test(cls);

/**
 * Selector prefix a plugin's section CSS is confined to.
 *
 * A plugin ships CSS for its own sections; without this it could ship
 * `body { display:none }` or restyle the admin. Confining every selector to
 * the plugin's own namespace makes its blast radius exactly the markup it
 * contributed.
 */
export const pluginSectionSelectorPrefix = (pluginId: string): string =>
  `.${SECTION_PLUGIN_PREFIX}${pluginId}-`;

/**
 * The prefix a PLUGIN's modifier classes are built from.
 *
 * Core's own sections turn `{ align: ['center'] }` into `ab-align-center`. A
 * plugin declaring the same group must not produce that class: it is core's,
 * it carries core's styling, and the entire plugin-CSS model rests on a
 * plugin's classes living under its own namespace. So a plugin's modifier is
 * `ab-x-<pluginId>-<group>-<value>`, which its own stylesheet is already
 * allowed to target and no other plugin's is.
 */
export const pluginModifierPrefix = (pluginId: string): string =>
  `${SECTION_PLUGIN_PREFIX}${pluginId}-`;

export const SECTIONS: readonly SectionDef[] = [
  {
    name: 'hero',
    label: 'Hero',
    description: 'A headline, a sentence, and a call to action.',
    modifiers: { align: ['left', 'center'] },
    template:
      '<div class="ab-hero ab-align-center">'
      + '<h2>Headline</h2>'
      + '<p>One sentence about what this page is for.</p>'
      + '<p><a class="ab-btn ab-btn-primary" href="/">Get started</a></p>'
      + '</div>',
  },
  {
    name: 'columns',
    label: 'Columns',
    description: 'Two to four side-by-side blocks that stack on a phone.',
    modifiers: { cols: ['2', '3', '4'] },
    parts: ['ab-col'],
    template:
      '<div class="ab-columns ab-cols-2">'
      + '<div class="ab-col"><h3>First</h3><p>Something short.</p></div>'
      + '<div class="ab-col"><h3>Second</h3><p>Something short.</p></div>'
      + '</div>',
  },
  {
    name: 'card',
    label: 'Card',
    description: 'A bordered panel for one idea.',
    template:
      '<div class="ab-card"><h3>Title</h3><p>Body copy.</p></div>',
  },
  {
    name: 'cta',
    label: 'Call to action',
    description: 'A full-width band that asks for one thing.',
    template:
      '<div class="ab-cta">'
      + '<h3>Ready when you are</h3>'
      + '<p><a class="ab-btn ab-btn-primary" href="/contact">Get in touch</a></p>'
      + '</div>',
  },
  {
    name: 'note',
    label: 'Note',
    description: 'A highlighted aside — information, warning, or success.',
    modifiers: { tone: ['info', 'warn', 'success'] },
    template: '<div class="ab-note ab-note-info"><p>Worth knowing.</p></div>',
  },
  {
    name: 'media',
    label: 'Media + text',
    description: 'An image beside a paragraph.',
    modifiers: { side: ['left', 'right'] },
    template:
      '<div class="ab-media ab-media-left">'
      + '<figure><img src="/default-cover.svg" alt="" /><figcaption>Caption</figcaption></figure>'
      + '<div><h3>About this</h3><p>Body copy.</p></div>'
      + '</div>',
  },
  {
    name: 'gallery',
    label: 'Gallery',
    description: 'A responsive grid of images.',
    parts: ['ab-gallery-item'],
    template:
      '<div class="ab-gallery">'
      + '<figure class="ab-gallery-item"><img src="/default-cover.svg" alt="" /></figure>'
      + '<figure class="ab-gallery-item"><img src="/default-cover.svg" alt="" /></figure>'
      + '</div>',
  },
  {
    name: 'spacer',
    label: 'Spacer',
    description: 'Vertical breathing room between sections.',
    modifiers: { size: ['sm', 'md', 'lg'] },
    template: '<div class="ab-spacer ab-spacer-md"></div>',
  },
  {
    // Tables already survived the sanitizer; what was missing was a way to get
    // one INTO a post without writing HTML. `caption`, `thead` and `scope` are
    // in the template because a table with none of them is a grid of numbers
    // no screen reader can navigate — and an author who starts from a correct
    // one usually keeps it correct.
    name: 'table',
    label: 'Table',
    description: 'Rows and columns, with a caption and a header row.',
    modifiers: { style: ['plain', 'striped'] },
    template:
      '<figure class="ab-table ab-table-plain">'
      + '<table>'
      + '<caption>What this table shows</caption>'
      + '<thead><tr><th scope="col">Item</th><th scope="col">Detail</th></tr></thead>'
      + '<tbody>'
      + '<tr><td>First</td><td>Something</td></tr>'
      + '<tr><td>Second</td><td>Something else</td></tr>'
      + '</tbody>'
      + '</table>'
      + '</figure>',
  },
  {
    // A LINK to a video, never an embedded player (C-64).
    //
    // This CMS does not host video and does not embed a third party's player:
    // the ingester refuses every video file by magic-byte sniff, and `iframe`
    // is absent from the sanitizer's allow-list, which is what keeps the CSP
    // intact. So the honest thing is a poster frame that links out — the
    // reader sees what the video is, and clicks through to whoever hosts it.
    name: 'video',
    label: 'Video link',
    description: 'A poster frame that links to a video hosted elsewhere.',
    modifiers: { ratio: ['16x9', '4x3'] },
    template:
      '<figure class="ab-video ab-video-16x9">'
      + '<a href="https://"><img src="/default-cover.svg" alt="" /></a>'
      + '<figcaption>What this video shows, and where it is hosted.</figcaption>'
      + '</figure>',
  },
];

/**
 * Every class this vocabulary can legitimately produce.
 *
 * The sanitizer's allow-list is generated from this rather than hand-written,
 * so a section cannot be added to the palette and then silently stripped on
 * save. That specific mismatch — the editor emitting something the sanitizer
 * removes — has already shipped once here, as the alignment buttons.
 */
export function sectionClassList(): string[] {
  const classes = new Set<string>();

  // Alignment is shared rather than owned by one section: the toolbar's
  // alignment buttons emit it on any block.
  for (const a of ['left', 'center', 'right']) classes.add(`ab-text-${a}`);
  // Buttons are shared too — a hero, a CTA and hand-written content all use them.
  classes.add('ab-btn');
  for (const v of ['primary', 'secondary', 'ghost']) classes.add(`ab-btn-${v}`);

  for (const s of SECTIONS) {
    classes.add(`ab-${s.name}`);
    for (const p of s.parts ?? []) classes.add(p);
    for (const values of Object.values(s.modifiers ?? {})) {
      for (const v of values) {
        // `align` is expressed with the shared ab-align-* names; every other
        // group is namespaced by its own key to avoid collisions.
        classes.add(`ab-${s.name}-${v}`);
      }
    }
    // The generic modifier forms the templates actually use.
    for (const [group, values] of Object.entries(s.modifiers ?? {})) {
      for (const v of values) classes.add(`ab-${group}-${v}`);
    }
  }
  for (const a of ['left', 'center', 'right']) classes.add(`ab-align-${a}`);

  return [...classes].sort();
}

/** Look a section up by name. */
export const getSection = (name: string): SectionDef | undefined =>
  SECTIONS.find((s) => s.name === name);
