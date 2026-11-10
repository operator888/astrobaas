/**
 * Reading INCOMING e-invoices (XRechnung / ZUGFeRD / Factur-X / Peppol).
 *
 * Since 1 January 2025 every German business must be able to RECEIVE
 * e-invoices, and a supplier may send nothing but an XML file. This turns one
 * into an expense draft: supplier, number, dates, and the VAT breakdown taken
 * from the document's own tax subtotals — never recomputed, because the
 * supplier's figures are what the input-tax deduction is based on.
 *
 * Both syntaxes are read: CII (`CrossIndustryInvoice`) and UBL (`Invoice` /
 * `CreditNote`).
 */
import { child, children, findAll, parseXml, path, text, type XmlNode } from './xml';
import { decimalToCents } from './format';

export interface ParsedEInvoice {
  syntax: 'CII' | 'UBL';
  type: 'invoice' | 'credit_note';
  number: string;
  issue_date: string;
  due_date?: string;
  service_date?: string;
  currency: string;
  seller: {
    name: string; vat_id?: string; tax_number?: string; email?: string;
    street?: string; zip?: string; city?: string; country?: string;
  };
  buyer: { name: string; vat_id?: string; reference?: string };
  groups: { category: string; rate: number; net_cents: number; tax_cents: number }[];
  net_cents: number;
  tax_cents: number;
  gross_cents: number;
  due_cents: number;
  iban?: string;
  payment_reference?: string;
  lines: { name: string; quantity: number; net_cents: number; rate: number }[];
  profile?: string;
}

function cents(s: string): number {
  return decimalToCents(s) ?? 0;
}

