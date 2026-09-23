/**
 * en — admin.profile.*
 *
 * One file per screen. 983 keys in a single module is a file nobody can review
 * and every translator conflicts in; split by surface, a screen's strings live
 * next to each other and two people can work at once.
 */
export const profile = {
  'admin.profile.pageTitle': 'Profile',
  'admin.profile.title': 'Your profile',
  'admin.profile.subtitle': 'Update your name, email, or password.',

  'admin.profile.nameLabel': 'Name',
  'admin.profile.emailLabel': 'Email',
  'admin.profile.roleLabel': 'Role',
  'admin.profile.saveChanges': 'Save changes',

  'admin.profile.passwordHeading': 'Change password',
  'admin.profile.newPassword': 'New password',
  'admin.profile.passwordHint': 'At least 8 characters.',
  'admin.profile.confirmPassword': 'Confirm password',
  'admin.profile.updatePassword': 'Update password',

  'admin.profile.twoFactorHeading': 'Two-factor authentication',
  'admin.profile.twoFactorIntro':
    'Add a time-based one-time code from an authenticator app (Google Authenticator, 1Password, Aegis…) as a second step at login.',
  'admin.profile.twoFactorNeedsEmail': 'Two-factor sign-in needs a working email channel first — it is the recovery path if you lose your authenticator. Configure email (for example the SMTP2GO plugin), then come back here.',
  'admin.profile.enableTwoFactor': 'Enable two-factor',

  'admin.profile.setupStep1': 'Add this secret to your authenticator app:',
  'admin.profile.setupStep2': 'Or paste this setup URI into the app:',
  'admin.profile.setupStep3': 'Enter the 6-digit code it shows to confirm:',
  'admin.profile.confirmEnable': 'Confirm & enable',

  'admin.profile.backupCodesIntro':
    'Two-factor is on. Save these backup codes somewhere safe — each works once, and they won’t be shown again.',
  'admin.profile.backupCodesDone': 'I’ve saved them',

  'admin.profile.disableIntro':
    'To turn two-factor off, enter a current authenticator code or a backup code.',
  'admin.profile.disableTwoFactor': 'Disable two-factor',

  // Browser-side (window.t): no plural support, so nothing here takes a count.
  'admin.profile.saveFailed': 'Save failed: {error}',
  'admin.profile.profileUpdated': 'Profile updated.',
  'admin.profile.passwordTooShort': 'Password must be at least 8 characters.',
  'admin.profile.passwordMismatch': 'Passwords do not match.',
  'admin.profile.passwordChangeFailed': 'Password change failed: {error}',
  'admin.profile.passwordUpdated': 'Password updated.',
  'admin.profile.statusEnabled': 'Enabled',
  'admin.profile.statusDisabled': 'Disabled',
  'admin.profile.setupFailed': 'Could not start setup.',
  'admin.profile.enterCode': 'Enter the 6-digit code from your app.',
  'admin.profile.invalidCode': 'Invalid code.',
  'admin.profile.enterDisableCode': 'Enter a current code or a backup code to disable.',
  'admin.profile.twoFactorDisabled': 'Two-factor disabled.',
};

export default profile;
