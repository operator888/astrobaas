/**
 * The browser's side of the CMS: pricing a basket, placing an order, starting
 * a payment. Everything else on this site was fetched at build time.
 *
 * The typed client, without credentials. Nothing here needs a key or a session:
 * checkout is public in the CMS, and it prices every basket itself from ids and
 * quantities. The CMS must list this site's origin in CORS_ORIGINS.
 */
import { createClient, AstroBaasError } from 'astrobaas/client';
import type { CartLine } from '../lib/cart';

export const cms = createClient(String(import.meta.env.PUBLIC_CMS_URL).replace(/\/+$/, ''), {
  timeoutMs: 20_000,
  retries: 2,
});

export interface QuoteLine {
  product_id: string;
  variant_id?: string;
  name: string;
  qty: number;
  unit_price_cents: number;
  line_subtotal_cents: number;
}

export interface Quote {
  subtotal_cents: number;
  discount_cents: number;
  shipping_cents: number;
  tax_cents: number;
  total_cents: number;
  currency: string;
  prices_include_tax: boolean;
  requires_shipping: boolean;
  lines: QuoteLine[];
  available_shipping_methods: { id: string; name: string; description?: string; cost_cents: number }[];
  selected_shipping_method: { id: string } | null;
  coupon: { ok: boolean; code?: string; message?: string } | null;
}

export interface PaymentMethod {
  id: string;
  label: string;
  kind: 'provider' | 'manual';
  /** What a buyer must do to pay, keyed by language: `{ en: "IBAN …" }`. */
  instructions?: Record<string, string>;
}

/** The instructions in the page's language, or the first there is. */
export function instructionsFor(m: PaymentMethod, lang = 'en'): string {
  const i = m.instructions ?? {};
  return i[lang] ?? Object.values(i)[0] ?? '';
}

export function quote(items: CartLine[], extra: Record<string, unknown> = {}): Promise<Quote> {
  return cms.orders.quote({ items, ...extra }) as Promise<Quote>;
}

export async function paymentMethods(): Promise<PaymentMethod[]> {
  const data = await cms.request<PaymentMethod[]>('GET', '/api/payments');
  return Array.isArray(data) ? data : [];
}

/** What to show a shopper when a call fails — the CMS's own sentence if it sent one. */
export function problem(err: unknown): string {
  if (err instanceof AstroBaasError) {
    if (err.status === 0 || err.status === undefined) return 'The shop could not be reached. Check your connection and try again.';
    return err.message || `The shop answered ${err.status}.`;
  }
  return 'The shop could not be reached. Check your connection and try again.';
}

export { AstroBaasError };
