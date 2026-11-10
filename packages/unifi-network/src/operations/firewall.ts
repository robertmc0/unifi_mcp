/** Firewall policies and zones (reviewed 2026-11-10 against 11.0.97). */
import { networkOperation, PAGED, siteLock } from '../define.ts';

export const listFirewallPolicies = networkOperation('getFirewallPolicies', {
  operationId: 'network.firewall.list_policies',
  category: 'firewall',
  effect: 'read',
  description: 'Firewall policies of a site: action, source, destination and order.',
  ...PAGED,
});

export const getFirewallPolicy = networkOperation('getFirewallPolicy', {
  operationId: 'network.firewall.get_policy',
  category: 'firewall',
  effect: 'read',
  description: 'One firewall policy in detail.',
});

export const getFirewallPolicyOrdering = networkOperation('getFirewallPolicyOrdering', {
  operationId: 'network.firewall.get_policy_ordering',
  category: 'firewall',
  effect: 'read',
  description: 'The order of user-defined firewall policies between a source and destination zone.',
});

export const listFirewallZones = networkOperation('getFirewallZones', {
  operationId: 'network.firewall.list_zones',
  category: 'firewall',
  effect: 'read',
  description: 'Firewall zones of a site and the networks in each.',
  ...PAGED,
});

export const getFirewallZone = networkOperation('getFirewallZone', {
  operationId: 'network.firewall.get_zone',
  category: 'firewall',
  effect: 'read',
  description: 'One firewall zone.',
});

// Writes: firewall policies and zones are security functions (spec §6.3 high), except the
// logging switches of a policy, which do not change what is allowed (medium). All firewall
// writes of a site share one lock: policies, zones and order interact.
const FIREWALL_LOCK = siteLock('firewall');
const high = { risk: 'high', approvalRequired: true } as const;

export const createFirewallPolicy = networkOperation('createFirewallPolicy', {
  operationId: 'network.firewall.create_policy',
  category: 'firewall',
  effect: 'write',
  ...high,
  retryClass: 'non-idempotent',
  resourceLockKey: FIREWALL_LOCK,
  description: 'Create a firewall policy. Needs human approval.',
});

export const updateFirewallPolicy = networkOperation('updateFirewallPolicy', {
  operationId: 'network.firewall.update_policy',
  category: 'firewall',
  effect: 'write',
  ...high,
  retryClass: 'idempotent',
  resourceLockKey: FIREWALL_LOCK,
  description: 'Replace a firewall policy. Needs human approval.',
});

export const patchFirewallPolicy = networkOperation('patchFirewallPolicy', {
  operationId: 'network.firewall.patch_policy',
  category: 'firewall',
  effect: 'write',
  risk: 'medium',
  approvalRequired: false,
  retryClass: 'non-idempotent',
  resourceLockKey: FIREWALL_LOCK,
  description: 'Turn logging or flow reporting of a firewall policy on or off.',
});

export const deleteFirewallPolicy = networkOperation('deleteFirewallPolicy', {
  operationId: 'network.firewall.delete_policy',
  category: 'firewall',
  effect: 'write',
  ...high,
  retryClass: 'idempotent',
  resourceLockKey: FIREWALL_LOCK,
  description: 'Delete a firewall policy. Needs human approval.',
});

export const updateFirewallPolicyOrdering = networkOperation('updateFirewallPolicyOrdering', {
  operationId: 'network.firewall.update_policy_ordering',
  category: 'firewall',
  effect: 'write',
  ...high,
  retryClass: 'idempotent',
  resourceLockKey: FIREWALL_LOCK,
  description:
    'Change the order of firewall policies between a source and destination zone. Needs human approval.',
});

export const createFirewallZone = networkOperation('createFirewallZone', {
  operationId: 'network.firewall.create_zone',
  category: 'firewall',
  effect: 'write',
  ...high,
  retryClass: 'non-idempotent',
  resourceLockKey: FIREWALL_LOCK,
  description: 'Create a firewall zone. Needs human approval.',
});

export const updateFirewallZone = networkOperation('updateFirewallZone', {
  operationId: 'network.firewall.update_zone',
  category: 'firewall',
  effect: 'write',
  ...high,
  retryClass: 'idempotent',
  resourceLockKey: FIREWALL_LOCK,
  description: 'Replace a firewall zone, including its networks. Needs human approval.',
});

export const deleteFirewallZone = networkOperation('deleteFirewallZone', {
  operationId: 'network.firewall.delete_zone',
  category: 'firewall',
  effect: 'write',
  ...high,
  retryClass: 'idempotent',
  resourceLockKey: FIREWALL_LOCK,
  description: 'Delete a firewall zone. Needs human approval.',
});
