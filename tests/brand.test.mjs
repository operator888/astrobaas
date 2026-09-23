#!/usr/bin/env node
/**
 * Brands: one maker, however it was typed.
 *
 * THE TEST THE SHOP OWNER ASKED FOR, in their own words: "A shop whose products
 * spell one brand three ways, asserting that filtering by any one spelling
 * returns all of them, and that a brand listing shows one entry rather than
 * three."
 *
 * It comes from a live catalogue: 447 products, 72 distinct brand strings, 62
 * actual makers. `?brand=Rayban` returned 16 of 17; `?brand=Ray-Ban` returned
 * none. Nobody notices until a customer tries it.
 *
 * The properties defended here:
 *
 *  1. **Filtering matches the maker, not the spelling.** Any spelling finds all
 *     of them, including the slug form older WooCommerce imports stored.
 *  2. **The listing and the filter agree.** The count beside a brand IS the
 *     number of products you get when you click it. Two groupings would show
 *     `Ray-Ban (1)` beside `Rayban (16)` and hand you 17 from either.
 *  3. **Nothing merges that should not.** `Tipi Diversi` and `Tipi Diversi
 *     Clip` are different product lines in that shop; `SOLANO` is not `Solano
 *     Clips`. A prefix rule would have merged both, and the owner said so.
 *  4. **A published slug leads back to its brand.** `GET /api/brands` listed
 *     `Straße` (slug `strasse`), `Γυαλιά Όψη` (slug `gyalia-opsi`) and a
 *     curated `Ray-Ban` (slug `rb`) with their counts, and `?brand=<slug>`
 *     returned NOTHING for all three — `slugify` transliterates, the filter's
 *     key does not, and a curated slug is not a spelling of anything. Checked
 *     on the pure directory AND on the real routes over a real database.
 *
 * Run with:  node tests/brand.test.mjs
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadTs, ROOT } from './lib/load.mjs';

const B = await loadTs('src/lib/commerce/brand.ts');

let pass = 0;
let fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };

/* ------------------------------------------------- the real catalogue */
// Exactly the spread the shop reported, so a regression is measured against
// data that actually existed rather than against a tidy invention.
const CATALOGUE = [
  ...Array(16).fill('Rayban'), 'RAYBAN',
  ...Array(52).fill('Symbol'), ...Array(9).fill('SYMBOL'), 'Symbol ', 'Symbol ',
  ...Array(4).fill('Dalet'), ...Array(6).fill('DALET'),
  ...Array(6).fill('Solano Clips'), 'Solano clips', 'Solano clips', 'SOLANO', 'SOLANO',
  ...Array(5).fill('Tipi Diversi'), ...Array(3).fill('Tipi Diversi Clip'),
  // The four products with no brand at all.
  '', '   ', null, undefined,
].map((brand, i) => ({ id: `p${i}`, brand, status: 'active' }));

/* ------------------------------------------------- the key */
{
  check('case is not identity', B.sameBrand('Rayban', 'RAYBAN'));
  check('a trailing space is not identity', B.sameBrand('Symbol', 'Symbol '));
  check('...nor a doubled inner space', B.sameBrand('Tipi  Diversi', 'Tipi Diversi'));
  // The owner's own failing example.
  check('a hyphen is not identity — ?brand=Ray-Ban must find Rayban',
    B.sameBrand('Ray-Ban', 'Rayban'));
  // The two vocabularies stored brands come in: shops the WooCommerce importer
  // filled before it kept names hold a SLUG, the admin form stores display
  // text. A menu built from either must find both.
  check('the importer\'s slug form matches the admin form\'s display text',
    B.sameBrand('ray-ban', 'Ray Ban') && B.sameBrand('ray-ban', 'RAYBAN'));

  // Greek, since both live shops write it.
  check('Greek accents are not identity', B.sameBrand('Γυαλιά', 'ΓΥΑΛΙΑ'));
  check('...and final sigma is the same letter', B.sameBrand('Σκελετός', 'σκελετοσ'));

  /* THE MERGES THAT MUST NOT HAPPEN — the owner named both. */
  check('a whole extra WORD is a different maker: Tipi Diversi ≠ Tipi Diversi Clip',
    !B.sameBrand('Tipi Diversi', 'Tipi Diversi Clip'));
  check('...and SOLANO ≠ Solano Clips', !B.sameBrand('SOLANO', 'Solano Clips'));
  check('...and two unrelated makers stay apart', !B.sameBrand('Rayban', 'Persol'));

  // Absent is not a brand. Otherwise every unbranded product joins one nameless
  // maker and the menu grows an entry for it.
  check('unbranded is not a brand', !B.sameBrand('', ''));
  check('...nor is whitespace, null or a non-string',
    !B.sameBrand('   ', '   ') && !B.sameBrand(null, null) && !B.sameBrand(7, 7));
  check('punctuation alone is not a brand', B.brandKey('---') === '');
}

