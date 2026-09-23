/**
 * An SMTP client, by hand.
 *
 * ## Why by hand
 *
 * The whole point of WP Mail SMTP — the plugin this capability is benchmarked
 * against — is pointing a site at your own or your host's mail server. AstroBaaS
 * had `console` and `webhook` and a SMTP2GO plugin, so the one thing a
 * self-hosted CMS is expected to do, it could not.
 *
 * Nodemailer is the obvious answer and it is 100+ transitive packages for a
 * protocol whose transactional subset is eleven verbs. This project ships
 * eleven dependencies in total and hand-writes AWS SigV4 for the same reason.
 * `node:net` and `node:tls` are in the runtime already.
 *
 * ## What it does and does not do
 *
 * Sends one transactional message per connection: EHLO, optional STARTTLS,
 * optional AUTH, MAIL FROM, RCPT TO, DATA, QUIT. No pooling, no queue, no
 * attachments, one recipient. That is exactly the shape of every message this
 * CMS sends, and a client that did more would be more to get wrong.
 *
 * Retries (`SMTP_RETRIES`, default and ceiling SMTP_MAX_RETRIES = 2) apply only
 * to failures the protocol calls transient — a 4xx reply, a dropped connection,
 * a timeout — each on a fresh connection, after ~2 s and then ~6 s. A 5xx, a
 * failed login and a bad certificate are never retried.
 *
 * ## Nothing is retried once the final "." has gone
 *
 * After the "." that ends the message the server usually HAS it, and is busy
 * filtering and queueing it. A reply lost there — a timeout, a dropped or reset
 * connection — says nothing about whether it was accepted, and retrying it is
 * how a customer gets the same password reset three times while the log says it
 * failed. RFC 5321 §4.5.3.2.6 gives that wait ten minutes for exactly this
 * reason. So that wait has its own timeout (`SMTP_DATA_TIMEOUT_MS`, default ten
 * minutes), the per-attempt ceiling does not apply to it, and whatever ends it
 * other than a real reply is reported as an OUTCOME UNKNOWN (`SmtpError`
 * with `outcomeUnknown`), never retried. A real 4xx reply to "." is still
 * retried: the server said it did not take the message.
 *
 * ## How long a send can take
 *
 * `SMTP_TIMEOUT_MS` bounds each single wait on the network before "." (the
 * connection, the TLS handshake, each reply). A server can still answer every
 * step just inside that, so the part of an attempt before "." is also capped as
 * a whole at 3 × SMTP_TIMEOUT_MS, after which its socket is destroyed. After
 * ".", only `SMTP_DATA_TIMEOUT_MS` applies, and only one attempt ever gets
 * there. The worst case for one message is therefore 3 × 3 × SMTP_TIMEOUT_MS +
 * ~8 s of backoff + SMTP_DATA_TIMEOUT_MS: about 12½ minutes at the defaults,
 * almost all of it a server that took the message and never said so. Every
 * request-path caller sends detached, so no HTTP response waits on it; the
 * scheduler's one-at-a-time loops pass a one-minute data timeout instead
 * (`BACKGROUND_DATA_TIMEOUT_MS` in email.ts).
 *
 * Delivery is not guaranteed by anything here — a 250 means the server ACCEPTED
 * the message, not that anyone received it. The email log records what was
 * attempted, which is the honest limit of what a sender can know.
 *
 * ## The credential
 *
 * `SMTP_PASS` is read from the environment and never logged, never echoed into
 * an error, and never returned by any endpoint. The AUTH exchange is base64 but
 * that is encoding, not encryption, so authentication is refused on a
 * connection that is not encrypted unless the operator has explicitly allowed
 * it for a local relay.
 */
import net from 'node:net';
import tls from 'node:tls';
import os from 'node:os';
import { domainToASCII } from 'node:url';
import { randomBytes } from 'node:crypto';
import type { EmailMessage, EmailTransport, SendOptions } from './email';
import { buildMimeMessage, stuffDots, envelopeAddress, isSendableAddress } from './email-mime';

export interface SmtpConfig {
  host: string;
  port: number;
  /** Implicit TLS from the first byte (port 465). Otherwise STARTTLS is used. */
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
  /**
   * Allow AUTH over an unencrypted connection.
   *
   * Off by default and deliberately awkward to turn on: sending a password in
   * base64 over plaintext is sending it in the clear. The one honest use is a
   * relay on localhost, where there is no network to intercept.
   */
  allowInsecureAuth?: boolean;
  /**
   * Accept a certificate this machine cannot verify.
   *
   * Off by default, and it should stay off for anything on the public internet
   * — an unverified certificate means the TLS session may be with anyone. The
   * honest use is an internal relay with a self-signed certificate, which is
   * common enough that refusing it outright would push operators to the far
   * worse workaround of disabling TLS entirely.
   */
  allowSelfSigned?: boolean;
  /**
   * How long to wait for any ONE thing from the network — the connection, the
   * greeting, each reply. Not the whole transaction: a server answering each
   * command in eight seconds is slow, not broken.
   */
  timeoutMs?: number;
  /**
   * How long to wait for the reply to the final "." (`SMTP_DATA_TIMEOUT_MS`).
   *
   * Separate from `timeoutMs`, and not bounded by the per-attempt ceiling: by
   * then the server usually has the message, so giving up early does not save
   * a send — it turns an acceptance into an "outcome unknown". Default
   * SMTP_DEFAULT_DATA_TIMEOUT_MS, the RFC's ten minutes.
   */
  dataTimeoutMs?: number;
  /**
   * How many times to try again after a TRANSIENT failure (see
   * `isTransientSmtpError`), 0 to SMTP_MAX_RETRIES. Default SMTP_MAX_RETRIES.
   */
  retries?: number;
  /**
   * The name this client gives in EHLO (`SMTP_HELO_NAME`). Defaults to
   * `defaultHeloName(from)` — see there.
   */
  heloName?: string;
}

