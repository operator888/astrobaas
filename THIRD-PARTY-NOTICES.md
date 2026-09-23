# Third-party notices

AstroBaaS ships with third-party software. This file records what, under which
licence, and — where a licence asks for something beyond attribution — what the
Project does about it.

It is kept honest by `npm run audit:licenses`, which walks the **production**
dependency tree (197 packages at the time of writing), fails the build on a
licence that would make the core unsellable as part of a commercial product, and
fails on weak copyleft that is not listed here. Development dependencies are
deliberately out of scope: they are never redistributed, and a GPL test runner is
not a GPL product.

---

## Why this file exists at all

AstroBaaS is GPL-3.0 and funded by selling proprietary modules on top of it (see
[LICENSING.md](./LICENSING.md)). That model needs two things to stay true:

1. one copyright holder for the core — which is what [CLA.md](./CLA.md) protects;
2. **every dependency licensed permissively enough to redistribute inside a
   commercial product** — which is what this file and the audit protect.

The second one fails silently. A single transitive dependency under AGPL-3.0 or
SSPL would arrive on an ordinary `npm install`, nothing would break, no test
would go red, and the paid module would simply have become unsellable — with
nobody finding out until a customer's lawyer asked.

---

## The licences in the production tree

| licence | packages | notes |
| --- | ---: | --- |
| MIT | 129 | Permissive. Attribution only. |
| ISC | 9 | Permissive, functionally equivalent to MIT. |
| Apache-2.0 | 5 | Permissive, with an express patent grant. |
| BSD-2-Clause / BSD-3-Clause | 8 | Permissive. |
| MIT AND Zlib | 1 | `pako` (via `pdf-lib`, for the receipt PDF). Both permissive; keep the notices. |
| 0BSD | 1 | Public-domain equivalent. |
| CC-BY-4.0 | 1 | Attribution required — see below. |
| LGPL-3.0-or-later | 1 | Weak copyleft — see below. |
| Apache-2.0 AND LGPL-3.0-or-later AND MIT | 1 | Compound; the LGPL part is the same libvips — see below. |

The rows add up to less than the tree size because `sharp` declares one
optional prebuilt binary per platform and only the current platform's is
installed; the audit counts a licence it can read, and skips the rest.

None of these prevents distributing AstroBaaS, or a proprietary module built on
it, commercially.

---

## LGPL-3.0: libvips, via sharp

**Packages:** `@img/sharp-libvips-*` (one prebuilt binary per platform),
`@img/sharp-wasm32`
**Licence:** LGPL-3.0-or-later
**Upstream:** <https://github.com/libvips/libvips>

`sharp` — the image library that generates AstroBaaS's WebP derivatives — is
itself Apache-2.0, but it wraps **libvips**, which is LGPL-3.0. The prebuilt
libvips binaries arrive as separate npm packages and are loaded as a **shared
library at runtime**.

### What that means here

Dynamic linking against an LGPL library from a program under any licence,
including a proprietary one, is precisely what the LGPL permits. It is not a
problem to be solved; it is a set of obligations to be met, and they attach to
whoever *distributes* the combination:

- **Anyone deploying AstroBaaS from source or from npm** is not distributing
  libvips — npm fetches it directly from its own publisher, under its own
  licence, with its own notices intact. Nothing further is required.
- **Anyone shipping a bundled artefact that contains libvips** — a Docker image,
  an installer, a `node_modules` tarball assembled offline and copied to a
  customer's server — *is* distributing it, and must:
  1. keep this notice with the distribution;
  2. make the libvips source available, or pass on the written offer below;
  3. not prevent the recipient from replacing libvips with their own build.

The third point is satisfied automatically by the shape of the dependency:
libvips is a separate shared library that a recipient can substitute by
installing a different `@img/sharp-libvips-*` build or by pointing sharp at a
system libvips.

### Written offer of source

> For the LGPL-3.0-licensed libvips components distributed with AstroBaaS, the
> complete corresponding source code is available from
> <https://github.com/libvips/libvips>, at the version recorded in this
> project's `package-lock.json`. On request to
> **theodoros@ecommercewebservices.de**, the Owner will also supply that source
> directly, on a medium customarily used for software interchange, for no more
> than the cost of performing the distribution.

### The one rule for paid modules

**A paid module must never vendor sharp or libvips into its own package.** It
should depend on the core and use the core's pipeline. A paid module that
bundled libvips would be distributing an LGPL library under a proprietary
licence, which is the one shape of this that does not work.

`npm run audit:licenses` will not catch that — it audits the core. It is a rule
for the commercial repository, and it is written down here because that is the
only place anyone will look for it.

---

## CC-BY-4.0: caniuse-lite

**Package:** `caniuse-lite`
**Licence:** CC-BY-4.0
**Upstream:** <https://github.com/browserslist/caniuse-lite>

Browser-support data, pulled in by the build toolchain. CC-BY-4.0 requires
attribution and nothing else — it places no restriction on redistribution,
commercial use or licensing of the surrounding work.

> Browser compatibility data from [caniuse-lite](https://github.com/browserslist/caniuse-lite),
> © the caniuse contributors, licensed under
> [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/).

---

## Bundled, but not an npm package: DejaVu Sans

`public/fonts/DejaVuSans.ttf` (757 KB) is redistributed with this project and
embedded into every server-generated receipt PDF
(`src/lib/commerce/receipt-pdf.ts`).

**`npm run audit:licenses` cannot see it.** It walks the npm tree, and this is a
file in the repository — which is exactly why it is written down here instead.
A redistributed asset that no tool checks is the shape of licence problem that
surfaces years later.

| | |
| --- | --- |
| **Upstream** | The DejaVu Fonts project, derived from Bitstream Vera |
| **Licence** | Bitstream Vera Fonts Copyright (permissive, MIT-like); DejaVu's own changes are in the public domain; Arev-derived glyphs © Tavmjong Bah on the same terms |
| **Full text** | [`public/fonts/DejaVuSans-LICENSE.txt`](./public/fonts/DejaVuSans-LICENSE.txt), shipped beside the font |
| **Obligations** | Keep the copyright notice with the font, do not sell the font *by itself*, and do not ship a MODIFIED version under the name "DejaVu" or "Bitstream Vera" |

All three are met: the font is redistributed byte for byte as part of a larger
program, its licence file travels with it, and nothing here renames or alters
it. The licence permits use, copying, merging, publishing, distribution and
sale as part of a larger package, which is what a GPL application does.

**Why a font is shipped at all.** PDF's 14 standard fonts are WinAnsi-encoded —
Latin-1 and nothing else — so a receipt drawn in Helvetica renders Greek as
empty boxes, and this project's first users are Greek shops. Only the glyphs a
given receipt actually uses are embedded in the output, so the 757 KB source
produces a ~15 KB file.

---

## What is deliberately NOT audited

- **Development dependencies.** They are not redistributed.
- **Anything a self-hoster installs themselves.** A plugin someone writes, or a
  database they point `DATABASE_URL` at, is theirs to license.
- **The commercial packages.** They live in a separate repository and carry
  their own notices. The rule above about not vendoring libvips is theirs to
  keep.

---

## Keeping this true

```bash
npm run audit:licenses
```

It runs in CI on every pull request. When it fails on a new weak-copyleft
dependency, the fix is a decision and then two edits: add the package to this
file with its obligations, and add it to `ACKNOWLEDGED_WEAK_COPYLEFT` in
`scripts/license-audit.mjs`. When it fails on a **forbidden** licence, the fix is
to remove the dependency — that list exists because those licences end the
business model rather than complicate it.
