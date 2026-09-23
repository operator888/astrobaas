/**
 * Performing an import plan against this install.
 *
 * The old importer wrote `db.json` directly. That made it a lowdb-only tool
 * that silently did nothing useful on the two drivers a real deployment uses,
 * and it bypassed every guarantee the write path provides — slug uniqueness
 * inside the write, content sanitization, the change feed. Everything here
 * goes through `LocalDB` instead, so an import behaves identically on all
 * three drivers and cannot produce a record the API could not have produced.
 *
 * Three properties this is built around:
 *
 *  - **Idempotent.** Re-running an import must not duplicate a site. Every
 *    imported record is stamped with the WordPress id it came from, and an
 *    item whose stamp is already present is reported as skipped rather than
 *    written again. Imports get interrupted — a network blip halfway through
 *    a 400-image media fetch is normal — and "run it again" has to be safe.
 *  - **Reports everything.** Nothing is dropped silently. Every item is
 *    created, skipped-with-a-reason, or failed-with-a-reason.
 *  - **Fetches carefully.** The media URLs come out of a file the operator was
 *    handed; they are attacker-controlled input in every sense that matters.
 *    They are checked against the same private-host guard webhooks use, capped
 *    in size and count, and fetched one at a time.
 */
import { LocalDB } from '../localdb';
import { sanitizeHtml } from '../sanitize';
import { ingestMedia, MAX_MEDIA_SIZE } from '../media/ingest';
import { isPrivateHostname } from '../url-guard';
import { reloadRedirects } from '../legacy/redirect-store';
import { slugifyImported, type ImportPlan, type PlannedPost } from './plan';
import type { Category, Post } from '../../core/models';
import type { RedirectRule } from '../legacy/redirects';

/**
 * Where the WordPress id is recorded on an imported record.
 *
 * On the post it rides in `meta_title`? No — that is content. It goes in the
 * record's own `wp_id` field, which the storage layer keeps because both
 * drivers store records as JSON documents. Nothing in the app reads it except
 * this importer, and that is exactly what it is for: making a second run
 * recognise its own work.
 */
export const WP_ID_FIELD = 'wp_id' as const;

export interface ApplyOptions {
  /**
   * Report what WOULD happen and write nothing. The default, deliberately:
   * an import is not undoable, so performing one has to be asked for.
   */
  dryRun?: boolean;
  /** Fetch media files from the old site. */
  fetchMedia?: boolean;
  /** Hard cap on media files, so one export cannot fill a disk. */
  maxMedia?: number;
  /** Hard cap per file. */
  maxMediaBytes?: number;
  /** Allow private/loopback media hosts. Off unless a test says otherwise. */
  allowPrivateMediaHosts?: boolean;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Called after each item so a CLI can show progress. */
  onProgress?: (done: number, total: number, label: string) => void;
}

export interface ApplyResult {
  dryRun: boolean;
  createdPosts: number;
  createdPages: number;
  createdCategories: number;
  createdRedirects: number;
  importedMedia: number;
  /** Items not written, each with a reason a human can act on. */
  skipped: { title: string; reason: string }[];
  /** Items that were meant to be written and could not be. */
  failed: { title: string; reason: string }[];
}

const DEFAULT_MAX_MEDIA = 2000;
// The same ceiling the media library itself enforces. Fetching more than that
// would mean pulling megabytes over the network only for `ingestMedia` to
// refuse them — a slow way to reach the same answer, on somebody else's
// bandwidth.
const DEFAULT_MAX_MEDIA_BYTES = MAX_MEDIA_SIZE;

/**
 * Is this URL safe to fetch on the server's behalf?
 *
 * The list comes from a file somebody was emailed. Without this check the
 * importer is a request forwarder into the private network — the same reason
 * webhook targets are guarded, and the same guard.
 */
export function mediaUrlProblem(raw: string, allowPrivate = false): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'not a valid URL';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return `refused scheme "${u.protocol}"`;
  if (!allowPrivate && isPrivateHostname(u.hostname)) {
    return 'points at a private or loopback address';
  }
  return null;
}