export const SMTP_DEFAULT_TIMEOUT_MS = 15_000;

/** RFC 5321 §4.5.3.2.6: wait ten minutes for the reply to the final ".". */
export const SMTP_DEFAULT_DATA_TIMEOUT_MS = 600_000;
/**
 * The range `SMTP_DATA_TIMEOUT_MS` is clamped to. Below a second, a healthy
 * server that scans the message before it answers would be reported as
 * "unknown" on every send; past half an hour, a dead server holds the send for
 * no reason anyone could want.
 */
export const SMTP_MIN_DATA_TIMEOUT_MS = 1_000;
export const SMTP_MAX_DATA_TIMEOUT_MS = 1_800_000;

/** The largest delay a Node timer honours; past it, setTimeout fires after 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * The most retries this client will make, whatever is configured.
 *
 * A hard ceiling because the servers this is pointed at are often RATE-LIMITED
 * per mailbox (a hosted noreply address at ten a minute is typical), and a
 * retry storm against a rate limit does not deliver the message — it spends the
 * mailbox's allowance on the same one, and can get the account suspended.
 */
export const SMTP_MAX_RETRIES = 2;

/**
 * The name to give in EHLO when none is configured.
 *
 * EHLO carries the CLIENT's name (RFC 5321 §4.1.1.1). This client used to send
 * the SERVER's name, SMTP_HOST, which a strict server is entitled to refuse —
 * a client claiming to be the server itself looks like what it usually is.
 *
 * This machine's own name when it is a real one (a dotted name that is not an
 * mDNS `.local` or `localhost`), otherwise the domain of EMAIL_FROM: the one
 * domain this sender demonstrably speaks for.
 */
export function defaultHeloName(from: string, hostname: string = os.hostname()): string {
  const h = hostname.trim().toLowerCase();
  const fqdn = h.includes('.')
    && isValidEhloName(h)
    && !/(^|\.)(local|localdomain|localhost)$/.test(h);
  if (fqdn) return h;
  // Checked like SMTP_HELO_NAME is: it goes onto the wire. A Greek shop's IDN
  // domain becomes its punycode form; anything still unusable (an underscore)
  // falls back to `localhost`, which every server parses, rather than a name a
  // strict server answers with a permanent 5xx on every send.
  const domain = asciiDomain(envelopeAddress(from).split('@')[1] ?? '');
  return domain && isValidEhloName(domain) ? domain : 'localhost';
}

/** A domain in its ASCII (punycode) form, lower-cased; '' if it has none. */
function asciiDomain(domain: string): string {
  const d = domain.trim().toLowerCase();
  return d ? (domainToASCII(d) || '') : '';
}

/**
 * Is this usable as an EHLO argument — a host name, or an address literal?
 *
 * Strict because it is written onto the wire verbatim: a value carrying a space
 * or a line break is a second SMTP command smuggled in by configuration.
 */
export function isValidEhloName(name: string): boolean {
  if (name.length === 0 || name.length > 253) return false;
  if (/^\[(\d{1,3}(\.\d{1,3}){3}|IPv6:[0-9A-Fa-f:.]+)\]$/.test(name)) return true;
  const label = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?';
  return new RegExp(`^${label}(?:\\.${label})*$`).test(name);
}

/**
 * An SMTP failure, carrying what a retry decision needs.
 *
 * The MESSAGE is exactly what it was before this class existed — `SMTP RCPT
 * TO failed: 550 …` — because operators grep logs for it and the email log
 * stores it. What is new is the structure beside it.
 */
export class SmtpError extends Error {
  /** The protocol step that failed, e.g. `RCPT TO`. */
  readonly step: string;
  /** The server's reply code, when the failure was a reply. */
  readonly code?: number;
  /** Could the same send succeed if tried again shortly? */
  readonly transient: boolean;
  /**
   * The whole message was sent and no reply to the final "." came back — the
   * server may have delivered it. Never transient: sending it again is how a
   * customer gets it twice. `isOutcomeUnknown` in email.ts reads this flag, so
   * a plugin transport with the same situation (an API request that timed out
   * after it was sent) can report it the same way.
   */
  readonly outcomeUnknown: boolean;

