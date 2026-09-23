/**
 * Building the bytes an SMTP server is handed.
 *
 * Separated from the socket so every rule below is testable without a mail
 * server — the same split `lib/backup/s3.ts` uses for request signing, and for
 * the same reason: these are the parts that fail silently and are impossible to
 * debug from the outside. A message that is subtly wrong does not error. It
 * arrives as mojibake, or truncated, or with headers the sender did not write.
 *
 * ## Everything here is non-ASCII by default
 *
 * This CMS runs Greek shops. A subject line reading "Η παραγγελία σας" is the
 * NORMAL case, not an edge case, and raw UTF-8 in a header is not legal mail:
 * headers are ASCII, so a non-ASCII subject has to be an RFC 2047 encoded-word
 * or it arrives as `Î— Ï€Î±Ï�Î±Î³Î³ÎµÎ»Î¯Î±`. Most hand-rolled SMTP senders get
 * this wrong because the author tested in English.
 *
 * ## The three ways a body gets corrupted
 *
 * 1. **Dot-stuffing.** A line consisting of a single `.` ENDS the DATA command.
 *    A body containing one is therefore truncated at that point, and everything
 *    after it is fed to the server as commands. Every line starting with a dot
 *    must have another prepended.
 * 2. **Line length.** SMTP allows 1000 octets per line including CRLF. A long
 *    paragraph — or one long base64 run — exceeds it and servers are entitled to
 *    reject or wrap it destructively. Base64 is emitted at 76 columns.
 * 3. **Bare newlines.** The protocol is CRLF. A lone LF terminates nothing and
 *    corrupts the framing.
 */

/** Values that reach a header are stripped of CR and LF. */
export function headerSafe(value: unknown): string {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
}

/** Does this string need encoding to survive an ASCII header? */
function needsEncoding(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[^\x20-\x7e]/.test(value);
}

/**
 * Encode a header value as RFC 2047 when it is not plain ASCII.
 *
 * Base64 rather than quoted-printable: a Greek subject is almost entirely
 * non-ASCII, and QP would escape nearly every character, producing a longer
 * string than the base64 of the same text.
 *
 * Chunked to keep each encoded-word under the 75-character limit the RFC sets.
 * Splitting is done on the BYTES of the UTF-8 form rather than on characters,
 * but at a character boundary — cutting a multi-byte sequence in half produces
 * a word that decodes to a replacement character.
 */
export function encodeHeaderValue(raw: unknown): string {
  const value = headerSafe(raw);
  if (!needsEncoding(value)) return value;

  // 75 total minus the `=?UTF-8?B?` prefix and `?=` suffix leaves 63 base64
  // characters, which encode 45 bytes (base64 is 4 chars per 3 bytes).
  const MAX_BYTES = 45;
  const words: string[] = [];
  let chunk = '';
  let chunkBytes = 0;

  for (const ch of value) {
    const size = Buffer.byteLength(ch, 'utf8');
    if (chunkBytes + size > MAX_BYTES) {
      words.push(`=?UTF-8?B?${Buffer.from(chunk, 'utf8').toString('base64')}?=`);
      chunk = '';
      chunkBytes = 0;
    }
    chunk += ch;
    chunkBytes += size;
  }
  if (chunk) words.push(`=?UTF-8?B?${Buffer.from(chunk, 'utf8').toString('base64')}?=`);

  // Folded with CRLF + space: continuation lines of one header, which is how a
  // multi-word encoded header is spelled.
  return words.join('\r\n ');
}

/** RFC 5322 `specials`: a display name containing one must be quoted. */
const PHRASE_SPECIALS = /[()<>[\]:;@\\,."]/;

/**
 * Encode an ADDRESS header value — `Name <addr@example.gr>` or a bare address.
 *
 * `encodeHeaderValue` is right for a Subject and wrong here, and the difference
 * was a real bug. Given `Οπτική Γωνία <shop@example.gr>` it produced ONE
 * encoded-word spanning the name AND the address. RFC 2047 forbids an
 * encoded-word inside an addr-spec, so a mail client has no address to show
 * and a submission server that checks From against the authenticated account —
 * which is exactly what a hosted "noreply" mailbox does — has nothing to match
 * and refuses the message. It never showed up because every test and example
 * used an ASCII name, and this CMS runs Greek shops.
 *
 * So only the display name is ever encoded; the angle-addr passes through as
 * written. An ASCII name with no specials comes out byte-for-byte as before,
 * which keeps every existing install's From header unchanged.
 */
export function encodeAddressHeader(raw: unknown): string {
  const value = headerSafe(raw);
  const m = value.match(/^(.*?)\s*<([^<>]+)>$/);
  // A bare address has no phrase to encode; non-ASCII local parts (SMTPUTF8)
  // are out of scope for a client that does not negotiate that extension.
  if (!m) return value;
  const name = m[1].trim().replace(/^"(.*)"$/, '$1');
  const addr = m[2].trim();
  if (!name) return `<${addr}>`;
  if (needsEncoding(name)) return `${encodeHeaderValue(name)} <${addr}>`;
  // `Smith, John <j@x>` unquoted is TWO mailboxes to a parser. Quote it.
  if (PHRASE_SPECIALS.test(name)) return `"${name.replace(/(["\\])/g, '\\$1')}" <${addr}>`;
  return `${name} <${addr}>`;
}

/**
 * Headers a caller may NOT supply through `headers`.
 *
 * These are the message's identity. A caller writing its own `From` is forging
 * the message; one writing `Reply-To` would produce a SECOND Reply-To beside
 * the first-class field, and which one a client honours is unspecified — so
 * the field is the only way to set it.
 */
const RESERVED_HEADERS = new Set([
  'from', 'to', 'subject', 'reply-to', 'mime-version', 'date', 'message-id',
  'content-type', 'content-transfer-encoding',
]);

/**
 * The extra headers a message may carry, cleaned — as `[name, value]` pairs.
 *
 * One implementation for every transport that forwards headers. The SMTP
 * builder writes them into the message; the SMTP2GO API takes them as
 * `custom_headers`. Two copies of these rules would be two chances for one
 * transport to let through the CRLF the other refuses.
 *
 * Both the NAME and the VALUE go through headerSafe: a CRLF in either one
 * splits the message and lets a caller inject arbitrary headers, or a body. The
 * name is additionally restricted to the token characters RFC 5322 allows,
 * because a name is not free text and a permissive check here would be the
 * whole guard.
 */
export function extraHeaderPairs(headers: Record<string, string> | undefined): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (!/^[A-Za-z][A-Za-z0-9-]{0,60}$/.test(name)) continue;
    if (RESERVED_HEADERS.has(name.toLowerCase())) continue;
    const safe = headerSafe(String(value)).slice(0, 500);
    if (safe) out.push([name, safe]);
  }
  return out;
}

