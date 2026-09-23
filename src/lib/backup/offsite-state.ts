/**
 * What the database remembers about off-site backups.
 *
 * ## The bug
 *
 * The last backup's outcome lived only in memory (offsite.ts). So:
 *
 *  - every restart looked like "never backed up", and the first sweep after a
 *    deploy pushed a full archive — on a shop that deploys daily and backs up
 *    daily, twice the uploads, twice the bucket churn, and retention pruning
 *    the archives an operator actually wanted to keep;
 *  - a process that crashed DURING a backup (the archive is built in memory,
 *    and a photo-heavy shop is exactly where that runs out) came back, saw no
 *    backup, and started the same backup again — a crash loop that was also a
 *    backup loop;
 *  - with two replicas, each had its own idea of when the last backup was;
 *  - the operations screen said "no backup has run on this server yet" after
 *    every restart, next to a bucket full of them.
 *
 * ## What is kept
 *
 * One settings row, `offsite_backup_state`:
 *
 *   attempt       the attempt in progress: an id, when it started, which
 *                 process. Written BEFORE any work, cleared by the same attempt
 *                 when it records its outcome.
 *   last          the most recent finished attempt (ok or not, with its error).
 *   last_success  the most recent successful one, so a run of failures does
 *                 not hide when the last good archive was made.
 *
 * Nothing about the TARGET is stored — the bucket, keys and credentials stay in
 * the environment (see offsite.ts). The row is not public: settings are
 * deny-by-default for anonymous readers (settings-visibility.ts).
 */
import os from 'node:os';
import crypto from 'node:crypto';
import { LocalDB } from '../localdb';
import {
  runOffsiteBackup,
  type BackupOutcome,
  type OffsiteConfig,
  type PersistedBackupState,
} from './offsite';

export const OFFSITE_STATE_SETTING = 'offsite_backup_state';

const EMPTY: PersistedBackupState = { attempt: null, last: null, last_success: null };

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

function parseOutcome(v: unknown): PersistedBackupState['last'] {
  if (!isObj(v) || typeof v.ok !== 'boolean' || typeof v.at !== 'string' || !Number.isFinite(Date.parse(v.at))) {
    return null;
  }
  return v as unknown as PersistedBackupState['last'];
}

/**
 * Read the stored value defensively. It is an ordinary settings row, so an
 * admin API call, a restore or a hand edit can put anything there; a shape we
 * do not recognise reads as "nothing remembered" rather than as an error that
 * would stop the scheduler deciding at all.
 */
export function parseOffsiteState(raw: unknown): PersistedBackupState {
  if (!isObj(raw)) return { ...EMPTY };
  const a = raw.attempt;
  const attempt = isObj(a) && typeof a.id === 'string' && typeof a.started_at === 'string'
    && Number.isFinite(Date.parse(a.started_at))
    ? { id: a.id, started_at: a.started_at, by: typeof a.by === 'string' ? a.by : '' }
    : null;
  return { attempt, last: parseOutcome(raw.last), last_success: parseOutcome(raw.last_success) };
}

/** The persisted state. Throws when storage does — the caller must not guess. */
export async function readOffsiteState(): Promise<PersistedBackupState> {
  await LocalDB.init();
  const row = await LocalDB.getSetting(OFFSITE_STATE_SETTING);
  return parseOffsiteState(row?.value);
}

async function writeOffsiteState(state: PersistedBackupState): Promise<void> {
  await LocalDB.updateSetting(OFFSITE_STATE_SETTING, state);
}

export interface RecordedBackupDeps {
  run?: (cfg: OffsiteConfig) => Promise<BackupOutcome>;
  now?: () => Date;
}

/**
 * Run one off-site backup and remember it: the marker first, the outcome
 * after. The scheduler and the "back up now" button both come through here,
 * so the screen and the schedule see the same history.
 *
 * If the marker cannot be written, the backup does not run: without it, a
 * crash during this attempt would be retried by the next process straight
 * away, which is the loop this module exists to stop. The outcome is returned
 * (and logged by the caller) even if recording it fails.
 */
export async function runRecordedBackup(cfg: OffsiteConfig, deps: RecordedBackupDeps = {}): Promise<BackupOutcome> {
  const run = deps.run ?? ((c: OffsiteConfig) => runOffsiteBackup(c));
  const now = deps.now ?? (() => new Date());
  const id = crypto.randomUUID();
  const startedAt = now().toISOString();

  const before = await readOffsiteState();
  await writeOffsiteState({
    ...before,
    attempt: { id, started_at: startedAt, by: `${os.hostname()}:${process.pid}` },
  });

  let outcome: BackupOutcome;
  try {
    outcome = await run(cfg);
  } catch (err) {
    // runOffsiteBackup reports failures as values; a throw is a bug or an
    // environment problem, and it still has to clear the marker.
    outcome = { ok: false, error: `The backup threw: ${err instanceof Error ? err.message : String(err)}`, at: startedAt };
  }

  try {
    // Re-read: a manual run may have started (and written its own marker)
    // while this one was uploading. Only OUR marker is cleared.
    const fresh = await readOffsiteState();
    const recorded = { ...outcome, attempt_id: id };
    await writeOffsiteState({
      attempt: fresh.attempt && fresh.attempt.id !== id ? fresh.attempt : null,
      last: recorded,
      last_success: outcome.ok ? recorded : fresh.last_success,
    });
  } catch (err) {
    console.error('[astrobaas] could not record the off-site backup outcome:', err instanceof Error ? err.message : err);
  }
  return outcome;
}
