/**
 * Where an OFFLINE script should write, and when it must refuse.
 *
 * ## The bug this exists to end
 *
 * Four scripts — `setup`, `reset-password`, `import-md`, `mint-storefront-key` —
 * each wrote to `path.resolve(process.cwd(), 'db.json')`. That is wrong twice
 * on the deployments people actually run:
 *
 *  - it ignores `DB_PATH`, which every containerised install sets so the data
 *    survives a redeploy. The script wrote a file next to the code, reported
 *    success, and the server kept reading the volume;
 *  - it ignores `DATABASE_URL` entirely. On the libSQL and relational drivers
 *    there IS no `db.json`. `npm run setup` would create one, print "Admin
 *    account written", and the operator would then fail to sign in — with the
 *    account sitting in a file nothing ever opens.
 *
 * Both failures are silent and both look like the tool working.
 *
 * ## Refusing is the feature
 *
 * A script that cannot reach the configured store must say so and stop. The
 * alternative — writing the JSON anyway "just in case" — is what produced the
 * second failure above.
 */
import path from 'node:path';

/** Mirrors `getDbPath()` in src/lib/paths.ts. Kept in step by tests/cli.test.mjs. */
export function jsonDbPath(env = process.env) {
  return env.DB_PATH ? path.resolve(env.DB_PATH) : path.resolve(process.cwd(), 'db.json');
}

/** True when the install is on libSQL or a relational database rather than JSON. */
export function usesSqlDriver(env = process.env) {
  return Boolean((env.DATABASE_URL ?? '').trim());
}

/**
 * Stop, with a message that names the actual configuration, when this script
 * cannot write to where the site really reads.
 *
 * `what` is what the caller was trying to do, so the message is about the
 * operator's task rather than about a file path.
 */
export function requireJsonDb(what, env = process.env) {
  if (!usesSqlDriver(env)) return jsonDbPath(env);
  console.error(
    `Cannot ${what} offline: this install is configured with DATABASE_URL, so its data is not in db.json.\n`
    + '\n'
    + `  DATABASE_URL = ${String(env.DATABASE_URL).slice(0, 60)}…\n`
    + '\n'
    + 'Use the running site instead — the admin screens and the REST API write to the\n'
    + 'configured database. Writing a db.json here would report success and change nothing.',
  );
  process.exit(1);
}
