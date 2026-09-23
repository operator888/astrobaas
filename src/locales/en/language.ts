/**
 * en — admin.language.*
 *
 * One file per screen. 983 keys in a single module is a file nobody can review
 * and every translator conflicts in; split by surface, a screen's strings live
 * next to each other and two people can work at once.
 */
export const language = {
  'admin.language.label': 'Admin language',
  'admin.language.help': 'The language of the admin interface. It does not change what language your content is in.',
  'admin.language.followSite': 'Follow the site default',
  'admin.language.incomplete': '{missing} of {total} messages are not translated yet and will show in English.',
};

export default language;
