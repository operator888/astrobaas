/**
 * The smallest S3 client that can hold a backup.
 *
 * ## Why this is hand-written
 *
 * `@aws-sdk/client-s3` is roughly seventy packages. This CMS has eleven
 * dependencies in total, on purpose: every one of them is something an
 * operator has to trust, patch and audit on a machine they own. What is
 * actually needed here is PUT, LIST and DELETE against one bucket, and AWS
 * Signature V4 is a published, fully specified algorithm that node:crypto can
 * do in eighty lines.
 *
 * ## Why it is testable
 *
 * Signing is the classic "looks right, returns 403" problem: every step is
 * plausible and the failure gives you no clue which one was wrong. AWS's own
 * docs publish a fully worked GET-Object example — canonical request, string
 * to sign, and the final signature — for service s3, and
 * `tests/s3-signing.test.mjs` pins that published signature as a hard constant.
 * A signature that matches it is correct against AWS, not merely
 * self-consistent, which is the difference that matters.
 *
 * S3-compatible endpoints (Backblaze B2, Cloudflare R2, MinIO, Hetzner,
 * Wasabi, DigitalOcean Spaces) all speak this. Nothing here is AWS-specific
 * beyond the algorithm's name.
 */
import crypto from 'node:crypto';

const ALGORITHM = 'AWS4-HMAC-SHA256';
const SERVICE = 's3';

export interface S3Config {
  /** Full origin, e.g. https://s3.eu-central-1.amazonaws.com or a MinIO host. */
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /**
   * Path-style (`/bucket/key`) rather than virtual-host (`bucket.host/key`).
   * MinIO and most self-hosted gateways need this; AWS accepts both.
   */
  forcePathStyle?: boolean;
}

/*
 * NOT `crypto.BinaryLike`, which is what this said until @types/node 26.
 *
 * BinaryLike is `string | ArrayBufferLike | NodeJS.ArrayBufferView`, and
 * `Hash.update()` takes `string | NodeJS.ArrayBufferView` — it has never
 * accepted a bare ArrayBuffer. Measured: `createHash('sha256').update(new
 * ArrayBuffer(4))` throws ERR_INVALID_ARG_TYPE at runtime. So the old
 * annotation was not a harmless widening, it was a claim this function could
 * do something that would have thrown. The types caught up; the code was
 * always narrower.
 *
 * The parameter below is character-for-character `Hash.update`'s own, so it
 * cannot reject anything update() would take. Both call sites pass a string or
 * a Buffer, and `send()` types its body as `Buffer | null`, so no ArrayBuffer
 * was ever reachable here.
 *
 * `hmac` on the next line is deliberately left alone: `createHmac(alg, key)`
 * takes KeyLike, which still admits the full union, and its data is already
 * a string. The asymmetry is real, not an oversight.
 */
const sha256Hex = (data: string | NodeJS.ArrayBufferView): string =>
  crypto.createHash('sha256').update(data).digest('hex');

const hmac = (key: crypto.BinaryLike, data: string): Buffer =>
  crypto.createHmac('sha256', key).update(data, 'utf8').digest();

/**
 * Percent-encode for a canonical URI.
 *
 * NOT `encodeURIComponent`: it leaves `!'()*` alone, which SigV4 requires to be
 * encoded, and a key containing any of them signs correctly and then 403s. The
 * unreserved set is exactly A-Z a-z 0-9 - _ . ~ — everything else is encoded,
 * uppercase hex.
 */
export function uriEncode(value: string, encodeSlash = true): string {
  let out = '';
  for (const ch of Buffer.from(value, 'utf8')) {
    const c = String.fromCharCode(ch);
    if ((ch >= 0x41 && ch <= 0x5a) || (ch >= 0x61 && ch <= 0x7a)
      || (ch >= 0x30 && ch <= 0x39) || c === '-' || c === '_' || c === '.' || c === '~') {
      out += c;
    } else if (c === '/') {
      out += encodeSlash ? '%2F' : '/';
    } else {
      out += `%${ch.toString(16).toUpperCase().padStart(2, '0')}`;
    }
  }
  return out;
}

