/**
 * E-invoices in UN/CEFACT Cross Industry Invoice (CII) syntax.
 *
 * One generator, two profiles:
 *
 *  - `xrechnung` — XRechnung 3.0, the German CIUS. Required for public-sector
 *    customers (with their Leitweg-ID as BT-10) and accepted by everyone.
 *  - `en16931`  — the plain EN 16931 profile, which is what ZUGFeRD 2.x /
 *    Factur-X "EN 16931 (COMFORT)" embeds inside the PDF.
 *
 * Both are an "E-Rechnung" under §14 UStG as amended from 2025. The XML is the
 * legally binding part of a hybrid invoice; the PDF is a rendering of it.
 *
 * Element ORDER matters: CII is validated against an XSD with sequences, so
 * every block below is written in schema order, not in reading order.
 *
 * `preflight` lists what a validator would reject BEFORE anything is
 * generated, in words a person can act on ("customer has no email address"),
 * instead of a schematron rule id.
 */
import type { FinanceDocument, TaxGroup } from './types';
import { centsToDecimal, escapeXml as x } from './format';
import { validIban } from './tax';

export type CiiProfile = 'xrechnung' | 'en16931';

export const GUIDELINE_IDS: Record<CiiProfile, string> = {
  xrechnung: 'urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0',
  en16931: 'urn:cen.eu:en16931:2017',
};
const BUSINESS_PROCESS = 'urn:fdc:peppol.eu:2017:poacc:billing:01.0';

export interface Preflight {
  errors: string[];
  warnings: string[];
}

/** Date `YYYY-MM-DD` → CII format 102 `YYYYMMDD`. */
function d102(iso: string): string {
  return iso.slice(0, 10).replace(/-/g, '');
}

function dateEl(tag: string, iso: string): string {
  return `<${tag}><udt:DateTimeString format="102">${d102(iso)}</udt:DateTimeString></${tag}>`;
}

/** Quantities and unit prices may carry up to 4 decimals in CII. */
function dec4(n: number): string {
  const r = Math.round(n * 10000) / 10000;
  return r.toFixed(4).replace(/\.?0+$/, '') || '0';
}

function buyerEmail(doc: FinanceDocument): string | undefined {
  return doc.recipient.email?.trim() || undefined;
}

export function preflight(doc: FinanceDocument, profile: CiiProfile): Preflight {
  const errors: string[] = [];
  const warnings: string[] = [];
  const s = doc.seller;
  if (!s) {
    errors.push('The document has no seller snapshot — finalize it first.');
    return { errors, warnings };
  }
  if (!doc.number) errors.push('The document has no number — finalize it first.');
  if (!doc.issue_date) errors.push('The document has no issue date.');
  if (!s.name) errors.push('Company name is missing (Settings → Company).');
  if (!s.street || !s.zip || !s.city) errors.push('Company address is incomplete (Settings → Company).');
  if (!s.vat_id && !s.tax_number) errors.push('Company needs a VAT id or a tax number (Settings → Company).');
  if (!doc.recipient.name) errors.push('Recipient name is missing.');
  if (!doc.recipient.country) errors.push('Recipient country is missing.');
  if (doc.totals.lines.length === 0) errors.push('The document has no billable lines.');

  if (profile === 'xrechnung') {
    if (!s.contact_person) errors.push('XRechnung needs a contact person (Settings → Company).');
    if (!s.phone) errors.push('XRechnung needs a company phone number (Settings → Company).');
    if (!s.email) errors.push('XRechnung needs a company email address (Settings → Company).');
    if (!buyerEmail(doc)) errors.push('XRechnung needs the customer\'s email address (electronic address, BT-49).');
    if (!s.zip || !s.city) errors.push('XRechnung needs the company postcode and city.');
    if (doc.totals.groups.some((g) => g.category === 'O')) {
      // BR-O-05 forbids a rate on an O line; BR-DE-14 demands one in the
      // breakdown. No XRechnung can satisfy both, so say so plainly.
      errors.push('XRechnung cannot carry a "not subject to VAT" invoice (customers outside the EU). Use ZUGFeRD or PDF for this customer.');
    }
    if (!doc.recipient.buyer_reference) {
      warnings.push('No buyer reference / Leitweg-ID set — the invoice number is used instead. Public-sector customers REQUIRE their Leitweg-ID.');
    }
  }
  if (doc.tax_treatment === 'reverse_charge_eu' || doc.tax_treatment === 'intra_community_supply') {
    if (!s.vat_id) errors.push('Reverse charge / intra-Community supply needs YOUR VAT id (USt-IdNr.).');
    if (!doc.recipient.vat_id) errors.push('Reverse charge / intra-Community supply needs the CUSTOMER\'s VAT id.');
  }
  if (s.iban && !validIban(s.iban)) warnings.push('The company IBAN fails its checksum.');
  if (!s.iban) warnings.push('No IBAN in the company profile — the e-invoice will carry no bank details.');
  return { errors, warnings };
}

