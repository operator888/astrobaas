#!/usr/bin/env node
/**
 * The editor's content analysis (src/lib/content-analysis.ts).
 *
 * The failure that matters here is a FALSE ALARM. An author told twice that a
 * correct page is wrong stops reading the panel, and then the real problems go
 * unfixed too. So most of these assertions are about what must NOT be reported:
 *
 *   · a blank meta_title on a page that renders the post title;
 *   · a missing keyphrase counted as a failure on a post that targets none;
 *   · missing subheadings on a 120-word note;
 *   · a Flesch score computed over Greek by an English syllable counter.
 *
 * Run with:  node tests/content-analysis.test.mjs
 */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const cacheDir = path.join(root, 'node_modules', '.cache');
await fs.mkdir(cacheDir, { recursive: true });
const out = path.join(cacheDir, `astrobaas-canalysis-${process.pid}.mjs`);
await build({
  entryPoints: [path.join(root, 'src/lib/content-analysis.ts')],
  bundle: true, format: 'esm', platform: 'node', packages: 'external',
  outfile: out, logLevel: 'silent',
});
const A = await import(pathToFileURL(out).href);

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
const verdict = (r, id) => r.checks.find((c) => c.id === id)?.verdict;
const body = (n) => `<p>${'word '.repeat(n).trim()}.</p>`;
const LONG = `<h2>One</h2>${body(200)}<h2>Two</h2>${body(200)}`;

// ─────────────────────────────────────────────────────────── the effective title

check('a blank meta_title is NOT reported when the post title renders', () => {
  // blog/[slug].astro falls back to the post title. Scoring the blank field as
  // "missing" is a lie about the page, and it is the first false alarm an
  // author would meet.
  const r = A.analyzeContent({ title: 'A perfectly good post title here', content: LONG, locale: 'en' });
  eq(verdict(r, 'title'), 'good');
});

check('meta_title WINS when it is set', () => {
  const r = A.analyzeContent({ title: 'x', meta_title: 'A perfectly good meta title here', content: LONG });
  eq(verdict(r, 'title'), 'good');
});

check('no title at all is bad', () => {
  eq(verdict(A.analyzeContent({ content: LONG }), 'title'), 'bad');
});

check('an over-long title is improve, not bad', () => {
  // 60 is where a search result is CUT, not a rule. A 70-character title is a
  // judgement the author is allowed to make.
  const r = A.analyzeContent({ title: 'x'.repeat(75), content: LONG });
  eq(verdict(r, 'title'), 'improve');
});

check('the description falls back to the excerpt, like the page does', () => {
  const r = A.analyzeContent({ title: 'T'.repeat(30), excerpt: 'd'.repeat(100), content: LONG });
  eq(verdict(r, 'description'), 'good');
});

// ──────────────────────────────────────────────────────────── the keyphrase

check('NO keyphrase is unknown, never a failure', () => {
  // Most posts do not target a phrase. Marking that red would make the dot red
  // on a perfectly good article.
  const r = A.analyzeContent({ title: 'T'.repeat(30), content: LONG });
  eq(verdict(r, 'keyphrase'), 'unknown');
  if (r.checks.some((c) => c.id.startsWith('kp-'))) throw new Error('ran keyphrase checks with no keyphrase');
});

check('an unknown check does not drag the score down', () => {
  const withPhrase = A.analyzeContent({ title: 'Sunglasses for summer days', content: LONG, focus_keyphrase: 'nowhere' });
  const without = A.analyzeContent({ title: 'Sunglasses for summer days', content: LONG });
  if (!(without.score >= withPhrase.score)) throw new Error(`unknown penalised: ${without.score} vs ${withPhrase.score}`);
});

