/**
 * Post revision capture, retention, and restore.
 *
 * A revision is a snapshot of the *previous* content, taken just before an
 * update overwrites it — so the newest revision is always "what the post looked
 * like before the last edit", and restoring one is a normal update (which itself
 * snapshots, making restore undoable).
 *
 * Retention is mandatory, not optional: every post accumulates a revision on
 * every save, and autosave writes far more. Without pruning, a busy editor grows
 * the store without bound. `REVISION_KEEP` caps how many are retained per post.
 */
import { LocalDB } from './localdb';
import type { Post, PostRevision } from '../core/models';

/** How many revisions to retain per post. Override with REVISIONS_KEEP. */
export function revisionKeep(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.REVISIONS_KEEP);
  if (Number.isFinite(raw) && raw >= 1) return Math.min(Math.floor(raw), 500);
  return 20;
}

/** Revisions are disabled entirely with REVISIONS_DISABLED=1. */
export function revisionsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.REVISIONS_DISABLED !== '1';
}

/**
 * True when two snapshots carry the same editable content. Used to skip writing
 * a revision when nothing actually changed — otherwise autosave would fill the
 * retention window with identical copies and push real history out of it.
 */
export function sameContent(
  a: Pick<PostRevision, 'title' | 'content' | 'excerpt'>,
  b: Pick<PostRevision, 'title' | 'content' | 'excerpt'>,
): boolean {
  return (
    a.title === b.title &&
    a.content === b.content &&
    (a.excerpt ?? '') === (b.excerpt ?? '')
  );
}

/**
 * Snapshot a post's CURRENT content, then prune. Returns the revision, or null
 * when nothing was written (disabled, or identical to the newest revision).
 *
 * Failures are swallowed and logged: losing a revision must never fail the edit
 * the user actually asked for.
 */
export async function captureRevision(
  post: Post,
  authorId: string,
  kind: PostRevision['kind'],
): Promise<PostRevision | null> {
  if (!revisionsEnabled()) return null;
  try {
    const snapshot = {
      title: post.title ?? '',
      content: post.content ?? '',
      excerpt: post.excerpt,
    };

    // Skip no-op snapshots (repeated autosaves with no edits in between).
    const [newest] = await LocalDB.getPostRevisions(post.id, 1);
    if (newest && sameContent(newest, snapshot)) return null;

    const rev = await LocalDB.createPostRevision({
      post_id: post.id,
      title: snapshot.title,
      content: snapshot.content,
      excerpt: snapshot.excerpt,
      author_id: authorId,
      kind,
    });
    // Retention: keep the newest N for this post.
    await LocalDB.prunePostRevisions(post.id, revisionKeep());
    return rev;
  } catch (err) {
    console.error('Revision capture failed (edit still applied):', err instanceof Error ? err.message : err);
    return null;
  }
}
