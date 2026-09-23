#!/usr/bin/env node
/**
 * The attention feed.
 *
 * A dashboard that tells an operator what needs doing is only worth having if
 * every card is TRUE. So the assertions here are mostly about restraint:
 *
 *  1. **A quiet shop gets NOTHING.** The failure mode of every dashboard like
 *     this is manufacturing a task to fill the space. A correctly configured
 *     install must produce an empty list.
 *  2. **A fault cannot be dismissed away.** `broken` ignores dismissal
 *     entirely — a card that was put away and then came back is precisely the
 *     case dismissal must not swallow.
 *  3. **Faults age UPWARD.** Oldest first within a severity, which is the
 *     opposite of a normal feed: the thing ignored longest is the thing going
 *     wrong quietly.
 *  4. **Every card can be acted on.** A card with no destination is a report.
 *  5. **One bad check cannot take the dashboard down.**
 *
 * Run with:  node tests/attention.test.mjs
 */
import { loadTs } from './lib/load.mjs';

const A = await loadTs('src/lib/admin/attention.ts');
// The real rule, not a copy of it: the assertion below must fail if the module
// ever stops consulting it.
const { canOpenAdminPage } = await loadTs('src/lib/admin-access.ts');

let pass = 0;
let fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };

const NOW = Date.parse('2026-09-10T12:00:00.000Z');
const ago = (days) => new Date(NOW - days * 86_400_000).toISOString();

/** A shop with nothing wrong. */
const HEALTHY = {
  // `shop_country` is the REAL key (TAX_KEYS.originCountry). An earlier version
  // of this fixture used `tax_origin_country`, which no writer in the codebase
  // produces — so the check under test read undefined forever, the card fired
  // on every shop, and this fixture asserted zero cards while sharing the same
  // invention. Two wrongs cancelling is exactly how a test stops being evidence.
  settings: { site_url: 'https://shop.example.com', tax_enabled: true, shop_country: 'GR' },
  schema: { current: 15, latest: 15 },
  products: [{ id: 'p1', status: 'active', in_stock: true }],
  orders: [{ id: 'o1', status: 'pending', created_at: ago(1) }],
  posts: [{ id: 'a1', status: 'published' }],
  commerceEnabled: true,
  nowMs: NOW,
  // An admin unless a test says otherwise. Required, not incidental: cards are
  // filtered by what the viewer can open, and no role means no cards.
  role: 'admin',
};
const ids = (cards) => cards.map((c) => c.id);

/* -------------------------------------------------- a quiet shop stays quiet */
{
  const cards = A.runAttention(HEALTHY);
  check('a correctly configured shop is told NOTHING', cards.length === 0);

  // The other half of the same property: a shop with commerce OFF must not be
  // nagged about commerce.
  const blog = A.runAttention({
    settings: { site_url: 'https://blog.example.com' },
    products: [{ id: 'p1', status: 'active', in_stock: false }],
    orders: [{ id: 'o1', status: 'pending', risk_flagged: true, created_at: ago(9) }],
    commerceEnabled: false,
    nowMs: NOW,
    role: 'admin',
  });
  check('a shop with commerce off gets no commerce cards',
    !ids(blog).includes('active-out-of-stock') && !ids(blog).includes('flagged-orders'));
  // Brands are a catalogue concept too, and the card points at /admin/products.
  check('...including the brand-spelling card',
    !ids(A.runAttention({
      settings: { site_url: 'https://x', brand_spelling_report: { needs_a_human: [{}] } },
      commerceEnabled: false, role: 'admin', nowMs: NOW,
    })).includes('brand-spellings'));

  // And an empty install, where every collection is absent rather than empty.
  const bare = A.runAttention({ settings: { site_url: 'https://x.example' }, role: 'admin' });
  check('a brand-new install with no content at all is not nagged', bare.length === 0);
}

