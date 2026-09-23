/**
 * Finding the receipt font, in a checkout and in a deployed release.
 *
 * The font ships in `public/fonts/`, which means `astro build` copies it into
 * `dist/client/fonts/` — so a release carries it without a build step of its
 * own. That is deliberate: the mail test had to grow `scripts/build-mail-test.mjs`
 * precisely because it lived somewhere a release does not have, and the failure
 * mode was invisible until a deploy. `public/` is the one directory whose
 * contents are guaranteed to survive into a release.
 *
 * It is read once and kept. The bytes are ~750 KB and every receipt would
 * otherwise re-read them from disk; one copy in memory for the life of the
 * process is the right trade for a file that cannot change while the process
 * runs.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Both places it can be, in the order a release should win.
 *
 * Resolved against `process.cwd()`, which is the release root under systemd
 * (`WorkingDirectory=/var/www/<site>/current`) and the repository root in
 * development.
 */
const CANDIDATES = [
  path.join('dist', 'client', 'fonts', 'DejaVuSans.ttf'),
  path.join('public', 'fonts', 'DejaVuSans.ttf'),
];

let cached: Uint8Array | null = null;

/**
 * The font bytes, or a thrown error naming every path that was tried.
 *
 * Throwing rather than falling back to a standard PDF font is the point: the
 * fallback would produce a receipt with empty boxes where a Greek customer's
 * name should be, and a receipt that renders wrongly is worse than one that
 * did not render. The caller turns this into a 500 with a log line, and the
 * reader still has the HTML receipt.
 */
export async function receiptFontBytes(): Promise<Uint8Array> {
  if (cached) return cached;
  const tried: string[] = [];
  for (const rel of CANDIDATES) {
    const abs = path.resolve(process.cwd(), rel);
    tried.push(abs);
    try {
      cached = new Uint8Array(await fs.readFile(abs));
      return cached;
    } catch {
      /* try the next one */
    }
  }
  throw new Error(`Receipt font not found. Tried: ${tried.join(', ')}`);
}

/** Test seam: forget the cached copy. */
export function resetReceiptFont(): void {
  cached = null;
}