function address(a: { street?: string; supplement?: string; zip?: string; city?: string; country?: string }): string {
  return '<ram:PostalTradeAddress>'
    + (a.zip ? `<ram:PostcodeCode>${x(a.zip)}</ram:PostcodeCode>` : '')
    + (a.street ? `<ram:LineOne>${x(a.street)}</ram:LineOne>` : '')
    + (a.supplement ? `<ram:LineTwo>${x(a.supplement)}</ram:LineTwo>` : '')
    + (a.city ? `<ram:CityName>${x(a.city)}</ram:CityName>` : '')
    + `<ram:CountryID>${x((a.country || 'DE').toUpperCase())}</ram:CountryID>`
    + '</ram:PostalTradeAddress>';
}

function taxRegistrations(vat?: string, taxNo?: string): string {
  let out = '';
  if (vat) out += `<ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">${x(vat.replace(/\s+/g, ''))}</ram:ID></ram:SpecifiedTaxRegistration>`;
  if (taxNo) out += `<ram:SpecifiedTaxRegistration><ram:ID schemeID="FC">${x(taxNo)}</ram:ID></ram:SpecifiedTaxRegistration>`;
  return out;
}

function headerTax(g: TaxGroup): string {
  return '<ram:ApplicableTradeTax>'
    + `<ram:CalculatedAmount>${centsToDecimal(g.tax_cents)}</ram:CalculatedAmount>`
    + '<ram:TypeCode>VAT</ram:TypeCode>'
    + (g.exemption_reason ? `<ram:ExemptionReason>${x(g.exemption_reason)}</ram:ExemptionReason>` : '')
    + `<ram:BasisAmount>${centsToDecimal(g.net_cents)}</ram:BasisAmount>`
    + `<ram:CategoryCode>${g.category}</ram:CategoryCode>`
    + (g.exemption_code ? `<ram:ExemptionReasonCode>${x(g.exemption_code)}</ram:ExemptionReasonCode>` : '')
    // Category O ("not subject to VAT") must carry no rate at all (BR-O-05/09).
    + (g.category === 'O' ? '' : `<ram:RateApplicablePercent>${dec4(g.rate)}</ram:RateApplicablePercent>`)
    + '</ram:ApplicableTradeTax>';
}

/**
 * Build the XML. Throws when preflight has errors — an invalid e-invoice is
 * worse than none, because the customer's system rejects it after it was
 * "sent" and nobody notices until the dunning letter.
 */