/* ------------------------------------------------- the listing */
{
  const summaries = B.summarizeBrands(CATALOGUE);

  // THE OWNER'S TEST, first half: one entry, not three.
  // Looked up by KEY, not by display name, and read with `?.` throughout: a
  // mutation that changes which spelling is displayed must produce a failed
  // assertion naming the property, not a TypeError that reads as a broken test.
  const rayban = summaries.find((s) => s.key === 'rayban');
  check('one maker, one listing entry — not one per spelling',
    summaries.filter((s) => s.key === 'rayban').length === 1);
  check('...counting every spelling', rayban?.count === 17);
  check('...displayed as the spelling the most products use', rayban?.name === 'Rayban');
  check('...and showing the variants, so an operator can SEE them',
    rayban?.spellings.length === 2 && rayban?.spellings[0].count === 16);

  const symbol = summaries.find((s) => s.key === 'symbol');
  check('a trailing-space variant folds into its spelling rather than becoming a third',
    symbol?.count === 63 && symbol?.spellings.length === 2);

  // The separations, in the listing this time.
  const byKey = (k) => summaries.find((s) => s.key === k);
  check('Solano Clips and SOLANO remain two entries',
    byKey('solanoclips')?.count === 8 && byKey('solano')?.count === 2);
  check('Tipi Diversi and Tipi Diversi Clip remain two entries',
    byKey('tipidiversi')?.count === 5 && byKey('tipidiversiclip')?.count === 3);

  check('unbranded products contribute no maker at all',
    !summaries.some((s) => s.key === '' || s.name.trim() === ''));
  check('62-for-72 becomes an honest count', summaries.length === 7);

  /* PROPERTY 2 — the listing and the filter cannot disagree. */
  const filterCount = (term) =>
    CATALOGUE.filter((p) => B.sameBrand(p.brand, term)).length;
  check('EVERY listed count equals what filtering by that brand returns',
    summaries.every((s) => filterCount(s.name) === s.count));
  check('...and equals what filtering by ANY of its spellings returns',
    summaries.every((s) => s.spellings.every((sp) => filterCount(sp.name) === s.count)));
}

/* ------------------------------------------------- the owner's headline case */
{
  // Spelled three ways; filtering by any one returns all of them.
  const shop = [
    ...Array(16).fill('Rayban'), 'RAYBAN', 'Ray-Ban',
  ].map((brand, i) => ({ id: `x${i}`, brand }));

  for (const spelling of ['Rayban', 'RAYBAN', 'Ray-Ban', 'ray-ban', 'RAY BAN', 'rayban']) {
    check(`filtering by "${spelling}" returns all 18`,
      shop.filter((p) => B.sameBrand(p.brand, spelling)).length === 18);
  }
  const listed = B.summarizeBrands(shop);
  check('and the listing shows ONE entry, not three', listed.length === 1);
  check('...with the full count', listed[0].count === 18);
}

/* ------------------------------------------------- storage tidying */
{
  check('a trailing space is trimmed on write', B.normalizeBrand('Symbol ') === 'Symbol');
  check('inner whitespace is collapsed', B.normalizeBrand('Tipi   Diversi') === 'Tipi Diversi');
  check('case is NOT changed — the stored spelling is what a storefront renders',
    B.normalizeBrand('RAYBAN') === 'RAYBAN');
  check('an empty brand becomes absent, not an empty string',
    B.normalizeBrand('   ') === undefined && B.normalizeBrand('') === undefined);
  check('a non-string is absent', B.normalizeBrand(7) === undefined && B.normalizeBrand(null) === undefined);
  check('an absurd length is capped', B.normalizeBrand('x'.repeat(500)).length === 120);
}