  constructor(message: string, step: string, code: number | undefined, transient: boolean, outcomeUnknown = false) {
    super(message);
    this.name = 'SmtpError';
    this.step = step;
    this.code = code;
    this.transient = transient && !outcomeUnknown;
    this.outcomeUnknown = outcomeUnknown;
  }
}

/** Socket-level failures that are about the network, not about the message. */
const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN', 'EPIPE',
]);

/**
 * Should this failure be retried?
 *
 * RFC 5321 draws the line for us: a 4xx reply is a transient negative
 * completion ("try again later"), a 5xx is permanent. Retrying a 550 cannot
 * succeed, and retrying a 535 — authentication failed — is a lockout waiting to
 * happen. Network failures are retried only from an ALLOW-list: anything
 * unrecognised, a certificate error above all, is permanent. A certificate that
 * failed verification will fail it again in two seconds, and a client that
 * retries TLS errors is one step from a client that ignores them.
 *
 * An outcome-unknown error (the reply to the final "." never came) is never
 * transient, whatever ended the wait: see SmtpError.outcomeUnknown.
 */
export function isTransientSmtpError(err: unknown): boolean {
  if (err instanceof SmtpError) return err.transient;
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && TRANSIENT_NETWORK_CODES.has(code);
}

/** Is this an IPv4 or IPv6 literal rather than a host name? */
export function isIpLiteral(host: string): boolean {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  // Bracketed or bare IPv6. Colons cannot appear in a host name, so this is
  // sufficient without parsing the address.
  return host.includes(':') || (host.startsWith('[') && host.endsWith(']'));
}

/** Read the transport's configuration from the environment. */
export function resolveSmtpConfig(
  env: NodeJS.ProcessEnv,
  /** Injectable for tests; see defaultHeloName. */
  hostname: string = os.hostname(),
): SmtpConfig | { error: string } {
  const host = (env.SMTP_HOST || '').trim();
  if (!host) return { error: 'SMTP_HOST is not set' };

  const secure = /^(1|true|yes)$/i.test((env.SMTP_SECURE || '').trim());
  const rawPort = (env.SMTP_PORT || '').trim();
  const port = rawPort ? Number(rawPort) : (secure ? 465 : 587);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { error: `SMTP_PORT is not a valid port: ${rawPort}` };
  }

  // A From address is not optional: a message without one is rejected by every
  // server, and defaulting it to something invented would fail at delivery time
  // rather than at configuration time.
  const from = (env.EMAIL_FROM || '').trim();
  if (!from) return { error: 'EMAIL_FROM is not set' };
  if (!isSendableAddress(from)) return { error: `EMAIL_FROM is not a usable address: ${from}` };

  const user = (env.SMTP_USER || '').trim() || undefined;
  const pass = env.SMTP_PASS || undefined;
  if (user && !pass) return { error: 'SMTP_USER is set but SMTP_PASS is not' };

  // Retries: a whole number, capped. A value that is not a number at all is a
  // typo worth saying so about — the same treatment SMTP_PORT gets — while a
  // number above the cap has an obvious safe reading, so it is clamped.
  const rawRetries = (env.SMTP_RETRIES || '').trim();
  let retries = SMTP_MAX_RETRIES;
  if (rawRetries) {
    const n = Number(rawRetries);
    if (!Number.isInteger(n) || n < 0) {
      return { error: `SMTP_RETRIES must be a whole number from 0 to ${SMTP_MAX_RETRIES}: ${rawRetries}` };
    }
    retries = Math.min(n, SMTP_MAX_RETRIES);
  }

  // Written onto the wire verbatim, so it is validated like SMTP_PORT is:
  // a typo is a configuration error, not a surprise at the first send.
  const rawHelo = (env.SMTP_HELO_NAME || '').trim();
  if (rawHelo && !isValidEhloName(rawHelo)) {
    return { error: `SMTP_HELO_NAME is not a host name or address literal: ${rawHelo}` };
  }

  // The wait for the reply to the final ".". Treated like SMTP_RETRIES: a value
  // that is not a positive whole number is a typo worth saying so about (and
  // "0" does not mean "wait forever"), while a number outside the sane range
  // has an obvious reading and is clamped.
  const rawData = (env.SMTP_DATA_TIMEOUT_MS || '').trim();
  let dataTimeoutMs = SMTP_DEFAULT_DATA_TIMEOUT_MS;
  if (rawData) {
    const n = Number(rawData);
    if (!Number.isInteger(n) || n <= 0) {
      return { error: `SMTP_DATA_TIMEOUT_MS must be a whole number of milliseconds: ${rawData}` };
    }
    dataTimeoutMs = Math.min(Math.max(n, SMTP_MIN_DATA_TIMEOUT_MS), SMTP_MAX_DATA_TIMEOUT_MS);
  }

  return {
    host,
    port,
    secure,
    user,
    pass,
    from,
    allowInsecureAuth: /^(1|true|yes)$/i.test((env.SMTP_ALLOW_INSECURE_AUTH || '').trim()),
    allowSelfSigned: /^(1|true|yes)$/i.test((env.SMTP_ALLOW_SELF_SIGNED || '').trim()),
    timeoutMs: Number(env.SMTP_TIMEOUT_MS) > 0 ? Number(env.SMTP_TIMEOUT_MS) : SMTP_DEFAULT_TIMEOUT_MS,
    dataTimeoutMs,
    retries,
    heloName: rawHelo || defaultHeloName(from, hostname),
  };
}

