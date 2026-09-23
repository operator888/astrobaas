import type { APIRoute } from 'astro';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { LocalDB, getSchemaStatus } from '../../../lib/localdb';
import { getUploadsDir } from '../../../lib/paths';
import { loadSharp } from '../../../lib/media/sharp';
import { mediaBaseFor } from '../../../lib/media-base';
import { normaliseOrigin } from '../../../lib/site-url';
import { describeRateLimitStore, sharedRateLimitStore } from '../../../lib/rate-limit';
import { isRelational } from '../../../lib/storage/select-adapter';
import { pluginBootstrapReport } from '../../../plugins';
import { DERIVATIVE_WIDTHS } from '../../../lib/media/derivatives';
import {
  getEmailTransport, lastSendOutcome, lastSendWarning, emailConfigProblem, emailConfigWarnings, resolveReplyTo,
  campaignsEnabled,
} from '../../../lib/email';
import { describeHealthToken, healthTokenUsable } from '../../../lib/health-token';
import { describeCorsPosture } from '../../../lib/security-headers';
import { enabledProviders } from '../../../lib/payments/registry';
import { returnUrlVerdict } from '../../../lib/payments/return-url-check';

/**
 * GET /api/health/deep — the check that would have caught this month.
 *
 * ## Why the shallow one was not enough
 *
 * `/healthz` proves the process is alive and the database answers a read. Every
 * production problem this month passed it: pages returned 200, images rendered,
 * nothing appeared in the error log. The shop was broken and the monitoring was
 * green, because nothing was checking the things that had actually failed —
 * an image pipeline whose native module would not load, and a CMS that did not
 * know its own public address.
 *
 * ## The rule this endpoint is built on
 *
 * EXERCISE, DO NOT INTROSPECT. "The sharp module is present" is not the check;
 * "sharp encoded an image just now" is. A module that imports and cannot encode
 * is the same outage with better paperwork, and that is very close to what
 * happened on a live shop.
 *
 * ## Status
 *
 *   200  everything essential works (warnings may still be present)
 *   503  at least one essential check failed
 *
 * so a deploy script can simply assert the status and stop.
 *
 * ## Access
 *
 * Admin session, or `Authorization: Bearer $HEALTH_TOKEN` for a deploy script
 * that has no session. The route is in PUBLIC_API_GET so the middleware lets it
 * KNOCK — the allow-list decides who may knock, this handler decides who may
 * read. Without a token configured, only an admin session gets in.
 *
 * It is gated because the body names plugin specifiers, storage driver, upload
 * paths and env var names: a precise map of how to attack the install.
 */
export const prerender = false;

type Level = 'ok' | 'warn' | 'fail';

interface Check {
  name: string;
  status: Level;
  /** One sentence an operator can act on. Never a stack trace. */
  detail: string;
  /** Facts, never secrets. Variable NAMES are fine; values are not. */
  data?: Record<string, unknown>;
}

/** A check that throws is a FAILED check, never a 500 on the health endpoint. */
async function run(name: string, fn: () => Promise<Check>): Promise<Check> {
  try {
    return await fn();
  } catch (err) {
    return { name, status: 'fail', detail: `check threw: ${(err as Error).message}` };
  }
}

/* ------------------------------------------------------------------ *
 * The checks
 * ------------------------------------------------------------------ */

/**
 * Email cannot be exercised the way the other checks are — a real send per
 * health poll spams a mailbox — so this one is two facts instead: which
 * transport is RESOLVED (the console default means password resets and
 * magic links land in a log, hence warn), and how the most recent actual
 * send went, recorded by sendEmail() itself. Transport identity comes from
 * the resolver, never env-sniffing: the smtp2go plugin activates by setting
 * the override, and webhook-without-URL silently falls back to console.
 */