function iso102(s: string): string {
  const m = s.trim().match(/^(\d{4})(\d{2})(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : s.trim().slice(0, 10);
}

function parseCii(doc: XmlNode): ParsedEInvoice {
  const ex = child(doc, 'ExchangedDocument');
  const tx = child(doc, 'SupplyChainTradeTransaction');
  const agr = child(tx, 'ApplicableHeaderTradeAgreement');
  const set = child(tx, 'ApplicableHeaderTradeSettlement');
  const sum = child(set, 'SpecifiedTradeSettlementHeaderMonetarySummation');
  const seller = child(agr, 'SellerTradeParty');
  const buyer = child(agr, 'BuyerTradeParty');
  const regs = (p?: XmlNode) => children(p, 'SpecifiedTaxRegistration').map((r) => child(r, 'ID'));
  const sellerAddr = child(seller, 'PostalTradeAddress');
  const typeCode = text(child(ex, 'TypeCode'));
  const groups = children(set, 'ApplicableTradeTax').map((t) => ({
    category: text(child(t, 'CategoryCode')),
    rate: Number(text(child(t, 'RateApplicablePercent')) || 0),
    net_cents: cents(text(child(t, 'BasisAmount'))),
    tax_cents: cents(text(child(t, 'CalculatedAmount'))),
  }));
  const due = path(set, 'SpecifiedTradePaymentTerms', 'DueDateDateTime', 'DateTimeString');
  const delivery = path(tx, 'ApplicableHeaderTradeDelivery', 'ActualDeliverySupplyChainEvent', 'OccurrenceDateTime', 'DateTimeString');
  const taxTotal = children(sum, 'TaxTotalAmount')[0];
  const lines = children(tx, 'IncludedSupplyChainTradeLineItem').map((li) => ({
    name: text(path(li, 'SpecifiedTradeProduct', 'Name')),
    quantity: Number(text(path(li, 'SpecifiedLineTradeDelivery', 'BilledQuantity')) || 0),
    net_cents: cents(text(path(li, 'SpecifiedLineTradeSettlement', 'SpecifiedTradeSettlementLineMonetarySummation', 'LineTotalAmount'))),
    rate: Number(text(path(li, 'SpecifiedLineTradeSettlement', 'ApplicableTradeTax', 'RateApplicablePercent')) || 0),
  }));
  const vat = regs(seller).find((r) => r?.attrs.schemeID === 'VA');
  const fc = regs(seller).find((r) => r?.attrs.schemeID === 'FC');
  return {
    syntax: 'CII',
    type: typeCode === '381' ? 'credit_note' : 'invoice',
    number: text(child(ex, 'ID')),
    issue_date: iso102(text(path(ex, 'IssueDateTime', 'DateTimeString'))),
    due_date: due ? iso102(text(due)) : undefined,
    service_date: delivery ? iso102(text(delivery)) : undefined,
    currency: text(child(set, 'InvoiceCurrencyCode')) || 'EUR',
    seller: {
      name: text(child(seller, 'Name')),
      vat_id: vat ? text(vat) : undefined,
      tax_number: fc ? text(fc) : undefined,
      email: text(path(seller, 'URIUniversalCommunication', 'URIID')) || undefined,
      street: text(child(sellerAddr, 'LineOne')) || undefined,
      zip: text(child(sellerAddr, 'PostcodeCode')) || undefined,
      city: text(child(sellerAddr, 'CityName')) || undefined,
      country: text(child(sellerAddr, 'CountryID')) || undefined,
    },
    buyer: {
      name: text(child(buyer, 'Name')),
      vat_id: regs(buyer).map(text).find(Boolean),
      reference: text(child(agr, 'BuyerReference')) || undefined,
    },
    groups,
    net_cents: cents(text(child(sum, 'TaxBasisTotalAmount'))),
    tax_cents: cents(text(taxTotal)),
    gross_cents: cents(text(child(sum, 'GrandTotalAmount'))),
    due_cents: cents(text(child(sum, 'DuePayableAmount'))),
    iban: text(path(set, 'SpecifiedTradeSettlementPaymentMeans', 'PayeePartyCreditorFinancialAccount', 'IBANID')) || undefined,
    payment_reference: text(child(set, 'PaymentReference')) || undefined,
    lines,
    profile: text(path(doc, 'ExchangedDocumentContext', 'GuidelineSpecifiedDocumentContextParameter', 'ID')) || undefined,
  };
}

function parseUbl(doc: XmlNode): ParsedEInvoice {
  const isCredit = doc.name === 'CreditNote';
  const sp = path(doc, 'AccountingSupplierParty', 'Party');
  const bp = path(doc, 'AccountingCustomerParty', 'Party');
  const addr = child(sp, 'PostalAddress');
  const totals = child(doc, 'LegalMonetaryTotal');
  const taxTotal = children(doc, 'TaxTotal').find((t) => children(t, 'TaxSubtotal').length) ?? child(doc, 'TaxTotal');
  const groups = children(taxTotal, 'TaxSubtotal').map((st) => ({
    category: text(path(st, 'TaxCategory', 'ID')),
    rate: Number(text(path(st, 'TaxCategory', 'Percent')) || 0),
    net_cents: cents(text(child(st, 'TaxableAmount'))),
    tax_cents: cents(text(child(st, 'TaxAmount'))),
  }));
  const lineName = isCredit ? 'CreditNoteLine' : 'InvoiceLine';
  const qtyName = isCredit ? 'CreditedQuantity' : 'InvoicedQuantity';
  const lines = children(doc, lineName).map((li) => ({
    name: text(path(li, 'Item', 'Name')),
    quantity: Number(text(child(li, qtyName)) || 0),
    net_cents: cents(text(child(li, 'LineExtensionAmount'))),
    rate: Number(text(path(li, 'Item', 'ClassifiedTaxCategory', 'Percent')) || 0),
  }));
  const schemes = children(sp, 'PartyTaxScheme');
  const vat = schemes.map((s) => text(child(s, 'CompanyID'))).find((v) => /^[A-Z]{2}/.test(v));
  return {
    syntax: 'UBL',
    type: isCredit ? 'credit_note' : 'invoice',
    number: text(child(doc, 'ID')),
    issue_date: text(child(doc, 'IssueDate')),
    due_date: text(child(doc, 'DueDate')) || text(path(doc, 'PaymentMeans', 'PaymentDueDate')) || undefined,
    service_date: text(path(doc, 'Delivery', 'ActualDeliveryDate')) || undefined,
    currency: text(child(doc, 'DocumentCurrencyCode')) || 'EUR',
    seller: {
      name: text(path(sp, 'PartyLegalEntity', 'RegistrationName')) || text(path(sp, 'PartyName', 'Name')),
      vat_id: vat,
      email: text(child(sp, 'EndpointID')) || undefined,
      street: text(child(addr, 'StreetName')) || undefined,
      zip: text(child(addr, 'PostalZone')) || undefined,
      city: text(child(addr, 'CityName')) || undefined,
      country: text(path(addr, 'Country', 'IdentificationCode')) || undefined,
    },
    buyer: {
      name: text(path(bp, 'PartyLegalEntity', 'RegistrationName')) || text(path(bp, 'PartyName', 'Name')),
      vat_id: text(path(bp, 'PartyTaxScheme', 'CompanyID')) || undefined,
      reference: text(child(doc, 'BuyerReference')) || undefined,
    },
    groups,
    net_cents: cents(text(child(totals, 'TaxExclusiveAmount'))),
    tax_cents: cents(text(child(taxTotal, 'TaxAmount'))),
    gross_cents: cents(text(child(totals, 'TaxInclusiveAmount'))),
    due_cents: cents(text(child(totals, 'PayableAmount'))),
    iban: text(path(doc, 'PaymentMeans', 'PayeeFinancialAccount', 'ID')) || undefined,
    payment_reference: text(path(doc, 'PaymentMeans', 'PaymentID')) || undefined,
    lines,
    profile: text(child(doc, 'CustomizationID')) || undefined,
  };
}

export function parseEInvoice(xml: string): ParsedEInvoice {
  const doc = parseXml(xml);
  if (doc.name === 'CrossIndustryInvoice') return parseCii(doc);
  if (doc.name === 'Invoice' || doc.name === 'CreditNote') return parseUbl(doc);
  // Some senders wrap the payload; look one level down before giving up.
  const inner = findAll(doc, 'CrossIndustryInvoice')[0];
  if (inner) return parseCii(inner);
  throw new Error(`Not an e-invoice: root element <${doc.name}>.`);
}
