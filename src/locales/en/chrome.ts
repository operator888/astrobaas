/**
 * en — admin.chrome.*
 *
 * The admin shell: the header bar and the sidebar navigation. These strings sit
 * on EVERY admin screen, so an untranslated one here is not one English label —
 * it is English framing around every translated page inside it.
 */
export const chrome = {
  // Header
  'admin.chrome.openMenu': 'Open navigation menu',
  'admin.chrome.viewSite': 'View Site',
  'admin.chrome.userMenu': 'Account menu',
  'admin.chrome.loading': 'Loading…',
  'admin.chrome.profile': 'Profile',
  'admin.chrome.signOut': 'Sign Out',
  // Shown until /api/auth/me answers, and when the account has no name set.
  'admin.chrome.userFallbackName': 'User',

  // Sidebar navigation
  'admin.chrome.dashboard': 'Dashboard',
  'admin.chrome.posts': 'Posts',
  'admin.chrome.allPosts': 'All Posts',
  'admin.chrome.addNew': 'Add New',
  'admin.chrome.categories': 'Categories',
  'admin.chrome.products': 'Products',
  'admin.chrome.orders': 'Orders',
  'admin.chrome.customers': 'Customers',
  'admin.chrome.media': 'Media',
  'admin.chrome.themes': 'Themes',
  'admin.chrome.users': 'Users',
  'admin.chrome.messages': 'Messages',
  'admin.chrome.plugins': 'Plugins',
  'admin.chrome.apiKeys': 'API Keys',
  'admin.chrome.webhooks': 'Webhooks',
  'admin.chrome.backgroundJobs': 'Background jobs',
  'admin.chrome.emailWording': 'Email wording',
  'admin.chrome.insights': 'Insights',
  'admin.chrome.dataRequests': 'Data requests',
  'admin.chrome.audit': 'Audit Log',
  'admin.chrome.tools': 'Tools',
  'admin.chrome.translations': 'Translations',
  'admin.chrome.importSite': 'Import a site',
  'admin.chrome.contentTypes': 'Content types',
  'admin.chrome.collections': 'Collections',
  'admin.chrome.legalPages': 'Legal pages',
  'admin.chrome.settings': 'Settings',

  // Sidebar group headings. The sidebar is grouped by what a person is
  // trying to DO, so these are verbs-in-noun-form rather than technical
  // categories, and they are the first words a new operator reads.
  'admin.chrome.redirects': 'Redirects',
  'admin.chrome.groupShop': 'Shop',
  'admin.chrome.groupContent': 'Content',
  'admin.chrome.groupSite': 'Site',
  'admin.chrome.groupSystem': 'System',

  // Heading over the links contributed by plugins. The link LABELS themselves
  // come from the plugin manifest and are not translated here.
  'admin.chrome.pluginsSection': 'Plugins',

  // Sidebar account card, replaced by the header script once the user loads.
  'admin.chrome.userNamePlaceholder': 'Admin User',
};

export default chrome;