export function buildCii(doc: FinanceDocument, profile: CiiProfile): string {
  const pf = preflight(doc, profile);
  if (pf.errors.length) throw new Error(`E-invoice cannot be generated: ${pf.errors.join(' ')}`);
  const s = doc.seller!;
  const r = doc.recipient;
  const isCredit = doc.type === 'credit_note';
  const typeCode = isCredit ? '381' : '380';
  const lang = s.document_language || 'de';

  const notes: string[] = [];
  if (doc.intro) notes.push(doc.intro);
  const exemption = doc.totals.groups.find((g) => g.exemption_reason)?.exemption_reason;
  if (exemption) notes.push(exemption);
  // Company registration details as a #REG note — the conventional place in
  // German e-invoices for what the letterhead footer says on paper.
  const reg = [s.register_court, s.register_number, s.managing_directors && `${lang === 'de' ? 'Geschäftsführung' : 'Managing director'}: ${s.managing_directors}`]
    .filter(Boolean).join(', ');

  const lineById = new Map(doc.lines.map((l) => [l.id, l]));
  let lineNo = 0;
  const lines = doc.totals.lines.map((cl) => {
    const l = lineById.get(cl.id)!;
    lineNo += 1;
    const qty = Number(l.quantity) || 0;
    // Net unit price such that qty × price reproduces the rounded line net.
    // For a plain net line without discount that is exactly the typed price.
    const plain = doc.price_mode === 'net' && !l.discount_percent;
    const unitNet = plain ? l.unit_price_cents / 100 : qty !== 0 ? cl.net_cents / 100 / qty : 0;
    const period = l.period_start && l.period_end
      ? `<ram:BillingSpecifiedPeriod>${dateEl('ram:StartDateTime', l.period_start)}${dateEl('ram:EndDateTime', l.period_end)}</ram:BillingSpecifiedPeriod>`
      : '';
    return '<ram:IncludedSupplyChainTradeLineItem>'
      + `<ram:AssociatedDocumentLineDocument><ram:LineID>${lineNo}</ram:LineID></ram:AssociatedDocumentLineDocument>`
      + '<ram:SpecifiedTradeProduct>'
      + `<ram:Name>${x(l.name || '—')}</ram:Name>`
      + (l.description ? `<ram:Description>${x(l.description)}</ram:Description>` : '')
      + '</ram:SpecifiedTradeProduct>'
      + '<ram:SpecifiedLineTradeAgreement>'
      + `<ram:NetPriceProductTradePrice><ram:ChargeAmount>${dec4(unitNet)}</ram:ChargeAmount></ram:NetPriceProductTradePrice>`
      + '</ram:SpecifiedLineTradeAgreement>'
      + `<ram:SpecifiedLineTradeDelivery><ram:BilledQuantity unitCode="${x(l.unit || 'C62')}">${dec4(qty)}</ram:BilledQuantity></ram:SpecifiedLineTradeDelivery>`
      + '<ram:SpecifiedLineTradeSettlement>'
      + '<ram:ApplicableTradeTax><ram:TypeCode>VAT</ram:TypeCode>'
      + `<ram:CategoryCode>${cl.category}</ram:CategoryCode>`
      + (cl.category === 'O' ? '' : `<ram:RateApplicablePercent>${dec4(cl.rate)}</ram:RateApplicablePercent>`)
      + '</ram:ApplicableTradeTax>'
      + period
      + `<ram:SpecifiedTradeSettlementLineMonetarySummation><ram:LineTotalAmount>${centsToDecimal(cl.net_cents)}</ram:LineTotalAmount></ram:SpecifiedTradeSettlementLineMonetarySummation>`
      + '</ram:SpecifiedLineTradeSettlement>'
      + '</ram:IncludedSupplyChainTradeLineItem>';
  }).join('');

  const sellerEmail = s.einvoice_email || s.email;
  const outOfScope = doc.totals.groups.some((g) => g.category === 'O');
  const buyerMail = buyerEmail(doc);
  const buyerRef = r.buyer_reference || doc.number!;
  const deliveryDate = doc.service_date || doc.issue_date!;

  const seller = '<ram:SellerTradeParty>'
    + `<ram:Name>${x(s.name)}</ram:Name>`
    + (reg ? `<ram:Description>${x(reg)}</ram:Description>` : '')
    + (s.register_number ? `<ram:SpecifiedLegalOrganization><ram:ID>${x(s.register_number)}</ram:ID></ram:SpecifiedLegalOrganization>` : '')
    + (s.contact_person || s.phone || s.email
      ? '<ram:DefinedTradeContact>'
        + (s.contact_person ? `<ram:PersonName>${x(s.contact_person)}</ram:PersonName>` : '')
        + (s.phone ? `<ram:TelephoneUniversalCommunication><ram:CompleteNumber>${x(s.phone)}</ram:CompleteNumber></ram:TelephoneUniversalCommunication>` : '')
        + (s.email ? `<ram:EmailURIUniversalCommunication><ram:URIID>${x(s.email)}</ram:URIID></ram:EmailURIUniversalCommunication>` : '')
        + '</ram:DefinedTradeContact>'
      : '')
    + address(s)
    + (sellerEmail ? `<ram:URIUniversalCommunication><ram:URIID schemeID="EM">${x(sellerEmail)}</ram:URIID></ram:URIUniversalCommunication>` : '')
    // An invoice "outside the scope of VAT" must not show the seller's VAT id
    // (BR-O-02); the tax number still identifies the seller.
    + taxRegistrations(outOfScope ? undefined : s.vat_id, s.tax_number)
    + '</ram:SellerTradeParty>';

  const buyer = '<ram:BuyerTradeParty>'
    + `<ram:Name>${x(r.name || '')}</ram:Name>`
    + address(r)
    + (buyerMail ? `<ram:URIUniversalCommunication><ram:URIID schemeID="EM">${x(buyerMail)}</ram:URIID></ram:URIUniversalCommunication>` : '')
    + taxRegistrations(outOfScope ? undefined : r.vat_id, undefined)
    + '</ram:BuyerTradeParty>';

  const hasIban = !!s.iban && validIban(s.iban);
  const paymentMeans = hasIban
    ? '<ram:SpecifiedTradeSettlementPaymentMeans><ram:TypeCode>58</ram:TypeCode>'
      + `<ram:PayeePartyCreditorFinancialAccount><ram:IBANID>${x(s.iban!.replace(/\s+/g, ''))}</ram:IBANID>`
      + `<ram:AccountName>${x(s.account_holder || s.name)}</ram:AccountName></ram:PayeePartyCreditorFinancialAccount>`
      + (s.bic ? `<ram:PayeeSpecifiedCreditorFinancialInstitution><ram:BICID>${x(s.bic.replace(/\s+/g, ''))}</ram:BICID></ram:PayeeSpecifiedCreditorFinancialInstitution>` : '')
      + '</ram:SpecifiedTradeSettlementPaymentMeans>'
    : '<ram:SpecifiedTradeSettlementPaymentMeans><ram:TypeCode>1</ram:TypeCode></ram:SpecifiedTradeSettlementPaymentMeans>';

  const headerPeriod = doc.service_date && doc.service_date_end
    ? `<ram:BillingSpecifiedPeriod>${dateEl('ram:StartDateTime', doc.service_date)}${dateEl('ram:EndDateTime', doc.service_date_end)}</ram:BillingSpecifiedPeriod>`
    : '';

  const termsText = doc.payment_terms_text
    || (doc.due_date ? (lang === 'de' ? `Zahlbar bis ${doc.due_date.split('-').reverse().join('.')}` : `Payable by ${doc.due_date}`) : '');
  const terms = isCredit ? '' : (termsText || doc.due_date)
    ? '<ram:SpecifiedTradePaymentTerms>'
      + (termsText ? `<ram:Description>${x(termsText)}</ram:Description>` : '')
      + (doc.due_date ? dateEl('ram:DueDateDateTime', doc.due_date) : '')
      + '</ram:SpecifiedTradePaymentTerms>'
    : '';

  const t = doc.totals;
  const summation = '<ram:SpecifiedTradeSettlementHeaderMonetarySummation>'
    + `<ram:LineTotalAmount>${centsToDecimal(t.net_cents)}</ram:LineTotalAmount>`
    + `<ram:TaxBasisTotalAmount>${centsToDecimal(t.net_cents)}</ram:TaxBasisTotalAmount>`
    + `<ram:TaxTotalAmount currencyID="${x(doc.currency)}">${centsToDecimal(t.tax_cents)}</ram:TaxTotalAmount>`
    + `<ram:GrandTotalAmount>${centsToDecimal(t.gross_cents)}</ram:GrandTotalAmount>`
    + `<ram:DuePayableAmount>${centsToDecimal(t.gross_cents)}</ram:DuePayableAmount>`
    + '</ram:SpecifiedTradeSettlementHeaderMonetarySummation>';

  const referenced = isCredit && doc.refers_to_number
    ? `<ram:InvoiceReferencedDocument><ram:IssuerAssignedID>${x(doc.refers_to_number)}</ram:IssuerAssignedID></ram:InvoiceReferencedDocument>`
    : '';

  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<rsm:CrossIndustryInvoice'
    + ' xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"'
    + ' xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100"'
    + ' xmlns:qdt="urn:un:unece:uncefact:data:standard:QualifiedDataType:100"'
    + ' xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">'
    + '<rsm:ExchangedDocumentContext>'
    + `<ram:BusinessProcessSpecifiedDocumentContextParameter><ram:ID>${BUSINESS_PROCESS}</ram:ID></ram:BusinessProcessSpecifiedDocumentContextParameter>`
    + `<ram:GuidelineSpecifiedDocumentContextParameter><ram:ID>${GUIDELINE_IDS[profile]}</ram:ID></ram:GuidelineSpecifiedDocumentContextParameter>`
    + '</rsm:ExchangedDocumentContext>'
    + '<rsm:ExchangedDocument>'
    + `<ram:ID>${x(doc.number!)}</ram:ID>`
    + `<ram:TypeCode>${typeCode}</ram:TypeCode>`
    + dateEl('ram:IssueDateTime', doc.issue_date!)
    + notes.map((n) => `<ram:IncludedNote><ram:Content>${x(n)}</ram:Content></ram:IncludedNote>`).join('')
    + (reg ? `<ram:IncludedNote><ram:Content>${x(reg)}</ram:Content><ram:SubjectCode>REG</ram:SubjectCode></ram:IncludedNote>` : '')
    + '</rsm:ExchangedDocument>'
    + '<rsm:SupplyChainTradeTransaction>'
    + lines
    + '<ram:ApplicableHeaderTradeAgreement>'
    + `<ram:BuyerReference>${x(buyerRef)}</ram:BuyerReference>`
    + seller
    + buyer
    + '</ram:ApplicableHeaderTradeAgreement>'
    + '<ram:ApplicableHeaderTradeDelivery>'
    // Goods leaving the country: the zero rate rests on where they went, so
    // the deliver-to address is mandatory (BR-IC-12) and given for exports too.
    + (doc.tax_treatment === 'intra_community_supply' || doc.tax_treatment === 'export'
      ? `<ram:ShipToTradeParty><ram:Name>${x(r.name || '')}</ram:Name>${address(r)}</ram:ShipToTradeParty>`
      : '')
    + `<ram:ActualDeliverySupplyChainEvent>${dateEl('ram:OccurrenceDateTime', deliveryDate)}</ram:ActualDeliverySupplyChainEvent>`
    + '</ram:ApplicableHeaderTradeDelivery>'
    + '<ram:ApplicableHeaderTradeSettlement>'
    + `<ram:PaymentReference>${x(doc.number!)}</ram:PaymentReference>`
    + `<ram:InvoiceCurrencyCode>${x(doc.currency)}</ram:InvoiceCurrencyCode>`
    + paymentMeans
    + t.groups.map(headerTax).join('')
    + headerPeriod
    + terms
    + summation
    + referenced
    + '</ram:ApplicableHeaderTradeSettlement>'
    + '</rsm:SupplyChainTradeTransaction>'
    + '</rsm:CrossIndustryInvoice>\n';
}
