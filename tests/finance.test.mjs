#!/usr/bin/env node
/**
 * The finance module (src/plugins/finance).
 *
 * What is pinned here, because a mistake in it costs money or a tax audit:
 *
 *  - VAT arithmetic follows EN 16931 (VAT per rate group on the summed line
 *    nets), in net and gross mode, and every non-domestic treatment forces 0 %.
 *  - Numbers are assigned only at finalization, per period, never twice.
 *  - A finalized document cannot be edited or deleted; it is corrected with a
 *    credit note, which offsets what was open.
 *  - The e-invoice XML is well-formed, carries the XRechnung / EN 16931 ids,
 *    and reads back to the same totals; preflight refuses what a validator
 *    would reject (including category O in an XRechnung).
 *  - The ZUGFeRD PDF carries factur-x.xml, PDF/A-3 metadata and an
 *    OutputIntent, and the XML can be pulled back out.
 *  - Bank statements in camt.053, MT940 and CSV parse to the same shape;
 *    re-importing is a no-op; an invoice number in the purpose auto-matches.
 *  - DATEV: 31 header fields, 125 columns on every row, CRLF, CP1252.
 *  - The hash-chained log detects tampering.
 *
 * Schema-level validation of the XML against the official KoSIT / CEN
 * schematron was done out of band (see the module README); this file pins
 * what can be pinned without Java.
 *
 * Run with:  node tests/finance.test.mjs
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument, PDFName, PDFDict, PDFArray } from 'pdf-lib';
import { loadTs, ROOT } from './lib/load.mjs';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'finance-test-'));
process.env.PRIVATE_UPLOADS_DIR = tmp;

const T = await loadTs('src/plugins/finance/lib/tax.ts');
const N = await loadTs('src/plugins/finance/lib/numbering.ts');
const C = await loadTs('src/plugins/finance/lib/einvoice-cii.ts');
const EP = await loadTs('src/plugins/finance/lib/einvoice-parse.ts');
const B = await loadTs('src/plugins/finance/lib/bank-parse.ts');
const M = await loadTs('src/plugins/finance/lib/matching.ts');
const D = await loadTs('src/plugins/finance/lib/datev.ts');
const R = await loadTs('src/plugins/finance/lib/reports.ts');
const Z = await loadTs('src/plugins/finance/lib/zip.ts');
const F = await loadTs('src/plugins/finance/lib/format.ts');
const X = await loadTs('src/plugins/finance/lib/xml.ts');
const FX = await loadTs('src/plugins/finance/lib/facturx.ts');
const S = await loadTs('src/plugins/finance/lib/service.ts');
const SH = await loadTs('src/plugins/finance/lib/shop.ts');
const LX = await loadTs('src/plugins/finance/lib/lexware.ts');
const IM = await loadTs('src/plugins/finance/lib/importer.ts');
const MIME = await loadTs('src/lib/email-mime.ts');
const font = new Uint8Array(await fs.readFile(path.join(ROOT, 'public/fonts/DejaVuSans.ttf')));

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) pass++;
  else { fail++; console.error(`✗ ${name}`); }
}
async function checkAsync(name, fn) {
  try { check(name, await fn()); } catch (err) { fail++; console.error(`✗ ${name}: ${err.message}`); }
}
async function rejects(name, fn, re) {
  try { await fn(); fail++; console.error(`✗ ${name}: did not throw`); } catch (err) { check(`${name} (${err.message.slice(0, 60)})`, !re || re.test(err.message)); }
}

/* ------------------------------------------------------------------ tax */
{
  const L = (o) => ({ id: Math.random().toString(36).slice(2), type: 'item', name: 'x', quantity: 1, unit: 'C62', unit_price_cents: 0, tax_rate: 19, ...o });
  const lines = [
    L({ quantity: 12.5, unit_price_cents: 9500 }),
    L({ quantity: 1, unit_price_cents: 14900, discount_percent: 10 }),
    L({ quantity: 2, unit_price_cents: 3990, tax_rate: 7 }),
    { id: 't', type: 'text', name: 'Heading', quantity: 0, unit: 'C62', unit_price_cents: 999999, tax_rate: 19 },
  ];
  const t = T.computeTotals(lines, 'domestic', 'net');
  check('net is the sum of rounded line nets', t.net_cents === 118750 + 13410 + 7980);
  check('19 % group VAT is computed once on the group sum', t.groups.find((g) => g.rate === 19).tax_cents === 25110);
  check('7 % group VAT rounds half up (5.586 → 5.59)', t.groups.find((g) => g.rate === 7).tax_cents === 559);
  check('gross = net + tax', t.gross_cents === t.net_cents + t.tax_cents && t.gross_cents === 165809);
  check('text lines carry no amount', t.lines.length === 3);
  check('groups are ordered highest rate first', t.groups[0].rate === 19);

  // EN 16931: VAT on the SUM, not per line. Three lines of 0.35 at 19 %:
  // per-line VAT would be 3 × 0.07 = 0.21; on the sum (1.05) it is 0.20.
  const tiny = T.computeTotals([L({ unit_price_cents: 35 }), L({ unit_price_cents: 35 }), L({ unit_price_cents: 35 })], 'domestic');
  check('VAT is not summed per line (BR-CO-17)', tiny.tax_cents === 20);

  const gross = T.computeTotals([L({ unit_price_cents: 11900 })], 'domestic', 'gross');
  check('gross mode: 119.00 incl. 19 % is 100.00 net + 19.00', gross.net_cents === 10000 && gross.tax_cents === 1900);

  for (const tr of ['small_business', 'reverse_charge_eu', 'intra_community_supply', 'third_country_service', 'export']) {
    const z = T.computeTotals([L({ unit_price_cents: 10000 })], tr);
    check(`${tr}: no VAT is charged even if the line says 19 %`, z.tax_cents === 0 && z.groups[0].rate === 0);
  }
  check('reverse charge is category AE with VATEX-EU-AE', T.computeTotals([L({ unit_price_cents: 1 })], 'reverse_charge_eu').groups[0].exemption_code === 'VATEX-EU-AE');
  check('Kleinunternehmer is category E with a §19 reason', /§ 19/.test(T.computeTotals([L({ unit_price_cents: 1 })], 'small_business').groups[0].exemption_reason));

  const seller = { small_business: false, country: 'DE' };
  check('German customer → domestic', T.suggestTreatment(seller, { country: 'DE' }) === 'domestic');
  check('EU business with VAT id → reverse charge', T.suggestTreatment(seller, { country: 'GR', vat_id: 'EL123456789' }) === 'reverse_charge_eu');
  check('EU consumer (no VAT id) → domestic VAT', T.suggestTreatment(seller, { country: 'AT' }) === 'domestic');
  check('EU goods to a business → intra-Community supply', T.suggestTreatment(seller, { country: 'FR', vat_id: 'FR12345678901' }, 'goods') === 'intra_community_supply');
  check('US customer → not taxable here', T.suggestTreatment(seller, { country: 'US' }) === 'third_country_service');
  check('Kleinunternehmer wins over everything', T.suggestTreatment({ small_business: true, country: 'DE' }, { country: 'GR', vat_id: 'EL1' }) === 'small_business');

  check('IBAN checksum accepts a valid one', T.validIban('DE02 1203 0000 0000 2020 51'));
  check('IBAN checksum rejects a typo', !T.validIban('DE02120300000000202052'));
  check('VAT id shape: Greek ids use EL', T.looksLikeVatId('EL123456789') && !T.looksLikeVatId('GR123456789'));
  check('splitGross(11900, 19) → 10000 + 1900', T.splitGross(11900, 19).net_cents === 10000);
}

/* ------------------------------------------------------------------ format */
{
  check('parse German amount', F.parseAmountToCents('1.234,56') === 123456);
  check('parse English amount', F.parseAmountToCents('1,234.56') === 123456);
  check('parse plain decimal', F.parseAmountToCents('12.5') === 1250);
  check('parse negative with €', F.parseAmountToCents('-12,50 €') === -1250);
  check('refuse garbage instead of guessing', F.parseAmountToCents('12abc') === null);
  check('parse German date', F.parseDate('13.10.2026') === '2026-10-13');
  check('parse short German date', F.parseDate('1.2.26') === '2026-02-01');
  check('addMonths clamps to month end', F.addMonths('2026-01-31', 1) === '2026-02-28');
  check('centsToDecimal', F.centsToDecimal(119000) === '1190.00' && F.centsToDecimal(-5) === '-0.05');
}

