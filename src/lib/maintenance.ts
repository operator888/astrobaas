import { escapeHtml as esc } from './escape-html';
import { settingBool } from './settings-map';
/**
 * Maintenance mode.
 *
 * ## What this covers, and what it cannot
 *
 * This serves a maintenance page while the PROCESS IS RUNNING: a migration is
 * in progress, a plugin is being installed, or an operator has deliberately
 * closed the shop for a window.
 *
 * It cannot cover a redeploy in which the process is stopped and replaced —
 * nothing served by the app can, because there is no app. That gap belongs to
 * whatever sits in front (nginx, Caddy, a platform router), and
 * `MAINTENANCE.md` carries a ready-made static page and the config for it.
 * Saying so is the point: a maintenance screen that only works when the site is
 * already up would be a comforting thing to have shipped and useless in the one
 * minute it was bought for.
 *
 * ## Why the switch is an environment variable first
 *
 * The most likely reason to need this page is that the DATABASE is busy,
 * migrating, or unreachable. A flag stored in the database would therefore be
 * unreadable at exactly the moment it is needed. `MAINTENANCE_MODE` is read
 * from the process environment, so the decision costs nothing and cannot fail.
 *
 * A settings-backed toggle exists as well, for a planned window an admin can
 * switch on from the UI without a redeploy. It is strictly the second source,
 * and a failure to read it means "not in maintenance" rather than an error.
 *
 * ## Why 503 and not 200
 *
 * A 200 tells a crawler this IS the page now. Sites have lost rankings that way
 * — Google reads a 200 maintenance notice as the content having been replaced
 * with "we are down". 503 with `Retry-After` says "temporarily unavailable, come
 * back", which is the true statement and the one search engines are built to
 * handle.
 *
 * ## What stays reachable, and why each one must
 *
 *   /healthz, /readyz   a load balancer that cannot health-check the process
 *                       will pull it out of rotation and the maintenance page
 *                       becomes a connection error.
 *   /admin, /login      an operator locked out of the admin cannot turn
 *                       maintenance OFF. That has to be impossible.
 *   /api/auth/*         because logging in is how you reach the admin.
 *   static assets       the maintenance page's own CSS is inline, but the admin
 *                       behind it is a real application.
 *
 * And a signed-in staff member sees the normal site, so the shop can be checked
 * before the window is lifted.
 */

/** Settings key for the admin-facing toggle. */
export const MAINTENANCE_KEYS = {
  enabled: 'maintenance_enabled',
  message: 'maintenance_message',
  /** ISO instant the operator expects to be back. Optional. */
  until: 'maintenance_until',
} as const;

/** Default seconds for `Retry-After` when no end time is known. */
export const DEFAULT_RETRY_AFTER = 300;

export interface MaintenanceState {
  active: boolean;
  /** Shown on the page. Never contains anything the operator did not write. */
  message: string;
  /** ISO instant, when the operator gave one. */
  until?: string;
  /** Seconds, for the Retry-After header. */
  retryAfter: number;
}

const DEFAULT_MESSAGE = 'We are carrying out scheduled maintenance and will be back shortly.';

