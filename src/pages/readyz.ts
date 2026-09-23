import type { APIRoute } from 'astro';
import { LocalDB, getSchemaStatus } from '../lib/localdb';
import { isDraining, reportError } from '../lib/observability';

// Readiness probe: distinct from /healthz (liveness). Returns 200 only when the
// storage backend is reachable, so an orchestrator/load balancer can hold
// traffic until the DB is actually usable (e.g. a remote libSQL connecting).
export const prerender = false;

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

export const GET: APIRoute = async () => {
  // A process that has been told to stop is not ready, however healthy its
  // database is. Answering 503 here, first and without touching storage, is
  // what lets a balancer move traffic away while the requests already in
  // flight finish (src/lib/shutdown.ts). Checked before the DB so a storage
  // hiccup during shutdown cannot turn this into a misleading "unavailable".
  if (isDraining()) {
    return json({ ready: false, draining: true, error: 'shutting down' }, 503);
  }
  try {
    await LocalDB.init();
    await LocalDB.getSettings(); // a cheap read that touches the store
    // Confirm the schema is at the version this build expects — a DB stuck
    // below it (failed/rolled-back migration) is reported as not-ready.
    const schema = getSchemaStatus();
    const dbVersion = await LocalDB.getSchemaVersion();
    const schemaOk = dbVersion >= schema.version;
    return json({ ready: schemaOk, schema_version: dbVersion, expected_schema_version: schema.version }, schemaOk ? 200 : 503);
  } catch (err) {
    // The reason goes to the LOG, not the response. This route is public and
    // unauthenticated, and a storage error message is exactly the wrong thing
    // to publish from it: a libSQL failure names the database host, a lowdb
    // one the absolute path of the data directory, a driver one the version.
    // The operator reads the journal; the balancer only needs the 503. The
    // `error` field is kept, with a fixed value, for monitors that read it.
    reportError(err, { where: 'readyz' });
    return json({ ready: false, error: 'unavailable' }, 503);
  }
};
