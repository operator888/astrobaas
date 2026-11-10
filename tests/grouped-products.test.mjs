#!/usr/bin/env node
/**
 * Grouped products (core item grouped-products).
 *
 * A grouped product is a page that shows 2–10 other products. Each member
 * keeps its own SKU, price and stock and is bought on its OWN cart line; the
 * group is never a line, has no price of its own (it reads "from" its cheapest
 * visible member, derived on read) and takes its availability from its members.
 *
 * ## What must hold
 *
 *   - membership is validated on every write: 2–10, no duplicates, not itself,
 *     no unknown id, no nested group, no NEW member with variants, and a
 *     product that is a member cannot become a group;
 *   - a group's price, sale, stock and variants are forced to nothing;
 *   - public reads resolve the members in order and skip draft and hidden ones,
 *     without leaking their ids; staff see every member;
 *   - the "from" price and the stock status follow the members as they are NOW;
 *   - the quote and order routes refuse the group as a line and accept its
 *     members as ordinary lines (no cart/quote/order change needed);
 *   - deleting a member removes it from every group, through saveProduct;
 *   - all of the above on lowdb, libsql and relational.
 *
 * Run with:  node tests/grouped-products.test.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTs, ROOT } from './lib/load.mjs';

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) pass += 1;
  else { fail += 1; console.error(`✗ ${name}`); }
}

/* ---------------------------------------------------------------- child --- */
if (process.env.GROUPED_CHILD) {
  const entry = path.join(ROOT, 'node_modules', '.cache', `grouped-entry-${process.pid}.ts`);
  await fs.mkdir(path.dirname(entry), { recursive: true });
  const abs = (rel) => JSON.stringify(path.join(ROOT, rel));
  await fs.writeFile(entry, [
    `export { LocalDB } from ${abs('src/lib/localdb.ts')};`,
    `export { GET as productGET, PUT as productPUT, DELETE as productDELETE } from ${abs('src/pages/api/products/[id].ts')};`,
    `export { GET as listGET, POST as createPOST } from ${abs('src/pages/api/products/index.ts')};`,
    `export { GET as statusGET } from ${abs('src/pages/api/products/[id]/stock-status.ts')};`,
    `export { POST as quotePOST } from ${abs('src/pages/api/orders/quote.ts')};`,
    `export { POST as orderPOST } from ${abs('src/pages/api/orders/index.ts')};`,
    `export { GET as suggestGET } from ${abs('src/pages/api/search/suggest.ts')};`,
  ].join('\n'));
  let M;
  try {
    M = await loadTs(path.relative(ROOT, entry), 'grouped');
  } finally {
    await fs.rm(entry, { force: true });
  }
  const { LocalDB } = M;
  await LocalDB.init();
  await LocalDB.updateSetting('commerce_enabled', true).catch(() => {});

  const admin = { id: 'u-admin', role: 'admin', email: 'a@example.com', name: 'Admin' };
  const call = async (handler, method, pathname, { params = {}, body, user = null } = {}) => {
    const url = new URL(`http://cms.test${pathname}`);
    const res = await handler({
      url, params, locals: { user, ip: '10.9.0.1' },
      request: new Request(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const create = async (input) => {
    const r = await call(M.createPOST, 'POST', '/api/products', {
      user: admin, body: { status: 'active', price_cents: 1000, ...input },
    });
    if (r.status !== 201) throw new Error(`create ${input.name}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.data;
  };
  const put = (id, body) => call(M.productPUT, 'PUT', `/api/products/${id}`, { params: { id }, body, user: admin });
  const getOne = (ref, user = null) => call(M.productGET, 'GET', `/api/products/${ref}`, { params: { id: ref }, user });

  const out = {};
  // The plan's acceptance case: tripod €50 (0 in stock), camera €800 (2),
  // lens €200, battery €30 — plus a hidden and a draft member.
  const tripod = await create({ name: 'Tripod', slug: 'tripod', sku: 'TRI', price_cents: 5000, stock: 0 });
  const camera = await create({ name: 'Camera', slug: 'camera', sku: 'CAM', price_cents: 80000, stock: 2 });
  const lens = await create({ name: 'Lens', slug: 'lens', sku: 'LEN', price_cents: 20000, stock: 5 });
  const battery = await create({ name: 'Battery', slug: 'battery', sku: 'BAT', price_cents: 3000 });
  const secret = await create({ name: 'Secret strap', slug: 'secret', price_cents: 100, catalog_visibility: 'hidden' });
  const drafty = await create({ name: 'Draft bag', slug: 'drafty', price_cents: 200, status: 'draft' });
  const shirt = await create({
    name: 'Shirt', slug: 'shirt', price_cents: 1500,
    variants: [{ options: { Size: 'S' }, stock: 3 }, { options: { Size: 'M' }, stock: 3 }],
  });

  const memberIds = [tripod.id, camera.id, lens.id, battery.id, secret.id, drafty.id];
  const kitRes = await call(M.createPOST, 'POST', '/api/products', {
    user: admin,
    body: {
      name: 'Camera kit', slug: 'camera-kit', price_cents: 99999, sale_price_cents: 5, stock: 7,
      type: 'grouped', grouped_product_ids: memberIds,
    },
  });
  out.kitCreate = { status: kitRes.status, body: kitRes.body?.data && {
    type: kitRes.body.data.type, price: kitRes.body.data.price_cents, stock: kitRes.body.data.stock,
    on_sale: kitRes.body.data.on_sale, ids: kitRes.body.data.grouped_product_ids,
  } };
  const kit = kitRes.body.data;
  const stored = await LocalDB.getProduct(kit.id);
  out.storedKit = {
    type: stored.type, price: stored.price_cents, regular: stored.regular_price_cents,
    sale: stored.sale_price_cents ?? null, stock: stored.stock, ids: stored.grouped_product_ids,
    hasDerived: 'grouped_products' in stored || 'price_from_cents' in stored,
  };

  // Refusals, each through the real route.
  const refuse = async (body, id) => {
    const r = id ? await put(id, body) : await call(M.createPOST, 'POST', '/api/products', {
      user: admin, body: { name: 'Bad group', price_cents: 0, type: 'grouped', ...body },
    });
    return { status: r.status, reason: r.body?.error?.reason ?? null };
  };
  out.refuse = {
    duplicate: await refuse({ grouped_product_ids: [camera.id, lens.id, camera.id] }),
    tooFew: await refuse({ grouped_product_ids: [camera.id] }),
    tooMany: await refuse({ grouped_product_ids: Array.from({ length: 11 }, (_, i) => `p${i}`) }),
    unknown: await refuse({ grouped_product_ids: [camera.id, 'no-such-product'] }),
    variable: await refuse({ grouped_product_ids: [camera.id, shirt.id] }),
    nested: await refuse({ grouped_product_ids: [camera.id, kit.id] }),
    self: await refuse({ grouped_product_ids: [kit.id, camera.id] }, kit.id),
    junk: await refuse({ grouped_product_ids: 'camera' }),
    withVariants: await refuse({ grouped_product_ids: [camera.id, lens.id], variants: [{ options: { Size: 'S' }, stock: 1 }] }),
    memberBecomesGroup: await refuse({ type: 'grouped', grouped_product_ids: [lens.id, battery.id] }, camera.id),
  };
  out.noBadGroupStored = (await LocalDB.getProducts()).filter((p) => p.name === 'Bad group').length;
  out.cameraStillSimple = (await LocalDB.getProduct(camera.id)).type ?? 'simple';

  // Public read: members resolved, in order, hidden and draft skipped.
  const pub = (await getOne('camera-kit')).body?.data;
  out.public = {
    names: pub?.grouped_products?.map((m) => m.name),
    ids: pub?.grouped_product_ids,
    price: pub?.price_cents, from: pub?.price_from_cents, regular: pub?.regular_price_cents, on_sale: pub?.on_sale,
    status: pub?.stock_status, tripod: pub?.grouped_products?.find((m) => m.name === 'Tripod')?.stock_status,
    camera: pub?.grouped_products?.find((m) => m.name === 'Camera'),
  };
  const staff = (await getOne(kit.id, admin)).body?.data;
  out.staffNames = staff?.grouped_products?.map((m) => m.name);
  out.staffFrom = staff?.price_from_cents;

  // The list route and the stock-status route agree with the single read.
  const list = (await call(M.listGET, 'GET', '/api/products?limit=50')).body?.data ?? [];
  const listed = list.find((p) => p.slug === 'camera-kit');
  out.list = { price: listed?.price_cents, from: listed?.price_from_cents, names: listed?.grouped_products?.map((m) => m.name) };
  const st = (await call(M.statusGET, 'GET', '/api/products/camera-kit/stock-status', { params: { id: 'camera-kit' } })).body?.data;
  out.statusRoute = { status: st?.status, purchasable: st?.purchasable, members: st?.members?.length };

  // Suggestions show the "from" price too.
  const sug = (await call(M.suggestGET, 'GET', '/api/search/suggest?q=camera%20kit&types=products')).body?.data;
  out.suggestPrice = sug?.products?.find((p) => p.slug === 'camera-kit')?.price_cents ?? null;

  // Derived on READ: a member's price change moves the group's "from" price
  // without anything rewriting the group.
  await put(battery.id, { sale_price_cents: 2500 });
  out.fromAfterSale = (await getOne('camera-kit')).body?.data?.price_from_cents;
  // ...and a member selling out changes the group's member answer.
  await put(camera.id, { stock: 0, stock_base: 2 });
  out.cameraAfterSellOut = (await getOne('camera-kit')).body?.data?.grouped_products?.find((m) => m.name === 'Camera')?.stock_status?.status;
  await put(camera.id, { stock: 2, stock_base: 0 });

  // The cart: the group itself is refused as a line; members are ordinary lines.
  const quote = (items, user = null) => call(M.quotePOST, 'POST', '/api/orders/quote', { body: { items }, user });
  const q1 = await quote([{ product_id: kit.id, qty: 1 }]);
  out.quoteGroup = { status: q1.status, reason: q1.body?.error?.reason ?? null };
  const q2 = await quote([{ product_id: camera.id, qty: 1 }, { product_id: lens.id, qty: 2 }]);
  out.quoteMembers = { status: q2.status, subtotal: q2.body?.data?.subtotal_cents, lines: q2.body?.data?.lines?.length };

  const order = (items) => call(M.orderPOST, 'POST', '/api/orders', {
    body: { email: 'buyer@example.com', name: 'Buyer', address: '1 Road', items },
  });
  const o1 = await order([{ product_id: kit.id, qty: 1 }]);
  out.orderGroup = { status: o1.status, reason: o1.body?.error?.reason ?? null };
  const o2 = await order([{ product_id: camera.id, qty: 1 }, { product_id: lens.id, qty: 2 }]);
  // The buyer-facing body carries no lines; read the stored order.
  const placed = (await LocalDB.getOrders()).find((o) => (o.items ?? []).some((i) => i.product_id === lens.id));
  out.orderMembers = {
    status: o2.status,
    items: placed?.items?.map((i) => [i.product_id === camera.id ? 'camera' : i.product_id === lens.id ? 'lens' : i.product_id, i.qty]),
    err: o2.status >= 300 ? o2.body : undefined,
  };
  out.cameraStockAfterOrder = (await LocalDB.getProduct(camera.id)).stock;
  const o3 = await order([{ product_id: tripod.id, qty: 1 }]);
  out.orderOutOfStock = o3.status;
  out.ordersWithGroupLine = (await LocalDB.getOrders()).filter((o) => (o.items ?? []).some((i) => i.product_id === kit.id)).length;

  // The admin editor's round trip: what a staff read returns, saved back.
  const reread = (await getOne(kit.id, admin)).body?.data;
  const roundTrip = await put(kit.id, {
    name: reread.name, type: reread.type, grouped_product_ids: reread.grouped_products.map((m) => m.id),
    grouped_products: reread.grouped_products, price_from_cents: reread.price_from_cents,
    price_cents: 0, regular_price_cents: 0, sale_price_cents: null, variants: [],
  });
  const afterTrip = await LocalDB.getProduct(kit.id);
  out.roundTrip = {
    status: roundTrip.status, ids: afterTrip.grouped_product_ids,
    leaked: 'grouped_products' in afterTrip || 'price_from_cents' in afterTrip,
  };
  // Reordering is a save of the same ids in a new order.
  const reordered = [lens.id, tripod.id, camera.id, battery.id, secret.id, drafty.id];
  await put(kit.id, { grouped_product_ids: reordered });
  out.reordered = (await getOne('camera-kit')).body?.data?.grouped_products?.map((m) => m.name);
  // A member that GAINS variants after joining is kept, and shown as such.
  await put(lens.id, { variants: [{ options: { Mount: 'E' }, stock: 2 }] });
  const lensView = (await getOne('camera-kit')).body?.data?.grouped_products?.find((m) => m.name === 'Lens');
  out.lensBecameVariable = lensView?.type;
  out.saveWithGrandfatheredVariable = (await put(kit.id, { name: 'Camera kit' })).status;

  // Deleting a member removes it from the group, through saveProduct.
  const del = await call(M.productDELETE, 'DELETE', `/api/products/${camera.id}`, { params: { id: camera.id }, user: admin });
  const afterDel = await LocalDB.getProduct(kit.id);
  out.afterDelete = { status: del.status, ids: afterDel.grouped_product_ids, type: afterDel.type };
  // ...down below the minimum, and the group survives.
  for (const p of [tripod, lens, battery, secret]) {
    await call(M.productDELETE, 'DELETE', `/api/products/${p.id}`, { params: { id: p.id }, user: admin });
  }
  const last = await LocalDB.getProduct(kit.id);
  out.afterAllDeleted = { ids: last.grouped_product_ids, type: last.type, price: last.price_cents };
  const emptyRead = (await getOne('camera-kit')).body?.data;
  out.emptyRead = { members: emptyRead?.grouped_products?.length, from: emptyRead?.price_from_cents, status: emptyRead?.stock_status };
  // An edit that does not touch the list still saves on a group upkeep left
  // with one member — a category rename or a bulk "feature" must not be blocked.
  out.unrelatedSaveOnSmallGroup = (await put(kit.id, { featured: true })).status;
  out.resendSmallList = (await put(kit.id, { grouped_product_ids: last.grouped_product_ids })).status;
  // Leaving the group without a price would make a €0 product: refused.
  const noPrice = await put(kit.id, { type: 'simple' });
  out.ungroupNoPrice = { status: noPrice.status, reason: noPrice.body?.error?.reason ?? null, type: (await LocalDB.getProduct(kit.id)).type };
  // JSON-LD: a group with no visible member publishes no €0 offer.
  out.emptyJsonld = JSON.stringify((await getOne('camera-kit')).body?.meta?.jsonld ?? '');
  // Unticking "grouped" makes it an ordinary product again, list cleared.
  await put(kit.id, { type: 'simple', price_cents: 1234 });
  const ungrouped = await LocalDB.getProduct(kit.id);
  out.ungrouped = { type: ungrouped.type, ids: ungrouped.grouped_product_ids ?? [], price: ungrouped.price_cents };

  console.log(`__RESULT__${JSON.stringify(out)}`);
  process.exit(0);
}

/* ------------------------------------------------------- pure helpers ----- */
const G = await loadTs('src/lib/commerce/grouped.ts');
const S = await loadTs('src/lib/commerce/stock-status.ts');
const V = await loadTs('src/lib/commerce/variants.ts');

const prod = (id, extra = {}) => ({
  id, name: id.toUpperCase(), slug: id, price_cents: 1000, on_sale: false, stock: null, in_stock: true,
  categories: [], images: [], status: 'active', created_at: '', updated_at: '', ...extra,
});
const catalogue = new Map([
  ['a', prod('a')], ['b', prod('b')], ['c', prod('c')],
  ['g', prod('g', { type: 'grouped', grouped_product_ids: ['a', 'b'] })],
  ['v', prod('v', { variants: [{ id: 'v1', options: { S: '1' }, stock: 1, in_stock: true, enabled: true }] })],
]);
const lookup = (id) => catalogue.get(id);
const val = (ids, extra = {}) => G.validateGroupMembers(ids, { lookup, ...extra });

check('limits are the plan\'s: 2 to 10', G.GROUP_LIMITS.min === 2 && G.GROUP_LIMITS.max === 10);
check('two known simple products are a group', val(['a', 'b']).ok && val(['a', 'b']).ids.join() === 'a,b');
check('order is kept', val(['c', 'a', 'b']).ids.join() === 'c,a,b');
check('a duplicate is refused, not deduplicated', val(['a', 'b', 'a']).code === 'group.duplicate_member');
check('one member is too few', val(['a']).code === 'group.too_few_members');
check('...unless membership upkeep shrinks it', val(['a'], { cascade: true }).ok);
check('eleven is too many, even in upkeep',
  val(Array.from({ length: 11 }, (_, i) => `x${i}`), { cascade: true }).code === 'group.too_many_members');
check('itself is refused', val(['a', 'b'], { selfId: 'a' }).code === 'group.self_member');
check('an unknown id is refused', val(['a', 'zzz']).code === 'group.unknown_member');
check('a group in a group is refused', val(['a', 'g']).code === 'group.nested_group');
check('a NEW member with variants is refused', val(['a', 'v']).code === 'group.variable_member');
check('...an existing one that gained variants is kept', val(['a', 'v'], { previous: ['a', 'v'] }).ok);
check('...but an existing one that became a group is not', val(['a', 'g'], { previous: ['a', 'g'] }).code === 'group.nested_group');
check('junk shapes are refused',
  ['a', null, { 0: 'a' }].every((x) => !val(x).ok) && val(['a', '<b>']).code === 'group.member_ids_invalid'
  && val(['a', 5]).code === 'group.member_ids_invalid');

// Stock status of a group.
const info = (stock, backorders) => S.productStockStatus({ stock, backorders }, 5);
check('a group is the best of its members', S.groupStockStatus([info(0), info(3), info(50)], 5).status === 'in-stock');
check('...low when the best member is low', S.groupStockStatus([info(0), info(3)], 5).status === 'low-stock');
check('...out and unbuyable when every member is out', (() => {
  const s = S.groupStockStatus([info(0), info(0)], 5);
  return s.status === 'out-of-stock' && !s.purchasable && !s.backorderable;
})());
check('...out but purchasable when a member takes backorders', (() => {
  const s = S.groupStockStatus([info(0), info(0, 'yes')], 5);
  return s.status === 'out-of-stock' && s.purchasable && s.backorderable;
})());
check('...never a summed count', S.groupStockStatus([info(3), info(4)], 5).available_qty === null);
check('...and no members is out of stock and unbuyable', (() => {
  const s = S.groupStockStatus([], 5);
  return s.status === 'out-of-stock' && !s.purchasable;
})());

// Reading a group.
const shop = new Map([
  ['t', prod('t', { name: 'Tripod', price_cents: 5000, stock: 0 })],
  ['c', prod('c', { name: 'Camera', price_cents: 80000, stock: 2, images: [{ src: '/v.mp4' }, { src: '/c.jpg', alt: 'cam' }] })],
  ['h', prod('h', { name: 'Hidden', price_cents: 1, catalog_visibility: 'hidden' })],
  ['d', prod('d', { name: 'Draft', price_cents: 2, status: 'draft' })],
  ['s', prod('s', { name: 'Search-only', price_cents: 900, catalog_visibility: 'search' })],
]);
const group = prod('kit', { type: 'grouped', grouped_product_ids: ['t', 'h', 'c', 'gone', 'd', 's'], price_cents: 0 });
const opts = (publicOnly) => ({ publicOnly, defaultThreshold: 5 });
const pubView = G.withGroup(group, (k) => shop.get(k), opts(true));
check('public: members in order, hidden/draft/missing skipped',
  pubView.grouped_products.map((m) => m.id).join() === 't,c,s');
check('public: the ids are narrowed too, so a hidden member\'s id is not published',
  pubView.grouped_product_ids.join() === 't,c,s');
check('"from" is the lowest VISIBLE member price (not the hidden €0.01)', pubView.price_from_cents === 900);
check('price_cents carries the "from" price, with no sale', pubView.price_cents === 900 && pubView.on_sale === false
  && pubView.sale_price_cents === null && pubView.regular_price_cents === 900);
check('a member image is its main PHOTO, not a leading video',
  pubView.grouped_products.find((m) => m.id === 'c').image.src === '/c.jpg');
check('each member carries its own stock status',
  pubView.grouped_products.find((m) => m.id === 't').stock_status.status === 'out-of-stock');
const staffView = G.withGroup(group, (k) => shop.get(k), opts(false));
check('staff: every member that exists, with its status and visibility',
  staffView.grouped_products.map((m) => m.id).join() === 't,h,c,d,s'
  && staffView.grouped_products.find((m) => m.id === 'd').status === 'draft');
check('staff see the SAME price and badge a shopper does',
  staffView.price_from_cents === pubView.price_from_cents
  && JSON.stringify(staffView.stock_status) === JSON.stringify(pubView.stock_status));
check('withGroup does not touch its input (a cached row)', (() => {
  const snap = JSON.stringify(group);
  G.withGroup(group, (k) => shop.get(k), opts(true));
  return JSON.stringify(group) === snap;
})());
check('a product that is not a group comes back untouched',
  G.withGroup(shop.get('c'), (k) => shop.get(k), opts(true)) === shop.get('c'));
check('no visible member: no "from" price', G.withGroup(prod('e', { type: 'grouped', grouped_product_ids: ['h'] }),
  (k) => shop.get(k), opts(true)).price_from_cents === null);
check('withGroupPrices sets a group\'s price from the same catalogue', (() => {
  const list = [...shop.values(), group];
  const priced = G.withGroupPrices(list);
  return priced.find((p) => p.id === 'kit').price_cents === 900 && list.find((p) => p.id === 'kit').price_cents === 0;
})());
check('groupsContaining finds every group that lists a product', G.groupsContaining([...catalogue.values()], 'a').map((p) => p.id).join() === 'g');

// The one resolver every pricing and ordering path uses refuses the group.
check('resolvePurchasable refuses a grouped product', V.resolvePurchasable(group) === null);
check('...with its own reason', V.explainResolveFailure(group).code === 'grouped-not-buyable');
check('...and still resolves an ordinary product', V.resolvePurchasable(shop.get('c'))?.price_cents === 80000);

// An automatic collection's price rule does not collect a group at its stored €0.
{
  const Col = await loadTs('src/lib/commerce/collections.ts');
  check('a price rule does not hold for a group (its stored price is not its price)',
    Col.conditionHolds(group, { field: 'price_cents', op: 'lt', value: 5000 }) === false
    && Col.conditionHolds(shop.get('t'), { field: 'price_cents', op: 'lt', value: 6000 }) === true);
}

// Bulk edits do not preview changes a group cannot take.
{
  const B = await loadTs('src/lib/commerce/bulk-edit.ts');
  const [planned] = B.planBulkEdit([group], { price: { mode: 'percent', value: 10 } });
  check('bulk price change skips a group', typeof planned.skipped === 'string' && !('regular_price_cents' in planned.patch));
  const [st] = B.planBulkEdit([group], { stock: 5 });
  check('bulk stock change skips a group', typeof st.skipped === 'string');
  const [ok] = B.planBulkEdit([group], { featured: true });
  check('...while a change a group CAN take still applies', ok.patch.featured === true && !ok.skipped);
}

/* --------------------------------------------- admin + starter, static --- */
const read = (rel) => fs.readFile(path.join(ROOT, rel), 'utf8');
{
  const admin = await read('src/pages/admin/products.astro');
  const dialog = admin.slice(admin.indexOf('<dialog id="product-dialog"'), admin.indexOf('</dialog>'));
  check('admin: a Group tab with its own panel', /data-tab="group"/.test(dialog) && /data-panel="group"/.test(dialog));
  check('admin: the picker searches, lists, reorders and warns',
    ['id="group-search"', 'id="group-results"', 'id="group-members"', 'id="group-warning"', 'name="is_grouped"']
      .every((n) => dialog.includes(n)));
  check('admin: the save sends type and the ordered ids',
    /type: grouped \? 'grouped' : 'simple'/.test(admin) && /grouped_product_ids: grouped \? groupMembers\.map\(\(m\) => m\.id\)/.test(admin));
  check('admin: an out-of-stock member raises the warning',
    /memberOut\(m\) && memberUnbuyable\(m\)/.test(admin) && /Out of stock: /.test(admin));
  check('admin: member names are never written with innerHTML',
    !/\.innerHTML\s*=/.test(admin.slice(admin.indexOf('/* ---------------- group members'), admin.indexOf('/* ---------------- tabs'))));
}
{
  const C = await loadTs('examples/storefront/src/lib/cart.ts');
  const mem = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) }; };
  const lines = C.linesFromQuery('?add.cam=1&add.lens=2&add.tri=0&add.x%3Cy=1&other=3&add.cam=5');
  check('starter: each member with a quantity above 0 is its own line; 0, junk and repeats are dropped',
    JSON.stringify(lines) === JSON.stringify([{ product_id: 'cam', qty: 1 }, { product_id: 'lens', qty: 2 }]));
  const s = mem();
  C.addToCart(s, 'cam', 1);
  check('starter: the group form adds to what is already in the cart',
    C.addFromQuery(s, '?add.cam=2&add.lens=1') === 2
    && JSON.stringify(C.readCart(s)) === JSON.stringify([{ product_id: 'cam', qty: 3 }, { product_id: 'lens', qty: 1 }]));
  const comp = await read('examples/storefront/src/components/GroupedProduct.astro');
  check('starter: the group page is a plain GET form to the cart — no JavaScript needed',
    /<form[^>]*method="get"[^>]*action="\/cart\/"/.test(comp) && !/<script/.test(comp));
  check('starter: one quantity box per member, named for the cart, and one submit button',
    /name=\{field\}/.test(comp) && /GROUP_FIELD_PREFIX/.test(comp) && (comp.match(/type="submit"/g) ?? []).length === 1
    && /Add selected to cart/.test(comp));
  check('starter: availability comes from the badge, not the page', /stockBadge\(m\)/.test(comp) && !/\.in_stock|available_qty|low_stock_threshold/.test(comp));
  const page = await read('examples/storefront/src/pages/product/[slug].astro');
  check('starter: the product page hands a group to GroupedProduct', /isGroup\(product\) \? <GroupedProduct/.test(page));
  const cart = await read('examples/storefront/src/pages/cart.astro');
  check('starter: the cart takes the group form\'s lines and drops the query', /addFromQuery\(store, location\.search\)/.test(cart) && /history\.replaceState/.test(cart));
}
{
  const api = await read('src/pages/openapi.json.ts');
  check('openapi documents the group fields',
    ['grouped_product_ids', 'grouped_products', 'price_from_cents', "'grouped'"].every((k) => api.includes(k)));
}

/* ------------------------------------------- routes, per storage driver --- */
const here = path.dirname(fileURLToPath(import.meta.url));
const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'astrobaas-grouped-'));
const DRIVERS = [
  { name: 'lowdb', env: (d) => ({ DB_PATH: path.join(d, 'db.json') }) },
  { name: 'libsql', env: (d) => ({ DATABASE_URL: `file:${path.join(d, 'db.sqlite')}` }) },
  { name: 'relational', env: (d) => ({ DATABASE_URL: `file:${path.join(d, 'db.sqlite')}`, DATABASE_DRIVER: 'relational' }) },
];
const results = {};
for (const driver of DRIVERS) {
  const dir = path.join(tmpRoot, driver.name);
  await fs.mkdir(path.join(dir, 'uploads'), { recursive: true });
  const run = spawnSync(process.execPath, [path.join(here, 'grouped-products.test.mjs')], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 240_000,
    env: {
      ...process.env, GROUPED_CHILD: '1', NODE_ENV: 'test', SITE_URL: 'https://shop.example.com',
      AUTH_SECRET: 'test-secret-'.padEnd(40, 'x'), UPLOADS_DIR: path.join(dir, 'uploads'), ...driver.env(dir),
    },
  });
  const line = (run.stdout || '').split('\n').find((l) => l.startsWith('__RESULT__'));
  if (!line) {
    fail += 1;
    console.error(`✗ [${driver.name}] child produced no result\n${(run.stdout || '').slice(-800)}\n${(run.stderr || '').slice(-2000)}`);
    continue;
  }
  const o = JSON.parse(line.slice('__RESULT__'.length));
  results[driver.name] = o;
  const t = (n, c) => check(`[${driver.name}] ${n}`, c);

  t('a group is created through POST /api/products', o.kitCreate.status === 201 && o.kitCreate.body?.type === 'grouped');
  t('its price, sale and stock are forced to nothing, whatever was sent',
    o.storedKit.price === 0 && o.storedKit.regular === 0 && o.storedKit.sale === null && o.storedKit.stock === null);
  t('its members are stored in order, all six', o.storedKit.ids?.length === 6);
  t('derived fields are never stored', o.storedKit.hasDerived === false);
  const r = o.refuse;
  t('refused: a duplicate member', r.duplicate.status === 400 && r.duplicate.reason === 'group.duplicate_member');
  t('refused: one member', r.tooFew.status === 400 && r.tooFew.reason === 'group.too_few_members');
  t('refused: eleven members', r.tooMany.status === 400 && r.tooMany.reason === 'group.too_many_members');
  t('refused: an unknown member', r.unknown.status === 400 && r.unknown.reason === 'group.unknown_member');
  t('refused: a member with variants', r.variable.status === 400 && r.variable.reason === 'group.variable_member');
  t('refused: a group inside a group', r.nested.status === 400 && r.nested.reason === 'group.nested_group');
  t('refused: the group inside itself', r.self.status === 400 && r.self.reason === 'group.self_member');
  t('refused: a member list that is not a list', r.junk.status === 400 && r.junk.reason === 'group.member_ids_invalid');
  t('refused: a group with variants', r.withVariants.status === 400 && r.withVariants.reason === 'group.has_variants');
  t('refused: a member turning into a group', r.memberBecomesGroup.status === 400 && r.memberBecomesGroup.reason === 'group.nested_group');
  t('...and nothing refused was stored', o.noBadGroupStored === 0 && o.cameraStillSimple === 'simple');

  t('public read: members resolved in order, hidden and draft skipped',
    o.public.names?.join() === 'Tripod,Camera,Lens,Battery');
  t('public read: the hidden and draft ids are not published', o.public.ids?.length === 4);
  t('public read: "from" the lowest visible price (€30), as price_cents too',
    o.public.from === 3000 && o.public.price === 3000 && o.public.regular === 3000 && o.public.on_sale === false);
  t('public read: the group is buyable while a member is; the tripod reads out of stock',
    o.public.status?.purchasable === true && o.public.status?.status === 'in-stock'
    && o.public.tripod?.status === 'out-of-stock' && o.public.tripod?.purchasable === false);
  t('public read: a member carries name, slug, price, stock_status and image',
    o.public.camera?.slug === 'camera' && o.public.camera?.price_cents === 80000
    && o.public.camera?.stock_status?.available_qty === 2 && 'image' in (o.public.camera ?? {}));
  t('staff read: every member, the same "from" price',
    o.staffNames?.join() === 'Tripod,Camera,Lens,Battery,Secret strap,Draft bag' && o.staffFrom === 3000);
  t('the list route agrees', o.list.price === 3000 && o.list.from === 3000 && o.list.names?.length === 4);
  t('the stock-status route agrees, member by member',
    o.statusRoute.status === 'in-stock' && o.statusRoute.purchasable === true && o.statusRoute.members === 4);
  t('search suggestions show the "from" price, not €0', o.suggestPrice === 3000);
  t('derived on read: a member\'s sale moves the group\'s "from" price', o.fromAfterSale === 2500);
  t('derived on read: a member selling out shows at once', o.cameraAfterSellOut === 'out-of-stock');

  t('quote: the group itself is refused as a line',
    o.quoteGroup.status === 400 && o.quoteGroup.reason === 'grouped-not-buyable');
  t('quote: its members are ordinary lines, priced by the CMS',
    o.quoteMembers.status === 200 && o.quoteMembers.subtotal === 120000);
  t('order: the group itself is refused, with its reason', o.orderGroup.status === 400
    && o.orderGroup.reason === 'grouped-not-buyable' && o.ordersWithGroupLine === 0);
  t(`order: members are placed as their own lines (${JSON.stringify(o.orderMembers)})`,
    o.orderMembers.status === 201 && JSON.stringify(o.orderMembers.items) === '[["camera",1],["lens",2]]'
    && o.cameraStockAfterOrder === 1);
  t('order: an out-of-stock member is refused on its own', o.orderOutOfStock === 409);

  t('the admin editor\'s round trip keeps every member and stores nothing derived',
    o.roundTrip.status === 200 && o.roundTrip.ids?.length === 6 && o.roundTrip.leaked === false);
  t('reordering is saved', o.reordered?.join() === 'Lens,Tripod,Camera,Battery');
  t('a member that gains variants stays, shown as "variable"', o.lensBecameVariable === 'variable');
  t('...and does not block the next save of the group', o.saveWithGrandfatheredVariable === 200);
  t('deleting a member removes it from the group', o.afterDelete.status === 200
    && o.afterDelete.ids?.length === 5 && o.afterDelete.type === 'grouped');
  t('...down below the minimum, and the group survives, still a group, still unpriced',
    o.afterAllDeleted.ids?.length === 1 && o.afterAllDeleted.type === 'grouped' && o.afterAllDeleted.price === 0);
  t('a group with no visible member reads as empty, unpriced and unbuyable',
    o.emptyRead.members === 0 && o.emptyRead.from === null && o.emptyRead.status?.purchasable === false);
  t('an edit that leaves the list alone still saves a one-member group', o.unrelatedSaveOnSmallGroup === 200);
  t('...while SETTING a one-member list is refused', o.resendSmallList === 400);
  t('leaving the group without a price is refused (no €0 product)',
    o.ungroupNoPrice.status === 400 && o.ungroupNoPrice.reason === 'group.price_required' && o.ungroupNoPrice.type === 'grouped');
  t('a group with no visible member publishes no Offer', o.emptyJsonld.length > 2 && !o.emptyJsonld.includes('Offer'));
  t('unticking "grouped" makes it an ordinary product with its list cleared',
    o.ungrouped.type === 'simple' && o.ungrouped.ids.length === 0 && o.ungrouped.price === 1234);
}

// All three drivers must agree, not merely each pass.
{
  const names = Object.keys(results);
  // Ids are generated per driver, so compare everything but them.
  const shape = (o) => JSON.stringify({
    names: o.public.names, ids: o.public.ids?.length, price: o.public.price, from: o.public.from,
    status: o.public.status, tripod: o.public.tripod, camera: { ...o.public.camera, id: undefined },
    r: o.refuse, q: o.quoteMembers, order: o.orderMembers, d: o.afterDelete.ids?.length, t: o.reordered,
    staff: o.staffNames, list: o.list, st: o.statusRoute, sug: o.suggestPrice, gone: o.afterAllDeleted.ids?.length,
  });
  check('the three drivers give the same answers', names.length === 3 && names.every((n) => shape(results[n]) === shape(results[names[0]])));
}

await fs.rm(tmpRoot, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
