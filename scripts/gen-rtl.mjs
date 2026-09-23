#!/usr/bin/env node
/**
 * The right-to-left flips in src/styles/global.css (C-135).
 *
 * The admin UI is written with PHYSICAL Tailwind utilities — ml-4, pr-2,
 * text-left — about five hundred of them. Rewriting every one to its logical
 * equivalent would touch every screen at once and could not be reviewed. So the
 * physical utilities are flipped in the stylesheet instead, and this script is
 * what keeps that list honest: it reads the utilities the source ACTUALLY uses
 * and reports any that global.css does not flip.
 *
 *   node scripts/gen-rtl.mjs           print the rules for the utilities in use
 *   node scripts/gen-rtl.mjs --check   exit 1 if global.css misses any of them
 *
 * --check runs in the test suite, so "the list is complete" is a checked claim
 * rather than a comment. Adding `mr-8` to a screen fails the gate until the
 * flip exists.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CSS = 'src/styles/global.css';
const SCAN_EXT = new Set(['.astro', '.ts', '.tsx', '.js', '.mjs', '.md']);

/** Tailwind's spacing scale, as a length. */
function spacing(n) {
  if (n === '0') return '0px';
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return v === 0 ? '0px' : `${v * 0.25}rem`;
}

/**
 * One physical utility → the rule that flips it.
 *
 * Every flip RESETS the original property. `margin-right: 1rem` added beside an
 * unreset `margin-left: 1rem` gives a block indented on both sides, which looks
 * deliberate and is not.
 */
function flip(cls) {
  let m;
  // A NEGATIVE margin (`-ml-1`, `-mr-12`) flips side like any other, and keeps
  // its sign. The token regex could not even see these, so the sidebar close
  // button and two theme headers were never flipped and the checker could not
  // report them.
  if ((m = /^-m([lr])-(.+)$/.exec(cls))) {
    const v = spacing(m[2]); if (!v || v === '0px') return null;
    const [from, to] = m[1] === 'l' ? ['left', 'right'] : ['right', 'left'];
    return `margin-${from}: 0; margin-${to}: -${v};`;
  }
  if ((m = /^m([lr])-(.+)$/.exec(cls))) {
    const v = spacing(m[2]); if (!v) return null;
    const [from, to] = m[1] === 'l' ? ['left', 'right'] : ['right', 'left'];
    return `margin-${from}: 0; margin-${to}: ${v};`;
  }
  if ((m = /^p([lr])-(.+)$/.exec(cls))) {
    const v = spacing(m[2]); if (!v) return null;
    const [from, to] = m[1] === 'l' ? ['left', 'right'] : ['right', 'left'];
    return `padding-${from}: 0; padding-${to}: ${v};`;
  }
  if ((m = /^(left|right)-(.+)$/.exec(cls))) {
    const v = spacing(m[2]); if (!v) return null;
    const to = m[1] === 'left' ? 'right' : 'left';
    return `${m[1]}: auto; ${to}: ${v};`;
  }
  if ((m = /^text-(left|right)$/.exec(cls))) {
    return `text-align: ${m[1] === 'left' ? 'right' : 'left'};`;
  }
  if ((m = /^float-(left|right)$/.exec(cls))) {
    return `float: ${m[1] === 'left' ? 'right' : 'left'};`;
  }
  if ((m = /^border-([lr])(?:-(\d+))?$/.exec(cls))) {
    const w = `${m[2] ?? 1}px`;
    const [from, to] = m[1] === 'l' ? ['left', 'right'] : ['right', 'left'];
    return `border-${from}-width: 0; border-${to}-width: ${w};`;
  }
  if ((m = /^rounded-([lr])(?:-(.+))?$/.exec(cls))) {
    const [from, to] = m[1] === 'l' ? ['left', 'right'] : ['right', 'left'];
    return `border-top-${from}-radius: 0; border-bottom-${from}-radius: 0;`
      + ` border-top-${to}-radius: var(--radius); border-bottom-${to}-radius: var(--radius);`;
  }
  return null;
}

