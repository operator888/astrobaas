#!/usr/bin/env node
/**
 * Archive pages (C-153) and the editorial gate (C-150).
 *
 * Both rows had the same shape of gap: a status and a filter that EXISTED and
 * nothing enforced or exposed. `review` was a decoration — `updatePost` checked
 * ownership and never checked who may set `published` — and `authorId` already
 * reached both storage drivers while no endpoint offered it.
 *
 * Run with:  node tests/archive-editorial.test.mjs
 */
import { loadTs } from './lib/load.mjs';

const A = await loadTs('src/lib/archive-view.ts');
const AUTH = await loadTs('src/lib/auth.ts');

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

// ───────────────────────────────────────────────── who may publish

check('only an editor or an admin may publish', () => {
  eq(AUTH.canPublishPosts('admin'), true);
  eq(AUTH.canPublishPosts('editor'), true);
  eq(AUTH.canPublishPosts('author'), false);
  eq(AUTH.canPublishPosts('manager'), false);
  eq(AUTH.canPublishPosts('viewer'), false);
  eq(AUTH.canPublishPosts(undefined), false);
});

check('publishing is NARROWER than authoring', () => {
  // The whole point of the row: canAuthorPosts admits author and manager, so
  // before this there was nothing between "may write" and "may go live".
  for (const role of ['author', 'manager']) {
    eq(AUTH.canAuthorPosts(role), true, role);
    eq(AUTH.canPublishPosts(role), false, role);
  }
});

// ───────────────────────────────────────────────── author archives

const USERS = [
  { id: 'u1', name: 'Anna Papadopoulou', email: 'anna@x.gr', public_archive: true },
  { id: 'u2', name: 'Bo', email: 'bo@x.gr' },
];

check('a slug is derived from the name, not stored', () => {
  // A stored field means a migration and a second place for the name and the
  // slug to disagree.
  eq(A.authorSlug(USERS[0]), 'anna-papadopoulou');
  eq(A.authorSlug({ email: 'solo@x.gr' }), 'solo');
});

check('a Greek name still produces a usable slug', () => {
  const slug = A.authorSlug({ name: 'Γιώργος Παπάς', email: 'g@x.gr' });
  if (!slug || slug === '-') throw new Error(slug);
});

check('TWO people who slug the same resolve to NOBODY', () => {
  // Showing the wrong person's posts under a colleague's name is worse than a
  // 404, and the reader could not detect it.
  const clashing = [
    { id: 'a', name: 'Anna Papadopoulou', email: 'a@x.gr' },
    { id: 'b', name: 'anna papadopoulou', email: 'b@x.gr' },
  ];
  eq(A.authorBySlug(clashing, 'anna-papadopoulou'), null);
  eq(A.authorBySlug(USERS, 'anna-papadopoulou')?.id, 'u1');
  eq(A.authorBySlug(USERS, 'nobody'), null);
});

check('OPT-IN: absent means no', () => {
  // The opposite default would publish a team roster the day somebody upgraded.
  eq(A.authorOptedIn(USERS[0]), true);
  eq(A.authorOptedIn(USERS[1]), false);
  eq(A.authorOptedIn({}), false);
  eq(A.authorOptedIn(null), false);
  eq(A.authorOptedIn({ public_archive: 'true' }), false, 'only a real boolean');
});

// ────────────────────────────────────────────────── date archives

const posts = [
  { publish_date: '2026-03-04T00:00:00Z' },
  { publish_date: '2026-03-20T00:00:00Z' },
  { created_at: '2026-01-09T00:00:00Z' },
  { publish_date: 'not-a-date' },
  {},
];

check('months are counted newest first, and junk is skipped', () => {
  eq(A.monthsOf(posts), [
    { year: 2026, month: 3, count: 2 },
    { year: 2026, month: 1, count: 1 },
  ]);
});

check('a post with no publish_date falls back to created_at', () => {
  eq(A.inMonth(posts, 2026, 1).length, 1);
});

check('a month filter is exact', () => {
  eq(A.inMonth(posts, 2026, 3).length, 2);
  eq(A.inMonth(posts, 2026, 2).length, 0);
  eq(A.inMonth(posts, 2025, 3).length, 0);
});

check('a month gets a readable label, and a bad one does not throw', () => {
  eq(A.monthLabel(2026, 3), 'March 2026');
  eq(A.monthLabel(2026, 13), '2026');
});

// ────────────────────────────────────────────────────── pagination

check('PAGE ONE HAS NO PARAMETER', () => {
  // `/blog` and `/blog?page=1` being two URLs for one listing is the
  // duplicate-content shape a canonical then has to clean up after.
  eq(A.pageHref('/blog', 1), '/blog');
  eq(A.pageHref('/blog', 0), '/blog');
  eq(A.pageHref('/blog', 2), '/blog?page=2');
});

check('an empty archive still has one page', () => {
  // Zero pages renders "page 1 of 0", which reads as broken.
  eq(A.pageCount(0, 10), 1);
  eq(A.pageCount(10, 10), 1);
  eq(A.pageCount(11, 10), 2);
  eq(A.pageCount(11, 0), 11, 'a zero page size does not divide by zero');
});

if (failures.length) {
  console.error(`\n✗ archive-editorial: ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error(`  · ${f}`);
  process.exit(1);
}
console.log(`✓ archive-editorial: ${passed} passed`);