/* -------------------------------------------------- each check, on its own */
{
  const only = (over) => ids(A.runAttention({ ...HEALTHY, ...over }));

  check('an unset site address is reported',
    only({ settings: { ...HEALTHY.settings, site_url: '' } }).includes('site-url-unset'));
  // A setting saved blank is not a setting. Same lesson as settingBool.
  check('...and a whitespace-only address counts as unset',
    only({ settings: { ...HEALTHY.settings, site_url: '   ' } }).includes('site-url-unset'));

  check('tax on with no origin country is reported',
    only({ settings: { site_url: 'https://x', tax_enabled: true } }).includes('tax-origin-unset'));
  check('...and the REAL key silences it, proving the key name is load-bearing',
    !only({ settings: { site_url: 'https://x', tax_enabled: true, shop_country: 'GR' } })
      .includes('tax-origin-unset'));
  check('...while the invented key does NOT silence it',
    only({ settings: { site_url: 'https://x', tax_enabled: true, tax_origin_country: 'GR' } })
      .includes('tax-origin-unset'));
  // The check must not fire before it is relevant — an origin country is
  // meaningless on a shop that charges no tax.
  check('...but NOT when tax is off',
    !only({ settings: { site_url: 'https://x', tax_enabled: false } }).includes('tax-origin-unset'));
  // A setting can arrive as the STRING "true".
  check('...and the string "true" counts as on',
    only({ settings: { site_url: 'https://x', tax_enabled: 'true' } }).includes('tax-origin-unset'));

  check('a schema behind the build is reported',
    only({ schema: { current: 14, latest: 15 } }).includes('schema-behind'));
  check('...and a schema AHEAD is not — that is a downgrade, not a missed migration',
    !only({ schema: { current: 16, latest: 15 } }).includes('schema-behind'));

  check('unreviewed flagged orders are reported',
    only({ orders: [{ id: 'o1', status: 'pending', risk_flagged: true, created_at: ago(3) }] })
      .includes('flagged-orders'));
  check('...but a flagged order already dealt with is not',
    !only({ orders: [{ id: 'o1', status: 'completed', risk_flagged: true, created_at: ago(3) }] })
      .includes('flagged-orders'));

  check('an active product with no stock is reported',
    only({ products: [{ id: 'p1', status: 'active', in_stock: false }] })
      .includes('active-out-of-stock'));
  check('...but a DRAFT one is not — it is not on sale',
    !only({ products: [{ id: 'p1', status: 'draft', in_stock: false }] })
      .includes('active-out-of-stock'));

  check('a scheduled post whose date has passed is reported',
    only({ posts: [{ id: 'a1', status: 'scheduled', publish_date: ago(2) }] })
      .includes('overdue-scheduled-posts'));
  check('...but one still in the future is not',
    !only({ posts: [{ id: 'a1', status: 'scheduled', publish_date: new Date(NOW + 86_400_000).toISOString() }] })
      .includes('overdue-scheduled-posts'));

  check('the brand-spelling report becomes a card',
    only({ settings: { ...HEALTHY.settings, brand_spelling_report: { needs_a_human: [{}], possibly_related: [] } } })
      .includes('brand-spellings'));
  check('...but a report with nothing left to decide does not',
    !only({ settings: { ...HEALTHY.settings, brand_spelling_report: { needs_a_human: [], possibly_related: [] } } })
      .includes('brand-spellings'));

  check('the assistant\'s last error surfaces off the settings screen',
    only({ settings: { ...HEALTHY.settings, assistant_last_error: { at: '2026-09-05T00:00:00.000Z', status: 401, detail: 'invalid api key', provider: 'openai' } } })
      .includes('assistant-error'));
}

/* -------------------------------------------------- every card is actionable */
{
  const noisy = A.runAttention({
    settings: {
      tax_enabled: true,
      assistant_last_error: { at: '2026-09-05T00:00:00.000Z', status: 401, detail: 'boom', provider: 'openai' },
      brand_spelling_report: { needs_a_human: [{}, {}], possibly_related: [{}] },
    },
    schema: { current: 14, latest: 15 },
    products: [{ id: 'p1', status: 'active', in_stock: false }],
    orders: [{ id: 'o1', status: 'pending', risk_flagged: true, created_at: ago(5) }],
    posts: [{ id: 'a1', status: 'scheduled', publish_date: ago(2) }],
    commerceEnabled: true,
    nowMs: NOW,
    role: 'admin',
  });

  check('a shop in trouble gets every card at once', noisy.length >= 6);
  // RULE 1: no card that merely informs.
  check('EVERY card names a destination',
    noisy.every((c) => c.action && c.action.href.startsWith('/admin')));
  check('every card has a severity the renderer knows',
    noisy.every((c) => ['broken', 'unfinished', 'worth-knowing'].includes(c.severity)));
  check('every card declares whose dismissal it obeys',
    noisy.every((c) => c.scope === 'shop' || c.scope === 'user'));
  check('ids are unique, or dismissing one would hide another',
    new Set(ids(noisy)).size === noisy.length);
  // Counts are stated, not implied — "orders are flagged" is useless. The count
  // travels as a PARAM now, because the sentence around it is a translation.
  check('a card counting things carries the number',
    noisy.find((c) => c.id === 'brand-spellings')?.params?.count === 3);
  check('...and the schema card carries both versions',
    noisy.find((c) => c.id === 'schema-behind')?.params?.current === 14);
}