check('the keyphrase is matched through the SEARCH FOLD', () => {
  // A Greek author's «Γυαλιά Ηλίου» must match a body that says «γυαλιά ηλίου».
  // Accents and capitals are not a different phrase, and a checker that says
  // otherwise is wrong on every Greek page.
  const r = A.analyzeContent({
    title: 'Γυαλιά Ηλίου για το καλοκαίρι',
    content: '<h2>Επιλογή</h2><p>Τα γυαλιά ηλίου προστατεύουν. ' + 'λέξη '.repeat(300) + '</p>',
    focus_keyphrase: 'γυαλιά ηλίου',
    locale: 'el',
  });
  eq(verdict(r, 'kp-title'), 'good');
  eq(verdict(r, 'kp-body'), 'good');
});

check('a keyphrase absent from the body is BAD, and stuffing is bad too', () => {
  const missing = A.analyzeContent({ title: 'T'.repeat(30), content: LONG, focus_keyphrase: 'nowhere at all' });
  eq(verdict(missing, 'kp-body'), 'bad');
  const stuffed = A.analyzeContent({
    title: 'T'.repeat(30),
    content: `<h2>a</h2><p>${'lenses '.repeat(60)}${'word '.repeat(140)}</p>`,
    focus_keyphrase: 'lenses',
  });
  eq(verdict(stuffed, 'kp-body'), 'bad');
});

// ─────────────────────────────────────────────────────────────── readability

check('Flesch is UNKNOWN outside English', () => {
  // The syllable model has no validated Greek or German port. A number from an
  // English counter over Greek text is a figure nobody can trace to a fact.
  for (const locale of ['el', 'de', 'el-GR', 'de-AT']) {
    eq(verdict(A.analyzeContent({ title: 'T'.repeat(30), content: LONG, locale }), 'flesch'), 'unknown', locale);
  }
});

check('Flesch IS computed for English', () => {
  const v = verdict(A.analyzeContent({ title: 'T'.repeat(30), content: LONG, locale: 'en' }), 'flesch');
  if (v === 'unknown') throw new Error('English got no reading-ease score');
});

check('a SHORT note is not told off for having no subheadings', () => {
  // Demanding subheadings on 120 words is exactly the false alarm that gets the
  // panel ignored.
  const r = A.analyzeContent({ title: 'T'.repeat(30), content: body(120), locale: 'en' });
  eq(verdict(r, 'headings'), 'good');
});

check('a LONG article with no subheadings is bad', () => {
  const r = A.analyzeContent({ title: 'T'.repeat(30), content: body(600), locale: 'en' });
  eq(verdict(r, 'headings'), 'bad');
});

check('sentence length uses the GREEK-aware splitter', () => {
  // With a Latin-only splitter this whole text is one sentence and reports
  // "far too long" — permanently, on both live shops.
  const greek = `<h2>Τίτλος</h2><p>${'Τι κάνεις; Καλά είμαι. '.repeat(60)}</p>`;
  eq(verdict(A.analyzeContent({ title: 'T'.repeat(30), content: greek, locale: 'el' }), 'sentences'), 'good');
});

// ───────────────────────────────────────────────────────────────── noindex

check('a noindexed page is GREY, with one explanation and no red checks', () => {
  // Scoring discoverability on a page deliberately hidden from search is noise.
  const r = A.analyzeContent({ content: '', noindex: true });
  eq(r.dot, 'grey');
  eq(r.checks.length, 1);
  eq(r.checks[0].verdict, 'unknown');
});

check('a site-wide noindex does the same, and says which it is', () => {
  const r = A.analyzeContent({ content: LONG, siteNoindex: true });
  eq(r.dot, 'grey');
  if (!/whole site/i.test(r.checks[0].text)) throw new Error(r.checks[0].text);
});

check('a noindexed page still reports its stats', () => {
  const r = A.analyzeContent({ content: LONG, noindex: true });
  if (r.stats.words < 100) throw new Error(JSON.stringify(r.stats));
});

// ─────────────────────────────────────────────────────────────────── images

check('images with no alt are BAD; an empty alt is not counted', () => {
  const r = A.analyzeContent({
    title: 'T'.repeat(30),
    content: `${LONG}<img src="/a.webp"><img src="/b.webp" alt="">`,
  });
  eq(verdict(r, 'images'), 'bad');
  const ok = A.analyzeContent({ title: 'T'.repeat(30), content: `${LONG}<img src="/b.webp" alt="">` });
  eq(verdict(ok, 'images'), 'good');
});

