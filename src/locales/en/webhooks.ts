/**
 * en — admin.webhooks.*
 *
 * One file per screen. 983 keys in a single module is a file nobody can review
 * and every translator conflicts in; split by surface, a screen's strings live
 * next to each other and two people can work at once.
 */
export const webhooks = {
  'admin.webhooks.title': 'Webhooks',
  'admin.webhooks.intro': 'Get a signed POST when content changes. The signing secret is shown once at registration.',

  // Secret disclosure
  'admin.webhooks.secretWarning': 'Copy the signing secret now — it will not be shown again.',
  'admin.webhooks.copy': 'Copy',

  // Registration form
  'admin.webhooks.urlLabel': 'Endpoint URL',
  'admin.webhooks.eventsLabel': 'Events',
  // {all} and {prefix} are code samples supplied by the page, not translated.
  'admin.webhooks.eventsHint': 'Comma-separated. Use {all} for all, or a {prefix} wildcard.',
  'admin.webhooks.register': 'Register webhook',

  // Webhook table
  'admin.webhooks.colUrl': 'URL',
  'admin.webhooks.colEvents': 'Events',
  'admin.webhooks.colActive': 'Active',
  'admin.webhooks.colActions': 'Actions',
  'admin.webhooks.loading': 'Loading…',
  'admin.webhooks.empty': 'No webhooks yet.',
  'admin.webhooks.yes': 'Yes',
  'admin.webhooks.no': 'No',
  'admin.webhooks.viewDeliveries': 'Deliveries',
  'admin.webhooks.delete': 'Delete',
  'admin.webhooks.deleteConfirm': 'Delete the webhook for {url}?',

  // Deliveries table
  'admin.webhooks.deliveriesTitle': 'Recent deliveries',
  'admin.webhooks.deliveriesTitleFiltered': 'Deliveries for selected webhook',
  'admin.webhooks.colEvent': 'Event',
  'admin.webhooks.colStatus': 'Status',
  'admin.webhooks.colAttempts': 'Attempts',
  'admin.webhooks.colLastCode': 'Last code',
  'admin.webhooks.colWhen': 'When',
  'admin.webhooks.deliveriesEmpty': 'No deliveries yet.',
  'admin.webhooks.redeliver': 'Redeliver',

  // Delivery status LABELS. The stored values stay 'success' / 'failed' /
  // 'pending' — deliveryRow() still branches on the raw value for its colour.
  'admin.webhooks.statusSuccess': 'Success',
  'admin.webhooks.statusFailed': 'Failed',
  'admin.webhooks.statusPending': 'Pending',
};

export default webhooks;