/**
 * A class name as a CSS SELECTOR.
 *
 * `.ml-0.5` is not one rule — it is `.ml-0` followed by the number token `.5`,
 * which every browser drops silently. Tailwind's own class is `ml-0\.5`, so
 * the dot has to be escaped. The generator emitted the unescaped form and the
 * checker looked for the same unescaped substring, so a dead rule "proved"
 * itself present and the gate stayed green while `ml-0.5` never flipped.
 *
 * The same applies to the `:` in a variant.
 *
 * A leading hyphen is NOT escaped: `-ml-1` is a valid CSS identifier (a hyphen
 * followed by a letter), and `.-ml-1` is exactly what Tailwind itself emits. An
 * earlier line here tried to escape it and was a no-op — it ran against the
 * class rather than the built selector — which produced the right output for
 * the wrong reason. Removed rather than fixed, because escaping it would have
 * been wrong too.
 */
function selector(cls) {
  return `.${cls.replace(/([.:])/g, '\\$1')}`;
}

/** Every class token in a file, variants stripped off the front. */
const TOKEN = /(?:^|[\s"'`{}()\[\],;=><$])((?:[a-z0-9-]+:)*-?(?:m[lr]|p[lr]|text|float|left|right|border|rounded)-[a-z0-9.-]+)/g;

async function walk(dir, out = []) {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'dist') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (SCAN_EXT.has(path.extname(e.name))) out.push(p);
  }
  return out;
}

const used = new Map(); // class -> Set(file)
for (const file of await walk(path.join(ROOT, 'src'))) {
  const text = await fs.readFile(file, 'utf8');
  for (const [, raw] of text.matchAll(TOKEN)) {
    // `sm:ml-4` compiles to the class `sm:ml-4`, so a bare `.ml-4` selector
    // would not match it. None exist today; if one appears, say so loudly
    // rather than silently emitting a rule that cannot apply.
    const cls = raw.slice(raw.lastIndexOf(':') + 1);
    const rule = flip(cls);
    if (!rule) continue;
    const key = raw.includes(':') ? raw : cls;
    if (!used.has(key)) used.set(key, new Set());
    used.get(key).add(path.relative(ROOT, file));
  }
}

const variants = [...used.keys()].filter((k) => k.includes(':'));
const plain = [...used.keys()].filter((k) => !k.includes(':')).sort();

if (process.argv.includes('--check')) {
  const css = await fs.readFile(path.join(ROOT, CSS), 'utf8');
  // Strip comments: the prose above the block names utilities as examples.
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const problems = [];
  for (const c of plain) {
    if (!rules.includes(`[dir="rtl"] ${selector(c)} `)) {
      problems.push(`${c} — used in ${[...used.get(c)].slice(0, 3).join(', ')}`);
    }
  }
  for (const v of variants) {
    // `file:mr-4` compiles to the class `file\:mr-4`, so its rule is written
    // by hand with the colon escaped and the variant's own selector attached.
    if (!rules.includes(`[dir="rtl"] .${v.replace(/:/g, '\\:')}`)) {
      problems.push(`${v} — variant-prefixed, used in ${[...used.get(v)].slice(0, 2).join(', ')};`
        + ` needs a hand-written rule with the colon escaped (\`.${v.replace(/:/g, '\\:')}\`)`);
    }
  }
  if (problems.length) {
    console.error(`✗ ${CSS} does not flip ${problems.length} physical utilit${problems.length === 1 ? 'y' : 'ies'} the source uses:\n`);
    for (const p of problems) console.error(`  · ${p}`);
    console.error('\nRun `node scripts/gen-rtl.mjs` for the rules and paste them into the RTL block.');
    process.exit(1);
  }
  console.log(`✓ RTL: all ${plain.length} physical utilities in use are flipped`);
} else {
  for (const c of plain) console.log(`  [dir="rtl"] ${selector(c)} { ${flip(c.slice(c.lastIndexOf(':') + 1))} }`);
  for (const v of variants) console.error(`# WARNING ${v} is variant-prefixed and needs a hand-written rule`);
}