async function checkEmailChannel(): Promise<Check> {
  const name = 'email_channel';
  const transport = getEmailTransport().name;
  const last = lastSendOutcome();
  const rt = resolveReplyTo();
  const data: Record<string, unknown> = {
    transport,
    // Addresses, not secrets: where replies go, and whether bulk mail is
    // refused. Both are things an operator checks after pointing at a server.
    ...('replyTo' in rt && rt.replyTo ? { reply_to: rt.replyTo } : {}),
    campaigns: campaignsEnabled(),
    ...(last ? { last_send: last } : {}),
  };
  // WHY mail is not configured, when somebody tried to configure it. This
  // check used to say only that mail had fallen back to the console and to
  // suggest SMTP2GO or a webhook — so an operator who had set
  // EMAIL_TRANSPORT=smtp and mistyped one variable was pointed at a different
  // product instead of at the variable.
  const problem = emailConfigProblem();
  if (transport === 'console') {
    return {
      name,
      status: 'warn',
      detail: problem
        ? `mail is not being sent: ${problem}. Until it is fixed, password resets, magic links and 2FA recovery land in the server log.`
        : 'no real email channel — password resets, magic links and 2FA recovery land in the server log. '
          + 'Configure EMAIL_TRANSPORT=smtp (your own mail server), SMTP2GO, or EMAIL_TRANSPORT=webhook.',
      data,
    };
  }
  if (problem) {
    // A plugin transport is sending, so the environment's transport is not in
    // use — but it is still wrong, and would be the fallback without the plugin.
    return { name, status: 'warn', detail: `${problem} (mail is going through ${transport} instead)`, data };
  }
  // Wrong but not stopping mail — an unusable EMAIL_REPLY_TO. Said here as
  // well as at startup, because a startup line scrolls away and this does not.
  const warnings = emailConfigWarnings();
  if (warnings.length) {
    return { name, status: 'warn', detail: warnings.join(' '), data };
  }
  // A failure, or an outcome UNKNOWN — the server never answered the end of the
  // message, so it may have been delivered. Worded apart (lastSendWarning): an
  // operator told "failed" resends a message the customer may already have.
  // `data.last_send.outcome` is "unknown" in the second case.
  const lastProblem = lastSendWarning(last);
  if (lastProblem) {
    return { name, status: 'warn', detail: lastProblem, data };
  }
  return { name, status: 'ok', detail: `outbound email via ${transport}`, data };
}

/**
 * A 1×1 PNG, as bytes.
 *
 * Encoding a real image is the only thing that distinguishes "sharp is
 * installed" from "sharp works". Inline rather than read from disk so the check
 * cannot fail for a reason that has nothing to do with the pipeline.
 */
const TEST_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function checkImagePipeline(): Promise<Check> {
  const name = 'image_pipeline';
  const sharp = await loadSharp();
  if (!sharp) {
    return {
      name,
      status: 'fail',
      detail:
        'sharp is not loadable, so uploads get no dimensions and no derivatives '
        + 'and the storefront is served full-size originals. Fix: npm install --include=optional sharp',
    };
  }
  // Encode, and read the result back. A resize that silently produced zero
  // bytes would pass a "did it throw" check.
  const out = await sharp(TEST_PNG).resize({ width: 1 }).webp({ quality: 80 }).toBuffer();
  if (!out || out.length === 0) {
    return { name, status: 'fail', detail: 'sharp loaded but produced an empty image' };
  }
  // RIFF....WEBP — prove it is actually WebP and not a passthrough.
  const isWebp = out.length >= 12
    && out.toString('ascii', 0, 4) === 'RIFF'
    && out.toString('ascii', 8, 12) === 'WEBP';
  if (!isWebp) {
    return { name, status: 'fail', detail: 'sharp produced output that is not WebP' };
  }
  return {
    name,
    status: 'ok',
    detail: `encoded a test image to WebP (${out.length} bytes)`,
    data: {
      sharp_version: (sharp as any).versions?.sharp ?? null,
      derivative_widths: [...DERIVATIVE_WIDTHS],
    },
  };
}