/* -------------------------------------------------- ordering */
{
  const cards = [
    { id: 'w', severity: 'worth-knowing', title: 't', body: 'b', action: { label: 'a', href: '/admin' }, scope: 'user' },
    { id: 'b-new', severity: 'broken', title: 't', body: 'b', action: { label: 'a', href: '/admin' }, since: ago(1), scope: 'shop' },
    { id: 'u', severity: 'unfinished', title: 't', body: 'b', action: { label: 'a', href: '/admin' }, scope: 'shop' },
    { id: 'b-old', severity: 'broken', title: 't', body: 'b', action: { label: 'a', href: '/admin' }, since: ago(30), scope: 'shop' },
    { id: 'b-undated', severity: 'broken', title: 't', body: 'b', action: { label: 'a', href: '/admin' }, scope: 'shop' },
  ];
  const ranked = ids(A.rankAttention(cards));
  check('severity comes first', ranked.slice(0, 3).every((id) => id.startsWith('b-')));
  /*
   * Severity must OUTRANK age, which the list above could not prove: every
   * broken card there happened to be older than the rest, so dropping the
   * severity comparison altogether left the order unchanged and the assertion
   * passed. `w-ancient` is a low-severity card older than every fault, so only
   * a real severity comparison can keep it off the top.
   */
  const mixed = A.rankAttention([
    { id: 'w-ancient', severity: 'worth-knowing', title: 't', body: 'b', action: { label: 'a', href: '/admin' }, since: ago(365), scope: 'user' },
    { id: 'b-recent', severity: 'broken', title: 't', body: 'b', action: { label: 'a', href: '/admin' }, since: ago(1), scope: 'shop' },
    { id: 'u-old', severity: 'unfinished', title: 't', body: 'b', action: { label: 'a', href: '/admin' }, since: ago(200), scope: 'shop' },
  ]);
  check('a fresh FAULT outranks year-old advice — severity beats age',
    ids(mixed)[0] === 'b-recent');
  check('...and unfinished still sits between them', ids(mixed)[1] === 'u-old');
  // THE DELIBERATE PART: a fault ignored for a month outranks one from
  // yesterday. A normal feed would do the opposite.
  check('within a severity the OLDEST fault is first — faults age upward',
    ranked.indexOf('b-old') < ranked.indexOf('b-new'));
  check('an undated card sorts after dated ones — unknown age is not "just now"',
    ranked.indexOf('b-undated') > ranked.indexOf('b-new'));
  check('unfinished outranks worth-knowing', ranked.indexOf('u') < ranked.indexOf('w'));
  check('ranking does not mutate its input', cards[0].id === 'w');
}

/* -------------------------------------------------- dismissal */
{
  const ctx = {
    settings: { site_url: 'https://x', assistant_last_error: { at: '2026-09-05T00:00:00.000Z', status: 401, detail: 'invalid api key', provider: 'openai' } },
    products: [{ id: 'p1', status: 'active', in_stock: false }],
    commerceEnabled: true,
    nowMs: NOW,
    role: 'admin',
  };
  const before = ids(A.runAttention(ctx));
  check('both cards show before dismissal',
    before.includes('active-out-of-stock') && before.includes('assistant-error'));

  const after = ids(A.runAttention(ctx, { dismissed: ['active-out-of-stock'] }));
  check('a dismissed advisory card is gone', !after.includes('active-out-of-stock'));
  check('...and the others are untouched', after.includes('assistant-error'));

  /* RULE 2 — the one that matters. */
  const faulty = { settings: { site_url: '' }, nowMs: NOW, role: 'admin' };
  check('a BROKEN card cannot be dismissed away',
    ids(A.runAttention(faulty, { dismissed: ['site-url-unset'] })).includes('site-url-unset'));
  check('...which is what isDismissible reports',
    A.isDismissible({ severity: 'broken' }) === false
    && A.isDismissible({ severity: 'unfinished' }) === true
    && A.isDismissible({ severity: 'worth-knowing' }) === true);

  // Dismissing something that is not showing must not throw or resurrect.
  check('dismissing an id that is not present changes nothing',
    ids(A.runAttention(ctx, { dismissed: ['no-such-card'] })).length === before.length);
}

