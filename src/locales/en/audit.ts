/**
 * en — admin.audit.*
 *
 * One file per screen. 983 keys in a single module is a file nobody can review
 * and every translator conflicts in; split by surface, a screen's strings live
 * next to each other and two people can work at once.
 *
 * `count_one` / `count_other` are the row counter. The browser script picks the
 * form itself (window.t has no plural support), which is safe for en/el/de —
 * all three have exactly the one/other pair. A language with more forms needs
 * that counter moved server-side, not another suffix added here.
 *
 * The action-filter placeholder is deliberately NOT here: it lists real action
 * prefixes (`auth.`, `payment.`, `user.`) that are matched against stored data,
 * so translating it would suggest filter values that match nothing.
 */
export const audit = {
  'admin.audit.title': 'Audit Log',
  'admin.audit.intro':
    'Who did what. Logins and security events, plus content and commerce edits — posts and products created, changed or deleted, and order status moves. Price, stock and status changes record their before and after; every other field is recorded by NAME only, so this never becomes a second copy of your content.',
  'admin.audit.filterAction': 'Action',
  'admin.audit.filterActor': 'Who',
  'admin.audit.actorPlaceholder': 'any user',
  'admin.audit.filterFrom': 'From',
  'admin.audit.filterTo': 'To',
  'admin.audit.apply': 'Filter',
  'admin.audit.clear': 'Clear',
  'admin.audit.colWhen': 'When',
  'admin.audit.colAction': 'Action',
  'admin.audit.colActor': 'Actor',
  'admin.audit.colTarget': 'Target',
  'admin.audit.colIp': 'IP',
  'admin.audit.loading': 'Loading…',
  'admin.audit.empty': 'No events match those filters.',
  'admin.audit.count_one': '{count} event',
  'admin.audit.count_other': '{count} events',
  'admin.audit.countCapped': '{count} events (capped — narrow the dates)',
};

export default audit;
