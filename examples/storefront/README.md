# AstroBaaS storefront starter

A complete shop front for an [AstroBaaS](https://astrobaas.com) backend: a home
page, the catalogue with nested categories, product pages, a cart, checkout with
every payment method the CMS offers, order confirmation, and the blog.

It is a **static site**. Every page is built from the CMS at build time; only
the cart and checkout talk to the CMS from the browser. Host it anywhere that
serves files — Netlify, Cloudflare Pages, S3, nginx — separately from the CMS.

- No API key and no secret. Everything it reads is public, and checkout is
  public in the CMS.
- No prices are computed here. The CMS prices every cart from product ids and
  quantities, and ignores any amount a browser sends.
- Strict Content-Security-Policy on every page: no `'unsafe-inline'` (Astro
  allows its own scripts and styles by hash), and the CMS is the only other
  origin the browser may call.
- Keyboard and screen-reader friendly: a skip link, labelled controls, visible
  focus, and colours that pass WCAG 2.1 AA in light and dark mode.

## Quick start

You need Node 22.12+ and a running AstroBaaS with the shop switched on
(**Settings → Shop**) and at least one product.

```bash
cp .env.example .env         # set PUBLIC_CMS_URL to your CMS
npm install
npm run dev                  # http://localhost:3000
```

On the **CMS**, allow this site's origin, or the browser refuses the cart and
checkout calls:

```bash
CORS_ORIGINS="http://localhost:3000 https://shop.example.com"
```

## Going live

1. **Set the CMS's Site URL to this storefront, and "Address of this CMS" to
   the CMS** (both in Settings → General). Payment providers send buyers back to
   `<Site URL>/checkout/success`, which is here. Receipt links in order emails
   use the CMS address; a CMS older than that setting links to
   `<Site URL>/receipt?token=…` instead, and `/receipt` here forwards it.
   `GET /api/health/deep` on the CMS warns while Site URL is wrong.
2. **List the storefront in `CORS_ORIGINS`** on the CMS — the exact origin, not
   `*`.
3. `npm run build` and upload `dist/`.
4. **Rebuild when the catalogue changes.** Pages are static, so a new product
   appears after the next build. Point a CMS webhook (Settings → Webhooks,
   events `product.*` and `post.*`) at your host's build hook.

If your host can send response headers, also send
`Content-Security-Policy: frame-ancestors 'none'` — a `<meta>` policy cannot
carry that directive.

## What is where

| Path | What it is |
| --- | --- |
| `/` | Featured products (or the newest) and the latest posts |
| `/shop/` | Everything, with the category tree |
| `/shop/<category>/` | A category **including its subcategories** |
| `/product/<slug>/` | One product; variants are a required choice |
| `/cart/` | The cart, priced by the CMS each time it opens |
| `/checkout/` | Address, delivery, payment, place order |
| `/order/placed/` | Confirmation; bank-transfer and cash instructions |
| `/checkout/success/`, `/checkout/cancelled/` | Where payment providers return the buyer |
| `/receipt/` | Forwards the emailed receipt link to the CMS |
| `/search/` | Results for the header search box, which also suggests products and categories as you type |
| `/blog/` | Posts |

The header menu is the CMS's own (**Site → Navigation**) when one is set, so it
can change without a deploy; otherwise Shop and Blog. Write menu links as paths
on this site.

The code is small on purpose:

- `src/lib/cms.ts` — every build-time read from the CMS.
- `src/scripts/shop-api.ts` — the browser's calls: quote, place, pay.
- `src/lib/cart.ts` — the cart: ids and quantities in `localStorage`, nothing
  else.
- `src/styles/shop.css` — one stylesheet; change the tokens at the top.

## Behaviour worth knowing

- **Pressing "Place order" again is safe.** The `Idempotency-Key` is built from
  the cart and the order's details, so the same order sent twice — after a
  timeout, a reload, or from another tab — returns the first order rather than
  placing a second. Changing the details (fixing a typo in the address) makes it
  a new request; a fresh cart makes it a new order.
- **The total is re-checked before ordering.** If the delivery details or a
  price change moved it, checkout shows the new total and asks again.
- **"Thank you" is not "paid".** An order becomes paid when the provider's
  signed webhook reaches the CMS, a few seconds after the buyer returns.
- **Catalogue visibility is honoured.** Products set to *search only* or
  *hidden* stay off the shelves, but their pages exist, so a direct link works.
- **Anti-spam on checkout**, when the shop switches it on, is solved in the
  browser automatically.

## Licence

MIT — copy it into your own project and change anything.
