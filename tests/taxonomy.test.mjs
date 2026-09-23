#!/usr/bin/env node
/**
 * Custom taxonomies (C-128).
 *
 * The roadmap offered "enum-field + filtered list" as today's answer. That is a
 * real workaround and it fails at the first requirement either live shop has: a
 * Brand has a slug, needs its own page, and gets added whenever a supplier
 * signs — not by editing a content type.
 *
 * The tests below are mostly about the two properties that decide whether this
 * is safe to ship on a live shop: it is ADDITIVE (no migration, no record
 * changes shape) and it is NOT DESTRUCTIVE (removing a taxonomy or a term
 * rewrites nothing).
 *
 * Run with:  node tests/taxonomy.test.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadTs, ROOT } from './lib/load.mjs';

const T = await loadTs('src/core/taxonomy.ts');
const read = (rel) => fs.readFile(path.join(ROOT, rel), 'utf8');
const route = await read('src/pages/api/taxonomies/index.ts');
const archive = await read('src/pages/t/[taxonomy]/[term].astro');
const createPath = await read('src/pages/api/posts/index.ts');
const updatePath = await read('src/lib/post-service.ts');
const newEditor = await read('src/pages/admin/posts/new.astro');
const editEditor = await read('src/pages/admin/posts/[id]/edit.astro');
const contentCreate = await read('src/pages/api/content/[type]/index.ts');
const contentUpdate = await read('src/pages/api/content/[type]/[id].ts');
const termLinks = await read('src/lib/taxonomy-links.ts');
const postArticle = await read('src/components/public/PostArticle.astro');
const postRoute = await read('src/pages/blog/[slug].astro');
const termChips = await read('src/components/public/TermChips.astro');

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed += 1; } catch (err) { failures.push(`${name}: ${err.message}`); }
}
function ok(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, what = '') {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
function code(src) {
  return src.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(?:\/\/|\s\*).*$/gm, '');
}

const DEFS = T.validateTaxonomies([
  { slug: 'brand', label: 'Brand', labelPlural: 'Brands', appliesTo: ['post', 'product'], publicArchive: true },
  { slug: 'supplier', label: 'Supplier', appliesTo: ['product'] },
]).defs;

/* ──────────────────────────────────────────────── defining them */

check('a valid set is accepted whole', () => {
  eq(DEFS.length, 2);
  eq(DEFS[0].slug, 'brand');
  eq(DEFS[1].publicArchive, false, 'publicArchive must default to OFF');
});

check('nothing configured is not an error', () => {
  // An install that has never defined one must not see a validation failure.
  for (const empty of [null, undefined, []]) {
    const out = T.validateTaxonomies(empty);
    ok(out.ok, JSON.stringify(out.errors));
    eq(out.defs, []);
  }
});

check('a stored STRING is parsed — the relational driver stores settings as TEXT', () => {
  const out = T.validateTaxonomies(JSON.stringify([{ slug: 'brand', label: 'Brand', appliesTo: ['post'] }]));
  ok(out.ok, JSON.stringify(out.errors));
  eq(out.defs[0].slug, 'brand');
});

check('RESERVED SLUGS ARE REFUSED', () => {
  // `/t/category/x` beside `/blog/category/x` is two routes for one idea, and
  // the second one an operator builds on will be the wrong one.
  for (const slug of ['category', 'categories', 'tag', 'tags', 'author', 'date']) {
    const out = T.validateTaxonomies([{ slug, label: 'X', appliesTo: ['post'] }]);
    ok(!out.ok, `${slug} was accepted`);
    ok(out.errors[0].includes(slug), out.errors[0]);
  }
});

check('a duplicate slug is refused, and the message says which', () => {
  const out = T.validateTaxonomies([
    { slug: 'brand', label: 'A', appliesTo: ['post'] },
    { slug: 'brand', label: 'B', appliesTo: ['post'] },
  ]);
  ok(!out.ok);
  ok(/defined twice/.test(out.errors[0]), out.errors[0]);
});

check('A TAXONOMY ATTACHED TO NOTHING IS REFUSED', () => {
  // It would render nowhere and could never be filled — and the operator would
  // find out by it simply not appearing.
  const out = T.validateTaxonomies([{ slug: 'brand', label: 'Brand', appliesTo: [] }]);
  ok(!out.ok);
  ok(/applies to nothing/.test(out.errors[0]), out.errors[0]);
});

