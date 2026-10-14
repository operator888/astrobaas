/**
 * Import from Lexware Office (formerly lexoffice) through its public API.
 *
 * The API key is used for this run and never stored: it can read and write
 * the whole Lexware account, and this module only ever needs it once.
 *
 * Contacts and articles are imported as records. Invoices and credit notes
 * are imported as ARCHIVED documents: they keep their Lexware number and
 * Lexware's own PDF is stored as the archived copy — they were issued by
 * Lexware, and GoBD wants the document as sent, not a re-rendering.
 *
 * Lexware allows 2 requests per second; the client paces itself and retries
 * once on 429.
 */
import type { Address, LineItem, TaxTreatment } from './types';

export const LEXWARE_BASE = 'https://api.lexware.io/v1';

export interface LexwareClientOptions {
  apiKey: string;
  fetch?: typeof fetch;
  base?: string;
  /** Milliseconds between requests (Lexware: max 2/s). */
  pace?: number;
}

export class LexwareClient {
  private last = 0;
  constructor(private opts: LexwareClientOptions) {}

  private async wait() {
    const pace = this.opts.pace ?? 550;
    const delta = Date.now() - this.last;
    if (delta < pace) await new Promise((r) => setTimeout(r, pace - delta));
    this.last = Date.now();
  }

  async request(path: string, accept = 'application/json', attempt = 0): Promise<Response> {
    await this.wait();
    const f = this.opts.fetch ?? fetch;
    const res = await f(`${this.opts.base ?? LEXWARE_BASE}${path}`, {
      headers: { Authorization: `Bearer ${this.opts.apiKey}`, Accept: accept },
    });
    if (res.status === 429 && attempt < 3) {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      return this.request(path, accept, attempt + 1);
    }
    if (res.status === 401) throw new Error('Lexware rejected the API key (401).');
    return res;
  }

  async json<T>(path: string): Promise<T> {
    const res = await this.request(path);
    if (!res.ok) throw new Error(`Lexware ${path} answered ${res.status}.`);
    return res.json() as Promise<T>;
  }

  /** Every page of a paged endpoint. */
  async *paged<T>(path: string): AsyncGenerator<T> {
    for (let page = 0; page < 1000; page++) {
      const sep = path.includes('?') ? '&' : '?';
      const body = await this.json<{ content: T[]; last: boolean }>(`${path}${sep}page=${page}&size=250`);
      for (const item of body.content ?? []) yield item;
      if (body.last || !body.content?.length) return;
    }
  }
}

/* ------------------------------ mapping ------------------------------ */

interface LxAddress { supplement?: string; street?: string; zip?: string; city?: string; countryCode?: string }
export interface LxContact {
  id: string;
  roles?: { customer?: { number?: number }; vendor?: { number?: number } };
  company?: { name?: string; taxNumber?: string; vatRegistrationId?: string; contactPersons?: { firstName?: string; lastName?: string; emailAddress?: string }[] };
  person?: { salutation?: string; firstName?: string; lastName?: string };
  addresses?: { billing?: LxAddress[] };
  emailAddresses?: { business?: string[]; office?: string[]; private?: string[]; other?: string[] };
  phoneNumbers?: { business?: string[]; office?: string[]; mobile?: string[] };
  note?: string;
  archived?: boolean;
}

export function mapContact(c: LxContact) {
  const billing = c.addresses?.billing?.[0];
  const email = c.emailAddresses?.business?.[0] ?? c.emailAddresses?.office?.[0] ?? c.emailAddresses?.other?.[0] ?? c.emailAddresses?.private?.[0];
  const cp = c.company?.contactPersons?.[0];
  return {
    kind: c.company ? 'company' : 'person',
    company_name: c.company?.name,
    salutation: c.person?.salutation,
    first_name: c.person?.firstName ?? cp?.firstName,
    last_name: c.person?.lastName ?? cp?.lastName,
    email: email ?? cp?.emailAddress,
    phone: c.phoneNumbers?.business?.[0] ?? c.phoneNumbers?.office?.[0] ?? c.phoneNumbers?.mobile?.[0],
    roles: { customer: !!c.roles?.customer, vendor: !!c.roles?.vendor },
    customer_number: c.roles?.customer?.number ? String(c.roles.customer.number) : undefined,
    vendor_number: c.roles?.vendor?.number ? String(c.roles.vendor.number) : undefined,
    vat_id: c.company?.vatRegistrationId,
    tax_number: c.company?.taxNumber,
    billing_address: billing ? {
      supplement: billing.supplement, street: billing.street, zip: billing.zip, city: billing.city, country: billing.countryCode ?? 'DE',
    } : { country: 'DE' },
    notes: c.note,
    archived: c.archived,
  };
}

