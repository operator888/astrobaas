/**
 * Related posts — "you might also like", without following anyone around.
 *
 * ## The rule that shapes everything else
 *
 * **Relatedness comes from the content, never from the reader.** No cookie, no
 * visitor id, no "people who read this also read". That is not a limitation
 * being worked around: a recommendation built from behaviour needs a profile of
 * the person reading, which turns a blog sidebar into a processing activity
 * with a lawful basis, a retention period and a place in the erasure tooling.
 * Category and tag overlap answer the same question well enough that paying
 * that price for a sidebar would be absurd.
 *
 * ## Topical overlap is required, recency only breaks ties
 *
 * A post with NOTHING in common scores zero and is excluded, however new it is.
 * This matters more than it sounds: the tempting implementation blends topic
 * and recency into one number, and then a shop that publishes daily fills its
 * "related" strip with yesterday's unrelated posts. A block labelled *related*
 * that shows unrelated things is worse than an empty one, because the reader
 * cannot tell it has failed.
 *
 * So a blog with no categories and no tags gets NO related posts, deliberately.
 * If a caller wants to fill that space it should render "Latest" under its own
 * heading — an honest label for what it actually is — rather than having this
 * function quietly lower its standards.
 *
 * ## Two exclusions that are easy to miss
 *
 * 1. **Other translations of the same article.** A set linked by
 *    `translation_of` is ONE article in several languages. Offering the German
 *    version as "related" to the Greek one you are reading is not a
 *    recommendation, it is the same page again. The set is resolved through its
 *    root, so a chain (de → el → en) collapses correctly — the same shape
 *    `lib/i18n/status.ts` needed.
 * 2. **Other locales.** A Greek reader offered a German article cannot read it.
 *    Related posts are same-locale only.
 */
import type { Post } from '../core/models';
import { isArticle } from './post-kind';
import { recordLocale } from './i18n';

/** How much each signal is worth. Exported so a test pins the intent, not a magic number. */
export const RELATED_WEIGHTS = {
  /** Same category. One editorial decision, so worth roughly one and a half tags. */
  category: 3,
  /** Per shared tag. */
  tag: 2,
  /**
   * Most tags that can count. Without a cap, a post tagged with twenty terms
   * out-ranks everything by breadth rather than by being related to anything —
   * and tagging everything with everything is exactly what happens to a blog
   * over a few years.
   */
  maxTags: 3,
  /**
   * Ceiling on the recency bonus. Deliberately below one tag: recency must
   * order posts that are ALREADY related, never promote one that is not.
   */
  recency: 1,
} as const;

/** Newer than this contributes nothing extra; it is a tiebreaker, not a signal. */
const RECENCY_WINDOW_DAYS = 365;

function dateOf(p: Pick<Post, 'publish_date' | 'created_at'>): number {
  const raw = p.publish_date || p.created_at;
  const t = raw ? Date.parse(raw) : NaN;
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Resolve a post to the root of its translation set.
 *
 * Follows `translation_of` through chains, guarding against a cycle: the field
 * is operator-supplied and nothing in storage prevents two posts pointing at
 * each other. An unresolvable link (pointing at a post that is not in the list)
 * leaves the post as its own root, which is the honest answer — we cannot know
 * what set it belongs to from here.
 */
function rootOf(p: Post, byId: Map<string, Post>): string {
  const seen = new Set<string>();
  let cur = p;
  while (cur.translation_of && byId.has(cur.translation_of) && !seen.has(cur.id)) {
    seen.add(cur.id);
    cur = byId.get(cur.translation_of)!;
  }
  // A MUTUAL pair (a→b, b→a) stops the walk at different posts depending on
  // where it started, so the two ended up with different roots and each was
  // offered as "related" to the other — the same article twice, which is the
  // one thing this function exists to prevent. When the walk terminated on a
  // cycle rather than at a genuine root, the SMALLEST id in the ring is the
  // root: every member of the ring then agrees on it.
  if (cur.translation_of && byId.has(cur.translation_of)) {
    let smallest = cur.id;
    for (const id of seen) if (id < smallest) smallest = id;
    return smallest;
  }
  return cur.id;
}

export interface RelatedOptions {
  /** How many to return. */
  limit?: number;
  /** Treated as "now" for the recency tiebreak. Injected so tests have no clock. */
  now?: number;
  /** Passed to `recordLocale`. Injected so this module stays testable without env. */
  env?: NodeJS.ProcessEnv;
}

export interface RelatedPost {
  post: Post;
  score: number;
}

/**
 * Posts related to `target`, best first.
 *
 * Pure: same inputs, same output, no clock and no database. `now` is injected
 * rather than read, because a function whose result changes between two calls
 * cannot be tested and cannot be cached.
 */
export function relatedPosts(
  target: Post,
  all: readonly Post[],
  opts: RelatedOptions = {},
): RelatedPost[] {
  const limit = Math.max(0, opts.limit ?? 3);
  if (limit === 0) return [];

  const now = opts.now ?? Date.now();
  // recordLocale, not `post.locale || ''`. A record written before i18n existed
  // has NO locale and belongs to the default one — comparing the raw field would
  // treat it as different from a post explicitly tagged with that same default,
  // so a site part-way through adopting i18n would silently stop relating its
  // own older posts to its newer ones.
  const targetLocale = recordLocale(target, opts.env);
  const targetTags = new Set((target.tags ?? []).filter((t) => typeof t === 'string' && t !== ''));

  // The set is resolved over the WHOLE list, not just the candidates, so a
  // chain that passes through a draft still collapses to the right root.
  const byId = new Map(all.map((p) => [p.id, p]));
  const targetRoot = rootOf(target, byId);

  const scored: RelatedPost[] = [];
  for (const p of all) {
    if (p.id === target.id) continue;
    if (p.status !== 'published') continue;
    // Pages are not "related articles" — a reader finishing a blog post is not
    // looking for the shipping policy. isArticle rather than a local check, so
    // this cannot drift from the rest of the codebase's idea of what a post is.
    if (!isArticle(p)) continue;
    // A post the operator told search engines to ignore should not be promoted
    // on the site either: noindex means "this is not for finding".
    if (p.noindex) continue;
    if (recordLocale(p, opts.env) !== targetLocale) continue;
    // The same article in another language is not a recommendation.
    if (rootOf(p, byId) === targetRoot) continue;

    let score = 0;
    if (target.category_id && p.category_id === target.category_id) {
      score += RELATED_WEIGHTS.category;
    }
    if (targetTags.size > 0) {
      let shared = 0;
      for (const t of p.tags ?? []) {
        if (targetTags.has(t)) shared += 1;
      }
      score += Math.min(shared, RELATED_WEIGHTS.maxTags) * RELATED_WEIGHTS.tag;
    }

    // Topical overlap is the entry ticket. Recency is applied only after it.
    if (score === 0) continue;

    const ageDays = Math.max(0, (now - dateOf(p)) / 86_400_000);
    const freshness = Math.max(0, 1 - ageDays / RECENCY_WINDOW_DAYS);
    score += freshness * RELATED_WEIGHTS.recency;

    scored.push({ post: p, score });
  }

  // Score, then date, then id: a stable total order. Without the final id the
  // result could differ between two storage drivers that return equal-scoring
  // rows in different orders — the kind of difference that shows up as a
  // flaking test long before anyone notices it on the site.
  scored.sort((a, b) =>
    (b.score - a.score)
    || (dateOf(b.post) - dateOf(a.post))
    || a.post.id.localeCompare(b.post.id));

  return scored.slice(0, limit);
}
