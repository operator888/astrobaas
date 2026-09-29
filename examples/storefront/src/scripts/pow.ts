/**
 * The CMS's optional anti-spam check on checkout (Settings → Anti-spam check →
 * Checkout). Off by default; when it is off the CMS says so and nothing is
 * sent. When it is on, the browser proves a little work before placing an
 * order — see INTEGRATION.md, "Checkout from a storefront".
 */
import type { AstroBaasClient } from 'astrobaas/client';

export async function powToken(cms: AstroBaasClient, surface: 'checkout' | 'magic-link'): Promise<string | undefined> {
  let data: { enabled?: boolean; token?: string; bits?: number } | null = null;
  try {
    data = await cms.request('GET', `/api/captcha/challenge?surface=${surface}`);
  } catch {
    return undefined; // an older CMS, or the check is unavailable: let the order speak for itself
  }
  if (!data?.enabled || typeof data.token !== 'string' || typeof data.bits !== 'number') return undefined;
  const enc = new TextEncoder();
  // Bounded, so a misconfigured difficulty cannot freeze the tab forever.
  for (let n = 0; n < 50_000_000; n++) {
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(`${data.token}.${n}`)));
    let bits = data.bits;
    let ok = true;
    for (let i = 0; bits > 0; i++, bits -= 8) {
      if (d[i] >>> (8 - Math.min(8, bits)) !== 0) { ok = false; break; }
    }
    if (ok) return `${data.token}::${n}`;
  }
  return undefined;
}