async function checkUploadsWritable(): Promise<Check> {
  const name = 'uploads_writable';
  const root = getUploadsDir();
  // The DATED directory, which is where uploads actually land — a root that is
  // writable while its subdirectories are not (a restrictive umask, a mount) is
  // a real shape, and probing only the root would call it healthy.
  const now = new Date();
  const dir = path.join(root, String(now.getUTCFullYear()), String(now.getUTCMonth() + 1).padStart(2, '0'));
  const probe = path.join(dir, `.health-${crypto.randomUUID()}`);
  try {
    // mkdir INSIDE the try, exactly like the upload route does. A fresh install
    // has no uploads directory yet, and reporting that as a failure would send
    // an operator chasing a permission problem that does not exist — but a
    // read-only parent makes this mkdir throw, and outside the try that threw
    // past the reporting and lost the very path an operator needs to see.
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(probe, 'ok');
    await fs.unlink(probe);
  } catch (err) {
    return {
      name,
      status: 'fail',
      detail: `cannot write to the uploads directory: ${(err as Error).message}`,
      data: { uploads_dir: root, probed: dir },
    };
  }
  return { name, status: 'ok', detail: 'wrote and removed a probe file', data: { uploads_dir: root, probed: dir } };
}

async function checkPublicSiteUrl(request: Request): Promise<Check> {
  const name = 'public_site_url';
  const rows = await LocalDB.getSettings();
  const configured = rows.find((r) => r.key === 'public_site_url')?.value;
  const base = await mediaBaseFor(request);

  // Graded on whether the stored value actually RESOLVED, not on whether a row
  // exists. A row holding `cms.example.com` (no scheme) is refused on save now,
  // but one written before that validator existed would sit there looking
  // configured while every media URL quietly came from the request instead.
  const resolvedFromSetting = normaliseOrigin(configured);
  if (resolvedFromSetting) {
    return {
      name,
      status: 'ok',
      detail: 'set, and media URLs are built from it',
      data: { media_base: base, source: 'public_site_url setting' },
    };
  }
  if (typeof configured === 'string' && configured.trim()) {
    return {
      name,
      status: 'fail',
      detail:
        `public_site_url is set to something unusable (${JSON.stringify(configured).slice(0, 80)}) `
        + 'and is being ignored. It must be an absolute http(s) address, e.g. https://cms.example.com.',
      data: { media_base_guessed: base },
    };
  }
  // Unset. The user asked for this to be LOUD rather than for the fallback to
  // pass for configuration — a fallback that works by accident is what made the
  // original failure take weeks to surface.
  return {
    name,
    status: 'warn',
    detail:
      'public_site_url is NOT set. Media URLs are being guessed from the Host header each request '
      + 'arrives with — wrong the moment a storefront on another host, a worker or a CLI asks, and '
      + 'influenced by whatever the caller sent. Set it in Settings → Address of this CMS.',
    data: { media_base_guessed: base },
  };
}

/**
 * Where a payment provider sends a buyer back to (payments/return-url-check.ts).
 *
 * ADVICE, never a failure: this one catches its own errors rather than letting
 * `run` turn them into `fail`, so a settings hiccup cannot make a deploy gate
 * refuse a release over a return address.
 */
async function checkPaymentReturnUrls(request: Request, site: unknown): Promise<Check> {
  const name = 'payment_return_urls';
  try {
    const rows = await LocalDB.getSettings();
    const map: Record<string, unknown> = {};
    for (const r of rows) map[r.key] = r.value;
    const verdict = returnUrlVerdict({
      onlineProviders: enabledProviders(process.env as Record<string, string | undefined>).map((p) => p.id),
      siteUrlSetting: map.site_url,
      siteUrlEnv: site ?? process.env.SITE_URL,
      publicSiteUrl: map.public_site_url,
      requestOrigin: new URL(request.url).origin,
    });
    return { name, ...verdict };
  } catch (err) {
    return { name, status: 'warn', detail: `could not check payment return URLs: ${(err as Error).message}` };
  }
}

