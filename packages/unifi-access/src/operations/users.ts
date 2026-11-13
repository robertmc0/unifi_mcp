/**
 * Users, user groups and UniFi Identity resources: reads (reviewed 2026-11-13 against the
 * transcription, ADR 0023 §3). User records hold names, e-mail addresses, phone and
 * employee numbers (`personal_identifier`) and the user's NFC cards, license plates and
 * Touch Pass (`biometric_or_access_identity`). PIN hashes are removed (credentials.ts).
 */
import type { SensitivityTag } from '@unifi-local-mcp/policy';
import { accessOperation } from '../define.ts';

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
