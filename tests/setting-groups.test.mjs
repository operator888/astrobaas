#!/usr/bin/env node
/**
 * Declared settings groups (C-127) — ACF's options pages.
 *
 * The point of this feature is NOT the generated form. It is the enforcement
 * behind it: without a server-side rule, POST /api/settings/update accepts any
 * shape that fits the generic 64 KB / depth-8 limit, so a field an operator
 * declared as a number happily stores the word "later" and the form is
 * decoration.
 *
 * The other thing worth testing is the storage key, because that is what
 * decides whether a value is world-readable: `isPublicSetting` discloses the
 * `public_` prefix, so a group's prefix IS its read policy.
 *
 * Run with:  node tests/setting-groups.test.mjs
 */
import { loadTs } from './lib/load.mjs';

const G = await loadTs('src/core/setting-groups.ts');
const SV = await loadTs('src/lib/settings-validate.ts');
const VIS = await loadTs('src/lib/settings-visibility.ts');

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

const group = (over = {}) => ({
  id: 'booking', label: 'Booking',
  fields: [
    { name: 'inbox', rule: { type: 'email' } },
    { name: 'lead_days', rule: { type: 'number', min: 0, max: 30, optional: true } },
  ],
  ...over,
});

// ────────────────────────────────────────────────────────────── validation

check('a well-formed group is accepted and REBUILT', () => {
  const r = G.validateSettingGroups([group({ evil: 'x' })]);
  if (!r.ok) throw new Error(r.errors.join());
  if ('evil' in r.groups[0]) throw new Error('kept an unknown key');
  eq(r.groups[0].id, 'booking');
});

check('nothing declared is fine', () => {
  for (const raw of [undefined, null, '', []]) {
    const r = G.validateSettingGroups(raw);
    if (!r.ok) throw new Error(`${String(raw)}: ${r.errors.join()}`);
    eq(r.groups, []);
  }
});

check('a group is PRIVATE unless it says otherwise', () => {
  // A settings group is where an operator puts what the product has no field
  // for, and some of that is a booking mailbox or a warehouse address.
  const r = G.validateSettingGroups([group()]);
  eq(r.groups[0].public, undefined);
});

check('an id that is not kebab-case is refused', () => {
  for (const id of ['Booking', 'a', '1x', 'a b', '../x']) {
    if (G.validateSettingGroups([group({ id })]).ok) throw new Error(`accepted ${id}`);
  }
});

check('two groups with the same id are refused', () => {
  if (G.validateSettingGroups([group(), group()]).ok) throw new Error('accepted a duplicate id');
});

check('a group with no fields is refused', () => {
  if (G.validateSettingGroups([group({ fields: [] })]).ok) throw new Error('accepted an empty group');
});

check('a bad field rule is refused, named by position', () => {
  const r = G.validateSettingGroups([group({ fields: [{ name: 'a', rule: { type: 'enum' } }] })]);
  if (r.ok) throw new Error('accepted an enum with no values');
  if (!/groups\[0\].fields\[0\]/.test(r.errors.join())) throw new Error(r.errors.join());
});

check('a REPEATER in a settings group is refused, with a reason', () => {
  // It would work — the store holds one bounded JSON value per key — but a
  // settings screen that grows a nested list editor is a content type wearing
  // a disguise, and the product already has content types.
  const r = G.validateSettingGroups([group({ fields: [
    { name: 'tiers', rule: { type: 'repeater', fields: [{ name: 'n', rule: { type: 'string' } }] } },
  ] })]);
  if (r.ok) throw new Error('accepted a repeater');
  if (!/content type/.test(r.errors.join())) throw new Error(r.errors.join());
});

check('too many groups, or too many fields, are refused', () => {
  const many = Array.from({ length: G.MAX_SETTING_GROUPS + 1 }, (_, i) => group({ id: `g-${i}` }));
  if (G.validateSettingGroups(many).ok) throw new Error('accepted too many groups');
  const wide = group({ fields: Array.from({ length: G.MAX_FIELDS_PER_GROUP + 1 },
    (_, i) => ({ name: `f${i}`, rule: { type: 'string' } })) });
  if (G.validateSettingGroups([wide]).ok) throw new Error('accepted too many fields');
});

// ───────────────────────────────────────────── the key IS the read policy

check('a private group keys its fields under group.', () => {
  eq(G.settingKeyFor({ id: 'booking' }, 'inbox'), 'group.booking.inbox');
});

check('a PUBLIC group keys them under public_group.', () => {
  eq(G.settingKeyFor({ id: 'booking', public: true }, 'inbox'), 'public_group.booking.inbox');
});

check('THE POLICY HOLDS: only the public prefix is disclosed anonymously', () => {
  // This is the whole headless story — no new endpoint, and the existing
  // isPublicSetting already discloses `public_`. If that stopped being true,
  // a private group would become world-readable with nothing to say so.
  if (VIS.isPublicSetting('group.booking.inbox')) throw new Error('a private group leaked');
  if (!VIS.isPublicSetting('public_group.booking.inbox')) throw new Error('a public group is hidden');
});

// ──────────────────────────────────────────────────────── enforcement

const GROUPS = G.validateSettingGroups([group({ public: true })]).groups;

check('settingRuleFor finds a declared key\'s rule', () => {
  eq(SV.validateSetting('public_group.booking.inbox', 'not-an-email', GROUPS) !== null, true);
  eq(SV.validateSetting('public_group.booking.inbox', 'a@b.gr', GROUPS), null);
});

check('THE ONE THAT MATTERS: a declared NUMBER refuses text', () => {
  // Without this the generated form is decoration: the generic size check
  // passes anything under 64 KB.
  if (SV.validateSetting('public_group.booking.lead_days', 'later', GROUPS) === null) {
    throw new Error('stored text in a number field');
  }
  eq(SV.validateSetting('public_group.booking.lead_days', 3, GROUPS), null);
});

check('a declared rule\'s BOUNDS are enforced', () => {
  if (SV.validateSetting('public_group.booking.lead_days', 99, GROUPS) === null) {
    throw new Error('accepted a value above max');
  }
});

check('an empty value clears an OPTIONAL field rather than failing', () => {
  // A settings screen has no way to express "absent" other than an empty box.
  eq(SV.validateSetting('public_group.booking.lead_days', '', GROUPS), null);
  eq(SV.validateSetting('public_group.booking.lead_days', null, GROUPS), null);
});

check('a key NO group declares is left to the built-in rules', () => {
  // The declared-key branch must not become a deny-list for everything else.
  eq(SV.validateSetting('site_title', 'A shop', GROUPS), null);
  eq(SV.validateSetting('group.other.thing', 'anything', GROUPS), null);
});

check('with no groups passed, nothing changes for the built-in keys', () => {
  eq(SV.validateSetting('site_title', 'A shop'), null);
  eq(SV.validateSetting('public_group.booking.lead_days', 'later'), null, 'undeclared without groups');
});

check('validateSettings reports every declared problem at once', () => {
  const problems = SV.validateSettings({
    'public_group.booking.inbox': 'nope',
    'public_group.booking.lead_days': 'later',
  }, GROUPS);
  eq(problems.length, 2);
});

if (failures.length) {
  console.error(`\n✗ setting-groups: ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error(`  · ${f}`);
  process.exit(1);
}
console.log(`✓ setting-groups: ${passed} passed`);