check('no images at all is improve, not bad', () => {
  eq(verdict(A.analyzeContent({ title: 'T'.repeat(30), content: LONG }), 'images'), 'improve');
});

// ────────────────────────────────────────────────────────────────── output

check('stats come from the shared parsers, not a second set of regexes', () => {
  const r = A.analyzeContent({
    title: 'T'.repeat(30),
    content: '<h2>A</h2><h3>B</h3><p>one two three</p><a href="/x">i</a><a href="https://y.test">e</a><img src="/z.webp" alt="z">',
  });
  eq(r.stats.headings, 2);
  eq(r.stats.links, 2);
  eq(r.stats.images, 1);
});

check('the score is 0–100 and the dot follows it', () => {
  for (const facts of [{}, { content: LONG }, { title: 'T'.repeat(30), content: LONG, locale: 'en' }]) {
    const r = A.analyzeContent(facts);
    if (r.score < 0 || r.score > 100) throw new Error(`score ${r.score}`);
    if (!['green', 'amber', 'red', 'grey'].includes(r.dot)) throw new Error(`dot ${r.dot}`);
  }
});

check('empty input does not throw', () => {
  const r = A.analyzeContent({});
  eq(r.stats, { words: 0, headings: 0, links: 0, images: 0 });
});

check('the analysis is deterministic', () => {
  const facts = { title: 'T'.repeat(30), content: LONG, locale: 'en', focus_keyphrase: 'word' };
  eq(A.analyzeContent(facts), A.analyzeContent(facts));
});

// ───────────────────────────────────────── the keyphrase in a HYPHENATED slug

check('a MULTI-WORD keyphrase is found in the slug', () => {
  // The check compared a hyphenated slug against a space-separated phrase.
  // foldForSearch folds case and accents and collapses whitespace; it never
  // turns a hyphen into a space. So `sunglasses-for-summer` could not contain
  // `sunglasses for summer`, and the panel reported "the keyphrase is not in
  // the URL" for a URL that is nothing BUT the keyphrase — for every multi-word
  // keyphrase, which is most of them. An author acting on it edits a slug that
  // was already right.
  const r = A.analyzeContent({
    title: 'Sunglasses for summer', content: LONG,
    slug: 'sunglasses-for-summer', focus_keyphrase: 'sunglasses for summer',
  });
  eq(verdict(r, 'kp-slug'), 'good');
});

check('a single-word keyphrase still works', () => {
  const r = A.analyzeContent({
    title: 'Sunglasses', content: LONG, slug: 'sunglasses', focus_keyphrase: 'sunglasses',
  });
  eq(verdict(r, 'kp-slug'), 'good');
});

check('an underscore slug is read the same way', () => {
  const r = A.analyzeContent({
    title: 'x', content: LONG, slug: 'sunglasses_for_summer', focus_keyphrase: 'sunglasses for summer',
  });
  eq(verdict(r, 'kp-slug'), 'good');
});

check('a keyphrase genuinely absent from the slug is STILL reported', () => {
  // The fix must not turn the check into one that always passes.
  const r = A.analyzeContent({
    title: 'x', content: LONG, slug: 'winter-boots', focus_keyphrase: 'sunglasses for summer',
  });
  eq(verdict(r, 'kp-slug'), 'improve');
});

check('a GREEK keyphrase is found in an accented slug', () => {
  // The shops that run this write Greek. foldForSearch folds the accents, and
  // the hyphens are the same problem in any language.
  const r = A.analyzeContent({
    title: 'x', content: LONG, slug: 'γυαλια-ηλιου-καλοκαιρι', focus_keyphrase: 'γυαλιά ηλίου καλοκαίρι',
  });
  eq(verdict(r, 'kp-slug'), 'good');
});

if (failures.length) {
  console.error(`\n✗ content-analysis: ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error(`  · ${f}`);
  process.exit(1);
}
console.log(`✓ content-analysis: ${passed} passed`);
