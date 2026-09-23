/**
 * Checking OUTBOUND links (the second half of C-14).
 *
 * ## Why this is separated from the internal check, and off by default
 *
 * The internal check reads the database: instant, exact, no network. This one
 * makes requests to third-party servers, which is a different activity with
 * different failure modes, and every one of them produces a FALSE POSITIVE if
 * handled naively:
 *
 *   · **Bot protection.** Cloudflare, Akamai and friends answer 403 to anything
 *     without a browser fingerprint. The link works perfectly for a reader.
 *   · **Rate limits.** A site with forty links to one domain gets 429 on the
 *     later ones purely because we asked too fast.
 *   · **HEAD refusal.** Plenty of servers answer 405 to HEAD and 200 to GET.
 *   · **Slow hosts.** A timeout is evidence about the network at that moment,
 *     not about the link.
 *
 * A checker that reports those as broken sends an editor to "fix" working links.
 * After two of those nobody opens the report again — and then the genuinely
 * broken links go unfixed too, which is worse than never having built it. So
 * **only 404 and 410 are called broken.** Everything else is recorded as its own
 * status and shown as "could not check", which is the truth.
 *
 * ## Results live in memory
 *
 * Deliberately. A link check is a CACHE, not a record: it describes the internet
 * at a moment, and a stored result is stale the instant it is written. Keeping
 * it in memory means no schema change, no eviction policy, and no risk of a
 * months-old 404 being presented as current after a restore.
 *
 * The cost is that a restart empties it, so the report says what it has checked
 * and since when rather than implying completeness.
 *
 * ## Politeness
 *
 * One request per host per sweep, oldest-unchecked first. A shop with two
 * hundred outbound links to the same documentation site would otherwise look
 * exactly like a small denial-of-service attempt from its own server.
 */
import { checkWebhookUrl } from './url-guard';

/** How long a result is trusted before the sweep will look again. */
export const RECHECK_AFTER_MS = 24 * 60 * 60 * 1000;
/** Requests per sweep. Small: the scheduler ticks every 60s by default. */
export const MAX_CHECKS_PER_SWEEP = 8;
/** A slow host is not a broken link, but we cannot wait forever either. */
export const CHECK_TIMEOUT_MS = 8000;

export type LinkVerdict =
  /** 404 or 410 — the only statuses this reports as broken. */
  | 'broken'
  /** 2xx or 3xx. */
  | 'ok'
  /**
   * Reached, but the answer says nothing about the link: 401, 403, 429, 5xx.
   * Named separately so the UI can say "could not check" rather than "broken".
   */
  | 'unknown'
  /** Refused before any request: SSRF guard, unparseable URL. */
  | 'skipped';

export interface LinkResult {
  url: string;
  verdict: LinkVerdict;
  /** HTTP status when we got one. */
  status?: number;
  /** Why, in words, for the row in the report. */
  note: string;
  checkedAt: number;
}

/**
 * The cache. Module-level, like the view buffer and the indexing memo.
 *
 * A `let` in `.astro` frontmatter resets every request — that mistake is
 * documented in `BaseLayout`, and this is the same shape.
 */
const results = new Map<string, LinkResult>();
let startedAt: number | null = null;

/** What the report needs to describe its own completeness. */
export interface ExternalCheckState {
  results: LinkResult[];
  /** When this process first swept. Null when it never has. */
  startedAt: number | null;
  checked: number;
}

export function externalCheckState(): ExternalCheckState {
  return { results: [...results.values()], startedAt, checked: results.size };
}

/** Test seam: drop everything the process has learned. */
export function resetExternalChecks(): void {
  results.clear();
  startedAt = null;
}

/**
 * Classify one response.
 *
 * Exported so the decision is testable without a network, and so the reasoning
 * lives next to the statuses rather than inside a fetch handler.
 */
export function verdictFor(status: number): { verdict: LinkVerdict; note: string } {
  if (status === 404) return { verdict: 'broken', note: 'The page is gone (404).' };
  if (status === 410) return { verdict: 'broken', note: 'The page was deliberately removed (410).' };
  if (status >= 200 && status < 400) return { verdict: 'ok', note: `Answered ${status}.` };
  if (status === 401 || status === 403) {
    return { verdict: 'unknown', note: `Refused our request (${status}). Bot protection answers this to anything without a browser; the link probably works for a reader.` };
  }
  if (status === 429) {
    return { verdict: 'unknown', note: 'Rate-limited us (429). Says nothing about the link.' };
  }
  if (status >= 500) {
    return { verdict: 'unknown', note: `The server is having trouble (${status}). Not evidence about the link.` };
  }
  return { verdict: 'unknown', note: `Answered ${status}, which does not settle it.` };
}