/* -------------------------------------------------- one bad check */
{
  /*
   * RULE 5. This renders on the screen an operator opens most, and a dashboard
   * that 500s because one advisory check met an unexpected row shape is a far
   * worse outcome than a dashboard missing one card.
   */
  const exploding = { id: 'boom', run: () => { throw new Error('kaboom'); } };
  const fine = {
    id: 'fine',
    run: () => [{ id: 'fine', severity: 'worth-knowing', title: 'still here', body: 'the other checks ran', action: { label: 'go', href: '/admin' }, scope: 'user' }],
  };
  let threw = null;
  let out = [];
  try { out = A.runAttention(HEALTHY, { checks: [exploding, fine] }); } catch (e) { threw = e; }
  check(`a throwing check does not take the dashboard down${threw ? ` (threw ${threw.message})` : ''}`,
    threw === null);
  check('...and the checks beside it still report', ids(out).includes('fine'));

  // A check returning nothing at all, rather than an empty array.
  const nully = { id: 'nully', run: () => null };
  let threw2 = null;
  try { A.runAttention(HEALTHY, { checks: [nully] }); } catch (e) { threw2 = e; }
  check('a check returning null is treated as "no cards"', threw2 === null);
}

/* -------------------------------------------------- the registry is honest */
{
  check('every registered check has a unique id',
    new Set(A.ATTENTION_CHECKS.map((c) => c.id)).size === A.ATTENTION_CHECKS.length);
  check('every registered check is runnable', A.ATTENTION_CHECKS.every((c) => typeof c.run === 'function'));
  // A check must survive a context with nothing on it — a fresh install, or a
  // caller that could not load one of the collections.
  let threw = null;
  try {
    for (const c of A.ATTENTION_CHECKS) c.run({ settings: {} });
  } catch (e) { threw = e; }
  check(`every check survives an empty context${threw ? ` (threw ${threw.message})` : ''}`, threw === null);
}

/* ---------------------------------------- a card only reaches someone who can act */
{
  /*
   * `/admin` is open to EVERY staff role, so the dashboard renders for an
   * author as readily as for an admin. Before this filter existed an author
   * saw seven of eight cards, every one of them pointing at a screen the
   * middleware would bounce them from — and two of them carried information
   * the role boundary exists to withhold: the provider's raw error text, which
   * can contain a fragment of an API key, and how many orders the risk scorer
   * flagged.
   *
   * The same property the palette holds, in the sibling that forgot it.
   */
  const TROUBLE = {
    settings: {
      tax_enabled: true,
      assistant_last_error: { at: ago(2), status: 401, detail: 'AuthenticationError', provider: 'openai' },
      brand_spelling_report: { needs_a_human: [{}], possibly_related: [] },
    },
    schema: { current: 14, latest: 15 },
    products: [{ id: 'p1', status: 'active', in_stock: false }],
    orders: [{ id: 'o1', status: 'pending', risk_flagged: true, created_at: ago(5) }],
    posts: [{ id: 'a1', status: 'scheduled', publish_date: ago(2) }],
    commerceEnabled: true,
    nowMs: NOW,
  };
  const forRole = (role) => A.runAttention({ ...TROUBLE, role });

  check('an admin sees everything wrong with the shop', forRole('admin').length === 8);

  // The two that leak across the boundary, named individually so a regression
  // says WHICH one came back.
  const author = ids(forRole('author'));
  check('an author is NOT shown the provider\'s raw error text',
    !author.includes('assistant-error'));
  check('...nor how many orders were flagged', !author.includes('flagged-orders'));
  check('...nor anything pointing at settings', !author.includes('site-url-unset'));

  // But an author still gets what an author can act on.
  check('an author IS still told a scheduled post never published',
    author.includes('overdue-scheduled-posts'));
  check('...so the feed is not simply empty for them', author.length > 0);

  const manager = ids(forRole('manager'));
  check('a manager sees the catalogue cards', manager.includes('active-out-of-stock'));
  check('...and the flagged orders they are responsible for', manager.includes('flagged-orders'));
  check('...but not the settings ones', !manager.includes('tax-origin-unset'));

  /*
   * EVERY card, for EVERY role, must point somewhere that role can open. Driven
   * over the roles rather than asserted case by case, so a card added later is
   * covered without anyone remembering to extend this.
   */
  for (const role of ['admin', 'editor', 'author', 'manager']) {
    const shown = forRole(role);
    check(`${role}: every card shown links somewhere they can open`,
      shown.length > 0 && shown.every((c) => canOpenAdminPage(c.action.href, role)));
  }

  // Fails CLOSED. No role is not "trusted"; it is "nobody".
  check('no role means no cards at all', A.runAttention(TROUBLE).length === 0);
  check('...and an unrecognised role likewise',
    A.runAttention({ ...TROUBLE, role: 'subscriber' }).length === 0);
}