/* ------------------------------------------------------------------ numbering */
{
  const s = { pattern: 'RE-{YYYY}-{SEQ:4}', reset: 'yearly' };
  const a = N.nextNumber(s, '2026-10-13', undefined);
  check('first number of a year is 0001', a.number === 'RE-2026-0001');
  const b = N.nextNumber(s, '2026-11-01', a.counter);
  check('the next one counts up', b.number === 'RE-2026-0002');
  const c = N.nextNumber(s, '2027-01-02', undefined);
  check('a new year starts again (counter is per period)', c.number === 'RE-2027-0001' && c.counter.period === '2027');
  check('monthly reset pattern', N.renderNumber('{YY}{MM}-{SEQ:3}', '2026-03-09', 7) === '2603-007');
  check('pattern without {SEQ} is refused', !!N.patternProblem('RE-{YYYY}'));
  check('pattern with unknown token is refused', !!N.patternProblem('RE-{DD}-{SEQ}'));
  check('pattern with a DATEV-illegal char is refused', !!N.patternProblem('RE_{SEQ}'));
  check('default pattern is accepted', N.patternProblem('RE-{YYYY}-{SEQ:4}') === null);
}

/* ------------------------------------------------------------------ e-invoice */
const seller = {
  name: 'Dimitriou eCommerceWebServices UG (haftungsbeschränkt)', street: 'Steinerne Furt 1', zip: '86167', city: 'Augsburg', country: 'DE',
  vat_id: 'DE123456789', tax_number: '103/123/45678', email: 'info@example.de', phone: '+49 821 1234567', contact_person: 'Theodoros Dimitriou',
  iban: 'DE02120300000000202051', bic: 'BYLADEM1001', small_business: false, vat_basis: 'soll', chart: 'SKR03', fiscal_year_start_month: 1,
  default_payment_days: 14, default_currency: 'EUR', document_language: 'de', register_court: 'Amtsgericht Augsburg', register_number: 'HRB 1', managing_directors: 'T. D.',
};
function docFor(treatment, recipient, extra = {}) {
  const lines = [
    { id: 'a', type: 'item', name: 'Entwicklung <Shop> & "Checkout"', quantity: 10, unit: 'HUR', unit_price_cents: 9500, tax_rate: 19 },
    { id: 'b', type: 'item', name: 'Buch', quantity: 1, unit: 'C62', unit_price_cents: 3990, tax_rate: 7 },
  ];
  return {
    id: 'doc_1', type: 'invoice', status: 'open', number: 'RE-2026-0042', recipient, seller, currency: 'EUR', price_mode: 'net',
    tax_treatment: treatment, lines, issue_date: '2026-10-13', service_date: '2026-10-10', due_date: '2026-10-27',
    totals: T.computeTotals(lines, treatment), paid_cents: 0, einvoice_format: 'zugferd', created_at: '', updated_at: '', ...extra,
  };
}
const deBuyer = { name: 'Kunde GmbH', street: 'Weg 1', zip: '80331', city: 'München', country: 'DE', email: 'ap@kunde.de', buyer_reference: '04011000-12345-67' };
{
  const d = docFor('domestic', deBuyer);
  const xr = C.buildCii(d, 'xrechnung');
  check('XRechnung declares the XRechnung 3.0 CIUS', xr.includes('urn:xeinkauf.de:kosit:xrechnung_3.0'));
  check('...and the Peppol business process (mandatory in XRechnung)', xr.includes('urn:fdc:peppol.eu:2017:poacc:billing:01.0'));
  check('...and the Leitweg-ID as buyer reference', xr.includes('<ram:BuyerReference>04011000-12345-67</ram:BuyerReference>'));
  check('data is XML-escaped', xr.includes('Entwicklung &lt;Shop&gt; &amp; &quot;Checkout&quot;'));
  const parsed = EP.parseEInvoice(xr);
  check('our XML parses back: number', parsed.number === 'RE-2026-0042');
  check('our XML parses back: gross', parsed.gross_cents === d.totals.gross_cents);
  check('our XML parses back: two tax groups', parsed.groups.length === 2 && parsed.groups.find((g) => g.rate === 7).tax_cents === 279);
  check('our XML parses back: seller VAT id', parsed.seller.vat_id === 'DE123456789');
  check('our XML parses back: due date', parsed.due_date === '2026-10-27');
  const en = C.buildCii(d, 'en16931');
  check('ZUGFeRD payload uses the plain EN 16931 guideline id', en.includes('<ram:ID>urn:cen.eu:en16931:2017</ram:ID>'));

  const rc = docFor('reverse_charge_eu', { name: 'Ελληνική Α.Ε.', street: 'Ερμού 1', zip: '10563', city: 'Αθήνα', country: 'GR', email: 'a@b.gr', vat_id: 'EL123456789' });
  const rcx = C.buildCii(rc, 'en16931');
  check('reverse charge: category AE with VATEX code', rcx.includes('<ram:CategoryCode>AE</ram:CategoryCode>') && rcx.includes('VATEX-EU-AE'));
  check('reverse charge: Greek text survives', rcx.includes('Ελληνική Α.Ε.'));
  check('reverse charge needs the customer VAT id (preflight)', C.preflight({ ...rc, recipient: { ...rc.recipient, vat_id: undefined } }, 'en16931').errors.length > 0);

  const third = docFor('third_country_service', { name: 'Acme Inc.', street: '1 Main St', zip: '10001', city: 'New York', country: 'US', email: 'ap@acme.com' });
  const tx = C.buildCii(third, 'en16931');
  check('category O carries no rate (BR-O-05)', !/<ram:CategoryCode>O<\/ram:CategoryCode><ram:RateApplicablePercent>/.test(tx));
  check('category O hides the seller VAT id (BR-O-02)', !tx.includes('schemeID="VA"') && tx.includes('schemeID="FC"'));
  check('XRechnung refuses category O up front', C.preflight(third, 'xrechnung').errors.some((e) => /XRechnung cannot/.test(e)));

  check('XRechnung refuses a missing buyer email', C.preflight(docFor('domestic', { ...deBuyer, email: undefined }), 'xrechnung').errors.some((e) => /BT-49/.test(e)));
  await rejects('buildCii throws on preflight errors', () => C.buildCii(docFor('domestic', { ...deBuyer, email: undefined }), 'xrechnung'), /E-invoice cannot be generated/);

  const cn = C.buildCii({ ...d, type: 'credit_note', number: 'GS-2026-0001', refers_to_number: 'RE-2026-0042' }, 'xrechnung');
  check('credit note: type 381 and a reference to the invoice', cn.includes('<ram:TypeCode>381</ram:TypeCode>') && cn.includes('<ram:IssuerAssignedID>RE-2026-0042</ram:IssuerAssignedID>'));

  // UBL in.
  const ubl = `<?xml version="1.0"?><Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
<cbc:CustomizationID>urn:cen.eu:en16931:2017</cbc:CustomizationID><cbc:ID>INV-77</cbc:ID><cbc:IssueDate>2026-09-30</cbc:IssueDate><cbc:DueDate>2026-10-14</cbc:DueDate>
<cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>
<cac:AccountingSupplierParty><cac:Party><cbc:EndpointID schemeID="EM">billing@host.de</cbc:EndpointID><cac:PostalAddress><cbc:CityName>Berlin</cbc:CityName><cac:Country><cbc:IdentificationCode>DE</cbc:IdentificationCode></cac:Country></cac:PostalAddress>
<cac:PartyTaxScheme><cbc:CompanyID>DE999999999</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme><cac:PartyLegalEntity><cbc:RegistrationName>Host GmbH</cbc:RegistrationName></cac:PartyLegalEntity></cac:Party></cac:AccountingSupplierParty>
<cac:TaxTotal><cbc:TaxAmount currencyID="EUR">3.80</cbc:TaxAmount><cac:TaxSubtotal><cbc:TaxableAmount currencyID="EUR">20.00</cbc:TaxableAmount><cbc:TaxAmount currencyID="EUR">3.80</cbc:TaxAmount><cac:TaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>19</cbc:Percent></cac:TaxCategory></cac:TaxSubtotal></cac:TaxTotal>
<cac:LegalMonetaryTotal><cbc:TaxExclusiveAmount currencyID="EUR">20.00</cbc:TaxExclusiveAmount><cbc:TaxInclusiveAmount currencyID="EUR">23.80</cbc:TaxInclusiveAmount><cbc:PayableAmount currencyID="EUR">23.80</cbc:PayableAmount></cac:LegalMonetaryTotal>
<cac:InvoiceLine><cbc:ID>1</cbc:ID><cbc:InvoicedQuantity unitCode="MON">1</cbc:InvoicedQuantity><cbc:LineExtensionAmount currencyID="EUR">20.00</cbc:LineExtensionAmount><cac:Item><cbc:Name>VPS</cbc:Name><cac:ClassifiedTaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>19</cbc:Percent></cac:ClassifiedTaxCategory></cac:Item></cac:InvoiceLine></Invoice>`;
  const u = EP.parseEInvoice(ubl);
  check('UBL: supplier, number, totals', u.syntax === 'UBL' && u.seller.name === 'Host GmbH' && u.number === 'INV-77' && u.gross_cents === 2380 && u.tax_cents === 380);
  check('UBL: VAT group', u.groups[0].rate === 19 && u.groups[0].net_cents === 2000);
  await rejects('XML with a DOCTYPE is refused (no XXE)', () => X.parseXml('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><x>&a;</x>'), /DOCTYPE/);
  await rejects('a non-invoice XML is named as such', () => EP.parseEInvoice('<Foo/>'), /Not an e-invoice/);
}

