# ECWS Billing vs. Lexware Office

A feature-by-feature comparison with Lexware Office (formerly lexoffice), as of
October 2026. Lexware's plan tiers are S €7.90, M €12.90, L €21.90 and
XL €32.90 per month (list prices, net). Which plan unlocks a feature is noted
where it matters.

**Legend:** ✅ there · ➕ ECWS Billing goes further · ◐ partly · ❌ not there

## Sales documents

| Feature | Lexware Office | ECWS Billing |
| --- | --- | --- |
| Quotes, invoices, credit notes / corrections | ✅ (M) | ✅ |
| Quote → invoice in one click | ✅ | ✅ |
| Optional and alternative quote lines | ✅ | ✅ — the customer picks optional items when accepting online |
| Customer accepts a quote online | ✅ (customer portal) | ✅ portal, with name, note and chosen options; fires `quote.accepted` |
| Order confirmation (Auftragsbestätigung) | ✅ (M) | ✅ PDF from the accepted quote, optionally emailed |
| Delivery note (Lieferschein), collective invoice from delivery notes | ✅ (M) | ❌ — not needed for a services agency |
| Down-payment and final invoices (Abschlags-/Schlussrechnung) | ✅ (XL) | ✅ TypeCode 326, `TotalPrepaidAmount`, VAT counted once |
| Recurring invoices | ✅ (XL) | ✅ + catch-up, billing periods, scheduler, auto-send |
| Skonto (early-payment discount) | ✅ | ✅ printed, structured `#SKONTO#` in XRechnung, booked automatically when the bank receives the Skonto amount |
| Line discount / text lines | ✅ | ✅ |
| English documents | ✅ (XL) | ✅ (DE / EN) |
| Layout designer, several print layouts | ✅ | ◐ one DIN 5008 layout with logo and accent colour |
| Rich text in documents | ✅ (2026) | ❌ |
| Foreign currencies | ❌ | ❌ (EUR only, same as Lexware) |
| GiroCode (EPC QR) on invoices | ✅ | ✅ on the PDF and in the portal |
| PayPal.Me link | ✅ | ✅ on the PDF and in the portal |
| Card / Stripe checkout on the invoice | via partners | ◐ Stripe payments arrive through the shop / sales API |
| Customer portal | ✅ (link + postcode) | ✅ link with a 192-bit token; script-free page with its own CSP |
| Dunning | ✅ manual | ✅ manual, three levels, fees, § 288 BGB interest, history, never sent automatically |

## E-invoicing

| Feature | Lexware Office | ECWS Billing |
| --- | --- | --- |
| Send ZUGFeRD | ✅ | ✅ EN 16931 as PDF/A-3b |
| Send XRechnung | ✅ (M or XL, sources disagree) | ✅ XRechnung 3.0 CII, Leitweg-ID per contact, check-digit warning |
| Receive and read e-invoices | ✅ (S) | ✅ XRechnung / ZUGFeRD / UBL → complete expense |
| Peppol network sending | not mentioned | ❌ |

## Receipts and expenses

| Feature | Lexware Office | ECWS Billing |
| --- | --- | --- |
| Upload receipts, archive them (GoBD) | ✅ | ✅ content-addressed, write-once, SHA-256 checked |
| Mobile scanner app | ✅ | ❌ — use the browser's camera upload |
| Email inbox for receipts | ✅ | ❌ |
| OCR of PDF / photo receipts | ✅ | ❌ (e-invoices are read exactly; paper receipts are typed) |
| Recurring bookings (Dauerbelege) | ✅ (Aug 2026) | ✅ rent, servers, insurance — booked each period |
| Fixed assets and depreciation (AfA) | ✅ (L) | ❌ |
| Cash book (Kassenbuch) | ✅ (L) | ❌ |
| Foreign VAT kept out of input tax | not documented | ✅ flagged for the BZSt refund procedure |

## Bank

| Feature | Lexware Office | ECWS Billing |
| --- | --- | --- |
| Live bank connection (PSD2) | ✅ | ❌ — needs a licensed provider; camt.053 / MT940 / CSV import instead |
| Automatic matching | ✅ (~80 % recognised) | ✅ invoice number, amount, IBAN, name; Skonto payments recognised |
| Create an expense from a bank line | ✅ | ✅ |
| Pay suppliers by transfer from the app | ✅ | ❌ |
| Business account | ✅ (Solaris) | ❌ |

## Tax and accountant