/* ---------------------------------------- the negatives each check still owed */
{
  const only = (over) => ids(A.runAttention({ ...HEALTHY, ...over }));

  /* site-url: the production shape, where the address comes from the BUILD. */
  check('a build-time SITE_URL silences the address card',
    !only({ settings: { ...HEALTHY.settings, site_url: '' }, buildSiteUrl: 'https://shop.example.com' })
      .includes('site-url-unset'));
  check('...and with neither settings row nor build value, it fires',
    only({ settings: { ...HEALTHY.settings, site_url: '' }, buildSiteUrl: '' })
      .includes('site-url-unset'));
  // The OTHER settings key that counts — public_site_url alone is enough.
  check('public_site_url alone is enough to silence it',
    !only({ settings: { site_url: '', public_site_url: 'https://x.example', tax_enabled: true, shop_country: 'GR' } })
      .includes('site-url-unset'));

  /* overdue posts: a PUBLISHED post with a past date is not overdue. */
  check('a published post with a past date is not overdue',
    !only({ posts: [{ id: 'a1', status: 'published', publish_date: ago(9) }] })
      .includes('overdue-scheduled-posts'));
  check('...nor a draft one', !only({ posts: [{ id: 'a1', status: 'draft', publish_date: ago(9) }] })
    .includes('overdue-scheduled-posts'));
  check('...nor a scheduled post whose date cannot be parsed — absent is not overdue',
    !only({ posts: [{ id: 'a1', status: 'scheduled', publish_date: 'not a date' }] })
      .includes('overdue-scheduled-posts'));

  /* out of stock: ABSENT is unknown, not false. */
  check('a product whose stock state is UNKNOWN is not reported as out of stock',
    !only({ products: [{ id: 'p1', status: 'active' }] }).includes('active-out-of-stock'));

  /* tax: the string "false" is a DECISION, not an absence. */
  check('tax_enabled as the string "false" means off, so no origin card',
    !only({ settings: { site_url: 'https://x', tax_enabled: 'false' } }).includes('tax-origin-unset'));

  /* assistant: the record is an OBJECT, and a stringy one must not fire. */
  check('the assistant card fires on the real record shape',
    only({ settings: { ...HEALTHY.settings, assistant_last_error: { at: ago(1), status: 401, detail: 'bad key', provider: 'openai' } } })
      .includes('assistant-error'));
  check('...but not on a bare string, which is not the shape anything writes',
    !only({ settings: { ...HEALTHY.settings, assistant_last_error: 'boom' } })
      .includes('assistant-error'));
  check('...nor on a record with no detail', 
    !only({ settings: { ...HEALTHY.settings, assistant_last_error: { at: ago(1), status: 401 } } })
      .includes('assistant-error'));
  // The record carries its own timestamp, so the card can age honestly.
  check('...and it takes its age from the record',
    A.runAttention({ ...HEALTHY, settings: { ...HEALTHY.settings, assistant_last_error: { at: ago(3), detail: 'x' } } })
      .find((c) => c.id === 'assistant-error')?.since === ago(3));
}