/* ------------------------------------------------- suggestions, never merges */
{
  const pairs = B.relatedBrandPairs(B.summarizeBrands(CATALOGUE));
  const named = (a, b) => pairs.some((p) => p.a === a && p.b === b);
  check('a shorter brand contained in a longer one is REPORTED',
    named('SOLANO', 'Solano Clips'));
  check('...including the owner\'s own counter-example, which must never be merged',
    named('Tipi Diversi', 'Tipi Diversi Clip'));
  check('every suggestion says why, in words an operator can act on',
    pairs.every((p) => typeof p.reason === 'string' && p.reason.length > 20));
  check('unrelated makers are not suggested',
    !pairs.some((p) => p.a === 'Rayban' || p.b === 'Rayban'));

  // The point of the whole function: it reports and changes nothing.
  const before = JSON.stringify(CATALOGUE);
  B.relatedBrandPairs(B.summarizeBrands(CATALOGUE));
  check('reporting mutates nothing', JSON.stringify(CATALOGUE) === before);
}

/* ------------------------------------------------- PROPERTY 4: a slug leads back */
//
// Every call into the directory goes through `?.`, so a revert that removes it
// produces ✗ lines naming the property rather than a TypeError.
{
  const shop = [
    'Straße', 'Straße',
    'Γυαλιά Όψη', 'Γυαλιά Όψη', 'Γυαλιά Όψη',
    'Rayban', 'RAYBAN', 'Ray-Ban',
    'Solano Clips', 'Solano clips', 'SOLANO',
    'Tipi Diversi', 'Tipi Diversi', 'Tipi Diversi Clip',
  ].map((brand, i) => ({ id: `d${i}`, brand, status: 'active' }));
  // A draft carries a brand too; it must be neither counted nor returned.
  shop.push({ id: 'draft', brand: 'Straße', status: 'draft' });
  const dir = B.buildBrandDirectory?.(shop, [{ id: 'b-rb', name: 'Ray-Ban', slug: 'rb' }]);
  const entries = dir?.entries ?? [];
  const byKey = (k) => entries.find((e) => e.key === k);
  // What `?brand=<value>` returns over this catalogue: the predicate
  // listProducts applies — resolve the value, then compare identities. -1 for
  // a value that resolves to no brand, so it can never equal a count.
  const filtered = (value) => {
    const want = dir?.keyFor?.(value) ?? '';
    return want ? shop.filter((p) => p.status === 'active' && B.brandKey(p.brand) === want).length : -1;
  };

  // The three cases reproduced by execution before the fix: each was listed
  // with its count, and filtering by its slug returned 0.
  check('"Straße" publishes the slug "strasse"', byKey('straße')?.slug === 'strasse');
  check('...and ?brand=strasse returns its 2 active products, not 0',
    filtered('strasse') === 2 && byKey('straße')?.count === 2);
  check('a Greek name publishes a transliterated slug: "gyalia-opsi"', byKey('γυαλιαοψη')?.slug === 'gyalia-opsi');
  check('...and ?brand=gyalia-opsi returns its 3 products, not 0',
    filtered('gyalia-opsi') === 3 && byKey('γυαλιαοψη')?.count === 3);
  check('a curated record keeps the slug it was given: "rb"',
    byKey('rayban')?.slug === 'rb' && byKey('rayban')?.curated === true);
  check('...and ?brand=rb returns all 3 spellings of Ray-Ban, not 0',
    filtered('rb') === 3 && byKey('rayban')?.count === 3);

  // THE INVARIANT the listing promises, over every entry it publishes.
  const broken = entries.filter((e) => filtered(e.slug) !== e.count).map((e) => `${e.name}→${e.slug}`);
  check(`EVERY listed brand: filtering by its slug returns exactly its count${broken.length ? ` (broken: ${broken.join(', ')})` : ''}`,
    entries.length === 7 && broken.length === 0);
  check('slugs are unique across the listing', entries.length > 0 && new Set(entries.map((e) => e.slug)).size === entries.length);

  // Names keep working: a value that is not a published slug is matched by identity.
  check('every spelling of a name still finds its brand',
    ['Rayban', 'RAYBAN', 'Ray-Ban', 'ray ban'].every((v) => filtered(v) === 3));
  check('...and a Greek name typed without accents still finds its products', filtered('ΓΥΑΛΙΑ ΟΨΗ') === 3);

  // The merges that must not happen, through slugs this time.
  check('Tipi Diversi and Tipi Diversi Clip keep separate slugs and counts',
    byKey('tipidiversi')?.slug !== byKey('tipidiversiclip')?.slug
      && filtered(byKey('tipidiversi')?.slug) === 2 && filtered(byKey('tipidiversiclip')?.slug) === 1);
  check('SOLANO and Solano Clips keep separate slugs and counts',
    filtered(byKey('solano')?.slug) === 1 && filtered(byKey('solanoclips')?.slug) === 2);
  check('an empty or punctuation-only value names no brand',
    dir?.keyFor?.('') === '' && dir?.keyFor?.('---') === '' && dir?.keyFor?.(undefined) === '');
}

