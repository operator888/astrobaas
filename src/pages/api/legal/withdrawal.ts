import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { contentLocale } from '../../../lib/i18n/resolve';
import { withdrawalStringsFor } from '../../../lib/legal/withdrawal-locales';
import {
  resolveWithdrawalPolicy, withdrawalInstructions, modelWithdrawalForm,
  policyIsPublishable, orderButtonLabel, WITHDRAWAL_KEYS,
} from '../../../lib/withdrawal';

/**
 * GET /api/legal/withdrawal — the withdrawal notice and model form.
 *
 * Public by design: a decoupled storefront has to render this text before
 * checkout, and the Directive's whole point is that the consumer sees it.
 *
 * It exposes trader identity (legal name, postal address, contact) — which is
 * information the Directive *requires* a trader to publish, not a leak. Nothing
 * else from settings is returned; this endpoint reads specific keys rather than
 * handing back a settings blob.
 */
export const GET: APIRoute = async ({ url }) => {
  try {
    await LocalDB.init();
    const rows = await LocalDB.getSettings();
    const map: Record<string, unknown> = {};
    for (const r of rows) map[r.key] = r.value;

    const policy = resolveWithdrawalPolicy(map);

    if (!policy.enabled) {
      return ApiResponseBuilder.success({ enabled: false }, 'Withdrawal notice is disabled for this shop');
    }

    // Incomplete trader details are reported rather than rendered into a
    // notice with blanks. A notice that LOOKS compliant but omits the address
    // fails the Art. 6 information duty, which extends the withdrawal period by
    // twelve months — worse than publishing nothing.
    if (!policyIsPublishable(policy)) {
      return ApiResponseBuilder.error(
        503,
        'The withdrawal notice is not configured yet — the shop operator must set the trader legal name, postal address and contact email.',
      );
    }

    // Which language the notice is served in. Falls back to English when the
    // locale has no text, or has text nobody has checked against the Directive.
    const asked = contentLocale(null, url.searchParams.get('locale'));
    const { locale: served, fellBack } = withdrawalStringsFor(asked);

    return ApiResponseBuilder.success({
      enabled: true,
      /** The language this notice is actually IN, which may not be the one asked for. */
      locale: served,
      withdrawal_days: policy.days,
      return_costs_borne_by: policy.returnCosts,
      trader: {
        name: policy.traderName,
        address: policy.traderAddress,
        email: policy.traderEmail,
        phone: policy.traderPhone || null,
      },
      /** Plain text. Escape it before inserting into HTML. */
      instructions: withdrawalInstructions(policy, served),
      model_form: modelWithdrawalForm(policy, served),
      /** Art. 8(2): use this verbatim on the order button, in the buyer's language. */
      order_button_label: orderButtonLabel(served),
      /**
       * True when a language was requested and English came back instead.
       *
       * Said out loud rather than silently substituted: a storefront rendering
       * a German checkout needs to know it is about to show an English legal
       * notice, because that is a compliance decision, not a display detail.
       */
      locale_fell_back: fellBack,
      disclaimer:
        'Generated from the model texts in Annex I of Directive 2011/83/EU using this shop’s configured details. It is a starting point, not legal advice — national transpositions differ and some goods are exempt.',
    });
  } catch (err) {
    console.error('Withdrawal notice error:', err);
    return ApiResponseBuilder.serverError('Failed to build the withdrawal notice');
  }
};

/** Setting keys are exported for the admin form; not part of the response. */
export const _keys = WITHDRAWAL_KEYS;
