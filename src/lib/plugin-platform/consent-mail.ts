/**
 * `host.consent` and `host.mail` — what a compiled plugin gets for consent and
 * for sending email.
 *
 * ## host.consent
 *
 * The consent ledger (src/lib/consent-ledger.ts), through the SAME service
 * core's own newsletter routes use (consent-service.ts), so a plugin's
 * `confirm({ purpose: 'newsletter' })` subscribes exactly the way a click on
 * core's confirmation link does — and refuses exactly the same way when the
 * person never granted it.
 *
 *   record({ email, purpose, granted, version, text, ip?, ua?, source })
 *     → { id, text_hash, at }            appends one row; throws on bad input
 *   confirm({ email, purpose, source, ip?, ua? })
 *     → { confirmed }                     only if the latest row is a grant
 *   withdraw({ email, purpose, source })  → void, appends a `granted: false` row
 *   withdrawUrl({ email, purpose })       → a signed public link that withdraws
 *
 * ## host.mail
 *
 *   send({ to, subject, html, text, headers?, category })
 *     → { ok, id?, error? }
 *
 * Through the CONFIGURED core transport (SMTP, SMTP2GO, the webhook bridge,
 * or whatever an install set) — with its Reply-To rules, its
 * `EMAIL_CAMPAIGNS=0` refusal of bulk mail, its delivery log and its health
 * reporting. A plugin never opens its own SMTP connection: one that did would
 * bypass every one of those, and send from credentials the operator configured
 * for something else.
 *
 * It never throws: a failure is `{ ok: false, error }`, because a plugin route
 * that throws on a mail-server hiccup answers its visitor with a 500.
 *
 * `category: 'bulk'` is newsletter mail, and core enforces what that means:
 *   - only to an address whose `newsletter` consent is granted AND confirmed
 *     AND not withdrawn (`error: 'no_newsletter_consent'` otherwise);
 *   - with RFC 8058 one-click unsubscribe headers (`List-Unsubscribe` +
 *     `List-Unsubscribe-Post`) and an unsubscribe link in the body, set by core
 *     — a plugin's own values for those two headers are replaced.
 *
 * Zero imports of storage at module load: the factory runs while plugins load.
 */
import type { ConsentRecordInput } from '../consent-ledger';
import { escapeHtml } from '../escape-html';

export interface PluginConsent {
  record(input: ConsentRecordInput): Promise<{ id: string; text_hash: string; at: string }>;
  confirm(input: { email: string; purpose: string; source: string; ip?: string; ua?: string }): Promise<{ confirmed: boolean }>;
  withdraw(input: { email: string; purpose: string; source: string }): Promise<void>;
  /**
   * A signed link that withdraws ONE purpose for ONE address — put it in the
   * mail you send, so a person can take back what they gave as easily as they
   * gave it (GDPR Art. 7(3)). A click (GET) withdraws and shows a page; a POST
   * answers a bare 200. Valid for a year.
   */
  withdrawUrl(input: { email: string; purpose: string }): Promise<string>;
}

export interface PluginMailMessage {
  to: string;
  subject: string;
  html?: string;
  text: string;
  headers?: Record<string, string>;
  category: 'transactional' | 'bulk';
}

export interface PluginMail {
  send(msg: PluginMailMessage): Promise<{ ok: boolean; id?: string; error?: string }>;
}

/**
 * The operator's site_url, else SITE_URL — the same origin the newsletter
 * signup route puts in its confirmation links. Null when neither is set.
 */
async function siteOrigin(): Promise<string | null> {
  const [{ resolveSiteUrl }, { LocalDB }] = await Promise.all([import('../site-url'), import('../localdb')]);
  return resolveSiteUrl({
    setting: (await LocalDB.getSetting('site_url'))?.value,
    astroSite: process.env.SITE_URL,
  });
}

export function createPluginConsent(): PluginConsent {
  const svc = () => import('../consent-service');
  return {
    record: async (input) => (await svc()).recordConsent(input),
    confirm: async (input) => (await svc()).confirmConsent(input),
    withdraw: async (input) => (await svc()).withdrawConsent(input),
    withdrawUrl: async (input) => {
      const [{ validEmail, validPurpose }, { consentWithdrawUrl }] = await Promise.all([
        import('../consent-ledger'),
        import('../newsletter-confirm'),
      ]);
      const email = validEmail(input?.email);
      const purpose = validPurpose(input?.purpose);
      const origin = await siteOrigin();
      if (!origin) throw new Error('withdrawUrl: no site URL is configured (site_url setting or SITE_URL)');
      return consentWithdrawUrl(origin, email, purpose);
    },
  };
}

