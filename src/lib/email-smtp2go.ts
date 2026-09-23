/**
 * SMTP2GO email transport.
 *
 * Uses SMTP2GO's HTTP API rather than SMTP: no socket handling, no third-party
 * mail dependency, and it works from platforms that block outbound port 587.
 *
 * Two things about this API are easy to get wrong, and both are handled here:
 *
 * 1. **HTTP 200 does not mean the mail was sent.** SMTP2GO answers 200 with a
 *    body reporting `succeeded` and `failed` counts. A transport that only
 *    checks `res.ok` silently drops undeliverable mail — including password
 *    resets, where the user simply never receives anything and no error is
 *    logged anywhere.
 * 2. **The API key belongs in a header, not the body.** The older documented
 *    form puts `api_key` in the JSON payload, which means the credential ends
 *    up in any request-body log or error dump. `X-Smtp2go-Api-Key` keeps it out
 *    of the payload.
 *
 * Credentials come from the environment. They must never be stored in the
 * settings table, which has a public read path (see settings-visibility.ts).
 */

import type { EmailMessage, EmailTransport } from './email';
import { encodeAddressHeader, extraHeaderPairs } from './email-mime';

const ENDPOINT = 'https://api.smtp2go.com/v3/email/send';

export interface Smtp2goOptions {
  apiKey: string;
  /** Verified sender, e.g. "Shop <no-reply@example.com>". */
  sender: string;
  /** Injectable for tests. */
  fetchImpl?: typeof globalThis.fetch;
  endpoint?: string;
}

/** Names of env vars this transport needs. Exported so the plugin can report them. */
export const SMTP2GO_ENV = ['SMTP2GO_API_KEY', 'SMTP2GO_SENDER'] as const;

export function smtp2goTransport(opts: Smtp2goOptions): EmailTransport {
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const endpoint = opts.endpoint ?? ENDPOINT;

  return {
    name: 'smtp2go',
    async send(msg: EmailMessage) {
      // Headers travel as `custom_headers: [{ header, value }]` — SMTP2GO's API
      // has no Reply-To field of its own, and its reference names this array
      // as the way to set one. This transport used to send no headers at all,
      // so it dropped C-111's List-Unsubscribe too: a campaign sent through it
      // reached Gmail without the one-click control, and that is scored against
      // the sending domain. The cleaning rules are the SMTP builder's, shared.
      const customHeaders = [
        // Unfolded: a long encoded name is folded with CRLF for a raw message,
        // but here it is a JSON value, where a line break is exactly what
        // extraHeaderPairs strips from every other one.
        ...(msg.replyTo ? [{ header: 'Reply-To', value: encodeAddressHeader(msg.replyTo).replace(/\r\n[ \t]/g, ' ') }] : []),
        ...extraHeaderPairs(msg.headers).map(([header, value]) => ({ header, value })),
      ];
      const res = await doFetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Header, not body — keeps the key out of payload logs.
          'X-Smtp2go-Api-Key': opts.apiKey,
          Accept: 'application/json',
        },
        body: JSON.stringify({
          sender: opts.sender,
          to: [msg.to],
          subject: msg.subject,
          text_body: msg.text,
          ...(msg.html ? { html_body: msg.html } : {}),
          // Absent rather than empty when there is nothing to send, so a
          // message with no headers makes exactly the request it always did.
          ...(customHeaders.length ? { custom_headers: customHeaders } : {}),
        }),
      });

      const body: any = await res.json().catch(() => null);

      if (!res.ok) {
        // Surface the provider's own error id, never the request we sent — the
        // request carries recipient addresses and message content.
        const detail = body?.data?.error || body?.error || `HTTP ${res.status}`;
        throw new Error(`SMTP2GO send failed: ${detail}`);
      }

      // The part a naive integration misses: a 200 can still be a failure.
      const succeeded = Number(body?.data?.succeeded ?? 0);
      const failed = Number(body?.data?.failed ?? 0);
      if (succeeded < 1 || failed > 0) {
        const reasons = body?.data?.failures?.join?.('; ') || body?.data?.error || 'no recipients accepted';
        throw new Error(`SMTP2GO accepted the request but sent nothing: ${reasons}`);
      }
    },
  };
}

/**
 * Build the transport from the environment, or explain what is missing.
 *
 * Returns a discriminated result rather than throwing: the plugin activates on
 * a normal request path, and a missing credential should disable the connector
 * with a clear log, not take down the request.
 */
export function smtp2goFromEnv(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
  fetchImpl?: typeof globalThis.fetch,
): { ok: true; transport: EmailTransport } | { ok: false; missing: string[] } {
  const missing = SMTP2GO_ENV.filter((name) => {
    const v = env[name];
    return typeof v !== 'string' || v.trim() === '';
  });
  if (missing.length) return { ok: false, missing };
  return {
    ok: true,
    transport: smtp2goTransport({
      apiKey: env.SMTP2GO_API_KEY!.trim(),
      sender: env.SMTP2GO_SENDER!.trim(),
      fetchImpl,
    }),
  };
}
