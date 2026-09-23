#!/usr/bin/env node
/**
 * Plugin-contributed sections.
 *
 * A plugin can put markup into the editor and CSS onto every public page. Two
 * things must therefore be true, and neither is obvious from reading the happy
 * path:
 *
 *  1. **A plugin cannot reach outside its namespace.** Not with a class (it
 *     would inherit core styling it does not control, and break when that
 *     section changes), and not with a CSS selector (`body { display:none }`
 *     shipped from a manifest is a defacement primitive).
 *  2. **A template that the sanitizer would rewrite is refused at install.**
 *     Not warned about — refused. A section that renders in the editor and
 *     loses part of itself on save is the most expensive kind of broken,
 *     because the author finds out on a published page.
 *
 * So most of what follows asserts REJECTION. Each rejection test is written
 * against markup that genuinely fails, because a rejection test that never sees
 * one proves nothing.
 *
 * Run with:  node tests/plugin-sections.test.mjs
 */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const cacheDir = path.join(root, 'node_modules', '.cache');
await fs.mkdir(cacheDir, { recursive: true });

async function load(rel, name) {
  const out = path.join(cacheDir, `astrobaas-${name}-${process.pid}.mjs`);
  await build({
    entryPoints: [path.join(root, rel)],
    bundle: true, format: 'esm', platform: 'node', packages: 'external',
    outfile: out, logLevel: 'silent',
  });
  const mod = await import(pathToFileURL(out).href);
  await fs.rm(out, { force: true });
  return mod;
}

const { validateManifest } = await load('src/core/manifest.ts', 'manifest-sections-core');
const { checkManifestSections, installedSections, manifestSectionCss } =
  await load('src/lib/manifest-sections.ts', 'manifest-sections-lib');
const { sanitizeHtml } = await load('src/lib/sanitize.ts', 'sanitize-plugin-sections');
const { pluginSectionClass, isPluginSectionClass } =
  await load('src/core/sections.ts', 'sections-plugin');

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) pass++;
  else { fail++; console.error(`✗ ${name}`); }
}

const base = (sections) => ({
  id: 'acme', name: 'Acme', version: '1.0.0',
  capabilities: { sections },
});
const errorsFor = (sections) => validateManifest(base(sections)).errors ?? [];
const okSection = {
  name: 'promo',
  label: 'Promo',
  description: 'A promo band.',
  template: '<div class="ab-x-acme-promo"><h3>Promo</h3><p>Copy.</p></div>',
};

/* ---------------- the namespace holds ---------------- */
{
  check('the host derives the class; the plugin does not choose it',
    pluginSectionClass('acme', 'promo') === 'ab-x-acme-promo');
  check('a namespaced class is recognised', isPluginSectionClass('ab-x-acme-promo'));
  check('a core class is not in the plugin namespace', !isPluginSectionClass('ab-hero'));
  check('a bare prefix is not a valid plugin class', !isPluginSectionClass('ab-x-acme'));
  check('uppercase is refused (it would reach CSS)', !isPluginSectionClass('ab-x-Acme-promo'));
  check('punctuation is refused', !isPluginSectionClass('ab-x-acme-pro_mo'));

  const valid = validateManifest(base([okSection]));
  check('a well-formed plugin section validates', valid.ok === true);

  // Reusing a core class would inherit styling the plugin does not control.
  check('a plugin may not use a core section class',
    errorsFor([{ ...okSection, template: '<div class="ab-x-acme-promo"><div class="ab-hero">x</div></div>' }])
      .some((e) => e.includes('ab-hero')));
  // Nor another plugin's.
  check('a plugin may not use another plugin\'s class',
    errorsFor([{ ...okSection, template: '<div class="ab-x-acme-promo"><div class="ab-x-other-thing">x</div></div>' }])
      .some((e) => e.includes('ab-x-other-thing')));
  check('the template must carry its own root class',
    errorsFor([{ ...okSection, template: '<div class="ab-x-acme-something-else">x</div>' }])
      .some((e) => e.includes('root class')));
  check('a non-kebab section name is refused',
    errorsFor([{ ...okSection, name: 'Promo Band' }]).some((e) => e.includes('kebab-case')));
  check('a duplicate section name is refused',
    errorsFor([okSection, okSection]).some((e) => e.includes('twice')));
  check('a missing template is refused',
    errorsFor([{ name: 'x1', label: 'X' }]).some((e) => e.includes('template is required')));
}

