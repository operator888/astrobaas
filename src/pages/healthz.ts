import type { APIRoute } from 'astro';
import { LocalDB } from '../lib/localdb';

// Cached at boot — not the package.json version, just a session marker so
// orchestrators can tell when the process was restarted.
const startedAt = new Date().toISOString();

export const prerender = false;

/**
 * How long one probe result is reused.
 *
 * /healthz is public and unauthenticated — it has to be, for a load balancer —
 * so whatever it costs, anyone can make us pay as often as they like. It used
 * to read EVERY post on every call (and, on the lowdb driver, rewrite the
 * whole database through `init()`), which made it the cheapest way on the
 * site to make the server do the most work. With this, a flood of probes costs
 * at most one small storage read per window, and a real monitor polling every
 * few seconds still sees a failure within one.
 */
export const PROBE_TTL_MS = 2_000;

let initialised: Promise<void> | null = null;
let last: { at: number; ok: boolean } | null = null;
let inFlight: Promise<boolean> | null = null;

/**
 * Does storage answer a read?
 *
 * `init()` once per process, not per probe: after the first success it only
 * repeats work (on lowdb, a full document write). A failed init is forgotten
 * so the next probe tries again — a database that was down at boot and has
 * come back must turn the probe green.
 *
 * The read is the schema version: one row on the SQL drivers, one field of
 * the cached document on lowdb. It proves the same thing reading every post
 * proved — the store is reachable and answering — without the cost growing
 * with the catalogue.
 */
async function probeStorage(): Promise<boolean> {
  try {
    if (!initialised) {
      initialised = LocalDB.init().catch((err) => {
        initialised = null;
        throw err;
      });
    }
    await initialised;
    const version = await LocalDB.getSchemaVersion();
    return typeof version === 'number' && Number.isFinite(version);
  } catch {
    return false;
  }
}

/** One probe at a time, and one per window; concurrent callers share it. */
async function storageOk(now: number): Promise<boolean> {
  if (last && now - last.at < PROBE_TTL_MS) return last.ok;
  if (!inFlight) {
    inFlight = probeStorage().then((ok) => {
      last = { at: Date.now(), ok };
      inFlight = null;
      return ok;
    });
  }
  return inFlight;
}

export const GET: APIRoute = async () => {
  const dbOk = await storageOk(Date.now());

  const body = {
    ok: dbOk,
    started_at: startedAt,
    now: new Date().toISOString(),
    db: dbOk ? 'ok' : 'error',
    // Kept, as null, for any monitor that reads the field. It used to be the
    // number of posts — which published the size of the content library to
    // anyone who asked, and was the reason this probe read every post. `null`
    // was already a value it could take (when the read failed), so a consumer
    // written against the old shape still parses this one.
    posts: null,
  };

  return new Response(JSON.stringify(body), {
    status: dbOk ? 200 : 503,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
};
