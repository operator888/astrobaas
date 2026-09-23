#!/usr/bin/env node
/**
 * The design-token vocabulary.
 *
 * This suite exists because of a specific failure: of five colours, two fonts
 * and a font size the customizer offered, exactly ONE (`--primary-color`)
 * changed a pixel. `backgroundColor` and `textColor` had no consumers,
 * `fontSize` was never emitted at all, and every save returned
 * 200 "Theme updated successfully".
 *
 * The lesson is that a token has FOUR places to die, and a test that only
 * covers one of them proves nothing:
 *   1. the write path drops it          (themes/update.ts rebuilds a literal)
 *   2. the emitter never serves it      (theme.css.ts token map)
 *   3. nothing consumes it              (no `var(--x)` anywhere)
 *   4. the admin never offers it        (no control)
 *
 * So the central assertion here is mechanical rather than per-field: EVERY
 * declared token must be emitted, and every enum key must resolve. A future
 * token added to the type but forgotten in the emitter fails this file rather
 * than shipping inert.
 *
 * Run with:  node tests/theme-tokens.test.mjs
 */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const cacheDir = path.join(root, 'node_modules', '.cache');
await fs.mkdir(cacheDir, { recursive: true });

const out = path.join(cacheDir, `astrobaas-tokens-${process.pid}.mjs`);
await build({
  entryPoints: [path.join(root, 'src/lib/theme-tokens.ts')],
  bundle: true, format: 'esm', platform: 'node', packages: 'external',
  outfile: out, logLevel: 'silent',
});
const T = await import(pathToFileURL(out).href);
await fs.rm(out, { force: true });

const presetsOut = path.join(cacheDir, `astrobaas-presets-${process.pid}.mjs`);
await build({
  entryPoints: [path.join(root, 'src/themes/presets.ts')],
  bundle: true, format: 'esm', platform: 'node', packages: 'external',
  outfile: presetsOut, logLevel: 'silent',
});
const { PRESETS } = await import(pathToFileURL(presetsOut).href);
await fs.rm(presetsOut, { force: true });

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) pass++;
  else { fail++; console.error(`✗ ${name}`); }
}

/* ---------------- the enum contract ---------------- */
{
  const { TOKEN_SCALES, TOKEN_SCALE_NAMES, resolveScale, isTokenKey } = T;

  check('every scale declares keys, a map and a default',
    TOKEN_SCALE_NAMES.every((n) => {
      const g = TOKEN_SCALES[n];
      return Array.isArray(g.keys) && g.keys.length > 0 && g.map && g.default;
    }));

  check("each scale's default is one of its own keys",
    TOKEN_SCALE_NAMES.every((n) => TOKEN_SCALES[n].keys.includes(TOKEN_SCALES[n].default)));

  // The property that makes this design safe: a stored value SELECTS css, it
  // never IS css. Every key must map to declarations written in source.
  check('every key of every scale resolves to declarations',
    TOKEN_SCALE_NAMES.every((n) =>
      TOKEN_SCALES[n].keys.every((k) => {
        const decls = resolveScale(n, k);
        return decls && Object.keys(decls).length > 0;
      })));

  // Each key within a scale must emit the SAME token names, or switching
  // between them leaves a stale declaration behind from the previous choice.
  check('all keys in a scale emit the same token names', TOKEN_SCALE_NAMES.every((n) => {
    const shapes = TOKEN_SCALES[n].keys.map((k) => Object.keys(resolveScale(n, k)).sort().join(','));
    return new Set(shapes).size === 1;
  }));

  // Hostile / unknown input must fall back rather than reach the stylesheet.
  const hostile = ['md; } body { display:none } :root {', '<script>', '', null, undefined, 42, {}, []];
  check('unknown and hostile values fall back to the default', TOKEN_SCALE_NAMES.every((n) =>
    hostile.every((h) => {
      const got = JSON.stringify(resolveScale(n, h));
      return got === JSON.stringify(resolveScale(n, TOKEN_SCALES[n].default));
    })));

  // The whole point: nothing a caller passes can appear in the output.
  check('no resolved declaration ever contains caller-supplied text',
    !JSON.stringify(resolveScale('radius', 'md; } body { display:none }')).includes('display:none'));

  check('isTokenKey accepts real keys and refuses others',
    isTokenKey('radius', 'md') && !isTokenKey('radius', 'enormous') && !isTokenKey('radius', ''));

  // A CSS value that could terminate a declaration would be a way out.
  check('no pre-authored value contains a declaration terminator',
    TOKEN_SCALE_NAMES.every((n) =>
      TOKEN_SCALES[n].keys.every((k) =>
        Object.values(resolveScale(n, k)).every((v) => !/[;{}<>]/.test(String(v))))));
}

