#!/usr/bin/env node
/**
 * Colour swatches (core/color-swatches-visual-variant-selection).
 *
 * - the core stores a colour or image per attribute value, validated strictly,
 *   and `swatchProblems` names every refused one (the save answers 400);
 * - the shared picker rule (both copies) decides which options are drawn as
 *   swatches and re-validates every swatch it hands to CSS or an <img>;
 * - the starter's view carries the decision, the component draws it without
 *   an inline style (the starter's CSP has no 'unsafe-inline'), and the
 *   accessibility promises are in the markup and the stylesheet;
 * - the admin editor's state survives the attributes-as-text round-trip.
 *
 * Run with:  node tests/color-swatches.test.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadTs, ROOT } from './lib/load.mjs';

let passed = 0;
const failures = [];
async function check(name, fn) {
  try { await fn(); passed += 1; } catch (err) { failures.push(`${name}: ${err.message}`); }
}
function ok(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, what = '') {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
const read = (rel) => fs.readFile(path.join(ROOT, rel), 'utf8');

// ───────────────────────────────────────────── core: storing and validating

const F = await loadTs('src/lib/product-fields.ts', 'sw-fields');

await check('a hex colour is accepted as #rgb or #rrggbb and stored as lower-case #rrggbb', () => {
  eq(F.normalizeSwatchColor('#C00'), '#cc0000');
  eq(F.normalizeSwatchColor(' #1A2b3C '), '#1a2b3c');
  for (const bad of ['red', '#ff00zz', 'ff0000', '#ff00', '#ff000000', '#ff0000;background:url(x)', 'rgb(1,2,3)', '', null, 3, ['#fff']]) {
    eq(F.normalizeSwatchColor(bad), undefined, `colour ${JSON.stringify(bad)}`);
  }
});

await check('a swatch image is a media reference: /uploads/ or https, never anything else', () => {
  for (const good of ['/uploads/2026/10/red.webp', 'https://cdn.example.com/sw/red.png', '/uploads/a%20b.jpg']) {
    eq(F.normalizeSwatchImage(good), good, good);
  }
  for (const bad of [
    'javascript:alert(1)', 'data:image/png;base64,AAAA', 'http://cdn.example.com/red.png', '//evil.example/x.png',
    '/admin/products', '/uploads/../admin', '/uploads/./x.png', '/uploads//x.png', '/uploads/a b.png',
    'https://user:pw@cdn.example.com/x.png', 'https://cdn.example.com/x.png") ;', 'https://cdn.example.com/a(1).png',
    '/uploads/2026/10/red.mp4', 'https://cdn.example.com/red.webm', '/uploads/' + 'a'.repeat(1001), '', 7,
    // Encoded dot segments a URL parser resolves (/uploads/%2e%2e/admin -> /admin), encoded slashes,
    // and an https URL with no host after the slashes (saved, then dropped by the storefront).
    '/uploads/%2e%2e/admin/logout', '/uploads/%2E./x.png', '/uploads/a%2f..%2fadmin', 'https:///x.png',
  ]) {
    eq(F.normalizeSwatchImage(bad), undefined, `image ${JSON.stringify(bad).slice(0, 60)}`);
  }
});

await check('normalizeAttributes keeps display and swatches, keyed by real values only', () => {
  const [a] = F.normalizeAttributes([{
    name: 'Colour', values: ['Red', 'Blue'], display: 'swatch',
    swatches: { Red: { color: '#F00' }, Blue: { image: '/uploads/blue.png', color: 'nope' }, Green: { color: '#0f0' } },
  }]);
  eq(a, { name: 'Colour', values: ['Red', 'Blue'], visible: true, display: 'swatch',
    swatches: { Red: { color: '#ff0000' }, Blue: { image: '/uploads/blue.png' } } });
});

await check('an attribute without swatches normalises to exactly what it did before', () => {
  eq(F.normalizeAttributes([{ name: 'Size', values: ['S'], display: 'buttons', swatches: {} }]),
    [{ name: 'Size', values: ['S'], visible: true }]);
  eq(F.normalizeAttributes([{ name: 'Size', values: ['S'], display: 'tiles', swatches: { S: {} } }]),
    [{ name: 'Size', values: ['S'], visible: true }]);
});

await check('swatchProblems names every refused colour and image, and nothing when all is well', () => {
  eq(F.swatchProblems([{ name: 'Colour', values: ['Red'], display: 'swatch', swatches: { Red: { color: '#f00', image: '/uploads/r.png' } } }]), []);
  eq(F.swatchProblems(undefined), []);
  eq(F.swatchProblems([{ name: 'Colour', values: ['Red'], swatches: { Red: null } }]), [], 'null clears');
  eq(F.swatchProblems([{ name: 'Colour', values: ['Red'], swatches: { Red: { color: '', image: '' } } }]), [], 'blank clears');
  const p = F.swatchProblems([{
    name: 'Colour', values: ['Red', 'Blue'], display: 'dots',
    swatches: { Red: { color: 'red' }, Blue: { image: 'javascript:alert(1)' }, Green: { color: '#0f0' } },
  }]);
  eq(p.length, 4, JSON.stringify(p));
  ok(p.some((l) => /display/.test(l)), 'unknown display not named');
  ok(p.some((l) => /Red: colour/.test(l)), 'bad colour not named');
  ok(p.some((l) => /Blue: image/.test(l)), 'bad image not named');
  ok(p.some((l) => /"Green", which is not one of its values/.test(l)), 'stray value not named');
});

await check('every swatch swatchProblems accepts is one normalizeAttributes keeps (no accept-then-drop)', () => {
  const cases = ['#abc', '#ABCDEF', '/uploads/x/y.png', 'https://cdn.example.com/y.webp'];
  for (const v of cases) {
    const sw = v.startsWith('#') ? { color: v } : { image: v };
    const attrs = [{ name: 'C', values: ['V'], swatches: { V: sw } }];
    eq(F.swatchProblems(attrs), [], v);
    ok(F.normalizeAttributes(attrs)[0].swatches?.V, `${v} accepted but dropped`);
  }
});

await check('saveProduct refuses a bad swatch before it normalises it away', async () => {
  const src = await read('src/lib/commerce-service.ts');
  const refuse = src.indexOf('swatchProblems(filtered.attributes)');
  const normalise = src.indexOf('normalizeExtendedFields(filtered, id');
  ok(refuse > 0, 'saveProduct does not call swatchProblems');
  ok(refuse < normalise, 'swatchProblems runs after the normaliser has already dropped the bad value');
  ok(/status: 400, message: `Invalid swatch/.test(src), 'no 400 for a bad swatch');
});

await check('every swatch image the core keeps, the storefront rule keeps too (saved, never then dropped)', async () => {
  const S = await loadTs('src/lib/commerce/variant-selection.ts', 'sw-agree');
  for (const v of ['/uploads/2026/10/red.webp', '/uploads/a%20b.jpg', 'https://cdn.example.com/sw/red.png', 'https://x.png', 'https://a.example/b?c=d']) {
    if (F.normalizeSwatchImage(v)) eq(S.swatchImage(v), v, v);
  }
  for (const v of ['#abc', '#A1B2C3']) eq(S.swatchColor(F.normalizeSwatchColor(v)), F.normalizeSwatchColor(v), v);
});

await check('replacing a media file rewrites swatch images too (they are media references)', async () => {
  const src = await read('src/lib/media/replace.ts');
  ok(/swatches\[value\] = image !== sw\?\.image \? \{ \.\.\.sw, image \} : sw;/.test(src), 'replace does not rewrite attributes[].swatches[].image');
  ok(/\.\.\.\(attributesChanged \? \{ attributes: nextAttributes \} : \{\}\)/.test(src), 'the rewritten attributes are not written back');
});

await check('OpenAPI documents display and swatches on product attributes, as the server accepts them', async () => {
  const src = await read('src/pages/openapi.json.ts');
  ok(/display: \{ type: 'string', enum: \['swatch', 'buttons'\]/.test(src), 'display missing');
  const pattern = src.match(/color: \{ type: 'string', pattern: '([^']+)'/)?.[1];
  ok(pattern, 'swatches.color missing');
  const re = new RegExp(pattern);
  for (const v of ['#C00', '#cc0000', '#A1b2C3']) ok(re.test(v) && F.normalizeSwatchColor(v), `OpenAPI and the server disagree on ${v}`);
  for (const v of ['red', '#ff00zz', '#ff000000']) ok(!re.test(v) && !F.normalizeSwatchColor(v), `OpenAPI and the server disagree on ${v}`);
  ok(/image: \{ type: 'string', description: 'A media reference/.test(src), 'swatches.image missing');
});

await check('ProductAttribute names display and swatches', async () => {
  const src = await read('src/core/models.ts');
  ok(/export interface ProductAttribute \{[\s\S]*?display\?: 'swatch';[\s\S]*?swatches\?: Record<string, ProductAttributeSwatch>;/.test(src), 'model fields missing');
});

// ───────────────────────────────────────────── the shared rule, both copies

for (const [label, file] of [['core', 'src/lib/commerce/variant-selection.ts'], ['starter', 'examples/storefront/src/lib/variant-selection.ts']]) {
  const S = await loadTs(file, `sw-${label}`);
  const T = (name, fn) => check(`[${label}] ${name}`, fn);
  const axes = [{ name: 'Colour', values: ['Red', 'Ivory', 'Navy'] }, { name: 'Size', values: ['S', 'M'] }];

  await T('an option is swatches when marked, or when every value has one — else buttons', () => {
    const marked = S.swatchAxes(axes, [{ name: 'Colour', display: 'swatch', swatches: { Red: { color: '#f00' } } }]);
    eq(marked[0], { Red: { color: '#ff0000', image: null, light: false }, Ivory: null, Navy: null });
    eq(marked[1], null, 'Size has no attribute');
    const all = S.swatchAxes(axes, [{ name: 'Colour', swatches: { Red: { color: '#f00' }, Ivory: { color: '#fffff0' }, Navy: { image: '/uploads/n.png' } } }]);
    ok(all[0] && all[0].Navy.image === '/uploads/n.png', 'every value has one but drawn as buttons');
    const some = S.swatchAxes(axes, [{ name: 'Colour', swatches: { Red: { color: '#f00' }, Ivory: { color: '#fffff0' } } }]);
    eq(some[0], null, 'two of three, unmarked, must stay buttons');
    eq(S.swatchAxes(axes, null), [null, null]);
  });

  await T('a swatch that is not a usable colour or image does not count', () => {
    const r = S.swatchAxes([{ name: 'C', values: ['A', 'B'] }], [{ name: 'C', swatches: { A: { color: 'red' }, B: { color: '#00f' } } }]);
    eq(r[0], null, 'an invalid colour counted toward "every value has one"');
  });

  await T('colours are re-validated before they reach CSS', () => {
    eq(S.swatchColor('#ABC'), '#aabbcc');
    for (const bad of ['red', '#ff0000;x:y', 'var(--x)', '#12345', null, {}]) eq(S.swatchColor(bad), null, String(bad));
  });

  await T('images are re-validated before they reach an <img>', () => {
    eq(S.swatchImage('/uploads/x.png'), '/uploads/x.png');
    eq(S.swatchImage('https://cdn.example.com/x.png'), 'https://cdn.example.com/x.png');
    for (const bad of ['javascript:alert(1)', '//evil/x.png', 'http://x/y.png', 'data:image/png,xx', '/a b.png', '/x".png', 'https://x/(1).png']) {
      eq(S.swatchImage(bad), null, bad);
    }
  });

  await T('pale colours are flagged for a darker border, dark ones are not', () => {
    for (const c of ['#ffffff', '#fffff0', '#ffff00', '#f5f5dc']) ok(S.isLightColor(c), `${c} not light`);
    for (const c of ['#000000', '#cc0000', '#1e3a8a', '#767676']) ok(!S.isLightColor(c), `${c} light`);
    ok(!S.isLightColor('nope'), 'non-colour is light');
  });
}

// ───────────────────────────────────────────── the starter

const PV = await loadTs('examples/storefront/src/lib/variant-view.ts', 'sw-view');

await check('the starter view carries the swatch decision per axis, from the wire attributes', () => {
  const d = PV.pickerData({
    id: 'p', price_cents: 1000, sku: 'P',
    attributes: [
      { name: 'Colour', values: ['Red', 'Ivory'], display: 'swatch', swatches: { Red: { color: '#c00' }, Ivory: { color: '#fffff0' } } },
      { name: 'Size', values: ['S'] },
    ],
    variants: [
      { id: 'r', options: { Colour: 'Red', Size: 'S' }, stock_status: { purchasable: true } },
      { id: 'i', options: { Colour: 'Ivory', Size: 'S' }, stock_status: { purchasable: false } },
    ],
  }, 'EUR');
  eq(d.swatches, [
    { Red: { color: '#cc0000', image: null, light: false }, Ivory: { color: '#fffff0', image: null, light: true } },
    null,
  ]);
  ok(PV.pickerJson(d).includes('"swatches"'), 'the script does not get the swatches');
});

await check('the component draws swatches as a second data-display of the same radios', async () => {
  const c = await read('examples/storefront/src/components/VariantSelector.astro');
  ok(/data-display=\{sw \? 'swatches' : 'buttons'\}/.test(c), 'data-display is not decided by swatchAxes');
  ok(/class="ab-variant__choice ab-variant__choice--swatch"[\s\S]{0,80}\{input\}/.test(c), 'a swatch is not the same radio');
  ok(/<span class="ab-variant__label"><span class="ab-variant__value">\{s\.value\}<\/span><\/span>/.test(c), 'a swatch has no text label');
  ok(/<span class="ab-variant__note" data-note>\{note\}<\/span>/.test(c), 'a sold-out swatch has no reason in words');
  ok(/<svg class="ab-variant__check"[^>]*aria-hidden="true"/.test(c), 'no check mark for the chosen swatch');
  ok(/class="ab-variant__swatch-img" src=\{swatch\.image\} alt=""/.test(c), 'an image swatch is not a decorative <img> named by its label');
  ok(/<span class="ab-variant__swatch-name" aria-hidden="true">\{s\.value\}<\/span>/.test(c), 'no visible name for where hover and focus cannot reach');
});

await check('a sold-out swatch shows its name (a disabled radio takes no focus), and so does every swatch on touch', async () => {
  const css = await read('examples/storefront/src/styles/shop.css');
  ok(/\.ab-variant__input:disabled ~ \.ab-variant__swatch-name \{ display: block; \}/.test(css), 'a sold-out swatch is named by its colour alone');
  ok(/@media \(hover: none\) \{\s*\.ab-variant__choice--swatch \.ab-variant__swatch-name \{ display: block; \}/.test(css), 'on touch no swatch is named');
});

await check('no inline style anywhere the CSP would refuse it; the colour goes through the CSSOM', async () => {
  const cfg = await read('examples/storefront/astro.config.mjs');
  const directives = cfg.match(/csp:\s*\{\s*directives:\s*\[([\s\S]*?)\]/)?.[1];
  ok(directives, 'the starter has no CSP');
  ok(/default-src 'self'/.test(directives) && !/style-src/.test(directives), 'the starter CSP changed shape — re-check where styles may come from');
  ok(!/unsafe-inline/.test(directives), 'the starter CSP allows unsafe-inline now — this check would be moot');
  const c = await read('examples/storefront/src/components/VariantSelector.astro');
  ok(!/\bstyle=/.test(c), 'the component has a style attribute');
  ok(!/background(-color)?\s*:/.test(c), 'the component writes CSS into markup');
  ok(/data-swatch-color=\{swatch\?\.color/.test(c), 'the colour is not handed over as a data attribute');
  const js = await read('examples/storefront/src/scripts/variant-selector.ts');
  ok(/el\.style\.setProperty\('--ab-swatch-color', color\)/.test(js), 'the script does not set the colour through the CSSOM');
  ok(!/setAttribute\(\s*['"]style['"]/.test(js) && !/\.style\.cssText/.test(js) && !/innerHTML/.test(js), 'the script writes a style attribute or HTML');
  ok(/const color = swatchColor\(el\.dataset\.swatchColor\);\s*if \(!color\) continue;/.test(js), 'the script trusts the attribute without re-validating it');
  ok(/paintSwatches\(root\);[\s\S]*fallback\?\.setAttribute\('hidden'/.test(js), 'swatches are painted after the groups show');
});

await check('the stylesheet keeps every accessibility promise for swatches', async () => {
  const css = await read('examples/storefront/src/styles/shop.css');
  ok(/background-color: var\(--ab-swatch-color,/.test(css), 'the tile does not read --ab-swatch-color');
  ok(/\.ab-variant__input:checked ~ \.ab-variant__swatch \{\s*box-shadow:[^}]*var\(--ab-variant-swatch-ring/.test(css), 'no ring on the chosen swatch');
  ok(/\.ab-variant__input:checked ~ \.ab-variant__swatch \.ab-variant__check \{ display: block; \}/.test(css), 'no check on the chosen swatch');
  ok(/\.ab-variant__swatch\[data-swatch-tone="light"\] \{ border-color: var\(--ab-variant-swatch-border-light, var\(--ink\)\)/.test(css), 'pale colours get no darker border');
  ok(/\.ab-variant__input:disabled ~ \.ab-variant__swatch::after \{[^}]*repeating-linear-gradient/.test(css), 'sold out is not cross-hatched');
  ok(/\.ab-variant__choice--swatch:hover \.ab-variant__label,\s*\.ab-variant__input:focus-visible ~ \.ab-variant__label \{/.test(css), 'the name does not show on hover and focus');
  // Visually hidden, never display:none, so a screen reader always reads it.
  const hiddenRule = css.match(/\.ab-variant__choice--swatch \.ab-variant__label \{([^}]*)\}/)?.[1] ?? '';
  ok(/clip-path: inset\(50%\)/.test(hiddenRule) && !/display:\s*none|visibility:\s*hidden/.test(hiddenRule), 'the name is removed from the accessibility tree');
  ok(/\.ab-variant__input:focus-visible ~ \.ab-variant__swatch \{ outline:/.test(css), 'no focus ring on a swatch');
  ok(/@media \(forced-colors: active\) \{[\s\S]*?\.ab-variant__input:checked ~ \.ab-variant__swatch \{ outline: 3px solid Highlight/.test(css), 'no forced-colours selected state');
});

// ───────────────────────────────────────────── the admin editor's state

const SF = await loadTs('src/lib/swatch-form.ts', 'sw-form');

await check('the editor round-trips what the text cannot spell: swatches, the mark, and visible', () => {
  const stored = [
    { name: 'Colour', values: ['Red', 'Blue'], visible: true, display: 'swatch', swatches: { Red: { color: '#ff0000' }, Blue: { image: '/uploads/b.png' } } },
    { name: 'Fit', values: ['Slim'], visible: false },
  ];
  const state = SF.swatchStateFrom(stored);
  // The operator edits the TEXT: renames nothing, adds a colour value.
  const parsed = [{ name: 'Colour', values: ['Red', 'Blue', 'Green'] }, { name: 'Fit', values: ['Slim'] }];
  eq(SF.applySwatchState(parsed, state), [
    { name: 'Colour', values: ['Red', 'Blue', 'Green'], visible: true, display: 'swatch', swatches: { Red: { color: '#ff0000' }, Blue: { image: '/uploads/b.png' } } },
    { name: 'Fit', values: ['Slim'], visible: false },
  ]);
});

await check('a value removed from the text takes its swatch with it; a cleared field clears it', () => {
  const state = SF.swatchStateFrom([{ name: 'C', values: ['A', 'B'], swatches: { A: { color: '#000000' }, B: { color: '#ffffff' } } }]);
  SF.metaFor(state, 'C').swatches.A = { color: '  ', image: '' };
  eq(SF.applySwatchState([{ name: 'C', values: ['A'] }], state), [{ name: 'C', values: ['A'], visible: true }]);
});

await check('a new attribute typed into the text starts visible, unmarked and empty', () => {
  const state = {};
  const m = SF.metaFor(state, 'Pattern');
  eq(m, { swatch: false, visible: true, swatches: {} });
  m.swatch = true;
  m.swatches.Dots = { color: '#123' };
  eq(SF.applySwatchState([{ name: 'Pattern', values: ['Dots'] }], state),
    [{ name: 'Pattern', values: ['Dots'], visible: true, display: 'swatch', swatches: { Dots: { color: '#123' } } }]);
  eq(SF.colorInputValue('#ABC'), '#aabbcc');
  eq(SF.colorInputValue('red'), null);
});

await check('the product editor saves attributes through applySwatchState and loads them through swatchStateFrom', async () => {
  const page = await read('src/pages/admin/products.astro');
  ok(/attributes: applySwatchState\(textToAttrs\(f\.attributes_text\.value\), swatchState\)/.test(page), 'the save does not put the swatches back');
  ok(/swatchState = swatchStateFrom\(p\.attributes\)/.test(page), 'the load does not read the swatches');
  ok(/swatchState = \{\};\s*renderSwatchEditor\(\);/.test(page), 'a new product keeps the previous product\'s swatches');
  ok(/data-swatch-editor/.test(page) && /type = 'color'/.test(page), 'no swatch editor');
  ok(!/innerHTML/.test(page.slice(page.indexOf('function renderSwatchEditor'), page.indexOf("form.elements.attributes_text.addEventListener('input'"))), 'the swatch editor builds HTML from strings');
});

await check('astrobaas/client re-exports the swatch rule', async () => {
  const src = await read('src/client/index.ts');
  for (const n of ['swatchAxes', 'swatchOf', 'swatchColor', 'swatchImage', 'isLightColor']) {
    ok(new RegExp(`\\b${n}\\b[\\s\\S]*from '\\.\\./lib/commerce/variant-selection'`).test(src), `${n} is not re-exported`);
  }
});

if (failures.length) {
  console.error(`\n✗ color-swatches: ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error(`  · ${f}`);
  process.exit(1);
}
console.log(`✓ color-swatches: ${passed} passed`);
