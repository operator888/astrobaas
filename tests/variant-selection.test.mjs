#!/usr/bin/env node
/**
 * The variant picker's availability rule (src/lib/commerce/variant-selection.ts)
 * and the per-variant `resolved` price it is shown with.
 *
 * - which option values are selectable given the earlier choices, and why
 *   the others are not ("Not available in Red", "Sold out in Red");
 * - the selection made consistent when an earlier choice changes;
 * - the variant a full choice names, and the one a ?variant= link names;
 * - the starter's copy is the CMS's own, byte for byte, and passes the same
 *   cases (it pins the published package, so it cannot import the new one);
 * - `resolved` on each variant is what the CHECKOUT charges, survives the
 *   real writer (normalizeVariants), and is never stored;
 * - the starter's build-time view reads `resolved`, not its own arithmetic.
 *
 * Run with:  node tests/variant-selection.test.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadTs, ROOT } from './lib/load.mjs';

const CORE = 'src/lib/commerce/variant-selection.ts';
const STARTER = 'examples/storefront/src/lib/variant-selection.ts';

let passed = 0;
const failures = [];
async function check(name, fn) {
  try { await fn(); passed += 1; } catch (err) { failures.push(`${name}: ${err.message}`); }
}
function ok(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, what = '') {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

// ───────────────────────────────────────────── the two copies are one

await check('the starter carries the CMS\'s own copy, byte for byte', async () => {
  const [a, b] = await Promise.all([CORE, STARTER].map((f) => fs.readFile(path.join(ROOT, f), 'utf8')));
  ok(a === b, `${STARTER} differs from ${CORE} — copy it over; the starter must not decide availability differently`);
});

await check('the rule has no imports, so the copy and the client bundle stand alone', async () => {
  const src = await fs.readFile(path.join(ROOT, CORE), 'utf8');
  ok(!/^\s*import\s/m.test(src), 'variant-selection.ts imports something');
});

await check('astrobaas/client re-exports it', async () => {
  const src = await fs.readFile(path.join(ROOT, 'src/client/index.ts'), 'utf8');
  for (const n of ['variantAxes', 'axisStates', 'optionStates', 'reconcileSelection', 'matchVariant', 'initialSelection', 'selectableVariants']) {
    ok(new RegExp(`\\b${n}\\b[\\s\\S]*from '\\.\\./lib/commerce/variant-selection'`).test(src), `${n} is not re-exported`);
  }
});

// ───────────────────────────────────────────── the rule, on both copies

const shirt = (S) => {
  // Colour then size, as the merchant entered them. Only some combinations
  // exist: no Blue S, no Green at all. Red S is sold out; every Black is.
  const variants = S.selectableVariants([
    { id: 'red-s', options: { Size: 'S', Colour: 'Red' }, enabled: true, stock_status: { purchasable: false } },
    { id: 'red-m', options: { Size: 'M', Colour: 'Red' }, enabled: true, stock_status: { purchasable: true } },
    { id: 'blue-m', options: { Size: 'M', Colour: 'Blue' }, enabled: true, stock_status: { purchasable: true } },
    { id: 'blue-l', options: { Size: 'L', Colour: 'Blue' }, enabled: true, stock_status: { purchasable: true } },
    { id: 'black-m', options: { Size: 'M', Colour: 'Black' }, enabled: true, stock_status: { purchasable: false } },
    { id: 'off', options: { Size: 'XL', Colour: 'Red' }, enabled: false, stock_status: { purchasable: true } },
  ]);
  const axes = S.variantAxes(variants, [
    { name: 'Colour', values: ['Green', 'Black', 'Red', 'Blue'] },
    { name: 'Size', values: ['S', 'M', 'L', 'XL'] },
  ]);
  return { variants, axes };
};
const brief = (states) => states.map((s) => `${s.value}:${s.selectable ? 'ok' : s.reason}`);

for (const [label, file] of [['core', CORE], ['starter', STARTER]]) {
  const S = await loadTs(file, `vs-${label}`);
  const T = (name, fn) => check(`[${label}] ${name}`, fn);

  await T('options follow the merchant\'s attribute order, values unused by any variant dropped', () => {
    const { axes } = shirt(S);
    eq(axes.map((a) => a.name), ['Colour', 'Size']);
    eq(axes[0].values, ['Black', 'Red', 'Blue'], 'Green has no variant; order is the attribute\'s');
    eq(axes[1].values, ['S', 'M', 'L'], 'XL exists only on a DISABLED variant');
  });

  await T('an option key no attribute names is still offered, after the named ones', () => {
    const vs = S.selectableVariants([{ id: 'a', options: { Fit: 'Slim', Colour: 'Red' }, enabled: true }]);
    eq(S.variantAxes(vs, [{ name: 'Colour', values: ['Red'] }]).map((a) => a.name), ['Colour', 'Fit']);
    eq(S.variantAxes(vs, null).map((a) => a.name), ['Fit', 'Colour'], 'without attributes: first use');
  });

  await T('with nothing chosen, a colour whose every variant is sold out reads sold out', () => {
    const { variants, axes } = shirt(S);
    eq(brief(S.axisStates(axes, variants, {}, 0)), ['Black:sold-out', 'Red:ok', 'Blue:ok']);
  });

  await T('sizes are judged against the colour chosen BEFORE them', () => {
    const { variants, axes } = shirt(S);
    eq(brief(S.axisStates(axes, variants, { Colour: 'Red' }, 1)), ['S:sold-out', 'M:ok', 'L:unavailable']);
    eq(brief(S.axisStates(axes, variants, { Colour: 'Blue' }, 1)), ['S:unavailable', 'M:ok', 'L:ok']);
    // With no colour yet, a size is open while any colour has it to sell.
    eq(brief(S.axisStates(axes, variants, {}, 1)), ['S:sold-out', 'M:ok', 'L:ok']);
  });

  await T('a later choice does not narrow an earlier option', () => {
    const { variants, axes } = shirt(S);
    eq(brief(S.axisStates(axes, variants, { Size: 'L' }, 0)), ['Black:sold-out', 'Red:ok', 'Blue:ok']);
  });

  await T('optionStates is axisStates for every option', () => {
    const { variants, axes } = shirt(S);
    const sel = { Colour: 'Red' };
    eq(S.optionStates(axes, variants, sel), axes.map((_, i) => S.axisStates(axes, variants, sel, i)));
  });

  await T('the reason reads with the choices it depends on', () => {
    const { axes } = shirt(S);
    eq(S.blockedText(axes, { Colour: 'Red' }, 1, 'sold-out'), 'Sold out in Red');
    eq(S.blockedText(axes, { Colour: 'Red' }, 1, 'unavailable'), 'Not available in Red');
    eq(S.blockedText(axes, {}, 0, 'sold-out'), 'Sold out');
  });

  await T('changing the colour clears a size it does not come in, and keeps one it does', () => {
    const { variants, axes } = shirt(S);
    eq(S.reconcileSelection(axes, variants, { Colour: 'Red', Size: 'L' }), { Colour: 'Red' },
      'L is not made in Red: it is dropped, and the shopper\'s own choice is NOT swapped for M behind their back');
    eq(S.droppedChoices(axes, { Colour: 'Red', Size: 'L' }, { Colour: 'Red' }), { Size: 'L' }, 'the page is told what went');
    eq(S.droppedChoices(axes, { Colour: 'Red' }, { Colour: 'Red', Size: 'M' }), {}, 'an auto-pick is not a drop');
    eq(S.reconcileSelection(axes, variants, { Colour: 'Blue', Size: 'M' }), { Colour: 'Blue', Size: 'M' });
    eq(S.reconcileSelection(axes, variants, { Colour: 'Blue', Size: 'S' }), { Colour: 'Blue' }, 'two sizes left: no guess');
  });

  await T('a sold-out, unknown or junk choice is dropped, never kept', () => {
    const { variants, axes } = shirt(S);
    eq(S.reconcileSelection(axes, variants, { Colour: 'Black' }), {});
    eq(S.reconcileSelection(axes, variants, { Colour: 'Purple', Fit: 'Slim' }), {});
    eq(S.reconcileSelection(axes, variants, { Colour: 'Blue', Size: '<script>' }), { Colour: 'Blue' });
  });

  await T('an option with exactly one value to choose is chosen for the shopper', () => {
    const vs = S.selectableVariants([
      { id: 'a', options: { Colour: 'Red', Size: 'S' }, enabled: true },
      { id: 'b', options: { Colour: 'Red', Size: 'M' }, enabled: true },
    ]);
    const axes = S.variantAxes(vs, null);
    eq(S.reconcileSelection(axes, vs, {}), { Colour: 'Red' });
    // Only L left in Blue, and no size chosen yet: L is chosen.
    const { variants, axes: ax } = shirt(S);
    eq(S.reconcileSelection(ax, variants.filter((v) => v.id !== 'blue-m'), { Colour: 'Blue' }), { Colour: 'Blue', Size: 'L' });
  });

  await T('a full choice names its variant; a partial one names none', () => {
    const { variants, axes } = shirt(S);
    eq(S.matchVariant(axes, variants, { Colour: 'Blue', Size: 'L' })?.id, 'blue-l');
    eq(S.matchVariant(axes, variants, { Colour: 'Blue' }), null);
    eq(S.matchVariant(axes, variants, { Colour: 'Red', Size: 'XL' }), null, 'a disabled variant is never named');
  });

  await T('a variant that does not use an option is named with that option left empty', () => {
    const vs = S.selectableVariants([
      { id: 'gift', options: { Colour: 'Red' }, enabled: true },
      { id: 'blue-m', options: { Colour: 'Blue', Size: 'M' }, enabled: true },
    ]);
    const axes = S.variantAxes(vs, null);
    eq(S.matchVariant(axes, vs, { Colour: 'Red' })?.id, 'gift');
    eq(brief(S.axisStates(axes, vs, { Colour: 'Red' }, 1)), ['M:unavailable']);
  });

  await T('a ?variant= link opens that choice; a sold-out one opens what is still on sale', () => {
    const { variants, axes } = shirt(S);
    eq(S.initialSelection(axes, variants, 'blue-l'), { Colour: 'Blue', Size: 'L' });
    eq(S.initialSelection(axes, variants, 'red-s'), { Colour: 'Red' }, 'S is sold out in Red: the size is left to choose, not swapped');
    eq(S.initialSelection(axes, variants, 'black-m'), { Size: 'M' }, 'every Black is sold out: the colour goes, the size M it named stays');
    eq(S.initialSelection(axes, variants, 'nope'), {});
    eq(S.initialSelection(axes, variants, 'off'), {}, 'a disabled variant cannot be linked into');
  });

  await T('a disabled variant is not offered; buyable is the CMS\'s purchasable, else the stored flag', () => {
    eq(S.toSelectable({ id: 'x', options: { A: '1' }, enabled: false }), null);
    eq(S.toSelectable({ id: 'x', options: {}, enabled: true }), null);
    eq(S.toSelectable({ id: 'x', options: { A: '1' }, stock_status: { purchasable: false }, in_stock: true }).buyable, false);
    // Out of stock with backorders allowed: the CMS says purchasable.
    eq(S.toSelectable({ id: 'x', options: { A: '1' }, stock_status: { status: 'out-of-stock', purchasable: true }, in_stock: false }).buyable, true);
    eq(S.toSelectable({ id: 'x', options: { A: '1' }, in_stock: false }).buyable, false, 'older CMS');
    eq(S.toSelectable({ id: 'x', options: { A: '1' } }).buyable, true);
  });

  await T('labels follow option order, and the missing options are named in order', () => {
    const { axes } = shirt(S);
    eq(S.selectionLabel(axes, { Size: 'M', Colour: 'Red' }), 'Red / M');
    eq(S.missingAxes(axes, { Colour: 'Red' }), ['Size']);
  });
}

// ───────────────────────── `resolved`: the price the checkout will charge

const V = await loadTs('src/lib/commerce/variants.ts', 'vs-variants');
const F = await loadTs('src/lib/product-fields.ts', 'vs-fields');

// Written by the real writer, not a literal: normalizeVariants is what every
// save, import and API write goes through.
const base = {
  id: 'p1', name: 'Shirt', slug: 'shirt', sku: 'SHIRT', price_cents: 1500, regular_price_cents: 1500,
  status: 'active', images: [{ src: '/uploads/main.jpg' }],
  variants: F.normalizeVariants([
    { id: 'inherit', options: { Colour: 'Red' }, stock: 3 },
    { id: 'own', options: { Colour: 'Blue' }, price_cents: 1200, sku: 'SHIRT-B', image: '/uploads/blue.jpg', stock: 1 },
    { id: 'sale', options: { Colour: 'Green' }, price_cents: 2000, regular_price_cents: 2000, sale_price_cents: 1600, stock: 1 },
    { id: 'off', options: { Colour: 'Pink' }, price_cents: 900, enabled: false, stock: 1 },
  ]),
};

await check('a variant without a price shows the product\'s, with the product\'s SKU and main image', () => {
  const r = V.withResolvedVariants(base).variants.find((v) => v.id === 'inherit').resolved;
  eq(r, { price_cents: 1500, regular_price_cents: 1500, on_sale: false, sku: 'SHIRT', image: '/uploads/main.jpg' });
});

await check('a variant with its own price, SKU and image shows them, not the product\'s', () => {
  const r = V.withResolvedVariants(base).variants.find((v) => v.id === 'own').resolved;
  eq([r.price_cents, r.sku, r.image], [1200, 'SHIRT-B', '/uploads/blue.jpg']);
});

await check('a variant on sale shows the sale price and the regular one', () => {
  const r = V.withResolvedVariants(base).variants.find((v) => v.id === 'sale').resolved;
  eq([r.price_cents, r.regular_price_cents, r.on_sale], [1600, 2000, true]);
});

await check('resolved is exactly what the checkout resolves, for every variant', () => {
  const out = V.withResolvedVariants(base);
  for (const v of out.variants.filter((x) => x.enabled)) {
    const c = V.resolvePurchasable(base, v.id);
    eq(v.resolved.price_cents, c.price_cents, `${v.id} price`);
    eq(v.resolved.on_sale, c.on_sale, `${v.id} on_sale`);
  }
});

await check('the product itself is not changed, and a simple product is passed through', () => {
  const before = JSON.stringify(base);
  V.withResolvedVariants(base);
  eq(JSON.stringify(base), before, 'the input was mutated');
  const simple = { ...base, variants: [] };
  ok(V.withResolvedVariants(simple) === simple, 'a product without variants was copied');
});

await check('resolved is never stored: the writer drops it when a read is written back', () => {
  const read = V.withResolvedVariants(base);
  const written = F.normalizeVariants(read.variants, base.variants);
  ok(written.every((v) => !('resolved' in v)), 'normalizeVariants kept `resolved`');
});

await check('both product routes put resolved on the variants they send', async () => {
  for (const f of ['src/pages/api/products/index.ts', 'src/pages/api/products/[id].ts']) {
    const src = await fs.readFile(path.join(ROOT, f), 'utf8');
    ok(/withStockStatus\(withResolvedVariants\(/.test(src), `${f} does not apply withResolvedVariants`);
  }
});

// ─────────────────────────────────────── the starter's build-time view

const PV = await loadTs('examples/storefront/src/lib/variant-view.ts', 'vs-view');

await check('the starter shows the CMS\'s resolved price and SKU, not the raw variant field', () => {
  const product = {
    ...base, attributes: [{ name: 'Colour', values: ['Red', 'Blue', 'Green'] }],
    variants: V.withResolvedVariants(base).variants.map((v) => ({ ...v, stock_status: { status: 'in-stock', purchasable: true } })),
  };
  const d = PV.pickerData(product, 'EUR');
  eq(d.axes, [{ name: 'Colour', values: ['Red', 'Blue', 'Green'] }]);
  eq([d.views.inherit.price, d.views.inherit.sku, d.views.inherit.was], ['€15.00', 'SHIRT', null]);
  eq([d.views.sale.price, d.views.sale.was], ['€16.00', '€20.00'], 'the sale price, not the raw 2000');
  ok(!('off' in d.views), 'a disabled variant has a view');
});

await check('against a CMS without resolved, the variant\'s own price or the product\'s — and no invented sale', () => {
  const d = PV.pickerData({ ...base, variants: base.variants }, 'EUR');
  eq([d.views.inherit.price, d.views.own.price, d.views.sale.price, d.views.sale.was], ['€15.00', '€12.00', '€20.00', null]);
});

await check('the data block cannot be closed by an option name', () => {
  const json = PV.pickerJson({ axes: [{ name: '</script><b>', values: [] }], variants: [], views: {} });
  ok(!json.includes('<'), json);
  eq(JSON.parse(json).axes[0].name, '</script><b>');
});

if (failures.length) {
  console.error(`\n✗ variant-selection: ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error(`  · ${f}`);
  process.exit(1);
}
console.log(`✓ variant-selection: ${passed} passed`);
