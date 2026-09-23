#!/usr/bin/env node
/**
 * Every relative link in the project's own Markdown must resolve.
 *
 * This exists because moving one section broke one link and nobody noticed:
 * the SMTP reference moved out of README.md into docs/EMAIL.md, and a
 * `[deploy/README.md](./deploy/README.md)` that had been correct at the repo
 * root now pointed at `docs/deploy/README.md`, which does not exist. A reader
 * following the one link that tells them where the mail password lives got a
 * 404 on GitHub.
 *
 * Nothing checked it, because the docs are prose and prose is not compiled.
 * This is the compiler.
 *
 * Two things are verified, both of them things a reader would hit:
 *
 *   1. a relative target exists on disk — file or directory;
 *   2. an `#anchor` names a heading that is really in the target file, using
 *      GitHub's slug rules (lowercase, punctuation dropped, spaces to dashes).
 *
 * Deliberately NOT checked: http(s) links. A network call in a unit suite is a
 * test that fails on a train, and the app already ships a link checker for
 * live content (src/lib/link-check.ts).
 *
 * Fenced code blocks are stripped first — a documentation example may contain
 * a link that is deliberately fictional.
 *
 * Run with:  node tests/docs-links.test.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) pass++;
  else {
    fail++;
    console.error(`✗ ${name}`);
  }
}

/**
 * Tracked Markdown, so an untracked scratch file never fails the build. A
 * "Download ZIP" or tarball copy has no .git, and `npm test` must still pass
 * there — so without git, walk the tree, skipping what installs and builds
 * write (none of it is tracked, so both paths see the same files).
 */
const GENERATED = new Set(['.git', 'node_modules', 'dist', 'pkg', '.astro', 'test-results', 'playwright-report']);
function walkMarkdown(dir, rel = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) return GENERATED.has(e.name) ? [] : walkMarkdown(path.join(dir, e.name), r);
    return e.name.endsWith('.md') ? [r] : [];
  });
}
let files;
try {
  files = execFileSync('git', ['ls-files', '*.md'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    .split('\n')
    .filter(Boolean);
} catch {
  files = walkMarkdown(root);
}

/** GitHub's heading slug: lowercase, drop punctuation, spaces to dashes. */
function slug(heading) {
  return heading
    .replace(/`/g, '')
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    // Each space becomes a dash and runs are NOT collapsed: dropping the "/"
    // from "(ISR / revalidation)" leaves two spaces, and GitHub's anchor
    // really does carry two dashes there.
    .replace(/\s/g, '-');
}

const headingsOf = new Map();
function anchors(rel) {
  if (!headingsOf.has(rel)) {
    const abs = path.join(root, rel);
    const text = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
    headingsOf.set(rel, new Set([...text.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)].map((m) => slug(m[1]))));
  }
  return headingsOf.get(rel);
}

let links = 0;
for (const rel of files) {
  const text = fs
    .readFileSync(path.join(root, rel), 'utf8')
    .replace(/^```[\s\S]*?^```/gm, '')
    .replace(/`[^`\n]*`/g, '');
  const dir = path.dirname(rel);

  for (const m of text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const raw = m[1];
    if (/^(https?:|mailto:|tel:|#!)/.test(raw)) continue;
    links++;

    const [target, hash] = raw.split('#');

    // A bare #anchor points inside this same file.
    if (!target) {
      check(`${rel}: anchor #${hash} exists`, anchors(rel).has(hash.toLowerCase()));
      continue;
    }

    const resolved = path.normalize(path.join(dir, target));
    const exists = fs.existsSync(path.join(root, resolved));
    check(`${rel}: ${raw} resolves (-> ${resolved})`, exists);

    if (exists && hash && resolved.endsWith('.md')) {
      check(`${rel}: ${raw} names a real heading in ${resolved}`, anchors(resolved).has(hash.toLowerCase()));
    }
  }
}

check('the walker found Markdown to check', files.length > 5);
check('the walker found links to check', links > 50);

console.log(`\n${pass} passed, ${fail} failed (${links} relative links in ${files.length} files)`);
process.exit(fail ? 1 : 0);