/** One server reply: the code, and the lines that came with it. */
export interface SmtpReply {
  code: number;
  lines: string[];
}

/**
 * Parse a complete reply.
 *
 * A multi-line reply marks every line but the last with `-` after the code.
 * Returning null means "not complete yet" — the caller keeps reading. Treating
 * a partial reply as complete is how a client ends up sending its next command
 * into the middle of the previous answer.
 */
export function parseReply(buffer: string): SmtpReply | null {
  // A reply is complete only when its LAST LINE IS TERMINATED. Splitting on
  // CRLF and looking at the final element treated "250 OK" with no trailing
  // CRLF — a buffer cut mid-line by TCP — as a finished reply, so the client
  // could act on half a line and then read the rest as the next reply.
  if (!buffer.endsWith('\r\n')) return null;
  const lines = buffer.split('\r\n').filter((l) => l.length > 0);
  if (lines.length === 0) return null;
  const last = lines[lines.length - 1];
  // Final line: three digits, then a space or NOTHING — RFC 5321 §4.2 makes the
  // text optional, and a server answering "." with a bare `250` used to go
  // unheard: the client timed out and reported an accepted message as failed.
  // A hyphen after the code (`250-…`) means more is coming.
  if (!/^\d{3}(?: |$)/.test(last)) return null;
  const code = Number(last.slice(0, 3));
  return { code, lines: lines.map((l) => l.slice(4)) };
}

/** Does this EHLO response advertise the capability? */
export function advertises(reply: SmtpReply, keyword: string): boolean {
  const want = keyword.toUpperCase();
  return reply.lines.some((l) => l.trim().toUpperCase().split(/\s+/)[0] === want);
}

type Sock = net.Socket | tls.TLSSocket;

/**
 * A tiny protocol driver: send a line, wait for a complete reply.
 *
 * Owns the ACTIVE socket, which is the whole point. STARTTLS replaces the
 * connection mid-conversation, and the first version of this kept writing the
 * message body to the socket it was constructed with — so on port 587, the
 * default whenever SMTP_SECURE is unset, the DATA payload went to the plaintext
 * socket underneath the TLS session and the server never saw it. Every write
 * goes through here now, so there is one place that knows which socket is live.
 */
class Conversation {
  private buffer = '';
  private pending: { resolve: (r: SmtpReply) => void; reject: (e: Error) => void; timer: NodeJS.Timeout } | null = null;
  private closed: Error | null = null;

  /**
   * @param observe  optional transcript sink. It sees what `send` is TOLD to
   *                 show, which for AUTH is a redacted line — the credential is
   *                 never handed to it at all, so no observer can leak it.
   */
  constructor(private socket: Sock, private timeoutMs: number, private observe?: (line: string) => void) {
    this.attach(socket);
  }

  /** Report a reply to the observer, one line per line as the server sent it. */
  private show(reply: SmtpReply): SmtpReply {
    if (this.observe) {
      reply.lines.forEach((l, i) => {
        const sep = i < reply.lines.length - 1 ? '-' : (l ? ' ' : '');
        this.observe!(`S: ${reply.code}${sep}${l}`);
      });
    }
    return reply;
  }

  private settle(reply: SmtpReply | null, err: Error | null): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    clearTimeout(p.timer);
    if (err) p.reject(err);
    else p.resolve(reply!);
  }

  private attach(socket: Sock): void {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      const reply = parseReply(this.buffer);
      if (reply) {
        this.buffer = '';
        this.settle(reply, null);
      }
    });
    socket.on('error', (err: Error) => {
      this.closed = err;
      this.settle(null, err);
    });
    socket.on('close', () => {
      // A connection the SERVER dropped mid-conversation is worth another try:
      // it is how an overloaded server sheds load.
      const err = this.closed ?? new SmtpError('SMTP connection closed unexpectedly', 'connection', undefined, true);
      this.closed = err;
      this.settle(null, err);
    });
  }

  /**
   * Wait for the next complete reply.
   *
   * @param timeoutMs  how long; the per-reply timeout unless given. The reply
   *                   to the final "." passes its own, much longer one.
   */
  read(timeoutMs: number = this.timeoutMs): Promise<SmtpReply> {
    const already = parseReply(this.buffer);
    if (already) {
      this.buffer = '';
      return Promise.resolve(this.show(already));
    }
    if (this.closed) return Promise.reject(this.closed);
    return new Promise<SmtpReply>((resolve, reject) => {
      // One timer, cleared in exactly one place. The first version created the
      // timer and the resolver in two steps and reassigned both, which left a
      // handle running after a fast reply and kept the process alive.
      const timer = setTimeout(() => {
        this.pending = null;
        reject(new SmtpError(`SMTP server did not reply within ${timeoutMs}ms`, 'reply', undefined, true));
      }, timeoutMs);
      this.pending = { resolve: (r) => resolve(this.show(r)), reject, timer };
    });
  }

  /** Write raw bytes to the ACTIVE socket. Not observed: see smtpSend's DATA. */
  write(data: string): void {
    this.socket.write(data);
  }

  /**
   * Send a command and return the reply.
   *
   * @param shown  what the transcript sees instead of `line`. AUTH passes a
   *               redacted form here; everything else shows as sent.
   */
  async send(line: string, shown: string = line): Promise<SmtpReply> {
    this.observe?.(`C: ${shown}`);
    this.write(`${line}\r\n`);
    return this.read();
  }

  /** Replace the socket after STARTTLS upgrades it. */
  adopt(socket: Sock): void {
    this.socket = socket;
    this.buffer = '';
    this.closed = null;
    this.attach(socket);
  }

  /** Close whichever socket is live. */
  destroy(): void {
    this.socket.destroy();
  }
}

