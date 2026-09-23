/**
 * de — admin.users.*
 *
 * One file per screen. 983 keys in a single module is a file nobody can review
 * and every translator conflicts in; split by surface, a screen's strings live
 * next to each other and two people can work at once.
 *
 * Formal address (Sie) throughout, and compounds are written out. A label that
 * wraps is a layout problem, not a reason to write "Passwort zurücks.".
 */
export const users = {
  'admin.users.title': 'Benutzer',
  'admin.users.subtitle': 'Benutzerkonten und Berechtigungen verwalten',
  'admin.users.addUser': 'Benutzer hinzufügen',

  'admin.users.statTotal': 'Benutzer gesamt',
  'admin.users.statActive': 'Aktive Benutzer',
  'admin.users.statAdmins': 'Administratoren',
  'admin.users.statInactive': 'Inaktiv',

  'admin.users.searchPlaceholder': 'Benutzer suchen …',
  'admin.users.allRoles': 'Alle Rollen',
  'admin.users.allStatuses': 'Alle Status',
  'admin.users.bulkActions': 'Sammelaktionen',
  'admin.users.deleteSelected': 'Ausgewählte löschen ({count})',

  'admin.users.role.admin': 'Administrator',
  'admin.users.role.editor': 'Redakteur',
  'admin.users.role.author': 'Autor',
  'admin.users.role.manager': 'Manager',
  'admin.users.role.viewer': 'Betrachter',

  'admin.users.status.active': 'Aktiv',
  'admin.users.status.inactive': 'Inaktiv',

  'admin.users.colUser': 'Benutzer',
  'admin.users.colRole': 'Rolle',
  'admin.users.colStatus': 'Status',
  'admin.users.colPosts': 'Beiträge',
  'admin.users.colLastLogin': 'Letzte Anmeldung',
  'admin.users.colActions': 'Aktionen',

  'admin.users.selectAll': 'Alle Benutzer auswählen',
  'admin.users.selectUser': '{name} auswählen',

  'admin.users.edit': 'Bearbeiten',
  'admin.users.resetPassword': 'Passwort zurücksetzen',
  'admin.users.delete': 'Löschen',

  'admin.users.modalAddTitle': 'Neuen Benutzer anlegen',
  'admin.users.modalEditTitle': 'Benutzer bearbeiten',
  'admin.users.closeModal': 'Schließen',
  'admin.users.fieldName': 'Vollständiger Name',
  'admin.users.fieldEmail': 'E-Mail',
  'admin.users.fieldRole': 'Rolle',
  'admin.users.fieldStatus': 'Status',
  'admin.users.fieldPassword': 'Passwort',
  'admin.users.cancel': 'Abbrechen',
  'admin.users.saveUser': 'Benutzer speichern',

  'admin.users.passwordRequired': 'Für neue Benutzer ist ein Passwort erforderlich.',
  'admin.users.saveFailed': 'Speichern fehlgeschlagen: {error}',
  'admin.users.userUpdated': 'Benutzer aktualisiert.',
  'admin.users.userCreated': 'Benutzer angelegt.',
  'admin.users.confirmDelete': 'Möchten Sie diesen Benutzer wirklich löschen?',
  'admin.users.deleteFailed': 'Löschen fehlgeschlagen: {error}',
  'admin.users.userDeleted': 'Benutzer gelöscht.',
  'admin.users.promptNewPassword': 'Geben Sie ein neues Passwort ein (mindestens 8 Zeichen):',
  'admin.users.passwordTooShort': 'Das Passwort ist zu kurz.',
  'admin.users.resetFailed': 'Zurücksetzen fehlgeschlagen: {error}',
  'admin.users.passwordUpdated': 'Passwort aktualisiert.',
  'admin.users.confirmBulkDelete': 'Die ausgewählten Benutzer ({count}) löschen? Dies kann nicht rückgängig gemacht werden.',
  'admin.users.bulkDeleted': 'Gelöscht: {count}.',
  'admin.users.bulkDeletedWithFailures': 'Gelöscht: {count}, fehlgeschlagen: {failed}.',
};

export default users;
