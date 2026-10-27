# ECWS Billing — invoicing and bookkeeping for AstroBaaS

A bundled plugin that does what Lexware Office does for a small German
company, and talks to everything else you run: the admin, a REST API, signed
webhooks in and out, and MCP for agents. See
[LEXWARE-COMPARISON.md](LEXWARE-COMPARISON.md) for a feature-by-feature
comparison with Lexware Office.

Activate it under **Admin → Plugins → ECWS Billing**. The app lives at
**Admin → Billing** (`/admin/plugin/finance`). It is limited to the
`admin` and `manager` roles.

## What it does

| Area | Features |
| --- | --- |
| Documents | Quotes, invoices, credit notes. Drafts are editable; finalizing assigns the number, freezes seller/buyer, archives the PDF (and XML) and makes the document immutable (GoBD). Cancel = full credit note offset against the open amount. Quote → invoice. Duplicate. |
| Quotes | Optional and alternative lines (priced, not in the total). The customer accepts or declines online in the portal and picks optional items; an order confirmation (Auftragsbestätigung) PDF is issued from the accepted scope. |
| Projects | Down-payment invoices (Abschlagsrechnung, TypeCode 326) and a final invoice (Schlussrechnung) that deducts them — XML `TotalPrepaidAmount`, VAT return, ZM, P&L and DATEV count the work once. |
| Skonto | Default per company or contact, overridable per invoice; printed, and in XRechnung as the structured `#SKONTO#` line. A bank payment of the Skonto amount in time settles the invoice; the discount reduces revenue and VAT (§ 17 UStG) and books to *Gewährte Skonti* (8736/8731 · 4736/4731). Small rests can be written off ("Differenz ausbuchen"). |
| Numbers | Per type, with `{YYYY} {YY} {MM} {SEQ:n}` patterns, reset yearly / monthly / never. Assigned under a lock; every issued number is recorded and never reused. |
| Tax | Domestic 19 / 7 / 0 %, Kleinunternehmer (§ 19), EU reverse charge (§ 3a / § 13b), intra-Community supply, third-country services, export. Suggested from the customer's country and VAT id; legal notes printed automatically. EN 16931 rounding (VAT per rate group). Net or gross prices. |
| E-invoicing | **Out:** ZUGFeRD / Factur-X EN 16931 as PDF/A-3b with embedded `factur-x.xml`, or XRechnung 3.0 (CII) with the Leitweg-ID. **In:** upload an XRechnung/ZUGFeRD/UBL file and it becomes a complete expense. |
| PDF | DIN 5008 layout with window-envelope address, mandatory footer (§ 14 UStG, § 35a GmbHG), logo, accent colour, German/English, Greek-safe font, pagination. |
| Sending | Email with the PDF (and XML) attached, plus a link to the customer portal (`/api/plugin/finance/public/<id>/<token>/view`): document at a glance, PDF/XML download, payment details with GiroCode and PayPal.Me, quote acceptance. Script-free, own CSP, no-index. |
| Payments | Manual, from bank import, from integrations; partial payments; status open → partially paid → paid. |
| Dunning | Suggestions by days overdue, three levels with fees and optional § 288 BGB interest, archived PDF, optional email. |
| Recurring | Monthly / quarterly / yearly templates with billing periods, catch-up, auto-finalize and auto-send — run by the scheduler. Idempotent per period; a failed finalize is resumed. Standing expenses (Dauerbelege: rent, servers) are booked by the same run. |
| Expenses | Receipts (PDF/photo/e-invoice) archived; categories mapped to SKR03/SKR04; reverse-charge purchases (Google, Meta, AWS…). |
| Bank | Import camt.053, MT940 or CSV from any German bank; re-import is harmless; payments auto-matched when the invoice number is in the purpose; suggestions otherwise; bank fees bookable without a receipt. |
| Reports | UStVA Kennzahlen (Soll or Ist), Zusammenfassende Meldung (with CSV), profit & loss by category, open items with ageing, dashboard. |
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

