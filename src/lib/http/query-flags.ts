/**
 * Boolean query-string flags, read one way everywhere.
 *
 * The typed client (`src/client/index.ts`, `commerceQuery`) sends a true
 * boolean as `1`, while hand-written callers, the docs and the smoke tests send
 * `true`. Routes used to read `=== 'true'` each on their own, so
 * `products.list({ featured: true })` from the typed client sent `featured=1`
 * and got the whole, unfiltered catalogue back: no error, just the wrong list.
 *
 * Every boolean query flag an API route reads goes through `queryFlag`, so the
 * wire form is decided once. `tests/query-flags.test.mjs` has a tripwire for
 * the common shapes of a route reading a flag on its own (`.get(x) === 'true'`,
 * a local `isTrue`); it is a guard against the obvious relapse, not a proof.
 *
 * Only `true` and `1` mean yes. Anything else (absent, empty, `0`, `false`,
 * `yes`, `TRUE`) is no. A flag widens or narrows what a caller sees, and an
 * unrecognised spelling must never switch a filter on, or (for `all`) show
 * staff-only rows, by accident.
 */
export function queryFlag(q: URLSearchParams, name: string): boolean {
  const v = q.get(name);
  return v === 'true' || v === '1';
}