/* ------------------------ hardening step 4: money and checkout faults */
{
  const only = (over) => ids(A.runAttention({ ...HEALTHY, ...over }));

  // S4.3: money arrived for an order that will not ship.
  const refundOrders = [
    { id: 'o1', status: 'pending', created_at: ago(1) },
    { id: 'o2', status: 'cancelled', payment_status: 'paid', needs_refund: true, needs_refund_at: ago(4), created_at: ago(5) },
    { id: 'o3', status: 'cancelled', payment_status: 'paid', needs_refund: true, needs_refund_at: ago(2), created_at: ago(3) },
  ];
  const refund = A.runAttention({ ...HEALTHY, orders: refundOrders }).find((c) => c.id === 'orders-need-refund');
  check(`a paid order that cannot ship is a BROKEN card (${JSON.stringify(refund)})`,
    refund?.severity === 'broken' && refund?.params?.count === 2 && refund?.action?.href === '/admin/orders');
  check('...aged from the oldest flag, not the order', refund?.since === ago(4));
  check('...and cannot be dismissed away',
    only({ orders: refundOrders }).includes('orders-need-refund')
      && ids(A.runAttention({ ...HEALTHY, orders: refundOrders }, { dismissed: ['orders-need-refund'] })).includes('orders-need-refund'));
  check('...not shown on a shop with commerce off',
    !only({ orders: refundOrders, commerceEnabled: false }).includes('orders-need-refund'));
  check('...not shown to a role that cannot open orders',
    !ids(A.runAttention({ ...HEALTHY, orders: refundOrders, role: 'author' })).includes('orders-need-refund'));

  // S4.15: the opt-in risk hold places flagged orders ON HOLD, and they are
  // exactly the ones waiting for a person.
  const held = A.runAttention({
    ...HEALTHY,
    orders: [{ id: 'h1', status: 'on-hold', risk_flagged: true, risk_held: true, created_at: ago(2) }],
  }).find((c) => c.id === 'flagged-orders');
  check(`a risk-HELD order counts as flagged and waiting (${JSON.stringify(held)})`, held?.params?.count === 1);

  // S4.17: payment providers would send paying buyers to a page the CMS lacks.
  const ret = (verdict, over = {}) => A.runAttention({ ...HEALTHY, paymentReturnUrls: verdict, ...over })
    .find((c) => c.id === 'payment-return-urls');
  const warned = ret({ status: 'warn' });
  check(`a return-URL warning is an UNFINISHED card pointing at settings (${JSON.stringify(warned)})`,
    warned?.severity === 'unfinished' && warned?.action?.href === '/admin/settings');
  check('...and absent when the return URLs are fine', ret({ status: 'ok' }) === undefined);
  check('...or when nothing was checked', ret(undefined) === undefined);
  check('...or when commerce is off', ret({ status: 'warn' }, { commerceEnabled: false }) === undefined);
  check('a quiet shop with good return URLs is still told nothing',
    A.runAttention({ ...HEALTHY, paymentReturnUrls: { status: 'ok' } }).length === 0);
}

/* ---------------------------------------- every card is translatable */
{
  /*
   * A card carries an id and params, never a sentence. These assert the three
   * keys each id implies actually exist, in every shipped locale — the guard
   * that scans for literal translate-call sites cannot see keys built from an
   * id at render time, so without this a check could ship with no translation
   * and a green gate.
   */
  const en = await import('../src/locales/en/attention.ts').catch(() => null);
  check('the en catalogue module loads', !!en);
  for (const c of A.ATTENTION_CHECKS) {
    for (const part of ['title', 'body', 'action']) {
      check(`en has admin.attention.${c.id}.${part}`,
        typeof en?.attention?.[`admin.attention.${c.id}.${part}`] === 'string');
    }
  }
  // The two other shipped locales, for the cards step 4 added.
  for (const loc of ['el', 'de']) {
    const mod = await import(`../src/locales/${loc}/attention.ts`).catch(() => null);
    for (const id of ['orders-need-refund', 'payment-return-urls']) {
      for (const part of ['title', 'body', 'action']) {
        check(`${loc} has admin.attention.${id}.${part}`,
          typeof mod?.attention?.[`admin.attention.${id}.${part}`] === 'string');
      }
    }
  }
  check('no card carries an English sentence of its own',
    A.ATTENTION_CHECKS.every((c) => {
      const src = String(c.run);
      return !/title:\s*['"`]/.test(src) && !/body:\s*['"`]/.test(src);
    }));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