/** Categories, created once and reused, keyed by slug. */
async function ensureCategories(
  plan: ImportPlan,
  dryRun: boolean,
): Promise<{ index: Map<string, string>; created: number }> {
  const existing = (await LocalDB.getCategories()) as Category[];
  const index = new Map<string, string>();
  for (const c of existing) index.set(c.slug, c.id);

  // Slug → the display name the export gave it. Un-slugifying instead would
  // rename "Frames & Lenses" to "Frames" on every post that used it.
  const wanted = new Map<string, string>();
  for (const p of plan.posts) {
    if (!p.categorySlug) continue;
    const existingName = wanted.get(p.categorySlug);
    if (!existingName) wanted.set(p.categorySlug, p.categoryName ?? '');
  }

  let created = 0;
  for (const [slug, name] of wanted) {
    if (index.has(slug)) continue;
    created += 1;
    if (dryRun) {
      index.set(slug, `dry-run:${slug}`);
      continue;
    }
    const cat = await LocalDB.createCategory({
      // Fall back to the slug only when the export carried no name at all.
      name: name || slug.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase()),
      slug,
      description: '',
    } as Omit<Category, 'id' | 'created_at' | 'updated_at'>);
    index.set(slug, cat.id);
  }
  return { index, created };
}

/**
 * Perform (or rehearse) a plan.
 *
 * `authorId` is the account every imported record is filed under. Imported
 * content is NOT attributed to a WordPress author automatically: creating user
 * accounts from an untrusted file, with the emails it names, would be an
 * invitation to impersonate. The author logins are reported in the plan so an
 * operator can invite the real people and reassign afterwards.
 */
export async function applyImport(
  plan: ImportPlan,
  authorId: string,
  opts: ApplyOptions = {},
): Promise<ApplyResult> {
  /*
   * Imports are serialized WITHIN THIS PROCESS. The idempotency check below is
   * a read-then-write snapshot, and two overlapping imports of the same export
   * — an admin's second click while the first minutes-long request is still in
   * flight, an HTTP retry — would each read "nothing imported yet" and each
   * create every post, with the slug layer politely renaming the duplicates to
   * `-2` so nothing even errors. A promise chain is enough for the HTTP
   * endpoint and the admin screen, which share this process. A CLI run against
   * the same database while the server imports is NOT covered — that is two
   * processes — and the storage layer has no cross-process transaction to lean
   * on; the CLI's own docs say to run it against a quiet site.
   */
  const run = importQueue.then(() => performImport(plan, authorId, opts));
  importQueue = run.then(() => undefined, () => undefined);
  return run;
}

let importQueue: Promise<void> = Promise.resolve();

