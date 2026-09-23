/**
 * en — admin.users.*
 *
 * One file per screen. 983 keys in a single module is a file nobody can review
 * and every translator conflicts in; split by surface, a screen's strings live
 * next to each other and two people can work at once.
 *
 * `admin.users.role.*` and `admin.users.status.*` are keyed by the VALUE they
 * label (`admin`, `active`) because the screen renders its role list from the
 * ROLES union. The value is what the filter and the API see; only the label
 * here is translated.
 */
export const users = {
  'admin.users.title': 'Users',
  'admin.users.subtitle': 'Manage user accounts and permissions',
  'admin.users.addUser': 'Add User',

  'admin.users.statTotal': 'Total Users',
  'admin.users.statActive': 'Active Users',
  'admin.users.statAdmins': 'Admins',
  'admin.users.statInactive': 'Inactive',

  'admin.users.searchPlaceholder': 'Search users...',
  'admin.users.allRoles': 'All Roles',
  'admin.users.allStatuses': 'All Status',
  'admin.users.bulkActions': 'Bulk Actions',
  'admin.users.deleteSelected': 'Delete Selected ({count})',

  'admin.users.role.admin': 'Admin',
  'admin.users.role.editor': 'Editor',
  'admin.users.role.author': 'Author',
  'admin.users.role.manager': 'Manager',
  'admin.users.role.viewer': 'Viewer',

  'admin.users.status.active': 'Active',
  'admin.users.status.inactive': 'Inactive',

  'admin.users.colUser': 'User',
  'admin.users.colRole': 'Role',
  'admin.users.colStatus': 'Status',
  'admin.users.colPosts': 'Posts',
  'admin.users.colLastLogin': 'Last Login',
  'admin.users.colActions': 'Actions',

  'admin.users.selectAll': 'Select all users',
  'admin.users.selectUser': 'Select {name}',

  'admin.users.edit': 'Edit',
  'admin.users.resetPassword': 'Reset Password',
  'admin.users.delete': 'Delete',

  'admin.users.modalAddTitle': 'Add New User',
  'admin.users.modalEditTitle': 'Edit User',
  'admin.users.closeModal': 'Close',
  'admin.users.fieldName': 'Full Name',
  'admin.users.fieldEmail': 'Email',
  'admin.users.fieldRole': 'Role',
  'admin.users.fieldStatus': 'Status',
  'admin.users.fieldPassword': 'Password',
  'admin.users.cancel': 'Cancel',
  'admin.users.saveUser': 'Save User',

  'admin.users.passwordRequired': 'Password is required for new users.',
  'admin.users.saveFailed': 'Save failed: {error}',
  'admin.users.userUpdated': 'User updated.',
  'admin.users.userCreated': 'User created.',
  'admin.users.confirmDelete': 'Are you sure you want to delete this user?',
  'admin.users.deleteFailed': 'Delete failed: {error}',
  'admin.users.userDeleted': 'User deleted.',
  'admin.users.promptNewPassword': 'Enter a new password (min 8 chars):',
  'admin.users.passwordTooShort': 'Password too short.',
  'admin.users.resetFailed': 'Reset failed: {error}',
  'admin.users.passwordUpdated': 'Password updated.',
  'admin.users.confirmBulkDelete': 'Delete the selected users ({count})? This cannot be undone.',
  'admin.users.bulkDeleted': 'Deleted: {count}.',
  'admin.users.bulkDeletedWithFailures': 'Deleted: {count}, failed: {failed}.',
};

export default users;