async function checkDatabase(write: boolean): Promise<Check> {
  const name = 'database';
  const dbVersion = await LocalDB.getSchemaVersion();
  const expected = getSchemaStatus().version;
  const driver = isRelational() ? 'relational' : process.env.DATABASE_URL ? 'libsql' : 'lowdb';

  if (dbVersion < expected) {
    return {
      name,
      status: 'fail',
      detail: `the database is at schema ${dbVersion} but this build expects ${expected} — a migration has not finished`,
      data: { driver, schema_version: dbVersion, expected_schema_version: expected },
    };
  }

  if (!write) {
    return {
      name,
      status: 'ok',
      detail: 'readable, and the schema matches this build (write probe skipped)',
      data: { driver, schema_version: dbVersion, expected_schema_version: expected, write_probe: false },
    };
  }

  // A real write. A read-only filesystem, a full disk or a database in
  // recovery all read perfectly well and fail on the first write — which on a
  // shop means the first order.
  const before = await LocalDB.nextSequence('health_probe');
  const after = await LocalDB.nextSequence('health_probe');
  if (!(after > before)) {
    return {
      name,
      status: 'fail',
      detail: 'a write appeared to succeed but did not persist',
      data: { driver, schema_version: dbVersion },
    };
  }
  return {
    name,
    status: 'ok',
    detail: 'read, wrote, and the schema matches this build',
    data: { driver, schema_version: dbVersion, expected_schema_version: expected, write_probe: true },
  };
}

async function checkRateLimitStore(): Promise<Check> {
  const name = 'rate_limit_store';
  const described = describeRateLimitStore();
  // describeRateLimitStore reads the ENVIRONMENT. A libSQL store that is
  // configured and broken fails OPEN — every request allowed, no limiting at
  // all — while still describing itself as shared. So exercise it.
  // THE store the middleware limits with, not a fresh one. Constructing a store
  // per health check opened a libSQL client per call, and — worse — a new store
  // counts correctly even when the one the application is using has failed,
  // which is the exact condition this check exists to detect.
  const store = sharedRateLimitStore();
  // A FIXED key, deliberately. A random one wrote a brand-new row into the
  // shared rate_limits table on every health check and never removed it — a
  // monitor polling every minute would add 1,440 orphaned rows a day.
  //
  // The limit is absurdly high so the reused bucket can never reach it and turn
  // a healthy store into a reported failure; what is asserted is that the count
  // MOVES, not that it is under any particular cap.
  const key = 'health:rate-limit-probe';
  // consume(), not hit(): hit() answers "still allowed?", which is true for both
  // of two calls under any limit and so cannot tell a counting store from one
  // that has silently stopped counting. consume() reports the budget.
  const first = await store.consume(key, 60_000, 1_000_000_000);
  const second = await store.consume(key, 60_000, 1_000_000_000);
  const counting = second.remaining < first.remaining;

  if (!counting) {
    return {
      name,
      status: 'fail',
      detail:
        `the ${described.kind} rate-limit store is not counting, so the limiter is failing open `
        + 'and no request is being limited',
      data: { kind: described.kind, shared: described.shared },
    };
  }
  if (described.warning) {
    return {
      name,
      status: 'warn',
      detail: described.warning,
      data: { kind: described.kind, shared: described.shared },
    };
  }
  return {
    name,
    status: 'ok',
    detail: described.shared
      ? 'counting, and shared across replicas'
      : 'counting, per-process (fine for a single node; a second replica would double the effective limit)',
    data: { kind: described.kind, shared: described.shared },
  };
}

/**
 * CORS_ORIGINS=* (S3.14). A warning, never a failure: the wildcard is a
 * legitimate choice a live storefront may depend on, and a deploy gate that
 * refused it would turn a posture note into an outage. See
 * `describeCorsPosture` for what the wildcard does and does not expose.
 */
async function checkCorsPosture(): Promise<Check> {
  const name = 'cors_origins';
  const posture = describeCorsPosture();
  if (posture.warning) {
    return { name, status: 'warn', detail: posture.warning, data: { wildcard: true } };
  }
  return {
    name,
    status: 'ok',
    detail: posture.origins.length
      ? `${posture.origins.length} origin(s) allow-listed for cross-origin API calls`
      : 'no cross-origin API callers allowed (CORS_ORIGINS unset)',
    data: { wildcard: false, origins: posture.origins.length },
  };
}