/* ------------------------------------------------- when two makers slugify alike */
//
// `Straße` and `Strasse` are different keys that both slugify to `strasse`;
// `Όψη` and `Opsi` both to `opsi`. A slug two entries share can lead to only
// one of them, so the directory must hand out unique slugs — without letting a
// slug re-point another maker's NAME, and without depending on product order.
{
  const shop = ['Straße', 'Straße', 'Strasse', 'Strasse', 'Strasse', 'Όψη', 'Opsi', 'Opsi', 'RB', 'RB', 'Rayban']
    .map((brand, i) => ({ id: `c${i}`, brand, status: 'active' }));
  const curated = [{ id: 'b1', name: 'Ray-Ban', slug: 'rb' }];
  const dir = B.buildBrandDirectory?.(shop, curated);
  const all = dir?.entries ?? [];
  const e = (k) => all.find((x) => x.key === k);
  const count = (value) => {
    const want = dir?.keyFor?.(value) ?? '';
    return want ? shop.filter((p) => B.brandKey(p.brand) === want).length : -1;
  };

  check('makers that slugify alike never share a slug',
    all.length === 6 && new Set(all.map((x) => x.slug)).size === 6);
  check('the maker whose NAME the slug is keeps it: Strasse is "strasse"', e('strasse')?.slug === 'strasse');
  check('...so ?brand=strasse still means Strasse (3), exactly as before', count('strasse') === 3);
  check('...and Straße gets a stable suffix that leads to its own 2',
    /^strasse-[a-z0-9]+$/.test(e('straße')?.slug ?? '') && count(e('straße')?.slug) === 2);
  check('a Greek maker never takes a Latin maker\'s name as its slug: Opsi keeps "opsi"',
    e('opsi')?.slug === 'opsi' && count('opsi') === 2);
  check('...and Όψη\'s own slug leads to Όψη', count(e('οψη')?.slug) === 1);
  check('a curated slug wins over another maker\'s name: "rb" is Ray-Ban, which has its own product',
    e('rayban')?.slug === 'rb' && count('rb') === 1);
  check('...and the maker actually called RB gets its own slug, which leads to its 2',
    e('rb')?.slug !== 'rb' && count(e('rb')?.slug) === 2);

  // The SHADOW rule, where key order alone would not save it. The maker keyed
  // `strasse` DISPLAYS as `Stras-se`, so it publishes `stras-se` and never asks
  // for `strasse` — which leaves `strasse` free for Straße to take, and would
  // silently re-point `?brand=strasse`, a name that has always meant Stras-se.
  const hy = B.buildBrandDirectory?.([
    { id: 'h1', brand: 'Stras-se', status: 'active' },
    { id: 'h2', brand: 'Straße', status: 'active' },
  ], []);
  const hyE = (k) => hy?.entries?.find((x) => x.key === k);
  const hyCount = (value) => {
    const want = hy?.keyFor?.(value) ?? '';
    return want ? ['Stras-se', 'Straße'].filter((b) => B.brandKey(b) === want).length : -1;
  };
  check('a slug never re-points another maker\'s NAME: Straße does not take "strasse" from Stras-se',
    hyE('strasse')?.slug === 'stras-se' && /^strasse-[a-z0-9]+$/.test(hyE('straße')?.slug ?? ''));
  check('...so ?brand=strasse still means Stras-se, and each slug leads to its own maker',
    hy?.keyFor?.('strasse') === 'strasse' && hyCount(hyE('straße')?.slug) === 1 && hyCount('stras-se') === 1);

  const reversed = B.buildBrandDirectory?.([...shop].reverse(), curated);
  const slugsOf = (d) => JSON.stringify((d?.entries ?? []).map((x) => [x.key, x.slug]).sort());
  check('the same catalogue in another order publishes the same slugs',
    reversed !== undefined && all.length > 0 && slugsOf(reversed) === slugsOf(dir));
  // And where NO rule settles it: Ψάρι and Πσάρι both slugify to `psari`, and
  // `psari` is neither one's name — only the order of claims decides, so the
  // order must be the keys', never the products'.
  const pair = ['Ψάρι', 'Πσάρι', 'Πσάρι'].map((brand, i) => ({ id: `g${i}`, brand, status: 'active' }));
  const fwd = B.buildBrandDirectory?.(pair);
  const back = B.buildBrandDirectory?.([...pair].reverse());
  check('two makers that slugify alike, neither of which the slug names, get the same slugs in any order',
    (fwd?.entries?.length ?? 0) === 2 && slugsOf(fwd) === slugsOf(back)
      && new Set((fwd?.entries ?? []).map((x) => x.slug)).size === 2);

  // Two curated records for one maker (a hand-made duplicate): the later is
  // shown, as before — and the earlier one's slug keeps leading to the maker,
  // because a legacy URL or an importer link may have been built from it.
  const two = B.buildBrandDirectory?.([{ id: 'x', brand: 'Rayban', status: 'active' }],
    [{ id: 'old', name: 'Ray-Ban', slug: 'ray-ban-old' }, { id: 'new', name: 'Ray Ban', slug: 'rb' }]);
  check('two curated records for one maker: one entry, the later record', two?.entries?.length === 1 && two?.entries?.[0]?.slug === 'rb');
  check('...and the earlier record\'s slug still leads to the maker', two?.keyFor?.('ray-ban-old') === 'rayban');
}