/**
 * A reply outside the 2xx/3xx range is a failure, and its text is the diagnosis.
 * 4xx is transient by the protocol's own definition; everything else is not.
 */
function expect(reply: SmtpReply, step: string): void {
  if (reply.code < 200 || reply.code >= 400) {
    throw new SmtpError(
      `SMTP ${step} failed: ${reply.code} ${reply.lines.join(' | ')}`.trim(),
      step,
      reply.code,
      reply.code >= 400 && reply.code < 500,
    );
  }
}

/**
 * The error for a wait after the final "." that ended without a reply.
 *
 * Says what happened in the operator's terms and what it means for the
 * customer — the message may well be in their inbox — and carries
 * `outcomeUnknown`, which keeps it from ever being retried.
 */
function lostAfterData(cause: unknown, dataTimeoutMs: number): SmtpError {
  const what = cause instanceof SmtpError && cause.step === 'reply'
    ? `no reply came within ${dataTimeoutMs}ms`
    : cause instanceof SmtpError && cause.step === 'connection'
      ? 'the connection closed before the server replied'
      : `the connection failed before the server replied (${cause instanceof Error ? cause.message : String(cause)})`;
  return new SmtpError(
    `SMTP outcome unknown: the whole message was sent, but ${what}. `
      + 'The server may have delivered it, so it was not sent again.',
    'message body',
    undefined,
    false,
    true,
  );
}

/**
 * A Message-ID for one message: unique, and on the sender's own domain.
 *
 * This client used to send NO Message-ID. RFC 5322 §3.6.4 says every message
 * SHOULD have one; spam filters score its absence, some receivers refuse the
 * message outright, and without it every multipart boundary was the same fixed
 * string. The right-hand side is the From address's domain — the convention,
 * and the one domain this sender demonstrably speaks for.
 */
export function newMessageId(from: string): string {
  // ASCII, like the HELO name: a Message-ID is a header, and an IDN in it is
  // one more thing for a strict receiver to reject.
  const domain = asciiDomain(envelopeAddress(from).split('@')[1] ?? '') || 'localhost';
  return `${Date.now().toString(36)}.${randomBytes(9).toString('hex')}@${domain}`;
}

/**
 * Replace every secret in `text` with asterisks.
 *
 * The AUTH token goes TO the server, and a broken or hostile server can echo it
 * back in its reply ("535 bad credentials: AGZvbw…") — which would carry it into
 * the error, the email log and the console. Nothing here can stop a server
 * saying it, so everything this client repeats of what a server said passes
 * through here first. Secrets shorter than four characters are not scrubbed: they
 * would mangle ordinary text, and are not secrets anyone relies on.
 */
function scrubber(secrets: Array<string | undefined>): (text: string) => string {
  const live = secrets.filter((x): x is string => typeof x === 'string' && x.length >= 4);
  if (live.length === 0) return (text) => text;
  return (text) => live.reduce((t, x) => t.split(x).join('********'), text);
}

/**
 * Send one message over one connection.
 *
 * Exported for the transport below and for an integration test; the pure parts
 * live in mime.ts so the vast majority of the behaviour needs no socket.
 *
 * Resolves with the server's final reply to the message body — the `250 …
 * queued as …` that is the only proof of acceptance a sender ever gets.
 *
 * Bounded in two phases. Before the final ".": every single wait by
 * `timeoutMs`, and the phase as a whole by 3 × `timeoutMs`, after which the
 * socket is destroyed — the first alone was not enough, as the STARTTLS
 * handshake had no timer at all and a server that said "220 go ahead" and then
 * nothing held a send open forever. After the ".": only the data timeout, and
 * nothing that ends that wait except a real reply is a retryable failure — see
 * "Nothing is retried once the final "." has gone" at the top of this file.
 */
