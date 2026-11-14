/**
 * Users, user groups and UniFi Identity resources (reviewed against the transcription:
 * reads 2026-11-13, ADR 0023 §3; writes 2026-11-14, ADR 0023 §4). User records hold names,
 * e-mail addresses, phone and employee numbers (`personal_identifier`) and the user's NFC
 * cards, license plates and Touch Pass (`biometric_or_access_identity`). PIN hashes are
 * removed (credentials.ts).
 *
 * Writes: everything that can change who opens which door, or with what, is high risk with
 * human approval: users and their status, credentials, policies and group membership, and
 * every deletion. Only creating an empty user group, which grants nothing, is medium.
 * Setting a PIN is off by default: the client that chose it knows it (ADR 0023 §4).
 */
import type { SensitivityTag } from '@unifi-local-mcp/policy';
import { accessOperation, consoleLock, HIGH, MEDIUM, objectLock } from '../define.ts';

/** What a user record reveals: who the person is, and what lets them in. */
export const PERSON: readonly SensitivityTag[] = [
  'personal_identifier',
  'biometric_or_access_identity',
];

export const getUser = accessOperation('GET /api/v1/developer/users/{id}', {
  operationId: 'access.users.get',
  category: 'users',
  effect: 'read',
  description:
    'One Access user: name, contact details, status, NFC cards, license plates and access policies.',
  sensitivityTags: PERSON,
});

export const listUsers = accessOperation('GET /api/v1/developer/users', {
  operationId: 'access.users.list',
  category: 'users',
  effect: 'read',
  description: 'Access users, a page at a time, with their cards, plates and access policies.',
  sensitivityTags: PERSON,
});

export const searchUsers = accessOperation('GET /api/v1/developer/users/search', {
  operationId: 'access.users.search',
  category: 'users',
  effect: 'read',
  description: 'Access users matching a keyword, user ID, status or admin role.',
  sensitivityTags: PERSON,
});

export const listUserAccessPolicies = accessOperation(
  'GET /api/v1/developer/users/{id}/access_policies',
  {
    operationId: 'access.users.list_access_policies',
    category: 'users',
    effect: 'read',
    description:
      'The access policies of one user, optionally only those assigned directly, not through groups.',
  },
);

export const listUserGroups = accessOperation('GET /api/v1/developer/user_groups', {
  operationId: 'access.user_groups.list',
  category: 'user_groups',
  effect: 'read',
  description: 'Access user groups and their parent groups.',
});

export const getUserGroup = accessOperation('GET /api/v1/developer/user_groups/{id}', {
  operationId: 'access.user_groups.get',
  category: 'user_groups',
  effect: 'read',
  description: 'One Access user group.',
});

export const listUserGroupMembers = accessOperation(
  'GET /api/v1/developer/user_groups/{id}/users',
  {
    operationId: 'access.user_groups.list_users',
    category: 'user_groups',
    effect: 'read',
    description: 'The users directly in one user group, without its subgroups.',
    sensitivityTags: PERSON,
  },
);

export const listAllUserGroupMembers = accessOperation(
  'GET /api/v1/developer/user_groups/{id}/users/all',
  {
    operationId: 'access.user_groups.list_all_users',
    category: 'user_groups',
    effect: 'read',
    description: 'The users in one user group, including its subgroups.',
    sensitivityTags: PERSON,
  },
);

export const listUserGroupAccessPolicies = accessOperation(
  'GET /api/v1/developer/user_groups/{id}/access_policies',
  {
    operationId: 'access.user_groups.list_access_policies',
    category: 'user_groups',
    effect: 'read',
    description: 'The access policies assigned to one user group.',
  },
);

export const listIdentityResources = accessOperation(
  'GET /api/v1/developer/users/identity/assignments',
  {
    operationId: 'access.identity.list_resources',
    category: 'identity',
    effect: 'read',
    description: 'UniFi Identity resources (Wi-Fi, VPN, EV stations) that can be assigned.',
  },
);

export const listUserIdentityResources = accessOperation(
  'GET /api/v1/developer/users/{id}/identity/assignments',
  {
    operationId: 'access.identity.list_user_resources',
    category: 'identity',
    effect: 'read',
    description: 'The UniFi Identity resources assigned to one user.',
  },
);

export const listUserGroupIdentityResources = accessOperation(
  'GET /api/v1/developer/user_groups/{id}/identity/assignments',
  {
    operationId: 'access.identity.list_group_resources',
    category: 'identity',
    effect: 'read',
    description: 'The UniFi Identity resources assigned to one user group.',
  },
);

// Writes (reviewed 2026-11-14, ADR 0023 §4).

const USER = objectLock('users', 'id');
const USER_BY_USER_ID = objectLock('users', 'user_id');
const GROUP = objectLock('user_groups', 'id');