check('a nameless taxonomy is refused', () => {
  ok(!T.validateTaxonomies([{ slug: 'brand', appliesTo: ['post'] }]).ok);
});

check('the count is bounded', () => {
  const many = Array.from({ length: T.MAX_TAXONOMIES + 1 }, (_, i) => ({ slug: `t${i}`, label: 'T', appliesTo: ['post'] }));
  ok(!T.validateTaxonomies(many).ok);
});

check('a bad entry does not take the good ones down with it', () => {
  const out = T.validateTaxonomies([
    { slug: 'brand', label: 'Brand', appliesTo: ['post'] },
    { slug: 'NOT A SLUG', label: 'X', appliesTo: ['post'] },
  ]);
  ok(!out.ok, 'it should still report a problem');
  eq(out.defs.map((d) => d.slug), ['brand'], 'the valid one was discarded too');
});

/* ──────────────────────────────────────────────── term slugs */

check('GREEK SURVIVES SLUGGING', () => {
  // Both live installs write Greek. An ASCII-only rule reduces "Ωμέγα" to the
  // empty string, and the assignment is then silently dropped — the record
  // saves, the term is not on it, and nothing says why. The first draft of this
  // module had exactly that bug: `termSlug` emitted Greek and `isTermSlug`
  // rejected it.
  const slug = T.termSlug('Ωμέγα');
  ok(slug.length > 0, 'the slug is empty');
  ok(T.isTermSlug(slug), `termSlug produced "${slug}", which its own validator rejects`);
});

check('...and so does a round trip through a mixed name', () => {
  const slug = T.termSlug('Ray-Ban Ωμέγα Ómega!!');
  ok(T.isTermSlug(slug), slug);
  ok(slug.includes('ray-ban'), slug);
});

check('a term slug is lower-case, hyphenated and bounded', () => {
  eq(T.termSlug('  Ray-Ban  '), 'ray-ban');
  eq(T.termSlug('A & B'), 'a-b');
  ok(T.termSlug('x'.repeat(100)).length <= 40);
});

check('an unusable name produces an empty slug rather than a bad one', () => {
  for (const junk of ['', '   ', '!!!', null, undefined]) {
    eq(T.termSlug(junk), '', JSON.stringify(junk));
    ok(!T.isTermSlug(T.termSlug(junk)), 'an empty slug passed validation');
  }
});

check('a TAXONOMY slug is ASCII, unlike a term slug', () => {
  // It is a short operator-typed identifier that also appears in code and in a
  // query string.
  ok(T.isTaxonomySlug('lens-type'));
  ok(!T.isTaxonomySlug('ωμεγα'), 'a taxonomy slug should stay ASCII');
  ok(!T.isTaxonomySlug('Brand'), 'upper case');
  ok(!T.isTaxonomySlug('-brand'), 'leading hyphen');
});

/* ──────────────────────────────────────────────── assignment */

check('terms are cleaned against the DEFINITIONS, not the payload', () => {
  const out = T.cleanTerms({ brand: ['ray-ban'], supplier: ['acme'], invented: ['x'] }, DEFS, 'post');
  eq(out, { brand: ['ray-ban'] }, 'supplier does not apply to post; invented does not exist');
});

check('A CLIENT CANNOT INVENT A TAXONOMY BY WRITING TO IT', () => {
  eq(T.cleanTerms({ nonsense: ['x'] }, DEFS, 'post'), undefined);
});

check('a slug that is not a slug is dropped', () => {
  eq(T.cleanTerms({ brand: ['ray-ban', 'NOT A SLUG', 'Upper', '', null, 'x'.repeat(50)] }, DEFS, 'post'),
    { brand: ['ray-ban'] });
});

check('...but a NUMERIC slug is real — a term can be called "2024"', () => {
  eq(T.cleanTerms({ brand: [2024] }, DEFS, 'post'), { brand: ['2024'] });
});

check('the same term twice is one assignment', () => {
  // A list that grows every save is how a record ends up with four hundred
  // copies of "ray-ban".
  eq(T.cleanTerms({ brand: ['ray-ban', 'ray-ban'] }, DEFS, 'post'), { brand: ['ray-ban'] });
});

check('a single value is accepted as well as a list', () => {
  eq(T.cleanTerms({ brand: 'ray-ban' }, DEFS, 'post'), { brand: ['ray-ban'] });
});

