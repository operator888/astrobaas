/**
 * ONE bundle for the storage race and backup tests.
 *
 * `loadTs` bundles every entry point on its own, so loading `localdb.ts` and
 * `commerce-service.ts` as two entries gives each bundle its OWN copy of
 * LocalDB: two lowdb mutexes, two in-memory documents, two SqlStorage
 * connections. A race test built that way races two databases rather than one,
 * and a lowdb run would "pass" because the mutex it is proving was never shared.
 * Re-exporting everything a test needs from a single entry keeps one module
 * graph, which is the graph the server runs.
 */
export { LocalDB } from '../../src/lib/localdb';
export { saveProduct, setOrderStatus } from '../../src/lib/commerce-service';
// The order-status race counts how many times the "status changed" side
// effects ran (plugin action, webhook event and audit are fired together), so
// it registers a probe on THIS graph's plugin manager — a second copy would
// never be called.
export { pluginManager, PLUGIN_HOOKS } from '../../src/lib/plugin-system';
// The other two callers that move an order's status on their own schedule:
// the abandoned-order sweep and a verified payment event. Both reach
// setOrderStatus, and both can race an admin.
export { sweepAbandonedOrders } from '../../src/lib/scheduler';
export { applyVerifiedEvent } from '../../src/lib/payments/service';
// The real PUT /api/orders/{id}: an admin double-click is two of these, and
// what the loser ANSWERS (200, 409, never 500) is part of the contract.
export { PUT as putOrder } from '../../src/pages/api/orders/[id]';
export { buildPayload } from '../../src/lib/backup/offsite';
export { POST as restoreBackup } from '../../src/pages/api/backup/import';
// The real PUT /api/products/{id}: the editor-save race is about what the ROUTE
// does with the body the admin editor sends (it must read `stock_base` before
// its allow-list drops it), so calling saveProduct directly would skip the half
// most likely to be forgotten.
export { PUT as putProduct } from '../../src/pages/api/products/[id]';
