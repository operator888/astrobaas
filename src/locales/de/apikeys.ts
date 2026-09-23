/**
 * de — admin.apikeys.*
 *
 * One file per screen. 983 keys in a single module is a file nobody can review
 * and every translator conflicts in; split by surface, a screen's strings live
 * next to each other and two people can work at once.
 *
 * The `roleX` keys are LABELS only. The role a key is minted with travels in
 * the `value` attribute of its <option> and in the JSON payload, so translating
 * the label can never change what the API is asked for.
 */
export const apikeys = {
  'admin.apikeys.title': 'API-Schlüssel',
  'admin.apikeys.intro': 'Bearer-Schlüssel für Headless-, Cross-Origin- und Agent-Zugriff. Das Geheimnis wird nur einmal bei der Erstellung angezeigt.',

  'admin.apikeys.secretWarning': 'Kopieren Sie diesen Schlüssel jetzt — er wird nicht erneut angezeigt.',
  'admin.apikeys.copySecret': 'Kopieren',

  'admin.apikeys.nameLabel': 'Name',
  'admin.apikeys.namePlaceholder': 'my-frontend',
  'admin.apikeys.roleLabel': 'Rolle',
  'admin.apikeys.roleAdmin': 'Administrator',
  'admin.apikeys.roleEditor': 'Redakteur',
  'admin.apikeys.roleAuthor': 'Autor',
  'admin.apikeys.roleManager': 'Manager',
  'admin.apikeys.roleViewer': 'Betrachter',
  'admin.apikeys.scopesLabel': 'Berechtigungsbereiche (optional)',
  'admin.apikeys.scopesHelp': 'Durch Komma getrennt. Leer lassen für den vollen Zugriff der Rolle.',
  'admin.apikeys.expiresLabel': 'Gültigkeitsdauer in Tagen (optional)',
  'admin.apikeys.createButton': 'Schlüssel erstellen',

  'admin.apikeys.colName': 'Name',
  'admin.apikeys.colPrefix': 'Präfix',
  'admin.apikeys.colRole': 'Rolle',
  'admin.apikeys.colScopes': 'Berechtigungsbereiche',
  'admin.apikeys.colExpires': 'Läuft ab',
  'admin.apikeys.colLastUsed': 'Zuletzt verwendet',
  'admin.apikeys.colActions': 'Aktionen',

  'admin.apikeys.loading': 'Wird geladen…',
  'admin.apikeys.empty': 'Noch keine Schlüssel vorhanden.',

  'admin.apikeys.rotate': 'Rotieren',
  'admin.apikeys.revoke': 'Widerrufen',
  'admin.apikeys.rotateConfirm': 'Diesen Schlüssel rotieren? Das aktuelle Geheimnis wird sofort ungültig.',
  'admin.apikeys.revokeConfirm': '„{name}“ widerrufen? Dies kann nicht rückgängig gemacht werden.',
};

export default apikeys;
