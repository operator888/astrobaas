/**
 * Pluggable email transport. Zero third-party deps. The default just logs to
 * the server console (fine for local dev and for self-hosters who have not
 * wired up email yet); the real ways out are your own SMTP server, a webhook
 * that bridges to any provider, or the SMTP2GO plugin.
 *
 * Selected by env:
 *   EMAIL_TRANSPORT=console            (default) — log to stdout
 *   EMAIL_TRANSPORT=smtp               — any submission server; see email-smtp.ts
 *     SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, EMAIL_FROM,
 *     SMTP_TIMEOUT_MS, SMTP_DATA_TIMEOUT_MS, SMTP_RETRIES, SMTP_HELO_NAME
 *   EMAIL_TRANSPORT=webhook            — POST the message as JSON to:
 *     EMAIL_WEBHOOK_URL=https://…      (required for webhook)
 *     EMAIL_WEBHOOK_SECRET=…           (optional; adds X-AstroBaaS-Signature)
 *
 * And, for every transport:
 *   EMAIL_REPLY_TO=info@example.com    — Reply-To on every message
 *   EMAIL_CAMPAIGNS=0                  — refuse bulk mail (newsletter campaigns)
 *
 * Tests/plugins can inject a transport with setEmailTransport().
 */
import crypto from 'node:crypto';
import { resolveSmtpConfig, smtpTransport } from './email-smtp';
import { isSendableAddress } from './email-mime';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /**
   * Where a reply should go. Defaults to `EMAIL_REPLY_TO`. A value that is not
   * a usable address is replaced by that default rather than sent — see
   * `prepareEmail`.
   *
   * A first-class field rather than an entry in `headers`, because not every
   * transport forwards arbitrary headers the same way, and a Reply-To that one
   * transport silently drops sends the customer's answer to a mailbox nobody
   * reads. Each transport maps this field explicitly.
   */
  replyTo?: string;
  /**
   * `bulk` for mail sent to a list (newsletter campaigns). Anything else is
   * transactional: one message, triggered by something the recipient did.
   *
   * The distinction exists because a mailbox may be licensed for one and not
   * the other — a hosted `noreply` address is typically capped per minute and
   * forbidden from carrying newsletters. `EMAIL_CAMPAIGNS=0` makes `sendEmail`
   * refuse `bulk` outright.
   */
  category?: 'transactional' | 'bulk';
  /**
   * Extra headers (C-111).
   *
   * Added for `List-Unsubscribe`, which is the one header that decides whether
   * a mailing list is treated as a mailing list or as a person sending a lot of
   * mail. Gmail and Outlook both put a one-click Unsubscribe control on a
   * message that carries it, and route a message without one toward the spam
   * complaint button instead — which costs the SENDING DOMAIN its reputation,
   * and that domain is the shop's.
   *
   * The VALUES are sanitised where they are written into the message
   * (`extraHeaderPairs` in email-mime.ts) rather than here, so every transport
   * gets the same protection from a CRLF in a value. `Reply-To` cannot be set
   * here — use `replyTo`.
   */
  headers?: Record<string, string>;
}

/** What a transport can report back about a message it handed off. */
export interface SendResult {
  /**
   * The server's final word on the message, e.g. `250 2.0.0 Ok: queued as 4ab1`.
   * Only SMTP has one; it is what proves a server ACCEPTED the message, which
   * is the most any sender can know.
   */
  response?: string;
  /** How many attempts it took, when the transport retries. */
  attempts?: number;
}

export interface SendOptions {
  /**
   * Observe the protocol conversation, one line at a time (SMTP only).
   *
   * For diagnostics — `npm run mail:test` prints it. Credentials never reach
   * the observer: the AUTH line is redacted before it is emitted, and the
   * message body is summarised rather than dumped, because a real message is a
   * password-reset link.
   */
  onTranscript?: (line: string) => void;
  /**
   * Receive what the transport can report — the server's final reply, the
   * attempts it took. A callback rather than a return value so that
   * `EmailTransport.send` keeps the `Promise<void>` it has always had: plugins
   * implement and call that type, and widening it would break the ones that
   * store it in a `() => Promise<void>` slot, as two call sites here did.
   */
  onResult?: (result: SendResult) => void;
  /**
   * Write this send to the email log (default true). The CLI test turns it off:
   * it runs in its own process, and a second writer on a lowdb file the server
   * is holding in memory can be overwritten — or overwrite — silently.
   */
  record?: boolean;
  /**
   * Wait at most this long for the server's reply to the end of the message
   * (SMTP only; `SMTP_DATA_TIMEOUT_MS`). It can only SHORTEN the configured
   * wait. For loops that send one message after another — see
   * `sendBackgroundEmail`.
   */
  dataTimeoutMs?: number;
}

