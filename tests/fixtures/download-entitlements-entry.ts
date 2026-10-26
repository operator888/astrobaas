/**
 * ONE bundle for the download-entitlements test, so the module, the status
 * service, the routes, the erasure path and the email builders all share one
 * LocalDB (see checkout-entry.ts for why that matters).
 */
export { LocalDB } from '../../src/lib/localdb';
export * as dl from '../../src/lib/commerce/download-entitlements';
export { setOrderStatus, saveProduct } from '../../src/lib/commerce-service';
export { eraseSubject, collectSubjectData } from '../../src/lib/gdpr';
export { buildOrderConfirmation } from '../../src/lib/commerce/order-confirmation';
export { receiptUrl, makeReceiptToken } from '../../src/lib/commerce/receipt';
export { storePrivateFile, deletePrivateFile, readPrivateFileMeta } from '../../src/lib/media/private-files';
export { projectProductForReader, normalizeDownloads, privateDownloadId } from '../../src/lib/product-fields';
export { GET as downloadFile, HEAD as headFile } from '../../src/pages/api/downloads/[token]';
export { GET as listBuyerDownloads } from '../../src/pages/api/downloads/index';
export { POST as uploadDownload } from '../../src/pages/api/downloads/upload';
export { GET as getOrderDownloads, POST as postOrderDownloads } from '../../src/pages/api/orders/[id]/downloads';
export { GET as getProductRoute } from '../../src/pages/api/products/[id]';
export { GET as listProductsRoute, POST as createProductRoute } from '../../src/pages/api/products/index';
