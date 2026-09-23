#!/usr/bin/env node
/**
 * Embeds behind a privacy facade (C-44).
 *
 * The roadmap note claimed embeds worked and only wanted a facade. They did
 * not: `iframe` is not in the sanitizer's allow-list and `disallowedTagsMode`
 * is `discard`, so a pasted YouTube embed was destroyed on save. That is
 * deliberate, and it is why nothing here stores an iframe.
 *
 * What is stored is a provider id and a video id. The frame URL is BUILT from
 * that pair. These tests are mostly about that one property, because it is the
 * property that lets a site with no third-party `script-src` have embeds at all.
 *
 * Run with:  node tests/embeds.test.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadTs, ROOT } from './lib/load.mjs';

const E = await loadTs('src/lib/embeds.ts');
const S = await loadTs('src/lib/sanitize.ts');
const C = await loadTs('src/lib/csp-config.ts');
const read = (rel) => fs.readFile(path.join(ROOT, rel), 'utf8');
const css = await read('src/styles/global.css');
const runtime = await read('src/components/public/EmbedRuntime.astro');
const pipeline = await read('src/lib/content-render.ts');
const layout = await read('src/layouts/PublicLayout.astro');

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed += 1; } catch (err) { failures.push(`${name}: ${err.message}`); }
}
function ok(cond, msg) { if (!cond) throw new Error(msg); }
/** Source text with comments removed — a check must not pass or fail on prose. */
function code(src) {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*(?:\/\/|\s\*).*$/gm, '');
}
function eq(a, b, what = '') {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

// ────────────────────────────────────────────────────────── recognising

check('YouTube, in all the shapes people actually paste', () => {
  for (const url of [
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s',
    'https://youtu.be/dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ?t=42',
    'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/embed/dQw4w9WgXcQ',
    'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
  ]) {
    eq(E.parseEmbedUrl(url), { provider: 'youtube', id: 'dQw4w9WgXcQ' }, url);
  }
});

check('Vimeo, from the site and from the player', () => {
  eq(E.parseEmbedUrl('https://vimeo.com/123456789'), { provider: 'vimeo', id: '123456789' });
  eq(E.parseEmbedUrl('https://player.vimeo.com/video/123456789'), { provider: 'vimeo', id: '123456789' });
});

check('OpenStreetMap: the SHARE url, which carries a centre and not a box', () => {
  const parsed = E.parseEmbedUrl('https://www.openstreetmap.org/#map=17/37.97945/23.71622');
  ok(parsed?.provider === 'openstreetmap', JSON.stringify(parsed));
  ok(E.validEmbed(parsed.provider, parsed.id), `built an id its own pattern rejects: ${parsed.id}`);
  const [box, marker] = parsed.id.split('!');
  const [w, s, e, n] = box.split(',').map(Number);
  ok(w < 23.71622 && e > 23.71622, `longitude not inside the box: ${box}`);
  ok(s < 37.97945 && n > 37.97945, `latitude not inside the box: ${box}`);
  eq(marker, '37.979450,23.716220', 'the marker is not the point');
});

check('ZOOM decides the span — a street is not a country', () => {
  const near = E.parseEmbedUrl('https://www.openstreetmap.org/#map=18/37.97945/23.71622');
  const far = E.parseEmbedUrl('https://www.openstreetmap.org/#map=6/37.97945/23.71622');
  const width = (p) => { const [w, , e] = p.id.split('!')[0].split(',').map(Number); return e - w; };
  ok(width(near) < width(far), `zoom 18 span ${width(near)} is not tighter than zoom 6 ${width(far)}`);
});

check('nonsense is not an embed', () => {
  for (const junk of [
    '', 'not a url', 'javascript:alert(1)', 'data:text/html,<script>alert(1)</script>',
    'https://www.youtube.com/', 'https://www.youtube.com/watch?v=short',
    'https://vimeo.com/notanumber', 'https://evil.example.com/watch?v=dQw4w9WgXcQ',
    'https://www.openstreetmap.org/',
  ]) {
    eq(E.parseEmbedUrl(junk), null, junk);
  }
});

check('A LOOKALIKE HOST IS NOT THE HOST', () => {
  // `youtube.com.evil.example` and `notyoutube.com` both contain "youtube.com".
  for (const host of ['youtube.com.evil.example', 'notyoutube.com', 'youtube.com.co']) {
    eq(E.parseEmbedUrl(`https://${host}/watch?v=dQw4w9WgXcQ`), null, host);
  }
});

check('a refused host SAYS SO instead of failing silently', () => {
  // An author who pastes an Instagram link and sees nothing happen assumes a
  // bug. It is a decision: their embeds need their own JavaScript, which this
  // CSP does not allow.
  for (const host of ['instagram.com', 'x.com', 'twitter.com', 'www.tiktok.com']) {
    const why = E.embedRefusal(`https://${host}/p/abc`);
    ok(why && /JavaScript/.test(why), `${host}: ${why}`);
    eq(E.parseEmbedUrl(`https://${host}/p/abc`), null, host);
  }
  eq(E.embedRefusal('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), null, 'YouTube is not refused');
});

// ──────────────────────────────────────── the frame url is never stored

check('THE CENTRAL PROPERTY: a frame URL is built, never read from content', () => {
  const html = E.embedPlaceholderHtml({ provider: 'youtube', id: 'dQw4w9WgXcQ' });
  ok(!/https?:/.test(html), `the placeholder names a URL: ${html}`);
  ok(!/<iframe/i.test(html), 'the placeholder contains a frame');
  ok(html.includes('data-embed-provider="youtube"'), html);
  ok(html.includes('data-embed-id="dQw4w9WgXcQ"'), html);
});

check('an invalid pair produces NOTHING, not a broken frame', () => {
  for (const bad of [
    { provider: 'youtube', id: '../../etc/passwd' },
    { provider: 'youtube', id: 'a" onload="alert(1)' },
    { provider: 'evil', id: 'dQw4w9WgXcQ' },
    { provider: 'vimeo', id: 'not-a-number' },
  ]) {
    eq(E.embedPlaceholderHtml(bad), '', JSON.stringify(bad));
    ok(!E.validEmbed(bad.provider, bad.id), JSON.stringify(bad));
  }
});

check('YouTube is framed on the NO-COOKIE domain', () => {
  // Not cosmetic: youtube.com sets tracking cookies on load, so a facade that
  // then loaded youtube.com would have delayed the tracking rather than
  // removed it.
  const src = E.getEmbedProvider('youtube').frameSrc('dQw4w9WgXcQ');
  ok(src.startsWith('https://www.youtube-nocookie.com/embed/'), src);
  ok(!src.includes('www.youtube.com'), src);
});

check('Vimeo is asked not to track', () => {
  ok(/dnt=1/.test(E.getEmbedProvider('vimeo').frameSrc('123456789')));
});

// ──────────────────────────────────────────────────── the sanitizer

check('AN IFRAME IN CONTENT IS STILL DESTROYED', () => {
  // This is the property the whole design protects. If allowing the placeholder
  // had also opened `iframe`, everything above would be theatre.
  const out = S.sanitizeHtml('<p>a</p><iframe src="https://evil.example/x"></iframe>');
  ok(!/iframe/i.test(out), out);
  ok(!/evil\.example/.test(out), out);
});

check('a VALID placeholder survives a save', () => {
  const stored = E.embedPlaceholderHtml({ provider: 'youtube', id: 'dQw4w9WgXcQ' });
  const out = S.sanitizeHtml(stored);
  ok(out.includes('data-embed-provider="youtube"'), out);
  ok(out.includes('data-embed-id="dQw4w9WgXcQ"'), out);
  ok(out.includes('ab-embed'), out);
});

check('an INVALID placeholder loses its attributes on save', () => {
  const out = S.sanitizeHtml('<div class="ab-embed" data-embed-provider="evil" data-embed-id="x"></div>');
  ok(!out.includes('data-embed-provider'), out);
  ok(!out.includes('data-embed-id'), out);
});

check('a REMOTE poster is dropped — it would defeat the facade', () => {
  // A poster served by a third party contacts them before the click, which is
  // the entire thing the facade prevents.
  const remote = S.sanitizeHtml('<div class="ab-embed" data-embed-provider="youtube" data-embed-id="dQw4w9WgXcQ" data-embed-poster="https://i.ytimg.com/vi/x/0.jpg"></div>');
  ok(!remote.includes('data-embed-poster'), remote);
  const local = S.sanitizeHtml('<div class="ab-embed" data-embed-provider="youtube" data-embed-id="dQw4w9WgXcQ" data-embed-poster="/uploads/poster.webp"></div>');
  ok(local.includes('data-embed-poster="/uploads/poster.webp"'), local);
});

check('an ORDINARY div gains nothing from this', () => {
  const out = S.sanitizeHtml('<div data-evil="1" onclick="alert(1)">x</div>');
  ok(!out.includes('data-evil'), out);
  ok(!out.includes('onclick'), out);
});

// ─────────────────────────────────────────────────────── the facade

check('the facade makes NO third-party request', () => {
  const out = E.renderEmbedFacades(E.embedPlaceholderHtml({ provider: 'youtube', id: 'dQw4w9WgXcQ' }));
  ok(!/<iframe/i.test(out), 'a frame was rendered before the click');
  // The exemption is for the sentence naming the host, which is copy rather
  // than a fetch. Matched against the text the facade ACTUALLY emits — the old
  // pattern said "Loads from" and the copy says "Load from", so the exemption
  // was dead and the assertion only held because no scheme is ever emitted.
  ok(!/https?:\/\//.test(out.replace(/Loads? from [^<]*/g, '')), `it fetches something: ${out}`);
  ok(/data-embed-load/.test(out), 'nothing to click');
});

check('THE FACADE READS IN THE PAGE\'S OWN LANGUAGE', () => {
  // A facade sits inside an article whatever theme is active, so an English
  // sentence in the middle of a Greek page is the CORE's fault rather than the
  // theme's. Keyed on the CONTENT locale, never on the staff member's admin
  // language — two visitors must get the same bytes for the same URL.
  const stored = E.embedPlaceholderHtml({ provider: 'youtube', id: 'dQw4w9WgXcQ' });
  const greek = E.renderEmbedFacades(stored, 'el');
  ok(/Φόρτωση από/.test(greek), greek.slice(0, 200));
  ok(/Βίντεο/.test(greek), 'the fallback label is still English');
  const german = E.renderEmbedFacades(stored, 'de-AT');
  ok(/Von .* laden/.test(german), `a region should not change the language: ${german.slice(0, 160)}`);
  // A locale with no catalogue falls back to English rather than to a key.
  const unknown = E.renderEmbedFacades(stored, 'ja');
  ok(/Load from/.test(unknown), unknown.slice(0, 160));
  // ...and no locale at all is what every existing caller passes.
  ok(/Load from/.test(E.renderEmbedFacades(stored)), 'the default changed');
});

check('...and it NAMES the host the click will contact', () => {
  const out = E.renderEmbedFacades(E.embedPlaceholderHtml({ provider: 'youtube', id: 'dQw4w9WgXcQ' }));
  ok(out.includes('www.youtube-nocookie.com'), out);
  ok(/Nothing is sent there until you press this/.test(out), out);
});

check('a local poster IS rendered, and lazily', () => {
  const stored = '<div class="ab-embed" data-embed-provider="youtube" data-embed-id="dQw4w9WgXcQ" data-embed-poster="/uploads/p.webp"></div>';
  const out = E.renderEmbedFacades(stored);
  ok(out.includes('src="/uploads/p.webp"'), out);
  ok(out.includes('loading="lazy"'), out);
});

check('a placeholder the renderer cannot validate is LEFT ALONE', () => {
  const stored = '<div class="ab-embed" data-embed-provider="gone" data-embed-id="x"></div>';
  eq(E.renderEmbedFacades(stored), stored, 'it invented a facade for an unknown provider');
});

check('content with no embed is returned untouched', () => {
  const html = '<p>Just a paragraph with the word embed in it.</p>';
  eq(E.renderEmbedFacades(html), html);
});

check('THE PIPELINE renders facades AFTER the sanitizer', () => {
  // The facade contains a <button>, which the sanitizer discards. Running it
  // first would both destroy the facade and let unsanitized markup through.
  const body = pipeline.slice(pipeline.indexOf('export function renderContentHtml'));
  const call = body.slice(0, body.indexOf('}'));
  ok(/renderEmbedFacades\(/.test(call), 'the pipeline does not render facades at all');
  ok(call.indexOf('sanitizeHtml(') > call.indexOf('renderEmbedFacades('), 'sanitize does not run first');
});

check('every public page carries the click handler', () => {
  // An embed can be in a post, a Page, a product description or a plugin's
  // section; a per-page flag would be threaded through four renderers with one
  // eventually forgotten.
  ok(/<EmbedRuntime \/>/.test(layout), 'PublicLayout does not include the runtime');
});

// ────────────────────────────────────────────────────────── the frame

check('the RUNTIME re-validates rather than trusting the markup', () => {
  // This HTML also reaches a headless storefront that renders it itself, where
  // the server-side half is somebody else's code.
  ok(/validEmbed\(providerId, id\)/.test(runtime), 'the runtime trusts the attributes');
  ok(/provider\.frameSrc\(id\)/.test(runtime), 'the runtime does not build the URL');
  ok(!/dataset\.embedSrc|\.src = facade\./.test(code(runtime)), 'the runtime reads a URL from the markup');
});

check('the frame is granted the few permissions a player needs, and no more', () => {
  // Not a `sandbox` attribute: a cross-origin frame already cannot touch this
  // document, and sandboxing would take away the frame's access to its OWN
  // origin — which every one of these players needs. `allow` is the list that
  // actually withholds something: camera, microphone, geolocation, payment.
  const src = code(runtime);
  ok(/setAttribute\('allow',/.test(src), 'no permission list at all');
  for (const denied of ['camera', 'microphone', 'geolocation', 'payment']) {
    ok(!new RegExp(`allow[^)]*${denied}`).test(src), `the frame is granted ${denied}`);
  }
  ok(/referrerpolicy/.test(src), 'the frame leaks the referrer');
});

check('a click loads ONE embed and remembers nothing', () => {
  ok(!/localStorage|sessionStorage|document\.cookie/.test(code(runtime)), 'the runtime persists a decision');
});

// ───────────────────────────────────────────────────── CSP and CSS

check('the CSP frames exactly these origins and nothing wider', () => {
  const frameSrc = C.cspDirectives({}).find((d) => d.startsWith('frame-src '));
  ok(frameSrc, 'no frame-src directive');
  for (const origin of E.embedFrameOrigins()) ok(frameSrc.includes(origin), `${origin} missing from ${frameSrc}`);
  ok(!/\*/.test(frameSrc), `frame-src has a wildcard: ${frameSrc}`);
});

check('EVERY provider whose shape is not 16:9 has its own rule', () => {
  // `ratio` would otherwise be a field nothing reads — the write-only-phantom
  // shape this codebase keeps finding. The CSS derives from it here instead.
  for (const p of E.EMBED_PROVIDERS) {
    if (Math.abs(p.ratio - 16 / 9) < 1e-9) continue;
    const selector = `.ab-embed-facade[data-embed-provider="${p.id}"] .ab-embed-box`;
    ok(css.includes(selector), `${p.id} (${p.ratio}) has no rule — it would render at video proportions`);
    const rule = css.slice(css.indexOf(selector));
    const pad = /padding-top:\s*([\d.]+)%/.exec(rule.slice(0, 200));
    ok(pad, `${p.id}: no padding-top`);
    const want = 100 / p.ratio;
    ok(Math.abs(Number(pad[1]) - want) < 0.5, `${p.id}: padding-top ${pad[1]}% but ratio says ${want.toFixed(2)}%`);
  }
});

check('an interactive frame is not printed', () => {
  // The rule has to be INSIDE `@media print`. The first version searched from
  // a banner comment to end-of-file, so it could not tell — moving the rule out
  // of the media query (hiding every facade ON SCREEN, a total feature break)
  // passed. Its second assertion was a tautology: with no `@media print` at
  // all, `indexOf` returns -1 and `slice(-1)` is one character, so
  // `length > 0` held.
  //
  // Brace-matched, so the block is the real one.
  const at = css.indexOf('@media print');
  ok(at >= 0, 'there are no print rules at all');
  let depth = 0, end = -1;
  for (let i = css.indexOf('{', at); i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  ok(end > at, 'the @media print block is unterminated');
  const printBlock = css.slice(at, end);
  ok(/\.ab-embed-facade\s*\{\s*display:\s*none/.test(printBlock),
    'the facade rule is not inside @media print — it either prints, or is hidden on screen');
});

if (failures.length) {
  console.error(`\n✗ embeds: ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error(`  · ${f}`);
  process.exit(1);
}
console.log(`✓ embeds: ${passed} passed`);
