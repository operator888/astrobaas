#!/usr/bin/env node
/**
 * Themes from npm (C-168) and child themes (C-170).
 *
 * The marketplace half of C-168 is a curated index, which is somebody's
 * editorial work rather than code. What has to exist here is the INSTALL
 * mechanism: `npm i @someone/theme-x` plus one environment variable.
 *
 * C-170 is the one with sharp edges. A child theme that silently loses its
 * parent's palette, or that renders a blank page when the parent is missing, is
 * worse than no child themes at all — so most of what follows is about the
 * merge rules and the two ways a chain breaks.
 *
 * Run with:  node tests/theme-distribution.test.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadTs, ROOT } from './lib/load.mjs';

const I = await loadTs('src/lib/theme-inherit.ts');
const X = await loadTs('src/themes/external.ts');
const read = (rel) => fs.readFile(path.join(ROOT, rel), 'utf8');
const runtime = await read('src/lib/theme-runtime.ts');
const registry = await read('src/themes/index.ts');
const themeCss = await read('src/pages/theme.css.ts');
const themesScreen = await read('src/pages/admin/themes/index.astro');

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed += 1; } catch (err) { failures.push(`${name}: ${err.message}`); }
}
async function acheck(name, fn) {
  try { await fn(); passed += 1; } catch (err) { failures.push(`${name}: ${err.message}`); }
}
function ok(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, what = '') {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
function code(src) {
  return src.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*(?:\/\/|\s\*).*$/gm, '');
}

/* ═════════════════════════════ C-170 · child themes ══════════════════════ */

const PARENT = {
  id: 'parent', name: 'Parent', version: '1.0.0', author: 'x',
  settings: {
    colors: { primary: '#001', secondary: '#002', text: '#003' },
    typography: { fontFamily: 'Serif', scale: 1.2 },
  },
  components: { Header: 'PARENT_HEADER', Footer: 'PARENT_FOOTER' },
  css: '.parent { color: red }',
  patterns: [{ name: 'hero', html: '<div>parent hero</div>' }, { name: 'cta', html: '<div>cta</div>' }],
};

const CHILD = {
  id: 'child', name: 'Child', version: '1.0.0', author: 'y',
  extends: 'parent',
  settings: { colors: { primary: '#999' } },
  components: { Footer: 'CHILD_FOOTER' },
  css: '.child { color: blue }',
  patterns: [{ name: 'hero', html: '<div>child hero</div>' }],
};

const LOOKUP = (id) => ({ parent: PARENT, child: CHILD }[id]);

check('a theme with no parent is itself, and nothing changes', () => {
  const out = I.resolveInheritance(PARENT, LOOKUP);
  eq(out.ancestry, ['parent']);
  eq(out.problem, undefined);
  eq(out.definition.components, PARENT.components);
});

check('COMPONENTS MERGE PER SLOT — that is the whole feature', () => {
  // A child overriding Footer keeps the parent's Header. Merging wholesale
  // would mean a child theme has to copy every template it did not want to
  // change, which is the copying this exists to end.
  const out = I.resolveInheritance(CHILD, LOOKUP);
  eq(out.definition.components.Header, 'PARENT_HEADER', 'the parent Header was lost');
  eq(out.definition.components.Footer, 'CHILD_FOOTER', 'the child Footer did not win');
});

check('AN OMITTED SLOT INHERITS — it does not erase', () => {
  // `Object.assign` would copy an explicit `undefined` over the parent's
  // component, so a child that lists a slot it does not implement would blank
  // it. That is the shape a theme author hits first, because listing every slot
  // is the natural thing to do.
  const sloppy = { id: 'sloppy', name: 'S', extends: 'parent', components: { Header: undefined, Footer: null } };
  const out = I.resolveInheritance(sloppy, LOOKUP);
  eq(out.definition.components.Header, 'PARENT_HEADER', 'an undefined slot erased the parent\'s');
  eq(out.definition.components.Footer, 'PARENT_FOOTER', 'a null slot erased the parent\'s');
});

