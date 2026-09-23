#!/usr/bin/env node
/**
 * The cookie declaration (src/lib/cookie-declaration.ts).
 *
 * A cookie declaration is a dated, specific claim about what a site does with
 * people's data. So the cases that matter here are the ones where a plausible
 * implementation publishes something FALSE:
 *
 *   · declaring a vendor whose tracking ID was removed, or never validated;
 *   · a lifetime typed by hand that no longer matches the constant;
 *   · implying the list is complete when the vendor controls it;
 *   · rows for `astrobaas_doc` and `astrobaas_requests_total`, which a naive
 *     `astrobaas_*` grep finds and which are a database table and a metric.
 *
 * Run with:  node tests/cookie-declaration.test.mjs
 */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const cacheDir = path.join(root, 'node_modules', '.cache');
await fs.mkdir(cacheDir, { recursive: true });
const out = path.join(cacheDir, `astrobaas-cookiedecl-${process.pid}.mjs`);
await build({
  entryPoints: [path.join(root, 'src/lib/cookie-declaration.ts')],
  bundle: true, format: 'esm', platform: 'node', packages: 'external',
  outfile: out, logLevel: 'silent',
});
const D = await import(pathToFileURL(out).href);

// The constants the declaration must agree with, from their own modules.
const consentSrc = await fs.readFile(path.join(root, 'src/lib/consent.ts'), 'utf8');
const authSrc = await fs.readFile(path.join(root, 'src/lib/auth.ts'), 'utf8');
const analyticsSrc = await fs.readFile(path.join(root, 'src/lib/analytics.ts'), 'utf8');

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed += 1; }
  catch (err) { failures.push(`${name}: ${err.message}`); }
}
function eq(a, b, what = '') {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${what} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
}
const S = (obj) => Object.entries(obj).map(([key, value]) => ({ key, value }));

// ------------------------------------------------------------ first party

check('the first-party list is exactly the cookies this app sets', () => {
  // NOT `astrobaas_doc` (a database table) and NOT `astrobaas_requests_total`
  // (a Prometheus metric). Both match a naive astrobaas_* grep.
  eq(D.firstPartyCookies().map((c) => c.name).sort(), [
    'astrobaas_2fa_pending', 'astrobaas_consent', 'astrobaas_csrf',
    'astrobaas_session', 'astrobaas_theme',
  ]);
});

check('every first-party row is complete enough to publish', () => {
  for (const c of D.firstPartyCookies()) {
    for (const f of ['name', 'provider', 'category', 'purpose', 'lifetime']) {
      if (!c[f]) throw new Error(`${c.name} has no ${f}`);
    }
    if (c.firstParty !== true) throw new Error(`${c.name} is not marked first-party`);
    if (!c.setWhen) throw new Error(`${c.name} does not say when it is set`);
  }
});

check('only the theme cookie is optional; the rest are necessary', () => {
  const byName = Object.fromEntries(D.firstPartyCookies().map((c) => [c.name, c.category]));
  eq(byName.astrobaas_theme, 'preferences');
  for (const n of ['astrobaas_session', 'astrobaas_csrf', 'astrobaas_consent', 'astrobaas_2fa_pending']) {
    eq(byName[n], 'necessary', n);
  }
});

check('the consent lifetime is DERIVED from CONSENT_MAX_AGE_DAYS, not typed', () => {
  // A declaration that says 6 months while the cookie lasts a year is a false
  // retention claim. Read the constant and check the rendered phrase follows it.
  const days = Number(/CONSENT_MAX_AGE_DAYS = (\d+)/.exec(consentSrc)[1]);
  const months = Math.round(Math.round(days) / 30);
  const row = D.firstPartyCookies().find((c) => c.name === 'astrobaas_consent');
  eq(row.lifetime, `${months} months`, `for ${days} days`);
});

check('the session lifetime is DERIVED from SESSION_TTL_MS', () => {
  const expr = /const SESSION_TTL_MS = ([^;]+);/.exec(authSrc)[1];
  // eslint-disable-next-line no-eval
  const ms = eval(expr);
  const hours = Math.round(ms / 3_600_000);
  const row = D.firstPartyCookies().find((c) => c.name === 'astrobaas_session');
  eq(row.lifetime, hours === 1 ? '1 hour' : `${hours} hours`);
});

// ---------------------------------------------------------- configuration

check('no configured provider means no third-party rows at all', () => {
  const d = D.buildCookieDeclaration(S({ site_title: 'Shop' }));
  eq(d.providers.length, 0);
  eq(d.all.length, D.firstPartyCookies().length);
  eq(d.incomplete, false, 'nothing to be incomplete about');
  eq(d.opaqueContainers, []);
});

check('a configured provider brings its cookies', () => {
  const d = D.buildCookieDeclaration(S({ analytics_ga4_id: 'G-ABCDE12345' }));
  eq(d.providers.length, 1);
  const names = d.providers[0].entries.map((e) => e.name);
  eq(names.includes('_ga'), true, `got ${names}`);
});

check('a provider with a MALFORMED id is not declared', () => {
  // It is not declared because it is not LOADED — the same validateAnalyticsId
  // decides both. Declaring a cookie the site never sets is as wrong as
  // omitting one it does.
  const d = D.buildCookieDeclaration(S({ analytics_ga4_id: 'not-a-measurement-id' }));
  eq(d.providers.length, 0);
});