/* ------------------------------------------------------------------ PDF + ZUGFeRD */
{
  const P = await loadTs('src/plugins/finance/lib/pdf.ts');
  const d = docFor('domestic', deBuyer);
  const xml = C.buildCii(d, 'en16931');
  const bytes = await P.renderDocumentPdf(d, seller, { fontBytes: font, xml, level: 'EN 16931', now: new Date('2026-10-13T10:00:00Z') });
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const cat = pdf.catalog;
  check('PDF: has XMP metadata', !!cat.get(PDFName.of('Metadata')));
  check('PDF: has an OutputIntent (PDF/A)', !!cat.lookupMaybe(PDFName.of('OutputIntents'), PDFArray));
  check('PDF: lists the XML in /AF', !!cat.lookupMaybe(PDFName.of('AF'), PDFArray));
  const names = cat.lookupMaybe(PDFName.of('Names'), PDFDict);
  check('PDF: has an EmbeddedFiles name tree', !!names?.lookupMaybe(PDFName.of('EmbeddedFiles'), PDFDict));
  const raw = Buffer.from(bytes).toString('latin1');
  check('PDF: XMP declares PDF/A-3B', raw.includes('<pdfaid:part>3</pdfaid:part>') && raw.includes('<pdfaid:conformance>B</pdfaid:conformance>'));
  check('PDF: XMP declares the Factur-X profile', raw.includes('<fx:ConformanceLevel>EN 16931</fx:ConformanceLevel>') && raw.includes('<fx:DocumentFileName>factur-x.xml</fx:DocumentFileName>'));
  check('PDF: the embedded file is marked Alternative', raw.includes('/AFRelationship /Alternative'));
  check('PDF: trailer has an /ID', /\/ID \[/.test(raw));
  await checkAsync('PDF: the XML can be extracted again, byte-identical', async () => (await FX.extractEmbeddedXml(bytes)) === xml);
  await checkAsync('PDF: Greek recipient renders (font is embedded, not WinAnsi)', async () => {
    const g = docFor('reverse_charge_eu', { name: 'Οπτική Γωνία', street: 'Ερμού 1', zip: '1', city: 'Αθήνα', country: 'GR', email: 'x@y.gr', vat_id: 'EL123456789' });
    return (await P.renderDocumentPdf(g, seller, { fontBytes: font })).length > 1000;
  });
  await checkAsync('PDF: a 120-line invoice paginates', async () => {
    const many = Array.from({ length: 120 }, (_, i) => ({ id: `l${i}`, type: 'item', name: `Position ${i}`, description: 'Beschreibung', quantity: 1, unit: 'HUR', unit_price_cents: 100, tax_rate: 19 }));
    const big = { ...d, lines: many, totals: T.computeTotals(many, 'domestic') };
    const out = await PDFDocument.load(await P.renderDocumentPdf(big, seller, { fontBytes: font }));
    return out.getPageCount() >= 4;
  });
  check('PDF filename cannot carry a quote', P.pdfFilename('Rechnung', 'RE"\n1') === 'Rechnung-RE1.pdf');
}

/* ------------------------------------------------------------------ bank */
const camt = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt><GrpHdr><MsgId>1</MsgId></GrpHdr><Stmt><Id>S1</Id>
<Acct><Id><IBAN>DE02120300000000202051</IBAN></Id></Acct>
<Ntry><Amt Ccy="EUR">1190.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts>BOOK</Sts><BookgDt><Dt>2026-10-20</Dt></BookgDt><ValDt><Dt>2026-10-20</Dt></ValDt><AcctSvcrRef>REF1</AcctSvcrRef>
<NtryDtls><TxDtls><Refs><EndToEndId>NOTPROVIDED</EndToEndId></Refs><RltdPties><Dbtr><Nm>Kunde GmbH</Nm></Dbtr><DbtrAcct><Id><IBAN>DE89370400440532013000</IBAN></Id></DbtrAcct></RltdPties>
<RmtInf><Ustrd>Rechnung RE-2026-0001 vielen Dank</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>
<Ntry><Amt Ccy="EUR">23.80</Amt><CdtDbtInd>DBIT</CdtDbtInd><Sts>BOOK</Sts><BookgDt><Dt>2026-10-21</Dt></BookgDt><AcctSvcrRef>REF2</AcctSvcrRef>
<NtryDtls><TxDtls><RltdPties><Cdtr><Nm>Host GmbH</Nm></Cdtr></RltdPties><RmtInf><Ustrd>INV-77</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>
<Ntry><Amt Ccy="EUR">5.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><Sts>PDNG</Sts><BookgDt><Dt>2026-10-22</Dt></BookgDt></Ntry>
</Stmt></BkToCstmrStmt></Document>`;
const mt940 = `:20:STARTUMS
:25:DE02120300000000202051
:28C:00001/001
:60F:C261019EUR1000,00
:61:2610201020CR1190,00NTRFNONREF//BANKREF1
:86:166?00GUTSCHRIFT?20EREF+NOTPROVIDED?21SVWZ+Rechnung RE-2026-00?2201 danke?30BYLADEM1001?31DE89370400440532013000?32Kunde GmbH
:61:2610211021DR23,80NTRFNONREF
:86:105?00LASTSCHRIFT?20SVWZ+INV-77?32Host GmbH
:62F:C261021EUR2166,20
-`;
const csv = `Kontoinhaber;Max
\nBuchungstag;Valutadatum;Name Zahlungsbeteiligter;IBAN Zahlungsbeteiligter;Verwendungszweck;Betrag;Währung
20.10.2026;20.10.2026;Kunde GmbH;DE89370400440532013000;"Rechnung RE-2026-0001; danke";1.190,00;EUR
21.10.2026;21.10.2026;Host GmbH;;INV-77;-23,80;EUR`;
{
  for (const [label, content] of [['camt.053', camt], ['MT940', mt940], ['CSV', csv]]) {
    const st = B.parseStatement(content);
    const inc = st.transactions.find((t) => t.amount_cents > 0);
    const out = st.transactions.find((t) => t.amount_cents < 0);
    check(`${label}: two booked transactions`, st.transactions.length === 2);
    check(`${label}: money in is positive 1190.00`, inc?.amount_cents === 119000 && inc.booking_date === '2026-10-20');
    check(`${label}: money out is negative 23.80`, out?.amount_cents === -2380);
    check(`${label}: counterparty name`, inc?.counterparty_name === 'Kunde GmbH');
    check(`${label}: purpose holds the invoice number`, /RE-2026-0001/.test(inc?.purpose ?? ''));
    check(`${label}: fingerprints are stable`, B.parseStatement(content).transactions[0].fingerprint === st.transactions[0].fingerprint);
  }
  check('camt: pending entries are skipped', B.parseCamt053(camt).transactions.every((t) => t.amount_cents !== -500));
  check('camt: account IBAN is read', B.parseCamt053(camt).iban === 'DE02120300000000202051');
  check('MT940: counterparty IBAN from ?31', B.parseMt940(mt940).transactions[0].counterparty_iban === 'DE89370400440532013000');

  const items = [
    { kind: 'document', id: 'd1', number: 'RE-2026-0001', name: 'Kunde GmbH', open_cents: 119000, date: '2026-10-13' },
    { kind: 'document', id: 'd2', number: 'RE-2026-0002', name: 'Kunde GmbH', open_cents: 119000, date: '2026-10-14' },
    { kind: 'expense', id: 'e1', number: 'INV-77', name: 'Host GmbH', open_cents: 2380, date: '2026-09-30' },
  ];
  const tx = B.parseCamt053(camt).transactions;
  const s1 = M.suggestMatches(tx[0], items);
  check('matching: the invoice named in the purpose wins', s1[0].id === 'd1' && s1[0].score >= M.AUTO_MATCH_SCORE);
  check('matching: auto-match only when exactly one is certain', M.autoMatch(s1)?.id === 'd1');
  check('matching: money out is matched to expenses only', M.suggestMatches(tx[1], items).every((s) => s.kind === 'expense'));
  const noRef = { ...tx[0], purpose: 'Zahlung', counterparty_iban: undefined };
  check('matching: two equal invoices without a number are NOT auto-matched', M.autoMatch(M.suggestMatches(noRef, items)) === null);
  check('matching: a loosely written number still matches', M.suggestMatches({ ...tx[0], purpose: 'RE 2026 1' }, items)[0]?.id === 'd1');
}

{
  check('German "1.500" is one thousand five hundred', F.parseAmountToCents('1.500') === 150000);
  check('machine decimals stay decimals in XML/camt', F.decimalToCents('1.500') === 150 && F.decimalToCents('1190.00') === 119000);
  const rv = B.parseCamt053(`<Document><BkToCstmrStmt><Stmt><Ntry><Amt Ccy="EUR">50.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><RvslInd>true</RvslInd><Sts>BOOK</Sts><BookgDt><Dt>2026-10-01</Dt></BookgDt></Ntry></Stmt></BkToCstmrStmt></Document>`);
  check('camt: a DBIT reversal is money out (CdtDbtInd decides)', rv.transactions[0].amount_cents === -5000);
  const twin = B.parseStatement('Buchungstag;Verwendungszweck;Betrag\n01.10.2026;AMAZON;-9,99\n01.10.2026;AMAZON;-9,99');
  check('two identical bank rows in one file stay two', twin.transactions.length === 2 && twin.transactions[0].fingerprint !== twin.transactions[1].fingerprint);
  check('...and re-parsing gives the same fingerprints', B.parseStatement('Buchungstag;Verwendungszweck;Betrag\n01.10.2026;AMAZON;-9,99\n01.10.2026;AMAZON;-9,99').transactions[1].fingerprint === twin.transactions[1].fingerprint);
}

/* ------------------------------------------------------------------ DATEV */
{
  const header = D.headerLine({ consultant: 1001, client: 1, fiscalYearStart: '2026-01-01', accountLength: 4, from: '2026-10-01', to: '2026-10-31', label: 'Okt', chart: 'SKR03', createdAt: new Date('2026-10-31T12:00:00Z') });
  check('DATEV header has 31 fields', header.split(';').length === 31);
  check('DATEV header starts EXTF 700 / 21 / Buchungsstapel / 13', header.startsWith('"EXTF";700;21;"Buchungsstapel";13;'));
  check('DATEV header: 17-digit timestamp', /;20261031120000000;/.test(header));
  check('DATEV header names the chart', header.includes(';"03";'));
  check('125 Buchungsstapel columns', D.BUCHUNGSSTAPEL_COLUMNS.length === 125);
  const row = D.bookingRow({ amount_cents: 119000, sh: 'S', account: 10001, contra: 8400, date: '2026-10-05', doc_no: 'RE-2026_0042', text: 'RE Kunde "GmbH"', service_date: '2026-10-01' });
  const cells = row.split(';');
  check('every row has 125 cells', cells.length === 125);
  check('amount has a decimal comma and no sign', cells[0] === '1190,00');
  check('Belegdatum is DDMM', cells[9] === '0510');
  check('Belegfeld 1 is stripped to DATEV characters', cells[10] === '"RE-20260042"');
  check('quotes are doubled', cells[13] === '"RE Kunde ""GmbH"""');
  check('Leistungsdatum is DDMMYYYY', cells[D.BUCHUNGSSTAPEL_COLUMNS.indexOf('Leistungsdatum')] === '01102026');
  const file = D.buildBuchungsstapel({ consultant: 1001, client: 1, fiscalYearStart: '2026-01-01', accountLength: 4, from: '2026-10-01', to: '2026-10-31', label: 'x', chart: 'SKR03' },
    [{ amount_cents: 100, sh: 'S', account: 1, contra: 2, date: '2026-10-02', doc_no: 'A', text: 't' }]);
  check('DATEV file ends with CRLF', file.endsWith('\r\n') && !/[^\r]\n/.test(file));
  await rejects('a booking outside the period is refused', () => D.buildBuchungsstapel({ consultant: 1, client: 1, fiscalYearStart: '2026-01-01', accountLength: 4, from: '2026-10-01', to: '2026-10-31', label: 'x', chart: 'SKR03' },
    [{ amount_cents: 1, sh: 'S', account: 1, contra: 2, date: '2026-11-01', doc_no: 'A', text: 't' }]), /outside/);
  const enc = D.encodeCp1252('Müller € Straße Ω');
  check('CP1252: ü, ß and € map to single bytes', enc[1] === 0xfc && enc.includes(0x80) && enc.includes(0xdf));
  check('CP1252: characters outside it become ?', enc[enc.length - 1] === 0x3f);
  check('Greek names are transliterated, Latin accents kept', D.latinize('Οπτική Γωνία Café') === 'Optiki Gonia Café');
}

/* ------------------------------------------------------------------ reports */
{
  const inv = docFor('domestic', deBuyer, { contact_id: 'c1' });
  const rc = docFor('reverse_charge_eu', { name: 'GR', country: 'GR', vat_id: 'EL1' }, { id: 'doc_2', number: 'RE-2026-0043' });
  const cn = { ...docFor('domestic', deBuyer), id: 'doc_3', type: 'credit_note', number: 'GS-2026-0001', issue_date: '2026-10-20' };
  const draft = { ...docFor('domestic', deBuyer), id: 'doc_4', status: 'draft', number: undefined };
  const expenses = [
    { id: 'e1', status: 'open', supplier_name: 'Host', date: '2026-10-02', lines: [{ category: 'hosting', net_cents: 2000, tax_rate: 19, tax_cents: 380 }], net_cents: 2000, tax_cents: 380, gross_cents: 2380, paid_cents: 0, currency: 'EUR', source: 'manual' },
    { id: 'e2', status: 'paid', supplier_name: 'Google Ireland', supplier_country: 'IE', reverse_charge: true, date: '2026-10-03', lines: [{ category: 'advertising', net_cents: 10000, tax_rate: 19, tax_cents: 0 }], net_cents: 10000, tax_cents: 0, gross_cents: 10000, paid_cents: 10000, paid_date: '2026-10-03', currency: 'EUR', source: 'manual' },
  ];
  const v = R.vatReturn({ from: '2026-10-01', to: '2026-10-31' }, 'soll', [inv, rc, cn, draft], [], expenses);
  check('VAT return: invoice minus credit note nets out Kz 81', v.kz['81'] === 0);
  check('VAT return: reverse-charge sale in Kz 21', v.kz['21'] === rc.totals.net_cents);
  check('VAT return: input tax Kz 66', v.kz['66'] === 380);
  check('VAT return: §13b purchase from IE in Kz 46/47 and deducted in Kz 67', v.kz['46'] === 10000 && v.kz['47'] === 1900 && v.kz['67'] === 1900);
  check('VAT return: drafts are ignored', !JSON.stringify(v).includes('doc_4'));
  check('VAT return: payable = VAT − input tax', v.payable_cents === v.kz['81_tax'] + v.kz['86_tax'] + v.kz['47'] + v.kz['85'] - v.kz['66'] - v.kz['67']);
  const ist = R.vatReturn({ from: '2026-10-01', to: '2026-10-31' }, 'ist', [inv], [{ id: 'p', document_id: inv.id, amount_cents: Math.round(inv.totals.gross_cents / 2), date: '2026-10-25', method: 'bank' }], []);
  check('VAT return (Ist): half paid → half the base', Math.abs(ist.kz['81'] - Math.round(inv.totals.groups[0].net_cents / 2)) <= 1);

  const pl = R.profitLoss({ from: '2026-01-01', to: '2026-12-31' }, [inv, cn], expenses);
  check('P&L: credit note reduces revenue', pl.revenue_net_cents === 0);
  check('P&L: expenses by category', pl.expenses_by_category.hosting === 2000 && pl.expenses_by_category.advertising === 10000);

  const oi = R.openItems([inv, cn], expenses, '2026-11-15');
  const recv = oi.find((i) => i.id === inv.id);
  check('open items: overdue days are counted from the due date', recv.days_overdue === 19);
  check('open items: unpaid expense is a payable', oi.some((i) => i.kind === 'payable' && i.id === 'e1'));

  const ctx = { chart: 'SKR03', settings: { account_overrides: {}, datev_use_personal_accounts: true }, contacts: new Map([['c1', { id: 'c1', datev_account: 10007 }]]), bankAccounts: new Map() };
  const { bookings, warnings } = R.datevBookings({ from: '2026-10-01', to: '2026-10-31' }, ctx, [inv, rc, cn], [{ id: 'p1', document_id: inv.id, amount_cents: 1000, date: '2026-10-25', method: 'bank' }], expenses, []);
  const revenue = bookings.filter((b) => b.doc_no === 'RE-2026-0042');
  check('DATEV: one booking per tax group, gross on the Automatikkonto', revenue.length === 3 && revenue.some((b) => b.contra === 8400 && b.amount_cents === 95000 + 18050) && revenue.some((b) => b.contra === 8300));
  check('DATEV: invoice debits the customer\'s personal account', revenue.find((b) => b.contra === 8400).account === 10007 && revenue.find((b) => b.contra === 8400).sh === 'S');
  check('DATEV: no BU key on an Automatikkonto', revenue.every((b) => !b.bu));
  check('DATEV: reverse-charge revenue goes to 8336 with the EU VAT id', bookings.some((b) => b.contra === 8336 && b.eu_vat_id === 'EL1'));
  check('DATEV: credit note is booked Haben', bookings.filter((b) => b.doc_no === 'GS-2026-0001').every((b) => b.sh === 'H'));
  check('DATEV: expense on 4806 with BU 9', bookings.some((b) => b.account === 4806 && b.bu === '9' && b.amount_cents === 2380));
  check('DATEV: §13b purchase is booked net with the RC key, and flagged', bookings.some((b) => b.account === 4600 && b.amount_cents === 10000 && b.bu === '94') && warnings.some((w) => /reverse-charge/.test(w)));
  check('DATEV: payment debits the bank (1200)', bookings.some((b) => b.account === 1200 && b.contra === 10007 && b.amount_cents === 1000));
  const cnPaid = { ...cn, contact_id: 'c1' };
  const refund = R.datevBookings({ from: '2026-10-01', to: '2026-10-31' }, ctx, [cnPaid], [{ id: 'r', document_id: cnPaid.id, amount_cents: 5000, date: '2026-10-22', method: 'bank' }], [], []);
  check('DATEV: a refund on a credit note credits the bank (money out)', refund.bookings.some((b) => b.account === 1200 && b.sh === 'H' && b.amount_cents === 5000));
  const istRefund = R.vatReturn({ from: '2026-10-01', to: '2026-10-31' }, 'ist', [inv], [{ id: 'a', document_id: inv.id, amount_cents: inv.totals.gross_cents, date: '2026-10-05', method: 'bank' }, { id: 'b', document_id: inv.id, amount_cents: -inv.totals.gross_cents, date: '2026-10-06', method: 'bank' }], []);
  check('VAT return (Ist): a refund takes the VAT back out', istRefund.kz['81'] === 0 && istRefund.payable_cents === 0);
  const feeTx = [{ id: 't1', account_id: 'x', booking_date: '2026-10-31', amount_cents: -11900, purpose: 'Abo', status: 'matched', category: 'software', fingerprint: 'f', currency: 'EUR' }];
  const fee = R.datevBookings({ from: '2026-10-01', to: '2026-10-31' }, ctx, [], [], [], feeTx);
  check('DATEV: a receipt-less bank booking claims no input tax', fee.bookings[0].bu === '' && fee.bookings[0].amount_cents === 11900);
  check('P&L: ...and counts as a cost', R.profitLoss({ from: '2026-10-01', to: '2026-10-31' }, [], [], feeTx).expenses_by_category.software === 11900);
  const odd = { ...inv, id: 'odd', number: 'RE-ODD', totals: T.computeTotals([{ id: 'z', type: 'item', name: 'x', quantity: 1, unit: 'C62', unit_price_cents: 100, tax_rate: 20 }], 'domestic') };
  const oddB = R.datevBookings({ from: '2026-10-01', to: '2026-10-31' }, ctx, [odd], [], [], []);
  check('DATEV: an unmapped rate is flagged, not a crashed export', oddB.bookings.length === 1 && oddB.warnings.some((w) => /RE-ODD/.test(w)));
  const ov = R.datevBookings({ from: '2026-10-01', to: '2026-10-31' }, { ...ctx, settings: { account_overrides: { 'exp:hosting': 4964 }, datev_use_personal_accounts: false } }, [], [], expenses, []);
  check('DATEV: account overrides apply', ov.bookings.some((b) => b.account === 4964));
  check('DATEV: without personal accounts the default Debitor/Kreditor is used', ov.bookings.every((b) => b.contra === 70000 || b.account === 70000 || b.contra !== 70001));
}

/* ------------------------------------------------------------------ zip */
{
  const z = Z.buildZip([{ name: 'a.txt', data: new TextEncoder().encode('hello hello hello hello') }, { name: 'a.txt', data: new Uint8Array([1, 2, 3]) }, { name: '../x.pdf', data: new Uint8Array([4]) }]);
  const b = Buffer.from(z);
  check('zip: starts with a local header', b.readUInt32LE(0) === 0x04034b50);
  const eocd = b.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  check('zip: end record counts 3 entries', eocd > 0 && b.readUInt16LE(eocd + 10) === 3);
  check('zip: duplicate names are suffixed, traversal is stripped', b.includes(Buffer.from('a-2.txt')) && !b.includes(Buffer.from('../')));
  check('zip: CRC-32 of "123456789" is CBF43926', Z.crc32(new TextEncoder().encode('123456789')) === 0xcbf43926);
}

/* ------------------------------------------------------------------ email attachments */
{
  const mime = MIME.buildMimeMessage({ from: 'a@b.de', to: 'c@d.de', subject: 'Rechnung', text: 'Hallo', messageId: 'm1@b', attachments: [{ filename: 'Rechnung-RE1.pdf', contentType: 'application/pdf', content: new Uint8Array([37, 80, 68, 70]) }, { filename: 'Ü"bel\r\n.xml', contentType: 'bad type', content: new Uint8Array([60]) }] });
  check('mail with attachments is multipart/mixed', /Content-Type: multipart\/mixed; boundary="/.test(mime));
  check('attachment is named and base64', mime.includes('Content-Disposition: attachment; filename="Rechnung-RE1.pdf"') && mime.includes('JVBERg=='));
  check('a hostile filename cannot split a header', !/\r\n\.xml/.test(mime) && mime.includes("filename*=UTF-8''"));
  check('a bogus content type falls back to octet-stream', mime.includes('Content-Type: application/octet-stream;'));
  const plain = MIME.buildMimeMessage({ from: 'a@b.de', to: 'c@d.de', subject: 'x', text: 'y' });
  check('mail without attachments is unchanged (text/plain)', /Content-Type: text\/plain; charset=utf-8/.test(plain) && !plain.includes('multipart'));
}

/* ------------------------------------------------------------------ service */
function memoryStore() {
  const data = new Map();
  const ns = (c) => { if (!data.has(c)) data.set(c, new Map()); return data.get(c); };
  return {
    data,
    async list(c) { return [...ns(c)].map(([id, d]) => ({ id, data: JSON.parse(JSON.stringify(d)) })); },
    async get(c, id) { const v = ns(c).get(id); return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); },
    async put(c, id, d) { ns(c).set(id, JSON.parse(JSON.stringify(d))); return d; },
    async delete(c, id) { ns(c).delete(id); },
    async clear(c) { ns(c).clear(); },
  };
}
{
  const store = memoryStore();
  const events = [];
  const mails = [];
  let clock = new Date('2026-10-13T09:00:00Z');
  const fin = new S.Finance(store, {
    fontBytes: async () => font, fire: (e, d) => events.push([e, d]),
    sendEmail: async (m) => { mails.push(m); }, siteUrl: async () => 'https://cms.example.com', now: () => clock,
  });
  const A = 'tester@example.com';
  await fin.saveCompany(seller, A);
  const cust = await fin.createContact({ company_name: 'Kunde GmbH', email: 'ap@kunde.de', billing_address: { street: 'Weg 1', zip: '80331', city: 'München', country: 'DE' } }, A);
  check('service: customer number assigned from 10001', cust.customer_number === '10001' && cust.datev_account === 10001);

  const draft = await fin.createDocument({ type: 'invoice', contact_id: cust.id, lines: [{ name: 'Beratung', quantity: 2, unit: 'HUR', unit_price: '120,00', tax_rate: 19 }], status: 'paid', number: 'HACK-1', totals: { gross_cents: 1 } }, A);
  check('service: a draft has no number and status draft, whatever the body said', draft.status === 'draft' && !draft.number && draft.totals.gross_cents === 28560);
  check('service: recipient copied from the contact', draft.recipient.name === 'Kunde GmbH' && draft.recipient.email === 'ap@kunde.de');
  check('service: treatment suggested from the customer', draft.tax_treatment === 'domestic');

  const inv = await fin.finalize(draft.id, A);
  check('service: finalize assigns RE-2026-0001', inv.number === 'RE-2026-0001' && inv.status === 'open');
  check('service: due date = issue + 14', inv.issue_date === '2026-10-13' && inv.due_date === '2026-10-27');
  check('service: seller is frozen into the document', inv.seller.name === seller.name);
  check('service: PDF archived (ZUGFeRD)', !!inv.archived_pdf_id && !inv.archived_xml_id);
  check('service: public token and content hash set', inv.public_token.length >= 32 && /^[0-9a-f]{64}$/.test(inv.content_hash));
  check('service: invoice.finalized fired', events.some(([e]) => e === 'invoice.finalized'));
  await checkAsync('service: archived PDF carries the e-invoice', async () => {
    const { bytes } = await fin.documentPdf(inv.id);
    const xml = await FX.extractEmbeddedXml(bytes);
    return !!xml && xml.includes('<ram:ID>RE-2026-0001</ram:ID>');
  });
  await rejects('service: a finalized invoice cannot be edited', () => fin.updateDocument(inv.id, { lines: [] }, A), /finalized/);
  await rejects('service: a finalized invoice cannot be deleted', () => fin.deleteDraft(inv.id, A), /Only drafts/);
  await rejects('service: finalize twice is refused', () => fin.finalize(inv.id, A), /Already/);
  await checkAsync('service: internal note is still editable', async () => (await fin.updateDocument(inv.id, { internal_note: 'call Friday' }, A)).internal_note === 'call Friday');

  // Concurrency: two finalizations at once must draw different numbers.
  const d2 = await fin.createDocument({ contact_id: cust.id, lines: [{ name: 'A', quantity: 1, unit_price_cents: 100 }] }, A);
  const d3 = await fin.createDocument({ contact_id: cust.id, lines: [{ name: 'B', quantity: 1, unit_price_cents: 100 }] }, A);
  const [f2, f3] = await Promise.all([fin.finalize(d2.id, A), fin.finalize(d3.id, A)]);
  check('service: concurrent finalizations get distinct numbers', f2.number !== f3.number && [f2.number, f3.number].sort().join() === 'RE-2026-0002,RE-2026-0003');

  // Payment, partial then full.
  const p1 = await fin.recordPayment(inv.id, { amount: '100,00', date: '2026-10-20' }, A);
  check('service: partial payment → partially_paid', p1.document.status === 'partially_paid' && p1.document.paid_cents === 10000);
  const p2 = await fin.recordPayment(inv.id, { date: '2026-10-21' }, A);
  check('service: paying the rest → paid, invoice.paid fired', p2.document.status === 'paid' && events.some(([e]) => e === 'invoice.paid'));
  const back = await fin.deletePayment(p2.payment.id, A);
  check('service: removing a payment reopens the invoice', back.status === 'partially_paid');

  // Cancel → credit note offsets what is open.
  const { invoice: cancelled, credit_note: cn } = await fin.cancelInvoice(f2.id, A, 'Doppelt berechnet');
  check('service: cancel creates a finalized credit note', cn.type === 'credit_note' && cn.number === 'GS-2026-0001' && cn.refers_to_number === f2.number);
  check('service: the cancelled invoice is cancelled and offset', cancelled.status === 'cancelled' && cancelled.paid_cents === cancelled.totals.gross_cents);
  check('service: the credit note is settled by the offset', cn.status === 'paid');

  // Send by email with the PDF attached.
  const sent = await fin.sendDocument(inv.id, {}, A);
  check('service: send emails the PDF as an attachment', mails.length === 1 && mails[0].attachments[0].filename === 'Rechnung-RE-2026-0001.pdf' && mails[0].to === 'ap@kunde.de');
  check('service: the email holds the customer link', mails[0].text.includes(`https://cms.example.com/api/plugin/finance/public/${inv.id}/`));
  check('service: sent_at recorded', !!sent.sent_at);

  // Quote → invoice.
  const q = await fin.finalize((await fin.createDocument({ type: 'quote', contact_id: cust.id, lines: [{ name: 'Shop-Relaunch', quantity: 1, unit_price_cents: 500000 }] }, A)).id, A);
  check('service: quotes number separately', q.number === 'AN-2026-0001' && !q.archived_xml_id);
  await fin.setQuoteStatus(q.id, 'accepted', A);
  const fromQuote = await fin.quoteToInvoice(q.id, A);
  check('service: accepted quote becomes an invoice draft', fromQuote.type === 'invoice' && fromQuote.status === 'draft' && fromQuote.totals.net_cents === 500000);
  await rejects('service: a quote cannot be invoiced twice', () => fin.quoteToInvoice(q.id, A), /already/);

  // XRechnung customer: XML archived separately.
  const authority = await fin.createContact({ company_name: 'Stadt Augsburg', email: 'erechnung@augsburg.de', buyer_reference: '09761000-ABC-12', einvoice_format: 'xrechnung', billing_address: { street: 'Rathausplatz 1', zip: '86150', city: 'Augsburg', country: 'DE' } }, A);
  const xr = await fin.finalize((await fin.createDocument({ contact_id: authority.id, lines: [{ name: 'Wartung', quantity: 1, unit: 'MON', unit_price_cents: 14900 }] }, A)).id, A);
  check('service: XRechnung customer → XML archived', !!xr.archived_xml_id);
  await checkAsync('service: archived XRechnung carries the Leitweg-ID', async () => (await fin.documentXml(xr.id)).xml.includes('09761000-ABC-12'));

  // A Kleinunternehmer mismatch is an error, not a warning.
  const sb = await fin.createDocument({ contact_id: cust.id, tax_treatment: 'small_business', lines: [{ name: 'x', quantity: 1, unit_price_cents: 100 }] }, A);
  check('service: §19 on a VAT-registered company is refused at check', (await fin.check(sb.id)).errors.some((e) => /Kleinunternehmer/.test(e)));
  await fin.deleteDraft(sb.id, A);

  // Bank import + auto match.
  const acct = await fin.saveBankAccount(null, { name: 'Sparkasse', iban: 'DE02120300000000202051' }, A);
  const stmt = `<?xml version="1.0"?><Document><BkToCstmrStmt><Stmt><Acct><Id><IBAN>DE02120300000000202051</IBAN></Id></Acct>
<Ntry><Amt Ccy="EUR">${(f3.totals.gross_cents / 100).toFixed(2)}</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts>BOOK</Sts><BookgDt><Dt>2026-10-22</Dt></BookgDt><AcctSvcrRef>X1</AcctSvcrRef>
<NtryDtls><TxDtls><RltdPties><Dbtr><Nm>Kunde GmbH</Nm></Dbtr></RltdPties><RmtInf><Ustrd>${f3.number}</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>
<Ntry><Amt Ccy="EUR">4.90</Amt><CdtDbtInd>DBIT</CdtDbtInd><Sts>BOOK</Sts><BookgDt><Dt>2026-10-31</Dt></BookgDt><AcctSvcrRef>X2</AcctSvcrRef><AddtlNtryInf>Kontofuehrung</AddtlNtryInf></Ntry>
</Stmt></BkToCstmrStmt></Document>`;
  const imp = await fin.importStatement(acct.id, stmt, A);
  check('service: statement imported, one payment auto-matched', imp.imported === 2 && imp.auto_matched === 1);
  check('service: the auto-matched invoice is paid', (await fin.getDocument(f3.id)).status === 'paid');
  const again = await fin.importStatement(acct.id, stmt, A);
  check('service: re-importing the same statement adds nothing', again.imported === 0 && again.duplicates === 2);
  await rejects('service: a statement for another IBAN is refused', () => fin.importStatement(acct.id, stmt.replace(/DE02120300000000202051/, 'DE89370400440532013000'), A), /not for/);
  const fee = (await fin.listBankTx('2026')).find((t) => t.amount_cents === -490);
  await fin.categorizeBankTx(fee.id, { category: 'bank_fees' }, A);
  check('service: a bank fee can be booked without a receipt', (await fin.listBankTx('2026')).find((t) => t.id === fee.id).status === 'matched');
  const un = await fin.unmatchBankTx((await fin.listBankTx('2026')).find((t) => t.amount_cents > 0).id, A);
  check('service: unmatching reopens the invoice', un.status === 'unmatched' && (await fin.getDocument(f3.id)).status === 'open');

  // Incoming e-invoice → expense.
  const upl = await fin.uploadReceipt(new TextEncoder().encode(EP && `<?xml version="1.0"?>${C.buildCii({ ...docFor('domestic', { name: 'Dimitriou', street: 'x', zip: '1', city: 'y', country: 'DE', email: 'me@x.de' }), seller: { ...seller, name: 'Host GmbH', vat_id: 'DE999999999' } }, 'en16931').replace(/^<\?xml[^>]*\?>\n?/, '')}`), 'host.xml', A);
  check('service: an incoming XRechnung/ZUGFeRD XML becomes a complete expense', upl.parsed && upl.expense.supplier_name === 'Host GmbH' && upl.expense.gross_cents === docFor('domestic', deBuyer).totals.gross_cents && upl.expense.status === 'open');
  check('service: the e-invoice XML is archived with it', !!upl.expense.xml_file_id);
  const dup = await fin.uploadReceipt(new TextEncoder().encode(EP && `<?xml version="1.0"?>${C.buildCii({ ...docFor('domestic', { name: 'Dimitriou', street: 'x', zip: '1', city: 'y', country: 'DE', email: 'me@x.de' }), seller: { ...seller, name: 'Host GmbH', vat_id: 'DE999999999' } }, 'en16931').replace(/^<\?xml[^>]*\?>\n?/, '')}`), 'host.xml', A);
  check('service: the same receipt uploaded twice is recognised', dup.duplicate === true);
  await rejects('service: our own invoice uploaded as an expense is refused', async () => {
    const own = C.buildCii(docFor('domestic', deBuyer), 'en16931');
    await fin.uploadReceipt(new TextEncoder().encode(own + ' '), 'own.xml', A);
  }, /issued BY your company/);
  const photo = await fin.uploadReceipt(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]), 'tankquittung.jpg', A);
  check('service: a photo becomes a draft expense with the file attached', photo.expense.status === 'draft' && !!photo.expense.file_id);
  const booked = await fin.saveExpense(photo.expense.id, { status: 'paid', lines: [{ category: 'vehicle', gross: '59,50', tax_rate: 19 }] }, A);
  check('service: the draft is completed from the gross amount', booked.net_cents === 5000 && booked.tax_cents === 950 && booked.status === 'paid');
  await rejects('service: a booked expense\'s supplier cannot change', () => fin.saveExpense(booked.id, { supplier_name: 'Other' }, A), /booked/);

  // Recurring.
  clock = new Date('2026-12-02T09:00:00Z');
  const rec = await fin.saveRecurring(null, { name: 'Wartung', contact_id: cust.id, interval: 'monthly', next_date: '2026-10-01', auto_finalize: true, lines: [{ name: 'Wartungsvertrag', quantity: 1, unit: 'MON', unit_price_cents: 14900 }] }, A);
  const r1 = await fin.runRecurring(A);
  check('service: recurring catches up every missed month (Oct, Nov, Dec)', r1.created.length === 3 && !r1.errors.length);
  const r2 = await fin.runRecurring(A);
  check('service: running again creates nothing', r2.created.length === 0);
  const recDocs = (await fin.listDocuments({ type: 'invoice' })).filter((d) => d.recurring_id === rec.id);
  check('service: each recurring invoice carries its billing period', recDocs.some((d) => d.lines[0].period_start === '2026-11-01' && d.lines[0].period_end === '2026-11-30'));

  // Dunning.
  const dun = await fin.dunningSuggestions();
  check('service: overdue invoices are suggested for dunning', dun.some((s) => s.document.id === inv.id && s.next_level >= 1));
  const dn = await fin.createDunning(inv.id, { send: true }, A);
  check('service: a dunning letter is archived and emailed', !!dn.pdf_id && dn.document.dunning_level === 1 && mails.some((m) => /Zahlungserinnerung/.test(m.subject)));
  check('service: no second letter within a week', !(await fin.dunningSuggestions()).some((s) => s.document.id === inv.id));

  // Inbound sale: idempotent.
  const sale = { source: 'licence-center', external_id: 'lic_42', customer: { company_name: 'Acme SaaS GmbH', email: 'billing@acme.de', address: { street: 'A 1', zip: '10115', city: 'Berlin', country: 'DE' } }, lines: [{ name: 'askTheodor Pro — Jahreslizenz', quantity: 1, unit: 'ANN', unit_price_cents: 119000, tax_rate: 19 }], paid: { method: 'stripe', reference: 'pi_123' } };
  const s1 = await fin.inboundSale(sale, 'api');
  const s2 = await fin.inboundSale(sale, 'api');
  check('service: inbound sale creates a paid, finalized invoice', s1.created && s1.document.status === 'paid' && s1.document.totals.gross_cents === 119000);
  check('service: the same sale delivered twice is one invoice', !s2.created && s2.document.id === s1.document.id);
  check('service: gross prices from a checkout are split correctly', s1.document.totals.net_cents === 100000);
  await rejects('service: inbound sale without external_id is refused', () => fin.inboundSale({ ...sale, external_id: undefined }, 'api'), /required/);

  // Review findings, pinned.
  const dupSale = { ...sale, external_id: 'lic_race' };
  const [ra, rb] = await Promise.all([fin.inboundSale(dupSale, 'api'), fin.inboundSale(dupSale, 'api')]);
  check('race: two concurrent identical sales are ONE invoice', ra.document.id === rb.document.id && [ra.created, rb.created].filter(Boolean).length === 1);
  const oss = await fin.createDocument({ contact_id: cust.id, lines: [{ name: 'x', quantity: 1, unit_price_cents: 100, tax_rate: 20 }] }, A);
  check('a foreign VAT rate (OSS) is refused at check', (await fin.check(oss.id)).errors.some((e) => /OSS/.test(e)));
  await fin.deleteDraft(oss.id, A);
  const usd = await fin.createDocument({ contact_id: cust.id, currency: 'USD', lines: [{ name: 'x', quantity: 1, unit_price_cents: 100 }] }, A);
  check('a non-EUR document is refused at check', (await fin.check(usd.id)).errors.some((e) => /EUR/.test(e)));
  await fin.deleteDraft(usd.id, A);
  await rejects('a booked expense cannot go back to draft', () => fin.saveExpense(booked.id, { status: 'draft' }, A), /draft/);
  await rejects('a booked expense\'s amounts cannot change', () => fin.saveExpense(booked.id, { lines: [{ category: 'vehicle', gross: '1,00', tax_rate: 19 }] }, A), /amounts/);
  check('a booked expense can still be re-categorised', (await fin.saveExpense(booked.id, { lines: [{ category: 'travel', net_cents: 5000, tax_cents: 950, tax_rate: 19 }] }, A)).lines[0].category === 'travel');
  const [c1, c2] = await Promise.all([fin.cancelInvoice(f3.id, A), fin.cancelInvoice(f3.id, A)]);
  check('race: cancelling twice at once issues ONE credit note', c1.credit_note.id === c2.credit_note.id);

  // Shop order mapping.
  const order = { id: 'ord_1', number: 'OG-1', status: 'completed', currency: 'EUR', total_cents: 2380 + 595, email: 'k@x.de', name: 'Maria Papadopoulou', items: [],
    line_totals: [{ product_id: 'p', name: 'Mug', qty: 2, unit_price_cents: 1190, line_subtotal_cents: 2380, discount_cents: 0, net_cents: 2000, tax_cents: 380, tax_rate_bp: 1900, total_cents: 2380 }],
    shipping_tax_cents: 95, shipping_method_name: 'DHL', billing_address: { line1: 'Str 1', postcode: '86150', city: 'Augsburg', country: 'de' } };
  const os1 = SH.orderToSale(order);
  check('shop: order → sale with lines and shipping', os1.lines.length === 2 && os1.lines[1].unit_price_cents === 595 && os1.lines[1].tax_rate === 19);
  check('shop: idempotency key is the order id', os1.source === 'shop' && os1.external_id === 'ord_1');
  check('shop: person name split', os1.customer.first_name === 'Maria' && os1.customer.last_name === 'Papadopoulou');
  const shopInv = await fin.inboundSale(os1, 'shop');
  check('shop: the order invoice totals the order', shopInv.document.totals.gross_cents === order.total_cents && shopInv.document.status === 'paid');

  // Log chain.
  const year = '2026';
  const v1 = await fin.verifyLog(year);
  check('log: the chain verifies', v1.ok && v1.entries > 20);
  const logCol = store.data.get(`log_${year}`);
  const [firstId, first] = [...logCol][3];
  logCol.set(firstId, { ...first, summary: 'tampered' });
  const v2 = await fin.verifyLog(year);
  check('log: an altered entry breaks the chain', !v2.ok && v2.broken_at === firstId);
  logCol.set(firstId, first);
  const lastId = [...logCol.keys()].sort().at(-1);
  const last = logCol.get(lastId);
  logCol.delete(lastId);
  check('log: a deleted newest entry is detected against the head', !(await fin.verifyLog(year)).ok);
  logCol.set(lastId, last);
  check('log: restored, the chain verifies again', (await fin.verifyLog(year)).ok);

  // Settings validation.
  await rejects('settings: a bad number pattern is refused', () => fin.saveSettings({ series: { invoice: { pattern: 'RE-{YYYY}' } } }, A), /SEQ/);
  const st = await fin.saveSettings({ account_overrides: { 'exp:software': '4964', 'evil': 1, 'rev:domestic:19': 0 } }, A);
  check('settings: only well-formed overrides are kept', st.account_overrides['exp:software'] === 4964 && !('evil' in st.account_overrides) && !('rev:domestic:19' in st.account_overrides));

  // Lexware import against a fake API.
  const fake = async (url, init) => {
    const u = new URL(url);
    const auth = init.headers.Authorization;
    if (auth !== 'Bearer lx-key') return new Response('', { status: 401 });
    const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (u.pathname === '/v1/contacts') return json({ content: [{ id: 'lc1', roles: { customer: { number: 10500 } }, company: { name: 'Alt Kunde GmbH', vatRegistrationId: 'DE111111111' }, addresses: { billing: [{ street: 'Alt 1', zip: '1', city: 'Köln', countryCode: 'DE' }] }, emailAddresses: { business: ['alt@kunde.de'] } }], last: true });
    if (u.pathname === '/v1/articles') return json({ content: [{ id: 'la1', title: 'Stundensatz', type: 'SERVICE', unitName: 'Stunde', price: { netPrice: 95, taxRate: 19 } }], last: true });
    if (u.pathname === '/v1/voucherlist') return json({ content: [{ id: 'lv1', voucherType: 'invoice', voucherStatus: 'paid', voucherNumber: 'RE0815', voucherDate: '2025-03-01T00:00:00.000+01:00', contactId: 'lc1', totalAmount: 119, openAmount: 0, currency: 'EUR' }], last: true });
    if (u.pathname === '/v1/invoices/lv1') return json({ id: 'lv1', voucherNumber: 'RE0815', voucherDate: '2025-03-01T00:00:00.000+01:00', address: { contactId: 'lc1', name: 'Alt Kunde GmbH', city: 'Köln', countryCode: 'DE' }, lineItems: [{ type: 'custom', name: 'Beratung', quantity: 1, unitName: 'Stunde', unitPrice: { netAmount: 100, taxRatePercentage: 19 } }], totalPrice: { currency: 'EUR', totalNetAmount: 100, totalGrossAmount: 119, totalTaxAmount: 19 }, taxConditions: { taxType: 'net' } });
    if (u.pathname === '/v1/invoices/lv1/file') return new Response(Buffer.from('%PDF-1.4 lexware original'), { status: 200 });
    return new Response('', { status: 404 });
  };
  const job = { id: 'job_t', kind: 'lexware', status: 'running', started_at: '', progress: {}, messages: [] };
  await IM.runLexwareImport(fin, { apiKey: 'lx-key', fetch: fake, pace: 0 }, A, job);
  check('lexware: job completes', job.status === 'done' && job.progress.contacts === 1 && job.progress.articles === 1 && job.progress.invoices === 1);
  const lxInv = (await fin.listDocuments()).find((d) => d.number === 'RE0815');
  check('lexware: invoice keeps its Lexware number, is paid and imported', lxInv && lxInv.imported && lxInv.status === 'paid' && lxInv.totals.gross_cents === 11900);
  check('lexware: the original Lexware PDF is the archived copy', !!lxInv.archived_pdf_id);
  check('lexware: the contact is linked', !!lxInv.contact_id && (await fin.getContact(lxInv.contact_id)).customer_number === '10500');
  check('lexware: unit names map to UN/ECE codes', (await fin.listArticles()).some((a) => a.title === 'Stundensatz' && a.unit === 'HUR' && a.unit_price_cents === 9500));
  const job2 = { id: 'job_t2', kind: 'lexware', status: 'running', started_at: '', progress: {}, messages: [] };
  await IM.runLexwareImport(fin, { apiKey: 'lx-key', fetch: fake, pace: 0 }, A, job2);
  check('lexware: re-running imports nothing twice', !job2.progress.contacts && !job2.progress.invoices && job2.progress.invoices_skipped === 1);
  await rejects('lexware: a bad key is reported', () => IM.runLexwareImport(fin, { apiKey: 'nope', fetch: fake, pace: 0 }, A, { ...job, id: 'j3', progress: {} }), /401/);
  check('lexware: tax types map', LX.mapTaxType('externalService13b') === 'reverse_charge_eu' && LX.mapTaxType('vatfree') === 'small_business');

  // A new invoice number after the import must not collide.
  const after = await fin.finalize((await fin.createDocument({ contact_id: cust.id, issue_date: '2026-12-02', lines: [{ name: 'x', quantity: 1, unit_price_cents: 100 }] }, A)).id, A);
  check('numbering continues after imports', /^RE-2026-\d{4}$/.test(after.number));
}

