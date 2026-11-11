/**
 * Users (reviewed 2026-11-11 against 7.4.96). Names and e-mail addresses: the
 * `personal_identifier` grant is required (ADR 0019 §5).
 */
import { protectOperation } from '../define.ts';

export const listUsers = protectOperation('GET /v1/users', {
  operationId: 'protect.users.list',
  category: 'users',
  effect: 'read',
  description: 'Protect users: names and e-mail addresses.',
  sensitivityTags: ['personal_identifier'],
});

export const getUser = protectOperation('GET /v1/users/{id}', {
  operationId: 'protect.users.get',
  category: 'users',
  effect: 'read',
  description: 'One Protect user.',
  sensitivityTags: ['personal_identifier'],
});

export const listUlpUsers = protectOperation('GET /v1/ulp-users', {
  operationId: 'protect.users.list_ulp',
  category: 'users',
  effect: 'read',
  description: 'ULP users: names, e-mail addresses and status.',
  sensitivityTags: ['personal_identifier'],
});

export const getUlpUser = protectOperation('GET /v1/ulp-users/{id}', {
  operationId: 'protect.users.get_ulp',
  category: 'users',
  effect: 'read',
  description: 'One ULP user.',
  sensitivityTags: ['personal_identifier'],
});
