#!/usr/bin/env node
/**
 * The shared vocabulary: html-text, settings-map, money-format, admin-ui.
 *
 * These four modules exist because the same code was written five, eleven, five
 * and seven times respectively — and in three of those four cases **the copies
 * disagreed**. So the assertions here are mostly about the disagreements:
 *
 *   · a tag boundary IS a word boundary (two strippers said otherwise);
 *   · settings keys are operator-supplied, so the map must be null-prototype;
 *   · the string "false" is truthy, which is how an operator turned something
 *     off through the API and was told it succeeded;
 *   · Greek punctuation is not Latin punctuation.
 *
 * Run with:  node tests/shared-lib.test.mjs
 */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const cacheDir = path.join(root, 'node_modules', '.cache');
await fs.mkdir(cacheDir, { recursive: true });

async function load(rel, tag) {
  const out = path.join(cacheDir, `astrobaas-${tag}-${process.pid}.mjs`);
  await build({
    entryPoints: [path.join(root, rel)],
    bundle: true, format: 'esm', platform: 'node', packages: 'external',
    outfile: out, logLevel: 'silent',
  });
  // Removed once imported, as tests/lib/load.mjs does: this file left one
  // artefact per module per run in node_modules/.cache, forever.
  try {
    return await import(pathToFileURL(out).href);
  } finally {
    await fs.rm(out, { force: true });
  }
}
const T = await load('src/lib/html-text.ts', 'htmltext');
const S = await load('src/lib/settings-map.ts', 'settingsmap');
const M = await load('src/lib/money-format.ts', 'money');
const U = await load('src/lib/admin-ui.ts', 'adminui');
const E = await load('src/lib/escape-html.ts', 'escapehtml');
const A = await load('src/lib/ai-assistant.ts', 'aiassistant');

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

// ═══════════════════════════════════════════════════════════════ html-text

check('a tag boundary IS a word boundary', () => {
  // The disagreement that forced this module: link-check.ts stripped with '',
  // everything else with ' '. So this counted 1 word in one caller and 2 in
  // another, and the byline's read time came from a different text than the
  // search excerpt.
  eq(T.plainText('<p>ten</p><p>words</p>'), 'ten words');
  eq(T.countWords('<p>ten</p><p>words</p>'), 2);
  eq(T.countWords('<b>a</b><b>b</b>'), 2);
});

check('entities decode, with the ampersand LAST', () => {
  // `&amp;lt;` is the TEXT `&lt;`, not the character `<`. Decoding & first
  // turns it into a tag-looking string.
  eq(T.plainText('Sales &amp; Support'), 'Sales & Support');
  eq(T.decodeEntities('&amp;lt;div&amp;gt;'), '&lt;div&gt;');
  eq(T.decodeEntities('&#65;&#x42;'), 'AB');
});

check('a numeric reference outside Unicode does not throw', () => {
  eq(T.decodeEntities('&#99999999;'), '');
  eq(T.decodeEntities('&#x110000;'), '');
});

check('script and style bodies are dropped, not counted as words', () => {
  // "function(){…}" counted as forty words is a silently wrong read time.
  eq(T.plainText('<p>real</p><script>var a = 1; var b = 2;</script>'), 'real');
  eq(T.plainText('<style>.a{color:red}</style><p>real</p>'), 'real');
});

check('countWords is not ASCII-only', () => {
  // \w would count zero words for Greek and German — on both live shops.
  eq(T.countWords('Πώς λειτουργεί το κατάστημα'), 4);
  eq(T.countWords('Größe und Qualität'), 3);
});

check('empty and non-string inputs are zero, not a throw', () => {
  for (const v of ['', null, undefined]) {
    eq(T.plainText(v), '', String(v));
    eq(T.countWords(v), 0, String(v));
  }
});

check('sentences splits GREEK punctuation, not only Latin', () => {
  // Greek writes a question mark as `;` and a semicolon as `·`. A splitter that
  // knows only .!? sees a Greek article as a few enormous sentences and reports
  // "far too long" on ordinary prose — permanently, on both live shops.
  eq(T.sentences('Τι κάνεις; Καλά είμαι. Εσύ;').length, 3);
  eq(T.sentences('Πρώτο· δεύτερο· τρίτο.').length, 3);
});

check('sentences still splits Latin normally', () => {
  eq(T.sentences('One. Two! Three?').length, 3);
  eq(T.sentences('<p>One.</p><p>Two.</p>').length, 2);
});

check('truncateWords does not cut a word in half', () => {
  eq(T.truncateWords('hello world', 20), 'hello world');
  const cut = T.truncateWords('hello beautiful world', 12);
  if (cut.includes('beau') && !cut.includes('beautiful')) throw new Error(`cut mid-word: ${cut}`);
  if (!cut.endsWith('…')) throw new Error(`no ellipsis: ${cut}`);
});