/** For the two PIN writes: the reason they are off by default, shown to approvers. */
export const PIN_CAUTION =
  'The requesting client chose this PIN and knows it: anyone it tells can open the doors this person may open.';

export const createUser = accessOperation('POST /api/v1/developer/users', {
  ...HIGH,
  operationId: 'access.users.create',
  category: 'users',
  description: 'Register an Access user with name, e-mail, employee number and onboarding time.',
  sensitivityTags: PERSON,
  retryClass: 'non-idempotent',
  resourceLockKey: consoleLock('users'),
});

export const updateUser = accessOperation('PUT /api/v1/developer/users/{id}', {
  ...HIGH,
  operationId: 'access.users.update',
  category: 'users',
  description: "Change a user's name, e-mail, employee number, onboarding time or status.",
  sensitivityTags: ['personal_identifier'],
  retryClass: 'idempotent',
  resourceLockKey: USER,
  approvalCaution:
    'A status change can deactivate the user, or reactivate them and restore their door access.',
});

export const deleteUser = accessOperation('DELETE /api/v1/developer/users/{id}', {
  ...HIGH,
  operationId: 'access.users.delete',
  category: 'users',
  description: 'Delete an Access user.',
  retryClass: 'idempotent',
  resourceLockKey: USER,
  approvalCaution:
    'The user, their credentials and their door access are removed; this cannot be undone.',
});

export const assignUserAccessPolicies = accessOperation(
  'PUT /api/v1/developer/users/{id}/access_policies',
  {
    ...HIGH,
    operationId: 'access.users.assign_access_policies',
    category: 'users',
    description: 'Assign access policies (which doors, and when) to one user.',
    retryClass: 'idempotent',
    resourceLockKey: USER,
  },
);

export const assignUserNfcCard = accessOperation('PUT /api/v1/developer/users/{id}/nfc_cards', {
  ...HIGH,
  operationId: 'access.users.assign_nfc_card',
  category: 'users',
  description: 'Assign an enrolled NFC card to a user.',
  sensitivityTags: ['biometric_or_access_identity'],
  retryClass: 'idempotent',
  resourceLockKey: USER,
  approvalCaution: 'With force_add, a card that belongs to someone else is moved to this user.',
});

export const unassignUserNfcCard = accessOperation(
  'PUT /api/v1/developer/users/{id}/nfc_cards/delete',
  {
    ...HIGH,
    operationId: 'access.users.unassign_nfc_card',
    category: 'users',
    description: "Remove an NFC card from a user; the card no longer opens the user's doors.",
    sensitivityTags: ['biometric_or_access_identity'],
    retryClass: 'idempotent',
    resourceLockKey: USER,
  },
);

export const assignUserPin = accessOperation('PUT /api/v1/developer/users/{id}/pin_codes', {
  ...HIGH,
  operationId: 'access.users.assign_pin',
  category: 'users',
  description: "Set a user's PIN code. Off by default.",
  sensitivityTags: ['biometric_or_access_identity'],
  retryClass: 'idempotent',
  resourceLockKey: USER,
  defaultDisabled: true,
  approvalCaution: PIN_CAUTION,
});

export const unassignUserPin = accessOperation('DELETE /api/v1/developer/users/{id}/pin_codes', {
  ...HIGH,
  operationId: 'access.users.unassign_pin',
  category: 'users',
  description: "Remove a user's PIN code.",
  sensitivityTags: ['biometric_or_access_identity'],
  retryClass: 'idempotent',
  resourceLockKey: USER,
});

export const assignUserLicensePlates = accessOperation(
  'PUT /api/v1/developer/users/{id}/license_plates',
  {
    ...HIGH,
    operationId: 'access.users.assign_license_plates',
    category: 'users',
    description: 'Assign license plate numbers to a user, for gates that read plates.',
    sensitivityTags: ['biometric_or_access_identity'],
    retryClass: 'idempotent',
    resourceLockKey: USER,
  },
);

export const unassignUserLicensePlate = accessOperation(
  'DELETE /api/v1/developer/users/{user_id}/license_plates/{license_plate_id}',
  {
    ...HIGH,
    operationId: 'access.users.unassign_license_plate',
    category: 'users',
    description: 'Remove one license plate number from a user.',
    sensitivityTags: ['biometric_or_access_identity'],
    retryClass: 'idempotent',
    resourceLockKey: USER_BY_USER_ID,
  },
);

export const assignUserTouchPass = accessOperation(
  'PUT /api/v1/developer/users/{user_id}/touch_passes/{touch_pass_id}',
  {
    ...HIGH,
    operationId: 'access.users.assign_touch_pass',
    category: 'users',
    description: 'Assign one Touch Pass (a phone or watch credential) to a user.',
    sensitivityTags: PERSON,
    retryClass: 'idempotent',
    resourceLockKey: USER_BY_USER_ID,
  },
);