| Feature | Lexware Office | ECWS Billing |
| --- | --- | --- |
| UStVA figures | ✅ (L) | ✅ Kennzahlen, Soll or Ist, Skonto per § 17 UStG |
| UStVA submission to ELSTER | ✅ (L) | ❌ — figures are typed into ELSTER (submission needs the ERiC library and a certificate) |
| Zusammenfassende Meldung | ✅ (L) | ✅ figures + CSV for the BZSt portal |
| EÜR / P&L | ✅ (L) | ◐ P&L by category and month; no official EÜR form |
| BWA, liquidity planning | ✅ (L) | ❌ |
| Balance sheet | ❌ | ❌ (the Steuerberater does it from the DATEV export) |
| DATEV export | ✅ | ✅ EXTF Buchungsstapel + ZIP with every document and a missing-receipts list |
| Steuerberater access | ✅ free user | ◐ an AstroBaaS `manager` account, or the ZIP package |
| Payroll | add-on | ❌ |

## Platform

| Feature | Lexware Office | ECWS Billing |
| --- | --- | --- |
| Public API | ✅ (XL) | ✅ every screen is an API, with scoped keys |
| Webhooks | ✅ (XL) | ✅ signed, 10 events |
| Shop connectors | Shopify, Shopware, WooCommerce via partners | ➕ the AstroBaaS shop invoices itself; any site posts to `/sales` |
| AI agents | — | ➕ MCP tools (`finance_*`) for askTheodor / Claude |
| Import from Lexware | — | ➕ contacts, articles, invoices with their original PDFs |
| Users and roles | ✅ | ✅ AstroBaaS roles (admin, manager) |
| Tamper-evident audit log | ◐ Festschreibung | ➕ hash-chained log with a verify button |
| Hosting | Lexware's cloud (Germany) | your own server |
| Price | €7.90–32.90 / month | nothing beyond hosting |

## What this round added

- **Skonto:**
  - set as a company or contact default, or per invoice;
  - printed on the PDF and in XRechnung;
  - settled automatically from the bank.
- **Write-offs:** "Differenz ausbuchen" for small differences, and shop rounding cents written off instead of dunned.
- **Quotes:** optional and alternative lines, and online acceptance in the customer portal.
- **Order confirmations:** an Auftragsbestätigung from the accepted quote.
- **Down-payment and final invoices:** Abschlagsrechnung and Schlussrechnung.
- **Recurring expenses:** standing expenses (Dauerbelege).
- **Customer portal:** GiroCode and PayPal.Me in the portal.
- **Leitweg-ID check:** a warning when the check digits are wrong.

## Not built, and why

- **ELSTER submission:** it needs the ERiC library and a certificate on the server. The figures are complete; typing them in takes two minutes.
- **PSD2 bank connection:** it needs a licensed provider (e.g. finAPI, GoCardless Bank Account Data). It is the next step if bank import becomes tedious.
- **OCR, mobile scanner and receipt inbox:** worth adding through askTheodor (an LLM reading the receipt) rather than a classic OCR engine.
- **Fixed assets / AfA, cash book, BWA, payroll:** a UG's Steuerberater usually does these from the DATEV export.
- **Delivery notes and layout designer:** not needed for a services agency.

## Sources

- [Lexware Office features](https://www.lexware.de/funktionen/), [prices](https://www.lexware.de/preise/), [release timeline](https://www.lexware.de/timeline/)
- Help centre: [Schlussrechnung](https://help.lexware.de/de-form/articles/661465-eine-schlussrechnung-in-lexware-office-erstellen-und-abschlage-verrechnen), [Skonto](https://help.lexware.de/de-form/articles/548179-zahlungsbedingungen-und-skonto-in-lexware-office-hinterlegen.md), [optional/alternative lines](https://help.lexware.de/de-form/articles/547989-optionale-und-alternative-positionen-in-angeboten-nutzen), [dunning](https://help.lexware.de/de-form/articles/547985-zahlungserinnerungen-und-mahnungen-erstellen.md), [QR codes](https://help.lexware.de/de-form/articles/548277-schnelle-bezahlung-mit-qr-codes-ermoglichen.md), [e-invoices](https://help.lexware.de/de-form/articles/547942-e-rechnungen-versenden-und-empfangen.md), [balance sheet](https://help.lexware.de/de-form/articles/548555-bilanz-und-lexware-office)
- Plan matrix: [tax&bytes, Jan 2026](https://www.taxandbytes.de/tools/buchhaltung-rechnungswesen/lexware-office/preise)