/**
 * How long a background loop waits for a server to answer the end of a message.
 *
 * The scheduler's sweep sends reminders, back-in-stock notices and campaign
 * batches ONE AT A TIME, and scheduled posts, abandoned-order cancellation and
 * payment-hold expiry all wait behind them on the same tick. At the RFC's ten
 * minutes per message (`SMTP_DATA_TIMEOUT_MS`), one server that takes messages
 * and never says so would hold a 25-address campaign batch for over four hours.
 *
 * One minute is well beyond what a healthy server's filtering after "."
 * normally takes, and a tenth of the RFC figure. Shortening it costs no duplicates — a wait that
 * runs out is an outcome UNKNOWN and is never retried — only a message that was
 * probably delivered being logged as "unknown" rather than "sent". The
 * worst case for one background message is then ~203 s at the defaults
 * (3 × 45 s before ".", ~8 s of backoff, 60 s after) — one minute more than the
 * ~143 s the sweep already allowed, instead of ten.
 */
export const BACKGROUND_DATA_TIMEOUT_MS = 60_000;

/**
 * Is this error a send whose OUTCOME IS UNKNOWN — the whole message went, and
 * no answer came back, so the server may have delivered it?
 *
 * Neither a success nor a failure, and it must not be retried. Duck-typed on an
 * `outcomeUnknown: true` property so a plugin transport can report the same
 * situation (an API request that timed out after it was sent) without importing
 * the SMTP module; `SmtpError` carries it.
 */
export function isOutcomeUnknown(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { outcomeUnknown?: unknown }).outcomeUnknown === true;
}

export interface EmailTransport {
  readonly name: string;
  /**
   * Hand the message off. `opts` is optional and additive: a transport written
   * before it existed ignores it and still conforms. One that has something to
   * report calls `opts.onResult`.
   */
  send(msg: EmailMessage, opts?: SendOptions): Promise<void>;
}

/**
 * The Reply-To to put on every message, from `EMAIL_REPLY_TO`.
 *
 * Held to the same standard as `EMAIL_FROM` — the same check, not a looser one
 * beside it. A value that is set but unusable is reported as an error so it can
 * be SAID (at startup and by the deep health check); what happens to the mail is
 * `prepareEmail`'s decision, and it sends without the header rather than not at
 * all.
 */
export function resolveReplyTo(
  env: NodeJS.ProcessEnv = process.env,
): { replyTo?: string } | { error: string } {
  const raw = (env.EMAIL_REPLY_TO || '').trim();
  if (!raw) return {};
  if (!isSendableAddress(raw)) return { error: `EMAIL_REPLY_TO is not a usable address: ${raw}` };
  return { replyTo: raw };
}

/**
 * May this install send newsletter campaigns? `EMAIL_CAMPAIGNS` = 0, false, no
 * or off says no; anything else, including unset, says yes — so an install that
 * has never heard of the key behaves exactly as it did.
 */
export function campaignsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.EMAIL_CAMPAIGNS || '').trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'no' || v === 'off');
}

/**
 * Why the configured transport cannot be used, in words — or null.
 *
 * ONE place decides this, and both the startup warning and the deep health
 * check read it. The health check used to report only that mail had fallen
 * back to the console, and to suggest SMTP2GO or a webhook — so an operator who
 * had set `EMAIL_TRANSPORT=smtp` and mistyped one variable was told to use a
 * different product instead of which variable.
 */
export function emailConfigProblem(env: NodeJS.ProcessEnv = process.env): string | null {
  const kind = (env.EMAIL_TRANSPORT || 'console').toLowerCase();
  if (kind === 'smtp') {
    const cfg = resolveSmtpConfig(env);
    if ('error' in cfg) return `EMAIL_TRANSPORT=smtp but ${cfg.error}`;
  } else if (kind === 'webhook') {
    if (!env.EMAIL_WEBHOOK_URL) return 'EMAIL_TRANSPORT=webhook but EMAIL_WEBHOOK_URL is unset';
  } else if (kind !== 'console') {
    return `EMAIL_TRANSPORT=${kind} is not a transport this install knows (smtp, webhook, console)`;
  }
  return null;
}

