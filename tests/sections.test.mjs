#!/usr/bin/env node
/**
 * The section vocabulary.
 *
 * Sections are CSS classes on already-allowed tags, not a block tree, so the
 * one thing that can silently break is the link between what the EDITOR emits
 * and what the SANITIZER permits. That mismatch has shipped here before: the
 * alignment buttons emitted an inline `style` the sanitizer stripped, so
 * alignment appeared to work and was destroyed on save.
 *
 * The central assertion is therefore not "the templates look right" but
 * **every template survives the sanitizer byte-for-byte**. If it does not, the
 * palette is offering something the save path will throw away.
 *
 * Run with:  node tests/sections.test.mjs
 */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const cacheDir = path.join(root, 'node_modules', '.cache');
await fs.mkdir(cacheDir, { recursive: true });

async function load(rel, name) {
  const out = path.join(cacheDir, `astrobaas-${name}-${process.pid}.mjs`);
  await build({
    entryPoints: [path.join(root, rel)],
    bundle: true, format: 'esm', platform: 'node', packages: 'external',
    outfile: out, logLevel: 'silent',
  });
  const mod = await import(pathToFileURL(out).href);
  await fs.rm(out, { force: true });
  return mod;
}

const { SECTIONS, SECTION_VOCAB_VERSION, SECTION_PREFIX, sectionClassList, getSection } =
  await load('src/core/sections.ts', 'sections');
const { sanitizeHtml } = await load('src/lib/sanitize.ts', 'sanitize-for-sections');

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) pass++;
  else { fail++; console.error(`✗ ${name}`); }
}

/* ---------------- the vocabulary is well formed ---------------- */
{
  check('sections exist', SECTIONS.length >= 6);
  check('names are unique', new Set(SECTIONS.map((s) => s.name)).size === SECTIONS.length);
  check('every section has a label and a description',
    SECTIONS.every((s) => s.label?.length > 0 && s.description?.length > 0));
  check('names are url-safe and lowercase',
    SECTIONS.every((s) => /^[a-z][a-z0-9-]*$/.test(s.name)));
  check('the vocabulary is versioned', Number.isInteger(SECTION_VOCAB_VERSION));
  check('the prefix is the one baked into stored HTML', SECTION_PREFIX === 'ab-');
  check('getSection finds by name and returns undefined otherwise',
    getSection('hero')?.name === 'hero' && getSection('nope') === undefined);
}

/* ---------------- THE assertion: templates survive the save path ---------------- */
{
  // If a template does not round-trip, the palette inserts something the
  // sanitizer discards — the author sees it work, then loses it on save.
  for (const s of SECTIONS) {
    const out = sanitizeHtml(s.template);
    check(`the "${s.name}" template survives the sanitizer unchanged`, out === s.template);
  }

  // And every class the vocabulary can produce must be permitted, including
  // modifier variants the templates themselves do not demonstrate.
  const classes = sectionClassList();
  for (const s of SECTIONS) {
    for (const [group, values] of Object.entries(s.modifiers ?? {})) {
      for (const v of values) {
        check(`modifier ab-${group}-${v} (${s.name}) is allow-listed`,
          classes.includes(`ab-${group}-${v}`));
      }
    }
    for (const part of s.parts ?? []) {
      check(`part ${part} (${s.name}) is allow-listed`, classes.includes(part));
    }
  }

  // A modifier applied to a real element must actually survive, not merely
  // appear in a list.
  const withModifier = '<div class="ab-columns ab-cols-4"><div class="ab-col"><p>x</p></div></div>';
  check('a modifier class survives on a real element', sanitizeHtml(withModifier) === withModifier);
}

/* ---------------- the allow-list stays an allow-list ---------------- */
{
  // The whole point of generating it is that it does not become a general
  // class channel. Content must not be able to escape the article.
  check('an arbitrary utility class is dropped',
    sanitizeHtml('<p class="fixed inset-0 z-50">x</p>') === '<p>x</p>');
  check('an unlisted class beside an allowed one is dropped',
    sanitizeHtml('<div class="ab-card fixed inset-0">x</div>') === '<div class="ab-card">x</div>');
  check('a lookalike prefix is not allowed',
    sanitizeHtml('<div class="ab-evil">x</div>') === '<div>x</div>');
  // The plugin namespace IS allowed, by shape rather than by looking up what is
  // installed — so saving a page while a plugin is disabled cannot strip that
  // plugin's sections out of it permanently. See tests/plugin-sections.test.mjs
  // for the full contract; asserted here because it widens THIS allow-list.
  check('a plugin-namespaced class is allowed',
    sanitizeHtml('<div class="ab-x-someplugin-thing">x</div>') === '<div class="ab-x-someplugin-thing">x</div>');
  check('...but the namespace is not a general escape hatch',
    sanitizeHtml('<div class="ab-x-nodashes">x</div>') === '<div>x</div>');
  check('...and it does not admit uppercase or punctuation into CSS',
    sanitizeHtml('<div class="ab-x-Some_plugin-thing">x</div>') === '<div>x</div>');

  // Templates are build-time literals, so nothing executable can be in one —
  // but the sanitizer is still the backstop.
  check('a script inside section markup is refused',
    !/script/i.test(sanitizeHtml('<div class="ab-card"><script>alert(1)</script></div>')));
  check('an inline style on a section is still stripped',
    sanitizeHtml('<div class="ab-card" style="position:fixed">x</div>') === '<div class="ab-card">x</div>');
  check('an event handler is stripped',
    !/onerror/i.test(sanitizeHtml('<div class="ab-card"><img src=x onerror=alert(1)></div>')));
}

/* ---------------- templates cannot carry data ---------------- */
{
  // A template is a constant. If one ever gains an interpolation it becomes an
  // injection sink, so assert they are static and inert.
  check('no template contains a template literal or interpolation',
    SECTIONS.every((s) => !s.template.includes('${') && !s.template.includes('`')));
  check('no template contains a script or event attribute',
    SECTIONS.every((s) => !/<script|on[a-z]+\s*=/i.test(s.template)));
  check('no template contains an inline style',
    SECTIONS.every((s) => !/\sstyle\s*=/i.test(s.template)));
  check('every template names its own root class',
    SECTIONS.every((s) => s.template.includes(`ab-${s.name}`)));
}

/* ---------------- degradation ---------------- */
{
  // Structure is not enforced, deliberately — a string sanitizer cannot know
  // ancestry. An orphaned part must therefore still be valid, readable markup.
  const orphan = '<div class="ab-col"><p>Still readable.</p></div>';
  check('an orphaned part survives as plain content', sanitizeHtml(orphan) === orphan);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