/** The header names core owns on newsletter mail. Compared case-insensitively. */
const UNSUBSCRIBE_HEADERS = ['list-unsubscribe', 'list-unsubscribe-post'];

/**
 * Add the unsubscribe link to a newsletter message. Pure, exported for tests.
 *
 * The plain-text part gets a line; the HTML part, when there is one, gets a
 * link — escaped, because the URL carries a token.
 */
export function withUnsubscribe(
  msg: { text: string; html?: string; headers?: Record<string, string> },
  unsubscribeUrl: string,
): { text: string; html?: string; headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(msg.headers ?? {})) {
    if (!UNSUBSCRIBE_HEADERS.includes(k.toLowerCase())) headers[k] = v;
  }
  headers['List-Unsubscribe'] = `<${unsubscribeUrl}>`;
  headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  const escaped = escapeHtml(unsubscribeUrl);
  return {
    text: `${msg.text}\n\n—\nTo stop receiving these: ${unsubscribeUrl}`,
    ...(typeof msg.html === 'string'
      ? { html: `${msg.html}\n<hr />\n<p style="font-size:12px;color:#6b7280"><a href="${escaped}">Unsubscribe</a></p>` }
      : {}),
    headers,
  };
}

export function createPluginMail(): PluginMail {
  return {
    async send(raw) {
      try {
        const [{ deliverEmail, isOutcomeUnknown }, { isSendableAddress }] = await Promise.all([
          import('../email'),
          import('../email-mime'),
        ]);
        const msg = (raw ?? {}) as Partial<PluginMailMessage>;
        const to = typeof msg.to === 'string' ? msg.to.trim() : '';
        // ONE recipient, a real address. A list here would be a plugin mailing
        // many people with each one's address visible to all the others.
        if (!to || /[\r\n,;]/.test(to) || !isSendableAddress(to)) return { ok: false, error: 'invalid_recipient' };
        const subject = typeof msg.subject === 'string' ? msg.subject.replace(/[\r\n]+/g, ' ').trim() : '';
        if (!subject || subject.length > 998) return { ok: false, error: 'invalid_subject' };
        if (typeof msg.text !== 'string' || !msg.text) return { ok: false, error: 'invalid_text' };
        if (msg.html !== undefined && typeof msg.html !== 'string') return { ok: false, error: 'invalid_html' };
        if (msg.category !== 'transactional' && msg.category !== 'bulk') return { ok: false, error: 'invalid_category' };
        const headers: Record<string, string> = {};
        if (msg.headers !== undefined) {
          if (!msg.headers || typeof msg.headers !== 'object' || Array.isArray(msg.headers)) return { ok: false, error: 'invalid_headers' };
          for (const [k, v] of Object.entries(msg.headers)) {
            if (typeof v === 'string') headers[k] = v;
          }
        }

        let text = msg.text;
        let html = msg.html;
        let finalHeaders = headers;
        if (msg.category === 'bulk') {
          const [{ isNewsletterContact }, { unsubscribeUrl }] = await Promise.all([
            import('../consent-service'),
            import('../newsletter-confirm'),
          ]);
          if (!(await isNewsletterContact(to))) return { ok: false, error: 'no_newsletter_consent' };
          const origin = await siteOrigin();
          // Without an origin there is no unsubscribe link to give, and a
          // newsletter without one is not sent.
          if (!origin) return { ok: false, error: 'no_site_url' };
          const out = withUnsubscribe({ text, html, headers }, unsubscribeUrl(origin, to));
          text = out.text;
          html = out.html;
          finalHeaders = out.headers;
        }

        try {
          const result = await deliverEmail({
            to, subject, text,
            ...(html !== undefined ? { html } : {}),
            ...(Object.keys(finalHeaders).length ? { headers: finalHeaders } : {}),
            category: msg.category,
          });
          return { ok: true, ...(result?.response ? { id: result.response } : {}) };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          // "May have been delivered" is not a plain failure: a plugin that
          // retries it may send the person a second copy of a one-time code.
          return { ok: false, error: isOutcomeUnknown(err) ? `outcome_unknown: ${message}` : message };
        }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
