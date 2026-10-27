/**
 * e2e fixture: a plugin that records consent through `host.consent`, for
 * tests/e2e/consent-ledger.spec.ts.
 *
 * Loaded through ASTROBAAS_PLUGINS in playwright.config.ts — the same path a
 * paid module takes — so the spec exercises the real host seam on the built
 * server. Its one route is admin-only and writes only the addresses the spec
 * sends, so loading it for the whole e2e server changes nothing for any other
 * test.
 */
export default function (host) {
  return host.definePlugin({
    id: 'e2e-consent',
    name: 'E2E consent',
    version: '1.0.0',
    description: 'Test fixture: records consent through host.consent.',
    author: 'AstroBaaS tests',
    routes: [{
      method: 'POST',
      path: '/api/plugin/e2e-consent/record',
      access: 'admin',
      handler: async ({ request }) => {
        const body = await request.json();
        const out = [];
        for (const step of body.steps ?? []) {
          if (step.op === 'record') out.push(await host.consent.record(step.input));
          else if (step.op === 'confirm') out.push(await host.consent.confirm(step.input));
          else if (step.op === 'withdraw') out.push((await host.consent.withdraw(step.input)) ?? null);
        }
        return Response.json({ success: true, data: out });
      },
    }],
  });
}
