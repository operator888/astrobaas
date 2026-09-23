#!/usr/bin/env node
/**
 * The WordPress WXR parser (src/lib/import/wxr.ts).
 *
 * An import runs once, against somebody's whole site, and its mistakes are
 * discovered weeks later as missing posts and mangled text. So the cases that
 * matter are the awkward ones a hand-rolled reader gets wrong: CDATA, entity
 * order, `</item>` inside content, dates WordPress spells four ways, and
 * inputs that are not exports at all.
 *
 * Run with:  node tests/wxr-parse.test.mjs
 */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cacheDir = path.join(here, '..', 'node_modules', '.cache');
await fs.mkdir(cacheDir, { recursive: true });
const out = path.join(cacheDir, `astrobaas-wxr-${process.pid}.mjs`);
await build({
  entryPoints: [path.join(here, '..', 'src/lib/import/wxr.ts')],
  bundle: true, format: 'esm', platform: 'node', packages: 'external',
  outfile: out, logLevel: 'silent',
});
const W = await import(pathToFileURL(out).href);
await fs.rm(out, { force: true });

let pass = 0;
let fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };

/** A minimal but REAL-shaped export; each test adds the items it needs. */
const doc = (items, head = '') => `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:wp="http://wordpress.org/export/1.2/">
<channel>
  <title>Example Optics</title>
  <link>https://old-shop.gr</link>
  <wp:base_site_url>https://old-shop.gr</wp:base_site_url>
  ${head}
  ${items.join('\n')}
</channel>
</rss>`;

const item = (fields) => `<item>${fields}</item>`;

/* ---- refusing what is not an export ---- */
{
  const boom = (input) => {
    try { W.parseWxr(input); return null; } catch (e) { return e; }
  };
  check('an empty file is refused by name', boom('')?.name === 'WxrParseError');
  check('whitespace only is refused', boom('   \n ')?.name === 'WxrParseError');
  check('a non-export XML file is refused', boom('<?xml version="1.0"?><foo><bar/></foo>')?.name === 'WxrParseError');
  check('...and the message says what was expected',
    /WordPress export/i.test(boom('<?xml version="1.0"?><foo/>')?.message ?? ''));
  check('a valid export with NO items parses to an empty list, not an error',
    W.parseWxr(doc([])).items.length === 0);
}

/* ---- entities: order is the whole trick ---- */
{
  const d = W.decodeXmlEntities;
  check('basic entities decode', d('&lt;b&gt;hi&lt;/b&gt;') === '<b>hi</b>');
  check('&amp; decodes LAST, so &amp;lt; stays the TEXT &lt;',
    d('&amp;lt;script&amp;gt;') === '&lt;script&gt;');
  check('numeric entities decode', d('caf&#233; &#x2014; bar') === 'café — bar');
  check('a lone surrogate is dropped rather than throwing', d('a&#xD800;b') === 'ab');
  check('an out-of-range code point is dropped', d('a&#x110000;b') === 'ab');
  check('an unknown named entity is left alone', d('5 &euro; each') === '5 &euro; each');

  // The audit's find: numeric spellings of the ampersand cascaded. Per XML 1.0
  // a character reference resolves to the character and is NOT re-scanned, so
  // &#38;lt; is the literal text &lt; — not a re-decodable entity.
  check('a DECIMAL ampersand does not cascade — &#38;lt; is the TEXT &lt;',
    d('&#38;lt;script&#38;gt;') === '&lt;script&gt;');
  check('a HEX ampersand does not cascade either', d('&#x26;amp;') === '&amp;');
  check("WordPress's zero-padded &#038; form does not cascade",
    d('&#038;lt;b&#038;gt;') === '&lt;b&gt;');
}

/* ---- CDATA is literal ---- */
{
  check('CDATA content is NOT entity-decoded a second time',
    W.unwrapCdata('<![CDATA[<p>Use &amp;amp; for &</p>]]>') === '<p>Use &amp;amp; for &</p>');
  check('non-CDATA text IS decoded', W.unwrapCdata('caf&#233;') === 'café');
  check('CDATA containing ]]> -adjacent text survives',
    W.unwrapCdata('<![CDATA[a ]] b]]>') === 'a ]] b');
  // XML forbids a literal ]]> inside CDATA, so wxr_cdata writes it as
  // ]]]]><![CDATA[> — close one bracket early, reopen. A conforming reader
  // concatenates the halves back to ]]>.
  check("WordPress's ]]> escape is reconstructed, not left mangled",
    W.unwrapCdata('<![CDATA[before ]]]]><![CDATA[> after]]>') === 'before ]]> after');
}

/* ---- the ]]> escape survives a whole parse, not just the helper ---- */
{
  const parsed = W.parseWxr(doc([
    item(`<title>CDATA tutorial</title><wp:post_id>1</wp:post_id><wp:post_type>post</wp:post_type>
      <wp:status>publish</wp:status>
      <content:encoded><![CDATA[end with ]]]]><![CDATA[> like this]]></content:encoded>`),
  ]));
  check('a post SHOWING a CDATA terminator imports with its text intact',
    parsed.items[0].content === 'end with ]]> like this');
}

