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
  // Observed 2026-11-12 on Network 11.0.99, also with direct requests: every network used
  // by clients or devices fails like this; networks used by nothing or only by Wi-Fi do
  // not. The cause is not known (docs/applications-network.md, Limitations).
  knownUpstreamFailures: [
    {
      status: 500,
      upstreamCode: 'api.unexpected-error',
      meaning:
        'The console could not list what uses this network. On Network 11.0.99 this happens ' +
        'for networks used by clients or devices: treat the network as in use, never as ' +
        'unused, and check in UniFi Network. Retrying does not help.',
    },
  ],
});

// Writes: networks and VLANs are routing configuration (spec §6.3 high).
const NETWORKS_LOCK = siteLock('networks');

/** Approvers cannot rely on the references read (see above), so they check by hand. */
const IN_USE_CAUTION =
  'The service cannot reliably list what uses a network: its references read fails for ' +
  'networks in use (Network 11.0.99). Check in UniFi Network which devices, switch ports ' +
  'and clients use it before approving.';

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
  approvalCaution: IN_USE_CAUTION,
});

export const deleteNetwork = networkOperation('deleteNetwork', {
  operationId: 'network.networks.delete',
  category: 'networks',
  effect: 'write',
  risk: 'high',
  approvalRequired: true,
  retryClass: 'idempotent',
  resourceLockKey: NETWORKS_LOCK,
  // `force` is not offered (ADR 0018, reviewed deviation). The contract does not describe
  // it; by its name it overrides a check of the console, and nothing here can show what
  // uses a network in use.
  description: 'Delete a network. The `force` flag is not offered. Needs human approval.',
  approvalCaution: IN_USE_CAUTION,
});
