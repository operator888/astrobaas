# Finance — invoicing and bookkeeping for AstroBaaS

A bundled plugin that does what Lexware Office does for a small German
company, and talks to everything else you run: the admin, a REST API, signed
webhooks in and out, and MCP for agents.

Activate it under **Admin → Plugins → Finance**. The app lives at
**Admin → Finanzen** (`/admin/plugin/finance`). It is limited to the
`admin` and `manager` roles.

## What it does

| Area | Features |
| --- | --- |
| Documents | Quotes, invoices, credit notes. Drafts are editable; finalizing assigns the number, freezes seller/buyer, archives the PDF (and XML) and makes the document immutable (GoBD). Cancel = full credit note offset against the open amount. Quote → invoice. Duplicate. |
| Numbers | Per type, with `{YYYY} {YY} {MM} {SEQ:n}` patterns, reset yearly / monthly / never. Assigned under a lock; every issued number is recorded and never reused. |
| Tax | Domestic 19 / 7 / 0 %, Kleinunternehmer (§ 19), EU reverse charge (§ 3a / § 13b), intra-Community supply, third-country services, export. Suggested from the customer's country and VAT id; legal notes printed automatically. EN 16931 rounding (VAT per rate group). Net or gross prices. |
| E-invoicing | **Out:** ZUGFeRD / Factur-X EN 16931 as PDF/A-3b with embedded `factur-x.xml`, or XRechnung 3.0 (CII) with the Leitweg-ID. **In:** upload an XRechnung/ZUGFeRD/UBL file and it becomes a complete expense. |
| PDF | DIN 5008 layout with window-envelope address, mandatory footer (§ 14 UStG, § 35a GmbHG), logo, accent colour, German/English, Greek-safe font, pagination. |
| Sending | Email with the PDF (and XML) attached, plus a customer link (`/api/plugin/finance/public/<id>/<token>`). |
| Payments | Manual, from bank import, from integrations; partial payments; status open → partially paid → paid. |
| Dunning | Suggestions by days overdue, three levels with fees and optional § 288 BGB interest, archived PDF, optional email. |
| Recurring | Monthly / quarterly / yearly templates with billing periods, catch-up, auto-finalize and auto-send. Idempotent per period. |
| Expenses | Receipts (PDF/photo/e-invoice) archived; categories mapped to SKR03/SKR04; reverse-charge purchases (Google, Meta, AWS…). |
| Bank | Import camt.053, MT940 or CSV from any German bank; re-import is harmless; payments auto-matched when the invoice number is in the purpose; suggestions otherwise; bank fees bookable without a receipt. |
| Reports | UStVA Kennzahlen (Soll or Ist), profit & loss by category, open items with ageing, dashboard. |
| Steuerberater | DATEV EXTF Buchungsstapel (v700/13, 125 columns, CP1252) and a ZIP package with the DATEV file, every archived invoice and receipt, a document list and a list of missing receipts. |
| Import | Lexware Office via its Public API (contacts, articles, invoices and credit notes with their original PDFs); contacts from CSV. |
| Audit | Hash-chained change log with a verify button. |

## Integrations

**REST** — everything the admin does is `/api/plugin/finance/…`. Mint an API key
for an admin or manager with scope `finance:read` / `finance:write`.

**Sales from other systems** (websites, the licence centre, Shopify):

```http
POST /api/plugin/finance/sales
Authorization: Bearer abk_…
Content-Type: application/json

{
  "source": "licence-center",
  "external_id": "lic_42",
  "customer": { "company_name": "Acme GmbH", "email": "billing@acme.de",
                "vat_id": "DE123456789",
                "address": { "street": "…", "zip": "10115", "city": "Berlin", "country": "DE" } },
  "lines": [{ "name": "askTheodor Pro — annual licence", "quantity": 1, "unit": "ANN",
              "unit_price_cents": 119000, "tax_rate": 19 }],
  "price_mode": "gross",
  "paid": { "method": "stripe", "reference": "pi_123" },
  "send_email": true
}
```

Idempotent on `source` + `external_id`: a retried webhook returns the same
invoice (`created: false`). Systems that cannot hold an API key can POST the
same body to `/api/plugin/finance/inbound/sale`, signed:

```
X-Finance-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(FINANCE_INBOUND_SECRET, "<t>.<raw body>")>
```

**AstroBaaS shop** — Settings → "Shop-Bestellungen automatisch abrechnen":
a completed order becomes a finalized, paid invoice.

**Webhooks out** (Admin → Webhooks): `invoice.finalized`, `invoice.paid`,
`invoice.cancelled`, `invoice.dunned`, `credit_note.finalized`,
`quote.finalized`, `quote.accepted`, `quote.rejected`, `document.sent`,
`expense.created`.

**MCP** — `npx astrobaas-mcp` exposes `finance_*` tools (summary, documents,
payments, expenses, VAT report, bank matching, recurring). Destructive tools
(finalize, cancel, send) say so in their descriptions so an agent confirms
first.

## Environment

| Variable | Purpose |
| --- | --- |
| `FINANCE_PUBLIC_URL` | Origin used in customer links (defaults to `SITE_URL`, then the request origin). |
| `FINANCE_INBOUND_SECRET` | Enables the signed `/inbound/sale` endpoint. |
| `PRIVATE_UPLOADS_DIR` | Where the GoBD archive lives (`<dir>/finance/`). **Back it up.** |

## Data and retention

Records live in the plugin's namespaced store; files (archived PDFs, XMLs,
receipts) under `<private uploads>/finance/`, content-addressed and write-once,
with a SHA-256 check on every read. Invoices and receipts must be kept 8 years
(§ 147 AO as amended 2025). The offsite backup does not include private
uploads — sync that directory separately, or download the yearly
Steuerberater package as an archive copy.

## Verified against

- XML: `@attestwire/en16931` (XRechnung 3.0 + EN 16931 rules, BR-DE-*) and the
  `factur-x` Python library (CEN XSD + EN 16931 schematron) — invoice, credit
  note, gross prices, discounts, Kleinunternehmer, reverse charge,
  intra-Community supply, export, third-country.
- PDF: XML extraction with `factur-x`; PDF/A-3b conformance should be
  confirmed once with veraPDF on the production server.
- DATEV: `@seamless-engineering/datev-extf` validator — 0 findings, SKR03 and SKR04.

## Things to confirm with the Steuerberater

- BU key for reverse-charge purchases (default `94`, override `bu:rc19`).
- Kleinunternehmer revenue account (`rev:small_business`: 8192 / 4184 in 2026 charts).
- Whether personal accounts (Debitoren/Kreditoren) or collective accounts are wanted.
- The UStVA Kennzahlen mapping against the current year's form.
