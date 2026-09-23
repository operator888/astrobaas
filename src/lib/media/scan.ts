/**
 * Handing an upload to a virus scanner before it is stored (C-76).
 *
 * ## What was already true, and what was missing
 *
 * Uploads are already type-sniffed from magic bytes, re-encoded when they are
 * rasters, and SVGs are stored as their sanitized serialization. That defeats
 * the attacks that matter to THIS site: nothing uploaded can execute here.
 *
 * It does nothing for the other risk, which is that a shop's media library is a
 * place customers download from. A Word document carrying a macro, or a PDF
 * with an exploit, passes every check above intact — it is a perfectly valid
 * file, and it is dangerous on the reader's machine rather than on ours. That
 * is what a scanner is for, and it is why this cannot be replaced by more
 * sniffing.
 *
 * ## clamd, and nothing else
 *
 * ClamAV's daemon speaks a small, stable protocol over a TCP or UNIX socket.
 * An "any HTTP scanning endpoint" mode was considered and dropped: it would
 * mean posting every upload to an operator-typed URL, which is an SSRF surface
 * on a feature whose entire purpose is safety, and no two such services agree
 * on a response shape.
 *
 * ## Off by default, and FAIL CLOSED when on
 *
 * Enabling means running clamd, so it cannot be a default. But once an operator
 * has turned it on, a scanner that cannot be reached must refuse the upload:
 * "the scanner is down" and "the file is clean" are not the same answer, and a
 * feature that silently degrades to the second is worse than not having it —
 * the operator believes they are protected. `MEDIA_SCAN_FAIL=open` exists for
 * someone who has decided otherwise, and has to say so.
 */
import net from 'node:net';

export type ScanMode = 'off' | 'clamd';

export interface ScanConfig {
  mode: ScanMode;
  host: string;
  port: number;
  /** A UNIX socket path, which takes precedence over host/port when set. */
  socket: string;
  timeoutMs: number;
  /** `true` (the default) refuses an upload the scanner could not judge. */
  failClosed: boolean;
  /** Do not stream more than this to the scanner. clamd's own default is 25 MB. */
  maxBytes: number;
}

