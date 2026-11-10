/**
 * `GET /api/invoice-records/{id}/pdf` — one invoice or credit-memo RECORD as
 * a PDF file.
 *
 * Two ways in, and only two:
 *  - staff who may read orders, for any record (drafts included);
 *  - the buyer, with the receipt token from their confirmation email
 *    (`?token=`), for a FINAL record of the order that token names — under
 *    exactly the receipt's rules (`receiptIsAvailable`: not erased, not
 *    cancelled).
 *
 * Everything else — a bad token, a token for another order, a draft, an
 * unknown id — is the same 404, so the route is not an oracle for which
 * records exist.
 *
 * The bytes come from `invoice-pdf.ts`, the receipt pipeline with its Greek
 * font. Without an issuer the page says it is not a tax document and prints no
 * document number; that is decided by the record's state, not here.
 */
import type { APIRoute } from 'astro';
import { LocalDB } from '../../../../lib/localdb';
import { canReadCommerce } from '../../../../lib/auth';
import { settingsMap, settingStr } from '../../../../lib/settings-map';
import { formatMoney } from '../../../../lib/money-format';
import { publicStrings } from '../../../../lib/i18n/public-strings';
import { readReceiptToken, receiptIsAvailable } from '../../../../lib/commerce/receipt';
import { receiptFontBytes } from '../../../../lib/commerce/receipt-font';
import { findInvoiceDocument, registeredInvoiceIssuers } from '../../../../lib/commerce/invoice-records';
import { invoicePdfBytes, invoicePdfFilename } from '../../../../lib/commerce/invoice-pdf';
import { invoicesOf } from '../../../../lib/commerce/invoice-records-rules';
import { reportError } from '../../../../lib/observability';

export const prerender = false;

function notFound(): Response {
  return new Response('Not found', {
    status: 404,
    headers: { 'Cache-Control': 'no-store, private', 'X-Robots-Tag': 'noindex, nofollow' },
  });
}

export const GET: APIRoute = async ({ params, url, locals }) => {
  await LocalDB.init();
  const found = await findInvoiceDocument(String(params.id ?? ''));
  if (!found) return notFound();
  const { order, doc, docs } = found;

  const staff = !!locals.user && canReadCommerce(locals.user.role);
  if (!staff) {
    const tokenOrder = readReceiptToken(url.searchParams.get('token'));
    if (!tokenOrder || tokenOrder !== order.id) return notFound();
    if (!receiptIsAvailable(order)) return notFound();
    if (doc.status !== 'final') return notFound();
  }

  const settings = settingsMap((await LocalDB.getSettings()) as { key: string; value: unknown }[]);
  const locale = String((locals as { locale?: string })?.locale ?? settingStr(settings['default_locale'], 'en'));
  const strings = publicStrings(locale).invoice;
  const issuerLabel = doc.issuer?.id
    ? registeredInvoiceIssuers(settings).find((i) => i.id === doc.issuer!.id)?.label ?? doc.issuer.id
    : undefined;
  const credited = doc.kind === 'credit_memo' ? invoicesOf(docs).find((i) => i.id === doc.invoice_record_id) : undefined;

  let bytes: Uint8Array;
  try {
    bytes = await invoicePdfBytes(
      doc,
      {
        strings,
        orderNumber: String(order.number ?? order.id),
        money: (cents) => formatMoney(cents, { currency: doc.currency || order.currency, locale }),
        issuerLabel,
      },
      await receiptFontBytes(),
      credited ? { seller: credited.seller, buyer: credited.buyer } : undefined,
    );
  } catch (err) {
    reportError(err, { where: 'invoice-record.pdf' });
    return new Response('PDF unavailable', { status: 500, headers: { 'Cache-Control': 'no-store, private' } });
  }

  return new Response(Buffer.from(bytes), {
    headers: {
      'Content-Type': 'application/pdf',
      // inline: staff open it from the order screen to read it; the buyer's
      // browser offers to save it either way.
      'Content-Disposition': `inline; filename="${invoicePdfFilename(doc, order.number)}"`,
      'Cache-Control': 'no-store, private',
      'X-Robots-Tag': 'noindex, nofollow',
      'Content-Length': String(bytes.length),
    },
  });
};