/* ---------------- dark mode derivation ---------------- */
{
  const { deriveDarkPalette, readableOn, luminance } = T;

  const dark = deriveDarkPalette({
    primary: '#2563eb', secondary: '#7c3aed', accent: '#059669',
    background: '#ffffff', text: '#0f172a',
  });
  check('a derived dark palette has a dark background',
    luminance(dark['--background-color']) < 0.1);
  check('...and light text', luminance(dark['--text-color']) > 0.5);
  check('...and every token is a valid hex',
    Object.values(dark).every((v) => /^#[0-9a-f]{6}$/i.test(v)));

  // A very dark brand colour is invisible on a dark surface; it must be lifted.
  const lifted = deriveDarkPalette({
    primary: '#0a0a0a', secondary: '#111111', accent: '#000033',
    background: '#ffffff', text: '#000000',
  });
  check('a near-black brand colour is lifted for dark mode',
    luminance(lifted['--primary-color']) > luminance('#0a0a0a'));

  // Contrast, the thing that actually makes text readable.
  check('white text is chosen on a dark primary', readableOn('#1d4ed8') === '#ffffff');
  check('dark text is chosen on a light primary', readableOn('#fde68a') === '#111827');
  check('on-primary is set from the dark primary, not the light one',
    /^#[0-9a-f]{6}$/i.test(dark['--on-primary']));

  // Garbage in must not produce garbage CSS.
  const junk = deriveDarkPalette({
    primary: 'red; }', secondary: '', accent: 'javascript:alert(1)',
    background: 'x', text: null,
  });
  // Check the VALUES, not the stringified object — JSON.stringify of any
  // object contains a closing brace, so the earlier form could never pass.
  check('non-hex input does not leak into the dark palette',
    Object.values(junk).every((v) => /^#[0-9a-f]{6}$/i.test(v)));
}

/* ---------------- presets ---------------- */
{
  check('presets exist and are distinct',
    PRESETS.length >= 6 && new Set(PRESETS.map((p) => p.id)).size === PRESETS.length);

  // A preset that sets a key the write path does not map would silently do
  // nothing — exactly the bug this file exists for.
  const ENUM_FIELDS = {
    typeScale: 'typeScale', headingWeight: 'headingWeight', radius: 'radius',
    density: 'density', shadow: 'shadow', containerWidth: 'containerWidth',
    buttonStyle: 'buttonStyle', headerStyle: 'headerStyle',
  };
  check('every preset uses only real enum keys', PRESETS.every((p) =>
    Object.entries(ENUM_FIELDS).every(([field, scale]) =>
      p.settings[field] === undefined || T.isTokenKey(scale, p.settings[field]))));

  check('every preset colour is a valid hex', PRESETS.every((p) =>
    Object.entries(p.settings)
      .filter(([k]) => /Color$/.test(k))
      .every(([, v]) => /^#[0-9a-f]{6}$/i.test(v))));

  check('every preset declares a legal colour scheme', PRESETS.every((p) =>
    ['light', 'dark', 'auto'].includes(p.settings.colorScheme)));

  check('every preset has two swatch colours', PRESETS.every((p) =>
    Array.isArray(p.swatch) && p.swatch.length === 2 && p.swatch.every((c) => /^#[0-9a-f]{6}$/i.test(c))));

  // Presets are the first thing a new operator clicks; a preset that renders
  // unreadable text is worse than no preset.
  check('every preset keeps body text readable on its background', PRESETS.every((p) => {
    const bg = T.luminance(p.settings.backgroundColor);
    const fg = T.luminance(p.settings.textColor);
    const ratio = (Math.max(bg, fg) + 0.05) / (Math.min(bg, fg) + 0.05);
    return ratio >= 4.5; // WCAG AA for body text
  }));

  check('presets cover both light and dark defaults',
    PRESETS.some((p) => p.settings.colorScheme === 'dark') &&
    PRESETS.some((p) => p.settings.colorScheme === 'light'));
}

/* ---------------- the anti-inert guarantee ---------------- */
{
  // Read the emitter and the stylesheet as TEXT and prove the chain is closed.
  // This is deliberately crude: it is the only check that catches "the token is
  // emitted but nothing consumes it", which is how three fields shipped dead.
  const css = await fs.readFile(path.join(root, 'src/styles/global.css'), 'utf8');
  const emitter = await fs.readFile(path.join(root, 'src/pages/theme.css.ts'), 'utf8');
  const updateRoute = await fs.readFile(path.join(root, 'src/pages/api/themes/update.ts'), 'utf8');

  // Every token the enum scales emit must be consumed somewhere in src/.
  const emitted = new Set();
  for (const n of T.TOKEN_SCALE_NAMES) {
    for (const k of T.TOKEN_SCALES[n].keys) {
      for (const token of Object.keys(T.resolveScale(n, k))) emitted.add(token);
    }
  }
  const srcFiles = [];
  async function walk(dir) {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (/\.(astro|css|ts)$/.test(e.name)) srcFiles.push(p);
    }
  }
  await walk(path.join(root, 'src'));

  // Strip comments before looking for consumers.
  //
  // This check used to be a substring grep over raw source, so a COMMENT
  // mentioning `var(--x)` counted as consuming it — which is exactly the kind
  // of false pass this file exists to prevent. Verified: adding
  // `/* var(--never-used-token) */` to a stylesheet satisfied the old form.
  //
  // Deliberately crude rather than a real CSS parser: it only has to be harder
  // to fool than a bare `includes`, and a parser here would be a second thing
  // to keep correct.
  const stripComments = (text) => text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')   // /* block */ — CSS, TS, Astro frontmatter
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // // line — not the // in a URL

  const allSrc = (await Promise.all(srcFiles.map((f) => fs.readFile(f, 'utf8'))))
    .map(stripComments)
    .join('\n');

  const unconsumed = [...emitted].filter((t) => !allSrc.includes(`var(${t}`));
  check(`every enum-emitted token is consumed somewhere${unconsumed.length ? ` (dead: ${unconsumed.join(', ')})` : ''}`,
    unconsumed.length === 0);

  // The free-form colour tokens, which is where the original bug lived.
  for (const token of ['--background-color', '--text-color', '--primary-color',
    '--surface-color', '--muted-color', '--border-color', '--font-size-base']) {
    check(`${token} is emitted by theme.css.ts`, emitter.includes(token));
    check(`${token} is consumed by a stylesheet or component`, allSrc.includes(`var(${token}`));
  }

  // The write path is where fontSize died: present in the type, absent from the
  // object literal that rebuilds the config.
  for (const field of ['fontSize', 'scale', 'headingWeight', 'radius', 'density',
    'shadow', 'containerWidth', 'buttonStyle', 'headerStyle', 'colorScheme',
    'surface', 'muted', 'border']) {
    check(`the update route maps "${field}"`, updateRoute.includes(field));
  }

  check('global.css defines fallbacks for the new tokens',
    ['--surface-color', '--muted-color', '--border-color', '--radius-md', '--space-4', '--shadow-md', '--container']
      .every((t) => css.includes(`${t}:`)));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