**Invoices another system issued** (the website's `ON-…` invoices): the other
system stays the issuer, Billing keeps a mirror so the VAT figures, DATEV, the
reports and the dashboard see every sale. Number, totals and PDF are kept as
issued (an imported document, like the Lexware import); a number already used
here is refused.

```http
POST /api/plugin/finance/documents/mirror        (API key, finance:write)
POST /api/plugin/finance/inbound/invoice         (signed, same body)

{
  "source": "ecws-website", "external_id": "<invoice uuid>",
  "kind": "invoice",                       // or "cancellation" + "cancels_external_id"
  "number": "ON-2026-00012", "issue_date": "2026-10-20",
  "service_date": "2026-10-20", "service_date_end": null,
  "tax_treatment": "domestic", "tax_rate": 19,  // reverse_charge_eu / third_country_service at 0
  "net_cents": 10000, "tax_cents": 1900, "gross_cents": 11900,
  "customer": { "company_name": "…", "name": "…", "email": "…", "vat_id": "…", "external_id": "<account id>",
                "address": { "street": "…", "zip": "…", "city": "…", "country": "DE" } },
  "lines": [{ "name": "…", "quantity": 1, "unit_net_cents": 10000 }],
  "paid": { "method": "card", "paid_at": "2026-10-20T10:00:00Z", "reference": "pi_…" },
  "pdf_base64": "JVBERi0…", "pdf_sha256": "…"
}
```

A cancellation becomes a credit note with its own number; the mirrored original
is marked cancelled, and what the customer paid shows as a refund owed until a
later delivery carries `paid` (the refund). Delivering the same document again
only adds what was missing (PDF, payment). The PDF must stay under 1.4 MB.
**Do not also send the same sale to `/sales`** — that would book it twice.

**Requests and orders** (the "Anfragen" inbox): contact and quote forms, the
cost calculator, orders and requests from a customer portal. Not bookkeeping —
a lead to answer. "→ Angebot" makes a contact and a quote draft from it.

```http
POST /api/plugin/finance/requests                (API key, finance:write)
POST /api/plugin/finance/inbound/request         (signed, same body)

{
  "source": "ecws-website", "external_id": "order:<uuid>",
  "kind": "order",           // order | request | inquiry | contact | quote | estimate
  "number": "EC-2026-00012", "status": "submitted", "created_at": "…",
  "subject": "…", "message": "…", "page": "/kontakt", "link": "https://…/admin/orders/…",
  "customer": { "name": "…", "company_name": "…", "email": "…", "phone": "…", "external_id": "…" },
  "items": [{ "name": "…", "quantity": 1, "unit_net_cents": 150000, "billing": "one_off" },
            { "name": "…", "quantity": 1, "unit_net_cents": null }],   // null = on request
  "net_cents": 150000, "tax_cents": 28500, "gross_cents": 178500, "tax_rate": 19,
  "extra": { "Budget": "5–10 k€" }
}
```

Again idempotent: a later delivery refreshes what the other system knows (its
status, items), never the inbox state, the note or the quote made here.
`GET /requests?state=open|new|in_progress|quoted|done|dismissed|all&q=`,
`PUT /requests/:id {state, note}`, `POST /requests/:id/quote`.

**AstroBaaS shop** — Settings → "Shop-Bestellungen automatisch abrechnen":
a completed order becomes a finalized, paid invoice.

**Webhooks out** (Admin → Webhooks): `invoice.finalized`, `invoice.paid`,
`invoice.cancelled`, `invoice.dunned`, `credit_note.finalized`,
`quote.finalized`, `quote.accepted`, `quote.rejected`, `document.sent`,
`expense.created`.

**MCP** — `npx astrobaas-mcp` exposes `finance_*` tools (summary, documents,
payments, expenses, VAT report, bank matching, recurring, the requests inbox). Destructive tools
(finalize, cancel, send) say so in their descriptions so an agent confirms
first.

## Environment

| Variable | Purpose |
| --- | --- |
| `FINANCE_PUBLIC_URL` | Origin used in customer links (defaults to `SITE_URL`, then the request origin). |
| `FINANCE_INBOUND_SECRET` | Enables the signed `/inbound/sale`, `/inbound/invoice` and `/inbound/request` endpoints. |
| `PRIVATE_UPLOADS_DIR` | Where the GoBD archive lives (`<dir>/finance/`). **Back it up.** |

## Data and retention

**Nothing booked can be deleted.**
- Finalized invoices, credit notes and quotes, booked expenses, contacts (archive only) and bank transactions have no delete — only drafts do.
- A finalized document cannot be edited. It is corrected by credit note or Storno, and a Storno reverses exactly what was declared, including down-payment deductions and Skonto.
- A mistaken payment can be removed, and that removal is logged. The Skonto belonging to a payment goes with it. Storno offsets and their reversals cannot be removed.
- Every change goes into a hash-chained log.

**Files** (archived PDFs, XMLs, receipts) live under `<private uploads>/finance/`. They are content-addressed and write-once, with a SHA-256 check on every read. Invoices and receipts must be kept 8 years (§ 147 AO as amended 2025).

**Backups:**
- The site backup (Admin → Tools → Backup, and the automatic off-site backup) carries the database *and* `finance/`.
- A restore brings back missing archive files and never overwrites an existing one.
- Settings → Datensicherheit offers:
  - **Integrität prüfen:** every issued number has its document, archived files exist and match their checksums, finalized content is unchanged, payments add up, bank assignments are backed by payments, and the log chain is intact.
  - **Komplettexport:** every record as JSON plus every archived file, with checksums. Keep a copy on a disk you own.

The integrity check is also available as `GET /api/plugin/finance/integrity` and the MCP tool `finance_integrity_check`.

## Verified against

- XML: `@attestwire/en16931` (XRechnung 3.0 + EN 16931 rules, BR-DE-*) and the
  `factur-x` Python library (CEN XSD + EN 16931 schematron) — invoice, credit
  note, gross prices, discounts, Kleinunternehmer, reverse charge,
  intra-Community supply, export, third-country; and (October 2026) Skonto,
  down-payment (326) and final invoices with prepaid amounts, negative-quantity
  deductions.
- PDF: XML extraction with `factur-x`; PDF/A-3b conformance should be
  confirmed once with veraPDF on the production server.
- DATEV: `@seamless-engineering/datev-extf` validator — 0 findings, SKR03 and SKR04.

## Things to confirm with the Steuerberater

- BU key for reverse-charge purchases (default `94`, override `bu:rc19`).
- Kleinunternehmer revenue account (`rev:small_business`: 8192 / 4184 in 2026 charts).
- Whether personal accounts (Debitoren/Kreditoren) or collective accounts are wanted.
- The UStVA Kennzahlen mapping against the current year's form.
- Down-payment invoices are booked as revenue when issued; under balance-sheet
  accounting the Steuerberater may prefer *erhaltene Anzahlungen* (1718 / 3272).
- Skonto accounts (`rev:discount:19`, `rev:discount:7`, `rev:discount:0`).