/**
 * Configuration that is wrong but does NOT stop mail going out — said loudly,
 * because nothing else will say it.
 *
 * An unusable EMAIL_REPLY_TO is the case. Refusing to send over it would lose
 * order confirmations and password resets to protect where the customer's
 * ANSWER goes, which is the smaller loss; so mail goes out without the header,
 * and this is what tells the operator their replies are going to the sending
 * mailbox.
 */
export function emailConfigWarnings(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  const rt = resolveReplyTo(env);
  if ('error' in rt) out.push(`${rt.error} — mail is sent WITHOUT a Reply-To, so replies go to the sending address.`);
  return out;
}

/** What has already been said, so a warning is logged once per process, not per send. */
const warned = new Set<string>();

/**
 * Log the configuration warnings, each once per process. Called at startup (the
 * middleware) and whenever the transport is resolved, so an install whose
 * environment changes under a long-lived process still hears about it.
 */
export function reportEmailConfig(env: NodeJS.ProcessEnv = process.env): void {
  for (const w of emailConfigWarnings(env)) {
    if (warned.has(w)) continue;
    warned.add(w);
    console.warn(`[email] WARNING: ${w}`);
  }
}

/** Logs the message to the server console. The zero-config default. */
export const consoleTransport: EmailTransport = {
  name: 'console',
  async send(msg) {
    // Reply-To shown only when set, so the line is unchanged for an install
    // that has not configured one.
    const replyTo = msg.replyTo ? ` reply-to=${msg.replyTo}` : '';
    console.log(`\n[email:console] to=${msg.to}${replyTo} subject=${JSON.stringify(msg.subject)}\n${msg.text}\n`);
  },
};

/** POSTs the message as JSON to `url`, optionally HMAC-signed with `secret`. */
export function webhookTransport(url: string, secret?: string): EmailTransport {
  return {
    name: 'webhook',
    async send(msg) {
      const body = JSON.stringify(msg);
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (secret) {
        const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');
        headers['X-AstroBaaS-Signature'] = `sha256=${sig}`;
      }
      const res = await fetch(url, { method: 'POST', headers, body });
      if (!res.ok) throw new Error(`email webhook failed: HTTP ${res.status}`);
    },
  };
}

let override: EmailTransport | null = null;
/** Override the active transport (tests/plugins). Pass null to revert to env. */
export function setEmailTransport(t: EmailTransport | null): void {
  override = t;
}

/** Resolve the active transport from an override or the environment. */
export function getEmailTransport(env: NodeJS.ProcessEnv = process.env): EmailTransport {
  reportEmailConfig(env);
  if (override) return override;
  const kind = (env.EMAIL_TRANSPORT || 'console').toLowerCase();
  if (kind !== 'smtp' && kind !== 'webhook') return consoleTransport;

  // Resolved eagerly so a misconfiguration is a startup-time complaint with a
  // reason, not a silent fallback that an operator discovers when a customer
  // says they never got their order. The reason comes from emailConfigProblem,
  // the same function the deep health check reports, so the two cannot differ.
  const problem = emailConfigProblem(env);
  if (problem) {
    console.warn(`${problem}; falling back to console.`);
    return consoleTransport;
  }
  if (kind === 'smtp') {
    const cfg = resolveSmtpConfig(env);
    if ('error' in cfg) return consoleTransport; // unreachable: checked above
    return smtpTransport(cfg);
  }
  return webhookTransport(env.EMAIL_WEBHOOK_URL!, env.EMAIL_WEBHOOK_SECRET);
}

/**
 * Is there a REAL way out of this box for an email?
 *
 * The console default "succeeds" by printing to stdout, which makes
 * `sendEmail() didn't throw` prove nothing about delivery. Features whose
 * whole mechanism IS an email — magic-link login, 2FA (whose lockout
 * recovery path is email) — must not be offerable on an install where the
 * message lands in a log nobody reads: a visitor who requests a sign-in
 * link that can never arrive experiences a broken product, not a spam
 * filter.
 *
 * Resolve-then-test, not env-sniffing: the smtp2go plugin activates by
 * SETTING the override, and `webhook` with a missing URL falls back to
 * console — both facts only the resolved transport's name reflects. (The
 * admin settings page once env-sniffed this and drifted; don't copy it.)
 *
 * Deliberately NOT coupled to last-send success: a transient provider error
 * must degrade delivery, not switch login methods off site-wide. Delivery
 * health is a separate fact, reported by /api/health/deep.
 */
