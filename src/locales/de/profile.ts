/**
 * de — admin.profile.*
 *
 * One file per screen. 983 keys in a single module is a file nobody can review
 * and every translator conflicts in; split by surface, a screen's strings live
 * next to each other and two people can work at once.
 */
export const profile = {
  'admin.profile.pageTitle': 'Profil',
  'admin.profile.title': 'Ihr Profil',
  'admin.profile.subtitle':
    'Aktualisieren Sie Ihren Namen, Ihre E-Mail-Adresse oder Ihr Passwort.',

  'admin.profile.nameLabel': 'Name',
  'admin.profile.emailLabel': 'E-Mail-Adresse',
  'admin.profile.roleLabel': 'Rolle',
  'admin.profile.saveChanges': 'Änderungen speichern',

  'admin.profile.passwordHeading': 'Passwort ändern',
  'admin.profile.newPassword': 'Neues Passwort',
  'admin.profile.passwordHint': 'Mindestens 8 Zeichen.',
  'admin.profile.confirmPassword': 'Passwort bestätigen',
  'admin.profile.updatePassword': 'Passwort aktualisieren',

  'admin.profile.twoFactorHeading': 'Zwei-Faktor-Authentifizierung',
  'admin.profile.twoFactorIntro':
    'Fügen Sie als zweiten Schritt bei der Anmeldung einen zeitbasierten Einmalcode aus einer Authenticator-App (Google Authenticator, 1Password, Aegis…) hinzu.',
  'admin.profile.twoFactorNeedsEmail': 'Die Zwei-Faktor-Anmeldung braucht zuerst einen funktionierenden E-Mail-Kanal — er ist der Wiederherstellungsweg, falls Sie Ihren Authenticator verlieren. Richten Sie E-Mail ein (z. B. das SMTP2GO-Plugin) und kommen Sie hierher zurück.',
  'admin.profile.enableTwoFactor': 'Zwei-Faktor-Authentifizierung aktivieren',

  'admin.profile.setupStep1': 'Fügen Sie dieses Geheimnis zu Ihrer Authenticator-App hinzu:',
  'admin.profile.setupStep2': 'Oder fügen Sie diese Einrichtungs-URI in die App ein:',
  'admin.profile.setupStep3': 'Geben Sie zur Bestätigung den angezeigten 6-stelligen Code ein:',
  'admin.profile.confirmEnable': 'Bestätigen und aktivieren',

  'admin.profile.backupCodesIntro':
    'Die Zwei-Faktor-Authentifizierung ist aktiv. Bewahren Sie diese Backup-Codes an einem sicheren Ort auf — jeder funktioniert nur einmal und sie werden nicht erneut angezeigt.',
  'admin.profile.backupCodesDone': 'Ich habe sie gespeichert',

  'admin.profile.disableIntro':
    'Um die Zwei-Faktor-Authentifizierung zu deaktivieren, geben Sie einen aktuellen Authenticator-Code oder einen Backup-Code ein.',
  'admin.profile.disableTwoFactor': 'Zwei-Faktor-Authentifizierung deaktivieren',

  // Browser-side (window.t): no plural support, so nothing here takes a count.
  'admin.profile.saveFailed': 'Speichern fehlgeschlagen: {error}',
  'admin.profile.profileUpdated': 'Profil aktualisiert.',
  'admin.profile.passwordTooShort': 'Das Passwort muss mindestens 8 Zeichen lang sein.',
  'admin.profile.passwordMismatch': 'Die Passwörter stimmen nicht überein.',
  'admin.profile.passwordChangeFailed': 'Passwortänderung fehlgeschlagen: {error}',
  'admin.profile.passwordUpdated': 'Passwort aktualisiert.',
  'admin.profile.statusEnabled': 'Aktiviert',
  'admin.profile.statusDisabled': 'Deaktiviert',
  'admin.profile.setupFailed': 'Die Einrichtung konnte nicht gestartet werden.',
  'admin.profile.enterCode': 'Geben Sie den 6-stelligen Code aus Ihrer App ein.',
  'admin.profile.invalidCode': 'Ungültiger Code.',
  'admin.profile.enterDisableCode':
    'Geben Sie zum Deaktivieren einen aktuellen Code oder einen Backup-Code ein.',
  'admin.profile.twoFactorDisabled': 'Zwei-Faktor-Authentifizierung deaktiviert.',
};

export default profile;