/**
 * Uploads that the pipeline could not fully process.
 *
 * The upload route records a `pipeline` report on any record it could not
 * complete. Writing that and reading it nowhere would be this codebase's most
 * reliable bug — a field the schema names and no copy consults — and on exactly
 * the signal this whole feature exists to surface. A shop that uploaded fifty
 * photos during an hour when sharp was broken has fifty degraded records, and
 * the live check above would say "ok" because sharp works NOW.
 */
async function checkStoredMedia(): Promise<Check> {
  const name = 'media_records';
  const media = await LocalDB.getMedia();
  const degraded = media.filter((m) => {
    const p = (m as { pipeline?: { status?: string } }).pipeline;
    return p && p.status && p.status !== 'ok';
  });
  const images = media.filter((m) => String(m.mime_type || '').startsWith('image/'));
  const withoutVariants = images.filter(
    (m) => !Array.isArray((m as { variants?: unknown[] }).variants)
      || (m as { variants: unknown[] }).variants.length === 0,
  );

  if (degraded.length > 0) {
    return {
      name,
      status: 'fail',
      detail:
        `${degraded.length} media record(s) were uploaded while the image pipeline was degraded — `
        + 'they have no derivatives and the storefront is being served the full-size file. '
        + 'Re-run: npm run media:backfill -- --apply',
      data: {
        degraded: degraded.length,
        examples: degraded.slice(0, 5).map((m) => ({
          url: m.url,
          reason: (m as { pipeline?: { reason?: string } }).pipeline?.reason,
        })),
      },
    };
  }
  if (withoutVariants.length > 0) {
    // Not a failure: every library uploaded before this feature existed looks
    // like this, and the shop is no worse off than it was. It is worth saying
    // once, with the command that fixes it.
    return {
      name,
      status: 'warn',
      detail:
        `${withoutVariants.length} of ${images.length} images have no generated sizes — they predate `
        + 'the image pipeline. Run: npm run media:backfill -- --apply',
      data: { images: images.length, without_variants: withoutVariants.length },
    };
  }
  return {
    name,
    status: 'ok',
    detail: `${images.length} image(s), all with generated sizes`,
    data: { images: images.length },
  };
}

async function checkPlugins(): Promise<Check> {
  const name = 'plugins';
  const r = pluginBootstrapReport();

  if (!r.at) {
    return { name, status: 'warn', detail: 'plugins have not finished bootstrapping in this process yet' };
  }

  const data = {
    requested: r.requested,
    registered: r.registered,
    active: r.active,
    failed_to_load: r.failed,
    force_activate: r.force_activate,
    force_activate_unknown: r.force_activate_unknown,
    active_without_implementation: r.active_without_implementation,
  };

  // Active in the database with nothing loaded is the expensive one: the admin
  // shows the module switched ON and nothing it provides is happening. On an
  // optician's shop that is prescription validation silently not running.
  if (r.active_without_implementation.length > 0) {
    return {
      name,
      status: 'fail',
      detail:
        `${r.active_without_implementation.join(', ')} — active in the database with no implementation loaded. `
        + 'Everything these provide is silently not happening. Check ASTROBAAS_PLUGINS.',
      data,
    };
  }
  if (r.failed.length > 0) {
    return {
      name,
      status: 'fail',
      detail: r.failed.map((f) => `${f.specifier}: ${f.reason}`).join('; '),
      data,
    };
  }
  if (r.force_activate_unknown.length > 0) {
    return {
      name,
      status: 'warn',
      detail:
        `ASTROBAAS_PLUGINS_ACTIVATE names ${r.force_activate_unknown.join(', ')}, which are not installed`,
      data,
    };
  }
  return {
    name,
    status: 'ok',
    detail: `${r.registered.length} loaded, ${r.active.length} active, none requested and missing`,
    data,
  };
}

/* ------------------------------------------------------------------ *
 * The route
 * ------------------------------------------------------------------ */

/** Constant-time compare, so the token cannot be guessed a byte at a time. */
function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * The token's own length, graded (src/lib/health-token.ts).
 *
 * The docs have always asked for 32+ characters and the gate below has always
 * accepted 16+, so a short token worked and nobody was told. It still works —
 * breaking a live deploy script over a read-only diagnostics credential is
 * worse than the weakness — but it is now a warning here, and a line in the
 * log the first time the check runs. A token under 16 is ignored outright,
 * which used to be indistinguishable from not having set one.
 */
