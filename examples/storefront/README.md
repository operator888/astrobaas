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
| `/product/<slug>/` | One product; variants are a required choice. A grouped product lists its products, each with a quantity, and one "Add selected to cart" (a plain form: `/cart/?add.<id>=<qty>`) |
| `/cart/` | The cart, priced by the CMS each time it opens |
| `/checkout/` | Address, delivery, payment, place order |
| `/order/placed/` | Confirmation; bank-transfer and cash instructions |
| `/checkout/success/`, `/checkout/cancelled/` | Where payment providers return the buyer |
| `/receipt/` | Forwards the emailed receipt link to the CMS |
| `/search/` | Results for the header search box, with a sort menu (the CMS does the sorting), which also suggests popular searches, products and categories as you type |
| `/blog/` | Posts |

The header menu is the CMS's own (**Site → Navigation**) when one is set, so it
can change without a deploy; otherwise Shop and Blog. Write menu links as paths
on this site.

The code is small on purpose:

- `src/lib/cms.ts` — every build-time read from the CMS.
- `src/scripts/shop-api.ts` — the browser's calls: quote, place, pay.
- `src/lib/cart.ts` — the cart: ids and quantities in `localStorage`, nothing
  else.
- `src/lib/stock.ts` — words and a colour for the CMS's `stock_status`. It
  decides nothing: the low-stock level and the backorder rule are the shop's
  settings, derived by the CMS.
- `src/components/VariantSelector.astro` — choosing a variant (below).
  Which values can be chosen is `src/lib/variant-selection.ts`, a copy of the
  CMS's own rule (`astrobaas/client` exports it too); prices and words are
  formatted at build time in `src/lib/variant-view.ts`.
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
- **Stock badges are as fresh as the last build.** "In stock", "Low stock – 3
  left" and "Out of stock" are rendered into the static pages, so they lag the
  catalogue until the next rebuild (the webhook in *Going live* does that). The
  CMS stays the judge at checkout, and refuses an order that cannot be filled.
- **Variants are chosen option by option.** One row per option, colour then
  size, in the order of the product's attributes in the CMS. A combination that
  does not exist or is sold out is disabled and says why. The price, stock line,
  SKU and image follow the choice — the price is the CMS's `resolved` price,
  the one the checkout will charge — and the address keeps it as
  `?variant=<id>`. Without JavaScript the picker is a plain select; the cart
  itself needs JavaScript, as it always has. Like every price here, a variant's
  sale price is as fresh as the last build: rebuild when a sale starts or ends
  (the CMS's quote in the cart is always current).
- **Restyling the variant picker.** Set `--ab-variant-*` properties (on `:root`
  or `.ab-variant`): `-border`, `-border-width`, `-radius`, `-bg`, `-ink`,
  `-selected-bg`, `-selected-ink`, `-hover-border`, `-disabled-bg`,
  `-note-ink`, `-focus`, `-gap`, `-choice-gap`, `-min-target`, and for
  swatches `-swatch-size`, `-swatch-radius`, `-swatch-border`,
  `-swatch-border-light` (the edge of a pale colour), `-swatch-ring` and
  `-swatch-hatch` (the sold-out cross-hatch). Each falls back to this
  stylesheet's own tokens. The `ab-variant__*` classes are stable hooks, and
  each option group's `data-display` says how its values are drawn.
- **Colour swatches.** An option is drawn as colour or image swatches when the
  merchant ticks *Show as swatches* for it in the product editor, or gives
  every value a colour or image. The name of each value is always read to a
  screen reader and shown on hover and focus (and always under a sold-out
  swatch, and under every swatch on a touch screen); the chosen swatch has a
  ring and a check; a sold-out one is cross-hatched and says why. The colour is set
  through a CSS custom property by the bundled script, so the strict CSP needs
  no `'unsafe-inline'`.
- **Catalogue visibility is honoured.** Products set to *search only* or
  *hidden* stay off the shelves, but their pages exist, so a direct link works.
- **Anti-spam on checkout**, when the shop switches it on, is solved in the
  browser automatically.
- **Campaign attribution needs your consent banner.** `src/lib/attribution.ts`
  keeps the `utm_*` tags and ad click ids of the landing page and sends them
  with the order, but ONLY when `hasMarketingConsent()` says yes. This starter
  has no banner, so by default it asks the CMS consent API
  (`window.astrobaasConsent`, present if you load the CMS's `/consent.js`) and
  otherwise keeps nothing. Pass your own banner's answer instead if you use
  another one.

## Licence

MIT (see `LICENSE`) — copy it into your own project, open or closed, and change
anything; keep the copyright notice. The AstroBaaS CMS it talks to is GPL.