/** An env var is on for '1', 'true', 'on', 'yes' — and nothing else. */
export function envFlagOn(raw: string | undefined): boolean {
  const v = String(raw ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

/**
 * Seconds until `until`, bounded.
 *
 * Bounded at both ends on purpose. A `Retry-After` of 0 invites a hot retry
 * loop from every client at once — precisely when the server is least able to
 * take it — and a huge one tells a crawler not to come back for a day over a
 * ten-minute window.
 */
export function retryAfterFor(until: string | undefined, nowMs: number): number {
  if (!until) return DEFAULT_RETRY_AFTER;
  const at = Date.parse(until);
  if (!Number.isFinite(at)) return DEFAULT_RETRY_AFTER;
  const seconds = Math.ceil((at - nowMs) / 1000);
  if (seconds <= 0) return 30;
  return Math.min(Math.max(seconds, 30), 3600);
}

/**
 * Resolve the state.
 *
 * `settings` is optional and may be null: the caller is expected NOT to hit the
 * database on the request path when the environment variable already decided.
 */
export function resolveMaintenance(
  env: Record<string, string | undefined>,
  settings: Record<string, unknown> | null,
  nowMs: number,
): MaintenanceState {
  const byEnv = envFlagOn(env.MAINTENANCE_MODE);
  // `settingBool`, for the reason `envFlagOn` above already accepts a
  // vocabulary: a value written through the settings API arrives as whatever
  // JSON the caller sent, and `"true" === true` is false — so an operator who
  // closed the shop through the API had it stay open while every readback said
  // closed. The env var and the setting now agree on what "on" means.
  const bySetting = settingBool(settings?.[MAINTENANCE_KEYS.enabled], false);
  const active = byEnv || bySetting;

  // The environment wins for the message too, so an operator mid-incident can
  // say something specific without a database that may be the problem.
  const rawMessage = typeof env.MAINTENANCE_MESSAGE === 'string' && env.MAINTENANCE_MESSAGE.trim()
    ? env.MAINTENANCE_MESSAGE
    : typeof settings?.[MAINTENANCE_KEYS.message] === 'string'
      ? (settings[MAINTENANCE_KEYS.message] as string)
      : '';

  const rawUntil = typeof env.MAINTENANCE_UNTIL === 'string' && env.MAINTENANCE_UNTIL.trim()
    ? env.MAINTENANCE_UNTIL.trim()
    : typeof settings?.[MAINTENANCE_KEYS.until] === 'string'
      ? (settings[MAINTENANCE_KEYS.until] as string).trim()
      : '';

  const until = rawUntil && Number.isFinite(Date.parse(rawUntil)) ? rawUntil : undefined;

  return {
    active,
    message: (rawMessage.trim() || DEFAULT_MESSAGE).slice(0, 500),
    until,
    retryAfter: retryAfterFor(until, nowMs),
  };
}

/**
 * Paths that must answer normally even while the shop is closed.
 *
 * Prefix-matched, and each entry is here because locking it would either take
 * the site out of rotation or lock the operator out of the switch.
 */
/**
 * Matched EXACTLY, or as a path prefix ending at a `/` boundary.
 *
 * The boundary matters. A bare `startsWith` would leave `/administrators-guide`
 * and `/logins-explained` serving normally during a window, because they begin
 * with `/admin` and `/login` — the same loose-prefix mistake this codebase has
 * made before with route rules.
 */
const ALWAYS_OPEN_PATHS = [
  '/healthz',
  '/readyz',
  '/metrics',
  '/admin',        // the operator has to be able to turn this off
  '/login',
  '/logout',
  '/forgot-password',
  '/reset-password',
  '/api/auth',     // logging in is how you reach the admin
  // A deploy turns maintenance ON, deploys, then asserts health before turning
  // it off. A deep check held by the maintenance gate could never be that gate's
  // exit condition.
  '/api/health',
  // Payment-provider webhooks (S3.5). A shopper who paid a minute before the
  // window opened is still being confirmed by Stripe, PayPal or Klarna while it
  // is open. Answered 503, the capture waited for the provider's retry
  // schedule — hours, for some — and the order sat "pending" with the money
  // already taken. Each webhook authenticates itself by signature or
  // credentialled fetch-back, so letting it through exposes nothing the
  // closed shop was hiding.
  //
  // A prefix with a `/` boundary, so it covers every provider slug and
  // nothing that merely starts with the same letters.
  '/api/payments/webhook',
];

/**
 * Matched as a literal prefix, boundary or not.
 *
 * Only for asset namespaces where the tail is a filename rather than a path:
 * `/favicon.ico`, `/favicon-32.png`. Nothing here can be a page.
 */
const ALWAYS_OPEN_PREFIXES = [
  '/_astro/',      // the admin is a real application and needs its assets
  '/favicon',
];

export function isAlwaysOpen(pathname: string): boolean {
  if (ALWAYS_OPEN_PREFIXES.some((p) => pathname.startsWith(p))) return true;
  return ALWAYS_OPEN_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/** Roles that see the live site during maintenance, so it can be checked. */
const PREVIEW_ROLES = new Set(['admin', 'editor', 'author', 'manager']);

export function canPreviewDuringMaintenance(role: string | undefined): boolean {
  return !!role && PREVIEW_ROLES.has(role);
}

/**
 * Should this request be answered with the maintenance page?
 *
 * Pure, so every rule above is testable without a server — including the ones
 * whose failure mode is "the operator cannot get back in".
 */
export function shouldHoldRequest(
  state: MaintenanceState,
  pathname: string,
  role: string | undefined,
): boolean {
  if (!state.active) return false;
  if (isAlwaysOpen(pathname)) return false;
  if (canPreviewDuringMaintenance(role)) return false;
  return true;
}


/**
 * The page itself.
 *
 * Self-contained: inline CSS, no fonts, no scripts, no database. It has to
 * render when everything else is unavailable, which rules out anything that
 * needs a second request to succeed. It is also the one page guaranteed to be
 * seen by someone already having a bad day, so it says what is happening and
 * when to come back rather than apologising at length.
 */
export function maintenanceHtml(state: MaintenanceState, siteTitle = 'This site'): string {
  const back = state.until
    ? `<p class="until">Expected back by <time datetime="${esc(state.until)}">${esc(
      new Date(state.until).toUTCString(),
    )}</time></p>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(siteTitle)} — under maintenance</title>
<meta name="robots" content="noindex">
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    padding: 2rem; background: #f8fafc; color: #0f172a;
    font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  .card {
    max-width: 32rem; width: 100%; background: #fff; border: 1px solid #e2e8f0;
    border-radius: 14px; padding: 2.5rem; text-align: center;
    box-shadow: 0 1px 3px rgb(15 23 42 / .08);
  }
  .icon { width: 3rem; height: 3rem; margin: 0 auto 1.25rem; color: #2563eb; }
  h1 { margin: 0 0 .75rem; font-size: 1.5rem; letter-spacing: -.02em; }
  p { margin: 0 0 .5rem; color: #475569; }
  .until { margin-top: 1.25rem; font-size: .875rem; color: #64748b; }
  @media (prefers-color-scheme: dark) {
    body { background: #0b1220; color: #e2e8f0; }
    .card { background: #111a2e; border-color: #1e293b; box-shadow: none; }
    p { color: #94a3b8; }
    .until { color: #64748b; }
  }
</style>
</head>
<body>
  <main class="card">
    <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
      <path stroke-linecap="round" stroke-linejoin="round" d="M11.42 15.17 17.25 21A2.652 2.652 0 0 0 21 17.25l-5.877-5.877M11.42 15.17l2.496-3.03c.317-.384.74-.626 1.208-.766M11.42 15.17l-4.655 5.653a2.548 2.548 0 1 1-3.586-3.586l6.837-5.63m5.108-.233c.55-.164 1.163-.188 1.743-.14a4.5 4.5 0 0 0 4.486-6.336l-3.276 3.277a3.004 3.004 0 0 1-2.25-2.25l3.276-3.276a4.5 4.5 0 0 0-6.336 4.486c.091 1.076-.071 2.264-.904 2.95l-.102.085m-1.745 1.437L5.909 7.5H4.5L2.25 3.75l1.5-1.5L7.5 4.5v1.409l4.26 4.001m-1.745 1.437 1.745-1.437m6.615 8.206L15.75 15.75M4.867 19.125h.008v.008h-.008v-.008Z" />
    </svg>
    <h1>Back shortly</h1>
    <p>${esc(state.message)}</p>
    ${back}
  </main>
</body>
</html>`;
}

/** Build the response, headers included. */
export function maintenanceResponse(state: MaintenanceState, siteTitle?: string): Response {
  return new Response(maintenanceHtml(state, siteTitle), {
    status: 503,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Retry-After': String(state.retryAfter),
      // A cached maintenance page outlives the maintenance. This one must never
      // be stored by a browser, a CDN, or a proxy.
      'Cache-Control': 'no-store, must-revalidate',
    },
  });
}

/** JSON, for API callers — a storefront should not have to parse HTML to learn this. */
export function maintenanceApiResponse(state: MaintenanceState): Response {
  return new Response(
    JSON.stringify({
      success: false,
      error: {
        message: state.message,
        code: 'MAINTENANCE',
        ...(state.until ? { retry_at: state.until } : {}),
      },
    }),
    {
      status: 503,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(state.retryAfter),
        'Cache-Control': 'no-store, must-revalidate',
      },
    },
  );
}
