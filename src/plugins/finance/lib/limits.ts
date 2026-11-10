/**
 * Size ceilings of the finance module, in a file with no imports so the
 * middleware's body-limit table (src/lib/body-limits.ts) can derive from it
 * without dragging the storage layer in.
 */

/** Largest receipt / statement / e-invoice the archive accepts. */
export const FINANCE_UPLOAD_MAX_BYTES = 15 * 1024 * 1024;

/**
 * Largest issuer PDF a mirrored invoice may carry. It travels base64 inside a
 * JSON body, which the default 2 MB body limit (src/lib/body-limits.ts) has
 * to hold: 1.4 MB × 4/3 + the rest of the document stays under it.
 */
export const MIRROR_PDF_MAX_BYTES = 1400 * 1024;