/* ------------------------------------------------- a suffixed slug outlives its collision */
//
// Storefronts cache brand pages. A suffix exists because of a collision, and
// the collision can go away (Strasse's last product becomes a draft) or the
// displayed spelling can change (most products get retyped) — neither may
// turn a cached link into an empty page.
{
  const mk = (list) => list.map((brand, i) => ({ id: `u${i}`, brand, status: 'active' }));
  const both = B.buildBrandDirectory?.(mk(['Straße', 'Straße', 'Strasse']));
  const suffixed = both?.entries?.find((x) => x.key === 'straße')?.slug ?? '';
  check('while Strasse exists, Straße publishes a suffixed slug', /^strasse-[a-z0-9]+$/.test(suffixed));
  const alone = B.buildBrandDirectory?.(mk(['Straße', 'Straße']));
  check('...and once Strasse is gone, that cached slug still leads to Straße',
    suffixed !== '' && alone?.keyFor?.(suffixed) === 'straße');
  const retyped = B.buildBrandDirectory?.(mk(['Stra-ße', 'Stra-ße', 'Stra-ße', 'Straße', 'Strasse']));
  check('...and so it does after most products are retyped under another spelling',
    suffixed !== '' && retyped?.keyFor?.(suffixed) === 'straße');
  check('a suffix nobody published leads nowhere', alone?.keyFor?.('strasse-zzzzzz') !== 'straße');

  // A TIE between spellings: the displayed one is whichever appeared first, so
  // the slug must not follow it — and the slug the other spelling would have
  // produced must keep leading to the brand too.
  const tieA = B.buildBrandDirectory?.(mk(['ΓυαλιάΌψη', 'Γυαλιά Όψη']));
  const tieB = B.buildBrandDirectory?.(mk(['Γυαλιά Όψη', 'ΓυαλιάΌψη']));
  const only = (d) => d?.entries?.[0]?.slug ?? '';
  check('a tie between spellings publishes the same slug whatever the product order',
    only(tieA) !== '' && only(tieA) === only(tieB));
  check('...and the slug either spelling would give leads to the brand',
    tieA?.keyFor?.('gyaliaopsi') === 'γυαλιαοψη' && tieA?.keyFor?.('gyalia-opsi') === 'γυαλιαοψη');

  // A curated brand with no products yet has no links to protect; the brand
  // already publishing the slug has.
  const early = B.buildBrandDirectory?.(mk(['Straße', 'Straße']), [{ id: 'n', name: 'Strasse', slug: 'strasse-new' }]);
  check('a curated brand with no products does not take a slug from a brand that has them',
    early?.entries?.find((x) => x.key === 'straße')?.slug === 'strasse' && early?.keyFor?.('strasse') === 'straße');
}

/* ------------------------------------------------- the old WooCommerce importer's shape */
//
// The importer used to store each product's brand as a SLUG and the brand
// record as { name, slug } — so a name that slugified lossily (ß, ø) arrived
// as a record whose name no product carries. Keyed on its name alone, that
// record became a second, EMPTY brand that took its own products' slug away.
// The importer now stores names (tests/woo-apply.test.mjs), but shops it
// filled before still hold this shape.
{
  const shop = ['optics', 'optics'].map((brand, i) => ({ id: `w${i}`, brand, status: 'active' }));
  const dir = B.buildBrandDirectory?.(shop, [{ id: 'wb', name: 'Όψη Optics', slug: 'optics' }]);
  const all = dir?.entries ?? [];
  check('a record whose name has no products describes the products its slug names — one entry, not two',
    all.length === 1 && all[0]?.curated === true && all[0]?.name === 'Όψη Optics' && all[0]?.count === 2);
  check('...its slug returns those products', all[0]?.slug === 'optics' && dir?.keyFor?.('optics') === 'optics');
  check('...and so does the name it is shown under', dir?.keyFor?.('Όψη Optics') === 'optics');
  const own = B.buildBrandDirectory?.(
    [{ id: 'a', brand: 'Rayban', status: 'active' }, { id: 'b', brand: 'RB', status: 'active' }],
    [{ id: 'r', name: 'Ray-Ban', slug: 'rb' }]);
  check('a record whose own name HAS products stays with them, whatever its slug names',
    own?.keyOfRecord?.({ name: 'Ray-Ban', slug: 'rb' }) === 'rayban' && own?.entries?.length === 2);
}

