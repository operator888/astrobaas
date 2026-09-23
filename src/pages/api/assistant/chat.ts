import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import {
  callAssistant, sanitizeHistory,
  ASSISTANT_LIMITS, ASSISTANT_LAST_ERROR_KEY,
} from '../../../lib/ai-assistant';
import { liveAssistantConfig } from '../../../lib/assistant-runtime';
import { ensurePluginsBootstrapped } from '../../../plugins';
import {
  resolveAssistantBudget, spendAssistantMessage, BUDGET_EXHAUSTED_MESSAGE,
} from '../../../lib/assistant-budget';
import { settingsMap } from '../../../lib/settings-map';

/**
 * POST /api/assistant/chat — proxy a visitor's message to the AI provider.
 *
 * Public, because the widget runs for anonymous visitors. It is a *proxy*
 * precisely so the credential stays here: a widget that called the provider
 * directly would ship the operator's API key to every page view.
 *
 * Everything the browser sends is untrusted and bounded:
 *  - the message length is capped;
 *  - the history is capped and its roles constrained to user/assistant, so a
 *    visitor cannot inject a `system` turn and rewrite the operator's prompt;
 *  - the system prompt is added HERE and never echoed back.
 *
 * The endpoint inherits the middleware's per-IP rate limit like every other
 * write. That matters more than usual: each call costs the operator money, so
 * an unthrottled version is a billing-exhaustion vector — and a per-MINUTE
 * limit is not a ceiling on a bill. The daily budgets in
 * lib/assistant-budget.ts are.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  try {
    await LocalDB.init();

    // liveAssistantConfig, not a second resolution of the same question.
    //
    // This route used to call resolveAssistantConfig + assistantReady itself
    // and never ask whether the ai-assistant PLUGIN was active — which is the
    // other half of "live", and the half an operator controls from Admin →
    // Plugins. So deactivating the plugin removed the bubble (BaseLayout and
    // /assistant.js both ask liveAssistantConfig) while this endpoint kept
    // proxying anonymous, unauthenticated requests to the operator's paid
    // provider. Every one of those calls costs them money, on a feature they
    // had switched off.
    //
    // That is exactly the sibling gap assistant-runtime.ts was written to end:
    // one rule, three callers, and the third asking a different question.
    // ensurePluginsBootstrapped first, because the activation list is empty
    // until it has run and a cold request would otherwise 404 a live assistant.
    await ensurePluginsBootstrapped();
    // 404 rather than 403: an assistant that is off should look like it does
    // not exist, not like something to keep probing.
    const cfg = await liveAssistantConfig();
    if (!cfg) return ApiResponseBuilder.notFound('Assistant');

    const body = await request.json().catch(() => null);
    const message = typeof (body as any)?.message === 'string' ? (body as any).message.trim() : '';
    if (!message) return ApiResponseBuilder.badRequest('message is required');
    if (message.length > ASSISTANT_LIMITS.message) {
      return ApiResponseBuilder.badRequest(`message must be under ${ASSISTANT_LIMITS.message} characters`);
    }

    // THE SPEND CAP, after the message is known to be valid (a refused empty
    // message must not cost a unit) and before the provider is called (a
    // refused message must not cost money). Same error envelope as every other
    // refusal here — the widget shows `error.message` — with a Retry-After so
    // a well-behaved client does not retry into the same wall.
    const budget = resolveAssistantBudget(settingsMap(await LocalDB.getSettings()));
    const spent = await spendAssistantMessage(budget, locals.ip);
    if (!spent.ok) {
      const refused = ApiResponseBuilder.error(429, BUDGET_EXHAUSTED_MESSAGE);
      refused.headers.set('Retry-After', String(spent.retryAfterSeconds));
      return refused;
    }

    const history = sanitizeHistory((body as any)?.history);
    const result = await callAssistant(cfg, { message, history });

    if (!result.ok) {
      // Persist the (already redacted) failure so the admin panel can show WHY
      // without an operator having to go read journalctl. Deduped by content:
      // under a sustained outage every request fails identically, and rewriting
      // the same row per request would turn a provider outage into database
      // write amplification.
      if (result.failure) {
        try {
          const previous = await LocalDB.getSetting(ASSISTANT_LAST_ERROR_KEY);
          const prev = previous?.value as { status?: number; detail?: string } | undefined;
          const changed = prev?.status !== result.failure.status || prev?.detail !== result.failure.detail;
          if (changed) await LocalDB.updateSetting(ASSISTANT_LAST_ERROR_KEY, result.failure);
        } catch {
          /* a diagnostic write must never turn into a second failure */
        }
      }
      return ApiResponseBuilder.error(502, result.error ?? 'The assistant is unavailable.');
    }

    // A success clears a stale error so the panel does not accuse a provider
    // that has since recovered.
    try {
      const previous = await LocalDB.getSetting(ASSISTANT_LAST_ERROR_KEY);
      if (previous?.value) await LocalDB.updateSetting(ASSISTANT_LAST_ERROR_KEY, null);
    } catch {
      /* ignore */
    }

    return ApiResponseBuilder.success({ reply: result.reply });
  } catch (err) {
    console.error('Assistant chat error:', err);
    return ApiResponseBuilder.serverError('The assistant could not answer.');
  }
};
