/**
 * ONE bundle for the checkout-abuse and checkout-race tests.
 *
 * The same reason as storage-entry.ts: `loadTs` bundles each entry point on
 * its own, so loading two of these modules separately would give each its own
 * LocalDB — two lowdb mutexes, two documents, two SqlStorage connections — and
 * a race "fixed" across two databases proves nothing. Everything a checkout
 * test touches is re-exported from here so it shares the graph the server
 * runs.
 *
 * Optional exports (things that only exist once the fix is in) are imported
 * as namespaces, so the tests can say "missing" cleanly on the code before the
 * fix instead of failing to bundle.
 */
export { LocalDB } from '../../src/lib/localdb';
export { placeOrder, setOrderStatus } from '../../src/lib/commerce-service';
export { pluginManager, PLUGIN_HOOKS } from '../../src/lib/plugin-system';
export { applyVerifiedEvent, refundOrder, startPayment } from '../../src/lib/payments/service';
export * as registry from '../../src/lib/payments/registry';
export * as capture from '../../src/lib/payments/capture';
export * as scheduler from '../../src/lib/scheduler';
export * as captcha from '../../src/lib/captcha';
export * as orderRisk from '../../src/lib/commerce/order-risk';
export * as coupons from '../../src/lib/commerce/coupons';
export { stripeProvider } from '../../src/lib/payments/stripe';
export { paypalProvider } from '../../src/lib/payments/paypal';
export { sharedRateLimitStore } from '../../src/lib/rate-limit';
// The real routes. What a storefront SEES — status codes, error codes, the
// body a replay returns — is the contract, so these are called rather than
// the service underneath them.
export { POST as postOrder } from '../../src/pages/api/orders/index';
export { POST as postQuote } from '../../src/pages/api/orders/quote';
export { POST as postPaymentStart } from '../../src/pages/api/payments/start';
export { POST as postWebhook } from '../../src/pages/api/payments/webhook/[provider]';
export { POST as postMagicLink } from '../../src/pages/api/auth/magic-link';