check('TOKENS MERGE PER LEAF, not per group', () => {
  // ThemeConfig is nested. A shallow merge lets a child that sets one colour
  // replace the parent's whole palette and blank its type scale — which looks
  // like a theme half-losing its design.
  const out = I.resolveInheritance(CHILD, LOOKUP);
  eq(out.definition.settings.colors.primary, '#999', 'the child colour did not win');
  eq(out.definition.settings.colors.secondary, '#002', 'the parent palette was blanked');
  eq(out.definition.settings.typography.fontFamily, 'Serif', 'the parent typography was blanked');
});

check('CSS is parent first, so a child rule wins by ordinary cascade', () => {
  // Concatenated rather than replaced. A child needing !important to beat its
  // own parent is a design that will be fought rather than used.
  const css = I.resolveInheritance(CHILD, LOOKUP).definition.css;
  ok(css.indexOf('.parent') < css.indexOf('.child'), css);
  ok(css.includes('astrobaas:theme parent') && css.includes('astrobaas:theme child'),
    'the levels are not identifiable in the output');
});

check('patterns are inherited, and a child replaces one by NAME', () => {
  // Losing the parent's patterns would leave the editor's inserter
  // mysteriously shorter after switching to a child theme.
  const patterns = I.resolveInheritance(CHILD, LOOKUP).definition.patterns;
  eq(patterns.length, 2, JSON.stringify(patterns.map((p) => p.name)));
  eq(patterns.find((p) => p.name === 'hero').html, '<div>child hero</div>');
  ok(patterns.some((p) => p.name === 'cta'), 'the parent-only pattern was dropped');
});

check('the result keeps the CHILD\'s identity', () => {
  // It is the theme the operator activated and the name that belongs on the
  // admin screen.
  const def = I.resolveInheritance(CHILD, LOOKUP).definition;
  eq(def.id, 'child');
  eq(def.name, 'Child');
  eq(def.author, 'y');
});

check('a three-level chain resolves root first', () => {
  const grand = { id: 'g', name: 'G', settings: { colors: { primary: '#1', accent: '#a' } }, components: { Header: 'G_H' } };
  const mid = { id: 'm', name: 'M', extends: 'g', settings: { colors: { primary: '#2' } }, components: { Footer: 'M_F' } };
  const leaf = { id: 'l', name: 'L', extends: 'm', settings: { colors: { primary: '#3' } } };
  const out = I.resolveInheritance(leaf, (id) => ({ g: grand, m: mid, l: leaf }[id]));
  eq(out.ancestry, ['g', 'm', 'l']);
  eq(out.definition.settings.colors.primary, '#3', 'the nearest ancestor should not win over the leaf');
  eq(out.definition.settings.colors.accent, '#a', 'the grandparent token was lost');
  eq(out.definition.components.Header, 'G_H');
  eq(out.definition.components.Footer, 'M_F');
});

check('A MISSING PARENT RENDERS THE CHILD, and says exactly what is wrong', () => {
  // The common real failure: a child installed without its parent. A blank page
  // here would be an outage caused by decoration.
  const orphan = { id: 'orphan', name: 'Orphan', extends: 'nowhere', components: { Header: 'O_H' } };
  const out = I.resolveInheritance(orphan, () => undefined);
  eq(out.definition.components.Header, 'O_H', 'the child did not render');
  ok(/not installed/.test(out.problem ?? ''), out.problem);
  ok((out.problem ?? '').includes('nowhere'), `it does not name the missing parent: ${out.problem}`);
});

check('A CYCLE TERMINATES', () => {
  const a = { id: 'a', name: 'A', extends: 'b', components: { Header: 'A_H' } };
  const b = { id: 'b', name: 'B', extends: 'a', components: { Footer: 'B_F' } };
  const out = I.resolveInheritance(a, (id) => ({ a, b }[id]));
  ok(/already in its own ancestry/.test(out.problem ?? ''), out.problem);
  eq(out.definition.components.Header, 'A_H', 'the child did not render');
});

check('a self-reference is a cycle too', () => {
  const self = { id: 's', name: 'S', extends: 's' };
  const out = I.resolveInheritance(self, (id) => (id === 's' ? self : undefined));
  ok(out.problem, 'a theme extending itself was accepted');
  ok(out.definition, 'it rendered nothing');
});