/* ---- the case that breaks naive splitters ---- */
{
  const hostile = doc([
    item(`<title>About RSS</title><wp:post_id>1</wp:post_id><wp:post_type>post</wp:post_type>
      <wp:post_name>about-rss</wp:post_name><wp:status>publish</wp:status>
      <content:encoded><![CDATA[<p>An RSS entry ends with &lt;/item&gt; — literally: </item></p>]]></content:encoded>`),
    item(`<title>Second post</title><wp:post_id>2</wp:post_id><wp:post_type>post</wp:post_type>
      <wp:post_name>second</wp:post_name><wp:status>publish</wp:status>`),
  ]);
  const parsed = W.parseWxr(hostile);
  check('a </item> inside CDATA does not split the item in two', parsed.items.length === 2);
  check('...and the content survives intact', parsed.items[0].content.includes('</item></p>'));
  check('...and the SECOND post is still found', parsed.items[1].title === 'Second post');
}

/* ---- what an item carries ---- */
{
  const parsed = W.parseWxr(doc([
    item(`<title>How to choose a frame</title>
      <link>https://old-shop.gr/2024/03/how-to-choose-a-frame/</link>
      <dc:creator><![CDATA[maria]]></dc:creator>
      <wp:post_id>42</wp:post_id>
      <wp:post_name>how-to-choose-a-frame</wp:post_name>
      <wp:post_type>post</wp:post_type>
      <wp:status>publish</wp:status>
      <wp:post_date_gmt>2024-03-05 09:30:00</wp:post_date_gmt>
      <content:encoded><![CDATA[<p>Body</p>]]></content:encoded>
      <excerpt:encoded><![CDATA[Short]]></excerpt:encoded>
      <category domain="category" nicename="frames"><![CDATA[Frames & Lenses]]></category>
      <category domain="category" nicename="guides">Guides &amp; more</category>
      <category domain="post_tag" nicename="titanium"><![CDATA[titanium]]></category>
      <wp:postmeta><wp:meta_key><![CDATA[_thumbnail_id]]></wp:meta_key><wp:meta_value><![CDATA[77]]></wp:meta_value></wp:postmeta>
      <wp:postmeta><wp:meta_key><![CDATA[_edit_last]]></wp:meta_key><wp:meta_value><![CDATA[1]]></wp:meta_value></wp:postmeta>`),
  ]));
  const it = parsed.items[0];
  check('title, slug and wpId', it.title === 'How to choose a frame' && it.slug === 'how-to-choose-a-frame' && it.wpId === '42');
  check('the ORIGINAL permalink is kept — old links depend on it',
    it.link === 'https://old-shop.gr/2024/03/how-to-choose-a-frame/');
  check('dc:creator is the author LOGIN', it.authorLogin === 'maria');
  check('the GMT date is read as UTC, not as local time',
    it.publishedAt === '2024-03-05T09:30:00.000Z');
  // Both shapes occur in real exports, and they decode DIFFERENTLY by spec:
  // CDATA is literal text, everything else is entity-encoded. Getting this
  // backwards silently mangles every category with an ampersand in it.
  check('a CDATA name is taken literally — an & inside it is already an &',
    it.categories.length === 2 && it.categories[0].slug === 'frames'
    && it.categories[0].name === 'Frames & Lenses');
  check('...while a non-CDATA name IS entity-decoded',
    it.categories[1].name === 'Guides & more');
  check('tags come from the post_tag domain only', it.tags.length === 1 && it.tags[0] === 'titanium');
  check('the featured image is found by meta key, not by position', it.thumbnailId === '77');
  check('an unrelated postmeta key is not mistaken for it',
    W.parseWxr(doc([item('<wp:post_id>1</wp:post_id><wp:postmeta><wp:meta_key><![CDATA[_edit_last]]></wp:meta_key><wp:meta_value><![CDATA[9]]></wp:meta_value></wp:postmeta>')]))
      .items[0].thumbnailId === undefined);
}