export const unassignUserTouchPass = accessOperation(
  'DELETE /api/v1/developer/users/{user_id}/touch_passes/{touch_pass_id}',
  {
    ...HIGH,
    operationId: 'access.users.unassign_touch_pass',
    category: 'users',
    description: 'Remove a Touch Pass from a user.',
    sensitivityTags: PERSON,
    retryClass: 'idempotent',
    resourceLockKey: USER_BY_USER_ID,
  },
);

export const assignTouchPasses = accessOperation(
  'PUT /api/v1/developer/users/touch_passes/assign',
  {
    ...HIGH,
    operationId: 'access.users.assign_touch_passes',
    category: 'users',
    description: 'Assign an available Touch Pass to each of several users.',
    sensitivityTags: PERSON,
    retryClass: 'non-idempotent',
    resourceLockKey: consoleLock('touch_passes'),
  },
);

export const createUserGroup = accessOperation('POST /api/v1/developer/user_groups', {
  ...MEDIUM,
  operationId: 'access.user_groups.create',
  category: 'user_groups',
  description: 'Create an empty user group, optionally under a parent group.',
  retryClass: 'non-idempotent',
  resourceLockKey: consoleLock('user_groups'),
});

export const updateUserGroup = accessOperation('PUT /api/v1/developer/user_groups/{id}', {
  ...HIGH,
  operationId: 'access.user_groups.update',
  category: 'user_groups',
  description: 'Rename a user group or move it under another parent group.',
  retryClass: 'idempotent',
  resourceLockKey: GROUP,
});

export const deleteUserGroup = accessOperation('DELETE /api/v1/developer/user_groups/{id}', {
  ...HIGH,
  operationId: 'access.user_groups.delete',
  category: 'user_groups',
  description: 'Delete a user group.',
  retryClass: 'idempotent',
  resourceLockKey: GROUP,
  approvalCaution: "The group's members may lose the door access the group gave them.",
});

export const addUserGroupMembers = accessOperation(
  'POST /api/v1/developer/user_groups/{id}/users',
  {
    ...HIGH,
    operationId: 'access.user_groups.add_users',
    category: 'user_groups',
    description: "Add users to a user group; they gain the group's access policies.",
    retryClass: 'idempotent',
    resourceLockKey: GROUP,
  },
);

export const removeUserGroupMembers = accessOperation(
  'POST /api/v1/developer/user_groups/{id}/users/delete',
  {
    ...HIGH,
    operationId: 'access.user_groups.remove_users',
    category: 'user_groups',
    description: 'Remove users from a user group.',
    retryClass: 'idempotent',
    resourceLockKey: GROUP,
  },
);

export const assignUserGroupAccessPolicies = accessOperation(
  'PUT /api/v1/developer/user_groups/{id}/access_policies',
  {
    ...HIGH,
    operationId: 'access.user_groups.assign_access_policies',
    category: 'user_groups',
    description: 'Assign access policies (which doors, and when) to every member of a user group.',
    retryClass: 'idempotent',
    resourceLockKey: GROUP,
  },
);

const IDENTITY_CAUTION =
  'Grants the chosen Wi-Fi, VPN or EV-station resources; a VPN grant reaches the local network.';

export const sendIdentityInvitations = accessOperation(
  'POST /api/v1/developer/users/identity/invitations',
  {
    ...HIGH,
    operationId: 'access.identity.send_invitations',
    category: 'identity',
    description: 'E-mail UniFi Identity invitations to users, optionally to another address.',
    sensitivityTags: ['personal_identifier'],
    retryClass: 'non-idempotent',
    resourceLockKey: consoleLock('identity_invitations'),
    approvalCaution:
      "Whoever receives the invitation can join UniFi Identity as this user: check that any address given is the user's own.",
  },
);

export const assignUserIdentityResources = accessOperation(
  'POST /api/v1/developer/users/{id}/identity/assignments',
  {
    ...HIGH,
    operationId: 'access.identity.assign_user_resources',
    category: 'identity',
    description: 'Assign UniFi Identity resources (Wi-Fi, VPN, EV stations) to a user.',
    retryClass: 'non-idempotent',
    resourceLockKey: USER,
    approvalCaution: IDENTITY_CAUTION,
  },
);

export const assignUserGroupIdentityResources = accessOperation(
  'POST /api/v1/developer/user_groups/{id}/identity/assignments',
  {
    ...HIGH,
    operationId: 'access.identity.assign_group_resources',
    category: 'identity',
    description: 'Assign UniFi Identity resources (Wi-Fi, VPN, EV stations) to a user group.',
    retryClass: 'non-idempotent',
    resourceLockKey: GROUP,
    approvalCaution: IDENTITY_CAUTION,
  },
);