export async function smtpSend(
  cfg: SmtpConfig,
  msg: EmailMessage,
  opts: Pick<SendOptions, 'onTranscript' | 'dataTimeoutMs'> & {
    /** One per message, reused if an attempt that never reached "." is retried. */
    messageId?: string;
  } = {},
): Promise<{ response: string }> {
  const to = envelopeAddress(msg.to);
  if (!isSendableAddress(to)) throw new Error('Refusing to send: the recipient is not a usable address');
  const from = envelopeAddress(cfg.from);
  const timeoutMs = cfg.timeoutMs ?? SMTP_DEFAULT_TIMEOUT_MS;
  // The configured wait for the reply to ".", which a caller may SHORTEN (the
  // scheduler's batches do) but never lengthen: the operator's setting is the
  // most any send waits there. A direct caller's nonsense (0, NaN) is the
  // default rather than "give up at once".
  const positive = (n: number | undefined) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined);
  const configuredDataMs = positive(cfg.dataTimeoutMs) ?? SMTP_DEFAULT_DATA_TIMEOUT_MS;
  const dataTimeoutMs = Math.min(positive(opts.dataTimeoutMs) ?? configuredDataMs, configuredDataMs, MAX_TIMER_MS);
  const heloName = cfg.heloName ?? defaultHeloName(cfg.from);
  const messageId = opts.messageId ?? newMessageId(cfg.from);

  const token = cfg.user && cfg.pass
    ? Buffer.from(`\0${cfg.user}\0${cfg.pass}`, 'utf8').toString('base64')
    : undefined;
  const scrub = scrubber([token, cfg.pass, cfg.pass && Buffer.from(cfg.pass, 'utf8').toString('base64')]);
  const observe = opts.onTranscript ? (line: string) => opts.onTranscript!(scrub(line)) : undefined;

  const verify = !cfg.allowSelfSigned;
  // SNI carries a HOST NAME. Node refuses an IP literal outright ("Setting the
  // TLS ServerName to an IP address is not permitted"), and an operator whose
  // SMTP_HOST is an internal relay's address — a normal thing to configure —
  // would get that as an unexplained send failure. Omit it there.
  //
  // The certificate is still checked against SMTP_HOST, address or name, unless
  // allowSelfSigned — because BOTH tls.connect calls below pass `host`, which is
  // what Node checks the certificate's names against when there is no
  // `servername`. The STARTTLS upgrade used to pass neither, and Node then
  // checked the certificate against "localhost": with SMTP_HOST=127.0.0.1 a
  // certificate for that address was refused and one for "localhost" accepted.
  const sni = isIpLiteral(cfg.host) ? undefined : cfg.host;
  const socket: Sock = cfg.secure
    ? tls.connect({ host: cfg.host, port: cfg.port, servername: sni, rejectUnauthorized: verify })
    : net.connect({ host: cfg.host, port: cfg.port });
  socket.setTimeout(timeoutMs);

  let encrypted = cfg.secure;
  const conv = new Conversation(socket, timeoutMs, observe);
  // The ceiling on the phase before "." — set up below, cleared the moment "."
  // is written.
  let ceilingTimer: NodeJS.Timeout | undefined;
  observe?.(`-- connecting to ${cfg.host}:${cfg.port} (${cfg.secure ? 'implicit TLS' : 'plain, STARTTLS if offered'}) --`);

  const talk = async (): Promise<{ response: string }> => {
    await new Promise<void>((resolve, reject) => {
      socket.once(cfg.secure ? 'secureConnect' : 'connect', () => resolve());
      socket.once('error', reject);
      socket.once('timeout', () => reject(
        new SmtpError(`SMTP connect to ${cfg.host}:${cfg.port} timed out`, 'connect', undefined, true),
      ));
    });

    expect(await conv.read(), 'greeting');

    // EHLO with a name, not HELO: the capability list is how we learn whether
    // STARTTLS and AUTH are available at all.
    let ehlo = await conv.send(`EHLO ${heloName}`);
    expect(ehlo, 'EHLO');

    if (!encrypted && advertises(ehlo, 'STARTTLS')) {
      expect(await conv.send('STARTTLS'), 'STARTTLS');
      const upgraded = await new Promise<tls.TLSSocket>((resolve, reject) => {
        // Its own timer. The replies have one each (Conversation.read) but the
        // handshake is not a reply, and it had none: a server that answered
        // "220 go ahead" and then stayed silent held the send open forever.
        const timer = setTimeout(() => {
          t.destroy();
          reject(new SmtpError(`SMTP TLS handshake did not complete within ${timeoutMs}ms`, 'STARTTLS', undefined, true));
        }, timeoutMs);
        const t = tls.connect(
          // `host` is for the identity check only — with `socket` given, Node
          // does not open a second connection. See `sni` above.
          { socket: socket as net.Socket, host: cfg.host, servername: sni, rejectUnauthorized: verify },
          () => { clearTimeout(timer); resolve(t); },
        );
        t.once('error', (e) => { clearTimeout(timer); reject(e); });
      });
      encrypted = true;
      conv.adopt(upgraded);
      observe?.(`-- TLS ${upgraded.getProtocol?.() ?? ''} established, certificate ${verify ? 'verified' : 'NOT verified (SMTP_ALLOW_SELF_SIGNED)'} --`);
      // The capability list must be re-read: a server is entitled to advertise
      // different capabilities (notably AUTH) only once the channel is secure,
      // and trusting the pre-TLS list is a downgrade waiting to happen.
      ehlo = await conv.send(`EHLO ${heloName}`);
      expect(ehlo, 'EHLO after STARTTLS');
    }

    if (token) {
      if (!encrypted && !cfg.allowInsecureAuth) {
        throw new Error(
          'Refusing to send credentials over an unencrypted connection. '
          + 'Use port 465 (SMTP_SECURE=1), a server offering STARTTLS, or set '
          + 'SMTP_ALLOW_INSECURE_AUTH=1 if this is a relay on localhost.',
        );
      }
      // AUTH PLAIN is one round trip and universally supported. The NUL-separated
      // form is the protocol's, not a choice. The token IS the password,
      // base64'd — so the transcript is shown a redacted line and never
      // receives the real one.
      const auth = await conv.send(`AUTH PLAIN ${token}`, 'AUTH PLAIN ********');
      if (auth.code !== 235) {
        // 4xx here is a server saying "not now"; 535 is "wrong credentials" and
        // retrying it is how an account gets locked. The server's text is
        // scrubbed on the way out (see the catch below) in case it echoes the
        // token it was sent.
        throw new SmtpError(
          `SMTP authentication failed: ${auth.code} ${auth.lines.join(' | ')}`,
          'AUTH',
          auth.code,
          auth.code >= 400 && auth.code < 500,
        );
      }
    }

    expect(await conv.send(`MAIL FROM:<${from}>`), 'MAIL FROM');
    expect(await conv.send(`RCPT TO:<${to}>`), 'RCPT TO');
    expect(await conv.send('DATA'), 'DATA');

    const mime = buildMimeMessage({
      from: cfg.from,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
      date: new Date().toUTCString(),
      messageId,
      // A first-class field, written by the builder as a real address header.
      replyTo: msg.replyTo,
      // List-Unsubscribe and friends (C-111). Sanitised inside buildMimeMessage,
      // so every transport that grows headers gets the same CRLF protection.
      headers: msg.headers,
    });
    if (observe) {
      // The headers are what an operator debugging delivery needs (From,
      // Reply-To, Message-ID). The body is summarised, never shown: a real
      // message is a password-reset link.
      const [head] = mime.split('\r\n\r\n', 1);
      for (const h of head.split('\r\n')) observe(`C:   ${h}`);
      observe(`C:   (body: ${Buffer.byteLength(mime) - Buffer.byteLength(head)} bytes, not shown)`);
      observe('C: .');
    }
    // stuffDots also normalises every line ending to CRLF. The lone `.` line is
    // the terminator and must be the only one.
    // Through the conversation, so it lands on whichever socket STARTTLS left
    // us with rather than the one we opened.
    conv.write(`${stuffDots(mime)}\r\n.\r\n`);
    // From here the server may have the message. The ceiling bounded the
    // conversation up to this point and must not cut this wait short — it was
    // what turned a server slow to answer "." into a retry and a second copy.
    clearTimeout(ceilingTimer);
    // A real reply — 250, or a 4xx/5xx that says the message was NOT taken — is
    // handled as always, by `expect`. Anything else that ends the wait (no reply
    // within the data timeout, a dropped or reset connection) says nothing about
    // whether the server kept the message, so it is an outcome UNKNOWN, and
    // never retried: the same message twice is the failure a customer sees.
    let accepted: SmtpReply;
    try {
      accepted = await conv.read(dataTimeoutMs);
    } catch (err) {
      throw lostAfterData(err, dataTimeoutMs);
    }
    expect(accepted, 'message body');

    // QUIT is said, NOT waited for. The message is accepted; nothing the
    // server says next can change that. Waiting for the reply used to sit
    // inside the attempt's time limit, so a server that accepted late and was
    // slow to say goodbye had the accepted message counted as a failure — and
    // retried, delivering it again.
    observe?.('C: QUIT');
    conv.write('QUIT\r\n');
    return { response: scrub(`${accepted.code} ${accepted.lines.join(' ')}`.trim()) };
  };

  // The attempt up to the final ".", bounded. Each wait inside has its own
  // timer, but a server answering every step just inside it could otherwise
  // hold an attempt for eleven of them. Cleared when "." is written: the wait
  // after it has its own bound (see talk).
  // Capped at the largest delay a Node timer honours; past it, setTimeout
  // fires after 1 ms and every send would fail at once.
  const ceilingMs = Math.min(timeoutMs * 3, MAX_TIMER_MS);
  const ceiling = new Promise<never>((_, reject) => {
    ceilingTimer = setTimeout(() => reject(
      new SmtpError(`SMTP attempt did not finish within ${ceilingMs}ms`, 'attempt', undefined, true),
    ), ceilingMs);
  });
  const work = talk();
  // Whichever loses the race still settles later; neither may become an
  // unhandled rejection.
  work.catch(() => {});
  ceiling.catch(() => {});
  try {
    return await Promise.race([work, ceiling]);
  } catch (err) {
    if (err instanceof Error) err.message = scrub(err.message);
    throw err;
  } finally {
    clearTimeout(ceilingTimer);
    // The conversation knows which socket is live; destroying the original
    // would leave the upgraded TLS socket open after STARTTLS.
    conv.destroy();
  }
}