/**
 * Which URLs this sweep should look at.
 *
 * Oldest-first among those due, one per host. Exported for the test: the
 * politeness rule is the part most likely to be quietly dropped in a refactor,
 * and it is invisible until a shop's own server is rate-limited by a partner.
 */
export function selectForSweep(
  urls: readonly string[],
  known: ReadonlyMap<string, LinkResult>,
  now: number,
  limit = MAX_CHECKS_PER_SWEEP,
): string[] {
  const due: { url: string; host: string; at: number }[] = [];
  for (const url of urls) {
    let host: string;
    try {
      host = new URL(url).host;
    } catch {
      continue;
    }
    const prev = known.get(url);
    if (prev && now - prev.checkedAt < RECHECK_AFTER_MS) continue;
    due.push({ url, host, at: prev ? prev.checkedAt : 0 });
  }
  // Never checked first, then least recently. Ties by url so two drivers cannot
  // produce different sweeps from the same data.
  due.sort((a, b) => (a.at - b.at) || a.url.localeCompare(b.url));

  const seenHosts = new Set<string>();
  const out: string[] = [];
  for (const d of due) {
    if (out.length >= limit) break;
    if (seenHosts.has(d.host)) continue;
    seenHosts.add(d.host);
    out.push(d.url);
  }
  return out;
}

/** Injected so the test needs no network. */
export type Fetcher = (url: string, init: RequestInit) => Promise<{ status: number }>;

/**
 * Check the URLs due for a look, and remember what came back.
 *
 * HEAD first, GET on 405 or 501: plenty of servers refuse HEAD and answer GET
 * perfectly. Without the fallback every one of them is reported as unknown, and
 * the report fills with noise that hides the real 404s.
 */
export async function sweepExternalLinks(
  urls: readonly string[],
  opts: { now?: number; fetcher?: Fetcher; limit?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<number> {
  const now = opts.now ?? Date.now();
  if (startedAt === null) startedAt = now;

  const doFetch: Fetcher = opts.fetcher ?? ((url, init) => fetch(url, init));
  const batch = selectForSweep(urls, results, now, opts.limit ?? MAX_CHECKS_PER_SWEEP);

  let checked = 0;
  for (const url of batch) {
    // The same guard the webhook sender uses. An author can paste any URL into a
    // post, so this is a request to an attacker-influenceable address made by
    // the server — exactly the shape url-guard exists for. Without it, a link to
    // http://169.254.169.254/ turns the link checker into a cloud-metadata reader.
    const guard = checkWebhookUrl(url, opts.env);
    if (!guard.ok) {
      results.set(url, {
        url, verdict: 'skipped', checkedAt: now,
        note: `Not checked: ${guard.reason ?? 'the address is not one this server may request'}.`,
      });
      checked += 1;
      continue;
    }

    try {
      const signal = AbortSignal.timeout(CHECK_TIMEOUT_MS);
      let res = await doFetch(url, { method: 'HEAD', redirect: 'follow', signal });
      if (res.status === 405 || res.status === 501) {
        res = await doFetch(url, { method: 'GET', redirect: 'follow', signal });
      }
      const { verdict, note } = verdictFor(res.status);
      results.set(url, { url, verdict, status: res.status, note, checkedAt: now });
    } catch (err) {
      // A timeout or a DNS failure is evidence about the network at this
      // moment, not about the link. Recorded, never called broken.
      results.set(url, {
        url, verdict: 'unknown', checkedAt: now,
        note: `Could not reach it: ${err instanceof Error ? err.message : String(err)}. This may be our network rather than the link.`,
      });
    }
    checked += 1;
  }
  return checked;
}

/**
 * How many of an install's outbound links a sweep still has to look at.
 *
 * Drives the "checked N of M" line. A report that shows three broken links out
 * of eight checked, on a site with four hundred, is telling a very different
 * story from one that has finished — and only this number distinguishes them.
 */
export function pendingCount(urls: readonly string[], now = Date.now()): number {
  let n = 0;
  for (const url of urls) {
    const prev = results.get(url);
    if (!prev || now - prev.checkedAt >= RECHECK_AFTER_MS) n += 1;
  }
  return n;
}