function num(raw: unknown, fallback: number): number {
  const n = Number(String(raw ?? '').trim());
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function scanConfig(env: NodeJS.ProcessEnv = process.env): ScanConfig {
  const raw = String(env.MEDIA_SCAN ?? '').trim().toLowerCase();
  const mode: ScanMode = raw === 'clamd' || raw === 'clamav' || raw === '1' || raw === 'on' ? 'clamd' : 'off';
  return {
    mode,
    host: String(env.MEDIA_SCAN_HOST ?? '127.0.0.1').trim(),
    port: num(env.MEDIA_SCAN_PORT, 3310),
    socket: String(env.MEDIA_SCAN_SOCKET ?? '').trim(),
    timeoutMs: num(env.MEDIA_SCAN_TIMEOUT_MS, 10_000),
    // Only the exact word turns it off. A typo must not silently disable the
    // refusal — that is the whole failure this setting guards against.
    failClosed: String(env.MEDIA_SCAN_FAIL ?? '').trim().toLowerCase() !== 'open',
    maxBytes: num(env.MEDIA_SCAN_MAX_BYTES, 25 * 1024 * 1024),
  };
}

export type ScanVerdict =
  | { verdict: 'skipped' }
  | { verdict: 'clean' }
  | { verdict: 'infected'; signature: string }
  | { verdict: 'error'; detail: string };

/**
 * Read clamd's one-line answer.
 *
 * The three shapes it can take, and what each means:
 *   `stream: OK`                     — clean
 *   `stream: Eicar-Test-Signature FOUND` — infected, and the name matters
 *   `... ERROR`                      — clamd itself failed (size limit, no db)
 *
 * Anything else is treated as an error rather than guessed at. A scanner whose
 * answer we do not understand has not said the file is clean.
 */
export function readClamReply(reply: string): ScanVerdict {
  const line = String(reply ?? '').replace(/\0/g, '').trim();
  if (!line) return { verdict: 'error', detail: 'empty reply' };
  if (/\bFOUND\b/.test(line)) {
    const m = /:\s*(.+?)\s+FOUND\b/.exec(line);
    return { verdict: 'infected', signature: m ? m[1] : 'unknown' };
  }
  if (/\bOK\b/.test(line)) return { verdict: 'clean' };
  return { verdict: 'error', detail: line.slice(0, 200) };
}

/**
 * Frame a buffer for clamd's INSTREAM command.
 *
 * `zINSTREAM\0`, then each chunk as a 4-byte big-endian length followed by the
 * bytes, then a zero length to end. Pure, so the wire format is testable
 * without a daemon — which matters because getting it subtly wrong produces a
 * scanner that answers OK to everything.
 */
export function instreamFrames(buf: Buffer, chunkSize = 64 * 1024): Buffer {
  const parts: Buffer[] = [Buffer.from('zINSTREAM\0', 'ascii')];
  for (let i = 0; i < buf.length; i += chunkSize) {
    const chunk = buf.subarray(i, Math.min(i + chunkSize, buf.length));
    const len = Buffer.alloc(4);
    len.writeUInt32BE(chunk.length, 0);
    parts.push(len, chunk);
  }
  parts.push(Buffer.alloc(4)); // a zero length ends the stream
  return Buffer.concat(parts);
}

/** Injected so the whole path is testable without a daemon. */
export interface ScanDeps {
  connect?: (cfg: ScanConfig) => net.Socket;
}

export async function scanBuffer(
  buf: Buffer,
  cfg: ScanConfig = scanConfig(),
  deps: ScanDeps = {},
): Promise<ScanVerdict> {
  if (cfg.mode === 'off') return { verdict: 'skipped' };
  if (buf.byteLength > cfg.maxBytes) {
    // Not silently skipped: an operator who scans uploads has not agreed that
    // files over 25 MB go unscanned. The caller applies the fail policy.
    return { verdict: 'error', detail: `file is larger than MEDIA_SCAN_MAX_BYTES (${cfg.maxBytes})` };
  }

  return new Promise<ScanVerdict>((resolve) => {
    let settled = false;
    let socket: net.Socket | undefined;
    const done = (v: ScanVerdict) => {
      if (settled) return;
      settled = true;
      try { socket?.destroy(); } catch { /* already gone */ }
      resolve(v);
    };

    // `net.connect` throws SYNCHRONOUSLY for a port outside 1-65535 or a
    // non-integer one — `ERR_SOCKET_BAD_PORT`. Thrown from inside this
    // executor, the promise REJECTS, so `refuseIfInfected` never runs its
    // switch and the fail-closed policy is skipped entirely: the upload is
    // still refused, but by a generic 500 rather than by the one decision point
    // this module exists to have. Resolved as an error verdict instead, so
    // every failure leaves through the same door.
    try {
      socket = deps.connect
        ? deps.connect(cfg)
        : (cfg.socket ? net.connect(cfg.socket) : net.connect(cfg.port, cfg.host));
    } catch (err) {
      resolve({ verdict: 'error', detail: err instanceof Error ? err.message : String(err) });
      return;
    }

    let reply = '';
    socket.setTimeout(cfg.timeoutMs);
    socket.on('timeout', () => done({ verdict: 'error', detail: 'the scanner did not answer in time' }));
    socket.on('error', (err: Error) => done({ verdict: 'error', detail: err.message }));
    socket.on('data', (d: Buffer) => {
      reply += d.toString('utf8');
      // clamd terminates its answer with a NUL in the `z` dialect.
      if (reply.includes('\0') || reply.includes('\n')) done(readClamReply(reply));
    });
    socket.on('close', () => done(reply ? readClamReply(reply) : { verdict: 'error', detail: 'the scanner closed without answering' }));
    socket.on('connect', () => { socket.write(instreamFrames(buf)); });
  });
}

/**
 * The one decision every upload door asks: may this file be stored?
 *
 * Returns `null` to proceed, or the refusal to show. Both doors — the media
 * library and a public form's file field — call THIS rather than reading the
 * verdict themselves, because "what do we do when the scanner is unreachable"
 * is exactly the rule that gets answered differently in two places.
 */
export async function refuseIfInfected(
  buf: Buffer,
  cfg: ScanConfig = scanConfig(),
  deps: ScanDeps = {},
): Promise<string | null> {
  const result = await scanBuffer(buf, cfg, deps);
  switch (result.verdict) {
    case 'skipped':
    case 'clean':
      return null;
    case 'infected':
      // The signature is named. An operator whose colleague's laptop is
      // infected needs to know that, not "upload failed".
      return `That file was refused by the virus scanner (${result.signature}).`;
    case 'error':
      if (!cfg.failClosed) {
        console.error('Media scan unavailable, allowing upload (MEDIA_SCAN_FAIL=open):', result.detail);
        return null;
      }
      console.error('Media scan unavailable, refusing upload:', result.detail);
      return 'The virus scanner could not check that file, so it was not stored. Try again shortly.';
  }
}
