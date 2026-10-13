/**
 * Finance — invoicing and bookkeeping for AstroBaaS ("your own Lexware").
 *
 * Quotes, invoices and credit notes with GoBD-safe numbering and archiving;
 * XRechnung and ZUGFeRD e-invoices out, e-invoices and receipts in; bank
 * statement import with automatic payment matching; dunning; recurring
 * invoices; the VAT return figures; DATEV export for the Steuerberater; and a
 * Lexware Office importer. Everything is reachable from the admin, the REST
 * API, webhooks and MCP.
 *
 * See src/plugins/finance/README.md.
 */
import { definePlugin, PLUGIN_HOOKS, sendEmail, createPluginStore, LocalDB } from 'astrobaas/core';
import type { Order } from 'astrobaas/core';
import type { PluginRouteContext } from '../../lib/plugin-platform/routes';
import { receiptFontBytes } from '../../lib/commerce/receipt-font';
import { escapeHtml } from '../../lib/escape-html';
import { makeRoutes } from './routes';
import { Finance, type Deps } from './lib/service';
import { orderToSale } from './lib/shop';
import { emitFinanceEvent } from './lib/events';
import appScript from './admin/app-script';

export const FINANCE_PLUGIN_ID = 'finance';

/** Where customer links point: the backend that serves them, not the storefront. */
function publicOrigin(requestUrl?: URL): string {
  const env = process.env.FINANCE_PUBLIC_URL || process.env.SITE_URL;
  if (env) return env.replace(/\/+$/, '');
  return requestUrl ? requestUrl.origin : '';
}

function deps(requestUrl?: URL): Deps {
  return {
    fontBytes: () => receiptFontBytes(),
    fire: (event, data) => { void emitFinanceEvent(event, data).catch(() => undefined); },
    sendEmail: (msg) => sendEmail({ ...msg, category: 'transactional' }),
    siteUrl: async () => publicOrigin(requestUrl),
  };
}


export default definePlugin({
  id: FINANCE_PLUGIN_ID,
  name: 'Finance',
  version: '1.0.0',
  description: 'Invoices, quotes, credit notes, expenses, bank matching, dunning, VAT return figures, DATEV export and e-invoicing (XRechnung / ZUGFeRD) — your own Lexware.',
  author: 'Theodor Dimitriou',

  routes: makeRoutes((ctx: PluginRouteContext) => deps(ctx.url)),

  adminPages: [
    {
      path: '',
      title: 'Finanzen',
      nav: { label: 'Finanzen', order: 5 },
      roles: ['admin', 'manager'],
      render: ({ csrf }) => `<div id="fin-app" data-csrf="${escapeHtml(csrf)}"><p class="text-sm text-gray-500">Lädt…</p></div>`
        + '<noscript><p class="text-sm text-red-700">Das Finanzmodul braucht JavaScript.</p></noscript>',
      script: appScript,
    },
  ],

  actions: {
    /**
     * A completed shop order becomes an invoice, finalized and marked paid —
     * when the operator switched that on. Idempotent on the order id, so a
     * status flipping back and forth never invoices twice.
     */
    [PLUGIN_HOOKS.AFTER_ORDER_STATUS_CHANGE]: async (order: Order) => {
      if (order.status !== 'completed') return;
      const store = createPluginStore(FINANCE_PLUGIN_ID, LocalDB);
      const fin = new Finance(store, deps());
      const settings = await fin.settings();
      if (!settings.auto_invoice_shop_orders) return;
      const sale = orderToSale(order);
      if (!sale) return;
      try {
        await fin.inboundSale(sale, 'shop');
      } catch (e) {
        console.error(`[finance] could not invoice order ${order.number}:`, (e as Error).message);
        await fin.log('shop', 'shop.invoice_failed', 'order', order.id, (e as Error).message);
      }
    },
  },

  migrations: [
    // v1: nothing to transform — the version is stamped so later migrations
    // know where this install started.
    { version: 1, name: 'initial', up: async () => undefined },
  ],
});
