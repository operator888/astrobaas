/**
 * Notice when ANOTHER process changed the plugin set, and rebuild.
 *
 * ## The gap
 *
 * The plugin registry — which plugins are active, the routes and admin pages
 * they own, the payment gateways they contribute, the content types (built-in
 * comments/reviews and the admin-defined ones) — is built once per process
 * and rebuilt by `reloadPlugins()` after a toggle, an install or a settings
 * change. In the process that took the write. `reloadPlugins`' own comment
 * said so: other replicas keep their old registry until they restart.
 *
 * With two replicas that is not a cosmetic difference. Switch a payment
 * plugin OFF in the admin and the other replica keeps offering it at checkout;
 * switch comments on and half the requests to /api/content/comment 404.
 *
 * ## The fix
 *
 * A cheap fingerprint of exactly what a bootstrap reads — each plugin's id,
 * active flag and declarative manifest, and the three settings that change
 * the content-type registry — taken when the registry is built. On a request,
 * at most once per PLUGIN_REGISTRY_RECHECK_MS, the fingerprint is read again
 * in the BACKGROUND (the request that notices is not delayed); if it differs,
 * the registry is rebuilt with `reloadPlugins()`, which serves the old
 * registry until the new one is ready, exactly as a local change does.
 *
 * Bound: another process's plugin change is live here within 15 s of the next
 * request, plus one bootstrap.
 */
import crypto from 'node:crypto';
import { COMMENTS_ENABLED_SETTING, REVIEWS_ENABLED_SETTING } from '../../core/builtin-collections';
import { ADMIN_CONTENT_TYPES_SETTING } from '../../core/content-types';

export const PLUGIN_REGISTRY_RECHECK_MS = 15_000;

/** The settings whose change alters what a bootstrap registers. */
export const REGISTRY_SETTING_KEYS: readonly string[] = [
  COMMENTS_ENABLED_SETTING,
  REVIEWS_ENABLED_SETTING,
  ADMIN_CONTENT_TYPES_SETTING,
];

interface RecordLike {
  id: string;
  active?: boolean;
  settings?: unknown;
}

/**
 * What a bootstrap depends on, hashed. Plugin CONFIG (other settings on the
 * record) is deliberately left out: changing it does not trigger a reload in
 * the writing process either, and a fingerprint stricter than that would
 * rebuild registries that nobody asked to rebuild.
 */
export function pluginRegistryFingerprint(
  records: readonly RecordLike[],
  settings: Readonly<Record<string, unknown>>,
): string {
  const plugins = [...records]
    .map((r) => {
      const s = r.settings as { manifest?: unknown } | undefined;
      return [r.id, !!r.active, s && typeof s === 'object' && 'manifest' in s ? s.manifest ?? null : null];
    })
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const relevant = REGISTRY_SETTING_KEYS.map((k) => [k, settings[k] ?? null]);
  return crypto.createHash('sha256').update(JSON.stringify([plugins, relevant])).digest('hex');
}

export interface RegistryRecheckOptions {
  read: () => Promise<string>;
  reload: () => Promise<void>;
  intervalMs?: number;
  now?: () => number;
  log?: (msg: string) => void;
}

export class RegistryRecheck {
  private built: string | null = null;
  private lastCheck = 0;
  private running: Promise<void> | null = null;
  private readonly intervalMs: number;
  private readonly now: () => number;

  constructor(private readonly opts: RegistryRecheckOptions) {
    this.intervalMs = opts.intervalMs ?? PLUGIN_REGISTRY_RECHECK_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  /** The registry was just built from state with this fingerprint. */
  markBuilt(fingerprint: string): void {
    this.built = fingerprint;
    this.lastCheck = this.now();
  }

  /** Called per request. Never waits, never throws. */
  poke(): void {
    if (this.running || this.built === null) return;
    if (this.now() - this.lastCheck < this.intervalMs) return;
    this.lastCheck = this.now();
    const seen = this.built;
    this.running = (async () => {
      const current = await this.opts.read();
      // Only if nothing rebuilt the registry meanwhile — a local reload has
      // already marked a newer fingerprint.
      if (current !== seen && this.built === seen) {
        this.opts.log?.('[astrobaas] the plugin set was changed by another process; rebuilding the registry');
        await this.opts.reload();
      }
    })()
      .catch((err) => {
        this.opts.log?.(`[astrobaas] plugin registry re-check failed: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => { this.running = null; });
  }

  /** The re-check in flight, if any. For tests and diagnostics. */
  settled(): Promise<void> {
    return this.running ?? Promise.resolve();
  }
}
