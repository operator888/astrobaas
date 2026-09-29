/**
 * The order this tab just placed, for the confirmation page — and starting its
 * payment, which both checkout and "Pay now" on that page do.
 *
 * sessionStorage, not the URL: the buyer's email must not end up in a query
 * string, where it is copied into server logs and Referer headers.
 */
import { cms } from './shop-api';

export const LAST_ORDER_KEY = 'astrobaas-last-order';

export interface LastOrder {
  number: string;
  total_cents: number;
  currency: string;
  method: string;
  instructions: string;
  online: boolean;
  provider?: string;
  email?: string;
}

export function readLastOrder(): LastOrder | null {
  try {
    const v = JSON.parse(sessionStorage.getItem(LAST_ORDER_KEY) ?? 'null');
    return v && typeof v.number === 'string' ? v : null;
  } catch {
    return null;
  }
}

/**
 * The provider's payment page for this order. Only ever an https address — the
 * CMS builds it from the provider's answer, and a storefront that followed any
 * other scheme there would be one redirect away from `javascript:`.
 */
export async function startPayment(orderNumber: string, email: string, provider: string): Promise<string> {
  const pay = await cms.request<{ redirect_url: string }>('POST', '/api/payments/start', {
    order_number: orderNumber, email, provider,
  });
  if (typeof pay?.redirect_url !== 'string' || !/^https:\/\//.test(pay.redirect_url)) {
    throw new Error('The payment page address was not secure.');
  }
  return pay.redirect_url;
}
