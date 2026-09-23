# Contributing to AstroBaaS

Thanks for considering a contribution. AstroBaaS is pre-alpha — there is a lot
of work to do and very little process to get in your way.

## Get the project running locally

Requires **Node 22.12+** (see `.nvmrc`).

```bash
git clone https://github.com/operator888/astrobaas.git
cd astrobaas
cp .env.example .env       # optional for dev; AUTH_SECRET is required in production
npm install
npm run setup              # optional: set your own admin email + password
npm run dev                # http://localhost:4321
```

Default credentials are `admin@local` / `admin`. The dashboard will warn you
to change them.

## Tests & checks before opening a PR

```bash
npm run build      # type check (astro check) + production build
npm test           # `npm run test:unit` (~150 files) + smoke test on the lowdb driver
npm run e2e        # optional: Playwright browser suite (needs: npx playwright install chromium)
```

`npm run build` and `npm test` must pass. CI runs them on every push to `main`
and every pull request. `npm run test:unit` is the long one — around 150 files
under `tests/`, run one at a time — so while you work, run the single file your
change touches (`node tests/<name>.test.mjs`) and keep the full run for before
you push.

## Where things live

- `src/middleware.ts` — auth, CSRF, rate limit, security headers.
- `src/lib/auth.ts` — session signing + PBKDF2 password hashing.
- `src/lib/apiClient.ts` — browser helper used by every admin write.
- `src/lib/localdb.ts` — the LowDB wrapper (the single source of truth).
- `src/lib/sanitize.ts` — HTML allow-list applied to user-supplied content.
- `src/lib/validate.ts` — tiny schema validator used by every API handler.
- `src/pages/api/*` — REST endpoints. Always return
  `{ success: true, data }` or `{ success: false, error: { message, code } }`.
- `src/pages/admin/*` — admin pages (SSR + small islands of JS).
- `src/pages/*` — public pages.

## Filing issues

Two kinds of issues are most useful:

1. **Bug reports** — please include the route you hit, what you did, what
   happened, and what you expected. A line from the dev server log goes a
   long way.
2. **Pickup of an open issue** — see the issue tracker. Comment
   on the corresponding tracking issue (or open one if it doesn't exist) and
   say "I want to take this one", then send a PR.

## Pull-request guidance

- Keep PRs small enough that the diff fits on one screen. Two small PRs
  almost always merge faster than one big one.
- Add a line to `CHANGELOG.md` under `[Unreleased]` if your change is one a
  user of the project would notice.
- If you change an API contract, add or update the matching check in
  `tests/smoke.mjs`. CI will catch you otherwise.
- Don't commit `db.json`, `dist/`, or anything under `public/uploads/`.
  These are gitignored; if they show up in your diff, something went wrong.

**The checklist is a merge gate, not a formality.** Open the PR with the
repository's template and tick every box in the description, including the CLA
box at the bottom. A workflow reads the description on every edit and fails the
PR if any box is still `- [ ]`, or if the description has no checklist at all.
Three of the boxes are written so "this does not touch it" is a real answer —
storage, API contract, stored data shape — so ticking them honestly is quick.
Drafts are exempt: the gate skips a draft PR and starts applying the moment you
mark it ready for review. If a box genuinely cannot be ticked, say so in the PR
and we will look at it together.

### Changing the data shape? Write a migration

If your change needs existing databases to be transformed (a new required field,
a renamed value, a backfill), add a migration in `src/lib/migrations.ts`:

- Append a new entry with the **next integer `version`**. Never edit, reorder,
  or renumber a migration that has shipped — append a corrective one instead.
- Write `up()` against the storage-agnostic `Storage` interface so it upgrades
  all three drivers at once. It **must be idempotent** — a no-op when the data is
  already in the target shape (fresh installs and re-runs must be safe).
- Add cases to `tests/migrations.test.mjs` (legacy → migrated, and idempotent).
  The per-driver boot assertion in `tests/smoke.mjs` will exercise it live.

## What to work on first

Good starter PRs (all genuinely open — see "What's not done yet" in the README):

- Add a Postgres storage adapter (the `Storage` interface is driver-agnostic;
  the libSQL relational driver is a good template).
- Localize the stock marketing home page. `src/components/DefaultHome.astro`
  still carries its headings and button labels as hardcoded English, so on a
  `SITE_LOCALES=en,de` install `/de` serves German content under an English
  hero. Everything else on the page already knows the locale.
- Add an a11y check to CI, or unit tests for the upload magic-byte sniffer and
  the backup-import path-traversal guard.

## Code of conduct

This project adheres to the [Contributor Covenant](CODE_OF_CONDUCT.md). By
participating, you are expected to uphold it. Report unacceptable behavior to
theodoros@ecommercewebservices.de.

## License and the CLA

The project is **GPL-3.0-or-later**, and it stays that way.

Contributions are covered by a **[Contributor License Agreement](CLA.md)**. A
bot asks you to sign on your first pull request — you reply to it with one
sentence, once, and later pull requests are not gated again.

The short version:

- **You keep your copyright.** Nothing is assigned or transferred. You can still
  do anything you like with your own code.
- **You grant the maintainer the right to license your contribution
  commercially**, as well as under the GPL. That is what makes a paid module on
  top of an open core possible, and the paid module is what funds the project.
- **Your contribution stays open.** The CLA commits the maintainer to keeping
  every merged contribution available under an OSI-approved licence — it can be
  licensed *additionally*, never *withdrawn*.

Why a CLA and not a DCO, and the honest case for refusing to sign one, are in
[CLA.md § Why this exists](CLA.md#why-this-exists) and
[LICENSING.md](LICENSING.md).

**If you would rather not sign, that is fine and it is not held against you.**
Open an issue describing the change instead; it will be implemented
independently and you will be credited in the commit message.
