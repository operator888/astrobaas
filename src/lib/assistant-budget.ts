/**
 * A daily ceiling on what the public AI assistant may spend.
 *
 * ## Why the rate limit was not enough
 *
 * `POST /api/assistant/chat` is anonymous and every call is billed to the
 * operator's own provider account. The only limit on it was the middleware's
 * generic 60 writes a minute per IP — which is 86,400 paid completions a day
 * from ONE address, and unlimited from a botnet. A billing-exhaustion attack
 * needed no skill, and the operator would learn about it from the invoice.
 *
 * So there are two budgets, both per day:
 *
 *  - **site-wide** (`assistant_daily_message_cap`, default 500): the most the
 *    shop can be billed for in a day, whoever is asking. This is the one that
 *    caps the invoice.
 *  - **per client IP** (`assistant_daily_ip_cap`, default 50): one visitor —
 *    or one script — cannot use up the whole day's budget and switch the
 *    assistant off for every real customer by lunchtime.
 *
 * Messages rather than tokens, because a message is the unit that is known
 * BEFORE the provider is called. Each message is already bounded in size
 * (`ASSISTANT_LIMITS`: a 4000-character message, twenty turns of history and
 * an 800-token reply), so a message cap is a token cap with a known factor.
 *
 * `0` switches a cap off — the operator's explicit choice, and the same
 * meaning `0` has for every other "how many" setting here.
 *
 * ## Counting
 *
 * On the shared rate-limit store, so replicas count together when
 * RATE_LIMIT_STORE=libsql; on that store the day is the UTC calendar day.
 * The per-IP budget is checked FIRST, so a visitor who is over their own
 * allowance does not also spend the site's.
 *
 * Counters fail OPEN, like every counter here: a limiter outage does not take
 * the assistant down. The per-IP middleware limit still applies in that case.
 */
import { sharedRateLimitStore, type RateLimitStore } from './rate-limit';
import { settingInt } from './settings-map';

export const ASSISTANT_BUDGET_KEYS = {
  siteDaily: 'assistant_daily_message_cap',
  ipDaily: 'assistant_daily_ip_cap',
} as const;

export const DEFAULT_SITE_DAILY_MESSAGES = 500;
export const DEFAULT_IP_DAILY_MESSAGES = 50;
const MAX_CAP = 1_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface AssistantBudget {
  /** Messages per day across the site; null = no cap. */
  siteDaily: number | null;
  /** Messages per day per client IP; null = no cap. */
  ipDaily: number | null;
}

export function resolveAssistantBudget(settings: Record<string, unknown> | null | undefined): AssistantBudget {
  const map = settings ?? {};
  const read = (key: string, fallback: number): number | null => {
    const raw = map[key];
    // A negative number is a mistake, not a decision to switch the cap off.
    const n = Number(raw);
    const v = Number.isFinite(n) && n < 0
      ? fallback
      : settingInt(raw, fallback, { min: 0, max: MAX_CAP });
    return v === 0 ? null : v;
  };
  return {
    siteDaily: read(ASSISTANT_BUDGET_KEYS.siteDaily, DEFAULT_SITE_DAILY_MESSAGES),
    ipDaily: read(ASSISTANT_BUDGET_KEYS.ipDaily, DEFAULT_IP_DAILY_MESSAGES),
  };
}

export type BudgetDecision =
  | { ok: true }
  | { ok: false; scope: 'site' | 'ip'; retryAfterSeconds: number };

/**
 * Spend one message from both budgets, or say which one is empty.
 *
 * Called BEFORE the provider, so a refused message costs nothing — and so a
 * burst of concurrent requests cannot all pass a check and then all spend.
 */
export async function spendAssistantMessage(
  budget: AssistantBudget,
  ip: string | undefined,
  store: RateLimitStore = sharedRateLimitStore(),
): Promise<BudgetDecision> {
  if (budget.ipDaily !== null) {
    const r = await store.consume(`assistant:ip|${ip || 'unknown'}`, DAY_MS, budget.ipDaily);
    if (!r.allowed) return { ok: false, scope: 'ip', retryAfterSeconds: r.retryAfterSeconds };
  }
  if (budget.siteDaily !== null) {
    const r = await store.consume('assistant:site', DAY_MS, budget.siteDaily);
    if (!r.allowed) return { ok: false, scope: 'site', retryAfterSeconds: r.retryAfterSeconds };
  }
  return { ok: true };
}

/**
 * What a visitor is told. The widget shows `error.message` verbatim, so this is
 * written for a shopper — and it does not say WHICH budget ran out: "the shop's
 * daily budget is spent" is operational detail a stranger has no use for.
 */
export const BUDGET_EXHAUSTED_MESSAGE =
  'The assistant has answered all the questions it can for today. Please try again tomorrow, or contact us directly.';
