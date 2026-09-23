/**
 * en — admin.apikeys.*
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
  'admin.apikeys.title': 'API Keys',
  'admin.apikeys.intro': 'Bearer keys for headless / cross-origin / agent access. The secret is shown once at creation.',

  'admin.apikeys.secretWarning': 'Copy this key now — it will not be shown again.',
  'admin.apikeys.copySecret': 'Copy',

  'admin.apikeys.nameLabel': 'Name',
  'admin.apikeys.namePlaceholder': 'my-frontend',
  'admin.apikeys.roleLabel': 'Role',
  'admin.apikeys.roleAdmin': 'Admin',
  'admin.apikeys.roleEditor': 'Editor',
  'admin.apikeys.roleAuthor': 'Author',
  'admin.apikeys.roleManager': 'Manager',
  'admin.apikeys.roleViewer': 'Viewer',
  'admin.apikeys.scopesLabel': 'Scopes (optional)',
  'admin.apikeys.scopesHelp': 'Comma-separated. Omit for full role access.',
  'admin.apikeys.expiresLabel': 'Expires in days (optional)',
  'admin.apikeys.createButton': 'Create key',

  'admin.apikeys.colName': 'Name',
  'admin.apikeys.colPrefix': 'Prefix',
  'admin.apikeys.colRole': 'Role',
  'admin.apikeys.colScopes': 'Scopes',
  'admin.apikeys.colExpires': 'Expires',
  'admin.apikeys.colLastUsed': 'Last used',
  'admin.apikeys.colActions': 'Actions',

  'admin.apikeys.loading': 'Loading…',
  'admin.apikeys.empty': 'No keys yet.',

  'admin.apikeys.rotate': 'Rotate',
  'admin.apikeys.revoke': 'Revoke',
  'admin.apikeys.rotateConfirm': 'Rotate this key? The current secret stops working immediately.',
  'admin.apikeys.revokeConfirm': 'Revoke "{name}"? This cannot be undone.',
};

export default apikeys;