async function performImport(
  plan: ImportPlan,
  authorId: string,
  opts: ApplyOptions = {},
): Promise<ApplyResult> {
  const dryRun = opts.dryRun !== false;
  const maxMedia = opts.maxMedia ?? DEFAULT_MAX_MEDIA;
  const maxBytes = opts.maxMediaBytes ?? DEFAULT_MAX_MEDIA_BYTES;
  const doFetch = opts.fetchImpl ?? fetch;

  const result: ApplyResult = {
    dryRun,
    createdPosts: 0,
    createdPages: 0,
    createdCategories: 0,
    createdRedirects: 0,
    importedMedia: 0,
    skipped: plan.skipped.map((s) => ({ title: s.title, reason: s.reason })),
    failed: [],
  };

  await LocalDB.init();

  // Already here? Then this is a re-run, and those items are its own work.
  const existingPosts = (await LocalDB.getPosts()) as (Post & { wp_id?: string })[];
  const alreadyImported = new Set(
    existingPosts.map((p) => p[WP_ID_FIELD]).filter((v): v is string => typeof v === 'string' && v !== ''),
  );

  const { index: categoryIds, created: createdCategories } = await ensureCategories(plan, dryRun);
  result.createdCategories = createdCategories;

  // Planned path → the path the content actually lives at. The plan resolves
  // collisions only WITHIN itself; the storage layer resolves them against
  // what is already in the database — by quietly renaming to `-2`. A redirect
  // written to the PLANNED path would then 301 every old link to whatever
  // unrelated record already held that slug. Filled in as posts are created
  // (and, on a re-run, from the records an earlier run created), consulted
  // when the redirects are written.
  const actualPath = new Map<string, string>();
  const pathFor = (kind: 'post' | 'page', slug: string) =>
    kind === 'page' ? `/${slug}` : `/blog/${slug}`;

  const total = plan.posts.length + (opts.fetchMedia ? plan.media.length : 0);
  let done = 0;

  for (const item of plan.posts) {
    done += 1;
    opts.onProgress?.(done, total, item.title);

    if (item.wpId && alreadyImported.has(item.wpId)) {
      result.skipped.push({ title: item.title, reason: 'already imported by an earlier run' });
      // The earlier run may itself have been renamed on collision, so the
      // redirect must follow the slug that run actually got, not the plan's.
      const earlier = existingPosts.find((p) => p[WP_ID_FIELD] === item.wpId);
      if (earlier?.slug && earlier.slug !== item.slug) {
        actualPath.set(pathFor(item.kind, item.slug), pathFor(item.kind, earlier.slug));
      }
      continue;
    }

    if (dryRun) {
      if (item.kind === 'page') result.createdPages += 1;
      else result.createdPosts += 1;
      continue;
    }

    try {
      const created = await createOne(item, authorId, categoryIds);
      if (item.kind === 'page') result.createdPages += 1;
      else result.createdPosts += 1;
      if (item.wpId) alreadyImported.add(item.wpId);
      if (created?.slug && created.slug !== item.slug) {
        actualPath.set(pathFor(item.kind, item.slug), pathFor(item.kind, created.slug));
      }
    } catch (err) {
      result.failed.push({ title: item.title, reason: (err as Error).message });
    }
  }

  if (opts.fetchMedia) {
    // The same re-run recognition posts get. Without it, the exact scenario
    // the module header names — a network blip halfway through a 400-image
    // fetch, then "run it again" — re-downloaded all 400 and doubled the
    // media library, because ingestMedia always creates a fresh record.
    const mediaStamps = new Set(
      ((await LocalDB.getMedia()) as ({ wp_id?: unknown })[])
        .map((m) => m[WP_ID_FIELD])
        .filter((v): v is string => typeof v === 'string' && v !== ''),
    );
    // ATTEMPTS, not successes. Counting only what worked would leave the cap
    // bounding the wrong thing: an export listing ten thousand dead URLs would
    // make ten thousand outbound requests, each with its own timeout, and the
    // cap that was supposed to bound the work would never be reached at all.
    let attempted = 0;
    for (const file of plan.media) {
      done += 1;
      opts.onProgress?.(done, total, file.url);
      if (file.wpId && mediaStamps.has(file.wpId)) {
        result.skipped.push({ title: file.url, reason: 'already imported by an earlier run' });
        continue;
      }
      if (attempted >= maxMedia) {
        result.skipped.push({ title: file.url, reason: `media cap of ${maxMedia} files reached` });
        continue;
      }
      const problem = mediaUrlProblem(file.url, opts.allowPrivateMediaHosts === true);
      if (problem) {
        // Refused without a request, so it does not spend the budget.
        result.skipped.push({ title: file.url, reason: `media URL ${problem}` });
        continue;
      }
      attempted += 1;
      if (dryRun) {
        result.importedMedia += 1;
        continue;
      }
      try {
        await fetchOne(file.url, doFetch, maxBytes, authorId, opts.allowPrivateMediaHosts === true, file.wpId);
        result.importedMedia += 1;
        if (file.wpId) mediaStamps.add(file.wpId);
      } catch (err) {
        result.failed.push({ title: file.url, reason: (err as Error).message });
      }
    }
  }

  // Redirects last: they describe where content ENDED UP, so writing them
  // before the content exists would advertise destinations that 404.
  const existingRedirects = (await LocalDB.getRedirects()) as RedirectRule[];
  const haveMatch = new Set(existingRedirects.map((r) => r.match));
  for (const r of plan.redirects) {
    if (haveMatch.has(r.from)) {
      result.skipped.push({ title: r.from, reason: 'a redirect for that path already exists' });
      continue;
    }
    // Where the content ACTUALLY ended up, when a collision renamed it.
    const target = actualPath.get(r.to) ?? r.to;
    result.createdRedirects += 1;
    if (dryRun) continue;
    try {
      const now = new Date().toISOString();
      await LocalDB.saveRedirect({
        id: cryptoId(),
        match: r.from,
        target,
        status: 301,
        enabled: true,
        notes: 'Created by the WordPress import',
        hits: 0,
        created_at: now,
        updated_at: now,
      } as RedirectRule);
      haveMatch.add(r.from);
    } catch (err) {
      result.createdRedirects -= 1;
      result.failed.push({ title: r.from, reason: (err as Error).message });
    }
  }

  // The redirect map is held in memory and rebuilt only when something says
  // so. Without this, every rule an import just created would sit in the
  // database doing nothing until the next restart — the operator would test
  // one of their old URLs, get a 404, and conclude the import had failed.
  //
  // Once, after the loop, rather than per rule: rebuilding is a full reload of
  // the map, and an import that creates four hundred redirects would otherwise
  // rebuild it four hundred times.
  if (!dryRun && result.createdRedirects > 0) {
    await reloadRedirects().catch(() => {
      // A stale in-memory map is a wrong 404 on an old URL, not a broken
      // import: the rules ARE written, and the next reload picks them up.
    });
  }

  return result;
}

