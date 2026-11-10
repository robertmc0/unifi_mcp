/** Networks and VLANs (reviewed 2026-11-10 against 11.0.97). */
import { networkOperation, PAGED, siteLock } from '../define.ts';

export const listNetworks = networkOperation('getNetworksOverviewPage', {
  operationId: 'network.networks.list',
  category: 'networks',
  effect: 'read',
  description: 'Networks of a site: name, VLAN id, management type, zone and whether enabled.',
  namedTool: 'network_list_networks',
  ...PAGED,
});

export const getNetwork = networkOperation('getNetworkDetails', {
  operationId: 'network.networks.get',
  category: 'networks',
  effect: 'read',
  description: 'One network in detail, including its IPv4 and IPv6 configuration.',
});

export const getNetworkReferences = networkOperation('getNetworkReferences', {
  operationId: 'network.networks.get_references',
  category: 'networks',
  effect: 'read',
  description: 'What refers to a network (for example Wi-Fi broadcasts), before changing it.',
});

// Writes: networks and VLANs are routing configuration (spec §6.3 high).
const NETWORKS_LOCK = siteLock('networks');

export const createNetwork = networkOperation('createNetwork', {
  operationId: 'network.networks.create',
  category: 'networks',
  effect: 'write',
  risk: 'high',
  approvalRequired: true,
  retryClass: 'non-idempotent',
  resourceLockKey: NETWORKS_LOCK,
  description: 'Create a network (VLAN) managed by the gateway or a switch. Needs human approval.',
});

export const updateNetwork = networkOperation('updateNetwork', {
  operationId: 'network.networks.update',
  category: 'networks',
  effect: 'write',
  risk: 'high',
  approvalRequired: true,
  retryClass: 'idempotent',
  resourceLockKey: NETWORKS_LOCK,
  description: 'Replace a network configuration. Needs human approval.',
});

export const deleteNetwork = networkOperation('deleteNetwork', {
  operationId: 'network.networks.delete',
  category: 'networks',
  effect: 'write',
  risk: 'high',
  approvalRequired: true,
  retryClass: 'idempotent',
  resourceLockKey: NETWORKS_LOCK,
  description: 'Delete a network; `force` deletes it even while referenced. Needs human approval.',
});