/* ---------------- CSS cannot escape the namespace ---------------- */
{
  const withCss = (css) => errorsFor([{ ...okSection, css }]);

  check('a selector scoped to the plugin is accepted',
    withCss('.ab-x-acme-promo { padding: 1rem; }').length === 0);
  check('a descendant selector under the namespace is accepted',
    withCss('.ab-x-acme-promo h3 { margin: 0; }').length === 0);
  check('a scoped selector inside @media is accepted',
    withCss('@media (max-width: 40rem) { .ab-x-acme-promo { padding: 0; } }').length === 0);

  // The defacement cases.
  check('a bare element selector is refused',
    withCss('body { display: none; }').some((e) => e.includes('body')));
  check('a universal selector is refused',
    withCss('* { color: red; }').some((e) => e.includes('*')));
  check('a core section selector is refused',
    withCss('.ab-hero { display: none; }').some((e) => e.includes('.ab-hero')));
  check('an unscoped selector hidden inside @media is still refused',
    withCss('@media screen { body { display: none; } }').some((e) => e.includes('body')));
  check('one unscoped selector in a group is refused',
    withCss('.ab-x-acme-promo, body { color: red; }').some((e) => e.includes('body')));
  check('@font-face is refused (it defines a name rather than matching)',
    withCss('@font-face { font-family: x; src: url(/x.woff2); }').some((e) => e.includes('@font-face')));
  check('a comment cannot smuggle an unscoped selector past the scanner',
    withCss('/* .ab-x-acme-promo { */ body { display:none } /* } */').some((e) => e.includes('body')));
}

/* ---------------- the install-time sanitizer round trip ---------------- */
{
  check('a clean section passes the round-trip check',
    checkManifestSections('acme', [okSection]).length === 0);
  check('no sections is not an error', checkManifestSections('acme', undefined).length === 0);

  // A template using a tag the content sanitizer does not allow. It validates
  // on shape — every class is namespaced — and only the round trip catches it.
  const iframed = {
    ...okSection,
    template: '<div class="ab-x-acme-promo"><iframe src="https://example.com"></iframe></div>',
  };
  check('shape validation alone does not catch a stripped tag',
    validateManifest(base([iframed])).ok === true);
  const rejected = checkManifestSections('acme', [iframed]);
  check('...but the round trip does', rejected.length === 1);
  check('the rejection names the section', rejected[0]?.section === 'promo');
  check('the rejection carries what was submitted', rejected[0]?.submitted === iframed.template);
  check('...and what the sanitizer returned, so the author can see the diff',
    rejected[0]?.sanitized === sanitizeHtml(iframed.template)
    && rejected[0].sanitized !== rejected[0].submitted);
  check('...and the reason explains the consequence, not just the fact',
    /discarded|survive/.test(rejected[0]?.reason ?? ''));

  const emptied = { ...okSection, name: 'gone', template: '<style class="ab-x-acme-gone">x</style>' };
  check('a template that sanitizes to nothing is refused',
    checkManifestSections('acme', [emptied]).length === 1);

  // CSS that the stylesheet filter would alter is refused rather than silently
  // rewritten, so what is stored is what was reviewed.
  const importer = { ...okSection, css: '@import url(//evil.test/x.css); .ab-x-acme-promo{color:red}' };
  check('CSS containing @import is refused at install',
    checkManifestSections('acme', [importer]).some((r) => r.reason.includes('@import')));
}

