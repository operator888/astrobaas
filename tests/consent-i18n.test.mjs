#!/usr/bin/env node
/**
 * The consent strings table.
 *
 * One rule with teeth: EVERY locale is complete, or the build fails. A
 * half-translated consent banner is worse than an English one — a visitor who
 * reads "Στατιστικά" above an English description cannot tell which language
 * to trust, and consent they cannot read is not informed consent at all.
 *
 * Run with:  node tests/consent-i18n.test.mjs
 */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cacheDir = path.join(here, '..', 'node_modules', '.cache');
await fs.mkdir(cacheDir, { recursive: true });
const out = path.join(cacheDir, `astrobaas-consent-${process.pid}.mjs`);
await build({
  entryPoints: [path.join(here, '..', 'src/lib/consent.ts')],
  bundle: true, format: 'esm', platform: 'node', packages: 'external',
  outfile: out, logLevel: 'silent',
});
const C = await import(pathToFileURL(out).href);
await fs.rm(out, { force: true });

let pass = 0, fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };

const LOCALES = Object.keys(C.CONSENT_STRINGS);
check('en, el and de are all present', ['en', 'el', 'de'].every((l) => LOCALES.includes(l)));

const TOP = ['title', 'body', 'acceptAll', 'rejectOptional', 'choose', 'save', 'alwaysOn', 'reopen'];
for (const loc of LOCALES) {
  const t = C.CONSENT_STRINGS[loc];
  for (const k of TOP) {
    check(`${loc}.${k} is a non-empty string`, typeof t[k] === 'string' && t[k].trim().length > 0);
  }
  for (const cat of C.CONSENT_CATEGORIES) {
    const c = t.categories?.[cat];
    check(`${loc}.categories.${cat} has label + description`,
      !!c && c.label.trim().length > 0 && c.description.trim().length > 0);
  }
}

// A translation that IS the English string is a copy, not a translation. The
// odd legitimate collision is allowed; wholesale copying is not.
for (const loc of LOCALES.filter((l) => l !== 'en')) {
  const t = C.CONSENT_STRINGS[loc], en = C.CONSENT_STRINGS.en;
  const same = TOP.filter((k) => t[k] === en[k]).length;
  check(`${loc} translates rather than copies (${same} identical of ${TOP.length})`, same <= 1);
}

// Descriptors carry structure only; text lives in the table. A label creeping
// back onto a descriptor would bypass every translation above.
for (const d of C.CONSENT_DESCRIPTORS) {
  check(`descriptor ${d.id} carries no hardcoded text`, !('label' in d) && !('description' in d));
}

// The invariants the banner logic rests on.
check('necessary is required', C.CONSENT_DESCRIPTORS.find((d) => d.id === 'necessary')?.required === true);
check('optional categories are exactly the non-required ones',
  JSON.stringify([...C.OPTIONAL_CATEGORIES].sort())
  === JSON.stringify(C.CONSENT_DESCRIPTORS.filter((d) => !d.required).map((d) => d.id).sort()));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
