/**
 * en — admin.media.*
 *
 * One file per screen. 983 keys in a single module is a file nobody can review
 * and every translator conflicts in; split by surface, a screen's strings live
 * next to each other and two people can work at once.
 */
export const media = {
  // Page chrome
  'admin.media.title': 'Media Library',
  'admin.media.subtitle': 'Manage your images, videos, and other media files',

  // Upload area
  'admin.media.uploadHeading': 'Upload Media',
  'admin.media.uploadHint': 'Drag and drop files here, or click to browse',
  'admin.media.uploadFormats': 'Images: JPG, PNG, GIF, WebP (max {image} MB) · Video: MP4, WebM (max {video} MB)',
  'admin.media.uploading': 'Uploading…',
  'admin.media.uploadDone': 'Done',
  'admin.media.uploadFailed': 'Upload failed: {error}',

  // Toolbar
  'admin.media.searchPlaceholder': 'Search media…',
  'admin.media.gridView': 'Grid view',
  'admin.media.listView': 'List view',

  // Grid / list state
  'admin.media.loading': 'Loading…',
  'admin.media.empty': 'No media yet. Upload something above.',

  // List columns
  'admin.media.colFile': 'File',
  'admin.media.colType': 'Type',
  'admin.media.colSize': 'Size',
  'admin.media.colDate': 'Date',
  'admin.media.colActions': 'Actions',

  // Row actions. These are LABELS only — the click handler dispatches on
  // data-action="select" / data-action="delete", never on the text or title.
  'admin.media.insert': 'Insert into post',
  'admin.media.select': 'Select',
  'admin.media.addAlt': 'Describe',
  'admin.media.altPrompt': 'Describe this picture for someone who cannot see it. Leave empty if it is decorative.',
  'admin.media.altFailed': 'Could not save the description',
  'admin.media.replace': 'Replace',
  'admin.media.replaceConfirm': 'Replace this file? Pages and products that use it will be updated to the new one, and the old file is removed.',
  'admin.media.replaceFailed': 'Could not replace the file: {error}',
  'admin.media.replaced': 'Replaced. {posts} page(s) and {products} product(s) were updated.',
  'admin.media.delete': 'Delete',
  'admin.media.deleteConfirm': 'Are you sure you want to delete this media file?',
  'admin.media.deleteFailed': 'Delete failed: {error}',

  // File sizes. Only the spelled-out unit is translatable; KB/MB/GB are
  // international symbols and stay as they are in every locale.
  'admin.media.unitBytes': 'Bytes',
  'admin.media.loadMore': 'Load more',
  'admin.media.rateLimited': 'Rate limited — retrying in {seconds}s…',
};

export default media;