export function emailChannelActive(): boolean {
  return getEmailTransport().name !== 'console';
}

/**
 * What the operator should be told is sending their mail.
 *
 * Resolved from the TRANSPORT, not by sniffing environment variables. The
 * settings screen listed the env vars it knew about and was never updated when
 * the SMTP transport was added — so an operator who had configured
 * EMAIL_TRANSPORT=smtp correctly was told no transport existed while mail was
 * in fact going out. A screen reporting the opposite of what the system does is
 * worse than one that says nothing, and it can only happen when two places
 * decide the same fact.
 *
 * Returns null when nothing but the console is configured.
 */
export function emailChannelLabel(env: NodeJS.ProcessEnv = process.env): string | null {
  const t = getEmailTransport(env);
  if (t.name === 'console') return null;
  if (t.name === 'smtp') return `SMTP (${env.SMTP_HOST || 'SMTP_HOST is not set'})`;
  if (t.name === 'webhook') return 'a webhook';
  // A plugin transport names itself — smtp2go overrides at activate().
  return t.name;
}

/** Outcome of the most recent send this process attempted. */
export interface LastSendOutcome {
  at: string;
  /** True only when the transport accepted the message. */
  ok: boolean;
  transport: string;
  /** Present on failure. Message only — never the recipient or body. */
  error?: string;
  /**
   * `unknown` (with `ok: false`): the whole message went and no answer came
   * back, so it may have been delivered — see `isOutcomeUnknown`. Absent for a
   * success and for a plain failure. `ok` stays false so that anything reading
   * only `ok` stays cautious, as it was before this existed.
   */
  outcome?: 'unknown';
}

let lastSend: LastSendOutcome | null = null;

/** For the deep health check: how did the last real send go? */
export function lastSendOutcome(): LastSendOutcome | null {
  return lastSend;
}

/**
 * What the deep health check should say about the last send, or null when it
 * went. One place, so "may have been delivered" cannot be reported as "failed".
 */
export function lastSendWarning(last: LastSendOutcome | null): string | null {
  if (!last || last.ok) return null;
  if (last.outcome === 'unknown') {
    return 'the server never confirmed the last email this process sent — it may have been delivered, '
      + `and was not sent again (${last.error ?? 'no reply'})`;
  }
  return `the last email this process tried to send failed (${last.error ?? 'unknown error'})`;
}

/**
 * Record one send, for the operator's log.
 *
 * Best-effort in every direction: a failure to write the log must never turn a
 * successful email into an error, and must never mask a real send failure
 * either. The BODY is not passed in — password-reset links, magic sign-in
 * links and invoices all come through here, and a log holding their contents
 * would be a store of live credentials readable by every admin.
 *
 * Imported lazily because `lib/email.ts` is pulled into small scripts and the
 * health check, and neither should drag the whole storage layer in behind it.
 */
function record(
  to: string,
  subject: string,
  transport: string,
  ok: boolean,
  detail: { error?: string; response?: string; outcome?: 'unknown' } = {},
): void {
  void (async () => {
    try {
      const { LocalDB } = await import('./localdb');
      await LocalDB.logEmail({
        to, subject, transport, ok,
        ...(detail.error ? { error: detail.error } : {}),
        // "May have been delivered" — neither sent nor failed. Stored inside the
        // entry's JSON like `response`, so no migration.
        ...(detail.outcome ? { outcome: detail.outcome } : {}),
        // The server's own "250 … queued as …": the id an operator quotes to
        // the mail host when a customer says a message never arrived.
        ...(detail.response ? { response: detail.response } : {}),
      });
    } catch {
      /* the log is a convenience; the email is the job */
    }
  })();
}

/**
 * Everything `sendEmail` does to a message before a transport sees it.
 *
 * Exported so the CLI test (`npm run mail:test`) prepares its message through
 * the SAME rules rather than a parallel copy of them — a test path that skips
 * the Reply-To default would prove a configuration the site does not run.
 *
 * Reply-To: the caller's own, when it is a usable address — a contact form
 * sets the visitor's, so the site owner can simply press Reply. One that is not
 * usable (a visitor typed nonsense) is DROPPED in favour of the default rather
 * than written into a header. The default is EMAIL_REPLY_TO; when that is itself
 * unusable the message goes without one (see emailConfigWarnings).
 *
 * Throws (with a reason fit for the log) only when the message must not go out
 * at all: it is bulk mail and this install has EMAIL_CAMPAIGNS=0.
 */