// ════════════════════════════════════════════════════════════ settings-map

check('the map is NULL-PROTOTYPE', () => {
  // Settings keys are operator-supplied. With a plain {}, a site that never
  // configured anything still answers truthily to map.constructor, and a
  // `?? default` on it silently keeps the inherited function.
  const m = S.settingsMap([{ key: 'site_title', value: 'Shop' }]);
  eq(m.constructor, undefined, 'constructor leaked from the prototype');
  eq(m.toString, undefined);
  eq(Object.getPrototypeOf(m), null);
});

check('a key literally named __proto__ is stored, not merged', () => {
  const m = S.settingsMap([{ key: '__proto__', value: { polluted: true } }]);
  eq({}.polluted, undefined, 'Object.prototype was polluted');
  eq(m.__proto__?.polluted, true, 'the value was not stored under its own key');
});

check('rubbish rows are skipped rather than crashing the map', () => {
  const m = S.settingsMap([null, undefined, { value: 1 }, { key: 7, value: 1 }, { key: 'ok', value: 2 }]);
  eq(m.ok, 2);
  eq(Object.keys(m).length, 1);
  eq(S.settingsMap(null), Object.create(null));
});

check('settingBool: the STRING "false" is false', () => {
  // Every reader that used a bare `!!` had this bug: an operator turning
  // something off through the API was told it succeeded and it stayed on.
  eq(S.settingBool('false'), false);
  eq(S.settingBool('0'), false);
  eq(S.settingBool('off'), false);
  eq(S.settingBool('no'), false);
  eq(S.settingBool(0), false);
});

check('settingBool accepts every spelling of yes', () => {
  for (const v of [true, 1, 'true', 'TRUE', '1', 'on', 'yes']) eq(S.settingBool(v), true, String(v));
});

check('settingBool: NOT SET falls back rather than reading as false', () => {
  eq(S.settingBool(undefined, true), true);
  eq(S.settingBool(null, true), true);
  eq(S.settingBool('', true), true);
  eq(S.settingBool('nonsense', true), true, 'unparseable is not a decision');
});

check('settingInt distinguishes a cleared field from a typed zero', () => {
  // Number(null) and Number('') are both 0. For a "how many" setting, 0 means
  // OFF — so a cleared box and a deliberate zero must not be told apart by luck.
  eq(S.settingInt('', 3), 3);
  eq(S.settingInt(null, 3), 3);
  eq(S.settingInt(undefined, 3), 3);
  eq(S.settingInt(0, 3), 0, 'an explicit 0 is a decision');
  eq(S.settingInt('0', 3), 0);
});

check('settingInt clamps and truncates', () => {
  eq(S.settingInt(999, 3, { max: 20 }), 20);
  eq(S.settingInt(-5, 3, { min: 0 }), 0);
  eq(S.settingInt(3.9, 0), 3);
  eq(S.settingInt('abc', 7), 7);
});

check('settingStr trims, and empty means unset', () => {
  eq(S.settingStr('  hi  '), 'hi');
  eq(S.settingStr('   ', 'fallback'), 'fallback');
  eq(S.settingStr(42), '42');
  eq(S.settingStr(null, 'x'), 'x');
  eq(S.settingStr({}, 'x'), 'x');
});

check('settingList takes an array OR a comma string, deduplicated', () => {
  // Admin screens post arrays; .env defaults and hand-edited rows are commas.
  eq(S.settingList(['a', 'b', 'a']), ['a', 'b']);
  eq(S.settingList('a, b ,a'), ['a', 'b']);
  eq(S.settingList(''), []);
  eq(S.settingList(null), []);
});

// ═══════════════════════════════════════════════════════════ money-format

check('money follows the READER, not a hardcoded el-GR', () => {
  // €89.00 and 89,00 € are the same amount written for two different people.
  const de = M.formatMoney(8900, { locale: 'de-DE' });
  const en = M.formatMoney(8900, { locale: 'en-US' });
  if (!de.includes('89,00')) throw new Error(`de: ${de}`);
  if (!en.includes('89.00')) throw new Error(`en: ${en}`);
});

check('a zero-decimal currency is not divided by 100', () => {
  // ¥8900 is 8900 yen, not 89.
  const jpy = M.formatMoney(8900, { currency: 'JPY', locale: 'en-US' });
  if (!/8,?900/.test(jpy)) throw new Error(`JPY rendered as ${jpy}`);
});

check('an unusable currency or locale falls back rather than throwing', () => {
  // A shop that stored `currency: "€"` should see a wrong symbol, not a 500.
  if (typeof M.formatMoney(100, { currency: '€' }) !== 'string') throw new Error('threw');
  if (typeof M.formatMoney(100, { locale: 'not a locale' }) !== 'string') throw new Error('threw');
  if (typeof M.formatMoney('nonsense') !== 'string') throw new Error('threw');
});

