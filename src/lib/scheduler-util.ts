/**
 * Pure helpers for the scheduled-post worker — no storage imports, so they're
 * unit-testable in isolation. The worker (scheduler.ts) uses these + LocalDB.
 */
import type { Post } from '../core/models';

/** A post is due to auto-publish when it's `scheduled` with a past `publish_date`. */
export function isPostDue(post: Pick<Post, 'status' | 'publish_date'>, now: number = Date.now()): boolean {
  if (post.status !== 'scheduled' || !post.publish_date) return false;
  const t = Date.parse(post.publish_date);
  return Number.isFinite(t) && t <= now;
}

const truthy = (v: string | undefined) => v === '1' || v === 'true';

/** The worker runs unless SCHEDULER_DISABLED is set. */
export function schedulerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !truthy(env.SCHEDULER_DISABLED);
}

/** Sweep interval (ms); SCHEDULER_INTERVAL_MS, default 60s, floor 100ms. */
export function schedulerIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.SCHEDULER_INTERVAL_MS);
  return Number.isFinite(n) && n >= 100 ? n : 60_000;
}

const falsy = (v: string | undefined) => v === '0' || v === 'false' || v === 'off';

/**
 * Sweep only while holding the `scheduler` lease (src/lib/lease.ts).
 *
 * On unless SCHEDULER_LEASE=0. The switch exists for one situation: a
 * single-process install whose database directory cannot hold a lock file
 * (some network filesystems refuse O_EXCL). With it off every process sweeps,
 * which is exactly the pre-lease behaviour — and wrong for two replicas.
 */
export function schedulerLeaseEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !falsy(env.SCHEDULER_LEASE?.trim().toLowerCase());
}

/**
 * How long a scheduler lease lasts without renewal.
 *
 * Three intervals by default: the leader renews every tick, so two missed
 * renewals in a row still leave it leading, and a leader that has died is
 * replaced within about three ticks. SCHEDULER_LEASE_TTL_MS overrides it, but
 * never below two intervals plus a second — a lease that can lapse between
 * two healthy ticks would hand leadership back and forth all day.
 */
export function schedulerLeaseTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const interval = schedulerIntervalMs(env);
  const floor = 2 * interval + 1_000;
  const raw = Number(env.SCHEDULER_LEASE_TTL_MS);
  if (Number.isFinite(raw) && raw > 0) return Math.max(Math.floor(raw), floor);
  return Math.max(3 * interval, floor);
}
