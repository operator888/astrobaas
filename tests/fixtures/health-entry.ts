/**
 * One bundle for tests that call the deep health check against a database
 * they have just written to — see storage-entry.ts for why it must be one.
 */
export { LocalDB } from '../../src/lib/localdb';
export { GET as deepHealth } from '../../src/pages/api/health/deep';
export * as registry from '../../src/lib/payments/registry';
