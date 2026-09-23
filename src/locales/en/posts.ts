/**
 * en — admin.posts.*
 *
 * One file per screen. 983 keys in a single module is a file nobody can review
 * and every translator conflicts in; split by surface, a screen's strings live
 * next to each other and two people can work at once.
 */
export const posts = {
  'admin.posts.bulk.prompt': 'Selected {count} posts. Choose action:',
  'admin.posts.bulk.confirmDelete': 'Delete {count} posts? This cannot be undone.',
  'admin.posts.bulk.done': 'Done — {count} posts updated.',
  'admin.posts.bulk.partial': '{done} updated, {failed} failed',
  'admin.posts.bulk.delete': 'Delete',
  'admin.posts.bulk.publish': 'Publish',
  'admin.posts.bulk.draft': 'Draft',
  'admin.posts.bulk.trash': 'Move to Trash',
};

export default posts;
