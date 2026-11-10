/**
 * The customer portal: what the link in an invoice or quote email opens.
 *
 * One page per document, reached with its unguessable token. It shows the
 * document at a glance, offers the PDF (and the e-invoice XML), the payment
 * details with a GiroCode and an optional PayPal.Me link — and for a quote,
 * lets the customer accept it (choosing optional items) or decline it.
 *
 * Deliberately plain HTML: no script at all, forms post back to the server,
 * every value escaped. It runs on the public internet with the customer's
 * data, so it carries its own strict CSP.
 */
import type { CompanyProfile, FinanceDocument } from './types';
import { escapeHtml as e, formatMoney, legalName } from './format';
import { dueCents, skontoFor } from './tax';
import { epcPayload, qrEncode } from './qr';

export interface PortalLinks {
  pdf: string;
  xml?: string;
  respond?: string;
}

const STATUS_DE: Record<string, string> = {
  open: 'offen', partially_paid: 'teilweise bezahlt', paid: 'bezahlt', cancelled: 'storniert',
  accepted: 'angenommen', rejected: 'abgelehnt', invoiced: 'beauftragt',
};

function date(iso?: string): string {
  return iso ? iso.split('-').reverse().join('.') : '—';
}

/** A QR matrix as an inline SVG — no image request, no script. */
export function qrSvg(matrix: boolean[][], px = 4): string {
  const n = matrix.length;
  const q = 4; // quiet zone
  const size = (n + 2 * q) * px;
  let path = '';
  matrix.forEach((row, y) => row.forEach((on, x) => { if (on) path += `M${(x + q) * px} ${(y + q) * px}h${px}v${px}h-${px}z`; }));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="GiroCode"><rect width="100%" height="100%" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}

export function portalCsp(): string {
  return "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
}

