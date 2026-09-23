/**
 * Loading sharp, and remembering what happened.
 *
 * ## The failure this exists to make visible
 *
 * sharp is an OPTIONAL dependency with a native binary. `npm install
 * --no-optional`, an unsupported platform, a glibc mismatch or a failed
 * postinstall all produce a working install with no sharp — and the upload route
 * used to swallow that in a bare `catch { return null }` with no `else` branch.
 * Uploads kept answering 201, no derivative was ever written, nothing was
 * logged, and a live shop served full-size originals for WEEKS before anyone
 * noticed.
 *
 * A dependency that can vanish silently is a dependency whose absence has to be
 * a reportable fact. So the load result is cached WITH its failure reason, and
 * the deep health check reads it — see api/health/deep.ts, which does not stop
 * at "the module is present" but actually encodes an image with it, because a
 * module that loads and cannot encode is the same outage with better paperwork.
 */

import { configureSharp } from './derivatives';

export interface SharpStatus {
  available: boolean;
  /** Why not, when not. A message an operator can search for. */
  reason?: string;
  /** sharp's own version, when it loaded. */
  version?: string;
}

let mod: any = null;
let status: SharpStatus | null = null;
let loading: Promise<any> | null = null;

async function doLoad(): Promise<any> {
  try {
    const m: any = await import('sharp');
    const resolved = m?.default ?? m;
    if (typeof resolved !== 'function') {
      status = { available: false, reason: 'sharp resolved to something that is not callable' };
      return null;
    }
    configureSharp(resolved);
    status = {
      available: true,
      version: (resolved.versions && resolved.versions.sharp) || undefined,
    };
    mod = resolved;
    return resolved;
  } catch (err) {
    // The message matters more than the stack: it names the missing .node file
    // or the glibc version, which is what tells an operator whether to
    // reinstall or to change base image.
    const reason = (err as Error)?.message || String(err);
    status = { available: false, reason };
    // Once per process, loudly. A silent skip is what cost two weeks of
    // full-size images on a live shop.
    console.error(
      '[astrobaas] the image pipeline is NOT available: sharp failed to load.\n'
      + `  reason: ${reason}\n`
      + '  Uploaded images will be stored as-is: no dimensions, no derivatives,\n'
      + '  and the storefront will be served full-size originals.\n'
      + '  Fix with: npm install --include=optional sharp',
    );
    return null;
  }
}

/**
 * The sharp module, or null.
 *
 * Memoised on the PROMISE, so twenty concurrent uploads on a cold process do not
 * each pay the native module load — and, when it fails, do not each print the
 * warning twenty times.
 */
export async function loadSharp(): Promise<any> {
  if (mod) return mod;
  if (status && !status.available) return null;
  if (!loading) {
    loading = doLoad().finally(() => {
      loading = null;
    });
  }
  return loading;
}

/**
 * What happened, for the health check.
 *
 * Forces a load if one has not been attempted, so a health check on a fresh
 * process reports the truth rather than "unknown".
 */
export async function sharpStatus(): Promise<SharpStatus> {
  if (!status) await loadSharp();
  return status ?? { available: false, reason: 'not attempted' };
}

/** Test seam. Never called by production code. */
export function _resetSharpForTest(): void {
  mod = null;
  status = null;
  loading = null;
}
