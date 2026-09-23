# Publishing AstroBaaS to npm

**Status: published from 0.1.0.** Two packages leave this repository, both from
`.github/workflows/publish.yml` on a `v*` tag, both with provenance:

| package | dist-tag | what it is |
| --- | --- | --- |
| `astrobaas` | `alpha` | the libraries (`/core`, `/client`, `/plugins`) and the CLI |
| `astrobaas-mcp` | `latest` | the MCP server alone, zero dependencies — staged from `bin/` by `scripts/build-mcp-pkg.mjs` |

`astrobaas-mcp` is on `latest` because `npx astrobaas-mcp` resolves `latest`,
and it is an HTTP client of the REST API, not the server; opting in to
pre-release software happens when you install the server.

---

## What publishing fixes, precisely

Three claims in the docs carried a caveat until the first publish:

| Before | After publishing |
|---|---|
| `import { createClient } from 'astrobaas/client'` works only inside this repo | works in any project |
| `npx astrobaas-mcp` in an MCP client config 404s (that config is read from your home directory, not the clone) | works from anywhere |
| `npx astrobaas …` works only from the project directory | works from anywhere |

**What it does NOT fix.** `astrobaas init` is not a project scaffolder — it
writes a `.env` with a generated `AUTH_SECRET`. Installing from npm still does
not give you a running CMS; you clone the repo for that. Do not let the README
imply otherwise, because that is the exact claim this project already had to
walk back once.

## Order of operations

1. **Make the repository public first.** An npm package whose `repository` field
   points at a private repo cannot be audited by anyone deciding whether to
   trust it, and the link is the main thing a careful installer checks.
2. **Have the CLA gate live** (`.github/workflows/cla.yml`) before either. See
   [LICENSING.md](./LICENSING.md).
3. **Then publish**, under a dist-tag (below).

## Dist-tags: why the first release is not `latest`

`npm install astrobaas` resolves the **`latest`** tag. Publishing pre-alpha
there hands it to everyone who types the obvious command, including people who
never read the status line.

So pre-1.0 releases publish under **`alpha`**:

```bash
npm install astrobaas@alpha     # deliberate
```

The registry points `latest` at a package's very first version whatever tag it
was published under, so `npm install astrobaas` resolves 0.1.0 too. From then
on the workflow leaves `latest` where it is.

The workflow defaults to `alpha` and **never moves `latest`**. Promoting a
release is a separate, deliberate command:

```bash
npm dist-tag add astrobaas@1.0.0 latest
```

Suggested progression: `alpha` → `beta` → `latest`. Move `latest` only when the
README's "What's not done yet" section holds nothing you would be embarrassed
to have a stranger find after typing `npm install astrobaas`.

## How to cut a release

```bash
npm version patch          # or minor / major — writes package.json AND tags
git push --follow-tags
```

The tag push runs the workflow, which re-runs the full gate (build, unit, smoke
across all three storage drivers, package build, `npm audit`) before publishing.
A tag whose name disagrees with `package.json` fails the job rather than
shipping a version no tag points at.

Never `npm publish` from a laptop. It ships whatever is in that working tree.

## One-time setup

1. An npm account with **2FA enabled**.
2. A **granular access token** (Access Tokens → Granular), scoped to the
   `astrobaas` package, read+write, with an expiry you will renew. A classic
   automation token works but grants far more than this job needs.
3. Add it to the repository as the secret **`NPM_TOKEN`**.

## Provenance

The workflow publishes with `--provenance`, which requires `id-token: write` and
only works from CI. It cryptographically ties the tarball on npm to this
repository, this workflow and this commit, and npm shows the link on the package
page.

For a package that handles sessions, uploads and payment webhooks, this is worth
the two lines of config: it turns "trust the maintainer" into something a
stranger can verify.

## Publishing is close to irreversible

- A version can be unpublished **only within 72 hours**.
- After that it is permanent, and the **name is taken forever** either way.
- A published version cannot be replaced — you can only publish a new one.

So the first publish is worth doing on a quiet afternoon rather than at the end
of a long session. Run the workflow manually with `dry_run: true` first; it packs
and validates without publishing, and the default is `true` precisely so an
accidental click cannot ship anything.

## What actually ships

Controlled by `files` in `package.json`:

```
pkg/                          built JS + .d.ts for astrobaas/{core,client,plugins}
bin/                          astrobaas, astrobaas-mcp
bin/lib/api-client.mjs        the REST client both binaries use
scripts/setup.mjs
scripts/reset-password.mjs    `npm run reset-password`
scripts/scaffold.mjs          `astrobaas plugin new`, `theme new`
scripts/lib/db-target.mjs     shared by the offline scripts above
.env.example
LICENSE, README.md            (npm always includes these)
```

The four `scripts/` and `bin/lib/` entries are there because the CLI shells out
to them: leave one out and the published binary fails at the moment someone
runs it, not at pack time.

Verified with `npm pack --dry-run`, which the workflow prints on every run —
read it once before the first publish. Application source (`src/`), tests,
`db.json` and uploads are all excluded — the only `.mjs` files that ship are the
ones the binaries call.

## After the first publish

Done with 0.1.0: the "Not on npm yet" notes are gone, the MCP examples use
`npx -y astrobaas-mcp`, and the README names the `alpha` tag. Still standing:

- **Move to trusted publishing.** Once both packages exist, configure npm's
  trusted publisher (this repository, `publish.yml`) on each and delete the
  `NPM_TOKEN` secret — the first publish needed a token only because a package
  that does not exist has no settings page.
- **Watch for typosquats.** Once a name is popular, `astrobass`, `astro-baas`
  and similar get registered by others. npm will not police this for you.
- **Renew the token** before it expires, or the first release after expiry fails
  in a way that looks like a broken workflow.
