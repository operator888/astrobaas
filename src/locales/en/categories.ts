/**
 * en — admin.categories.*
 *
 * One file per screen. 983 keys in a single module is a file nobody can review
 * and every translator conflicts in; split by surface, a screen's strings live
 * next to each other and two people can work at once.
 */
export const categories = {
  'admin.categories.pageTitle': 'Categories',
  'admin.categories.title': 'Categories',
  'admin.categories.addButton': 'Add Category',

  // Form
  'admin.categories.formTitleAdd': 'Add New Category',
  'admin.categories.formTitleEdit': 'Edit Category',
  'admin.categories.nameLabel': 'Name',
  'admin.categories.namePlaceholder': 'Enter category name',
  'admin.categories.slugLabel': 'Slug',
  'admin.categories.slugHint': 'URL-friendly version of the name',
  'admin.categories.descriptionLabel': 'Description',
  'admin.categories.descriptionPlaceholder': 'Optional description',
  'admin.categories.submitAdd': 'Add Category',
  'admin.categories.submitUpdate': 'Update Category',
  'admin.categories.cancel': 'Cancel',

  // List
  'admin.categories.searchPlaceholder': 'Search categories...',
  'admin.categories.count_one': '{count} category',
  'admin.categories.count_other': '{count} categories',
  'admin.categories.colName': 'Name',
  'admin.categories.colSlug': 'Slug',
  'admin.categories.colDescription': 'Description',
  'admin.categories.colPosts': 'Posts',
  'admin.categories.colActions': 'Actions',
  'admin.categories.postCount_one': '{count} post',
  'admin.categories.postCount_other': '{count} posts',
  'admin.categories.edit': 'Edit',
  'admin.categories.delete': 'Delete',

  // Empty state
  'admin.categories.emptyTitle': 'No categories found',
  'admin.categories.emptyBody': 'Get started by creating your first category.',
  'admin.categories.emptyAction': 'Add Category',

  // Messages
  'admin.categories.nameRequired': 'Name is required.',
  'admin.categories.saved': 'Category "{name}" saved.',
  'admin.categories.saveFailed': 'Save failed: {error}',
  'admin.categories.deleteConfirm': 'Are you sure you want to delete "{name}"?',
  'admin.categories.deleted': 'Category "{name}" deleted.',
  'admin.categories.deleteFailed': 'Delete failed: {error}',
};

export default categories;
