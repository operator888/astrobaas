/**
 * `/receipt.pdf?token=…` — the same receipt as a file.
 *
 * Everything about WHO may see this is decided by `receipt.astro`'s rules, not
 * by new ones here: the same signed token, the same `receiptIsAvailable` (which
 * refuses an erased order), and the same indistinguishable 404 for a bad token,
 * an unknown order and an erased one. Two answers that differ would turn this
 * route into the order-number oracle the token was designed to prevent.
 *
 * The bytes are built by `receipt-pdf.ts` from the same `ReceiptView` the page
 * renders, so the file and the page cannot disagree about what was bought.
 */
import type { APIRoute } from 'astro';
import { LocalDB } from '../lib/localdb';
import { settingsMap, settingStr } from '../lib/settings-map';
import { formatMoney } from '../lib/money-format';
import { publicStrings } from '../lib/i18n/public-strings';
import { readReceiptToken, receiptIsAvailable, receiptView } from '../lib/commerce/receipt';
import { receiptPdfBytes, receiptPdfFilename } from '../lib/commerce/receipt-pdf';
import { receiptFontBytes } from '../lib/commerce/receipt-font';
import { reportError } from '../lib/observability';
import type { Order } from '../core/models';

export const prerender = false;

/** Identical to what the HTML page serves for the same input. */
function notFound(): Response {
  return new Response('Not found', {
    status: 404,
    headers: { 'Cache-Control': 'no-store, private', 'X-Robots-Tag': 'noindex, nofollow' },
  });
}

export const GET: APIRoute = async ({ url, locals }) => {
  await LocalDB.init();

  const orderId = readReceiptToken(url.searchParams.get('token'));
  if (!orderId) return notFound();

  const orders = (await LocalDB.getOrders()) as Order[];
  const order = orders.find((o) => String(o.id) === orderId) ?? null;
  if (!receiptIsAvailable(order) || !order) return notFound();

  const rows = await LocalDB.getSettings();
  const settings = settingsMap(rows as { key: string; value: unknown }[]);
  const locale = String((locals as { locale?: string })?.locale ?? settingStr(settings['default_locale'], 'en'));
  const strings = publicStrings(locale).receipt;

  const view = receiptView(order, (cents) => formatMoney(cents, { currency: order.currency, locale }));

  let bytes: Uint8Array;
  try {
    bytes = await receiptPdfBytes(
      view,
      strings,
      {
        seller: settingStr(settings['trader_legal_name']) || settingStr(settings['site_title']),
        sellerAddress: settingStr(settings['trader_address']),
        sellerVat: settingStr(settings['trader_vat_number']),
        buyer: String(order.name ?? ''),
        buyerAddress: String(order.address ?? ''),
      },
      await receiptFontBytes(),
    );
  } catch (err) {
    // The HTML receipt still works, so this is a 500 for the file and nothing
    // else. Logged with context because the likely cause — a release that did
    // not carry the font — is invisible from the response.
    reportError(err, { where: 'receipt.pdf' });
    return new Response('Receipt PDF unavailable', {
      status: 500,
      headers: { 'Cache-Control': 'no-store, private' },
    });
  }

  return new Response(Buffer.from(bytes), {
    headers: {
      'Content-Type': 'application/pdf',
      // `attachment`: this is a file somebody is filing, and the HTML page is
      // already the way to read it in a browser.
      'Content-Disposition': `attachment; filename="${receiptPdfFilename(view.number)}"`,
      // One URL, one person's purchase. Never a shared cache.
      'Cache-Control': 'no-store, private',
      'X-Robots-Tag': 'noindex, nofollow',
      'Content-Length': String(bytes.length),
    },
  });
};
