import type { APIRoute } from 'astro';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { paymentConfigReport, allManualMethods, manualInstructions } from '../../../lib/payments/registry';
import { LocalDB } from '../../../lib/localdb';
import { defaultLocale } from '../../../lib/i18n';

/**
 * GET /api/payments — which payment methods this install can take.
 *
 * Public: a storefront needs it to render the checkout choices. It exposes only
 * ids and labels, never credentials — and for staff it additionally reports
 * which providers are half-configured, by variable NAME, so a misconfiguration
 * is visible in the admin instead of at the till.
 */
export const GET: APIRoute = async ({ locals }) => {
  const report = paymentConfigReport(process.env as Record<string, string | undefined>);
  const role = locals.user?.role;
  const isStaff = role === 'admin' || role === 'editor';

  const available = report
    .filter((r) => r.enabled)
    .map((r) => ({ id: r.id, label: r.label, kind: 'provider' as const }));

  // `instructions` is included for everyone, not just staff: it is what the
  // BUYER has to read in order to pay. It carries only things a shop already
  // publishes — see ManualMethodDef.
  // Settings FIRST, then a plugin-declared method's own map. The built-in
  // bank-transfer and cod methods have no plugin behind them, so before this
  // they could carry no instructions at all — the operator typed an IBAN into
  // the settings screen and the CHECKOUT PAGE still showed nothing, while the
  // confirmation email showed it. One source for both, or they disagree.
  const settingsRows = await LocalDB.getSettings().catch(() => []);
  const settingsMap: Record<string, unknown> = Object.create(null);
  for (const r of settingsRows as { key?: string; value?: unknown }[]) {
    if (typeof r?.key === 'string') settingsMap[r.key] = r.value;
  }
  const manual = allManualMethods().map((m) => {
    const text = manualInstructions(m.id, settingsMap, defaultLocale());
    return {
      id: m.id,
      label: m.label,
      kind: 'manual' as const,
      // Same locale-keyed shape as before, so every existing consumer of this
      // endpoint keeps working unchanged.
      ...(text ? { instructions: { [defaultLocale()]: text } } : {}),
    };
  });

  return ApiResponseBuilder.success(
    [...available, ...manual],
    'Payment methods',
    isStaff
      ? {
          // Staff-only diagnostics: names of the variables still needed, and
          // faults in the ones that ARE set. Neither ever carries a value.
          providers: report.map((r) => ({
            id: r.id,
            requested: r.requested,
            enabled: r.enabled,
            missing_env: r.missingEnv,
            problems: r.problems,
          })),
        }
      : undefined,
  );
};
