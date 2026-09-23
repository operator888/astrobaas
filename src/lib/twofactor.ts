/**
 * Two-factor recovery (backup) codes + the account-level 2FA challenge helper.
 *
 * Backup codes let a user who has lost their authenticator device still sign in.
 * They are single-use, stored only as SHA-256 hashes (never plaintext), and
 * shown to the user exactly once at enrollment.
 */
import crypto from 'node:crypto';
import { verifyTotp } from './totp';
import type { TwoFactor } from '../core/models';

/** Normalize a backup code for hashing: strip hyphens/space, lowercase. */
function normalize(code: string): string {
  return (code || '').replace(/[\s-]/g, '').toLowerCase();
}

export function hashBackupCode(code: string): string {
  return crypto.createHash('sha256').update(normalize(code)).digest('hex');
}

/** Generate `n` recovery codes; return the plaintext (show once) + hashes (store). */
export function generateBackupCodes(n = 10): { plain: string[]; hashed: string[] } {
  const plain: string[] = [];
  const hashed: string[] = [];
  for (let i = 0; i < n; i++) {
    const raw = crypto.randomBytes(5).toString('hex'); // 10 hex chars
    const code = `${raw.slice(0, 5)}-${raw.slice(5)}`;
    plain.push(code);
    hashed.push(hashBackupCode(code));
  }
  return { plain, hashed };
}

/** Index of the matching hash for `code`, or -1. Constant-time per candidate. */
export function matchBackupCode(code: string, hashed: string[]): number {
  if (!code) return -1;
  const h = Buffer.from(hashBackupCode(code));
  for (let i = 0; i < hashed.length; i++) {
    const cand = Buffer.from(hashed[i]);
    if (cand.length === h.length && crypto.timingSafeEqual(cand, h)) return i;
  }
  return -1;
}

/**
 * Result of checking a second factor at login. `consumedBackupIndex >= 0` means
 * a recovery code was used and the caller MUST remove it from the stored list.
 */
export interface TwoFactorCheck {
  ok: boolean;
  consumedBackupIndex: number;
}

/**
 * Verify a login-time second factor against a user's 2FA config: accept either a
 * valid TOTP code or an unused backup code. Pure — the caller persists the
 * backup-code consumption.
 */
export function checkSecondFactor(tf: TwoFactor | undefined | null, code: string): TwoFactorCheck {
  if (!tf || !tf.enabled) return { ok: true, consumedBackupIndex: -1 }; // 2FA not on → nothing to check
  const trimmed = (code || '').trim();
  if (!trimmed) return { ok: false, consumedBackupIndex: -1 };
  if (verifyTotp(tf.secret, trimmed)) return { ok: true, consumedBackupIndex: -1 };
  const idx = matchBackupCode(trimmed, tf.backup_codes ?? []);
  if (idx >= 0) return { ok: true, consumedBackupIndex: idx };
  return { ok: false, consumedBackupIndex: -1 };
}
