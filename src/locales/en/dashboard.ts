/**
 * en — admin.dashboard.*
 *
 * One file per screen. 983 keys in a single module is a file nobody can review
 * and every translator conflicts in; split by surface, a screen's strings live
 * next to each other and two people can work at once.
 */
export const dashboard = {
  'admin.dashboard.title': 'Dashboard',

  // Default-password banner. Split around the <code>admin@local</code> chip and
  // the /admin/profile link, both of which are values and stay untranslated —
  // so every language ends its sentence AT the link rather than wrapping it.
  'admin.dashboard.defaultPasswordTitle': 'Heads up:',
  'admin.dashboard.defaultPasswordBefore': 'the default',
  'admin.dashboard.defaultPasswordAfter': 'account still exists. Change the password at',

  'admin.dashboard.welcome': 'Welcome back, {name}!',
  'admin.dashboard.subtitle': "Here's what's happening with your site today.",
  /** Shown in the greeting when the signed-in account has no name set. */
  'admin.dashboard.defaultUserName': 'Admin',

  // Commerce cards
  'admin.dashboard.openOrders': 'Open orders',
  'admin.dashboard.ordersTotal': '{count} in total',
  'admin.dashboard.revenuePaid': 'Revenue (paid)',
  'admin.dashboard.revenuePaidHint': 'paid orders only',
  'admin.dashboard.products': 'Products',
  'admin.dashboard.productsHint': 'in the catalogue',
  'admin.dashboard.outOfStock': 'Out of stock',
  'admin.dashboard.needsRestocking': 'needs restocking',
  'admin.dashboard.allInStock': 'all in stock',

  // Content stats
  'admin.dashboard.totalPosts': 'Total Posts',
  'admin.dashboard.authors_one': '{count} author',
  'admin.dashboard.authors_other': '{count} authors',
  'admin.dashboard.published': 'Published',
  'admin.dashboard.publishedShare': '{percent}% of all posts',
  'admin.dashboard.drafts': 'Drafts',
  'admin.dashboard.mediaFiles_one': '{count} media file',
  'admin.dashboard.mediaFiles_other': '{count} media files',
  'admin.dashboard.totalViews': 'Total Views',
  'admin.dashboard.viewsHint': 'across all published posts',

  // Recent posts
  'admin.dashboard.recentPosts': 'Recent Posts',
  'admin.dashboard.viewAll': 'View all',
  'admin.dashboard.noPosts': 'No posts yet.',
  'admin.dashboard.createFirstPost': 'Create your first post →',
  'admin.dashboard.postViews_one': '{count} view',
  'admin.dashboard.postViews_other': '{count} views',

  // Post status badge. The badge COLOUR and this label are both derived from
  // post.status; nothing matches on the label, so only the label is translated.
  'admin.dashboard.status.published': 'Published',
  'admin.dashboard.status.draft': 'Draft',
  'admin.dashboard.status.scheduled': 'Scheduled',
  'admin.dashboard.status.trashed': 'Trashed',

  // Sidebar
  'admin.dashboard.quickActions': 'Quick Actions',
  'admin.dashboard.newPost': 'New Post',
  'admin.dashboard.uploadMedia': 'Upload Media',
  'admin.dashboard.manageCategories': 'Manage Categories',
  'admin.dashboard.recentActivity': 'Recent Activity',
  'admin.dashboard.noActivity': 'No activity yet.',

  // Activity lines: '<entity> <verb>'. Built as one sentence per verb with the
  // entity as a parameter, because a language that puts the verb first cannot
  // be assembled from two independently translated halves.
  'admin.dashboard.activity.created': '{entity} created',
  'admin.dashboard.activity.updated': '{entity} updated',
  'admin.dashboard.activity.deleted': '{entity} deleted',

  // Entity names, keyed by EntityType (kebab-case types become lowerCamelCase).
  // An entity type a plugin invented has no key here and falls back to its own
  // name, so this list does not have to be exhaustive to stay correct.
  'admin.dashboard.entity.post': 'Post',
  'admin.dashboard.entity.theme': 'Theme',
  'admin.dashboard.entity.setting': 'Setting',
  'admin.dashboard.entity.category': 'Category',
  'admin.dashboard.entity.user': 'User',
  'admin.dashboard.entity.plugin': 'Plugin',
  'admin.dashboard.entity.product': 'Product',
  'admin.dashboard.entity.brand': 'Brand',
  'admin.dashboard.entity.productCategory': 'Product category',
  'admin.dashboard.entity.order': 'Order',
  'admin.dashboard.entity.customer': 'Customer',
  'admin.dashboard.entity.media': 'Media file',

  // Relative timestamps
  'admin.dashboard.time.justNow': 'just now',
  'admin.dashboard.time.minutes_one': '{count} min ago',
  'admin.dashboard.time.minutes_other': '{count} min ago',
  'admin.dashboard.time.hours_one': '{count}h ago',
  'admin.dashboard.time.hours_other': '{count}h ago',
  'admin.dashboard.time.days_one': '{count}d ago',
  'admin.dashboard.time.days_other': '{count}d ago',
};

export default dashboard;
