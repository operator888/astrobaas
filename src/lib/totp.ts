/**
 * RFC 6238 TOTP / RFC 4226 HOTP — dependency-free (node:crypto only).
 *
 * Used for optional two-factor auth on admin accounts. Default parameters match
 * what every authenticator app (Google Authenticator, 1Password, Aegis, …)
 * expects: HMAC-SHA1, 6 digits, 30-second step. Verified against the RFC 6238
 * Appendix B test vectors in tests/totp.test.mjs.
 */
import crypto from 'node:crypto';

// RFC 4648 base32 alphabet (no padding on output; padding tolerated on input).
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/=+$/, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of clean) {
    const idx = B32.indexOf(c);
    if (idx === -1) continue; // ignore spaces/hyphens/invalid chars
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A fresh base32 secret (default 20 bytes = 160 bits, the RFC-recommended size). */
export function generateTotpSecret(bytes = 20): string {
  return base32Encode(crypto.randomBytes(bytes));
}

/** RFC 4226 HOTP for a raw key + counter. Exported for RFC test vectors. */
export function hotp(key: Buffer, counter: number, digits = 6): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return (bin % 10 ** digits).toString().padStart(digits, '0');
}

export interface TotpOptions {
  t?: number; // ms epoch (default now)
  step?: number; // seconds per window (default 30)
  digits?: number; // code length (default 6)
}

/** Current TOTP code for a base32 secret. */
export function totp(secretBase32: string, opts: TotpOptions = {}): string {
  const t = opts.t ?? Date.now();
  const step = opts.step ?? 30;
  const counter = Math.floor(t / 1000 / step);
  return hotp(base32Decode(secretBase32), counter, opts.digits ?? 6);
}

/**
 * Verify a user-supplied code against a secret, tolerating ±`window` steps of
 * clock skew (default ±1 = ±30s). Constant-time per-candidate comparison.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  opts: TotpOptions & { window?: number } = {},
): boolean {
  const target = (code || '').trim();
  const digits = opts.digits ?? 6;
  if (!new RegExp(`^\\d{${digits}}$`).test(target)) return false;
  const t = opts.t ?? Date.now();
  const step = opts.step ?? 30;
  const window = opts.window ?? 1;
  const key = base32Decode(secretBase32);
  const counter = Math.floor(t / 1000 / step);
  const targetBuf = Buffer.from(target);
  for (let w = -window; w <= window; w++) {
    const candidate = Buffer.from(hotp(key, counter + w, digits));
    if (candidate.length === targetBuf.length && crypto.timingSafeEqual(candidate, targetBuf)) {
      return true;
    }
  }
  return false;
}

/** otpauth:// URI for authenticator-app QR codes / manual entry. */
export function otpauthUri(secretBase32: string, opts: { label: string; issuer: string }): string {
  const issuer = encodeURIComponent(opts.issuer);
  const label = encodeURIComponent(opts.label);
  return `otpauth://totp/${issuer}:${label}?secret=${secretBase32}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
}