/** `20260829T120000Z` and `20260829`, the two forms the algorithm needs. */
export function amzDates(now: Date): { amzDate: string; dateStamp: string } {
  const amzDate = `${now.toISOString().replace(/[:-]|\.\d{3}/g, '')}`;
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

export interface SignInput {
  method: string;
  /**
   * The canonical URI: path WITHOUT the query, bucket included for path-style,
   * and ALREADY percent-encoded (objectUrl does this). signRequest does not
   * re-encode it — doing so double-encodes every special character.
   */
  path: string;
  /** Sorted `k=v` pairs, already encoded. Empty string for none. */
  query?: string;
  headers: Record<string, string>;
  /** Hex sha256 of the body. `UNSIGNED-PAYLOAD` is not used here. */
  payloadHash: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  now: Date;
}

/**
 * The `Authorization` header value for one request.
 *
 * Exported and pure so the published AWS test vectors can be run against it
 * directly — the only way to know signing is right without a bucket.
 */
export function signRequest(input: SignInput): { authorization: string; canonicalRequest: string; stringToSign: string } {
  const { amzDate, dateStamp } = amzDates(input.now);

  // Canonical headers: lower-cased names, trimmed values, sorted, one per line.
  const entries = Object.entries(input.headers)
    .map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const canonicalHeaders = entries.map(([k, v]) => `${k}:${v}\n`).join('');
  const signedHeaders = entries.map(([k]) => k).join(';');

  const canonicalRequest = [
    input.method,
    // The path is ALREADY percent-encoded by objectUrl() — encoding it again
    // here turned %27 into %2527, so the string SIGNED no longer matched the
    // URL SENT and every key with a special character 403'd. The canonical URI
    // is the encoded path verbatim.
    input.path,
    input.query ?? '',
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${input.region}/${SERVICE}/aws4_request`;
  const stringToSign = [
    ALGORITHM,
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = hmac(`AWS4${input.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, SERVICE);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  return {
    authorization: `${ALGORITHM} Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    canonicalRequest,
    stringToSign,
  };
}

/** Where one object lives, as origin + path. */
export function objectUrl(cfg: S3Config, key: string): { origin: string; path: string; host: string } {
  const base = new URL(cfg.endpoint);
  const encodedKey = key.split('/').map((s) => uriEncode(s)).join('/');
  if (cfg.forcePathStyle) {
    return { origin: base.origin, path: `/${cfg.bucket}/${encodedKey}`, host: base.host };
  }
  const host = `${cfg.bucket}.${base.host}`;
  return { origin: `${base.protocol}//${host}`, path: `/${encodedKey}`, host };
}

export interface S3Result {
  ok: boolean;
  status: number;
  /** The provider's message when it refused. S3 answers in XML. */
  error?: string;
  body?: string;
}

/**
 * One signed request.
 *
 * The body is hashed in full rather than sent as `UNSIGNED-PAYLOAD`: a backup
 * is the thing you reach for when everything else has gone wrong, and a signed
 * hash is the difference between "the upload succeeded" and "the bytes that
 * arrived are the bytes I sent".
 */
async function send(
  cfg: S3Config,
  method: string,
  key: string,
  body: Buffer | null,
  extraHeaders: Record<string, string> = {},
  query = '',
  doFetch: typeof fetch = fetch,
  now: Date = new Date(),
): Promise<S3Result> {
  const { origin, path, host } = objectUrl(cfg, key);
  const payload = body ?? Buffer.alloc(0);
  const payloadHash = sha256Hex(payload);
  const { amzDate } = amzDates(now);

  const headers: Record<string, string> = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    ...extraHeaders,
  };

  const { authorization } = signRequest({
    method, path, query, headers, payloadHash,
    region: cfg.region,
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    now,
  });

  const res = await doFetch(`${origin}${path}${query ? `?${query}` : ''}`, {
    method,
    headers: { ...headers, Authorization: authorization },
    ...(body ? { body: new Uint8Array(body) } : {}),
  });

  const text = res.ok ? await res.text().catch(() => '') : await res.text().catch(() => '');
  if (!res.ok) {
    // S3 answers with an XML <Message>. Surfacing it verbatim is the
    // difference between a fixable "SignatureDoesNotMatch" and a useless 403.
    const message = /<Message>([\s\S]*?)<\/Message>/.exec(text)?.[1] ?? text.slice(0, 200);
    return { ok: false, status: res.status, error: message || `HTTP ${res.status}` };
  }
  return { ok: true, status: res.status, body: text };
}

export const s3 = {
  put: (cfg: S3Config, key: string, body: Buffer, contentType: string, doFetch?: typeof fetch, now?: Date) =>
    send(cfg, 'PUT', key, body, { 'content-type': contentType, 'content-length': String(body.byteLength) }, '', doFetch, now),

  delete: (cfg: S3Config, key: string, doFetch?: typeof fetch, now?: Date) =>
    send(cfg, 'DELETE', key, null, {}, '', doFetch, now),

  /**
   * List keys under a prefix.
   *
   * ListObjectsV2 against the bucket root, so the "key" is empty and the
   * prefix rides in the query. Returns keys only — a backup rotation needs
   * names and nothing else.
   */
  async list(cfg: S3Config, prefix: string, doFetch?: typeof fetch, now?: Date): Promise<{ ok: boolean; keys: string[]; error?: string }> {
    const query = `list-type=2&prefix=${uriEncode(prefix)}`;
    const res = await send(cfg, 'GET', '', null, {}, query, doFetch, now);
    if (!res.ok) return { ok: false, keys: [], error: res.error };
    const keys = [...(res.body ?? '').matchAll(/<Key>([\s\S]*?)<\/Key>/g)].map((m) => m[1]);
    return { ok: true, keys };
  },
};
