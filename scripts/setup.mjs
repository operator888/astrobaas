#!/usr/bin/env node
/**
 * One-time admin setup. Prompts for email + password, then writes the user to
 * db.json (replacing the seed admin@local if it exists). Safe to re-run.
 *
 * Password input is NOT masked. For local development this is fine; for
 * production setup, pipe a strong password from a secret manager:
 *   echo "user@example.com\nyour-strong-pw\nyour-strong-pw\nAdmin\n" | npm run setup
 */
import readline from 'node:readline';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { requireJsonDb } from './lib/db-target.mjs';

// Honours DB_PATH, and REFUSES when the install is on libSQL or a
// relational database — where there is no db.json and writing one would
// report success and change nothing. See scripts/lib/db-target.mjs.
const DB_PATH = requireJsonDb('create an admin account');
const SEED_PATH = path.resolve(process.cwd(), 'db.seed.json');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, (a) => res(a)));

const pbkdf2 = promisify(crypto.pbkdf2);

/**
 * The SAME derivation as src/lib/auth.ts — 120,000 iterations, 32 bytes,
 * SHA-256 — or the account this writes cannot sign in.
 * tests/password-hash.test.mjs holds both copies to those three values and
 * checks a hash made here verifies there. Async like the server's (S3.8); a
 * one-shot CLI would not notice either way, but the two copies should read
 * the same.
 */
async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = (await pbkdf2(password, salt, 120_000, 32, 'sha256')).toString('hex');
  return { hash, salt };
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

async function loadDb() {
  try {
    const raw = await fs.readFile(DB_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') {
      try {
        const seed = await fs.readFile(SEED_PATH, 'utf8');
        return JSON.parse(seed);
      } catch {
        return {
          posts: [],
          categories: [],
          users: [],
          media: [],
          themes: [],
          settings: [],
          themeSettings: [],
          contentChanges: [],
        };
      }
    }
    throw err;
  }
}

async function main() {
  console.log('AstroBaaS admin setup\n(Note: password will be visible while typing.)\n');
  const email = ((await ask('Admin email [admin@local]: ')) || '').trim() || 'admin@local';
  const password = ((await ask('Admin password (>=8 chars): ')) || '').trim();
  if (password.length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
  }
  const confirm = ((await ask('Confirm password: ')) || '').trim();
  if (password !== confirm) {
    console.error('Passwords do not match.');
    process.exit(1);
  }
  const name = ((await ask('Display name [Admin]: ')) || '').trim() || 'Admin';
  rl.close();

  const db = await loadDb();
  db.users = db.users || [];

  const { hash, salt } = await hashPassword(password);
  const nowIso = new Date().toISOString();

  const existing = db.users.findIndex(
    (u) => (u.email || '').toLowerCase() === email.toLowerCase(),
  );
  // Remove the seed admin if we're creating a different one
  if (email !== 'admin@local') {
    db.users = db.users.filter((u) => u.email !== 'admin@local');
  }

  const record = {
    id: existing >= 0 ? db.users[existing].id : generateId(),
    name,
    email,
    role: 'admin',
    password_hash: hash,
    password_salt: salt,
    status: 'active',
    posts_count: existing >= 0 ? db.users[existing].posts_count ?? 0 : 0,
    created_at: existing >= 0 ? db.users[existing].created_at ?? nowIso : nowIso,
    updated_at: nowIso,
  };
  if (existing >= 0) db.users[existing] = record;
  else db.users.unshift(record);

  await fs.writeFile(DB_PATH, JSON.stringify(db, null, 2) + '\n');
  console.log(`\nDone. Admin account "${email}" written to db.json.`);
  console.log('Start the app with `npm run dev` and sign in at /login.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