check('NOTHING SURVIVING MEANS ABSENT, not an empty object', () => {
  // A record with no terms must be byte-identical to every row written before
  // taxonomies existed — that is what makes this additive.
  for (const nothing of [{}, { brand: [] }, { invented: ['x'] }, null, undefined, 'string', 42, []]) {
    eq(T.cleanTerms(nothing, DEFS, 'post'), undefined, JSON.stringify(nothing));
  }
});

check('A DELETED TAXONOMY DEGRADES TO NOTHING', () => {
  // Removing a taxonomy must not rewrite four hundred posts — that is a
  // migration disguised as a button. The assignment simply stops being read,
  // and comes back if the taxonomy is defined again.
  const record = { title: 'x', terms: { brand: ['ray-ban'] } };
  eq(T.cleanTerms(record.terms, [], 'post'), undefined, 'with no taxonomies defined');
  eq(T.cleanTerms(record.terms, DEFS, 'post'), { brand: ['ray-ban'] }, 'and it returns when redefined');
});

/* ──────────────────────────────────────────────── reading */

check('hasTerm and recordsWithTerm', () => {
  const a = { id: 'a', terms: { brand: ['ray-ban'] } };
  const b = { id: 'b', terms: { brand: ['persol'] } };
  const c = { id: 'c' };
  ok(T.hasTerm(a, 'brand', 'ray-ban'));
  ok(!T.hasTerm(a, 'brand', 'persol'));
  ok(!T.hasTerm(c, 'brand', 'ray-ban'), 'a record with no terms');
  ok(!T.hasTerm(null, 'brand', 'ray-ban'), 'no record at all');
  eq(T.recordsWithTerm([a, b, c], 'brand', 'ray-ban').map((r) => r.id), ['a']);
});

check('term counts, for the row an operator needs to see', () => {
  // "Brand: Ray-Ban (0)" is either a typo or a supplier they never stocked.
  const counts = T.termCounts([
    { terms: { brand: ['ray-ban', 'persol'] } },
    { terms: { brand: ['ray-ban'] } },
    { terms: { supplier: ['acme'] } },
    {},
    null,
  ], 'brand');
  eq(counts, { 'ray-ban': 2, persol: 1 });
});

check('taxonomiesFor narrows by collection', () => {
  eq(T.taxonomiesFor(DEFS, 'post').map((d) => d.slug), ['brand']);
  eq(T.taxonomiesFor(DEFS, 'product').map((d) => d.slug), ['brand', 'supplier']);
  eq(T.taxonomiesFor(DEFS, 'page'), []);
});

/* ──────────────────────────────────────────────── the endpoint */

check('DEFINITIONS are admin, TERMS are editorial', () => {
  // Adding "Ray-Ban" is what whoever stocks the shelves does every week; adding
  // a taxonomy changes what every editor sees on every record.
  const src = code(route);
  const put = src.slice(src.indexOf('export const PUT'), src.indexOf('export const POST'));
  ok(/isAdmin\(locals\)/.test(put), 'defining a taxonomy is not admin-only');
  const post = src.slice(src.indexOf('export const POST'), src.indexOf('export const DELETE'));
  ok(/canAuthorPosts/.test(post), 'adding a term requires more than writing content');
  ok(!/isAdmin/.test(post), 'adding a term is admin-gated, so the shelf-stocker must ask somebody');
});

check('adding an existing term is IDEMPOTENT', () => {
  // Two editors adding "Ray-Ban" at the same moment is normal, and the second
  // must not see a failure.
  ok(/already exists/.test(route), 'a duplicate term is an error');
});

check('REMOVING A TERM DELETES THE RECORD AND NOTHING ELSE', () => {
  const del = code(route).slice(code(route).indexOf('export const DELETE'));
  ok(/deleteCustomEntity/.test(del), 'it does not remove the term');
  for (const rewrite of ['updatePost', 'getPosts', 'updateCustomEntity']) {
    ok(!del.includes(rewrite), `it rewrites records: ${rewrite}`);
  }
});

check('the whole set is validated on write, not one entry', () => {
  ok(/validateTaxonomies\(body\?\.taxonomies\)/.test(code(route)), 'the endpoint has its own rules');
});

check('a definition change is audited', () => {
  ok(/AUDIT\.TAXONOMIES_UPDATE/.test(code(route)), 'nothing records a change to what every editor sees');
});

/* ──────────────────────────────────────────────── both write paths */

