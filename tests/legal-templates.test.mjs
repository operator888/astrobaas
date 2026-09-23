#!/usr/bin/env node
/**
 * Legal-page templates (src/lib/legal/templates.ts).
 *
 * The properties: every template is COMPLETE in every locale (a language
 * that renders half a privacy policy is worse than English), genuinely
 * translated, its slugs never collide with built-in routes or each other,
 * substituted business details are HTML-escaped (the trader-address field
 * is a stored-XSS vector interpolated raw), and a missing detail becomes a
 * VISIBLE marker — never a silent blank in a compliant-looking page.
 *
 * Run with:  node tests/legal-templates.test.mjs
 */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cacheDir = path.join(here, '..', 'node_modules', '.cache');
await fs.mkdir(cacheDir, { recursive: true });

const entry = path.join(cacheDir, `astrobaas-legal-tpl-entry-${process.pid}.ts`);
const outFile = path.join(cacheDir, `astrobaas-legal-tpl-${process.pid}.mjs`);
const root = path.join(here, '..');
await fs.writeFile(entry, [
  `export * from ${JSON.stringify(path.join(root, 'src/lib/legal/templates.ts'))};`,
  `export { isReservedSlug } from ${JSON.stringify(path.join(root, 'src/lib/reserved-slugs.ts'))};`,
].join('\n'));
await build({
  entryPoints: [entry], bundle: true, format: 'esm', platform: 'node',
  packages: 'external', outfile: outFile, logLevel: 'silent',
});
const L = await import(pathToFileURL(outFile).href);
await fs.rm(entry, { force: true });
await fs.rm(outFile, { force: true });

let pass = 0;
let fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };

const LOCALES = L.LEGAL_TEMPLATE_LOCALES;

/* ---- completeness: whole in every language, or not shipped ---- */
{
  check('the library ships the five documents a site actually needs',
    ['privacy', 'terms', 'cookies', 'imprint', 'returns']
      .every((id) => L.LEGAL_TEMPLATES.some((t) => t.id === id)));

  for (const tpl of L.LEGAL_TEMPLATES) {
    for (const loc of LOCALES) {
      const text = tpl.locales[loc];
      check(`${tpl.id}/${loc}: title, slug and a real body`,
        !!text && text.title.trim().length > 2
        && /^[a-z0-9-]+$/.test(text.slug)
        && text.body.trim().length > 200);
      check(`${tpl.id}/${loc}: slug does not collide with a built-in route`,
        !L.isReservedSlug(text.slug));
    }
    check(`${tpl.id}: el and de are genuinely translated, not English copies`,
      tpl.locales.el.body !== tpl.locales.en.body && tpl.locales.de.body !== tpl.locales.en.body);
  }

  const allSlugs = L.LEGAL_TEMPLATES.flatMap((t) => LOCALES.map((l) => t.locales[l].slug));
  check('no two template pages share a slug', new Set(allSlugs).size === allSlugs.length);

  check('returns is shop-only, the rest are for every site',
    L.LEGAL_TEMPLATES.find((t) => t.id === 'returns')?.commerceOnly === true
    && L.LEGAL_TEMPLATES.filter((t) => !t.commerceOnly).length === 4);

  check('returns LINKS to the statutory withdrawal notice instead of copying it',
    LOCALES.every((l) =>
      L.LEGAL_TEMPLATES.find((t) => t.id === 'returns').locales[l].body.includes('/legal/withdrawal')));
}

/* ---- substitution ---- */
{
  const settings = {
    site_title: 'Example Optics',
    site_url: 'https://example.gr',
    trader_legal_name: 'Example Optics OE',
    trader_address: 'Example Street 1, Athens',
    trader_email: 'info@example.gr',
    trader_phone: '+30 210 0000000',
  };
  const r = L.renderLegalTemplate('privacy', 'el', settings);
  check('values substitute in', r.contentHtml.includes('Example Optics OE') && r.contentHtml.includes('info@example.gr'));
  check('nothing is reported missing when everything is set', r.missing.length === 0);
  check('no placeholder braces survive substitution', !/\{\{[a-z_]+\}\}/.test(r.contentHtml));

  const partial = L.renderLegalTemplate('imprint', 'de', { trader_legal_name: 'Firma GmbH' });
  check('a missing detail becomes a VISIBLE localized marker',
    partial.contentHtml.includes('<mark>[bitte ergänzen:') && partial.missing.includes('trader_address'));
  check('the missing list names every gap, sorted',
    partial.missing.includes('trader_email') && partial.missing.includes('trader_phone')
    && JSON.stringify(partial.missing) === JSON.stringify([...partial.missing].sort()));

  const hostile = L.renderLegalTemplate('imprint', 'en', {
    trader_legal_name: '<img src=x onerror=alert(1)>Evil Co',
    trader_address: '</p><script>steal()</script>',
    trader_email: 'a@b.c', trader_phone: '1',
  });
  check('substituted values are HTML-escaped (stored-XSS via trader fields)',
    !hostile.contentHtml.includes('<img') && !hostile.contentHtml.includes('<script')
    && hostile.contentHtml.includes('&lt;img') && hostile.contentHtml.includes('Evil Co'));

  check('unknown template and locale are null, never throw',
    L.renderLegalTemplate('nonexistent', 'en', {}) === null
    && L.renderLegalTemplate('privacy', 'fr', {}) === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
