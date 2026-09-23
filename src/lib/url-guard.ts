/**
 * Outbound-URL guard (SSRF defence) for operator-registered webhook targets.
 *
 * Even though only admins can register webhooks, letting the server POST to
 * arbitrary URLs turns it into an internal port-scanner / metadata-service
 * client (169.254.169.254, localhost admin panels, RFC-1918 ranges) — and the
 * delivery log would even report status codes back. So by default we refuse
 * targets that resolve to obviously-internal hosts by NAME/LITERAL.
 *
 * Scope & honesty: this checks the URL as written (scheme, hostname literal,
 * well-known internal names). It does NOT resolve DNS, so a public name that
 * resolves to a private IP (DNS rebinding) is out of scope here — noted in
 * SECURITY.md. Local development and tests can allow private targets with
 * WEBHOOK_ALLOW_PRIVATE=1.
 */

const truthy = (v: string | undefined) => v === '1' || v === 'true';

/** Hostname (no brackets, lowercase) → is it a private/loopback/link-local target? */
export function isPrivateHostname(hostRaw: string): boolean {
  const host = hostRaw.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;

  // Well-known internal names.
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')) return true;
  if (host === 'metadata.google.internal') return true;

  // IPv6 literals.
  if (host.includes(':')) {
    if (host === '::' || host === '::1') return true;
    if (host.startsWith('fe8') || host.startsWith('fe9') || host.startsWith('fea') || host.startsWith('feb')) return true; // fe80::/10
    if (host.startsWith('fc') || host.startsWith('fd')) return true; // fc00::/7 (ULA)
    // IPv4-mapped (::ffff:a.b.c.d) → recurse on the v4 part.
    const v4 = host.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (v4) return isPrivateHostname(v4[1]);
    return false;
  }

  // IPv4 literals (incl. shorthand like 127.1 are rejected as non-standard → not matched here;
  // the URL parser normalizes real IPs to dotted-quad form before we see them).
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
    return false;
  }

  return false; // public-looking name
}

export interface UrlGuardResult {
  ok: boolean;
  reason?: string;
}

/**
 * Is `raw` an acceptable outbound webhook target? http(s) only; private/internal
 * hosts are refused unless WEBHOOK_ALLOW_PRIVATE=1 (dev/test convenience).
 */
export function checkWebhookUrl(raw: string, env: NodeJS.ProcessEnv = process.env): UrlGuardResult {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: 'not a valid URL' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, reason: 'only http(s) URLs are allowed' };
  }
  if (u.username || u.password) {
    return { ok: false, reason: 'credentials in the URL are not allowed' };
  }
  if (!truthy(env.WEBHOOK_ALLOW_PRIVATE) && isPrivateHostname(u.hostname)) {
    return {
      ok: false,
      reason: 'private/internal hosts are not allowed as webhook targets (set WEBHOOK_ALLOW_PRIVATE=1 to override, e.g. in local dev)',
    };
  }
  return { ok: true };
}