/** Base64 at 76 columns, the width SMTP line limits make safe. */
function base64Lines(text: string): string {
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76));
  return lines.join('\r\n');
}

/**
 * Escape a body for the DATA command.
 *
 * Normalises every line ending to CRLF and doubles a leading dot. Without the
 * second, a body containing a line that is just "." truncates the message and
 * hands the remainder to the server as SMTP commands — which is both a
 * corruption bug and, with attacker-influenced content, a command-injection one.
 */
export function stuffDots(body: string): string {
  return body
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => (line.startsWith('.') ? `.${line}` : line))
    .join('\r\n');
}

export interface MimeInput {
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Injected rather than read, so the output is deterministic in a test. */
  date?: string;
  messageId?: string;
  /** Where a reply should go. Written as a real `Reply-To`, never via `headers`. */
  replyTo?: string;
  /** Extra headers — see `extraHeaderPairs`. */
  headers?: Record<string, string>;
}

/**
 * Build the full message, headers and body.
 *
 * Base64 for both parts rather than 8BITMIME: it is legal on every server,
 * needs no capability negotiation, and cannot be corrupted by a relay that
 * rewrites line endings. The cost is a third more bytes, which for a
 * transactional email is nothing.
 */
export function buildMimeMessage(input: MimeInput): string {
  // No leading dashes in the boundary VALUE: the delimiter is written as
  // `--<boundary>`, so a boundary that already starts with `--` produces
  // `----…` lines. Legal, and needlessly confusing to anyone reading a raw
  // message while debugging.
  const boundary = `=_ab_${(input.messageId ?? 'x').replace(/[^A-Za-z0-9]/g, '').slice(0, 24) || 'part'}`;
  const headers: string[] = [
    `From: ${encodeAddressHeader(input.from)}`,
    `To: ${encodeAddressHeader(input.to)}`,
    `Subject: ${encodeHeaderValue(input.subject)}`,
    'MIME-Version: 1.0',
  ];
  // Reply-To is an address header like From, and gets the same encoding: a
  // Greek display name must not swallow the address it names.
  if (input.replyTo && headerSafe(input.replyTo)) {
    headers.push(`Reply-To: ${encodeAddressHeader(input.replyTo)}`);
  }
  if (input.date) headers.push(`Date: ${headerSafe(input.date)}`);
  if (input.messageId) headers.push(`Message-ID: <${headerSafe(input.messageId)}>`);

  // Extra headers (C-111 — List-Unsubscribe and its one-click companion). The
  // cleaning rules live in extraHeaderPairs, shared with the SMTP2GO transport.
  for (const [name, safe] of extraHeaderPairs(input.headers)) {
    headers.push(`${name}: ${safe}`);
  }

  if (!input.html) {
    headers.push(
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
    );
    return `${headers.join('\r\n')}\r\n\r\n${base64Lines(input.text)}`;
  }

  headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
  const body = [
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(input.text),
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(input.html),
    `--${boundary}--`,
  ].join('\r\n');

  return `${headers.join('\r\n')}\r\n\r\n${body}`;
}

/**
 * The address for MAIL FROM / RCPT TO, without a display name.
 *
 * `Example Optics <shop@example.gr>` is a valid From HEADER and an invalid SMTP
 * envelope address. Sending the header form as the envelope is rejected by
 * strict servers and silently mangled by lenient ones.
 */
export function envelopeAddress(value: unknown): string {
  const raw = headerSafe(value);
  const angled = raw.match(/<([^>]+)>/);
  return (angled ? angled[1] : raw).trim();
}

/** Is this a plausible address to hand a server? Deliberately narrow. */
export function isSendableAddress(value: unknown): boolean {
  const addr = envelopeAddress(value);
  if (addr.length === 0 || addr.length > 254) return false;
  // No spaces, exactly one @, something either side, and a dot in the domain.
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(addr);
}