/* ---- types and statuses are REPORTED, not judged ---- */
{
  const parsed = W.parseWxr(doc([
    item('<wp:post_id>1</wp:post_id><wp:post_type>post</wp:post_type><wp:status>publish</wp:status>'),
    item('<wp:post_id>2</wp:post_id><wp:post_type>page</wp:post_type><wp:status>draft</wp:status>'),
    item('<wp:post_id>3</wp:post_id><wp:post_type>attachment</wp:post_type><wp:status>inherit</wp:status><wp:attachment_url>https://old-shop.gr/wp-content/uploads/2024/03/frame.jpg</wp:attachment_url>'),
    item('<wp:post_id>4</wp:post_id><wp:post_type>post</wp:post_type><wp:status>trash</wp:status>'),
    item('<wp:post_id>5</wp:post_id><wp:post_type>product</wp:post_type><wp:status>publish</wp:status>'),
  ]));
  check('every item is reported, including trash and custom types', parsed.items.length === 5);
  check('the parser does not filter — deciding is the apply layer’s job',
    parsed.items.map((i) => i.type).join() === 'post,page,attachment,post,product');
  check('statuses arrive verbatim, not translated',
    parsed.items.map((i) => i.status).join() === 'publish,draft,inherit,trash,publish');
  check('an attachment carries its source URL',
    parsed.items[2].attachmentUrl === 'https://old-shop.gr/wp-content/uploads/2024/03/frame.jpg');
  check('a missing post_type defaults to post',
    W.parseWxr(doc([item('<wp:post_id>9</wp:post_id>')])).items[0].type === 'post');
}

/* ---- dates WordPress actually writes ---- */
{
  const dated = (fields) => W.parseWxr(doc([item(`<wp:post_id>1</wp:post_id>${fields}`)])).items[0].publishedAt;
  check('the zero date means "never", not 1970',
    dated('<wp:post_date_gmt>0000-00-00 00:00:00</wp:post_date_gmt>') === undefined);
  check('...and then pubDate is used instead',
    dated('<wp:post_date_gmt>0000-00-00 00:00:00</wp:post_date_gmt><pubDate>Tue, 05 Mar 2024 09:30:00 +0000</pubDate>')
      === '2024-03-05T09:30:00.000Z');
  check('a missing date is undefined rather than "now"', dated('') === undefined);
  check('an unparseable date is undefined rather than Invalid Date',
    dated('<wp:post_date_gmt>not a date</wp:post_date_gmt>') === undefined);
  // pubDate carries an EXPLICIT offset, the local column carries none — so
  // when the GMT column is the zero date, pubDate must win. The first version
  // consulted the local column first and branded its wall-clock time as UTC.
  check('pubDate (explicit offset) beats the zone-less local column',
    dated('<wp:post_date_gmt>0000-00-00 00:00:00</wp:post_date_gmt>'
      + '<wp:post_date>2024-03-05 12:00:00</wp:post_date>'
      + '<pubDate>Tue, 05 Mar 2024 10:00:00 +0000</pubDate>')
      === '2024-03-05T10:00:00.000Z');
  check('the local column is still a last resort when nothing else exists',
    dated('<wp:post_date>2024-03-05 12:00:00</wp:post_date>') === '2024-03-05T12:00:00.000Z');
}

/* ---- attributes are read from the opening tag, never the body ---- */
{
  const parsed = W.parseWxr(doc([
    item(`<wp:post_id>1</wp:post_id>
      <category domain="category"><![CDATA[See nicename="spoofed" docs]]></category>`),
  ]));
  check('body text that LOOKS like a nicename attribute is not read as the slug',
    parsed.items[0].categories[0]?.slug !== 'spoofed');
  check('...and the fall-back to the display name is reachable again',
    parsed.items[0].categories[0]?.slug === 'See nicename="spoofed" docs');
}

/* ---- illegal bytes are refused, not mis-assembled ---- */
{
  const boom = (input) => {
    try { W.parseWxr(input); return null; } catch (e) { return e; }
  };
  // NUL doubles as the CDATA mask, so a crafted NUL+digits+NUL could splice
  // one item's CDATA into another item's field. Refusal closes that.
  check('a NUL byte anywhere in the file is refused by name',
    /NUL/.test(boom(doc([item('<wp:post_id>1</wp:post_id><title>a\u0000' + '0\u0000b</title>')]))?.message ?? ''));
}

/* ---- the header ---- */
{
  const parsed = W.parseWxr(doc([item('<title>A post</title><wp:post_id>1</wp:post_id>')], `
    <wp:author>
      <wp:author_login><![CDATA[maria]]></wp:author_login>
      <wp:author_email><![CDATA[maria@old-shop.gr]]></wp:author_email>
      <wp:author_display_name><![CDATA[Maria K.]]></wp:author_display_name>
    </wp:author>
    <wp:author><wp:author_login><![CDATA[admin]]></wp:author_login></wp:author>
    <wp:author><wp:author_email><![CDATA[nobody@example.com]]></wp:author_email></wp:author>`));
  check('authors are read from the header', parsed.authors.length === 2);
  check('...with login, email and display name', parsed.authors[0].login === 'maria'
    && parsed.authors[0].email === 'maria@old-shop.gr' && parsed.authors[0].displayName === 'Maria K.');
  check('an author with no login is skipped — the login is the join key',
    parsed.authors.every((a) => a.login));
  check('the SITE title is not confused with a post title', parsed.siteTitle === 'Example Optics');
  check('the old site URL is captured (redirects need it)', parsed.siteUrl === 'https://old-shop.gr');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
