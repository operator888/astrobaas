/**
 * el — admin.posts.*
 *
 * One file per screen. 983 keys in a single module is a file nobody can review
 * and every translator conflicts in; split by surface, a screen's strings live
 * next to each other and two people can work at once.
 */
export const posts = {
  'admin.posts.bulk.prompt': 'Επιλέχθηκαν {count} άρθρα. Επιλέξτε ενέργεια:',
  'admin.posts.bulk.confirmDelete': 'Διαγραφή {count} άρθρων; Δεν αναιρείται.',
  'admin.posts.bulk.done': 'Έγινε — ενημερώθηκαν {count} άρθρα.',
  'admin.posts.bulk.partial': '{done} ενημερώθηκαν, {failed} απέτυχαν',
  'admin.posts.bulk.delete': 'Διαγραφή',
  'admin.posts.bulk.publish': 'Δημοσίευση',
  'admin.posts.bulk.draft': 'Πρόχειρο',
  'admin.posts.bulk.trash': 'Μεταφορά στον κάδο',
};

export default posts;
