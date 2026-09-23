# Fonts

## DejaVuSans.ttf

Embedded in server-generated PDFs (`src/lib/commerce/receipt-pdf.ts`).

**It is not optional and it is not a style choice.** PDF's 14 standard fonts are
WinAnsi-encoded — Latin-1 and nothing else — so a receipt drawn in Helvetica
renders Greek as empty boxes. This project's first users are Greek shops, and a
receipt that loses the customer's name is not a receipt. DejaVu Sans covers
Greek and Coptic completely, along with Latin-1 and Latin Extended-A.

It lives in `public/` because that is the one directory `astro build` copies
into a release (`dist/client/fonts/`). The alternative — anywhere under `src/` —
is exactly the trap the mail test fell into: correct in a checkout, missing on
the server, invisible until a deploy.

Only the glyphs a given receipt uses are embedded in the output, so a 757 KB
font produces a PDF of roughly 11–13 KB (measured 2026-09-23 on the test
receipt: 11.3 KB in English, 13.3 KB in Greek).

**Licence:** Bitstream Vera (permissive) with DejaVu's own changes in the public
domain — full text in `DejaVuSans-LICENSE.txt`, and summarised in
[THIRD-PARTY-NOTICES.md](../../THIRD-PARTY-NOTICES.md). Redistributed unmodified
as part of a larger package, which is what that licence permits.
