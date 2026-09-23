/**
 * AI assistant configuration and provider calls.
 *
 * ## The one rule this file exists to enforce
 *
 * **The API key never reaches the browser.** A chat widget that calls an AI
 * provider directly from the page has to ship the key to every visitor, and a
 * leaked key is billed to the operator until they notice. So the widget talks
 * to `/api/assistant/chat` on our own origin, and this server holds the
 * credential and forwards the request.
 *
 * That also buys the things a direct-from-browser widget cannot have: per-IP
 * rate limiting, a message-length cap, a system prompt the visitor cannot see
 * or override, and an audit trail.
 *
 * ## Where the key lives
 *
 * Environment variable first (`ASSISTANT_API_KEY`), settings second. Env is the
 * house rule for secrets and is what the payments and SMTP2GO connectors use.
 * The settings fallback exists because operators asked to configure this from
 * the admin without a redeploy — it is stored under a key that is NOT publicly
 * readable (see settings-visibility.ts) and never included in any response, but
 * it is still plaintext in the database, so the admin says so plainly.
 */

import type { ConsentCategory } from './consent';
import { settingBool } from './settings-map';

export const ASSISTANT_KEYS = {
  enabled: 'assistant_enabled',
  provider: 'assistant_provider',
  /** NOT public. Never returned by any endpoint. */
  apiKey: 'assistant_api_key',
  /** OpenAI Assistant id, or a model name for the plain chat providers. */
  assistantId: 'assistant_id',
  model: 'assistant_model',
  title: 'assistant_title',
  greeting: 'assistant_greeting',
  systemPrompt: 'assistant_system_prompt',
  /** Base URL for self-hosted / OpenAI-compatible endpoints. */
  baseUrl: 'assistant_base_url',
} as const;

export type AssistantProviderId = 'openai' | 'anthropic' | 'openai-compatible';

export interface AssistantProviderInfo {
  id: AssistantProviderId;
  label: string;
  /** Default endpoint. Overridable for self-hosted gateways. */
  defaultBaseUrl: string;
  defaultModel: string;
  /** What the operator pastes as the id field, if anything. */
  idHint: string;
}

export const ASSISTANT_PROVIDERS: readonly AssistantProviderInfo[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    idHint: 'Assistant ID (asst_…), optional',
  },
  {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-sonnet-4-5',
    idHint: 'Not used',
  },
  {
    id: 'openai-compatible',
    label: 'OpenAI-compatible (self-hosted, Together, Groq…)',
    defaultBaseUrl: '',
    defaultModel: '',
    idHint: 'Not used',
  },
];

export function getAssistantProvider(id: string): AssistantProviderInfo | undefined {
  return ASSISTANT_PROVIDERS.find((p) => p.id === id);
}

/** The widget is a third-party-ish integration, so it waits for consent. */
export const ASSISTANT_CONSENT_CATEGORY: ConsentCategory = 'preferences';

/** Caps. The endpoint is public, so every input is bounded. */
export const ASSISTANT_LIMITS = {
  message: 4000,
  historyTurns: 20,
  systemPrompt: 4000,
  title: 80,
  greeting: 300,
  replyTokens: 800,
} as const;

export interface AssistantConfig {
  enabled: boolean;
  provider: AssistantProviderId;
  apiKey: string;
  assistantId: string;
  model: string;
  baseUrl: string;
  title: string;
  greeting: string;
  systemPrompt: string;
}

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

/**
 * Resolve config from settings + environment. PURE.
 *
 * Env wins over settings for the key: an operator moving the secret out of the
 * database should not have to remember to clear the old row too.
 */
export function resolveAssistantConfig(
  settings: Record<string, unknown> | null | undefined,
  env: Record<string, string | undefined> = {},
): AssistantConfig {
  const map = settings ?? {};
  const providerId = str(map[ASSISTANT_KEYS.provider], 40) as AssistantProviderId;
  const provider = getAssistantProvider(providerId) ?? ASSISTANT_PROVIDERS[0];

  const apiKey = (env.ASSISTANT_API_KEY || '').trim() || str(map[ASSISTANT_KEYS.apiKey], 400);

  return {
    // settingBool, not `=== true`. The admin form posts a real boolean, but the
    // relational driver stores every setting as TEXT — so the toggle came back
    // as the STRING "true", which is not `true`, and on that driver the
    // assistant could never be switched on at all. It failed CLOSED, which is
    // why nobody saw a security incident and why nobody saw the feature work.
    // Defaults to OFF: an assistant costs the operator money per message.
    enabled: settingBool(map[ASSISTANT_KEYS.enabled], false),
    provider: provider.id,
    apiKey,
    assistantId: str(map[ASSISTANT_KEYS.assistantId], 200),
    model: str(map[ASSISTANT_KEYS.model], 100) || provider.defaultModel,
    baseUrl: (str(map[ASSISTANT_KEYS.baseUrl], 300) || provider.defaultBaseUrl).replace(/\/+$/, ''),
    title: str(map[ASSISTANT_KEYS.title], ASSISTANT_LIMITS.title) || 'Ask us anything',
    greeting: str(map[ASSISTANT_KEYS.greeting], ASSISTANT_LIMITS.greeting) || 'Hi! How can I help?',
    systemPrompt: str(map[ASSISTANT_KEYS.systemPrompt], ASSISTANT_LIMITS.systemPrompt),
  };
}

