/**
 * @unifi-local-mcp/unifi-network
 *
 * The official local UniFi Network Integration API adapter (ADR 0018): generated request
 * and response schemas for contract revision 11.0.97, and the hand-reviewed security
 * metadata of every implemented operation. Only operations recorded in
 * `api-specs/network/11.0.97/` can be implemented here.
 */
import type { OperationDescriptor } from '@unifi-local-mcp/core';
import { getAclRule, getAclRuleOrdering, listAclRules } from './operations/acl.ts';
import { getClient, listClients } from './operations/clients.ts';
import {
  getDevice,
  getDeviceStatistics,
  listDevices,
  listDeviceTags,
  listPendingDevices,
} from './operations/devices.ts';
import { getDnsPolicy, listDnsPolicies } from './operations/dns.ts';
import {
  getFirewallPolicy,
  getFirewallPolicyOrdering,
  getFirewallZone,
  listFirewallPolicies,
  listFirewallZones,
} from './operations/firewall.ts';
import { getVoucher, listVouchers } from './operations/hotspot.ts';
import { getInfo } from './operations/info.ts';
import { getNetwork, getNetworkReferences, listNetworks } from './operations/networks.ts';
import { listSites } from './operations/sites.ts';
import {
  listCountries,
  listDpiApplications,
  listDpiCategories,
  listRadiusProfiles,
  listSiteToSiteVpnTunnels,
  listVpnServers,
  listWans,
} from './operations/supporting.ts';
import {
  getLag,
  getMcLagDomain,
  getSwitchStack,
  listLags,
  listMcLagDomains,
  listSwitchStacks,
} from './operations/switching.ts';
import { getTrafficMatchingList, listTrafficMatchingLists } from './operations/traffic-lists.ts';
import { getWifiBroadcast, listWifiBroadcasts } from './operations/wifi.ts';

export { ALWAYS_REMOVED, withoutCredentials } from './credentials.ts';
export {
  NETWORK_CONTRACT_REVISION,
  NETWORK_VERSION_RANGE,
  networkOperation,
  PAGED,
  type NetworkPage,
  type VendorOperationId,
} from './define.ts';
export { NETWORK_VERSION_PROBE } from './probe.ts';

/** Every documented Network read (41), reviewed 2026-11-10. */
export const NETWORK_READS: readonly OperationDescriptor[] = [
  getInfo,
  listSites,
  listDevices,
  getDevice,
  getDeviceStatistics,
  listPendingDevices,
  listDeviceTags,
  listClients,
  getClient,
  listNetworks,
  getNetwork,
  getNetworkReferences,
  listWifiBroadcasts,
  getWifiBroadcast,
  listFirewallPolicies,
  getFirewallPolicy,
  getFirewallPolicyOrdering,
  listFirewallZones,
  getFirewallZone,
  listAclRules,
  getAclRule,
  getAclRuleOrdering,
  listDnsPolicies,
  getDnsPolicy,
  listVouchers,
  getVoucher,
  listLags,
  getLag,
  listMcLagDomains,
  getMcLagDomain,
  listSwitchStacks,
  getSwitchStack,
  listTrafficMatchingLists,
  getTrafficMatchingList,
  listVpnServers,
  listSiteToSiteVpnTunnels,
  listWans,
  listRadiusProfiles,
  listCountries,
  listDpiApplications,
  listDpiCategories,
];

/** Every implemented Network operation, registered by the service at startup. */
export const NETWORK_OPERATIONS: readonly OperationDescriptor[] = [...NETWORK_READS];
