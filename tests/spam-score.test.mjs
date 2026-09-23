#!/usr/bin/env node
/**
 * Spam scoring and the shared public-write gate (C-79).
 *
 * Two things are being asserted, and the second is the one that was actually
 * broken:
 *
 *  1. the score is STRUCTURAL — no phrase dictionary, because a list of "spam
 *     words" is a list in one language and both live installs write Greek. A
 *     scorer trained on English marketing copy flags an ordinary Greek enquiry
 *     and misses the Greek spam entirely;
 *  2. the three public write paths run the SAME gate. They were written
 *     separately and had drifted: the content-type form had a form-shaped rate
 *     limit and /api/contact and /api/newsletter had none — so the two doors a
 *     stranger is most likely to find were the two least protected.
 *
 * Run with:  node tests/spam-score.test.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadTs, ROOT } from './lib/load.mjs';

const S = await loadTs('src/lib/spam-score.ts');
const L = await loadTs('src/lib/link-check.ts');

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
const ids = (v) => v.signals.map((s) => s.id).sort();

// ─────────────────────────────────────────── an ordinary message scores zero

check('a normal enquiry is not flagged', () => {
  // The failure that costs an operator a customer is a false positive, so this
  // is the case that matters most.
  const v = S.scoreSubmission({
    name: 'Anna Papadopoulou',
    email: 'anna@example.gr',
    message: 'Do you have these frames in blue? I need them before Friday if possible.',
  });
  eq(v.score, 0);
  eq(v.flagged, false);
});

check('a GREEK enquiry is not flagged', () => {
  // Every signal is structural precisely so this is true. A phrase dictionary
  // would be a dictionary in one language.
  const v = S.scoreSubmission({
    name: 'Γιώργος',
    message: 'Καλησπέρα, έχετε αυτόν τον σκελετό σε μπλε χρώμα; Τον χρειάζομαι μέχρι την Παρασκευή.',
  });
  eq(v.flagged, false, JSON.stringify(v.signals));
});

check('an enquiry that CITES one link is not flagged', () => {
  // A customer linking the product they mean is not a spammer.
  const v = S.scoreSubmission({
    message: 'I saw this model on your site https://shop.example.gr/frames/aviator — do you have it in 52mm? '
      + 'My prescription is fairly strong so I want to be sure the lens will fit the frame properly.',
  });
  eq(v.flagged, false, JSON.stringify(v.signals));
});

check('an empty submission scores nothing', () => {
  eq(S.scoreSubmission({}).score, 0);
  eq(S.scoreSubmission({ a: '', b: null, c: 5 }).score, 0);
});

// ────────────────────────────────────────────────────── what IS flagged

check('a wall of links is flagged', () => {
  const v = S.scoreSubmission({
    message: 'https://a.gr https://b.gr https://c.gr https://d.gr https://e.gr',
  });
  if (!v.flagged) throw new Error(JSON.stringify(v));
  if (!ids(v).includes('many-links')) throw new Error(ids(v).join());
});

check('a short message built around a link is flagged', () => {
  const v = S.scoreSubmission({ message: 'check this https://a.gr https://b.gr' });
  if (!v.flagged) throw new Error(JSON.stringify(v));
});

check('link MARKUP in a plain-text field is flagged', () => {
  // A form field is plain text. An anchor tag in one was typed by software,
  // and by software that expected a forum.
  for (const body of ['<a href="https://x.gr">buy</a>', '[url=https://x.gr]buy[/url]']) {
    const v = S.scoreSubmission({ message: body });
    if (!ids(v).includes('markup')) throw new Error(`${body}: ${ids(v).join()}`);
  }
});

check('a NAME that is a link or an address is flagged', () => {
  if (!ids(S.scoreSubmission({ name: 'https://x.gr', message: 'hi' })).includes('name-is-a-link')) {
    throw new Error('missed a url in the name');
  }
  if (!ids(S.scoreSubmission({ full_name: 'a@b.gr', message: 'hi' })).includes('name-is-a-link')) {
    throw new Error('missed an address in the name');
  }
});

check('shouting is a signal but not, alone, a verdict', () => {
  // Somebody upset is not somebody selling. It contributes; it does not flag.
  const v = S.scoreSubmission({ message: 'MY GLASSES ARRIVED BROKEN AND NOBODY HAS REPLIED TO ME' });
  if (!ids(v).includes('shouting')) throw new Error(ids(v).join());
  eq(v.flagged, false, 'an angry customer must still reach the shop');
});

check('a long run of one character is a signal', () => {
  if (!ids(S.scoreSubmission({ message: 'helloooooooooo' })).includes('repetition')) {
    throw new Error('missed the run');
  }
});

check('every signal carries a reason a person can read', () => {
  const v = S.scoreSubmission({ name: 'http://x.gr', message: 'https://a.gr https://b.gr https://c.gr https://d.gr' });
  for (const s of v.signals) {
    if (!s.reason || !/[a-z]/i.test(s.reason)) throw new Error(JSON.stringify(s));
    if (typeof s.weight !== 'number' || s.weight <= 0) throw new Error(JSON.stringify(s));
  }
});

// ───────────────────────────────────────────────────── URLs in free text

check('bare urls are found in the spellings people actually use', () => {
  eq(L.extractUrlsFromText('go to https://a.gr/x and www.b.gr and c.gr/deal'),
    ['https://a.gr/x', 'www.b.gr', 'c.gr/deal']);
});

check('trailing punctuation is not part of the url', () => {
  eq(L.extractUrlsFromText('see https://a.gr/x.'), ['https://a.gr/x']);
});

check('an email address is not a url', () => {
  eq(L.extractUrlsFromText('write to anna@example.gr'), []);
});

check('ordinary prose yields nothing', () => {
  eq(L.extractUrlsFromText('No links here. Just a sentence, with punctuation.'), []);
  eq(L.extractUrlsFromText(''), []);
  eq(L.extractUrlsFromText(null), []);
});

// ──────────────────────────────────── the three doors run the SAME gate

// Read UP FRONT, so the assertion below is synchronous.
//
// `check` calls its function and catches what it throws; it does not await.
// A check that returns a promise therefore always passes — the rejection
// becomes an unhandled one and the count says 16/16. That is the
// "verification that cannot fail" shape, and it was in this file's first draft.
const GATE_FILES = ['src/pages/api/contact.ts', 'src/pages/api/newsletter.ts', 'src/pages/api/content/[type]/index.ts'];
const gateSources = new Map();
for (const rel of GATE_FILES) {
  gateSources.set(rel, await fs.readFile(path.join(ROOT, rel), 'utf8'));
}

check('THE DRIFT IS CLOSED: all three public write paths use the shared gate', () => {
  // Stated as a property rather than by reading each file: the failure was not
  // that one of them was wrong, it was that there were three of them.
  for (const [rel, src] of gateSources) {
    if (!src.includes('publicSubmissionGate')) throw new Error(`${rel} does not use the gate`);
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    if (/captchaCheck\s*\(/.test(code)) throw new Error(`${rel} still calls captchaCheck itself`);
    if (/sharedRateLimitStore\s*\(/.test(code)) throw new Error(`${rel} still rate-limits itself`);
  }
});

if (failures.length) {
  console.error(`\n✗ spam-score: ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error(`  · ${f}`);
  process.exit(1);
}
console.log(`✓ spam-score: ${passed} passed`);
