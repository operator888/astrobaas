#!/usr/bin/env node
/**
 * Patterns and the section audit.
 *
 * The property under test is the same one that makes sections safe: **what the
 * editor offers must be exactly what the save path keeps.** A pattern that the
 * sanitizer rewrites is worse than a missing pattern, because the author builds
 * a page on it and loses a region on save with no error anywhere.
 *
 * So the registry is not asserted to "work" — it is asserted to REJECT. A
 * rejection test that never sees a rejection proves nothing, so each one is
 * paired with a hand-built bad pattern.
 *
 * Run with:  node tests/patterns.test.mjs
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

const { BUILTIN_PATTERNS, isWellFormedPattern, unknownSectionsIn } =
  await load('src/core/patterns.ts', 'patterns');
const { resolvePatterns } = await load('src/lib/pattern-registry.ts', 'pattern-registry');
const { auditSections } = await load('src/lib/section-audit.ts', 'section-audit');
const { sanitizeHtml, sanitizeThemeCss, MAX_THEME_CSS } =
  await load('src/lib/sanitize.ts', 'sanitize-for-patterns');

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) pass++;
  else { fail++; console.error(`✗ ${name}`); }
}

/* ---------------- THE invariant: patterns survive the save path ---------------- */
{
  for (const p of BUILTIN_PATTERNS) {
    check(`the "${p.name}" pattern survives the sanitizer unchanged`, sanitizeHtml(p.html) === p.html);
  }
  check('built-in pattern names are unique',
    new Set(BUILTIN_PATTERNS.map((p) => p.name)).size === BUILTIN_PATTERNS.length);
  check('every built-in pattern is well formed', BUILTIN_PATTERNS.every(isWellFormedPattern));
  check('no pattern contains an interpolation, script or inline style',
    BUILTIN_PATTERNS.every((p) =>
      !p.html.includes('${') && !/<script|on[a-z]+\s*=|\sstyle\s*=/i.test(p.html)));
  // A pattern is a composition of sections; one made of plain divs is just HTML.
  check('every built-in pattern actually uses sections',
    BUILTIN_PATTERNS.every((p) => /class="ab-/.test(p.html)));
}

/* ---------------- the registry rejects rather than trusts ---------------- */
{
  const good = resolvePatterns();
  check('with no theme, all built-ins resolve', good.patterns.length === BUILTIN_PATTERNS.length);
  check('...and nothing is rejected', good.rejected.length === 0);

  // A theme naming a section this build does not have. The class is stripped on
  // save, so the pattern would silently lose a whole region.
  const futureSection = resolvePatterns(
    [{ name: 'future', label: 'Future', description: 'x', html: '<div class="ab-parallax"><p>hi</p></div>' }],
    'sometheme',
  );
  check('a pattern using an unknown section is rejected',
    futureSection.patterns.length === BUILTIN_PATTERNS.length && futureSection.rejected.length === 1);
  check('...and the rejection names the missing section',
    futureSection.rejected[0]?.reason.includes('ab-parallax'));

  // Markup the sanitizer rewrites for a different reason.
  const scripted = resolvePatterns(
    [{ name: 'bad', label: 'Bad', description: 'x', html: '<div class="ab-card"><script>alert(1)</script></div>' }],
    'sometheme',
  );
  check('a pattern containing a script is rejected', scripted.rejected.length === 1);
  check('...and is not offered', !scripted.patterns.some((p) => p.name.includes('bad')));

  const malformed = resolvePatterns([{ label: 'No name', html: '<p>x</p>' }, null, 'nope'], 'sometheme');
  check('malformed pattern objects are each rejected', malformed.rejected.length === 3);
  check('...without throwing or dropping the built-ins',
    malformed.patterns.length === BUILTIN_PATTERNS.length);

  // One bad pattern must not cost the good ones beside it.
  const mixed = resolvePatterns([
    { name: 'ok', label: 'OK', description: 'x', html: '<div class="ab-card"><p>fine</p></div>' },
    { name: 'bad', label: 'Bad', description: 'x', html: '<div class="ab-nope"><p>broken</p></div>' },
  ], 'sometheme');
  check('a valid theme pattern is offered alongside a rejected one',
    mixed.patterns.some((p) => p.name === 'sometheme--ok') && mixed.rejected.length === 1);

  // A theme must not be able to shadow a built-in the author already knows.
  const shadow = resolvePatterns(
    [{ name: 'landing', label: 'Hijack', description: 'x', html: '<div class="ab-card"><p>x</p></div>' }],
    'sometheme',
  );
  check('a theme pattern cannot shadow a built-in name',
    shadow.patterns.filter((p) => p.name === 'landing').length === 1
    && shadow.patterns.some((p) => p.name === 'sometheme--landing'));

  check('unknownSectionsIn finds only unknown roots',
    JSON.stringify(unknownSectionsIn('<div class="ab-hero ab-parallax ab-cols-2">x</div>')) === '["ab-parallax"]');
}

/* ---------------- theme CSS is refused, not truncated ---------------- */
{
  check('theme CSS passes normal rules through',
    sanitizeThemeCss('.ab-hero { padding: 2rem; }') === '.ab-hero { padding: 2rem; }');
  check('@import is stripped (it would bypass style-src)',
    !/@import/.test(sanitizeThemeCss('@import url(//evil.test/x.css); .a{color:red}')));
  check('a </style> escape attempt is stripped',
    !/<\/style>/i.test(sanitizeThemeCss('</style><script>alert(1)</script>.a{color:red}')));
  check('javascript: urls are stripped',
    !/javascript:/i.test(sanitizeThemeCss('.a{background:url(javascript:alert(1))}')));

  // The distinction from operator CSS: too long is REFUSED, because truncating
  // inside `@media (...) {` would swallow every rule after it.
  let reason = '';
  const huge = '.a{color:red}'.repeat(Math.ceil(MAX_THEME_CSS / 13) + 10);
  const out = sanitizeThemeCss(huge, (r) => { reason = r; });
  check('an over-long theme stylesheet is refused whole, not truncated', out === '');
  check('...and the refusal explains itself', reason.includes('over the'));
  check('empty and undefined input are safe',
    sanitizeThemeCss('') === '' && sanitizeThemeCss(undefined) === '');
}

/* ---------------- the audit finds drift ---------------- */
{
  const mk = (id, content, extra = {}) => ({
    id, title: `T${id}`, slug: `s${id}`, status: 'published', content, ...extra,
  });

  const posts = [
    mk('1', '<div class="ab-hero ab-align-center"><h2>ok</h2></div>'),
    mk('2', '<div class="ab-parallax"><p>removed section</p></div>', { kind: 'page' }),
    mk('3', '<p>no sections at all</p>'),
    mk('4', '<div class="ab-parallax ab-card"><p>mixed</p></div>'),
  ];
  const a = auditSections(posts);

  check('the audit scans every record', a.scanned === 4);
  check('...counts only those using sections', a.usingSections === 3);
  check('...and flags only those with unknown classes', a.affected.length === 2);
  check('a record with only valid sections is not flagged',
    !a.affected.some((r) => r.id === '1'));
  check('a record with no sections is not flagged', !a.affected.some((r) => r.id === '3'));
  check('the unknown class is counted across records',
    a.unknownTotals.find((u) => u.className === 'ab-parallax')?.records === 2);
  check('a known class beside an unknown one is not reported',
    !a.unknownTotals.some((u) => u.className === 'ab-card'));
  check('the flagged row carries its kind', a.affected.find((r) => r.id === '2')?.kind === 'page');
  check('a record with no kind audits as a post', a.affected.find((r) => r.id === '4')?.kind === 'post');
  check('usage counts real sections', a.usage.find((u) => u.name === 'hero')?.records === 1);
  check('usage reports zero for unused sections',
    a.usage.find((u) => u.name === 'gallery')?.records === 0);

  /* ---- plugin classes: known when installed, orphaned when not ---- */
  // Without this distinction the audit reports every page using a healthy
  // plugin section as broken, and tells its owner to rewrite pages that need
  // nothing done to them.
  const withPlugin = [mk('9', '<div class="ab-x-acme-promo"><p>x</p></div>')];

  const installed = auditSections(withPlugin, ['ab-x-acme-promo']);
  check('a plugin section from an ACTIVE plugin is not flagged at all',
    installed.affected.length === 0 && installed.unknownTotals.length === 0);
  check('...and still counts as using sections', installed.usingSections === 1);

  const orphan = auditSections(withPlugin);
  check('a plugin section with no plugin installed is reported as ORPHANED',
    orphan.orphanedTotals.some((u) => u.className === 'ab-x-acme-promo'));
  check('...and NOT as unknown, because the sanitizer preserves it',
    orphan.unknownTotals.length === 0);
  check('...on a row that names it separately from unknown classes',
    orphan.affected[0]?.orphanedPluginClasses.includes('ab-x-acme-promo')
    && orphan.affected[0]?.unknownClasses.length === 0);

  // A malformed lookalike is NOT in the namespace, so it really is at risk.
  const lookalike = auditSections([mk('10', '<div class="ab-x-broken"><p>x</p></div>')]);
  check('a malformed plugin-ish class is unknown, not orphaned',
    lookalike.unknownTotals.some((u) => u.className === 'ab-x-broken')
    && lookalike.orphanedTotals.length === 0);

  // Both conditions at once must be separated, not merged.
  const both = auditSections([mk('11', '<div class="ab-x-acme-promo ab-parallax"><p>x</p></div>')]);
  check('a record with both is reported under both headings',
    both.affected[0]?.orphanedPluginClasses.length === 1
    && both.affected[0]?.unknownClasses.length === 1);

  // A clean corpus must produce a clean report — the common case has to be
  // quiet, or nobody reads the screen.
  const clean = auditSections([mk('1', '<div class="ab-card"><p>x</p></div>')]);
  check('a clean corpus reports nothing to fix',
    clean.affected.length === 0 && clean.unknownTotals.length === 0);
  check('an empty corpus is handled', auditSections([]).scanned === 0);
  // Missing/absent content must not throw — a draft can legitimately have none.
  check('a record with no content is skipped safely',
    auditSections([{ id: 'x', title: 't', slug: 's', status: 'draft' }]).usingSections === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
