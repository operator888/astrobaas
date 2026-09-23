#!/usr/bin/env node
/**
 * Writing direction (C-135) and per-locale operator strings (C-136).
 *
 * The roadmap called RTL "a theme-token concern". The theme tokens are FLEX
 * directions and have nothing to do with writing direction — there was no `dir`
 * attribute in the codebase at all, so an Arabic locale rendered left-to-right
 * and no token could change it.
 *
 * C-136 was the opposite mistake: the note said "some strings localized", when
 * the per-locale PATTERN already existed three times with a shared
 * field-by-field rule and had simply never been pointed at the settings table.
 *
 * Run with:  node tests/i18n-direction.test.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadTs, ROOT } from './lib/load.mjs';

const D = await loadTs('src/lib/i18n/direction.ts');
const S = await loadTs('src/lib/settings-i18n.ts');
const globalCss = await fs.readFile(path.join(ROOT, 'src/styles/global.css'), 'utf8');
const baseLayout = await fs.readFile(path.join(ROOT, 'src/layouts/BaseLayout.astro'), 'utf8');

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed += 1; }
  catch (err) { failures.push(`${name}: ${err.message}`); }
}
function ok(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, what = '') {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${what} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
}

// ──────────────────────────────────────────────────────────── direction

check('the right-to-left languages are right to left', () => {
  for (const tag of ['ar', 'he', 'fa', 'ur', 'ps', 'ckb', 'dv', 'yi']) {
    eq(D.directionFor(tag), 'rtl', tag);
  }
});

check('a REGION does not change the script', () => {
  // `ar-EG`, `ar_SA` and `ar` are one language.
  for (const tag of ['ar-EG', 'ar_SA', 'AR-eg', 'he-IL']) eq(D.directionFor(tag), 'rtl', tag);
});

check('everything else is left to right', () => {
  for (const tag of ['en', 'el', 'de', 'fr', 'el-GR', 'zh-Hans']) eq(D.directionFor(tag), 'ltr', tag);
});

check('UNKNOWN falls back to ltr, which is the safe direction', () => {
  // A left-to-right site rendered right-to-left is unreadable; the reverse
  // merely looks wrong to somebody who would notice at once.
  for (const tag of ['', null, undefined, 'nonsense', 42]) eq(D.directionFor(tag), 'ltr', String(tag));
});

check('the direction is DERIVED, never a setting', () => {
  // A second setting is a second thing to get wrong: an operator who added
  // Arabic and forgot to tick a box would get a broken site with nothing
  // saying why. The script of a language is a property of the language.
  const src = D.directionFor.toString();
  if (/setting|config/i.test(src)) throw new Error('it reads configuration');
});

// ─────────────────────────────────────────────────────── it is APPLIED

check('THE FOUNDATION: BaseLayout sets dir on <html>', () => {
  // Nothing else works without it, and there was no dir attribute anywhere.
  if (!/<html[^>]*\bdir=\{directionFor\(/.test(baseLayout)) {
    throw new Error('no dir attribute derived from the locale');
  }
});

check('the stylesheet flips the physical utilities that are USED', () => {
  for (const rule of ['[dir="rtl"] .text-left', '[dir="rtl"] .ml-4', '[dir="rtl"] .pr-4']) {
    if (!globalCss.includes(rule)) throw new Error(`${rule} is not flipped`);
  }
});

check('the flip is a REPLACEMENT, not an addition', () => {
  // `margin-right: 1rem` added beside an unreset `margin-left: 1rem` gives a
  // block indented on both sides — which looks deliberate and is not.
  const m = globalCss.match(/\[dir="rtl"\] \.ml-4 \{([^}]*)\}/);
  if (!m) throw new Error('no ml-4 rule');
  if (!/margin-left:\s*0/.test(m[1])) throw new Error(`the original is not reset: ${m[1]}`);
  if (!/margin-right:\s*1rem/.test(m[1])) throw new Error(m[1]);
});

check('A DOTTED CLASS IS ESCAPED — an unescaped one is a dead rule', () => {
  // `.ml-0.5` is not one selector: it is `.ml-0` followed by the number token
  // `.5`, and every browser drops it. The generator emitted the unescaped
  // form and the checker looked for the same unescaped substring, so a rule
  // that could never match "proved" itself present and the gate stayed green.
  const rules = globalCss.replace(/\/\*[\s\S]*?\*\//g, '');
  ok(rules.includes('[dir="rtl"] .ml-0\\.5 '), 'the dot in ml-0.5 is not escaped');
  ok(!/\[dir="rtl"\] \.ml-0\.5 /.test(rules), 'the dead unescaped rule is still there');
});

check('NEGATIVE margins are flipped, and keep their sign', () => {
  // The generator's token regex could not match a class beginning with `-`, so
  // the admin sidebar's close button and two theme headers were never flipped
  // — and the check that exists to catch a missing flip could not see them
  // either.
  const rules = globalCss.replace(/\/\*[\s\S]*?\*\//g, '');
  ok(/\[dir="rtl"\] \.-ml-1 \{[^}]*margin-right: -0\.25rem/.test(rules), '-ml-1 is not flipped, or lost its sign');
  ok(/\[dir="rtl"\] \.-mr-12 \{[^}]*margin-left: -3rem/.test(rules), '-mr-12 is not flipped, or lost its sign');
});

check('`[dir="rtl"]` rather than `:dir(rtl)`', () => {
  // The pseudo-class is newer than some of the browsers a Greek optician's
  // customers are on, and the attribute is set on <html> either way.
  //
  // Comments stripped FIRST: the note explaining this decision names the
  // pseudo-class, and the first version of this check failed on it — the same
  // "the guard was fooled by a comment" shape this codebase has hit before.
  const rules = globalCss.replace(/\/\*[\s\S]*?\*\//g, '');
  if (/:dir\(/.test(rules)) throw new Error('uses the pseudo-class');
});

// ───────────────────────────────────────────── per-locale settings

const SETTINGS = {
  site_title: 'Οπτική Γωνία',
  site_tagline: 'Γυαλιά και φακοί',
  site_url: 'https://shop.gr',
  site_i18n: {
    de: { site_title: 'Optik Ecke' },
    en: { site_title: 'Optical Corner', site_tagline: 'Glasses and lenses' },
  },
};

check('no locale means exactly what it meant before', () => {
  eq(S.localizedSetting(SETTINGS, 'site_title', null), 'Οπτική Γωνία');
  eq(S.localizedSetting(SETTINGS, 'site_title', ''), 'Οπτική Γωνία');
});

check('a translated key comes back translated', () => {
  eq(S.localizedSetting(SETTINGS, 'site_title', 'de'), 'Optik Ecke');
  eq(S.localizedSetting(SETTINGS, 'site_title', 'EN'), 'Optical Corner');
});

check('BLANK IS NOT A TRANSLATION: a half-filled block overlays only what it filled', () => {
  // An operator who translated the title and not the tagline must not blank the
  // tagline on every German page — a data-loss-shaped surprise from an additive
  // edit.
  eq(S.localizedSetting(SETTINGS, 'site_tagline', 'de'), 'Γυαλιά και φακοί');
  eq(S.localizedSetting(SETTINGS, 'site_tagline', 'en'), 'Glasses and lenses');
});

check('a locale nobody translated falls back', () => {
  eq(S.localizedSetting(SETTINGS, 'site_title', 'fr'), 'Οπτική Γωνία');
});

check('THE WHITELIST: a credential or a URL cannot be localised', () => {
  // "Any setting" would let somebody create a locale-keyed API key or site URL
  // — shapes nobody should be able to make, which every reader would then have
  // to defend against.
  const sneaky = { ...SETTINGS, site_i18n: { de: { site_url: 'https://evil.example', assistant_api_key: 'x' } } };
  eq(S.localizedSetting(sneaky, 'site_url', 'de'), 'https://shop.gr');
  eq(S.normaliseSettingsI18n(sneaky.site_i18n), {}, 'neither key survives normalisation');
});

check('localizedSettings strips the sidecar, so the shape is identical either way', () => {
  const out = S.localizedSettings(SETTINGS, 'de');
  if ('site_i18n' in out) throw new Error('the sidecar leaked into the result');
  eq(out.site_title, 'Optik Ecke');
  eq(out.site_url, 'https://shop.gr');
});

check('an unreadable sidecar does not take the site down', () => {
  for (const junk of ['nonsense', 42, [], null]) {
    eq(S.normaliseSettingsI18n(junk), {}, String(junk));
    eq(S.localizedSettings({ site_title: 'X', site_i18n: junk }, 'de').site_title, 'X');
  }
});

check('a malformed locale code is dropped rather than stored', () => {
  eq(S.normaliseSettingsI18n({ 'not a locale': { site_title: 'x' } }), {});
  eq(S.normaliseSettingsI18n({ de: { site_title: '   ' } }), {}, 'blank is not a translation');
});

if (failures.length) {
  console.error(`\n✗ i18n-direction: ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error(`  · ${f}`);
  process.exit(1);
}
console.log(`✓ i18n-direction: ${passed} passed`);
