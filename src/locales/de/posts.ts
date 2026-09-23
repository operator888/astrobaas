/**
 * de — admin.posts.*
 *
 * One file per screen. 983 keys in a single module is a file nobody can review
 * and every translator conflicts in; split by surface, a screen's strings live
 * next to each other and two people can work at once.
 */
export const posts = {
  'admin.posts.bulk.prompt': '{count} Beiträge ausgewählt. Aktion wählen:',
  'admin.posts.bulk.confirmDelete': '{count} Beiträge löschen? Das kann nicht rückgängig gemacht werden.',
  'admin.posts.bulk.done': 'Fertig — {count} Beiträge aktualisiert.',
  'admin.posts.bulk.partial': '{done} aktualisiert, {failed} fehlgeschlagen',
  'admin.posts.bulk.delete': 'Löschen',
  'admin.posts.bulk.publish': 'Veröffentlichen',
  'admin.posts.bulk.draft': 'Entwurf',
  'admin.posts.bulk.trash': 'In den Papierkorb',
};

export default posts;