/* ------------------------------------------------- collection rules resolve like ?brand= */
{
  const C = await loadTs('src/lib/commerce/collections.ts');
  const shop = ['Straße', 'Γυαλιά Όψη', 'Rayban', 'Solano Clips', 'SOLANO']
    .map((brand, i) => ({ id: `r${i}`, brand, status: 'active' }));
  const dir = B.buildBrandDirectory?.(shop, [{ id: 'b', name: 'Ray-Ban', slug: 'rb' }]);
  const NOW = Date.parse('2026-09-11T00:00:00.000Z');
  const p = (brand) => ({ id: 'x', brand, status: 'active', categories: [] });
  const holds = (brand, op, value) => C.conditionHolds(p(brand), { field: 'brand', op, value }, NOW, dir);

  check('rule "brand eq <published slug>" holds for that brand: strasse', holds('Straße', 'eq', 'strasse'));
  check('...for a Greek brand by its slug', holds('Γυαλιά Όψη', 'eq', 'gyalia-opsi'));
  check('...and for a curated slug, whatever the product spelling', holds('RAYBAN', 'eq', 'rb'));
  check('"in" resolves every listed slug', holds('Γυαλιά Όψη', 'in', ['rb', 'gyalia-opsi']));
  check('"not-in" resolves too', !holds('Straße', 'not-in', ['strasse']) && holds('Straße', 'not-in', ['rb']));
  check('a rule written with a name still matches by identity',
    holds('Ray-Ban', 'eq', 'RAYBAN') && holds('Solano clips', 'eq', 'Solano Clips'));
  check('...and never across a word, by slug or by name',
    !holds('SOLANO', 'eq', 'solano-clips') && !holds('Solano Clips', 'eq', 'solano') && !holds('SOLANO', 'eq', 'Solano Clips'));
  check('the directory reaches rules through effectiveCategories',
    C.effectiveCategories(p('Straße'), [{ slug: 'german', rule: { match: 'all',
      conditions: [{ field: 'brand', op: 'eq', value: 'strasse' }] } }], NOW, dir).includes('german'));
}

