#!/usr/bin/env node
/**
 * The admin list pagination maths (src/lib/admin-paging.ts), shared by the
 * products, posts and pages screens. The screens themselves are driven in
 * tests/e2e/cms.spec.ts; this pins the arithmetic a screen cannot show you
 * the edges of.
 *
 * Run with:  node tests/admin-paging.test.mjs
 */
import { loadTs } from './lib/load.mjs';

const P = await loadTs('src/lib/admin-paging.ts');

let pass = 0;
let fail = 0;
const check = (n, c, detail = '') => {
  if (c) pass++;
  else { fail++; console.error(`✗ ${n}${detail ? `\n    ${detail}` : ''}`); }
};
const q = (s) => new URLSearchParams(s);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- readPaging ----
{
  const p = P.readPaging(q(''), 312);
  check('defaults: page 1 of 25', p.page === 1 && p.pageSize === 25 && p.totalPages === 13 && p.start === 0 && p.end === 25);
  const p2 = P.readPaging(q('page=2'), 312);
  check('page 2 is items 25–49', p2.start === 25 && p2.end === 50);
  const last = P.readPaging(q('page=13'), 312);
  check('the last page is short, not padded', last.start === 300 && last.end === 312);
  check('a page past the end shows the last page, not an empty one', P.readPaging(q('page=999'), 312).page === 13);
  for (const bad of ['page=0', 'page=-3', 'page=abc', 'page=', 'page=2.7']) {
    const r = P.readPaging(q(bad), 312);
    check(`?${bad} reads safely`, r.page >= 1 && r.page <= 13 && Number.isInteger(r.page), JSON.stringify(r));
  }
  check('?per=50 is honoured', P.readPaging(q('per=50'), 312).pageSize === 50);
  check('?per=100 is honoured', P.readPaging(q('per=100'), 312).totalPages === 4);
  for (const bad of ['per=7', 'per=100000', 'per=-1', 'per=abc']) {
    check(`?${bad} falls back to 25 — no unbounded page`, P.readPaging(q(bad), 312).pageSize === 25);
  }
  const empty = P.readPaging(q('page=4'), 0);
  check('an empty list is one empty page', empty.page === 1 && empty.totalPages === 1 && empty.start === 0 && empty.end === 0);
  check('exactly one full page is one page', P.readPaging(q(''), 25).totalPages === 1);
  check('one more makes two', P.readPaging(q(''), 26).totalPages === 2);
}

// ---- pageWindow ----
{
  check('few pages: all shown', eq(P.pageWindow(2, 4), [1, 2, 3, 4]));
  check('middle: first, neighbours, last, with gaps', eq(P.pageWindow(6, 20), [1, null, 5, 6, 7, null, 20]));
  check('start', eq(P.pageWindow(1, 20), [1, 2, null, 20]));
  check('end', eq(P.pageWindow(20, 20), [1, null, 19, 20]));
  check('a gap of one page shows the page, not "…"', eq(P.pageWindow(4, 20), [1, 2, 3, 4, 5, null, 20]));
  check('a single page', eq(P.pageWindow(1, 1), [1]));
}

// ---- listHref ----
{
  const sp = q('q=frame&status=active&page=3&per=50');
  check('a page link keeps the search and filters', P.listHref(sp, { page: 4 }) === '?q=frame&status=active&page=4&per=50');
  check('changing the size goes back to page 1', P.listHref(sp, { per: 100, page: null }) === '?q=frame&status=active&per=100');
  check('page 1 and the default size are left out of the URL', P.listHref(q('page=2&per=50'), { page: 1, per: 25 }) === '?');
  check('clearing the search keeps the rest', P.listHref(sp, { q: null, page: null }) === '?status=active&per=50');
  check('values are encoded', P.listHref(q(''), { q: 'a&b c' }) === '?q=a%26b+c');
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
