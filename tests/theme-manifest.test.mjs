#!/usr/bin/env node
/**
 * Declarative themes — the runtime-installable tier.
 *
 * A theme manifest is data, so nothing executes. The risk is quieter, and this
 * file is mostly about REJECTION because that is where the risk lives:
 *
 *  1. **A token value that is not a token.** Stored values land in
 *     `/theme.css` as `--primary-color: <value>`. A value carrying `;` or `}`
 *     escapes the declaration and becomes arbitrary CSS — the difference
 *     between a stored value that SELECTS css and one that IS css.
 *  2. **A pattern the sanitizer would rewrite** — the same invariant the whole
 *     sections subsystem rests on.
 *  3. **Shadowing a bundled theme**, which would make the admin list one thing
 *     and the renderer resolve another.
 *
 * Every rejection test is written against input that genuinely fails, because a
 * rejection test that never sees a rejection proves nothing.
 *
 * Run with:  node tests/theme-manifest.test.mjs
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

const { validateThemeManifest } = await load('src/lib/theme-manifest.ts', 'theme-manifest');
const { isDeclarativeTheme, THEME_MANIFEST_LIMITS } =
  await load('src/core/theme-manifest.ts', 'theme-manifest-core');

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) pass++;
  else { fail++; console.error(`✗ ${name}`); }
}

const BASE = { id: 'sunset', name: 'Sunset', version: '1.0.0' };
const v = (extra, opts) => validateThemeManifest({ ...BASE, ...extra }, opts);
const errs = (extra, opts) => v(extra, opts).errors;

/* ---------------- identity ---------------- */
{
  check('a minimal manifest validates', v({}).ok === true);
  check('a non-object is refused', validateThemeManifest('nope').ok === false);
  check('a missing id is refused', validateThemeManifest({ name: 'x', version: '1.0.0' }).ok === false);
  check('a non-kebab id is refused', errs({ id: 'Sun Set' }).some((e) => e.includes('kebab-case')));
  check('a non-semver version is refused', errs({ version: '1.0' }).some((e) => e.includes('semver')));
  check('an empty name is refused', errs({ name: '  ' }).some((e) => e.includes('`name`')));

  // A declarative row claiming a bundled id would make the admin show one theme
  // and the renderer resolve the other.
  check('a manifest may not claim a bundled theme id',
    errs({ id: 'default' }, { reservedIds: ['default', 'editorial'] }).some((e) => e.includes('built-in')));
  check('...but the same id is fine when it is not reserved', v({ id: 'default' }).ok === true);

  check('a non-https homepage is refused', errs({ homepage: 'http://x.test' }).some((e) => e.includes('https')));
  check('a mismatched major API version is refused',
    errs({ astrobaasApi: '^2.0.0' }).some((e) => e.includes('targets v2')));
  check('a matching major is accepted', v({ astrobaasApi: '^1.0.0' }).ok === true);
  check('a remote screenshot URL is refused',
    errs({ screenshot: 'https://evil.test/x.png' }).some((e) => e.includes('data: image')));
  check('a data: screenshot is accepted',
    v({ screenshot: 'data:image/png;base64,iVBORw0KGgo=' }).ok === true);
}

/* ---------------- THE token guard: select CSS, never be CSS ---------------- */
{
  check('a hex colour is accepted', v({ tokens: { colors: { primary: '#e2571e' } } }).ok === true);
  check('a short hex is accepted', v({ tokens: { colors: { primary: '#abc' } } }).ok === true);

  // Each of these would escape `--primary-color: <value>;` if stored.
  for (const evil of [
    'red; } body { display: none } .x{',
    '#fff; background: url(//evil.test)',
    'expression(alert(1))',
    'var(--x); }',
    'red',            // a bare keyword is not a hex value
    '#gggggg',        // hex-shaped but not hex
  ]) {
    check(`a colour of ${JSON.stringify(evil)} is refused`,
      errs({ tokens: { colors: { primary: evil } } }).some((e) => e.includes('hex colour')));
  }

  // Enum scales resolve through an allow-list, so a stored value may only NAME
  // a pre-authored block.
  check('a known token key is accepted', v({ tokens: { style: { radius: 'lg' } } }).ok === true);
  check('a raw CSS value in an enum slot is refused',
    errs({ tokens: { style: { radius: '9999px' } } }).some((e) => e.includes('allowed values')));
  check('an unknown token key is refused',
    errs({ tokens: { style: { radius: 'enormous' } } }).some((e) => e.includes('allowed values')));
  // isTokenKey indexes TOKEN_SCALES directly and throws on an unknown scale —
  // a typo in an uploaded manifest must be a 400, not a 500.
  check('an unknown design token name is refused rather than throwing',
    errs({ tokens: { style: { bogusScale: 'x' } } }).some((e) => e.includes('not a design token')));

  check('a font stack is accepted',
    v({ tokens: { typography: { headingFont: '"Inter", system-ui, sans-serif' } } }).ok === true);
  check('a font value that could close a declaration is refused',
    errs({ tokens: { typography: { headingFont: 'Inter; } body {' } } }).length > 0);
  check('a length is accepted', v({ tokens: { typography: { fontSize: '1.05rem' } } }).ok === true);
  check('a bogus length is refused', errs({ tokens: { typography: { fontSize: '10; }' } } }).length > 0);

  check('colorScheme is constrained', errs({ tokens: { colorScheme: 'neon' } }).length > 0);
  check('a valid colorScheme is accepted', v({ tokens: { colorScheme: 'auto' } }).ok === true);

  // customCSS is the OPERATOR's box. A theme that could write it would silently
  // overwrite whatever the site owner had typed there.
  check('a theme cannot set the operator customCSS',
    errs({ tokens: { customCSS: 'body{}' } }).some((e) => e.includes('customCSS')));

  check('tokens must be an object', errs({ tokens: 'nope' }).some((e) => e.includes('`tokens`')));
}

