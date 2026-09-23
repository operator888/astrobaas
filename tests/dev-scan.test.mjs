#!/usr/bin/env node
/**
 * No `.astro` file may mention a script tag in a COMMENT or in its frontmatter.
 *
 * Vite's dependency scanner finds `<script>` blocks in .astro files with a
 * pattern match, and it strips HTML comments first but not JavaScript ones.
 * Prose like `// the strings inside the <script> below use window.t` therefore
 * opened a "script" whose body was the rest of the sentence; the scan failed
 * with ten PARSE_ERRORs on every `npm run dev`, and Vite then SKIPPED
 * dependency pre-bundling altogether — slower first loads and late re-optimise
 * reloads, behind a wall of red that looked like a broken install.
 *
 * The same regular expression Vite uses (vite/dist/node, `scriptRE`) is applied
 * here, with the same HTML-comment stripping, and everything it would extract
 * must parse — which is precisely what the scan requires.
 *
 * Run with:  node tests/dev-scan.test.mjs
 */
import { transformSync } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
let fail = 0;
const check = (n, c, detail = '') => {
  if (c) pass++;
  else { fail++; console.error(`✗ ${n}${detail ? `\n    ${detail}` : ''}`); }
};

// Vite 7's scanner, verbatim in effect: scriptRE and commentRE.
const scriptRE = /(<script(?:\s+[a-z_:][-\w:]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*>)(.*?)<\/script>/gis;
const commentRE = /<!--.*?-->/gs;

/**
 * What Vite's scanner would extract from `source` that is not JavaScript — the
 * exact thing that failed the scan. Each match's body is parsed as TypeScript;
 * a real script parses, and prose that followed a `<script>` in a comment does
 * not. Returned as "line: text".
 */
function falseScripts(source) {
  const stripped = source.replace(commentRE, (m) => m.replace(/[^\n]/g, ' '));
  const bad = [];
  for (const m of stripped.matchAll(scriptRE)) {
    try {
      transformSync(m[2], { loader: 'ts', logLevel: 'silent' });
    } catch {
      const line = stripped.slice(0, m.index).split('\n').length;
      bad.push(`${line}: ${source.split('\n')[line - 1].trim().slice(0, 90)}`);
    }
  }
  return bad;
}

// The scanner must be able to fail.
check('flags a script tag named in a frontmatter comment',
  falseScripts('---\n// the strings in the <script> below use t()\n---\n<div/>\n<script>\nconsole.log(1)\n</script>\n').length === 1);
check('flags one named in a /* */ block without leading stars',
  falseScripts('---\n/*\n  strings live in <script> blocks, so without this a\n*/\n---\n<script>\nlet a = 1;\n</script>\n').length === 1);
check('does not flag a real tag, or one inside an HTML comment',
  falseScripts('---\nconst a = 1;\n---\n<!-- a <script> in here is fine -->\n<script>\nconsole.log(1)\n</script>\n').length === 0);

function* astroFiles(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* astroFiles(p);
    else if (e.name.endsWith('.astro')) yield p;
  }
}
let scanned = 0;
for (const file of astroFiles(path.join(root, 'src'))) {
  scanned++;
  const bad = falseScripts(fs.readFileSync(file, 'utf8'));
  check(`${path.relative(root, file)} names no script tag in a comment`, bad.length === 0,
    `${bad.join('\n    ')}\n    Write "script block" / "the script below" instead: Vite's dependency scan reads the tag.`);
}
check('there are .astro files to scan', scanned > 50);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