/* ------------------------------------------------- the real routes, end to end */
//
// The promise is about two ROUTES, so it is checked on them: the real
// GET /api/brands handler and the real listProducts, over a real (temporary)
// database. Bundled as ONE module so both share one LocalDB — bundled apart,
// each would get its own module instance and its own cache.
{
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'astrobaas-brand-'));
  delete process.env.DATABASE_URL;
  delete process.env.DATABASE_DRIVER;
  process.env.DB_PATH = path.join(tmp, 'db.json');
  process.env.SITE_LOCALES = 'en,el';
  const entryRel = `node_modules/.cache/astrobaas-brand-routes-${process.pid}.ts`;
  await fs.mkdir(path.join(ROOT, 'node_modules', '.cache'), { recursive: true });
  // ABSOLUTE specifiers. esbuild resolves through symlinks, so a relative
  // import from inside node_modules/.cache reaches whichever checkout a
  // symlinked node_modules points at — and quietly tests that tree instead.
  const src = (rel) => JSON.stringify(path.join(ROOT, rel));
  await fs.writeFile(path.join(ROOT, entryRel), [
    `export { LocalDB } from ${src('src/lib/localdb.ts')};`,
    `export { listProducts } from ${src('src/lib/commerce-service.ts')};`,
    `export { GET as brandsGET, POST as brandsPOST } from ${src('src/pages/api/brands/index.ts')};`,
    `export { planWooImport } from ${src('src/lib/import/woo.ts')};`,
    `export { applyWooImport } from ${src('src/lib/import/woo-apply.ts')};`,
  ].join('\n'));
  let R;
  try { R = await loadTs(entryRel, 'brand-routes'); } finally { await fs.rm(path.join(ROOT, entryRel), { force: true }); }
  await R.LocalDB.init();

  let n = 0;
  const mk = (brand, status = 'active', categories = []) => R.LocalDB.createProduct({
    name: `P${++n}`, slug: `p-${n}`, status, brand, price_cents: 1000, stock: 5, categories,
  });
  for (const b of ['Straße', 'Straße', 'Γυαλιά Όψη', 'Γυαλιά Όψη', 'Γυαλιά Όψη', 'Rayban', 'RAYBAN',
    'Solano Clips', 'SOLANO', 'Tipi Diversi', 'Tipi Diversi Clip', 'Όψη Οπτικά', 'Όψη Οπτικά',
    // Two makers that slugify alike (both `opsi`) — and only Όψη, below, is
    // in the `greek-only` category.
    // K.D. publishes `k-d`, so `kd` is its NAME but not its slug.
    'Opsi', 'Opsi', 'K.D.', 'Kaufmann']) await mk(b);
  await mk('Όψη', 'active', ['greek-only']);
  await mk('Straße', 'draft');
  await mk(undefined);

  // A shop an EARLIER WooCommerce importer filled: it stored a lossy slug on
  // each product (it dropped the ø) and a record { name: 'Ørgreen', slug:
  // 'rgreen' } whose name no product carries. Written here exactly as that
  // importer wrote it, because shops holding it still exist.
  for (const n of ['1', '2']) {
    await R.LocalDB.createProduct({
      name: `Old woo ${n}`, slug: `old-woo-${n}`, status: 'active', brand: 'rgreen',
      price_cents: 1000, sale_price_cents: null, on_sale: false, stock: 2, in_stock: true, categories: [], images: [], wp_id: `o${n}`,
    });
  }
  await R.LocalDB.createBrand({ name: 'Ørgreen', slug: 'rgreen' });
  // The importer as it is now, for real: a Greek maker — which the earlier one
  // imported with NO brand at all — arrives under its own name.
  const woo = await R.applyWooImport(R.planWooImport({
    brands: [{ name: 'Βλέμμα' }],
    products: [
      { wp_id: 'w1', name: 'Woo frame one', slug: 'woo-frame-one', price_cents: 1000, in_stock: 'yes', stock: 2, brand: 'Βλέμμα' },
      { wp_id: 'w2', name: 'Woo frame two', slug: 'woo-frame-two', price_cents: 1000, in_stock: 'yes', stock: 2, brand: 'Βλέμμα' },
    ],
  }), 'u1', { dryRun: false, includePosts: false });
  check('route: the WooCommerce import created its brand and both products',
    woo?.createdBrands === 1 && woo?.createdProducts === 2);
  // The importer is the other way a curated record is created, so it applies
  // the same guard: a record taking the slug Γυαλιά Όψη publishes would win
  // it in the listing and leave that brand's links pointing at nothing.
  const clashing = await R.applyWooImport(R.planWooImport({
    brands: [{ name: 'Foo Import', slug: 'gyalia-opsi' }],
  }), 'u1', { dryRun: false, includePosts: false });
  check('route: the importer skips a brand whose slug another brand already answers to, and says why',
    clashing?.createdBrands === 0 && (clashing?.skipped ?? []).some((s) => /gyalia-opsi/.test(s.reason)));

  const post = (body) => R.brandsPOST({
    request: new Request('http://t/api/brands', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }),
    locals: { user: { id: 'u1', role: 'admin' } },
  });
  check('route: a curated brand with a slug of its own is created', (await post({ name: 'Ray-Ban', slug: 'rb' })).status === 201);
  // Curated, with an English translation of its Greek name.
  await R.LocalDB.createBrand({ name: 'Όψη Οπτικά', slug: 'opsi-optika', i18n: { en: { name: 'Opsi Optics' } } });
  check('route: a new curated slug that another brand already answers to is refused',
    (await post({ name: 'Foo', slug: 'gyalia-opsi' })).status === 400);
  check('route: ...and so is a chosen slug that is another brand\'s NAME (kd, while K.D. has products)',
    (await post({ name: 'Kaufmann', slug: 'kd' })).status === 400);
  const strasseRes = await post({ name: 'Strasse' });
  const strasseSlug = (await strasseRes.json().catch(() => null))?.data?.slug ?? '';
  check('route: a GENERATED slug that clashes is suffixed, not refused',
    strasseRes.status === 201 && /^strasse-[a-z0-9]+$/.test(strasseSlug));
  check('route: ...and a double submit is refused rather than stored twice',
    (await post({ name: 'Strasse' })).status === 400
      && (await R.LocalDB.getBrands()).filter((b) => b.name === 'Strasse').length === 1);

  const list = async (locale) => {
    const u = new URL(`http://t/api/brands${locale ? `?locale=${locale}` : ''}`);
    const res = await R.brandsGET({ url: u, request: new Request(u), locals: {} });
    return (await res.json().catch(() => null))?.data ?? [];
  };
  const total = async (brand) => (await R.listProducts({ brand, limit: 1 }))?.meta?.total;
  const listed = await list();
  const find = (key) => listed.find((b) => b.key === key);

  check('route: Straße → "strasse", and ?brand=strasse returns its 2',
    find('straße')?.slug === 'strasse' && await total('strasse') === 2);
  check('route: Γυαλιά Όψη → "gyalia-opsi", and ?brand=gyalia-opsi returns its 3',
    find('γυαλιαοψη')?.slug === 'gyalia-opsi' && await total('gyalia-opsi') === 3);
  check('route: curated Ray-Ban → "rb", and ?brand=rb returns both spellings',
    find('rayban')?.slug === 'rb' && await total('rb') === 2);

  const brokenRoutes = [];
  for (const b of listed) {
    const t = await total(b.slug);
    if (t !== b.count) brokenRoutes.push(`${b.name} (${b.slug}): count ${b.count}, ?brand= ${t}`);
  }
  check(`route: for EVERY brand GET /api/brands returns, ?brand=<slug> returns exactly its count${brokenRoutes.length ? ` — ${brokenRoutes.join('; ')}` : ''}`,
    listed.length === 15 && brokenRoutes.length === 0);
  check('route: slugs are unique', listed.length > 0 && new Set(listed.map((b) => b.slug)).size === listed.length);

  const opsiSlug = find('οψη')?.slug ?? '';
  check('route: makers that slugify alike — Opsi keeps "opsi", Όψη publishes its own suffixed slug',
    find('opsi')?.slug === 'opsi' && await total('opsi') === 2
      && /^opsi-[a-z0-9]+$/.test(opsiSlug) && await total(opsiSlug) === 1);
  const oldWoo = find('rgreen');
  check('route: a brand an earlier import wrote and its products are ONE entry, and its slug returns them',
    oldWoo?.curated === true && oldWoo?.name === 'Ørgreen' && oldWoo?.count === 2 && await total('rgreen') === 2);
  check('route: ...and so does the name it is shown under', await total('Ørgreen') === 2);
  const newWoo = find('βλεμμα');
  check('route: a Greek brand the importer brings is ONE entry under its own name, with a transliterated slug that returns its products',
    newWoo?.curated === true && newWoo?.name === 'Βλέμμα' && newWoo?.slug === 'vlemma' && newWoo?.count === 2
      && await total('vlemma') === 2 && await total('ΒΛΕΜΜΑ') === 2);
  check('route: a curated brand with no products yet did not take Straße\'s slug',
    find('straße')?.slug === 'strasse' && find('strasse')?.count === 0 && find('strasse')?.slug === strasseSlug);

  // The directory comes from the STORED catalogue, not the filtered list: in
  // `greek-only` only Όψη exists, and `opsi` must still mean Opsi there.
  const inCategory = async (brand) => (await R.listProducts({ category: 'greek-only', brand, limit: 1 }))?.meta?.total;
  check('route: ?category=&brand=<Όψη\'s published slug> returns Όψη\'s product in that category',
    await inCategory(opsiSlug) === 1);
  check('route: ...and ?category=&brand=opsi returns none there, because opsi is Opsi',
    await inCategory('opsi') === 0);

  // A translated curated name is presentation, not identity. Keyed on the
  // translation, the brand split in two: a count-0 curated entry beside the
  // derived one.
  const opsi = (await list('en')).filter((b) => b.key === 'οψηοπτικα');
  check('route: a translated curated name does not split its brand in two',
    opsi.length === 1 && opsi[0]?.name === 'Opsi Optics' && opsi[0]?.count === 2);
  check('...and its slug still returns its count', await total(opsi[0]?.slug) === 2);

  // An automatic collection whose rule names a brand by its published slug.
  await R.LocalDB.createProductCategory({ name: 'German makers', slug: 'german-makers',
    rule: { match: 'all', conditions: [{ field: 'brand', op: 'eq', value: 'strasse' }] } });
  check('route: a collection rule on a published slug holds that brand\'s products',
    (await R.listProducts({ category: 'german-makers', limit: 1 }))?.meta?.total === 2);

  await fs.rm(tmp, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
