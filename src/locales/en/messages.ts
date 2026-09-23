/**
 * en — admin.messages.*
 *
 * One file per screen. 983 keys in a single module is a file nobody can review
 * and every translator conflicts in; split by surface, a screen's strings live
 * next to each other and two people can work at once.
 */
export const messages = {
  'admin.messages.title': 'Messages',
  'admin.messages.subtitle': 'Contact form submissions and newsletter subscribers',

  // Stat cards
  'admin.messages.statTotal': 'Total Messages',
  'admin.messages.statUnread': 'Unread',
  'admin.messages.statSubscribers': 'Subscribers',

  // Contact messages list
  'admin.messages.contactHeading': 'Contact Messages',
  'admin.messages.empty': 'No messages yet.',
  'admin.messages.newBadge': 'New',
  'admin.messages.subject': 'Subject: {subject}',
  'admin.messages.markRead': 'Mark read',
  'admin.messages.markUnread': 'Mark unread',
  'admin.messages.delete': 'Delete',

  // Subscribers list
  'admin.messages.subscribersHeading_one': 'Newsletter Subscriber ({count})',
  'admin.messages.subscribersHeading_other': 'Newsletter Subscribers ({count})',
  'admin.messages.subscribersEmpty': 'No subscribers yet.',
  'admin.messages.subscriberRemove': 'Remove',
  'admin.messages.subscriberRemoveConfirm': 'Take {email} off the mailing list? They keep their orders and messages.',
  'admin.messages.subscriberRemoveFailed': 'Could not remove that subscriber.',

  // Browser-side (window.t — no plural support, no interpolation used here)
  'admin.messages.deleteConfirm': 'Delete this message?',
  'admin.messages.deleteFailed': 'Delete failed',
  'admin.messages.updateFailed': 'Update failed',
};

export default messages;
