#!/usr/bin/env node
/**
 * Where PRIVATE_UPLOADS_DIR defaults to, and what an existing install keeps.
 *
 * ## The bug
 *
 * The doc comment said "a sibling of the database"; the code said
 * `cwd/private-uploads`. Under the reference systemd unit the working directory
 * is the release — read-only under ProtectSystem=strict, and replaced on every
 * deploy — so a stranger's form attachment either failed to write or was left
 * behind by the next release. In the Docker image cwd is /app, outside the
 * /app/data volume, so the files vanished when the container was recreated.
 *
 * ## The rules pinned here
 *
 *  - PRIVATE_UPLOADS_DIR wins, always;
 *  - otherwise the directory sits beside the database: DB_PATH's directory,
 *    or a `file:` DATABASE_URL's (which wins, since DB_PATH is then unused);
 *  - plain dev (no DB_PATH, no DATABASE_URL) is unchanged;
 *  - an install with files at the OLD location, and none at the new one, keeps
 *    the old one and is told how to move — never silently re-pointed, which
 *    would 404 every stored attachment;
 *  - the decision is made once, so the first upload into the new directory
 *    cannot flip it mid-process.
 *
 * Run with:  node tests/private-uploads-dir.test.mjs
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadTs } from './lib/load.mjs';

let pass = 0;
let fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };

const P = await loadTs('src/lib/paths.ts');
const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'astrobaas-privdir-')));

const warnings = [];
const origWarn = console.warn;
console.warn = (...a) => { warnings.push(a.join(' ')); };

try {
  /* ---- databaseDir ---- */
  const cwd = path.join(tmp, 'app');
  check('dbdir: no DB_PATH, no DATABASE_URL → the working directory', P.databaseDir({}, cwd) === cwd);
  check('dbdir: DB_PATH → its directory', P.databaseDir({ DB_PATH: '/srv/x/data/db.json' }, cwd) === '/srv/x/data');
  check('dbdir: a relative DB_PATH resolves against cwd', P.databaseDir({ DB_PATH: 'data/db.json' }, cwd) === path.join(cwd, 'data'));
  check('dbdir: file:/abs DATABASE_URL → its directory, and it beats DB_PATH',
    P.databaseDir({ DATABASE_URL: 'file:/srv/y/cms.db', DB_PATH: '/srv/x/db.json' }, cwd) === '/srv/y');
  check('dbdir: file:///abs URL form', P.databaseDir({ DATABASE_URL: 'file:///srv/z/cms.db' }, cwd) === '/srv/z');
  check('dbdir: file:rel with a query string', P.databaseDir({ DATABASE_URL: 'file:./data/astrobaas.db?mode=rwc' }, cwd) === path.join(cwd, 'data'));
  check('dbdir: a remote libsql:// URL has no directory — DB_PATH, then cwd, stand in',
    P.databaseDir({ DATABASE_URL: 'libsql://x.turso.io', DB_PATH: '/srv/w/db.json' }, cwd) === '/srv/w'
      && P.databaseDir({ DATABASE_URL: 'libsql://x.turso.io' }, cwd) === cwd);

  /* ---- the default ---- */
  P.resetPrivateUploadsResolution();
  const env = { DB_PATH: path.join(tmp, 'shared/data/db.json') };
  const r1 = P.resolvePrivateUploadsDir(env, cwd);
  check('default: THE FIX — beside the database, not in the working directory',
    r1.dir === path.join(tmp, 'shared/data/private-uploads') && r1.source === 'default');
  check('default: ...and nothing to warn about on a fresh install', !r1.warning);

  check('explicit: PRIVATE_UPLOADS_DIR wins over everything',
    P.resolvePrivateUploadsDir({ ...env, PRIVATE_UPLOADS_DIR: '/srv/p' }, cwd).dir === '/srv/p'
      && P.resolvePrivateUploadsDir({ ...env, PRIVATE_UPLOADS_DIR: '/srv/p' }, cwd).source === 'env');
  check('dev: no DB_PATH → still cwd/private-uploads, exactly as before',
    P.resolvePrivateUploadsDir({}, cwd).dir === path.join(cwd, 'private-uploads'));
  check('docker: the image\'s DB_PATH puts it inside the /app/data volume',
    P.resolvePrivateUploadsDir({ DB_PATH: '/app/data/db.json' }, '/app').dir === '/app/data/private-uploads');

  /* ---- an existing install with files at the old location ---- */
  P.resetPrivateUploadsResolution();
  warnings.length = 0;
  const legacyCwd = path.join(tmp, 'legacy-app');
  await fs.mkdir(path.join(legacyCwd, 'private-uploads', '2026-09'), { recursive: true });
  await fs.writeFile(path.join(legacyCwd, 'private-uploads', '2026-09', 'abc.pdf'), '%PDF');
  const lenv = { DB_PATH: path.join(tmp, 'legacy-data', 'db.json') };
  const r2 = P.resolvePrivateUploadsDir(lenv, legacyCwd);
  check('legacy: files at the old location and none at the new → KEEP the old one',
    r2.dir === path.join(legacyCwd, 'private-uploads') && r2.source === 'legacy');
  check('legacy: ...and tell the operator, once, how to move them',
    warnings.length === 1 && warnings[0].includes(path.join(legacyCwd, 'private-uploads'))
      && warnings[0].includes(path.join(tmp, 'legacy-data', 'private-uploads'))
      && /mv /.test(warnings[0]) && /PRIVATE_UPLOADS_DIR=/.test(warnings[0]));

  // The first upload after boot creates the NEW directory. The decision must
  // not flip because of it — that would strand everything written so far.
  await fs.mkdir(path.join(tmp, 'legacy-data', 'private-uploads', 'x'), { recursive: true });
  const r3 = P.resolvePrivateUploadsDir(lenv, legacyCwd);
  check('legacy: the decision is stable for the life of the process', r3.dir === r2.dir);
  check('legacy: ...and the warning is not repeated on every upload', warnings.length === 1);
  check('legacy: getPrivateUploadsDir() follows the same rule',
    (() => {
      const saved = { DB_PATH: process.env.DB_PATH, PRIVATE_UPLOADS_DIR: process.env.PRIVATE_UPLOADS_DIR, cwd: process.cwd() };
      try {
        process.env.DB_PATH = lenv.DB_PATH;
        delete process.env.PRIVATE_UPLOADS_DIR;
        process.chdir(legacyCwd);
        return P.getPrivateUploadsDir() === r2.dir;
      } finally {
        process.chdir(saved.cwd);
        if (saved.DB_PATH === undefined) delete process.env.DB_PATH; else process.env.DB_PATH = saved.DB_PATH;
        if (saved.PRIVATE_UPLOADS_DIR !== undefined) process.env.PRIVATE_UPLOADS_DIR = saved.PRIVATE_UPLOADS_DIR;
      }
    })());

  /* ---- files in both places ---- */
  P.resetPrivateUploadsResolution();
  warnings.length = 0;
  const r4 = P.resolvePrivateUploadsDir(lenv, legacyCwd);
  check('both: files in both places → the new location', r4.dir === path.join(tmp, 'legacy-data', 'private-uploads') && r4.source === 'default');
  check('both: ...with a warning that the old files are stranded', warnings.length === 1 && /BOTH/.test(warnings[0]));

  /* ---- an empty old directory is not "an install with files" ---- */
  P.resetPrivateUploadsResolution();
  warnings.length = 0;
  const emptyCwd = path.join(tmp, 'empty-app');
  await fs.mkdir(path.join(emptyCwd, 'private-uploads'), { recursive: true });
  const r5 = P.resolvePrivateUploadsDir({ DB_PATH: path.join(tmp, 'empty-data', 'db.json') }, emptyCwd);
  check('empty legacy dir: the new location, silently', r5.source === 'default' && warnings.length === 0);

  /* ---- still never under the public uploads directory ---- */
  const pub = P.getUploadsDir();
  const priv = P.resolvePrivateUploadsDir({ DB_PATH: path.join(process.cwd(), 'public', 'db.json') }, process.cwd()).dir;
  check('the default is never inside the PUBLIC uploads directory, even with the database in public/',
    !priv.startsWith(pub + path.sep) && priv !== pub);
} finally {
  console.warn = origWarn;
  await fs.rm(tmp, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