/* ---------------- what reaches the editor and the page ---------------- */
{
  const manifest = {
    id: 'acme', name: 'Acme', version: '1.0.0',
    capabilities: {
      sections: [
        { ...okSection, css: '.ab-x-acme-promo { padding: 1rem; }' },
        { name: 'band', label: 'Band', template: '<div class="ab-x-acme-band"><p>x</p></div>' },
      ],
    },
  };

  const list = installedSections(manifest);
  check('every declared section reaches the editor', list.length === 2);
  check('the class is the host-derived one', list[0].className === 'ab-x-acme-promo');
  check('a section with no description gets an empty one, not undefined',
    list[1].description === '');
  check('the origin travels with it', list.every((s) => s.pluginId === 'acme'));

  const css = manifestSectionCss(manifest);
  check('declared section CSS is served', css.includes('.ab-x-acme-promo'));
  check('a section with no CSS contributes none', !css.includes('ab-x-acme-band'));
  check('the served CSS is labelled with its origin', css.includes('acme: promo'));

  // Re-checked at serve time, not trusted from install: a row can be edited in
  // the database, and an older build validated by older rules.
  const tampered = {
    id: 'acme', name: 'Acme', version: '1.0.0',
    capabilities: { sections: [{ ...okSection, css: 'body { display: none; }' }] },
  };
  check('CSS that is not scoped to the plugin is dropped at serve time',
    !manifestSectionCss(tampered).includes('body'));
}

/* ---------------- content survives an uninstall ---------------- */
{
  // The reason the sanitizer matches the namespace by SHAPE rather than by
  // looking up installed plugins: saving a page while a plugin is disabled must
  // not strip that plugin's sections out of it permanently.
  const inContent = '<div class="ab-x-acme-promo"><p>Written while installed.</p></div>';
  check('a plugin section class survives sanitization with no plugin installed',
    sanitizeHtml(inContent) === inContent);
  check('a malformed lookalike is still dropped',
    sanitizeHtml('<div class="ab-x-evil">x</div>') === '<div>x</div>');
  check('an arbitrary class is still dropped',
    sanitizeHtml('<div class="fixed inset-0">x</div>') === '<div>x</div>');
}


/* ---- section variants (modifiers) ---- */
{
  const withMods = (modifiers) => ({
    id: 'acme', name: 'Acme', version: '1.0.0',
    capabilities: {
      sections: [{
        name: 'promo', label: 'Promo',
        template: '<div class="ab-x-acme-promo">Hi</div>',
        ...(modifiers !== undefined ? { modifiers } : {}),
      }],
    },
  });

  check('a section may declare no variants at all', validateManifest(withMods(undefined)).ok);
  check('a well-formed variant set is accepted',
    validateManifest(withMods({ tone: ['light', 'dark'] })).ok);

  const bad = (mods) => validateManifest(withMods(mods)).ok === false;
  check('a variant group name must be kebab-case', bad({ 'Tone!': ['a'] }));
  check('a variant value must be kebab-case', bad({ tone: ['Light Blue'] }));
  check('a trailing hyphen is refused (the sanitizer would strip the class)', bad({ tone: ['dark-'] }));
  check('a doubled hyphen is refused', bad({ 'to--ne': ['dark'] }));
  check('a leading hyphen is refused', bad({ tone: ['-dark'] }));
  check('an empty value list is refused', bad({ tone: [] }));
  check('a non-array value list is refused', bad({ tone: 'light' }));
  check('too many groups are refused',
    bad(Object.fromEntries(['a','b','c','d','e','f','g'].map((k) => [k, ['x']]))));
  check('too many values are refused',
    bad({ tone: Array.from({ length: 13 }, (_, i) => `v${i}`) }));
  check('a value that could smuggle a selector is refused', bad({ tone: ['a b'] }));

  // The one with teeth. Core turns { align: ['center'] } into
  // `ab-align-center`, which core CSS styles. A plugin declaring the same
  // group must produce its OWN class, or it inherits styling it does not
  // control — the thing the whole plugin-CSS namespace exists to prevent.
  const installed = installedSections(withMods({ align: ['center'] }));
  check('the declared variants reach the editor', 
    JSON.stringify(installed[0].modifiers) === JSON.stringify({ align: ['center'] }));
  check('a plugin modifier is namespaced to the plugin',
    installed[0].modifierPrefix === 'ab-x-acme-');
  // The real property: the composed class starts with the plugin's own
  // namespace and therefore CANNOT equal a core class. Assert the negative
  // directly rather than restating the prefix.
  check('...so a composed plugin modifier is never a core class',
    `${installed[0].modifierPrefix}align-center`.startsWith('ab-x-acme-')
    && `${installed[0].modifierPrefix}align-center` !== 'ab-align-center');
  check('...and it sits under the same prefix as the section itself',
    installed[0].className.startsWith(installed[0].modifierPrefix));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);