/** Usable right now? Enabled, keyed, and with somewhere to send the request. */
export function assistantReady(cfg: AssistantConfig): boolean {
  return cfg.enabled && cfg.apiKey !== '' && cfg.baseUrl !== '' && cfg.model !== '';
}

/** What is still missing, by NAME. Never includes a value. */
export function assistantMissing(cfg: AssistantConfig): string[] {
  const missing: string[] = [];
  if (!cfg.apiKey) missing.push('API key');
  if (!cfg.baseUrl) missing.push('Base URL');
  if (!cfg.model) missing.push('Model');
  return missing;
}

/**
 * Strip anything secret-shaped from text bound for a log.
 *
 * Provider error bodies routinely quote the credential back at you — OpenAI's
 * "Incorrect API key provided: sk-abc…xyz" is the classic. Logging that verbatim
 * puts the key in journalctl, in log shipping, and in any paste of a stack
 * trace. So: redact the configured key exactly, then redact anything that merely
 * *looks* like a key, because a provider may echo a prefix or a rotated value we
 * are not currently holding.
 */
export function redactSecrets(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 8) out = out.split(secret).join('[redacted]');
  }
  return out
    // sk-…, sk_live_…, whsec_…, and bearer-style tokens.
    //
    // The character class includes `*` and `•` deliberately. Providers mask
    // their own echo — OpenAI answers "Incorrect API key provided:
    // sk-proj-****************-abc" — and a class of only [A-Za-z0-9_-] stops
    // at the first asterisk, leaving the prefix AND the unmasked tail in the
    // log. Found by pointing a live install at a deliberately wrong key and
    // reading what actually landed in the journal.
    .replace(/\b(sk|pk|rk)[-_][A-Za-z0-9_*\u2022-]{6,}/g, '[redacted]')
    .replace(/\bwhsec_[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '$1 [redacted]')
    // Long opaque tokens in JSON string values, e.g. "api_key":"………".
    .replace(/("(?:api[_-]?key|token|secret|authorization)"\s*:\s*")[^"]{6,}(")/gi, '$1[redacted]$2');
}

/** Settings key holding the last provider failure, for the admin panel. */
export const ASSISTANT_LAST_ERROR_KEY = 'assistant_last_error';

export interface AssistantErrorRecord {
  /** ISO timestamp. */
  at: string;
  /** HTTP status the provider returned, or 0 for a transport failure. */
  status: number;
  /** Redacted provider message. Never contains a credential. */
  detail: string;
  provider: string;
  model: string;
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Clean an untrusted conversation from the browser.
 *
 * The client sends the whole history back each turn (the server keeps no
 * session), so it is fully attacker-controlled: roles must be constrained to
 * user/assistant — accepting `system` would let a visitor rewrite the operator's
 * instructions — and the length is bounded so nobody can bill the operator for
 * a megabyte of context per request.
 */
export function sanitizeHistory(raw: unknown): ChatTurn[] {
  if (!Array.isArray(raw)) return [];
  const out: ChatTurn[] = [];
  for (const item of raw.slice(-ASSISTANT_LIMITS.historyTurns)) {
    if (!item || typeof item !== 'object') continue;
    const t = item as Record<string, unknown>;
    // 'system' is deliberately not accepted.
    const role = t.role === 'assistant' ? 'assistant' : t.role === 'user' ? 'user' : null;
    if (!role) continue;
    const content = str(t.content, ASSISTANT_LIMITS.message);
    if (!content) continue;
    out.push({ role, content });
  }
  return out;
}

export interface AssistantRequest {
  message: string;
  history: ChatTurn[];
}

export interface AssistantReply {
  ok: boolean;
  reply?: string;
  /** Safe, generic message for the visitor. Never provider detail. */
  error?: string;
  /**
   * Diagnostic detail for the OPERATOR — logged and surfaced in the admin, never
   * returned to the browser. Redacted before it gets here.
   */
  failure?: AssistantErrorRecord;
}

/**
 * Call the provider and return the assistant's text.
 *
 * `fetchImpl` is injectable so the request shape is testable without network or
 * credentials. Errors are deliberately generic to the caller: a provider's error
 * body can echo the account, the model, or fragments of the key.
 */
export async function callAssistant(
  cfg: AssistantConfig,
  req: AssistantRequest,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  now: () => Date = () => new Date(),
  /**
   * Reply budget. Defaults to the public bubble's, which is a chat answer.
   *
   * The editorial tasks (C-163, C-134) pass their own: a rewrite has to come
   * back WHOLE, and a truncated one is worse than none — an editor pastes it in
   * and loses the last third of their article. A parameter rather than a second
   * `callAssistant`, because the two would then differ in the provider
   * dialects, the error redaction and the failure record as well as the number.
   */
  maxTokens: number = ASSISTANT_LIMITS.replyTokens,
): Promise<AssistantReply> {
  const messages = [...req.history, { role: 'user' as const, content: req.message }];

  /**
   * Build the operator-facing failure record.
   *
   * "The assistant is unavailable" with nothing in the log is the worst possible
   * outcome: the operator cannot tell a wrong key from a bad model name from a
   * dead network, and every one of those looks identical to the visitor. So the
   * status and the provider's own message are logged — redacted — and stored for
   * the admin panel.
   */
  const fail = (status: number, rawDetail: unknown): AssistantReply => {
    const text = typeof rawDetail === 'string' ? rawDetail : JSON.stringify(rawDetail ?? null);
    const detail = redactSecrets(String(text ?? '').slice(0, 600), [cfg.apiKey]);
    const record: AssistantErrorRecord = {
      at: now().toISOString(),
      status,
      detail,
      provider: cfg.provider,
      model: cfg.model,
    };
    console.error(
      `[assistant] ${cfg.provider} ${cfg.model} failed: HTTP ${status} ${detail}`,
    );
    return {
      ok: false,
      // The visitor gets nothing diagnostic — provider errors name accounts,
      // quotas, and sometimes the credential.
      error: status === 0 ? 'The assistant could not be reached.' : 'The assistant is unavailable right now.',
      failure: record,
    };
  };

  try {
    if (cfg.provider === 'anthropic') {
      const res = await fetchImpl(`${cfg.baseUrl}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': cfg.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: cfg.model,
          max_tokens: maxTokens,
          ...(cfg.systemPrompt ? { system: cfg.systemPrompt } : {}),
          messages,
        }),
      });
      const json: any = await res.json().catch(() => null);
      if (!res.ok) return fail(res.status, json?.error?.message ?? json ?? `HTTP ${res.status}`);
      const text = (json?.content ?? []).filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n').trim();
      return text ? { ok: true, reply: text } : fail(res.status, 'Provider returned no text content');
    }

    // OpenAI and anything speaking its chat-completions dialect.
    const res = await fetchImpl(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: maxTokens,
        messages: cfg.systemPrompt
          ? [{ role: 'system', content: cfg.systemPrompt }, ...messages]
          : messages,
      }),
    });
    const json: any = await res.json().catch(() => null);
    if (!res.ok) return fail(res.status, json?.error?.message ?? json ?? `HTTP ${res.status}`);
    const text = str(json?.choices?.[0]?.message?.content, 20_000);
    return text ? { ok: true, reply: text } : fail(res.status, 'Provider returned no message content');
  } catch (err) {
    // Status 0 = never got an HTTP answer: DNS, TLS, timeout, wrong base URL.
    return fail(0, err instanceof Error ? err.message : String(err));
  }
}

/**
 * Public-safe view of the config.
 *
 * Exists so there is ONE function that decides what the browser may see, rather
 * than each call site remembering to delete the key. Note what is absent:
 * apiKey, baseUrl, model, and the system prompt — the prompt is the operator's
 * instructions, and revealing it hands a visitor the map to working around it.
 */
export function publicAssistantConfig(cfg: AssistantConfig): {
  enabled: boolean;
  title: string;
  greeting: string;
  consentCategory: ConsentCategory;
} {
  return {
    enabled: assistantReady(cfg),
    title: cfg.title,
    greeting: cfg.greeting,
    consentCategory: ASSISTANT_CONSENT_CATEGORY,
  };
}
