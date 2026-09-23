/**
 * A stand-in for a PAID module, used to test the external-plugin path in CI.
 *
 * The real ones (@astrobaas/optical and the gateways) are proprietary and live
 * in a private repository, so public CI cannot install them. This fixture
 * exercises the same three things they depend on:
 *
 *   1. a module loaded from node_modules by ASTROBAAS_PLUGINS;
 *   2. SEVERAL plugins shipped in ONE module, so a customer names one package
 *      however many modules they have licensed;
 *   3. a plugin contributing a PAYMENT PROVIDER, which no plugin could do until
 *      the registry stopped being a hardcoded array.
 *
 * The default export is a FACTORY taking the host API. A module in node_modules
 * cannot resolve `astrobaas/core` — inside the repo that is a tsconfig path
 * alias, and in a deployment installed from a tarball there is no such package
 * — so it imports nothing and the host passes what it needs in.
 */
/**
 * What a separate package throws when a webhook cannot be trusted.
 *
 * It cannot be the host's `WebhookVerificationError` — importing the host is
 * exactly what a module in node_modules cannot do. The host therefore
 * recognises the failure by the class NAME, and this fixture is what proves it:
 * before that, a forged event from a plugin-contributed gateway was answered
 * 500 ("our fault, retry") instead of 401, so a PSP counted every probe against
 * the endpoint's health and every one logged a stack trace.
 */
class GatewayVerificationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GatewayVerificationError';
  }
}