check('the chain is DEPTH-BOUNDED', () => {
  // Not only against cycles: a hundred-deep chain is a mistake, and resolving
  // it on every uncached render is a cost nobody asked for.
  const themes = {};
  for (let i = 0; i <= 20; i += 1) themes[`t${i}`] = { id: `t${i}`, name: `T${i}`, extends: `t${i + 1}` };
  const out = I.resolveInheritance(themes.t0, (id) => themes[id]);
  ok(out.ancestry.length <= I.MAX_THEME_DEPTH, `${out.ancestry.length} levels`);
  ok(/more than/.test(out.problem ?? ''), out.problem);
});

check('a merge cannot reparent the target', () => {
  // A theme definition can come from an external npm package.
  const evil = { id: 'e', name: 'E', extends: 'parent', settings: JSON.parse('{"__proto__":{"polluted":true}}') };
  I.resolveInheritance(evil, LOOKUP);
  ok(({}).polluted === undefined, 'Object.prototype was polluted');
});

check('THE FLATTENED SETTINGS ACTUALLY REACH THE STYLESHEET', () => {
  // The merge had NO RUNTIME EFFECT for its first version: `/theme.css` read
  // the DB row, which is seeded from the theme's OWN settings — so a child that
  // set one colour rendered with no secondary colour, no type scale and no
  // radius. The per-leaf merge this module is built around was dead code.
  ok(/mergeThemeSettings/.test(code(themeCss)), '/theme.css ignores the inherited defaults');
  ok(/resolvedTheme\.definition\?\.settings/.test(code(themeCss)), 'it does not read the flattened definition');
});

check('A THEME WITH NO SETTINGS DOES NOT 500 THE STYLESHEET', () => {
  // The external loader explicitly permits it — a pure child theme that only
  // overrides a component has no tokens of its own — and `lightTokens` is
  // called OUTSIDE the try block, so dereferencing `settings.typography` threw
  // and every page on the site rendered unstyled.
  ok(/settings\.colors \?\?/.test(code(themeCss)), 'colors is dereferenced unguarded');
  ok(/settings\.typography \?\?/.test(code(themeCss)), 'typography is dereferenced unguarded');
});

check('...and does not 500 the screen an operator would use to switch away', () => {
  // ANY unguarded step into settings, anywhere in the file — not just the
  // `c?.` shape in the frontmatter. The narrow version missed three live
  // dereferences in the TEMPLATE (`theme.settings.colors.primary` on the
  // swatches), which 500'd this exact screen for a theme with no settings —
  // a shape the external loader accepts and a sibling check in this same file
  // establishes as supported.
  // `settings`, `colors` and `typography` only. `.style.` and `.layout.` also
  // name DOM properties — `el.style.background` is not a theme dereference, and
  // including them made this check fire on eleven innocent lines.
  const unguarded = [...code(themesScreen).matchAll(
    /\.(settings|colors|typography)\.(?!\?)[a-zA-Z]/g,
  )].map((m) => m[0]);
  ok(unguarded.length === 0,
    `unguarded dereference(s) on the themes screen: ${unguarded.join(', ')}`);
});

check('THE BOOTSTRAP IS A PROMISE, not a boolean', () => {
  // The boolean was set before the first await, so a concurrent request
  // returned into an empty external-theme list, resolved the active theme to
  // nothing, fell back to the stock look — and CACHED it for five seconds with
  // no log, because an unknown id produces no inheritance problem to report.
  ok(/themesBootstrap: Promise<void> \| null/.test(code(registry)), 'the flag is still a boolean');
  ok(!/themesBootstrapped = true/.test(code(registry)), 'the racing assignment is still there');
  ok(/invalidateThemeCache\(\)/.test(code(registry)), 'a resolution cached before the load is never dropped');
});

