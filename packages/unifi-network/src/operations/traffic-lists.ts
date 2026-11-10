/** Traffic matching lists, used by firewall policies (reviewed 2026-11-10). */
import { networkOperation, PAGED, siteLock } from '../define.ts';

export const listTrafficMatchingLists = networkOperation('getTrafficMatchingLists', {
  operationId: 'network.traffic_lists.list',
  category: 'traffic_lists',
  effect: 'read',
  description: 'Traffic matching lists of a site (port, IPv4 or IPv6 address lists).',
  ...PAGED,
});

export const getTrafficMatchingList = networkOperation('getTrafficMatchingList', {
  operationId: 'network.traffic_lists.get',
  category: 'traffic_lists',
  effect: 'read',
  description: 'One traffic matching list and its items.',
});

// Writes: firewall policies match traffic through these lists. A new list changes nothing
// until a (high-risk) policy uses it, so creating one is medium; changing or deleting one
// can change what an existing policy allows (high).
const LISTS_LOCK = siteLock('traffic_lists');

export const createTrafficMatchingList = networkOperation('createTrafficMatchingList', {
  operationId: 'network.traffic_lists.create',
  category: 'traffic_lists',
  effect: 'write',
  risk: 'medium',
  approvalRequired: false,
  retryClass: 'non-idempotent',
  resourceLockKey: LISTS_LOCK,
  description: 'Create a traffic matching list (ports or addresses) for use in firewall policies.',
});

export const updateTrafficMatchingList = networkOperation('updateTrafficMatchingList', {
  operationId: 'network.traffic_lists.update',
  category: 'traffic_lists',
  effect: 'write',
  risk: 'high',
  approvalRequired: true,
  retryClass: 'idempotent',
  resourceLockKey: LISTS_LOCK,
  description:
    'Replace a traffic matching list; policies using it change too. Needs human approval.',
});

export const deleteTrafficMatchingList = networkOperation('deleteTrafficMatchingList', {
  operationId: 'network.traffic_lists.delete',
  category: 'traffic_lists',
  effect: 'write',
  risk: 'high',
  approvalRequired: true,
  retryClass: 'idempotent',
  resourceLockKey: LISTS_LOCK,
  description: 'Delete a traffic matching list. Needs human approval.',
});