/** Base delays before retry 1 and retry 2. */
export const SMTP_BACKOFF_MS = [2_000, 6_000] as const;

/**
 * How long to wait before retry `n` (1-based): ~2 s, then ~6 s, plus up to
 * 500 ms of jitter so two processes that failed together do not retry together.
 *
 * Short on purpose. Retries exist for a dropped connection or a server that
 * was briefly busy; they are NOT a way through a per-minute rate limit, which
 * a few seconds cannot outlast. Every caller on a request path sends detached
 * (`void sendEmail(…)`), so no response waits on this.
 */
export function smtpBackoffMs(n: number, random: () => number = Math.random): number {
  const base = SMTP_BACKOFF_MS[Math.min(Math.max(n, 1), SMTP_BACKOFF_MS.length) - 1];
  return base + Math.floor(random() * 500);
}

/**
 * An address as the log may show it: `i***@example.com`.
 *
 * Enough to tell which customer's mail failed when they write in, without the
 * log becoming a list of every address the site has mailed.
 */
export function maskAddress(address: string): string {
  const bare = envelopeAddress(address);
  const at = bare.lastIndexOf('@');
  if (at < 1) return '***';
  return `${bare[0]}***${bare.slice(at)}`;
}

/** Test seams: a backoff that does not really wait, and a fixed jitter. */
export interface SmtpTransportHooks {
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

/**
 * The transport, for `getEmailTransport`.
 *
 * What it logs, and nothing more — never a subject, a body or a credential:
 *   [email] smtp sent to=i***@example.com attempts=1: 250 2.0.0 Ok: queued as …
 *   [email] smtp attempt 1 of 3 failed to=i***@example.com: <reply> — retrying in 2012 ms
 *   [email] smtp failed to=i***@example.com attempts=3: <reply>
 *   [email] smtp outcome unknown to=i***@example.com attempts=1: SMTP outcome unknown: …
 * Exactly one `sent`, one `failed` or one `outcome unknown` line per message,
 * from here, so it is there whether or not the caller logs what it caught.
 */
export function smtpTransport(cfg: SmtpConfig, hooks: SmtpTransportHooks = {}): EmailTransport {
  const sleep = hooks.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  // NaN (a direct caller's arithmetic) must not become "retry forever".
  const configured = Number.isFinite(cfg.retries) ? Math.trunc(cfg.retries!) : SMTP_MAX_RETRIES;
  const retries = Math.min(Math.max(configured, 0), SMTP_MAX_RETRIES);
  return {
    name: 'smtp',
    async send(msg, opts) {
      // ONE Message-ID for the message, not one per attempt: it is one message,
      // however many connections it took to get it through.
      const messageId = newMessageId(cfg.from);
      const who = maskAddress(msg.to);
      for (let attempt = 1; ; attempt++) {
        try {
          const { response } = await smtpSend(cfg, msg, {
            onTranscript: opts?.onTranscript, messageId, dataTimeoutMs: opts?.dataTimeoutMs,
          });
          console.log(`[email] smtp sent to=${who} attempts=${attempt}: ${response}`);
          opts?.onResult?.({ response, attempts: attempt });
          return;
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          // The server may have the message: never retried, whatever the count,
          // and logged as what it is rather than as a failure.
          if (err instanceof SmtpError && err.outcomeUnknown) {
            console.error(`[email] smtp outcome unknown to=${who} attempts=${attempt}: ${reason}`);
            if (attempt > 1) err.message += ` (after ${attempt} attempts)`;
            throw err;
          }
          if (attempt > retries || !isTransientSmtpError(err)) {
            console.error(`[email] smtp failed to=${who} attempts=${attempt}: ${reason}`);
            // The count goes on the message the email log stores, so an
            // operator can tell "failed once" from "failed three times".
            if (attempt > 1 && err instanceof Error) err.message += ` (after ${attempt} attempts)`;
            throw err;
          }
          const wait = smtpBackoffMs(attempt, hooks.random);
          // Logged with the server's own reply; never with a credential —
          // smtpSend scrubs any a server echoes back.
          console.warn(`[email] smtp attempt ${attempt} of ${retries + 1} failed to=${who}: ${reason} — retrying in ${wait} ms`);
          opts?.onTranscript?.(`-- attempt ${attempt} failed (${reason}); retrying in ${wait} ms --`);
          await sleep(wait);
        }
      }
    },
  };
}