check('EVERY collection that can declare a taxonomy can CARRY one', () => {
  // `appliesTo` accepts `product` and any content type name, and for its first
  // version only posts and pages could ever carry a term — so the admin's term
  // counter showed "Ray-Ban (0)" permanently and no record outside those two
  // could be filed under anything. The definition said one thing and the write
  // paths did another.
  const called = (src) => /cleanTerms\(/.test(
    code(src).split('\n').filter((l) => !l.trimStart().startsWith('import ') && !l.includes('} from ')).join('\n'),
  );
  ok(called(contentCreate), 'a custom collection cannot carry a term on create');
  ok(called(contentUpdate), 'a custom collection cannot carry a term on update');
});

check('...but a PUBLIC submission cannot file itself under one', () => {
  // A stranger filling in a contact form has no business choosing a taxonomy,
  // and the field would be one more thing to validate on an anonymous surface.
  const src = code(contentCreate);
  const publicPath = src.slice(src.indexOf('const publicSub'));
  ok(!/cleanTerms/.test(publicPath), 'the public submission path reads terms');
});

check('TERMS ARE CLEANED ON CREATE **AND** ON UPDATE', () => {
  // A rule applied to one and not the other is this codebase's most reliable
  // bug; here it would mean terms could be set on a new post and never changed
  // on an existing one.
  ok(/cleanTerms\(/.test(code(createPath)), 'create ignores terms');
  ok(/cleanTerms\(/.test(code(updatePath)), 'update ignores terms');
});

check('...and both read the RAW body, because no static rule can express the shape', () => {
  ok(/TERMS_FIELD\]/.test(code(createPath)), 'create reads terms through the schema');
  ok(/TERMS_FIELD\]/.test(code(updatePath)), 'update reads terms through the schema');
});

check('an update with no terms key leaves the assignment ALONE', () => {
  // The storage layer merges, so writing `undefined` unconditionally would
  // silently clear every record's terms on any unrelated edit.
  ok(/if \(rawTerms !== undefined\)/.test(code(updatePath)), 'an unrelated edit would clear the terms');
});

/* ──────────────────────────────────────────────── the archive */

check('THE ARCHIVE IS OPT-IN PER TAXONOMY', () => {
  // An internal grouping — supplier, margin band — has no business on the open
  // web unless somebody put it there.
  ok(/publicArchive !== true/.test(code(archive)), 'every taxonomy gets a public page');
  ok(/status: 404/.test(code(archive)), 'it renders an empty page instead of 404ing');
});

check('an unknown TERM is a 404, not an empty page with a made-up heading', () => {
  // Otherwise every misspelling is a live page with zero results, which is a
  // soft 404 with extra steps — indexed, linked, and reported as working.
  ok(/if \(!term\) return new Response\('Not found'/.test(code(archive)), 'an unknown term renders');
});

check('THE ARCHIVE IS REACHABLE — from the ROUTE, so a theme cannot lose it', () => {
  // Nothing linked to it at all at first. Then the links went into the built-in
  // `PostArticle` — which the active theme OVERRIDES, so on the install this
  // was tested against they still never appeared. Three implementations of that
  // slot exist and a theme can supply a fourth.
  //
  // Same conclusion the print button reached: the route renders it.
  ok(/<TermChips post=\{post\} \/>/.test(postRoute), 'the route does not render the term chips');
  ok(/postTermLinks/.test(code(termChips)), 'the chips do not resolve any terms');
  ok(/\/t\/\$\{encodeURIComponent/.test(termLinks), 'the link is not built, or is not encoded');
  // ...and NOT in the article component, where a theme would shadow it.
  ok(!/postTermLinks/.test(code(postArticle)), 'the links are back inside an overridable slot');
});

check('...and only for a taxonomy that opted IN', () => {
  ok(/publicArchive !== true\) continue/.test(code(termLinks)), 'an internal grouping would be published');
});

check('...and never to a term whose record is gone', () => {
  // The archive 404s for it, and a link that 404s is worse than no link.
  ok(/if \(!term\) continue/.test(code(termLinks)), 'a deleted term is still linked');
});

check('A LONG NAME STILL PRODUCES A VALID SLUG', () => {
  // The slice ran BEFORE the hyphen trim, so a name of exactly the wrong length
  // ended in a hyphen — which this module's own validator then rejected, and
  // the API answered 400 for a term whose only sin was being long.
  const long = `${'a'.repeat(39)} b`;
  const slug = T.termSlug(long);
  ok(T.isTermSlug(slug), `termSlug produced "${slug}", which its own validator rejects`);
  ok(!slug.endsWith('-'), slug);
});

check('the route lives under a RESERVED prefix', async () => {
  // A taxonomy named `about` would otherwise take the About page's URL, and the
  // operator would find out from a customer.
  //
  // The first version of this was three worthless lines: a literal `|| true`, a
  // `length > 0` on a non-empty file, and a regex that matched only the route's
  // own PROSE — so the single thing it could detect was somebody rewording a
  // comment. What actually establishes the property is the file's PATH and the
  // reserved-slug list.
  await fs.access(path.join(ROOT, 'src/pages/t/[taxonomy]/[term].astro'));
  const reserved = await read('src/lib/reserved-slugs.ts');
  ok(/'t',/.test(reserved), "`t` is not reserved, so a page can take /t/ from the archive");
});

/* ──────────────────────────────────────────────── the editors */

check('BOTH editors carry the picker', () => {
  ok(/<TermPicker/.test(newEditor), 'posts/new has no term picker');
  ok(/<TermPicker/.test(editEditor), 'posts/[id]/edit has no term picker');
});

check('...AND BOTH ACTUALLY SEND ITS VALUE', () => {
  // The check above passed on a version where the entire feature was inert.
  // Both editors serialise an explicit key list rather than posting the form,
  // so the picker's hidden input was never read: it rendered, it ticked, it
  // synced, and nothing left the browser. Every server-side test still passed,
  // because the server was never asked to do anything.
  //
  // This asserts the SERIALISER reads it, which is the step that was missing.
  // `slice()` on an indexOf that returns -1 takes the REST OF THE FILE. The
  // first version of this looked for `async save(` in posts/new, which does not
  // exist — so it searched 6.8 kB of unrelated code and passed on a version
  // where the serialisation had been moved into a method nothing calls. That is
  // the exact regression this check exists to catch.
  const between = (src, from, to, what) => {
    const a = src.indexOf(from);
    const b = src.indexOf(to);
    ok(a >= 0, `${what}: no "${from}"`);
    ok(b > a, `${what}: no "${to}" after "${from}" — the slice would be the rest of the file`);
    return src.slice(a, b);
  };
  const newPayload = between(newEditor, 'collectPayload(', 'async handleSubmit(', 'posts/new');
  ok(/payload\.terms = parsed/.test(newPayload), 'posts/new never sends terms');
  const editPayload = between(editEditor, 'collectFormData(', 'async handleSubmit(', 'posts/[id]/edit');
  ok(/data\.terms = parsed/.test(editPayload), 'posts/[id]/edit never sends terms');
});

check('the EDIT screen sends terms even when empty, so unticking the last one works', () => {
  // The server reads an absent key as "leave them alone". Sending the field
  // only when non-empty would make removing the final term impossible — the
  // author unticks it, saves, and it comes back.
  const a = editEditor.indexOf('collectFormData(');
  const b = editEditor.indexOf('async handleSubmit(');
  ok(a >= 0 && b > a, 'the serialiser could not be located');
  const editPayload = editEditor.slice(a, b);
  ok(/JSON\.parse\(termsField\.value \|\| '\{\}'\)/.test(editPayload), 'an empty picker sends nothing');
  ok(!/Object\.keys\(parsed\)\.length/.test(editPayload), 'it skips an empty set, so removal is impossible');
});

check('the edit screen passes the record\'s OWN kind and terms', () => {
  // A page's taxonomies are not a post's, and an editor opening an existing
  // record must see what is already on it.
  ok(/collection=\{post\.kind === 'page' \? 'page' : 'post'\}/.test(editEditor), 'it assumes every record is a post');
  ok(/value=\{\(post as any\)\.terms/.test(editEditor), 'existing terms are not shown');
});

check('the picker import is in the FRONTMATTER, not the script block', () => {
  // An `.astro` file's frontmatter and each <script> are separate module
  // scopes. A component imported into the script block is not available to the
  // template — this codebase has hit that seven times, and the first draft of
  // this change made it an eighth.
  const frontmatter = editEditor.slice(0, editEditor.indexOf('\n---', 3));
  ok(/import TermPicker/.test(frontmatter), 'the import is outside the frontmatter');
});

if (failures.length) {
  console.error(`\n✗ taxonomy: ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error(`  · ${f}`);
  process.exit(1);
}
console.log(`✓ taxonomy: ${passed} passed`);
