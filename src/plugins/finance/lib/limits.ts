/**
 * Size ceilings of the finance module, in a file with no imports so the
 * middleware's body-limit table (src/lib/body-limits.ts) can derive from it
 * without dragging the storage layer in.
 */

/** Largest receipt / statement / e-invoice the archive accepts. */
export const FINANCE_UPLOAD_MAX_BYTES = 15 * 1024 * 1024;
