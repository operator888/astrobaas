#!/usr/bin/env node
/**
 * The offline account scripts work when their answers are PIPED — the way a
 * provisioning script, a Dockerfile step or CI would run them.
 *
 * With readline.question(), piped stdin reaches end-of-file before the second
 * prompt: `reset-password` crashed with ERR_USE_AFTER_CLOSE and changed
 * nothing, and `setup` exited 0 WITHOUT writing an admin, which is the worse of
 * the two. Both now read through scripts/lib/prompt.mjs.
 *
 * Run with:  node tests/cli-prompts.test.mjs
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
const check = (n, c, detail = '') => {
  if (c) pass++;
  else { fail++; console.error(`✗ ${n}${detail ? `\n    ${detail}` : ''}`); }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'abprompt-'));
const run = (script, args, input, dbPath) => spawnSync(process.execPath, [path.join(root, 'scripts', script), ...args], {
  input, encoding: 'utf8', timeout: 30_000,
  env: { ...process.env, DB_PATH: dbPath, DATABASE_URL: '', DATABASE_DRIVER: '' },
});
/** The derivation src/lib/auth.ts uses (tests/password-hash.test.mjs pins it). */
const verifies = (pw, user) =>
  crypto.pbkdf2Sync(pw, user.password_salt, 120_000, 32, 'sha256').toString('hex') === user.password_hash;
const seedDb = (file) => fs.writeFileSync(file, JSON.stringify({
  users: [{ id: 'u1', email: 'admin@local', role: 'admin', password_hash: 'old', password_salt: 'old', session_version: 3 }],
}));

try {
  // ---- reset-password ----
  {
    const db = path.join(tmp, 'reset.json');
    seedDb(db);
    const r = run('reset-password.mjs', ['admin@local'], 'piped-password-1\npiped-password-1\n', db);
    const u = JSON.parse(fs.readFileSync(db, 'utf8')).users[0];
    check('reset-password accepts piped answers', r.status === 0, `status ${r.status}\n${r.stderr}`);
    check('...and the new password verifies', verifies('piped-password-1', u));
    check('...and signs the account out everywhere', u.session_version === 4);

    seedDb(db);
    const cut = run('reset-password.mjs', ['admin@local'], 'piped-password-1\n', db);
    const after = JSON.parse(fs.readFileSync(db, 'utf8')).users[0];
    check('input that ends early fails with a message, not a crash',
      cut.status === 1 && /Input ended before the confirmation/.test(cut.stderr) && !/ERR_USE_AFTER_CLOSE/.test(cut.stderr),
      `status ${cut.status}\n${cut.stderr}`);
    check('...and changes nothing', after.password_hash === 'old');

    const mismatch = run('reset-password.mjs', ['admin@local'], 'piped-password-1\nsomething-else-1\n', db);
    check('a mismatched confirmation is still refused', mismatch.status === 1 && /do not match/.test(mismatch.stderr));
  }

  // ---- setup ----
  {
    const db = path.join(tmp, 'setup.json');
    const r = run('setup.mjs', [], 'owner@example.com\nsetup-password-1\nsetup-password-1\nOwner\n', db);
    const users = fs.existsSync(db) ? JSON.parse(fs.readFileSync(db, 'utf8')).users ?? [] : [];
    const owner = users.find((u) => u.email === 'owner@example.com');
    check('setup accepts piped answers and writes the admin', r.status === 0 && !!owner, `status ${r.status}\n${r.stderr}`);
    check('...with the password that was piped', !!owner && verifies('setup-password-1', owner));
    check('...and the display name', owner?.name === 'Owner');

    const db2 = path.join(tmp, 'setup-default-name.json');
    const noName = run('setup.mjs', [], 'owner@example.com\nsetup-password-1\nsetup-password-1\n', db2);
    const u2 = fs.existsSync(db2) ? JSON.parse(fs.readFileSync(db2, 'utf8')).users?.find((u) => u.email === 'owner@example.com') : null;
    check('the optional name may be left off the end of the input', noName.status === 0 && u2?.name === 'Admin', `status ${noName.status}\n${noName.stderr}`);

    const db3 = path.join(tmp, 'setup-cut.json');
    const cut = run('setup.mjs', [], 'owner@example.com\n', db3);
    check('setup with input that ends early FAILS — it used to exit 0 having written nothing',
      cut.status === 1 && /Input ended before the password/.test(cut.stderr), `status ${cut.status}\n${cut.stderr}`);
    check('...and writes nothing', !fs.existsSync(db3));
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