check('a broken chain keeps the ancestors it DID reach', () => {
  // The docblock used to claim "the child ALONE", which was false — and the
  // real behaviour is the better one: a three-level chain whose grandparent is
  // missing still gets its parent's design.
  const gp = { id: 'gp', name: 'GP', extends: 'gone', components: { Header: 'GP_H' } };
  const kid = { id: 'kid', name: 'Kid', extends: 'gp', components: { Footer: 'K_F' } };
  const out = I.resolveInheritance(kid, (id) => ({ gp, kid }[id]));
  eq(out.definition.components.Header, 'GP_H', 'the reachable ancestor was discarded');
  eq(out.definition.components.Footer, 'K_F');
  ok(out.problem, 'the break was not reported');
});

check('the flattened result SHARES NOTHING with the theme modules', () => {
  // An in-place edit or sort downstream would otherwise corrupt the parent
  // module for the life of the process.
  const out = I.resolveInheritance(CHILD, LOOKUP);
  ok(out.definition.patterns[0] !== PARENT.patterns[0] && out.definition.patterns[0] !== CHILD.patterns[0],
    'a pattern object is shared with a theme module');
  eq(out.definition.patterns.find((p) => p.name === 'cta').html, '<div>cta</div>', 'and it still carries the content');
});

check('THE RUNTIME applies inheritance once, for every consumer', () => {
  // The layout, /theme.css and the editor's inserter all read the resolved
  // theme. A consumer resolving it itself would be the second implementation.
  ok(/resolveInheritance\(own,/.test(code(runtime)), 'the runtime does not flatten the chain');
  ok(/ancestry: inherited\.ancestry/.test(code(runtime)), 'nothing reports the chain');
  ok(/inheritanceProblem/.test(code(runtime)), 'a broken chain is swallowed');
});

/* ═════════════════════════════ C-168 · themes from npm ═══════════════════ */

check('the specifier list is parsed forgivingly', () => {
  eq(X.parseThemeSpecifiers('@a/theme, ./local/theme.mjs ,,'), ['@a/theme', './local/theme.mjs']);
  eq(X.parseThemeSpecifiers(undefined), []);
  eq(X.parseThemeSpecifiers(''), []);
});

check('what counts as a theme', () => {
  ok(X.looksLikeTheme({ id: 'x', name: 'X' }));
  // Tokens are NOT required: a pure child theme that only overrides one
  // component legitimately has none of its own.
  ok(X.looksLikeTheme({ id: 'x', name: 'X', extends: 'parent' }));
  for (const bad of [null, undefined, {}, { id: 'x' }, { name: 'X' }, { id: '', name: 'X' }, 'theme', 42]) {
    ok(!X.looksLikeTheme(bad), JSON.stringify(bad));
  }
});

check('A PACKAGE CANNOT CLAIM A BUILT-IN ID', () => {
  // A package exporting a theme called `default` would silently replace the
  // stock look on every install that loaded it — possibly as a side effect of
  // installing something else from the same package.
  ok(X.themeIdIsReserved('default', ['default', 'editorial', 'marquee']));
  ok(!X.themeIdIsReserved('acme-shop', ['default', 'editorial', 'marquee']));
});

await acheck('nothing configured loads nothing', async () => {
  const out = await X.loadExternalThemes({}, ['default']);
  eq(out.themes, []);
  eq(out.failed, []);
});

await acheck('a module that does not exist FAILS LOUDLY and does not throw', async () => {
  // Boot continues: a shop that will not start sells nothing, which is strictly
  // worse than one that looks wrong.
  const out = await X.loadExternalThemes({ ASTROBAAS_THEMES: '@nope/not-installed' }, ['default']);
  eq(out.themes, []);
  eq(out.failed.length, 1);
  eq(out.failed[0].specifier, '@nope/not-installed');
  ok(out.failed[0].reason.length > 0, 'no reason given');
});

await acheck('a real module loads — object, array and factory', async () => {
  const dir = path.join(ROOT, 'tests', 'fixtures');
  await fs.mkdir(dir, { recursive: true });
  const one = path.join(dir, 'theme-one.mjs');
  const many = path.join(dir, 'theme-many.mjs');
  const factory = path.join(dir, 'theme-factory.mjs');
  await fs.writeFile(one, `export default { id: 'ext-one', name: 'Ext One', css: '.a{}' };\n`);
  await fs.writeFile(many, `export default [{ id: 'ext-a', name: 'A' }, { id: 'ext-b', name: 'B' }];\n`);
  // The factory shape is the one that matters: an external module cannot
  // resolve `astrobaas/core`, so it is handed defineTheme instead.
  await fs.writeFile(factory, `export default (host) => host.defineTheme({ id: 'ext-f', name: 'F' });\n`);
  try {
    const out = await X.loadExternalThemes(
      { ASTROBAAS_THEMES: `./tests/fixtures/theme-one.mjs,./tests/fixtures/theme-many.mjs,./tests/fixtures/theme-factory.mjs` },
      ['default'],
    );
    eq(out.failed, [], JSON.stringify(out.failed));
    eq(out.themes.map((t) => t.id), ['ext-one', 'ext-a', 'ext-b', 'ext-f']);
  } finally {
    await fs.rm(one, { force: true });
    await fs.rm(many, { force: true });
    await fs.rm(factory, { force: true });
  }
});

await acheck('a package claiming a built-in id is refused, with the reason', async () => {
  const dir = path.join(ROOT, 'tests', 'fixtures');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'theme-hijack.mjs');
  await fs.writeFile(file, `export default { id: 'default', name: 'Not The Default' };\n`);
  try {
    const out = await X.loadExternalThemes({ ASTROBAAS_THEMES: './tests/fixtures/theme-hijack.mjs' }, ['default', 'marquee']);
    eq(out.themes, []);
    ok(/built-in/.test(out.failed[0]?.reason ?? ''), JSON.stringify(out.failed));
  } finally {
    await fs.rm(file, { force: true });
  }
});

