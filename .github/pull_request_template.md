<!--
Keep this short. A PR that explains itself in four lines gets reviewed faster
than one with a filled-in form and no reasoning.
-->

## What this changes

<!-- One or two sentences. What is different after this merges? -->

## Why

<!-- The problem, not the patch. If it fixes an issue, link it: "Fixes #123". -->

## How it was verified

<!--
Not "tests pass" — WHICH command, and what it proved. If you fixed a bug, the
most valuable line here is evidence the test fails without your fix.
-->

```
# paste the command and the relevant output
```

- [ ] `npm run build` passes (this is `astro check && astro build` — a plain
      `astro build` does **not** type-check, and that gap has hidden real
      defects here before)
- [ ] `npm test` passes (unit + smoke on the lowdb driver)
- [ ] Storage: this does not touch it — or `npm run smoke:libsql` and
      `npm run smoke:relational` pass too (there are three drivers and they
      have disagreed before)
- [ ] API contract: unchanged — or `tests/smoke.mjs` was updated to match
- [ ] Stored data shape: unchanged — or a migration was added to
      `src/lib/migrations.ts` (idempotent, next integer version)

<!--
Three of the boxes above are written so you can tick them either way: "does not
touch it" is a real answer.
-->

## Contributor License Agreement

This project sells a paid module on top of a GPL-3.0 core, which only works
while the copyright stays with one holder. A bot will ask you to sign once on
your first PR; you keep your copyright. See
[CLA.md](https://github.com/operator888/astrobaas/blob/main/CLA.md) — the
["Why this exists"](https://github.com/operator888/astrobaas/blob/main/CLA.md#why-this-exists)
section explains the trade plainly, including the case for declining.

- [ ] I have read the CLA and am willing to sign it

<!--
EVERY box in this description — including the one directly above — has to be
ticked before this can merge. A workflow reads the description and fails the PR
while any box is still unticked, and fails it if the description carries no
checklist at all. Drafts are exempt until you mark them ready for review. If a
box genuinely cannot be ticked, say why in the PR and we will look at it
together.

If you would rather not sign the CLA, that is genuinely fine — say so and open
an issue describing the change instead. It will be implemented independently and
you will be credited in the commit.
-->