check('a provider whose id was CLEARED disappears', () => {
  eq(D.buildCookieDeclaration(S({ analytics_ga4_id: '' })).providers.length, 0);
  eq(D.buildCookieDeclaration(S({ analytics_ga4_id: null })).providers.length, 0);
});

check('an unknown settings key is not mistaken for a provider', () => {
  eq(D.buildCookieDeclaration(S({ analytics_nonesuch_id: 'x' })).providers.length, 0);
});

// -------------------------------------------------------------- honesty

check('cookieless providers are declared as such, with no rows', () => {
  for (const [id, value] of [['plausible', 'shop.example.com'], ['fathom', 'ABCDEFGH'], ['umami', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee']]) {
    const d = D.buildCookieDeclaration(S({ [`analytics_${id}_id`]: value }));
    if (d.providers.length !== 1) throw new Error(`${id} not configured — check the id pattern`);
    eq(d.providers[0].facts.cookieless, true, id);
    eq(d.providers[0].entries.length, 0, id);
    eq(d.incomplete, false, `${id} must not raise the incompleteness caveat`);
  }
});

check('a vendor-controlled provider RAISES the incompleteness caveat', () => {
  // The alternative is publishing a completeness claim we cannot stand behind.
  eq(D.buildCookieDeclaration(S({ analytics_ga4_id: 'G-ABCDE12345' })).incomplete, true);
});

check('Tag Manager is flagged as opaque, not merely incomplete', () => {
  // Different sentence, different truth: not "there may be more" but "this CMS
  // cannot see what you loaded through it".
  const d = D.buildCookieDeclaration(S({ analytics_gtm_id: 'GTM-ABC1234' }));
  eq(d.opaqueContainers.length, 1, JSON.stringify(d.providers.map((p) => p.provider.id)));
  eq(d.providers[0].entries.length, 0);
});

check('a cookieless provider is never called opaque', () => {
  eq(D.buildCookieDeclaration(S({ analytics_plausible_id: 'shop.example.com' })).opaqueContainers, []);
});

check('a provider whose cookies we merely did not list is NOT called a container', () => {
  // The LinkedIn Insight Tag sets cookies; they are just not enumerated here.
  // Inferring "container" from "no rows" told visitors it sets nothing, which
  // is a false statement in a legal document and the misleading direction of
  // false. An audit caught exactly this.
  const d = D.buildCookieDeclaration(S({ analytics_linkedin_id: '1234567' }));
  eq(d.providers.length, 1, 'linkedin not configured — check the id pattern');
  eq(d.opaqueContainers, []);
  eq(d.incomplete, true, 'it still raises the "there may be more" caveat');
});

check('every third-party row carries a link to the vendor\'s own documentation', () => {
  const d = D.buildCookieDeclaration(S({ analytics_ga4_id: 'G-ABCDE12345', analytics_clarity_id: 'abcdefghij' }));
  for (const p of d.providers) {
    for (const e of p.entries) {
      if (!/^https:\/\//.test(e.helpUrl || '')) throw new Error(`${e.name} has no vendor docs`);
    }
  }
});

check('a marketing tag is declared under marketing, not analytics', () => {
  const d = D.buildCookieDeclaration(S({ 'analytics_meta-pixel_id': '1234567890' }));
  eq(d.providers.length, 1, 'meta-pixel not configured — check the id pattern');
  eq(d.providers[0].entries.every((e) => e.category === 'marketing'), true);
});

check('the category on a row matches the provider registry, not a copy of it', () => {
  // Two lists of categories drift. This asserts the row takes the provider's.
  const d = D.buildCookieDeclaration(S({ analytics_hotjar_id: '1234567', analytics_tiktok_id: 'ABCDEFGHIJKLMNOPQRST' }));
  for (const p of d.providers) {
    for (const e of p.entries) eq(e.category, p.provider.category, p.provider.id);
  }
});

// ----------------------------------------------------------- completeness

check('EVERY provider in the registry has cookie facts', () => {
  // A provider added later with no entry here would silently declare nothing
  // while setting cookies — the worst possible failure for this file.
  const ids = [...analyticsSrc.matchAll(/^\s{4}id: '([a-z0-9-]+)',$/gm)].map((m) => m[1]);
  if (ids.length < 10) throw new Error(`only found ${ids.length} provider ids — parser drifted`);
  const missing = ids.filter((id) => !(id in D.PROVIDER_COOKIES));
  eq(missing, [], 'providers with no cookie facts');
});

check('`all` is first-party first, then third-party', () => {
  const d = D.buildCookieDeclaration(S({ analytics_ga4_id: 'G-ABCDE12345' }));
  const n = D.firstPartyCookies().length;
  eq(d.all.slice(0, n).every((c) => c.provider === 'This site'), true);
  eq(d.all.slice(n).every((c) => c.provider !== 'This site'), true);
  eq(d.all.length, n + d.providers[0].entries.length);
});

check('several providers at once are all declared', () => {
  const d = D.buildCookieDeclaration(S({
    analytics_ga4_id: 'G-ABCDE12345',
    'analytics_meta-pixel_id': '1234567890',
    analytics_plausible_id: 'shop.example.com',
  }));
  eq(d.providers.length, 3);
  eq(d.incomplete, true);
});

if (failures.length) {
  console.error(`\n✗ cookie-declaration: ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error(`  · ${f}`);
  process.exit(1);
}
console.log(`✓ cookie-declaration: ${passed} passed`);