await acheck('two packages cannot claim one id — whichever loaded last would win silently', async () => {
  const dir = path.join(ROOT, 'tests', 'fixtures');
  await fs.mkdir(dir, { recursive: true });
  const a = path.join(dir, 'theme-dup-a.mjs');
  const b = path.join(dir, 'theme-dup-b.mjs');
  await fs.writeFile(a, `export default { id: 'twin', name: 'A' };\n`);
  await fs.writeFile(b, `export default { id: 'twin', name: 'B' };\n`);
  try {
    const out = await X.loadExternalThemes(
      { ASTROBAAS_THEMES: './tests/fixtures/theme-dup-a.mjs,./tests/fixtures/theme-dup-b.mjs' }, ['default'],
    );
    eq(out.themes.map((t) => t.name), ['A'], 'the second should not have replaced the first');
    ok(/already provided/.test(out.failed[0]?.reason ?? ''), JSON.stringify(out.failed));
  } finally {
    await fs.rm(a, { force: true });
    await fs.rm(b, { force: true });
  }
});

await acheck('an incompatible theme is refused at the door', async () => {
  // Rather than deep at render time, where the symptom is a stack trace instead
  // of a sentence.
  const dir = path.join(ROOT, 'tests', 'fixtures');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'theme-future.mjs');
  await fs.writeFile(file, `export default { id: 'future', name: 'Future', requiresCore: '^99.0.0' };\n`);
  try {
    const out = await X.loadExternalThemes({ ASTROBAAS_THEMES: './tests/fixtures/theme-future.mjs' }, ['default']);
    eq(out.themes, []);
    ok(/requires core/.test(out.failed[0]?.reason ?? ''), JSON.stringify(out.failed));
  } finally {
    await fs.rm(file, { force: true });
  }
});

check('the registry loads external themes and REPORTS failures', () => {
  ok(/loadExternalThemes\(/.test(code(registry)), 'the registry never loads them');
  ok(/console\.error\(/.test(code(registry)), 'a failure is swallowed');
  ok(/allThemes\(\)/.test(code(registry)), 'external themes get no database row, so cannot be activated');
});

check('an external theme is looked up like any other', () => {
  ok(/externalThemes\.find/.test(code(registry)), 'getThemeDefinition only knows bundled themes');
});

if (failures.length) {
  console.error(`\n✗ theme-distribution: ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error(`  · ${f}`);
  process.exit(1);
}
console.log(`✓ theme-distribution: ${passed} passed`);
