/**
 * ONE bundle for the order-tags test, so the module, the routes, the erasure
 * path and the buyer-facing builders all share one LocalDB (see
 * checkout-entry.ts for why that matters).
 */
export { LocalDB } from '../../src/lib/localdb';
export * as tags from '../../src/lib/commerce/order-tags';
export { eraseSubject, collectSubjectData } from '../../src/lib/gdpr';
export { buildOrderConfirmation } from '../../src/lib/commerce/order-confirmation';
export { buildShippedNotice } from '../../src/lib/commerce/shipped-notice';
export { buildRecoveryNotice } from '../../src/lib/commerce/recovery-notice';
export { receiptView } from '../../src/lib/commerce/receipt';
export { GET as listOrders } from '../../src/pages/api/orders/index';
export { GET as getOrder, PUT as putOrder } from '../../src/pages/api/orders/[id]/index';
export { GET as getOrderTags, POST as postOrderTags, DELETE as deleteOrderTag } from '../../src/pages/api/orders/[id]/tags';
export { GET as getTagCounts, PATCH as patchTags, DELETE as deleteTagEverywhere } from '../../src/pages/api/orders/tags';
