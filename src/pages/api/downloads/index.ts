/**
 * GET /api/downloads?receipt=<receipt token> — the buyer's downloads for one
 * order, with freshly signed links. For a headless storefront that renders
 * its own "your downloads" page; the CMS's own `/receipt` page shows the same.
 *
 * Authorised by the RECEIPT token the buyer already has (it is in the order
 * confirmation email): it names one order and proves nothing else. A bad,
 * expired or erased-order token, and an order with no downloads, all answer
 * the same empty 404, for the reason /receipt gives — telling them apart
 * would confirm which orders exist.
 *
 * The answer never contains a file's location or the download log: names,
 * state, links, remaining count, expiry.
 */
import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { readReceiptToken, receiptIsAvailable } from '../../../lib/commerce/receipt';
import {
  buyerDownloads, loadDownloadSettings, reconcileEntitlements,
} from '../../../lib/commerce/download-entitlements';
import { mediaBaseFor } from '../../../lib/media-base';

export const prerender = false;

export const GET: APIRoute = async ({ url, request }) => {
  try {
    await LocalDB.init();
    const orderId = readReceiptToken(url.searchParams.get('receipt'));
    // Reconciled on read: an order that reached a paid status by a path that
    // did not grant (an import, an order older than this feature) still gets
    // its downloads the first time the buyer looks.
    const order = orderId ? (await reconcileEntitlements(orderId)).order : null;
    if (!order || !receiptIsAvailable(order) || !order.entitlements?.length) {
      const res = ApiResponseBuilder.notFound('Downloads');
      res.headers.set('Cache-Control', 'private, no-store');
      return res;
    }
    const settings = await loadDownloadSettings();
    const origin = (await mediaBaseFor(request)) ?? url.origin;
    const res = ApiResponseBuilder.success(
      buyerDownloads(order, settings.linkTtlHours, { origin }),
      undefined,
      { order_number: order.number, link_ttl_hours: settings.linkTtlHours },
    );
    res.headers.set('Cache-Control', 'private, no-store');
    return res;
  } catch (err) {
    console.error('Downloads list error:', err);
    return ApiResponseBuilder.serverError('Could not list downloads');
  }
};
