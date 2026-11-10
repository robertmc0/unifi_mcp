/** Networks and VLANs (reviewed 2026-11-10 against 11.0.97). */
import { networkOperation, PAGED } from '../define.ts';

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
