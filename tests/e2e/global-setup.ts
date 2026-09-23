/**
 * Deliberately a no-op.
 *
 * This used to wipe /tmp/astrocms-e2e-db.json so each run started clean. It did
 * not work: Playwright starts `webServer` BEFORE globalSetup, so the server had
 * already booted against the previous run's database — `seedIfEmpty()` found an
 * existing admin@local and skipped seeding — and this then deleted the file out
 * from under a process still holding it in memory.
 *
 * The effect was a suite that silently tested stale seed data, and any change
 * to seeding was invisible until someone removed the file by hand.
 *
 * The wipe now runs as part of the `webServer.command` in playwright.config.ts,
 * where it is guaranteed to precede boot. This file stays so the config's
 * `globalSetup` key keeps resolving, and so the reasoning is recorded at the
 * place someone would look first.
 */
export default function globalSetup() {
  /* intentionally empty — see the comment above */
}
