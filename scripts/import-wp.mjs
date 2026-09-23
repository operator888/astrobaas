#!/usr/bin/env node
/**
 * Import a WordPress WXR export into AstroBaaS.
 *
 *   npm run import:wp -- ./export.xml                 # rehearse, write nothing
 *   npm run import:wp -- ./export.xml --apply         # perform it
 *   npm run import:wp -- ./export.xml --apply --media # ...and fetch the files
 *
 * This is a THIN wrapper. Every decision — what a WordPress status means here,
 * which items are skipped, what redirect an old permalink needs, whether a
 * file is safe to store — lives in src/lib/import/* and src/lib/media/ingest.ts,
 * shared with the admin endpoint. The two paths cannot disagree, because there
 * is only one implementation to disagree with.
 *
 * The version this replaces wrote db.json directly. That made it silently
 * useless on the two drivers a real deployment runs (libSQL and relational),
 * and it bypassed slug uniqueness, HTML sanitization and the change feed. This
 * one goes through LocalDB like everything else.
 */
import { loadTs as load } from './lib/load-ts.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

const argv = process.argv.slice(2);
const file = argv.find((a) => !a.startsWith('-'));
const has = (flag) => argv.includes(flag);

if (!file || has('--help') || has('-h')) {
  console.log(`
Usage: npm run import:wp -- <export.xml> [options]

  --apply              Perform the import. Without this nothing is written.
  --media              Fetch the media library from the old site.
  --trash              Include content WordPress had in the bin.
  --no-pages           Import posts only.
  --types a,b          Also import these custom post types, as posts.
  --author <email>     File imported content under this account.
                       Defaults to the oldest administrator.

An import cannot be undone. Run it without --apply first and read the summary.
`.trim());
  process.exit(file ? 0 : 2);
}


const value = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};

const xmlPath = path.resolve(process.cwd(), file);
let xml;
try {
  xml = await fs.readFile(xmlPath, 'utf8');
} catch {
  console.error(`Cannot read ${xmlPath}`);
  process.exit(2);
}

const { parseWxr, WxrParseError } = await load('src/lib/import/wxr.ts', 'wxr');
const { planImport, summarisePlan } = await load('src/lib/import/plan.ts', 'plan');

let doc;
try {
  doc = parseWxr(xml);
} catch (err) {
  if (err instanceof WxrParseError || err?.name === 'WxrParseError') {
    console.error(`\n  ${err.message}\n`);
    process.exit(1);
  }
  throw err;
}

const plan = planImport(doc, {
  includePages: !has('--no-pages'),
  includeMedia: true,
  includeTrash: has('--trash'),
  extraTypes: (value('--types') ?? '').split(',').map((t) => t.trim()).filter(Boolean),
});

console.log(`\n  ${doc.siteTitle ?? 'A WordPress site'}${doc.siteUrl ? ` — ${doc.siteUrl}` : ''}`);
console.log(`  ${summarisePlan(plan)}\n`);

if (plan.authors.length) {
  console.log('  Authors found in the export (accounts are NOT created — invite them yourself):');
  for (const a of plan.authors) {
    console.log(`    · ${a.displayName ?? a.login}${a.email ? ` <${a.email}>` : ''}`);
  }
  console.log('');
}

if (plan.skipped.length) {
  // Grouped, because "412 skipped" scrolls past and tells nobody anything,
  // while "412 skipped: 400 attachments, 12 in the bin" is a decision.
  const byReason = new Map();
  for (const s of plan.skipped) byReason.set(s.reason, (byReason.get(s.reason) ?? 0) + 1);
  console.log('  Skipped:');
  for (const [reason, n] of [...byReason].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(5)} × ${reason}`);
  }
  console.log('');
}

if (!has('--apply')) {
  console.log('  Nothing was written. Re-run with --apply to perform this import.\n');
  process.exit(0);
}

// ---- performing ----
const { LocalDB } = await load('src/lib/localdb.ts', 'db');
const { applyImport } = await load('src/lib/import/apply.ts', 'apply');

await LocalDB.init();

const wanted = value('--author');
const users = await LocalDB.getUsers();
const admins = users
  .filter((u) => u.role === 'admin' && u.status === 'active')
  .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
const author = wanted
  ? users.find((u) => u.email?.toLowerCase() === wanted.toLowerCase())
  : admins[0];

if (!author) {
  console.error(wanted
    ? `  No account with the email ${wanted}.\n`
    : '  This install has no active administrator to file the content under.\n');
  process.exit(1);
}
console.log(`  Filing imported content under ${author.email ?? author.id}.\n`);

let lastLine = 0;
const result = await applyImport(plan, author.id, {
  dryRun: false,
  fetchMedia: has('--media'),
  onProgress: (done, total, label) => {
    // Rewritten in place; a 4000-line scroll is not progress reporting.
    const now = Date.now();
    if (now - lastLine < 80 && done < total) return;
    lastLine = now;
    process.stdout.write(`\r  ${done}/${total}  ${label.slice(0, 60).padEnd(62)}`);
  },
});
process.stdout.write('\r'.padEnd(80) + '\r');

console.log(`  Created: ${result.createdPosts} post(s), ${result.createdPages} page(s), `
  + `${result.createdCategories} categor(ies), ${result.createdRedirects} redirect(s)`
  + (has('--media') ? `, ${result.importedMedia} media file(s)` : ''));

if (result.failed.length) {
  console.log(`\n  ${result.failed.length} item(s) could not be imported:`);
  for (const f of result.failed.slice(0, 20)) console.log(`    · ${f.title} — ${f.reason}`);
  if (result.failed.length > 20) console.log(`    …and ${result.failed.length - 20} more`);
}

console.log('\n  Done. Re-running this import is safe: already-imported items are skipped.\n');
// A failure to import content is a failure, even though the run finished.
process.exit(result.failed.length ? 1 : 0);
