#!/usr/bin/env node
/**
 * Mint a least-privilege storefront API key offline (writes db.json directly,
 * same trust model as the importers — you already have the database file).
 *
 *   node scripts/mint-storefront-key.mjs [path/to/storefront/.env.local]
 *
 * Scopes: products:read, orders:write, content:read, posts:read — enough for
 * a headless shop (catalog reads + checkout), nothing more. The key is printed
 * ONCE; if an env-file path is given, ASTROBAAS_KEY/URL are upserted there.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { requireJsonDb } from './lib/db-target.mjs';

// Honours DB_PATH, and REFUSES when the install is on libSQL or a
// relational database — where there is no db.json and writing one would
// report success and change nothing. See scripts/lib/db-target.mjs.
const DB_PATH = requireJsonDb('mint an API key');
const envPath = process.argv[2];
const URL = process.env.ASTROBAAS_URL || 'http://localhost:4321';

const secret = crypto.randomBytes(24).toString('base64url');
const key = `abk_${secret}`;
const hash = crypto.createHash('sha256').update(key).digest('hex');

const db = JSON.parse(await fs.readFile(DB_PATH, 'utf-8'));
db.apiKeys = db.apiKeys ?? [];
db.apiKeys.push({
  id: crypto.randomUUID(),
  name: 'storefront',
  prefix: key.slice(0, 12),
  key_hash: hash,
  role: 'editor',
  // `media:read` is needed only if the storefront lists the media library.
  // Rendering images does NOT need it — files under /uploads are served
  // publicly and their URLs are embedded in products and post content. It is
  // included because /api/media/get stopped being in the public allow-list
  // (it was enumerable by anyone), and a key without the scope now gets 403.
  scopes: ['products:read', 'orders:write', 'content:read', 'posts:read', 'media:read'],
  created_at: new Date().toISOString(),
});
await fs.writeFile(DB_PATH, JSON.stringify(db, null, 2) + '\n');

console.log('Storefront API key (shown once):');
console.log(`  ${key}`);

if (envPath) {
  let env = '';
  try { env = await fs.readFile(envPath, 'utf-8'); } catch { /* new file */ }
  const upsert = (src, k, v) => {
    const line = `${k}=${v}`;
    const re = new RegExp(`^#?\\s*${k}=.*$`, 'm');
    return re.test(src) ? src.replace(re, line) : src + (src.endsWith('\n') || src === '' ? '' : '\n') + line + '\n';
  };
  env = upsert(env, 'ASTROBAAS_URL', URL);
  env = upsert(env, 'ASTROBAAS_KEY', key);
  await fs.writeFile(envPath, env.endsWith('\n') ? env : env + '\n');
  console.log(`Wrote ASTROBAAS_URL + ASTROBAAS_KEY to ${envPath}`);
}
