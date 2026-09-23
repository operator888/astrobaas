/**
 * Curated plugin registry client.
 *
 * A registry is a single JSON index served over HTTPS listing available
 * declarative plugins. Installing "by id from a known index" is what turns
 * "arbitrary JSON from the internet" into "reviewed content from a source the
 * operator chose", which is the difference between a marketplace and a liability.
 *
 * Trust model — deliberately modest, and stated plainly:
 *   - The index URL is operator-configured (`PLUGIN_REGISTRY_URL`) and fetched
 *     over HTTPS. TLS authenticates the host; the index is the trust root.
 *   - Each entry carries a `sha256` of its manifest bytes. We verify it before
 *     the manifest is even parsed, so a compromised/edited CDN copy is rejected
 *     even though it was served over a valid TLS connection.
 *   - Manifests are then run through the SAME validator as an upload. The
 *     registry is a distribution channel, never a bypass.
 *   - This is NOT author signing (no public-key trust chain). Adding
 *     detached signatures is a natural follow-up; the checksum field is the
 *     hook for it.
 *
 * SSRF: the registry URL is operator-supplied config, but it is still fetched
 * server-side, so it goes through the same URL guard as webhooks unless
 * explicitly allowed (a self-hoster pointing at an internal mirror sets
 * WEBHOOK_ALLOW_PRIVATE=1).
 */
import crypto from 'node:crypto';
import { checkWebhookUrl } from './url-guard';

export const DEFAULT_REGISTRY_URL = 'https://raw.githubusercontent.com/operator888/astrobaas/main/examples/registry/index.json';

/**
 * What kind of thing a listing describes.
 *
 * - `declarative` — a JSON manifest the operator can install with one click.
 *   Data only, no code, checksum-verified. The default.
 * - `bundled` — a CODE plugin that already ships inside AstroBaaS. Some things
 *   a manifest genuinely cannot express: a connector that swaps the email
 *   transport, for instance, is an implementation, not data. Listing them keeps
 *   the marketplace an honest directory of everything available instead of only
 *   the installable subset — an operator browsing for "how do I send email"
 *   should find the answer, and it happens to be one they already have.
 *   These carry no manifestUrl and are NEVER downloaded or executed from the
 *   registry; the entry is a pointer to something already in the build.
 */
export type RegistryEntryKind = 'declarative' | 'bundled';

export interface RegistryEntry {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  homepage?: string;
  /** Defaults to 'declarative' when absent, so older indexes keep working. */
  kind?: RegistryEntryKind;
  /**
   * Absolute https URL of the manifest JSON. Required for `declarative`
   * entries; absent for `bundled` ones, which have nothing to fetch.
   */
  manifestUrl?: string;
  /** Hex SHA-256 of the manifest bytes. Required — no checksum, no install. */
  sha256?: string;
}

export interface RegistryIndex {
  name?: string;
  updated_at?: string;
  plugins: RegistryEntry[];
}

const FETCH_TIMEOUT_MS = 8_000;
const MAX_BYTES = 512 * 1024;

export function registryUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.PLUGIN_REGISTRY_URL || DEFAULT_REGISTRY_URL).trim();
}

/** Registry support can be turned off entirely (uploads still work). */
export function registryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PLUGIN_REGISTRY_DISABLED !== '1' && !!registryUrl(env);
}

function assertFetchable(url: string): void {
  if (!/^https:\/\//i.test(url)) throw new Error('Registry URLs must be https.');
  const guard = checkWebhookUrl(url);
  if (!guard.ok) throw new Error(`Refusing to fetch an internal address: ${guard.reason}`);
}

/** Fetch with a timeout and a hard byte cap, returning the raw text. */
async function fetchText(url: string): Promise<string> {
  assertFetchable(url);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const len = Number(res.headers.get('content-length') || '0');
    if (len && len > MAX_BYTES) throw new Error('Response too large.');
    const text = await res.text();
    if (text.length > MAX_BYTES) throw new Error('Response too large.');
    return text;
  } finally {
    clearTimeout(timer);
  }
}

function isEntry(v: unknown): v is RegistryEntry {
  if (!v || typeof v !== 'object') return false;
  const e = v as Record<string, unknown>;
  if (typeof e.id !== 'string' || typeof e.name !== 'string' || typeof e.version !== 'string') {
    return false;
  }
  const kind = e.kind === undefined ? 'declarative' : e.kind;
  if (kind !== 'declarative' && kind !== 'bundled') return false;

  // A bundled entry is a directory pointer to code already in the build. It has
  // nothing to download, so requiring a URL + checksum would be meaningless —
  // but it must NOT carry them either, or a listing could imply the registry
  // can deliver code it cannot.
  if (kind === 'bundled') {
    return e.manifestUrl === undefined && e.sha256 === undefined;
  }

  // Declarative entries are fetched and executed as configuration, so the
  // checksum stays mandatory: no checksum, no install.
  return (
    typeof e.manifestUrl === 'string' &&
    /^https:\/\//i.test(e.manifestUrl) &&
    typeof e.sha256 === 'string' &&
    /^[a-f0-9]{64}$/i.test(e.sha256)
  );
}

/** Fetch + parse the registry index. Entries missing a valid checksum are dropped. */
export async function fetchRegistryIndex(env: NodeJS.ProcessEnv = process.env): Promise<RegistryIndex> {
  const text = await fetchText(registryUrl(env));
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Registry index is not valid JSON.');
  }
  const plugins = Array.isArray((parsed as any)?.plugins) ? (parsed as any).plugins : [];
  return {
    name: typeof (parsed as any)?.name === 'string' ? (parsed as any).name : undefined,
    updated_at: typeof (parsed as any)?.updated_at === 'string' ? (parsed as any).updated_at : undefined,
    plugins: plugins.filter(isEntry),
  };
}

/**
 * Fetch one entry's manifest and verify its SHA-256 BEFORE parsing. Returns the
 * parsed JSON for the caller to run through validateManifest().
 */
export async function fetchRegistryManifest(entry: RegistryEntry): Promise<unknown> {
  // A bundled listing is a directory pointer to code already in the build —
  // there is nothing to fetch, and it must not look installable. Checked before
  // anything else so a malformed entry can never reach fetchText with
  // `undefined` and skip the checksum gate below.
  if ((entry.kind ?? 'declarative') === 'bundled') {
    throw new Error(
      `"${entry.id}" is a bundled plugin — it ships with AstroBaaS and is activated from Plugins, not installed from the registry.`,
    );
  }
  if (!entry.manifestUrl || !entry.sha256) {
    throw new Error(`Registry entry "${entry.id}" is missing a manifest URL or checksum — refusing to install.`);
  }

  const text = await fetchText(entry.manifestUrl);
  const digest = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
  if (digest.toLowerCase() !== entry.sha256.toLowerCase()) {
    throw new Error(`Checksum mismatch for "${entry.id}" — refusing to install (expected ${entry.sha256}, got ${digest}).`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Manifest is not valid JSON.');
  }
}
