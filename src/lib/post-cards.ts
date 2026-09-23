/**
 * Prepare posts for card/listing display — the shape the PostCard and Home
 * theme slots receive.
 *
 * Extracted so the home page and any future listing agree with the blog about
 * what a "prepared" post is. The blog's own inline version predates this
 * helper and matches it field-for-field; unifying that call site is a cleanup
 * for a quiet day, not a requirement.
 */
import type { Post, User, Category } from '../core/models';
import { countWords } from './html-text';
import { pluginManager } from './plugin-system';
import { resolveByline, type BylineContext } from './byline';

/**
 * Whole minutes at 200 wpm, minimum 1. Exported because the article page and
 * the card enricher must AGREE — the contract (PostArticleProps.readTime) is
 * a number, and the article page shipping a "1 min read" STRING is how a
 * theme's byline once rendered "1 min read min" in production.
 */
export function estimateReadTime(html: string): number {
  // countWords, not a local strip: this number appears in the byline while the
  // editor's analysis panel shows its own word count, and two strippers that
  // disagree put contradictory figures on the same post.
  const words = countWords(html);
  return Math.max(1, Math.ceil(words / 200));
}

export interface PrepareCardsCtx {
  users: User[];
  categories: Category[];
  byline: BylineContext;
}

/** Enrich published posts for display: byline, category name, image, date, read time. */
export function prepareCards(posts: Post[], ctx: PrepareCardsCtx) {
  return posts.map((post) => {
    const author = resolveByline(post, ctx.users, ctx.byline).name;
    const category = ctx.categories.find((c) => c.id === post.category_id)?.name || 'Uncategorized';
    const content = pluginManager.applyFilters('post_content', post.content, post) as string;
    const title = pluginManager.applyFilters('post_title', post.title, post) as string;
    return {
      ...post,
      title,
      content,
      author,
      category,
      image: post.featured_image || '/default-cover.svg',
      date: new Date(post.publish_date || post.created_at).toISOString().split('T')[0],
      readTime: estimateReadTime(content),
    };
  });
}
