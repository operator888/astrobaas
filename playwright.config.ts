import { defineConfig, devices } from '@playwright/test';

/**
 * Browser-level e2e tests. These drive a real Chromium against the production
 * standalone build. Run with:  npm run e2e   (after `npx playwright install chromium`).
 *
 * The webServer is started against an isolated temp DB/uploads dir so tests are
 * deterministic (fresh seed admin/admin) and never touch your dev db.json.
 */
const PORT = 4399;
const DB_PATH = '/tmp/astrocms-e2e-db.json';
const UPLOADS_DIR = '/tmp/astrocms-e2e-uploads';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    /*
     * `retain-on-failure`, not `on-first-retry`, because `retries` above is 0.
     *
     * With no retries there is never a first retry, so the old setting captured
     * a trace on exactly no runs — it read like diagnostics and was dead
     * config. That cost real time: a CI-only ERR_ABORTED had to be diagnosed
     * from a stack trace and reproduced by hand, because the run that failed
     * kept nothing. Traces from passing tests are discarded, so this is free on
     * a green run and the whole story on a red one.
     */
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // The wipe happens HERE, not in globalSetup, because Playwright starts the
    // webServer BEFORE globalSetup runs. The old arrangement therefore booted
    // the server against the PREVIOUS run's database: seedIfEmpty() found an
    // admin@local already present and skipped seeding, so any change to seed
    // data or to the bootstrap password was invisible until someone deleted
    // /tmp/astrocms-e2e-db.json by hand. globalSetup then deleted the file the
    // running server was still holding in memory, which is worse than useless.
    //
    // Found while changing the bootstrap password: 18 tests failed, and passed
    // again the moment the file was removed manually.
    command: `rm -f ${DB_PATH} && rm -rf ${UPLOADS_DIR} && node ./dist/server/entry.mjs`,
    url: `http://127.0.0.1:${PORT}/healthz`,
    timeout: 60_000,
    // Always start a fresh server bound to the temp DB so tests never run
    // against a stale process from a previous build.
    reuseExistingServer: false,
    env: {
      AUTH_SECRET: 'e2e-secret-key-at-least-32-characters-long',
      COOKIE_SECURE: '0',
      HOST: '127.0.0.1',
      PORT: String(PORT),
      DB_PATH,
      UPLOADS_DIR,
      // An allow-listed origin so the embeddable-widget CORS/preflight path is
      // exercisable. Only the BUILT server routes OPTIONS through our
      // middleware — under `astro dev` Vite answers it first — so the preflight
      // assertion has to live in this suite.
      CORS_ORIGINS: 'https://frontend.example.com',
      // The whole suite is ONE client making several hundred requests in under
      // a minute — nothing like the real traffic the 60/min default is sized
      // for. Leaving it produced 429s partway through, and the symptoms were
      // deeply misleading: a product that "did not appear in the list", an
      // admin row that "was missing", a read-back that returned undefined —
      // all of them a throttled request nobody was checking the status of.
      //
      // The limiter itself is still tested: tests/smoke.mjs asserts that the
      // login throttle returns 429, so raising it here does not stop exercising
      // the control, it stops the control from masking product behaviour.
      RATE_LIMIT_PER_MIN: '100000',
      // This suite drives the BUILT server, so `isProductionRuntime()` is true
      // and the D2-7 gates are live: seed-data generates a random admin
      // password, and /login refuses the published default `admin` outright.
      // Both are exactly the behaviour we want on a production artefact.
      //
      // So the suite states its own credential instead of relying on a dev
      // fallback. Deliberately NOT `admin`, and deliberately no
      // ALLOW_SEED_PASSWORD escape hatch — that way the refusal stays armed and
      // the "default password is rejected" test below is testing something real.
      ADMIN_PASSWORD: 'e2e-admin-not-the-default',
    },
  },
  globalSetup: './tests/e2e/global-setup.ts',
});
