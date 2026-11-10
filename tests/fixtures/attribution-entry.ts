/**
 * ONE bundle for tests/conversion-attribution.test.mjs, so the route, the
 * served consent script, the GDPR functions and the database share a single
 * LocalDB (see checkout-entry.ts for why two bundles would prove nothing).
 */
export { LocalDB } from '../../src/lib/localdb';
export { placeOrder } from '../../src/lib/commerce-service';
export { collectSubjectData, eraseSubject } from '../../src/lib/gdpr';
export { buildCookieDeclaration } from '../../src/lib/cookie-declaration';
export * as attribution from '../../src/lib/commerce/attribution';
export * as consent from '../../src/lib/consent';
export { POST as postOrder } from '../../src/pages/api/orders/index';
export { GET as getAttributionReport } from '../../src/pages/api/orders/attribution';
export { GET as getConsentJs } from '../../src/pages/consent.js.ts';
export { GET as getOrder } from '../../src/pages/api/orders/[id]/index';
