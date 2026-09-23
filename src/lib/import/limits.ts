/**
 * Ceilings for the HTTP import path.
 *
 * These live in their own module because TWO places must agree about them and
 * they are enforced in different layers: the middleware refuses an oversized
 * body from `Content-Length` before any handler buffers it, and the route
 * refuses the file itself with a message that tells the operator what to do
 * instead. If the middleware's number were the smaller of the two, the route's
 * careful error would be unreachable — the operator would get a bare 413 and
 * no idea that the CLI exists.
 *
 * That failure mode is invisible in review (both files look right on their
 * own), so the numbers are defined once and `tests/import-limits.test.mjs`
 * asserts the relationship rather than either value.
 */

/**
 * The largest export accepted over HTTP.
 *
 * Well below the parser's own 200 MB cap: a multipart upload of that size,
 * buffered in memory and parsed inside a single request, is a request that
 * dies half-way. Above this the answer is the CLI, which has neither a
 * timeout to lose against nor an upload step.
 */
export const MAX_HTTP_WXR_BYTES = 24 * 1024 * 1024;

/**
 * What the middleware allows through for that route.
 *
 * Larger than the file cap on purpose: multipart framing, the boundary
 * markers, and the other form fields all count toward `Content-Length`. If
 * this were equal to the file cap, an export of exactly the documented maximum
 * would be refused by the layer that cannot explain why.
 */
export const IMPORT_BODY_LIMIT = MAX_HTTP_WXR_BYTES + 2 * 1024 * 1024;

/**
 * Media files one HTTP import will fetch.
 *
 * Sized against the thing that actually ends the request: a reverse proxy's
 * read timeout, which is 60 seconds by default almost everywhere. At a few
 * hundred milliseconds a file — a small image over the public internet, plus
 * the derivative pipeline — a hundred files is already close to that, and a
 * request killed half-way leaves the operator with a partial import and no
 * report of what happened.
 *
 * The CLI is uncapped, because it can take an hour and nothing will hang up on
 * it. An import that hits this reports the rest as skipped with the cap named
 * in the reason, so finishing the job is `npm run import:wp -- … --media`.
 */
export const HTTP_MEDIA_CAP = 100;