function cryptoId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `imp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function createOne(
  item: PlannedPost,
  authorId: string,
  categoryIds: Map<string, string>,
): Promise<{ slug?: string } | null> {
  // Sanitized on the way in, exactly like every other write. WordPress content
  // is not trusted input just because it is the operator's own: a decade-old
  // blog is full of embeds, inline handlers and shortcodes from plugins that
  // no longer exist.
  const content = sanitizeHtml(item.content ?? '');
  // The RETURN VALUE matters: the storage layer resolves slug collisions by
  // renaming, and the caller points this item's redirect at the slug the
  // record really got.
  return LocalDB.createPost({
    title: item.title.slice(0, 200),
    slug: item.slug,
    content,
    ...(item.excerpt ? { excerpt: item.excerpt.slice(0, 600) } : {}),
    status: item.status,
    ...(item.kind === 'page' ? { kind: 'page' as const } : {}),
    author_id: authorId,
    ...(item.categorySlug && categoryIds.get(item.categorySlug)
      ? { category_id: categoryIds.get(item.categorySlug) }
      : {}),
    tags: item.tags.slice(0, 20),
    ...(item.publishedAt ? { publish_date: item.publishedAt } : {}),
    views: 0,
    // The stamp that makes a second run idempotent.
    [WP_ID_FIELD]: item.wpId,
  } as unknown as Omit<Post, 'id' | 'created_at' | 'updated_at'>);
}

/**
 * How long one file gets before the import gives up on it.
 *
 * An import walks hundreds of URLs pointing at a site that is, by definition,
 * being decommissioned. Without a deadline one unresponsive host stalls the
 * whole run — and the operator, who is watching a progress line, has no way to
 * tell a slow import from a hung one.
 */
const FETCH_TIMEOUT_MS = 20_000;

/** Redirect hops allowed. Old sites move; open redirect chains do not. */
const MAX_REDIRECTS = 5;

/**
 * Fetch one file and hand it to the media pipeline.
 *
 * Three things this has to do that a plain `fetch` does not:
 *
 *  - **Check every hop, not just the first.** `redirect: 'follow'` would check
 *    the URL from the export and then quietly follow it to wherever the old
 *    site points — including 169.254.169.254 and 127.0.0.1. The list came out
 *    of a file somebody was emailed; the guard has to apply to the address
 *    actually connected to, so redirects are followed HERE, one at a time,
 *    with the same check on each.
 *  - **Stop reading at the cap.** `Content-Length` is a claim, not a promise.
 *    Buffering the whole body and measuring it afterwards is not a limit at
 *    all: a hostile or broken server answering a thumbnail request with an
 *    endless body would be held in memory in full before anyone objected. The
 *    body is read chunk by chunk and abandoned the moment it goes over.
 *  - **Give up.** See FETCH_TIMEOUT_MS.
 */
async function fetchOne(
  url: string,
  doFetch: typeof fetch,
  maxBytes: number,
  uploadedBy: string,
  allowPrivate: boolean,
  wpId?: string,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    let current = url;
    let res: Response | undefined;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      // Checked on EVERY hop, including the first: this is the address about
      // to be connected to, not the one the export claimed.
      const problem = mediaUrlProblem(current, allowPrivate);
      if (problem) throw new Error(`redirected to a URL that ${problem}`);

      res = await doFetch(current, { redirect: 'manual', signal: controller.signal });
      if (res.status < 300 || res.status >= 400) break;

      const location = res.headers.get('location');
      if (!location) throw new Error(`the old site answered ${res.status} with no destination`);
      // Relative Locations are legal and common.
      current = new URL(location, current).toString();
      res = undefined;
    }

    if (!res) throw new Error(`too many redirects (more than ${MAX_REDIRECTS})`);
    if (!res.ok) throw new Error(`the old site answered ${res.status}`);

    const tooBig = `file is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`;
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (Number.isFinite(declared) && declared > maxBytes) throw new Error(tooBig);

    const buf = await readCapped(res, maxBytes, tooBig);
    if (buf.byteLength === 0) throw new Error('the old site returned an empty file');

    // The importer does not decide what a safe file is — `ingestMedia` does,
    // and it is the only place that knows (magic-byte sniffing, SVG
    // sanitization, EXIF stripping, derivative generation, the
    // content-addressed write). Duplicating any of it here would be a second,
    // weaker gate on one door.
    // The response's Content-Type is passed for the same reason a browser's
    // `file.type` is: it is the ONLY hint that distinguishes a .txt from a .md,
    // both of which sniff as nothing. It is consulted for plain-text types and
    // nothing else — an image is whatever its magic bytes say it is, whatever
    // the old server claims — so a lying header buys an attacker the ability
    // to store text as text.
    const declaredType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    const stored = await ingestMedia(buf, {
      originalName: fileNameFrom(current),
      ...(declaredType ? { declaredType } : {}),
      uploadedBy,
    });
    if (!stored.ok) throw new Error(stored.error);
    // The stamp that lets a second run skip this file instead of downloading
    // it again and creating a twin record. Written after the ingest rather
    // than through it, so the media pipeline itself stays import-agnostic.
    if (wpId) {
      await LocalDB.updateMediaFile(stored.media.id, { [WP_ID_FIELD]: wpId } as Record<string, unknown>);
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The file name to record, from the URL actually fetched.
 *
 * `decodeURIComponent` throws on a malformed escape — `%ZZ`, or a stray `%` at
 * the end — which is exactly the kind of thing a decade-old media library is
 * full of. Left unguarded that surfaces as "URI malformed" against a file the
 * operator cannot identify, so the raw segment is used instead and the file is
 * still imported.
 */
function fileNameFrom(url: string): string {
  const segment = new URL(url).pathname.split('/').pop() || 'imported';
  try {
    return decodeURIComponent(segment) || 'imported';
  } catch {
    return segment;
  }
}

/**
 * Read a response body, stopping at `maxBytes` instead of after.
 *
 * Falls back to `arrayBuffer()` only when the response has no readable stream —
 * which in practice means a test double, not a network response.
 */
async function readCapped(res: Response, maxBytes: number, tooBig: string): Promise<Buffer> {
  const body = res.body;
  if (!body || typeof body.getReader !== 'function') {
    const whole = Buffer.from(await res.arrayBuffer());
    if (whole.byteLength > maxBytes) throw new Error(tooBig);
    return whole;
  }

  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.byteLength;
      if (total > maxBytes) throw new Error(tooBig);
      chunks.push(chunk);
    }
  } finally {
    // Tell the far end to stop sending rather than draining what it offers.
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}

export { slugifyImported };