check('moneyPlain has no grouping separator', () => {
  // A spreadsheet reading 1.234,56 as a currency string is a support ticket.
  eq(M.moneyPlain(123456), '1234.56');
  eq(M.moneyPlain(8900, 'JPY'), '8900');
  eq(M.moneyPlain(null), '0.00');
});

// ══════════════════════════════════════════════════════════════ admin-ui

check('every notice class is a COMPLETE literal, never composed', () => {
  // Tailwind scans source text. A computed `bg-${c}-50` is not in the generated
  // stylesheet, so the notice renders unstyled in production and correctly in
  // dev — the worst shape a bug can have.
  const src = codeOnly('src/lib/admin-ui.ts');
  if (/bg-\$\{|text-\$\{|border-\$\{/.test(src)) throw new Error('a class name is composed at runtime');
  for (const kind of ['success', 'error', 'warn', 'info']) {
    const c = U.noticeClasses(kind);
    if (!c.includes('rounded-md')) throw new Error(`${kind}: ${c}`);
    if (!/bg-\w+-\d+/.test(c)) throw new Error(`${kind} has no background: ${c}`);
  }
});

check('an unknown kind falls back to info rather than rendering nothing', () => {
  eq(U.noticeClasses('nonsense'), U.noticeClasses('info'));
  eq(U.noticeClasses(), U.noticeClasses('info'));
});

check('flash sets textContent, never innerHTML', () => {
  // The message routinely carries a server error that routinely carries
  // something the user typed.
  const src = codeOnly('src/lib/admin-ui.ts');
  if (/innerHTML/.test(src)) throw new Error('admin-ui uses innerHTML');
  const el = { className: '', textContent: '' };
  U.flash(el, '<img src=x onerror=alert(1)>', 'error');
  eq(el.textContent, '<img src=x onerror=alert(1)>', 'as text');
});

check('an empty message HIDES the notice', () => {
  const el = { className: 'whatever', textContent: 'old' };
  U.flash(el, '');
  eq(el.className, 'hidden');
  eq(el.textContent, '');
});

check('a missing element is a no-op, not a thrown error', () => {
  // A screen that changed its markup must not take its own save button down.
  U.flash(null, 'x');
  U.flash(undefined, 'x');
});

check('timeAgo is localised and survives junk', () => {
  const now = Date.UTC(2026, 8, 1, 12, 0, 0);
  const out = U.timeAgo(new Date(now - 4 * 60_000).toISOString(), now, 'en');
  if (!/4 min/.test(out)) throw new Error(out);
  eq(U.timeAgo(null, now), '');
  eq(U.timeAgo('garbage', now), '');
});

// ═══════════════════════════════════════════════════ the sweep held

check('NO strip-tags copy survives outside html-text.ts', () => {
  // The whole point. A helper nobody calls removes no duplication.
  const hits = [];
  for (const f of walk(path.join(root, 'src'))) {
    if (f.endsWith('html-text.ts')) continue;
    if (/\.(ts|astro)$/.test(f) && codeOnly(path.relative(root, f)).includes('/<[^>]*>/g')) {
      hits.push(path.relative(root, f));
    }
  }
  eq(hits, []);
});

check('NO hand-built notice class string survives', () => {
  const hits = [];
  for (const f of walk(path.join(root, 'src'))) {
    if (f.endsWith('admin-ui.ts')) continue;
    if (/\.astro$/.test(f) && /rounded-md border text-sm' \+|rounded-md border text-sm ' \+/.test(codeOnly(path.relative(root, f)))) {
      hits.push(path.relative(root, f));
    }
  }
  eq(hits, []);
});

check('NO admin screen hardcodes el-GR for money', () => {
  const hits = [];
  for (const f of walk(path.join(root, 'src', 'pages', 'admin'))) {
    if (/\.astro$/.test(f) && codeOnly(path.relative(root, f)).includes("toLocaleString('el-GR', { style: 'currency'")) {
      hits.push(path.relative(root, f));
    }
  }
  eq(hits, []);
});

check('every admin-ui symbol used in a <script> is IMPORTED in that scope', () => {
  // This has now bitten twice. An Astro `<script>` is its own module: an import
  // in the FRONTMATTER is invisible there, so the symbol is undefined in the
  // browser. `astro check` reports it as "declared but never read" in the
  // frontmatter — which reads like a tidiness warning, not a runtime crash —
  // and the smoke suite never exercises those admin JS paths.
  //
  // The second time, the check that should have caught it was fooled by a
  // COMMENT mentioning lib/admin-ui.ts, which is why this strips comments.
  const bad = [];
  for (const f of walk(path.join(root, 'src', 'pages', 'admin'))) {
    if (!f.endsWith('.astro')) continue;
    const src = fsSync(path.relative(root, f));
    const at = src.indexOf('<script');
    if (at < 0) continue;
    const script = src.slice(at);
    const code = script.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const imported = script
      .split('\n')
      .some((l) => l.includes('admin-ui') && l.trimStart().startsWith('import'));
    for (const sym of ['charCount', 'sharedFlash', 'noticeClasses', 'pillClasses', 'timeAgo']) {
      if (new RegExp(`\\b${sym}\\s*\\(`).test(code) && !imported) {
        bad.push(`${path.relative(root, f)}: ${sym}`);
      }
    }
  }
  eq(bad, []);
});

check('every shared helper used in .astro frontmatter is IMPORTED there', () => {
  // `astro check` does NOT catch an undefined identifier in .astro frontmatter —
  // verified: it reported 0 errors on a page that threw
  // "ReferenceError: plainText is not defined" on every search. Only the live
  // smoke suite found it, and only because a query returned a 500.
  //
  // This has now bitten four times in one session, always the same way: an edit
  // introduces a call, and the guard that should add the import checks whether
  // the NAME appears in the file — which it now does, because the call is the
  // thing that just added it. So this checks for the import STATEMENT.
  const HELPERS = {
    plainText: 'html-text', countWords: 'html-text', sentences: 'html-text',
    settingsMap: 'settings-map', settingStr: 'settings-map', settingBool: 'settings-map',
    settingInt: 'settings-map', formatMoney: 'money-format',
    comparePostsForListing: 'post-query', expanderFromSetting: 'search/expander',
    plainTextOf: 'html-text',
  };
  const bad = [];
  for (const f of walk(path.join(root, 'src'))) {
    if (!f.endsWith('.astro')) continue;
    const src = fsSync(path.relative(root, f));
    const end = src.indexOf('\n---', 3);
    if (end < 0) continue;
    const frontmatter = src.slice(0, end);
    const code = frontmatter.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const [sym, mod] of Object.entries(HELPERS)) {
      if (!new RegExp(`\\b${sym}\\s*\\(`).test(code)) continue;
      const imported = frontmatter
        .split('\n')
        .some((l) => l.trimStart().startsWith('import') && l.includes(mod) && l.includes(sym));
      if (!imported) bad.push(`${path.relative(root, f)}: ${sym}`);
    }
  }
  eq(bad, []);
});

check('NO .astro scope CALLS a shared helper it has not imported', () => {
  // The other half of the same disease, and the half that produced a blocker
  // in this branch: RichTextEditor's <script> called syncEditorSurface() with
  // no import anywhere in the file, so every alignment click threw and the
  // change was dropped on save. `// @ts-nocheck` on that script hid it.
  //
  // The set of names is DERIVED from src/lib and src/core rather than typed
  // here, so a helper added tomorrow is covered without anybody remembering to
  // add it — which is exactly what the two older allow-list checks could not do.
  const strip2 = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  /** Astro `{/* … *\/}` and HTML comments, removed. */
  const stripMarkupComments = (s) => s
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/<!--[\s\S]*?-->/g, '');



  // Every name a scope binds by import — STATIC or dynamic, across line breaks,
  // because a multi-line clause is the normal way to bring in five helpers.
  function bound(code) {
    const names = new Set();
    const add = (clause) => {
      for (const part of clause.split(',')) {
        const raw = part.trim().replace(/^type\s+/, '');
        if (!raw) continue;
        const name = (raw.split(/\s+as\s+/).pop() || raw).trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
      }
    };
    for (const m of code.matchAll(/import\s*(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]*)\}\s*from/g)) add(m[1]);
    for (const m of code.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*await\s+import\(/g)) add(m[1]);
    for (const m of code.matchAll(/import\s+([A-Za-z_$][\w$]*)\s*(?:,|from)/g)) names.add(m[1]);
    for (const m of code.matchAll(/import\s+\*\s+as\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
    return names;
  }

  const exported = new Map();
  for (const f of [...walk(path.join(root, 'src', 'lib')), ...walk(path.join(root, 'src', 'core'))]) {
    if (!f.endsWith('.ts') || f.endsWith('.d.ts')) continue;
    for (const m of fsSync(path.relative(root, f)).matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) {
      exported.set(m[1], path.relative(root, f));
    }
  }

  const bad = [];
  for (const f of walk(path.join(root, 'src'))) {
    if (!f.endsWith('.astro')) continue;
    const rel = path.relative(root, f);
    const src = fsSync(rel);
    const fmEnd = src.startsWith('---') ? src.indexOf('\n---', 3) : -1;
    const frontmatter = fmEnd > 0 ? src.slice(0, fmEnd) : '';
    const rawRest = fmEnd > 0 ? src.slice(fmEnd + 4) : src;
    // Comments are removed BEFORE the block scan, not after. An Astro
    // `{/* … */}` or an HTML comment may legitimately CONTAIN the text
    // "<script>" — this file's own note about module scopes does — and a
    // scanner that treats it as a block opening swallows the rest of the
    // template and reports every symbol in it as script-scoped.
    const rest = stripMarkupComments(rawRest);


    const scopes = [];
    const open = /<script\b[^>]*?(\/?)>/g;
    let m; let template = ''; let cursor = 0;
    while ((m = open.exec(rest))) {
      if (m[1] === '/') continue;
      const bodyStart = m.index + m[0].length;
      const close = rest.indexOf('</script', bodyStart);
      const bodyEnd = close < 0 ? rest.length : close;
      scopes.push({ kind: '<script>', code: rest.slice(bodyStart, bodyEnd) });
      template += rest.slice(cursor, m.index);
      cursor = bodyEnd;
      open.lastIndex = bodyEnd;
    }
    template += rest.slice(cursor);
    // The template compiles into the frontmatter's module scope, so they are
    // one scope for this purpose — which is what made `defaultLocale()` in a
    // template a frontmatter problem.
    scopes.unshift({ kind: 'frontmatter', code: `${frontmatter}\n${template}` });

    for (const scope of scopes) {
      const code = strip2(scope.code);
      const names = bound(scope.code);
      for (const [name, mod] of exported) {
        if (!new RegExp(`(?<![\\w.$])${name}\\s*\\(`).test(code)) continue;
        // A local function, const, or a CLASS METHOD of the same name.
        if (new RegExp(`(?:function|const|let|var|class)\\s+${name}\\b`).test(code)) continue;
        if (new RegExp(`^\\s*(?:async\\s+)?${name}\\s*\\([^)]*\\)\\s*\\{`, 'm').test(code)) continue;
        if (names.has(name)) continue;
        bad.push(`${rel} [${scope.kind}]: calls ${name}() — exported by ${mod}, not imported here`);
      }
    }
  }
  eq(bad, []);
});

check('NO NEW test file spells its own TypeScript loader', () => {
  // Twenty-five files carried one, in EIGHT variants — differing in whether the
  // entry point resolved against the repo root or the test directory, and in
  // whether the compiled artefact was deleted afterwards (two variants left one
  // file per process id in node_modules/.cache, forever).
  //
  // The recon for this batch found twenty-three of the remaining capabilities
  // would each have added a twenty-sixth. tests/lib/load.mjs exists so they do
  // not, and the existing twenty-five are grandfathered BY NAME rather than by
  // a rule — a list that can only shrink, and the shrinking is safe to do one
  // file at a time.
  const GRANDFATHERED = new Set(["admin-access.test.mjs", "admin-nav.test.mjs", "client.test.mjs", "compliance.test.mjs", "legacy-urls.test.mjs", "lib.test.mjs", "manifest.test.mjs", "media-embed.test.mjs", "media-pipeline.test.mjs", "migrations.test.mjs", "money.test.mjs", "openapi.test.mjs", "patterns.test.mjs", "payments.test.mjs", "plugin-dependencies.test.mjs", "plugin-platform.test.mjs", "plugin-sections.test.mjs", "post-kind.test.mjs", "reserved-slugs.test.mjs", "search-expander.test.mjs", "sections.test.mjs", "shared-lib.test.mjs", "theme-manifest.test.mjs", "totp.test.mjs"]);
  const offenders = [];
  for (const f of walk(path.join(root, 'tests'))) {
    if (!f.endsWith('.mjs')) continue;
    const rel = path.relative(path.join(root, 'tests'), f);
    if (rel.startsWith('lib' + path.sep) || rel.startsWith('e2e' + path.sep)) continue;
    if (GRANDFATHERED.has(rel)) continue;
    if (/async function load\s*\(/.test(fsSync(path.relative(root, f)))) {
      offenders.push(`tests/${rel}: import { loadTs } from './lib/load.mjs' instead`);
    }
  }
  eq(offenders, []);
});

check('the assistant toggle survives TEXT storage', () => {
  // `enabled: map[...] === true` could never be satisfied on the relational
  // driver, which stores every setting as TEXT — the toggle came back as the
  // STRING "true". It failed CLOSED, which is why this was a feature nobody
  // could switch on rather than an incident.
  eq(A.resolveAssistantConfig({ assistant_enabled: 'true' }).enabled, true);
  eq(A.resolveAssistantConfig({ assistant_enabled: true }).enabled, true);
  eq(A.resolveAssistantConfig({ assistant_enabled: 'false' }).enabled, false);
  eq(A.resolveAssistantConfig({ assistant_enabled: false }).enabled, false);
  eq(A.resolveAssistantConfig({}).enabled, false, 'an assistant costs money per message; default off');
  eq(A.resolveAssistantConfig({ assistant_enabled: 'maybe' }).enabled, false, 'unreadable means off');
});

check('NOTHING walks a content type\'s fields FLAT any more', () => {
  // Three places filtered `def.fields` by rule type — the ref checker, the
  // media resolver, and the GDPR sweep that FINDS a data subject. All three
  // were flat by construction, and a repeater field can now hold an email.
  //
  // The consequence of the flat version is not a missing feature: it is a
  // subject-access request that answers "we hold nothing about you" while
  // holding it, and an erasure that leaves the address behind. That is the one
  // failure mode of gdpr.ts that is itself a breach.
  //
  // content-refs.ts keeps two flat helpers on purpose — `refFields` and
  // `mediaFields`, for callers that address a field by its own name — so the
  // check is on the pattern, not the file.
  const ALLOWED = new Set([
    path.join('src', 'lib', 'field-walk.ts'),
    path.join('src', 'lib', 'content-refs.ts'), // documented flat helpers
    path.join('src', 'core', 'content-types.ts'),
    path.join('src', 'core', 'manifest.ts'),
  ]);
  const offenders = [];
  for (const f of walk(path.join(root, 'src'))) {
    if (!/\.(ts|astro)$/.test(f)) continue;
    const rel = path.relative(root, f);
    if (ALLOWED.has(rel)) continue;
    const code = codeOnly(rel);
    // `def.fields.filter(f => f.rule.type === …)` in any spelling.
    // NOT `[^)]*` — the arrow function's own parens, `(f) => f.rule…`, sit
    // between the two anchors, so a paren-excluding class never matches and
    // the guard silently passes. It did, on the first attempt.
    if (/\.fields\s*\.filter\s*\([\s\S]{0,80}?\.rule\.type\s*===/.test(code)) {
      offenders.push(`${rel}: use fieldsOfType from lib/field-walk.ts`);
    }
  }
  eq(offenders, []);
});

check('ONLY assistant-runtime decides whether the AI assistant is live', () => {
  // src/lib/assistant-runtime.ts exists so that "is the assistant live?" is
  // answered in one place, and "live" means BOTH halves: the ai-assistant
  // plugin is active AND the settings are complete.
  //
  // Three surfaces ask it, and two of them used to ask a different question —
  // they called resolveAssistantConfig + assistantReady themselves and never
  // checked plugin activation. The consequence was not cosmetic: an operator
  // who deactivated the plugin saw the bubble disappear and reasonably believed
  // the feature was off, while POST /api/assistant/chat kept proxying
  // anonymous, unauthenticated requests to their PAID provider. Every call
  // cost them money on a feature they had switched off.
  //
  // The admin settings screen is exempt: it renders the configuration state
  // itself, including "you have set a key but the plugin is off", which is
  // precisely the thing it must be able to say.
  const EXEMPT = new Set([
    path.join('src', 'lib', 'ai-assistant.ts'),        // defines them
    path.join('src', 'lib', 'assistant-runtime.ts'),   // the one place
    path.join('src', 'pages', 'admin', 'settings', 'index.astro'), // shows the state
  ]);
  const offenders = [];
  for (const f of walk(path.join(root, 'src'))) {
    if (!/\.(ts|astro)$/.test(f)) continue;
    const rel = path.relative(root, f);
    if (EXEMPT.has(rel)) continue;
    const code = codeOnly(rel);
    if (/\bresolveAssistantConfig\s*\(|\bassistantReady\s*\(/.test(code)) {
      offenders.push(`${rel}: call liveAssistantConfig() instead`);
    }
  }
  eq(offenders, []);
});

check('NO hand-written HTML/XML escaper survives beside the shared ones', () => {
  // There were EIGHT copies, and the HTML ones had already drifted: three of
  // them (manifest.escapeAttr, image-dimensions.escapeAttr, toc.attrEscape)
  // never escaped the apostrophe, and maintenance.esc was typed `(value:
  // string)` so it threw on an undefined settings value instead of rendering
  // the maintenance page it exists to render.
  //
  // The apostrophe is not cosmetic: an unescaped `'` breaks out of a
  // SINGLE-quoted attribute, which is a spelling this codebase uses.
  const hits = [];
  for (const f of walk(path.join(root, 'src'))) {
    if (!/\.(ts|astro)$/.test(f)) continue;
    const rel = path.relative(root, f);
    if (rel.endsWith('escape-html.ts')) continue;
    const code = codeOnly(rel);
    // The signature of a hand-rolled escaper: an ampersand pass. Anything
    // needing one must call escapeHtml or escapeXml.
    if (/\.replace\(\s*\/&\/g\s*,\s*['"]&amp;['"]\s*\)/.test(code)) hits.push(rel);
  }
  eq(hits, []);
});

check('escapeHtml and escapeXml differ ONLY in the apostrophe, and deliberately', () => {
  // `&#39;` is numeric and legal in both; `&apos;` is a NAMED reference,
  // predefined in XML and absent from HTML 4. One function that had to know
  // which document it was writing into is the bug this pair avoids.
  eq(E.escapeHtml(`a'b`), 'a&#39;b');
  eq(E.escapeXml(`a'b`), 'a&apos;b');
  for (const [inp, out] of [['&', '&amp;'], ['<', '&lt;'], ['>', '&gt;'], ['"', '&quot;']]) {
    eq(E.escapeHtml(inp), out, 'html');
    eq(E.escapeXml(inp), out, 'xml');
  }
});

check('both escapers survive null and undefined', () => {
  // maintenance.esc was typed `(value: string)` and threw on an unset setting.
  eq(E.escapeHtml(undefined), '');
  eq(E.escapeHtml(null), '');
  eq(E.escapeXml(undefined), '');
  eq(E.escapeXml(null), '');
  eq(E.escapeHtml(42), '42');
});

check('NO .astro import sits in the wrong scope — both directions', () => {
  // The general form of the bug that has now bitten SEVEN times, and the reason
  // this replaces guessing at a list of helper names. The two allow-list checks
  // above only catch symbols somebody remembered to enumerate; the blocker that
  // motivated this one — `discourageIndexing` and `defaultLocale` imported into
  // edit.astro's <script> and called from its frontmatter, a hard 500 on every
  // post edit page — used two names that were not on any list, and
  // `// @ts-nocheck` on that script kept astro check silent.
  //
  // The rule needs no list: an Astro <script> is its own module, so an import
  // whose name never appears in that script is in the wrong place. Stated the
  // other way round for the frontmatter. Both directions, every .astro file.
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  /** Astro `{/* … *\/}` and HTML comments, removed. */
  const stripMarkupComments = (s) => s
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/<!--[\s\S]*?-->/g, '');


  const withoutImports = (s) => s.split('\n').filter((l) => !/^\s*import\b/.test(l)).join('\n');

  function importedNames(line) {
    // Type-only imports are erased at build time and cannot be a runtime bug.
    if (/^\s*import\s+type\b/.test(line)) return [];
    const m = line.match(/^\s*import\s+(.+?)\s+from\s+['"]/);
    if (!m) return [];
    const out = [];
    const clause = m[1];
    const braces = clause.match(/\{([^}]*)\}/);
    if (braces) {
      for (const part of braces[1].split(',')) {
        const t = part.trim();
        if (!t || t.startsWith('type ')) continue;
        out.push((t.split(/\s+as\s+/).pop() || t).trim());
      }
    }
    const lead = clause.replace(/\{[^}]*\}/, '').replace(/,/g, ' ').trim();
    for (const t of lead.split(/\s+/)) {
      if (t && t !== '*' && t !== 'as' && /^[A-Za-z_$][\w$]*$/.test(t)) out.push(t);
    }
    return out;
  }

  const bad = [];
  for (const f of walk(path.join(root, 'src'))) {
    if (!f.endsWith('.astro')) continue;
    const rel = path.relative(root, f);
    const src = fsSync(rel);
    const fmEnd = src.startsWith('---') ? src.indexOf('\n---', 3) : -1;
    const frontmatter = fmEnd > 0 ? src.slice(0, fmEnd) : '';
    const rawRest = fmEnd > 0 ? src.slice(fmEnd + 4) : src;
    // Comments are removed BEFORE the block scan, not after. An Astro
    // `{/* … */}` or an HTML comment may legitimately CONTAIN the text
    // "<script>" — this file's own note about module scopes does — and a
    // scanner that treats it as a block opening swallows the rest of the
    // template and reports every symbol in it as script-scoped.
    const rest = stripMarkupComments(rawRest);


    // A SELF-CLOSING <script ... /> — Astro's set:html form for JSON-LD — opens
    // no block. Treating it as one swallows the template up to the next
    // </script> and reports every template symbol as script-scoped.
    const scripts = [];
    const open = /<script\b[^>]*?(\/?)>/g;
    let m;
    let template = '';
    let cursor = 0;
    while ((m = open.exec(rest))) {
      if (m[1] === '/') continue;
      const bodyStart = m.index + m[0].length;
      const close = rest.indexOf('</script', bodyStart);
      const bodyEnd = close < 0 ? rest.length : close;
      scripts.push(rest.slice(bodyStart, bodyEnd));
      template += rest.slice(cursor, m.index);
      cursor = bodyEnd;
      open.lastIndex = bodyEnd;
    }
    template += rest.slice(cursor);

    for (const body of scripts) {
      const code = withoutImports(strip(body));
      for (const line of body.split('\n')) {
        for (const name of importedNames(line)) {
          if (new RegExp(`\\b${name}\\b`).test(code)) continue;
          const elsewhere = new RegExp(`\\b${name}\\b`).test(strip(frontmatter))
            || new RegExp(`\\b${name}\\b`).test(template);
          bad.push(`${rel}: <script> imports ${name}${elsewhere ? ' — but it is used in the FRONTMATTER' : ' — unused'}`);
        }
      }
    }
    for (const line of frontmatter.split('\n')) {
      for (const name of importedNames(line)) {
        const re = new RegExp(`\\b${name}\\b`);
        if (re.test(withoutImports(strip(frontmatter))) || re.test(template)) continue;
        if (scripts.some((b) => re.test(strip(b)))) {
          bad.push(`${rel}: frontmatter imports ${name} — but it is used in a <script>`);
        }
      }
    }
  }
  eq(bad, []);
});

check('no module is imported twice in one file', () => {
  // `astro check` reports 0 errors on this; the BUILD fails with "cannot be
  // redeclared" only when the duplicate names the same symbol. Six files
  // carried a silent one.
  const bad = [];
  for (const f of walk(path.join(root, 'src'))) {
    if (!/\.(astro|ts)$/.test(f)) continue;
    const src = fsSync(path.relative(root, f));
    const end = src.indexOf('\n---', 3);
    const head = f.endsWith('.astro') && end > 0 ? src.slice(0, end) : src;
    const seen = new Map();
    for (const m of head.matchAll(/^import \{[^}]*\} from '([^']+)';$/gm)) {
      seen.set(m[1], (seen.get(m[1]) ?? 0) + 1);
    }
    for (const [mod, n] of seen) if (n > 1) bad.push(`${path.relative(root, f)}: ${mod} x${n}`);
  }
  eq(bad, []);
});

// Small sync helpers, declared last so the checks above read cleanly.
function fsSync(rel) {
  return readFileSync(path.join(root, rel), 'utf8');
}
/**
 * Source with comments removed.
 *
 * Needed because these files DOCUMENT the anti-patterns they avoid — the
 * docblock in admin-ui.ts contains the words `bg-${c}-50` and `innerHTML`
 * precisely to explain why neither appears in the code. A scan that reads the
 * explanation as the offence fails on the most careful files.
 */
function codeOnly(rel) {
  return fsSync(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}
function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

/*
 * ── Serialised JSON must go through `jsonForScript` ──────────────────────────
 *
 * `JSON.stringify` does not escape `<`, so a value containing `</script>`
 * closes the enclosing element WHATEVER its type — `application/json`
 * included — and everything after it is parsed as markup.
 *
 * `lib/json-in-html.ts` exists because this had already been solved three
 * times by hand before a fourth site was written without it. Its own header
 * says so. Since then two more appeared: a command palette, and the admin
 * settings screen embedding `crawler_policy`, an operator-supplied object
 * whose KEYS reach the page unvalidated.
 *
 * So this stops being a thing anyone has to remember. The rule is mechanical:
 * inside a `set:html`, serialisation goes through the helper. A hand-rolled
 * `.replace(/</g, ...)` counts as a failure too — it is the same knowledge in
 * a sixth place, and it is how the seventh copy gets written missing a case.
 */
check('no set:html serialises JSON without jsonForScript', () => {
  const offenders = [];
  for (const file of walk(path.join(root, 'src'))) {
    if (!/\.(astro|ts|tsx)$/.test(file)) continue;
    const src = readFileSync(file, 'utf8');
    // `set:html={` … up to the matching close is awkward to parse; the whole
    // attribute value on one logical line is enough, because every real site
    // in this repo writes it that way and a multi-line one still starts here.
    const re = /set:html=\{([^}]*)\}/g;
    let m;
    while ((m = re.exec(src))) {
      const expr = m[1];
      if (!/JSON\.stringify/.test(expr)) continue;
      if (/jsonForScript/.test(expr)) continue;
      offenders.push(`${path.relative(root, file)}: set:html={${expr.trim().slice(0, 70)}…}`);
    }
  }
  if (offenders.length) {
    throw new Error(
      `use jsonForScript() from lib/json-in-html.ts:\n    ${offenders.join('\n    ')}`,
    );
  }
});

check('...and nobody hand-rolls the escape instead', () => {
  const offenders = [];
  for (const file of walk(path.join(root, 'src'))) {
    if (!/\.(astro|ts|tsx)$/.test(file)) continue;
    if (file.endsWith('json-in-html.ts')) continue; // the helper itself
    const src = readFileSync(file, 'utf8');
    if (/replace\(\s*\/<\/g\s*,\s*['"`]\\\\u003c/.test(src)) {
      offenders.push(path.relative(root, file));
    }
  }
  if (offenders.length) {
    throw new Error(`hand-rolled </script> escape — use jsonForScript(): ${offenders.join(', ')}`);
  }
});

if (failures.length) {
  console.error(`\n✗ shared-lib: ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error(`  · ${f}`);
  process.exit(1);
}
console.log(`✓ shared-lib: ${passed} passed`);
