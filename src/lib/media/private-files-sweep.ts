/**
 * The scheduler's half of the orphan-upload clean-up.
 *
 * `private-files.ts` decides WHAT is an orphan and deletes it; this module
 * answers the one question that needs the database — "which uploaded files
 * does some stored record name?" — and decides how often to ask.
 *
 * Kept apart from `private-files.ts` because that module is imported by
 * `body-limits.ts`, and a size constant must not drag the storage layer in
 * behind it.
 *
 * ## Where it looks
 *
 * In the records of every form a candidate file was uploaded THROUGH (the
 * sidecar says which), and additionally in every currently registered type
 * with a file field — a storefront that uploads through one form and submits
 * the id to another still has its attachment kept. The lookup reads the
 * records as stored, so a form whose plugin is switched off is still searched:
 * its records exist, and so do the files they name.
 *
 * ## How often
 *
 * At most once an hour, whatever the tick interval. Walking the private
 * directory and reading a few collections every minute would be work spent
 * finding nothing; an orphan that lives an extra hour past a 24-hour grace
 * period costs nobody anything.
 */
import { LocalDB } from '../localdb';
import { getContentTypes } from '../../core/content-types';
import { fieldsOfType } from '../field-walk';
import { settingsMap } from '../settings-map';
import {
  sweepOrphanPrivateFiles, privateFileIdsIn, resolveOrphanMaxAgeMs, type OrphanSweepResult,
} from './private-files';

export const ORPHAN_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Starts at LOAD time, not 0, so the first sweep waits a full interval.
 *
 * The scheduler's first tick runs as the middleware module loads — before any
 * request has bootstrapped the plugins, so no admin-defined or plugin form is
 * registered yet. The recorded-form lookup does not need the registry, but the
 * cross-form safety net does, and a file whose only reference is in another
 * form's record must not be judged on the one tick where that net is empty.
 * An hour after boot, any site with traffic has bootstrapped.
 */
let lastRunAt = Date.now();

/** Test seam. Never called by production code. */
export function _resetOrphanSweepClock(): void {
  lastRunAt = 0;
}

/** Ids named by any record of the given types, plus every registered file-bearing type. */
export async function referencedPrivateFileIds(forms: ReadonlySet<string>): Promise<Set<string>> {
  const types = new Set(forms);
  for (const def of getContentTypes()) {
    if (fieldsOfType(def, 'file').length > 0) types.add(def.name);
  }
  const ids = new Set<string>();
  for (const type of types) {
    // Deliberately NOT caught: a read that fails must fail the whole lookup,
    // so the sweep deletes nothing rather than treating an unreadable
    // collection as an empty one.
    const rows = await LocalDB.getCustomEntities(type) as { data?: unknown }[];
    for (const row of rows) {
      for (const id of privateFileIdsIn(row?.data)) ids.add(id);
    }
  }
  return ids;
}

/**
 * Remove uploads no submission names, once the grace period has passed.
 *
 * Returns null when it skipped because it ran less than an hour ago.
 */
export async function sweepOrphanFormUploads(
  nowMs: number = Date.now(),
  opts: { force?: boolean } = {},
): Promise<OrphanSweepResult | null> {
  if (!opts.force && lastRunAt && nowMs - lastRunAt < ORPHAN_SWEEP_INTERVAL_MS) return null;
  lastRunAt = nowMs;

  await LocalDB.init();
  const settings = settingsMap(await LocalDB.getSettings());
  const result = await sweepOrphanPrivateFiles({
    now: nowMs,
    maxAgeMs: resolveOrphanMaxAgeMs(settings),
    referencedIds: referencedPrivateFileIds,
  });
  if (result.error) {
    console.error(`[astrobaas] orphan upload sweep skipped: ${result.error}`);
  } else if (result.removed) {
    console.log(`[astrobaas] removed ${result.removed} form upload(s) no submission names`);
  }
  return result;
}
