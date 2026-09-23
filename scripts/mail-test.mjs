#!/usr/bin/env node
/**
 * Send one test email through this install's configured mail channel.
 *
 *   npm run mail:test -- you@example.com
 *   npm run mail:test -- --env-file=/var/www/<site>/shared/.env you@example.com
 *
 * That is the form for a checkout. A built or deployed release has no scripts/
 * and no src/ to compile, and carries the same test precompiled instead:
 *
 *   node dist/mail-test.mjs you@example.com
 *
 * Prints the configuration it is using (never the password), the SMTP
 * conversation with the credential redacted, and the server's final reply —
 * the `250 … queued as …` that is the only proof of acceptance a sender gets.
 * Exits 0 on acceptance, non-zero otherwise, so a deploy script can assert it.
 *
 * ## Why it goes through the app's own code
 *
 * It imports `src/lib/email.ts` and sends with `deliverEmail`, the function
 * every message the site sends goes through — the same Reply-To default, the
 * same refusals, the same transport. A test script with its own little SMTP
 * client would prove that SOME client can reach the server, which is not the
 * question. The question is whether THIS one, configured THIS way, can.
 *
 * ## Where the code is
 *
 * In lib/mail-test-main.mjs, shared with dist/mail-test.mjs (built by
 * build-mail-test.mjs). This file only compiles it for a checkout and runs it.
 * The entry is resolved from ROOT, and the module's own imports from where it
 * sits: a relative specifier in a temporary barrel resolves through
 * node_modules when that is a symlink — as it is in every agent worktree — and
 * would quietly run another checkout's mail code.
 *
 * ## What it deliberately does not do
 *
 * It does not write to the email log. It runs in its own process, and on the
 * JSON storage driver the server holds the database in memory: a second writer
 * on that file can be overwritten by the next save, or overwrite it.
 *
 * ## Two caveats about --env-file
 *
 * A variable already set in the shell WINS over the file (Node's rule for env
 * files), so an `EMAIL_TRANSPORT` exported in your session overrides the one
 * you meant to test.
 *
 * And it reads the file with Node's own loader. systemd's EnvironmentFile parser is
 * a different parser; they agree on ordinary values, but a password containing
 * quotes or backslashes may be read differently by the two. To test with
 * EXACTLY what the service sees, run the release's copy under systemd instead —
 * see the mail section of the README.
 */
import process from 'node:process';
import { loadTs } from './lib/load-ts.mjs';

// `main` returns the exit code: loadTs removes its compiled copy in a `finally`,
// which an exit from inside the module would skip.
const { main } = await loadTs('scripts/lib/mail-test-main.mjs', 'mail-test');
process.exit(await main(process.argv.slice(2)));