/* ---------------- stylesheet ---------------- */
{
  check('a normal stylesheet is accepted',
    v({ css: '.ab-hero { padding: var(--space-lg); }' }).ok === true);
  // Unlike a PLUGIN, a theme's CSS is not namespace-scoped — restyling the whole
  // site is the job. It is still filtered.
  check('a theme may style anything (it is not namespace-scoped)',
    v({ css: 'body { background: var(--background-color); }' }).ok === true);
  check('@import is refused (it would bypass style-src)',
    errs({ css: '@import url(//evil.test/x.css);' }).some((e) => e.includes('filter removes')));
  check('a </style> escape is refused',
    errs({ css: '</style><script>alert(1)</script>' }).some((e) => e.includes('filter removes')));
  check('a javascript: URL is refused',
    errs({ css: '.a { background: url(javascript:alert(1)) }' }).some((e) => e.includes('filter removes')));
  check('an over-long stylesheet is refused',
    errs({ css: 'a'.repeat(THEME_MANIFEST_LIMITS.css + 1) }).some((e) => e.includes('exceeds')));
}

/* ---------------- patterns ---------------- */
{
  const good = { name: 'splash', label: 'Splash', description: 'Big hero.',
    html: '<div class="ab-hero ab-align-center"><h2>Hi</h2></div>' };
  check('a pattern built from real sections is accepted', v({ patterns: [good] }).ok === true);

  const bad = { ...good, name: 'nope', html: '<div class="ab-parallax"><p>x</p></div>' };
  const r = v({ patterns: [bad] });
  check('a pattern the sanitizer would rewrite is refused', r.ok === false);
  check('...and the rejection carries the diff',
    r.rejectedPatterns?.[0]?.submitted === bad.html
    && r.rejectedPatterns[0].sanitized !== bad.html);
  check('...naming the section this build does not define',
    r.rejectedPatterns?.[0]?.reason.includes('ab-parallax'));

  check('a pattern containing a script is refused',
    v({ patterns: [{ ...good, html: '<div class="ab-card"><script>alert(1)</script></div>' }] }).ok === false);
  check('a duplicate pattern name is refused',
    errs({ patterns: [good, good] }).some((e) => e.includes('twice')));
  check('a malformed pattern is refused',
    errs({ patterns: [{ label: 'no name' }] }).some((e) => e.includes('name, label')));
  check('too many patterns are refused',
    errs({ patterns: Array.from({ length: THEME_MANIFEST_LIMITS.patterns + 1 },
      (_, i) => ({ ...good, name: `p${i}` })) }).some((e) => e.includes('Too many')));
}

/* ---------------- the normalized output ---------------- */
{
  const out = v({
    description: 'Warm.', author: 'Someone', homepage: 'https://x.test',
    tokens: { colors: { primary: '#e2571e' } },
    css: '.ab-hero { color: red; }',
    patterns: [{ name: 'a', label: 'A', description: 'd', html: '<div class="ab-card"><p>x</p></div>' }],
  }).manifest;
  check('the normalized manifest keeps every declared capability',
    out.tokens?.colors?.primary === '#e2571e' && !!out.css && out.patterns?.length === 1);
  check('...and does not invent fields that were not declared',
    v({}).manifest.css === undefined && v({}).manifest.patterns === undefined);
  check('a colour is stored trimmed',
    v({ tokens: { colors: { primary: '  #abcdef  ' } } }).manifest.tokens.colors.primary === '#abcdef');
}

/* ---------------- the tier marker ---------------- */
{
  check('a row carrying a manifest is declarative',
    isDeclarativeTheme({ id: 'x', manifest: { id: 'x' } }) === true);
  check('a bundled row is not', isDeclarativeTheme({ id: 'default' }) === false);
  check('a malformed manifest marker is not', isDeclarativeTheme({ manifest: { nope: 1 } }) === false);
  check('null is handled', isDeclarativeTheme(null) === false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