export default function ({ definePlugin, PLUGIN_HOOKS }) {
  const provider = {
    id: 'test-gateway',
    label: 'Test Gateway',
    requiredEnv: ['TEST_GATEWAY_KEY'],
    async createSession(order) {
      return { redirectUrl: `https://gateway.test/pay/${order.id}`, reference: `ref-${order.id}` };
    },
    async verifyWebhook(rawBody, headers) {
      // Deliberately trivial — the point under test is how the HOST answers a
      // refusal from an out-of-repo provider, not the strength of this check.
      if (headers.get('x-test-gateway-signature') !== 'valid-signature') {
        throw new GatewayVerificationError('signature mismatch');
      }
      const body = JSON.parse(rawBody);
      return {
        eventId: String(body.id ?? ''),
        reference: String(body.reference ?? ''),
        outcome: 'ignored',
        amountCents: null,
        currency: null,
        rawType: 'test.event',
      };
    },
    // A credential that is present and unusable — the case `requiredEnv` cannot
    // see. Used to prove that reporting a problem DISABLES the provider.
    validateEnv(env) {
      return env.TEST_GATEWAY_KEY === 'unusable'
        ? ['TEST_GATEWAY_KEY is not a usable key for this account']
        : [];
    },
  };

  return [
    definePlugin({
      id: 'test-gateway',
      name: 'Test Gateway',
      version: '1.0.0',
      description: 'Fixture: a plugin that contributes a payment provider.',
      author: 'AstroBaaS tests',
      filters: {
        [PLUGIN_HOOKS.PAYMENT_PROVIDERS]: (list) => [...list, provider],
        // A method that takes no credentials and calls no API — the shape a
        // shop paid through its own bank needs. `instructions` is served
        // publicly, because the BUYER is who has to read it.
        [PLUGIN_HOOKS.MANUAL_METHODS]: (list) => [
          ...list,
          {
            id: 'test-manual',
            label: 'Test Manual Method',
            instructions: { en: 'Pay us at the counter, quoting your order number.' },
          },
          // Must be REFUSED: a manual method shadowing a gateway id would make
          // checkout accept as unpaid an order the shop believes was charged.
          { id: 'test-gateway', label: 'Impostor' },
        ],
      },
    }),
    definePlugin({
      id: 'test-platform',
      name: 'Platform Capability Fixture',
      version: '1.0.0',
      description: 'Fixture: a plugin that owns API routes, an admin page and its own data.',
      author: 'AstroBaaS tests',

      // --- Capability 3: the plugin's own storage, with its own migrations ---
      migrations: [
        {
          version: 1,
          name: 'seed-widgets',
          async up(store) {
            await store.put('widgets', 'seeded', { label: 'from migration v1', n: 1 });
          },
        },
        {
          version: 2,
          name: 'add-n-to-seeded',
          async up(store) {
            const rec = await store.get('widgets', 'seeded');
            if (rec) await store.put('widgets', 'seeded', { ...rec, n: 2 });
          },
        },
      ],

      // --- Capability 1: API routes ---
      routes: [
        {
          // Staff-only by DEFAULT — no `access` declared.
          method: 'GET',
          path: '/api/plugin/test-platform/whoami',
          description: 'Echoes the caller, to prove auth reached the handler.',
          handler: async ({ user }) =>
            new Response(JSON.stringify({ role: user?.role ?? null }), {
              status: 200, headers: { 'Content-Type': 'application/json' },
            }),
        },
        {
          // ctx.store is bound to the OWNING plugin. This route writes and
          // reads through it, so the platform test proves a handler can
          // persist without importing anything — the exact gap that shipped
          // once: the docs showed createPluginStore, the barrel did not
          // export it, and an external author had no storage at all.
          method: 'GET',
          path: '/api/plugin/test-platform/counter',
          access: 'public',
          handler: async ({ store }) => {
            const prev = (await store.get('counters', 'hits'))?.n ?? 0;
            await store.put('counters', 'hits', { n: prev + 1 });
            return new Response(JSON.stringify({ ok: true, hits: prev + 1 }), {
              status: 200, headers: { 'Content-Type': 'application/json' },
            });
          },
        },
        {
          method: 'GET',
          path: '/api/plugin/test-platform/public',
          access: 'public',
          handler: async () =>
            new Response(JSON.stringify({ ok: true }), {
              status: 200, headers: { 'Content-Type': 'application/json' },
            }),
        },
        {
          method: 'GET',
          path: '/api/plugin/test-platform/admin-only',
          access: 'admin',
          handler: async () => new Response('{"secret":true}', {
            status: 200, headers: { 'Content-Type': 'application/json' },
          }),
        },
        {
          // Path parameters.
          method: 'GET',
          path: '/api/plugin/test-platform/widgets/:id',
          access: 'public',
          handler: async ({ params }) =>
            new Response(JSON.stringify({ id: params.id }), {
              status: 200, headers: { 'Content-Type': 'application/json' },
            }),
        },
        {
          // A public WRITE. Still CSRF-checked — nothing here is exempt.
          method: 'POST',
          path: '/api/plugin/test-platform/echo',
          access: 'public',
          handler: async ({ request }) => {
            const body = await request.json().catch(() => null);
            return new Response(JSON.stringify({ got: body }), {
              status: 201, headers: { 'Content-Type': 'application/json' },
            });
          },
        },
        {
          // Storage round-trip through the route layer, so the test proves the
          // two capabilities compose rather than merely both existing.
          method: 'GET',
          path: '/api/plugin/test-platform/stored',
          handler: async () => {
            const { LocalDB } = await import('../../../src/lib/localdb.ts');
            const rows = await LocalDB.getPluginData('test-platform:widgets');
            return new Response(JSON.stringify({ rows: rows.map((r) => ({ id: r.id, data: r.data })) }), {
              status: 200, headers: { 'Content-Type': 'application/json' },
            });
          },
        },
        {
          // A handler that throws must be a 500 with NO detail on the wire.
          method: 'GET',
          path: '/api/plugin/test-platform/boom',
          handler: async () => { throw new Error('SECRET-INTERNAL-DETAIL'); },
        },
        {
          // Must be REFUSED at registration: reserved namespace.
          method: 'POST',
          path: '/api/auth/backdoor',
          access: 'public',
          handler: async () => new Response('pwned', { status: 200 }),
        },
        {
          // Must be REFUSED: core owns it, and claiming it is a mistake worth
          // reporting even though the router would never route here anyway.
          method: 'GET',
          path: '/api/settings/get',
          access: 'public',
          handler: async () => new Response('pwned', { status: 200 }),
        },
        {
          // THE reproduced vulnerability, kept as a permanent regression test.
          //
          // This route can never be SERVED — core's file wins — but the
          // middleware decides CSRF before routing, and it used to consult this
          // declaration and stop checking CSRF on core's real upload handler.
          // A cross-site POST then uploaded a file with only a session cookie.
          //
          // Registration must now refuse it, so core keeps its CSRF check.
          method: 'POST',
          path: '/api/media/upload',
          csrf: 'exempt',
          handler: async () => new Response('pwned', { status: 200 }),
        },
        {
          // Same shape, aimed at the 401 gate instead of CSRF.
          method: 'GET',
          path: '/api/audit',
          access: 'public',
          handler: async () => new Response('pwned', { status: 200 }),
        },
      ],

      // --- Capability 2: admin pages ---
      adminPages: [
        {
          path: 'widgets',
          title: 'Test Widgets',
          nav: { label: 'Test Widgets' },
          roles: ['admin', 'editor'],
          render: async () => '<p data-testid="plugin-admin-body">Rendered by the plugin.</p>',
          script: 'window.__PLUGIN_ADMIN_RAN__ = true;',
        },
        {
          // No roles declared → admin only, inherited from the deny-by-default
          // rule for unknown admin paths.
          path: 'secret',
          title: 'Admin Only Page',
          render: async () => '<p>admin eyes</p>',
        },
        {
          path: 'broken',
          title: 'Broken Page',
          roles: ['admin'],
          render: async () => { throw new Error('render exploded'); },
        },
      ],
    }),
    definePlugin({
      id: 'test-second-module',
      name: 'Second Module In One Package',
      version: '1.0.0',
      description: 'Fixture: proves one module can carry several plugins.',
      author: 'AstroBaaS tests',
      filters: {},
    }),
  ];
}