export function renderPortal(doc: FinanceDocument, co: CompanyProfile, links: PortalLinks, opts: { today: string; notice?: string }): string {
  const cur = doc.currency;
  const m = (c: number) => e(formatMoney(c, cur, 'de'));
  const kind = doc.type === 'quote' ? 'Angebot' : doc.type === 'credit_note' ? 'Gutschrift'
    : doc.invoice_kind === 'partial' ? 'Abschlagsrechnung' : doc.invoice_kind === 'final' ? 'Schlussrechnung' : 'Rechnung';
  const accent = /^#[0-9a-fA-F]{6}$/.test(co.accent_color ?? '') ? co.accent_color! : '#1d4ed8';
  const open = dueCents(doc) - doc.paid_cents;
  const parts: string[] = [];

  parts.push(`<header><div class="brand">${e(legalName(co))}</div><h1>${e(kind)} ${e(doc.number ?? '')}</h1>
    <p class="muted">für ${e(doc.recipient.name ?? '')} · vom ${date(doc.issue_date)}${doc.title ? ` · ${e(doc.title)}` : ''}</p>
    <span class="badge">${e(STATUS_DE[doc.status] ?? doc.status)}</span></header>`);
  if (opts.notice) parts.push(`<div class="notice">${e(opts.notice)}</div>`);

  // Lines
  const rows = doc.lines.map((l) => {
    const cl = doc.totals.lines.find((x) => x.id === l.id);
    if (l.type === 'text') return `<tr class="text"><td colspan="3">${e(l.name)}${l.description ? `<div class="muted">${e(l.description)}</div>` : ''}</td></tr>`;
    const tag = l.optional ? '<span class="tag">optional</span>' : l.alternative ? '<span class="tag">Alternative</span>' : '';
    const amount = cl ? (doc.price_mode === 'gross' ? Math.round(cl.net_cents * (1 + cl.rate / 100)) : cl.net_cents) : 0;
    return `<tr${cl?.excluded ? ' class="excluded"' : ''}><td>${e(l.name)} ${tag}${l.description ? `<div class="muted">${e(l.description)}</div>` : ''}</td>
      <td class="num">${e(String(l.quantity).replace('.', ','))}</td><td class="num">${cl?.excluded ? `(${m(amount)})` : m(amount)}</td></tr>`;
  }).join('');
  const t = doc.totals;
  let totals = `<tr><td colspan="2">Netto</td><td class="num">${m(t.net_cents)}</td></tr>`;
  for (const g of t.groups) if (g.tax_cents) totals += `<tr><td colspan="2">USt ${g.rate} %</td><td class="num">${m(g.tax_cents)}</td></tr>`;
  totals += `<tr class="sum"><td colspan="2">Gesamt</td><td class="num">${m(t.gross_cents)}</td></tr>`;
  for (const p of doc.deducts ?? []) totals += `<tr><td colspan="2">abzgl. Abschlag ${e(p.number)}</td><td class="num">−${m(p.gross_cents)}</td></tr>`;
  if (t.prepaid_cents) totals += `<tr class="sum"><td colspan="2">Zu zahlen</td><td class="num">${m(dueCents(doc))}</td></tr>`;
  parts.push(`<section><table><thead><tr><th>Leistung</th><th class="num">Menge</th><th class="num">Betrag</th></tr></thead><tbody>${rows}</tbody><tfoot>${totals}</tfoot></table></section>`);

  parts.push(`<section class="actions"><a class="btn" href="${e(links.pdf)}">PDF herunterladen</a>${links.xml ? ` <a class="btn ghost" href="${e(links.xml)}">E-Rechnung (XML)</a>` : ''}</section>`);

  // Payment
  if (doc.type === 'invoice' && doc.status !== 'cancelled' && open > 0) {
    const sk = skontoFor(doc);
    const skontoOk = sk && opts.today <= sk.until && doc.paid_cents === 0;
    const amount = skontoOk ? sk!.pay_cents : open;
    const epc = co.iban && cur === 'EUR' ? epcPayload({ name: co.account_holder || legalName(co), iban: co.iban, bic: co.bic, amount_cents: amount, reference: doc.number ?? '' }) : null;
    const qr = epc ? qrSvg(qrEncode(new TextEncoder().encode(epc))) : '';
    parts.push(`<section class="pay"><h2>Bezahlen</h2><div class="paygrid"><div>
      <p><strong>${m(amount)}</strong> ${skontoOk ? `bis ${date(sk!.until)} (abzgl. ${e(String(sk!.percent).replace('.', ','))} % Skonto), danach ${m(open)}` : `fällig bis ${date(doc.due_date)}`}</p>
      ${co.iban ? `<dl><dt>Empfänger</dt><dd>${e(co.account_holder || legalName(co))}</dd><dt>IBAN</dt><dd>${e(co.iban.replace(/(.{4})/g, '$1 ').trim())}</dd>${co.bic ? `<dt>BIC</dt><dd>${e(co.bic)}</dd>` : ''}<dt>Verwendungszweck</dt><dd>${e(doc.number ?? '')}</dd></dl>` : ''}
      ${co.paypal_me ? `<p><a class="btn ghost" href="https://www.paypal.me/${e(co.paypal_me)}/${(amount / 100).toFixed(2)}EUR" rel="noopener noreferrer">Mit PayPal bezahlen</a></p>` : ''}
      </div>${qr ? `<figure>${qr}<figcaption>GiroCode für die Banking-App</figcaption></figure>` : ''}</div></section>`);
  }

  // Quote response
  if (doc.type === 'quote') {
    const expired = !!doc.valid_until && doc.valid_until < opts.today;
    if (doc.status === 'open' && links.respond && !expired) {
      const optional = doc.lines.filter((l) => l.type === 'item' && l.optional);
      parts.push(`<section class="respond"><h2>Angebot annehmen</h2>
        <p class="muted">Gültig bis ${date(doc.valid_until)}. Mit „Verbindlich annehmen“ beauftragen Sie die Leistungen dieses Angebots.</p>
        <form method="post" action="${e(links.respond)}">
          ${optional.length ? `<fieldset><legend>Optionale Positionen</legend>${optional.map((l) => `<label><input type="checkbox" name="option" value="${e(l.id)}"> ${e(l.name)}</label>`).join('')}</fieldset>` : ''}
          <label>Ihr Name<input name="name" required maxlength="120" autocomplete="name"></label>
          <label>Anmerkung (optional)<textarea name="note" maxlength="1000" rows="3"></textarea></label>
          <div class="row"><button name="decision" value="accept" class="btn">Verbindlich annehmen</button>
          <button name="decision" value="reject" class="btn ghost" formnovalidate>Ablehnen</button></div>
        </form></section>`);
    } else if (doc.status === 'open' && expired) {
      parts.push(`<div class="notice">Dieses Angebot war bis ${date(doc.valid_until)} gültig. Bitte sprechen Sie uns für ein aktuelles Angebot an.</div>`);
    } else if (doc.quote_response) {
      parts.push(`<div class="notice">${doc.quote_response.status === 'accepted' ? 'Angenommen' : 'Abgelehnt'} am ${date(doc.quote_response.at.slice(0, 10))}${doc.quote_response.name ? ` von ${e(doc.quote_response.name)}` : ''}.</div>`);
    }
  }

  const contact = [co.email && `<a href="mailto:${e(co.email)}">${e(co.email)}</a>`, co.phone && e(co.phone), co.website && e(co.website)].filter(Boolean).join(' · ');
  parts.push(`<footer>${e(legalName(co))}${co.street ? ` · ${e(co.street)}, ${e(co.zip ?? '')} ${e(co.city ?? '')}` : ''}${contact ? `<br>${contact}` : ''}</footer>`);

  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${e(kind)} ${e(doc.number ?? '')} – ${e(legalName(co))}</title>
<style>
:root{--accent:${accent};--ink:#111827;--muted:#6b7280;--line:#e5e7eb;--bg:#f9fafb;--card:#fff}
@media (prefers-color-scheme:dark){:root{--ink:#f3f4f6;--muted:#9ca3af;--line:#374151;--bg:#0b0f17;--card:#111827}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:760px;margin:0 auto;padding:24px 16px 48px}
header,section,.notice{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:18px;margin-bottom:14px}
.brand{font-weight:600;color:var(--accent)}h1{margin:.2em 0 .1em;font-size:1.5em}h2{margin:0 0 .6em;font-size:1.1em}
.muted{color:var(--muted);font-size:.9em;margin:0}.badge{display:inline-block;margin-top:8px;padding:2px 10px;border-radius:99px;border:1px solid var(--line);font-size:.85em}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px 4px;border-bottom:1px solid var(--line);vertical-align:top}
.num{text-align:right;white-space:nowrap}tfoot td{border:0;padding:4px}tfoot .sum td{font-weight:700;border-top:2px solid var(--ink)}
tr.excluded td{color:var(--muted)}tr.text td{font-weight:600}.tag{font-size:.75em;border:1px solid var(--line);border-radius:4px;padding:0 5px;color:var(--muted)}
.btn{display:inline-block;background:var(--accent);color:#fff;border:1px solid var(--accent);border-radius:8px;padding:9px 16px;text-decoration:none;font:inherit;cursor:pointer}
.btn.ghost{background:transparent;color:var(--accent)}.actions{display:flex;gap:8px;flex-wrap:wrap}
.paygrid{display:flex;gap:18px;flex-wrap:wrap;justify-content:space-between}figure{margin:0;text-align:center}figure svg{width:150px;height:150px;border-radius:6px}
figcaption{font-size:.8em;color:var(--muted)}dl{display:grid;grid-template-columns:auto 1fr;gap:2px 12px;margin:.6em 0}dt{color:var(--muted)}dd{margin:0;word-break:break-all}
form label{display:block;margin:.6em 0}input[name=name],textarea{display:block;width:100%;margin-top:4px;padding:8px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--ink);font:inherit}
fieldset{border:1px solid var(--line);border-radius:8px}fieldset label{margin:.3em 0}.row{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
.notice{border-color:var(--accent)}footer{color:var(--muted);font-size:.85em;text-align:center;margin-top:24px}a{color:var(--accent)}
</style></head><body><main>${parts.join('\n')}</main></body></html>`;
}