/* ------------------------------------------------------------------ the admin app */
{
  const { execFileSync } = await import('node:child_process');
  let fresh = true;
  try { execFileSync(process.execPath, [path.join(ROOT, 'scripts/build-finance-admin.mjs'), '--check'], { stdio: 'pipe' }); } catch { fresh = false; }
  check('the embedded admin script matches app.client.js (run scripts/build-finance-admin.mjs)', fresh);
  const app = await fs.readFile(path.join(ROOT, 'src/plugins/finance/admin/app.client.js'), 'utf8');
  check('the admin app never writes data through innerHTML', !/\.innerHTML\s*=/.test(app));
  check('the admin app sends the CSRF token', app.includes("'X-CSRF-Token': csrf"));
  const plugin = await loadTs('src/plugins/finance/index.ts');
  const def = plugin.default;
  check('plugin: admin page is limited to admin and manager', def.adminPages[0].roles.join() === 'admin,manager');
  check('plugin: ships its script', typeof def.adminPages[0].script === 'string' && def.adminPages[0].script.length > 10000);
  const routes = def.routes;
  check('plugin: every route lives under /api/plugin/finance/', routes.every((r) => r.path.startsWith('/api/plugin/finance/')));
  check('plugin: only the customer link and the signed webhook are public', routes.filter((r) => r.access === 'public').map((r) => r.path).sort().join()
    === ['/api/plugin/finance/inbound/sale', '/api/plugin/finance/public/:id/:token', '/api/plugin/finance/public/:id/:token/xml'].join());
  check('plugin: only the signed webhook skips CSRF', routes.filter((r) => r.csrf === 'exempt').map((r) => r.path).join() === '/api/plugin/finance/inbound/sale');
  check('plugin: every staff route declares a finance scope', routes.filter((r) => r.access !== 'public').every((r) => /^finance:(read|write)$/.test(r.scope)));
  const editor = { request: new Request('http://x/'), url: new URL('http://x/'), params: {}, user: { id: 'u', role: 'editor' }, locals: {}, store: memoryStore(), settings: async () => ({}) };
  const summary = routes.find((r) => r.path.endsWith('/summary'));
  check('plugin: an editor is refused (money is not content)', (await summary.handler(editor)).status === 403);
  const pub = routes.find((r) => r.path.endsWith('/public/:id/:token'));
  const store = memoryStore();
  await store.put('documents', 'doc_x', { id: 'doc_x', status: 'open', public_token: 'a'.repeat(32) });
  check('plugin: a wrong customer token is a 404', (await pub.handler({ ...editor, user: null, store, params: { id: 'doc_x', token: 'b'.repeat(32) } })).status === 404);
  const inbound = routes.find((r) => r.path.endsWith('/inbound/sale'));
  process.env.FINANCE_INBOUND_SECRET = 'shh';
  const unsigned = await inbound.handler({ ...editor, user: null, request: new Request('http://x/', { method: 'POST', body: '{}' }) });
  check('plugin: an unsigned inbound sale is refused', unsigned.status === 401);
  const { createHmac } = await import('node:crypto');
  const raw = JSON.stringify({ source: 'site', external_id: 'o1', customer: { company_name: 'X GmbH', email: 'x@x.de', address: { country: 'DE', city: 'Berlin', zip: '1', street: 's' } }, lines: [{ name: 'A', quantity: 1, unit_price_cents: 1190, tax_rate: 19 }], finalize: false });
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', 'shh').update(`${t}.${raw}`).digest('hex');
  const signed = await inbound.handler({ ...editor, user: null, request: new Request('http://x/', { method: 'POST', body: raw, headers: { 'x-finance-signature': `t=${t},v1=${sig}` } }) });
  check('plugin: a correctly signed inbound sale creates an invoice draft', signed.status === 201);
}

await fs.rm(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
