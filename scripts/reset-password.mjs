#!/usr/bin/env node
/**
 * Reset a user's password without web access.
 *
 *   npm run reset-password -- <email>
 *
 * Prompts for a new password and writes it to db.json. If the email doesn't
 * exist, errors out — use `npm run setup` to create a new admin instead.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { requireJsonDb } from './lib/db-target.mjs';
import { createPrompter } from './lib/prompt.mjs';

// Honours DB_PATH, and REFUSES when the install is on libSQL or a
// relational database — where there is no db.json and writing one would
// report success and change nothing. See scripts/lib/db-target.mjs.
const DB_PATH = requireJsonDb('reset a password');
const args = process.argv.slice(2);
const emailArg = args[0];

if (!emailArg) {
  console.error('Usage: npm run reset-password -- <email>');
  process.exit(2);
}

const prompt = createPrompter();

const pbkdf2 = promisify(crypto.pbkdf2);

/**
 * The SAME derivation as src/lib/auth.ts — 120,000 iterations, 32 bytes,
 * SHA-256 — or the reset password never verifies.
 * tests/password-hash.test.mjs holds both copies to those three values.
 */
async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = (await pbkdf2(password, salt, 120_000, 32, 'sha256')).toString('hex');
  return { hash, salt };
}

async function main() {
  let raw;
  try {
    raw = await fs.readFile(DB_PATH, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.error(`db.json not found at ${DB_PATH}. Boot the server once first.`);
      process.exit(1);
    }
    throw err;
  }
  const db = JSON.parse(raw);
  const users = db.users || [];
  const idx = users.findIndex((u) => (u.email || '').toLowerCase() === emailArg.toLowerCase());
  if (idx < 0) {
    console.error(`No user found with email ${emailArg}.`);
    process.exit(1);
  }

  console.log(`Resetting password for ${users[idx].email} (role: ${users[idx].role}).`);
  console.log('(Password will be visible while typing.)\n');
  const pwd = (await prompt.require('New password (>=8 chars): ', 'the new password')).trim();
  if (pwd.length < 8) {
    console.error('Password must be at least 8 characters.');
    prompt.close();
    process.exit(1);
  }
  const confirm = (await prompt.require('Confirm password: ', 'the confirmation')).trim();
  prompt.close();
  if (pwd !== confirm) {
    console.error('Passwords do not match.');
    process.exit(1);
  }

  const { hash, salt } = await hashPassword(pwd);
  users[idx].password_hash = hash;
  users[idx].password_salt = salt;
  // Sign the account out everywhere, as the web reset does. A password reset
  // from the shell is most often the response to a compromised account, and
  // leaving the intruder's session alive for another day defeated it.
  users[idx].session_version = (users[idx].session_version ?? 0) + 1;
  users[idx].revoked_sessions = [];
  users[idx].status = users[idx].status || 'active';
  users[idx].updated_at = new Date().toISOString();
  db.users = users;

  await fs.writeFile(DB_PATH, JSON.stringify(db, null, 2) + '\n');
  console.log(`\nDone. ${users[idx].email} can now sign in with the new password.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
