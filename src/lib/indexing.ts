/**
 * "Should this site be indexed?" — answered once, remembered after.
 *
 * The setting is read on every page render (a live SELECT; nothing caches it),
 * so on a libSQL/Turso install a single connection blip can fail this read
 * while the rest of the page renders perfectly. Both obvious error policies
 * are wrong on that path, in opposite directions:
 *
 *  - **Fail open** drops the `noindex` from a staging site for the length of
 *    the blip, and a crawler in that window indexes content nobody published.
 *  - **Fail closed** puts `noindex, nofollow` on a healthy production shop's
 *    200 response — silently, no log, no visible difference — and a crawler in
 *    THAT window drops the URL from the index. Recovery needs a recrawl:
 *    days to weeks, for two shops that live on search traffic.
 *
 * So neither: the last value successfully read is remembered, and a failed
 * read reuses it. An install that has ever answered this question keeps its
 * own answer through a hiccup, in whichever direction that answer went — the
 * only behaviour that is right for a staging site AND a live one.
 *
 * A cold process that has never completed one read has nothing to remember and
 * has to guess. It guesses "indexable", matching every other reader in the
 * codebase — every reader now calls `resolveDiscourageIndexing`, which is also
 * where the staging override lives — and refusing to invent a delisting.
 *
 * This lives in a .ts module, not in the layout, for a reason worth recording:
 * a `let` declared in `.astro` frontmatter compiles INSIDE the per-render
 * function, so it resets on every request and remembers nothing. Verified in
 * the built output before this file existed.
 */
import { LocalDB } from './localdb';
import { envFlagOn } from './maintenance';

/** The last successfully-read value. `false` until one read succeeds. */
let lastKnown = false;
/** Whether any read has ever succeeded — for diagnostics and tests. */
let everRead = false;

/**
 * PURE resolver, so the truthiness rule is testable without a database.
 *
 * Deliberately `!!`: this matches every other reader (sitemap, robots.txt,
 * rss), and `settings-validate.ts` refuses to store the string `"false"` for
 * this key precisely so that agreement is safe.
 */
export function resolveDiscourageIndexing(value: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  // The ENVIRONMENT wins, and it can only ever say "hide".
  //
  // A staging clone arrives with production's database, so it arrives with
  // `discourage_indexing` OFF — the setting travelled with the data. The refresh
  // procedure then has a checklist step somebody skips on the third run, and the
  // staging copy of a live shop quietly enters the index, competing with the
  // shop it was cloned from.
  //
  // One-way on purpose: `STAGING=1` can force noindex, and nothing in the
  // environment can force indexing ON. A variable that could un-hide a site the
  // operator hid would be a way to publish a private site by editing a deploy
  // config.
  if (isStagingEnv(env)) return true;
  return !!value;
}

/**
 * Is this deployment a staging copy?
 *
 * Env-only, and read at call time rather than at import, so a test can drive it
 * and so a process that changes its own environment is not left with a stale
 * answer. `envFlagOn` is the existing spelling of "is this flag on" — every
 * boolean env var in this codebase goes through it, and a second parser here
 * would disagree with the first one somebody typed `yes` into.
 */
export function isStagingEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return envFlagOn(env.STAGING) || envFlagOn(env.ASTROBAAS_STAGING);
}

/** How the setting is read in production. */
async function readFromDatabase(): Promise<unknown> {
  await LocalDB.init();
  return (await LocalDB.getSetting('discourage_indexing'))?.value;
}

/**
 * Read the setting, remembering the answer. Never throws.
 *
 * `read` is injectable so the REMEMBERING — the whole point of this module —
 * can be driven in a test without a database, including the failure path.
 * A policy whose error branch cannot be exercised is a policy nobody has
 * checked; production calls this with no argument.
 */
export async function discourageIndexing(
  read: () => Promise<unknown> = readFromDatabase,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  // The env override is checked FIRST, and outside the try.
  //
  // The remembered-value branch below exists so a database blip cannot delist a
  // live shop. But it also meant a cold staging process whose first settings
  // read failed — the normal state right after a refresh, while the database is
  // being restored — fell back to `lastKnown`, which starts false, and served
  // indexable pages. The one thing the staging flag exists to prevent.
  if (isStagingEnv(env)) return true;
  try {
    lastKnown = resolveDiscourageIndexing(await read(), env);
    everRead = true;
  } catch {
    // Keep the remembered value — see the header.
  }
  return lastKnown;
}

/** What the module currently remembers, without touching the database. */
export function lastKnownDiscourageIndexing(): { value: boolean; everRead: boolean } {
  return { value: lastKnown, everRead };
}

/** Tests only: forget, so a case can start from a cold process. */
export function _resetDiscourageMemory(): void {
  lastKnown = false;
  everRead = false;
}