export function prepareEmail(
  msg: EmailMessage,
  _transportName: string,
  env: NodeJS.ProcessEnv = process.env,
): EmailMessage {
  if (msg.category === 'bulk' && !campaignsEnabled(env)) {
    throw new Error(
      'Refusing to send bulk mail: this install has EMAIL_CAMPAIGNS=0. '
      + 'Newsletters need a sending service that allows them.',
    );
  }
  // A plugin written before `replyTo` existed set it as `headers['Reply-To']`,
  // which the MIME builder now refuses (one Reply-To, from one place). Read it
  // here instead, held to the same checks, so that plugin keeps working.
  const legacy = Object.entries(msg.headers ?? {}).find(([k]) => k.toLowerCase() === 'reply-to')?.[1];
  const own = typeof msg.replyTo === 'string' ? msg.replyTo.trim()
    : typeof legacy === 'string' ? legacy.trim() : '';
  if (own && isSendableAddress(own) && !/[\r\n]/.test(own)) return { ...msg, replyTo: own };
  const rt = resolveReplyTo(env);
  const { replyTo: _dropped, ...rest } = msg;
  return 'replyTo' in rt && rt.replyTo ? { ...rest, replyTo: rt.replyTo } : rest;
}

/**
 * Send a message and report what the transport said about it.
 *
 * The one path every send takes — `sendEmail` is this with the result
 * discarded, so there is no second, thinner way to send. Resolves with the
 * transport's report (the SMTP server's final `250 …`, the attempts taken), or
 * `undefined` from a transport with nothing to report.
 *
 * Rejects on failure — and on an outcome UNKNOWN, which a caller can tell apart
 * with `isOutcomeUnknown(err)`. Rejecting keeps every caller that predates it
 * from counting a message nobody confirmed as sent; the log, `lastSendOutcome`
 * and the health check record it as `outcome: 'unknown'`, not as a failure.
 */
export async function deliverEmail(msg: EmailMessage, opts: SendOptions = {}): Promise<SendResult | undefined> {
  const transport = getEmailTransport();
  const to = Array.isArray(msg.to) ? msg.to.join(', ') : String(msg.to ?? '');
  const shouldRecord = opts.record !== false;
  let result: SendResult | undefined;
  try {
    const prepared = prepareEmail(msg, transport.name);
    await transport.send(prepared, {
      ...opts,
      onResult: (r) => { result = r; opts.onResult?.(r); },
    });
    lastSend = { at: new Date().toISOString(), ok: true, transport: transport.name };
    if (shouldRecord) record(to, String(msg.subject ?? ''), transport.name, true, { response: result?.response });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const unknown = isOutcomeUnknown(err);
    lastSend = {
      at: new Date().toISOString(),
      ok: false,
      transport: transport.name,
      error: message,
      ...(unknown ? { outcome: 'unknown' as const } : {}),
    };
    // A FAILED send is the one worth logging most: it is the reason somebody
    // did not get their order confirmation. The message carries the server's
    // own reply ("SMTP RCPT TO failed: 550 …") and never a credential. An
    // UNKNOWN one says so, because "failed" would send an operator to resend a
    // message the customer may already have.
    if (shouldRecord) {
      record(to, String(msg.subject ?? ''), transport.name, false, { error: message, ...(unknown ? { outcome: 'unknown' as const } : {}) });
    }
    throw err;
  }
}

/**
 * Send a message via the active transport.
 *
 * Public plugin API (src/core) — its signature is exactly what it has always
 * been. Use `deliverEmail` for the server's reply.
 */
export async function sendEmail(msg: EmailMessage): Promise<void> {
  await deliverEmail(msg);
}

/**
 * `sendEmail` for a loop that sends one message after another off the request
 * path — the scheduler's reminders, back-in-stock notices and campaign batches.
 *
 * The same send, with the wait for the server's reply to the end of the message
 * cut to BACKGROUND_DATA_TIMEOUT_MS, so one silent server cannot hold the whole
 * sweep for ten minutes a message. See there for why that costs no duplicates.
 */
export async function sendBackgroundEmail(msg: EmailMessage): Promise<void> {
  await deliverEmail(msg, { dataTimeoutMs: BACKGROUND_DATA_TIMEOUT_MS });
}