export interface LxArticle {
  id: string; title: string; description?: string; type?: 'PRODUCT' | 'SERVICE'; articleNumber?: string; unitName?: string;
  price?: { netPrice?: number; grossPrice?: number; leadingPrice?: 'NET' | 'GROSS'; taxRate?: number };
  archived?: boolean;
}

const UNIT_MAP: Record<string, string> = {
  stunde: 'HUR', stunden: 'HUR', std: 'HUR', 'std.': 'HUR', h: 'HUR', hour: 'HUR', hours: 'HUR',
  tag: 'DAY', tage: 'DAY', day: 'DAY', days: 'DAY', monat: 'MON', monate: 'MON', month: 'MON',
  jahr: 'ANN', year: 'ANN', woche: 'WEE', stück: 'C62', stk: 'C62', 'stk.': 'C62', piece: 'C62', pauschal: 'LS', pauschale: 'LS',
};

export function mapUnit(name: string | undefined): string {
  return UNIT_MAP[(name ?? '').trim().toLowerCase()] ?? 'C62';
}

export function mapArticle(a: LxArticle) {
  const rate = a.price?.taxRate ?? 19;
  const net = a.price?.netPrice ?? (a.price?.grossPrice !== undefined ? a.price.grossPrice / (1 + rate / 100) : 0);
  return {
    title: a.title, description: a.description, type: a.type === 'PRODUCT' ? 'product' : 'service',
    number: a.articleNumber, unit: mapUnit(a.unitName), unit_price_cents: Math.round(net * 100), tax_rate: rate, archived: a.archived,
  };
}

export interface LxVoucher {
  id: string; voucherType: string; voucherStatus: string; voucherNumber: string; voucherDate: string;
  dueDate?: string; contactId?: string; contactName?: string; totalAmount?: number; openAmount?: number; currency?: string;
}

export interface LxInvoice {
  id: string; voucherNumber: string; voucherDate: string; dueDate?: string; voucherStatus?: string;
  address?: { contactId?: string; name?: string; supplement?: string; street?: string; city?: string; zip?: string; countryCode?: string };
  lineItems?: {
    type?: string; name?: string; description?: string; quantity?: number; unitName?: string;
    unitPrice?: { netAmount?: number; grossAmount?: number; taxRatePercentage?: number }; discountPercentage?: number;
  }[];
  totalPrice?: { currency?: string; totalNetAmount?: number; totalGrossAmount?: number; totalTaxAmount?: number };
  taxConditions?: { taxType?: string };
  shippingConditions?: { shippingDate?: string; shippingEndDate?: string };
  title?: string; introduction?: string; remark?: string;
}

export function mapTaxType(t: string | undefined): TaxTreatment {
  switch (t) {
    case 'vatfree': return 'small_business';
    case 'intraCommunitySupply': return 'intra_community_supply';
    case 'externalService13b': return 'reverse_charge_eu';
    case 'thirdPartyCountryService': return 'third_country_service';
    case 'thirdPartyCountryDelivery': return 'export';
    default: return 'domestic';
  }
}

export function mapInvoiceLines(inv: LxInvoice, gross: boolean): LineItem[] {
  return (inv.lineItems ?? []).map((l, i) => {
    const text = l.type === 'text';
    const unit = gross ? l.unitPrice?.grossAmount : l.unitPrice?.netAmount;
    return {
      id: `lx${i}`,
      type: text ? 'text' : 'item',
      name: l.name ?? '',
      description: l.description,
      quantity: text ? 0 : l.quantity ?? 1,
      unit: mapUnit(l.unitName),
      unit_price_cents: text ? 0 : Math.round((unit ?? 0) * 100),
      discount_percent: l.discountPercentage || undefined,
      tax_rate: l.unitPrice?.taxRatePercentage ?? 19,
    } satisfies LineItem;
  });
}

export function mapInvoiceAddress(inv: LxInvoice): Address & { email?: string } {
  const a = inv.address ?? {};
  return { name: a.name, supplement: a.supplement, street: a.street, zip: a.zip, city: a.city, country: a.countryCode ?? 'DE' };
}

export function mapVoucherStatus(s: string): 'open' | 'paid' | 'cancelled' {
  if (s === 'paid' || s === 'paidoff') return 'paid';
  if (s === 'voided') return 'cancelled';
  return 'open';
}