let healthTokenWarned = false;
async function checkHealthToken(): Promise<Check> {
  const { level, detail } = describeHealthToken(process.env.HEALTH_TOKEN);
  if (level === 'warn' && !healthTokenWarned) {
    healthTokenWarned = true;
    console.warn(`[health] ${detail}`);
  }
  return { name: 'health_token', status: level, detail };
}

/**
 * The off-site backup's persisted record (backup/offsite-state.ts). Warn-only:
 * see `backupHealth` for why a failing bucket is not a failed health check.
 */
async function checkOffsiteBackup(): Promise<Check> {
  const { offsiteConfig, lastBackup, backupHealth } = await import('../../../lib/backup/offsite');
  const cfg = offsiteConfig();
  let persisted = null;
  if (cfg) {
    try {
      const { readOffsiteState } = await import('../../../lib/backup/offsite-state');
      persisted = await readOffsiteState();
    } catch (err) {
      // Still warn-level: the database check is the one that fails for this.
      return { name: 'offsite_backup', status: 'warn', detail: `Could not read the backup record: ${(err as Error).message}` };
    }
  }
  const h = backupHealth(cfg, persisted, lastBackup(), Date.now());
  return { name: 'offsite_backup', status: h.status, detail: h.detail, data: h.data };
}

export const GET: APIRoute = async ({ request, locals, url, site }) => {
  await LocalDB.init();

  const token = process.env.HEALTH_TOKEN;
  const presented = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  const byToken = healthTokenUsable(token) && !!presented && tokenMatches(presented, token);
  const bySession = locals.user?.role === 'admin';

  if (!byToken && !bySession) {
    // 404, not 403.
    //
    // Not because it hides the endpoint — /openapi.json documents it, and
    // /healthz, /readyz and /metrics are discoverable anyway. It is 404 because
    // 403 would confirm that a HEALTH_TOKEN is configured and that guessing one
    // is worth an attacker's time, and because "no such resource" is how every
    // other route in this API refuses something the caller may not see.
    return new Response(JSON.stringify({ success: false, error: { message: 'Not found', code: 'NOT_FOUND' } }), {
      status: 404,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }

  // The write probe rewrites the whole document on the lowdb and libSQL doc
  // drivers, so a monitor polling every ten seconds would be rewriting the
  // database every ten seconds. On by default because a deploy script asking
  // "is this healthy" means "can it take an order"; `?write=0` for pollers.
  const write = url.searchParams.get('write') !== '0';

  const checks = await Promise.all([
    run('health_token', checkHealthToken),
    run('image_pipeline', checkImagePipeline),
    run('uploads_writable', checkUploadsWritable),
    run('public_site_url', () => checkPublicSiteUrl(request)),
    run('cors_origins', checkCorsPosture),
    run('database', () => checkDatabase(write)),
    run('rate_limit_store', checkRateLimitStore),
    run('plugins', checkPlugins),
    run('media_records', checkStoredMedia),
    run('email_channel', checkEmailChannel),
    run('payment_return_urls', () => checkPaymentReturnUrls(request, site)),
    run('offsite_backup', checkOffsiteBackup),
  ]);

  const failed = checks.filter((c) => c.status === 'fail');
  const warned = checks.filter((c) => c.status === 'warn');
  const ok = failed.length === 0;

  const body = {
    ok,
    status: failed.length ? 'fail' : warned.length ? 'warn' : 'ok',
    now: new Date().toISOString(),
    failed: failed.map((c) => c.name),
    warnings: warned.map((c) => c.name),
    checks,
  };

  return new Response(JSON.stringify(body, null, 2), {
    // Non-200 when anything essential is broken, so `curl -fsS` is a
    // sufficient assertion in a deploy script.
    status: ok ? 200 : 503,
    headers: {
      'Content-Type': 'application/json',
      // A cached health response is worse than none.
      'Cache-Control': 'no-store',
    },
  });
};
