#!/usr/bin/env node
/**
 * The withdrawal notice, per language.
 *
 * These are the model texts of Annex I of Directive 2011/83/EU. The rule that
 * matters most is not about translation quality — it is that a text NOBODY HAS
 * CHECKED must never be served as a legal notice. Falling back to English is
 * the safe failure; an unverified German Widerrufsbelehrung is not.
 *
 * Run with:  node tests/legal-i18n.test.mjs
 */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cacheDir = path.join(here, '..', 'node_modules', '.cache');
await fs.mkdir(cacheDir, { recursive: true });
const load = async (rel, tag) => {
  const out = path.join(cacheDir, `astrobaas-${tag}-${process.pid}.mjs`);
  await build({
    entryPoints: [path.join(here, '..', rel)], bundle: true, format: 'esm',
    platform: 'node', packages: 'external', outfile: out, logLevel: 'silent',
  });
  const m = await import(pathToFileURL(out).href);
  await fs.rm(out, { force: true });
  return m;
};

const L = await load('src/lib/legal/withdrawal-locales.ts', 'wloc');
const W = await load('src/lib/withdrawal.ts', 'withdrawal');

const {
  withdrawalStringsFor, withdrawalTextIsVerified, withdrawalLocales,
  OFFICIALLY_VERIFIED_LOCALES,
} = L;
const { withdrawalInstructions, modelWithdrawalForm, orderButtonLabel } = W;

let pass = 0, fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };

const policy = {
  enabled: true, days: 14, returnCosts: 'customer',
  traderName: 'Example Optics', traderAddress: 'Athens', traderEmail: 'shop@example.gr',
};

/* ---------- the verification gate ---------- */
{
  check('English is verified out of the box', withdrawalTextIsVerified('en', {}));
  // The rule this whole module exists for.
  check('German is NOT verified by default', !withdrawalTextIsVerified('de', {}));
  check('nor is Greek', !withdrawalTextIsVerified('el', {}));
  check('only English is in the shipped verified set',
    OFFICIALLY_VERIFIED_LOCALES.join() === 'en');

  const opted = { WITHDRAWAL_VERIFIED_LOCALES: 'de, el' };
  check('an operator can opt in per locale', withdrawalTextIsVerified('de', opted));
  check('and it is comma-separated and trimmed', withdrawalTextIsVerified('el', opted));
  check('but only for what they named', !withdrawalTextIsVerified('fr', opted));
  for (const junk of [{ WITHDRAWAL_VERIFIED_LOCALES: '' }, { WITHDRAWAL_VERIFIED_LOCALES: '   ' }, {}]) {
    check('junk opts nothing in', !withdrawalTextIsVerified('de', junk));
  }
}

/* ---------- what actually gets served ---------- */
{
  const unverified = withdrawalStringsFor('de', {});
  check('an unverified locale falls back to English', unverified.locale === 'en');
  check('and SAYS it fell back, so a storefront can react', unverified.fellBack === true);
  check('English itself never reports a fallback', withdrawalStringsFor('en', {}).fellBack === false);
  check('an unknown locale falls back too', withdrawalStringsFor('fr', {}).locale === 'en');
  check('and so does nonsense', withdrawalStringsFor('', {}).locale === 'en');

  const verified = withdrawalStringsFor('de', { WITHDRAWAL_VERIFIED_LOCALES: 'de' });
  check('an opted-in locale is served', verified.locale === 'de' && verified.fellBack === false);
}

/* ---------- the generated texts ---------- */
{
  const en = withdrawalInstructions(policy, 'en');
  check('English instructions render', en.includes('Right of withdrawal'));
  check('the day count is interpolated', en.includes('within 14 days'));
  check('the trader block is included', en.includes('Example Optics') && en.includes('shop@example.gr'));
  check('the return-cost sentence follows the policy', en.includes('bear the direct cost'));
  check('and flips with the policy',
    withdrawalInstructions({ ...policy, returnCosts: 'trader' }, 'en').includes('We bear the cost'));

  // Unverified: the German request must produce ENGLISH text.
  const deUnverified = withdrawalInstructions(policy, 'de');
  check('an unverified German request yields English text', deUnverified.includes('Right of withdrawal'));
  check('and no German at all', !deUnverified.includes('Widerrufsrecht'));

  const form = modelWithdrawalForm(policy, 'en');
  check('the model form renders', form.includes('Model withdrawal form'));
  check('with the trader block', form.includes('Example Optics'));

  // Art. 8(2).
  check('the order button label is the statutory English one',
    orderButtonLabel('en') === 'Order with obligation to pay');
  check('an unverified locale gets the English label', orderButtonLabel('de') === 'Order with obligation to pay');
}

/* ---------- the translations exist and are complete ---------- */
{
  check('three locales ship text', withdrawalLocales().join() === 'de,el,en');
  const keys = Object.keys(withdrawalStringsFor('en', {}).strings);
  for (const loc of ['de', 'el']) {
    const s = withdrawalStringsFor(loc, { WITHDRAWAL_VERIFIED_LOCALES: loc }).strings;
    const missing = keys.filter((k) => typeof s[k] !== 'string' || !s[k].trim());
    check(`${loc} has every key the English text has`, missing.length === 0);
    // A "translation" that is byte-identical to English is an untranslated one.
    const identical = keys.filter((k) => s[k] === withdrawalStringsFor('en', {}).strings[k]);
    check(`${loc} is genuinely translated, not copied`, identical.length === 0);
  }
  // The one phrase the statute itself names.
  check('the German order button uses the statutory wording',
    withdrawalStringsFor('de', { WITHDRAWAL_VERIFIED_LOCALES: 'de' }).strings.orderButtonLabel
      === 'Zahlungspflichtig bestellen');
  // The day placeholder must survive into every language, or the notice states
  // no withdrawal period at all.
  for (const loc of ['en', 'de', 'el']) {
    const s = withdrawalStringsFor(loc, { WITHDRAWAL_VERIFIED_LOCALES: 'de,el' }).strings;
    check(`${loc} keeps the {days} placeholder`,
      s.rightIntro.includes('{days}') && s.periodExpires.includes('{days}'));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
