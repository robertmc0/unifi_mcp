/**
 * The reviewed security metadata of every Network operation (spec §4.3, §6.3, §6.4;
 * ADR 0018 §4). The table below is the review record: a change to permissions, risk,
 * approval, sensitivity, default state or named tools must change this table too, so it
 * cannot happen silently, for instance through a regenerated schema.
 *
 * Columns: operationId, effect, risk, approval required, sensitivity tags, default
 * disabled, named tool. The permission is always `network.<category>.<effect>`.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NETWORK_OPERATIONS } from '@unifi-local-mcp/unifi-network';
import { describe, expect, it } from 'vitest';

type Row = [
  operationId: string,
  effect: 'read' | 'write',
  risk: 'low' | 'medium' | 'high',
  approval: boolean,
  sensitivity: string[],
  defaultDisabled: boolean,
  namedTool: string | null,
];

const PEOPLE = ['personal_identifier', 'network_identity'];

/** Reviewed 2026-11-10 against contract 11.0.97, by vendor operationId. */
// prettier-ignore
const REVIEW: Record<string, Row> = {
  // Reads: low risk, no approval. Client data needs sensitive grants.
  getInfo: ['network.info.get', 'read', 'low', false, [], false, null],
  getSiteOverviewPage: ['network.sites.list', 'read', 'low', false, [], false, 'network_list_sites'],
  getAdoptedDeviceOverviewPage: ['network.devices.list', 'read', 'low', false, [], false, 'network_list_devices'],
  getAdoptedDeviceDetails: ['network.devices.get', 'read', 'low', false, [], false, 'network_get_device'],
  getAdoptedDeviceLatestStatistics: ['network.devices.get_statistics', 'read', 'low', false, [], false, null],
  getPendingDevicePage: ['network.devices.list_pending', 'read', 'low', false, [], false, null],
  getDeviceTagPage: ['network.devices.list_tags', 'read', 'low', false, [], false, null],
  getConnectedClientOverviewPage: ['network.clients.list', 'read', 'low', false, PEOPLE, false, 'network_list_clients'],
  getConnectedClientDetails: ['network.clients.get', 'read', 'low', false, PEOPLE, false, null],
  getNetworksOverviewPage: ['network.networks.list', 'read', 'low', false, [], false, 'network_list_networks'],
  getNetworkDetails: ['network.networks.get', 'read', 'low', false, [], false, null],
  getNetworkReferences: ['network.networks.get_references', 'read', 'low', false, [], false, null],
  getWifiBroadcastPage: ['network.wifi.list', 'read', 'low', false, [], false, null],
  getWifiBroadcastDetails: ['network.wifi.get', 'read', 'low', false, [], false, null],
  getFirewallPolicies: ['network.firewall.list_policies', 'read', 'low', false, [], false, null],
  getFirewallPolicy: ['network.firewall.get_policy', 'read', 'low', false, [], false, null],
  getFirewallPolicyOrdering: ['network.firewall.get_policy_ordering', 'read', 'low', false, [], false, null],
  getFirewallZones: ['network.firewall.list_zones', 'read', 'low', false, [], false, null],
  getFirewallZone: ['network.firewall.get_zone', 'read', 'low', false, [], false, null],
  getAclRulePage: ['network.acl.list', 'read', 'low', false, [], false, null],
  getAclRule: ['network.acl.get', 'read', 'low', false, [], false, null],
  getAclRuleOrdering: ['network.acl.get_ordering', 'read', 'low', false, [], false, null],
  getDnsPolicyPage: ['network.dns.list', 'read', 'low', false, [], false, null],
  getDnsPolicy: ['network.dns.get', 'read', 'low', false, [], false, null],
  getVouchers: ['network.hotspot.list_vouchers', 'read', 'low', false, [], false, null],
  getVoucher: ['network.hotspot.get_voucher', 'read', 'low', false, [], false, null],
  getLagPage: ['network.switching.list_lags', 'read', 'low', false, [], false, null],
  getLag: ['network.switching.get_lag', 'read', 'low', false, [], false, null],
  getMcLagDomainPage: ['network.switching.list_mc_lag_domains', 'read', 'low', false, [], false, null],
  getMcLagDomain: ['network.switching.get_mc_lag_domain', 'read', 'low', false, [], false, null],
  getSwitchStackPage: ['network.switching.list_switch_stacks', 'read', 'low', false, [], false, null],
  getSwitchStack: ['network.switching.get_switch_stack', 'read', 'low', false, [], false, null],
  getTrafficMatchingLists: ['network.traffic_lists.list', 'read', 'low', false, [], false, null],
  getTrafficMatchingList: ['network.traffic_lists.get', 'read', 'low', false, [], false, null],
  getVpnServerPage: ['network.vpn.list_servers', 'read', 'low', false, [], false, null],
  getSiteToSiteVpnTunnelPage: ['network.vpn.list_site_to_site_tunnels', 'read', 'low', false, [], false, null],
  getWansOverviewPage: ['network.wans.list', 'read', 'low', false, [], false, null],
  getRadiusProfileOverviewPage: ['network.radius.list_profiles', 'read', 'low', false, [], false, null],
  getCountries: ['network.reference.list_countries', 'read', 'low', false, [], false, null],
  getDpiApplications: ['network.reference.list_dpi_applications', 'read', 'low', false, [], false, null],
  getDpiApplicationCategories: ['network.reference.list_dpi_categories', 'read', 'low', false, [], false, null],

  // Writes. High risk needs independent human approval (spec §6.3): security functions
  // (firewall, ACL, DNS, Wi-Fi security), routing (networks/VLANs), device adoption,
  // removal and restarts, and destructive bulk deletes. Medium: limited, reversible effect.
  createAclRule: ['network.acl.create', 'write', 'high', true, [], false, null],
  updateAclRule: ['network.acl.update', 'write', 'high', true, [], false, null],
  deleteAclRule: ['network.acl.delete', 'write', 'high', true, [], false, null],
  updateAclRuleOrdering: ['network.acl.update_ordering', 'write', 'high', true, [], false, null],
  createFirewallPolicy: ['network.firewall.create_policy', 'write', 'high', true, [], false, null],
  updateFirewallPolicy: ['network.firewall.update_policy', 'write', 'high', true, [], false, null],
  patchFirewallPolicy: ['network.firewall.patch_policy', 'write', 'medium', false, [], false, null],
  deleteFirewallPolicy: ['network.firewall.delete_policy', 'write', 'high', true, [], false, null],
  updateFirewallPolicyOrdering: ['network.firewall.update_policy_ordering', 'write', 'high', true, [], false, null],
  createFirewallZone: ['network.firewall.create_zone', 'write', 'high', true, [], false, null],
  updateFirewallZone: ['network.firewall.update_zone', 'write', 'high', true, [], false, null],
  deleteFirewallZone: ['network.firewall.delete_zone', 'write', 'high', true, [], false, null],
  createNetwork: ['network.networks.create', 'write', 'high', true, [], false, null],
  updateNetwork: ['network.networks.update', 'write', 'high', true, [], false, null],
  deleteNetwork: ['network.networks.delete', 'write', 'high', true, [], false, null],
  createWifiBroadcast: ['network.wifi.create', 'write', 'high', true, [], false, null],
  updateWifiBroadcast: ['network.wifi.update', 'write', 'high', true, [], false, null],
  deleteWifiBroadcast: ['network.wifi.delete', 'write', 'high', true, [], false, null],
  createDnsPolicy: ['network.dns.create', 'write', 'high', true, [], false, null],
  updateDnsPolicy: ['network.dns.update', 'write', 'high', true, [], false, null],
  deleteDnsPolicy: ['network.dns.delete', 'write', 'high', true, [], false, null],
  createTrafficMatchingList: ['network.traffic_lists.create', 'write', 'medium', false, [], false, null],
  updateTrafficMatchingList: ['network.traffic_lists.update', 'write', 'high', true, [], false, null],
  deleteTrafficMatchingList: ['network.traffic_lists.delete', 'write', 'high', true, [], false, null],
  adoptDevice: ['network.devices.adopt', 'write', 'high', true, [], false, null],
  removeDevice: ['network.devices.remove', 'write', 'high', true, [], true, null],
  executeAdoptedDeviceAction: ['network.devices.run_action', 'write', 'high', true, [], false, null],
  executePortAction: ['network.devices.run_port_action', 'write', 'high', true, [], false, null],
  executeConnectedClientAction: ['network.clients.run_action', 'write', 'medium', false, PEOPLE, false, null],
  createVouchers: ['network.hotspot.create_vouchers', 'write', 'medium', false, [], false, null],
  deleteVoucher: ['network.hotspot.delete_voucher', 'write', 'medium', false, [], false, null],
  deleteVouchers: ['network.hotspot.delete_vouchers', 'write', 'high', true, [], true, null],
};

interface InventoryOperation {
  method: string;
  path: string;
  vendorOperationId: string;
  documentationUrl: string;
}

const inventory = JSON.parse(
  await readFile(
    join(import.meta.dirname, '../../api-specs/network/11.0.97/operations.json'),
    'utf8',
  ),
) as { operations: InventoryOperation[] };
const byKey = new Map(inventory.operations.map((op) => [`${op.method} ${op.path}`, op]));

describe('Network security review', () => {
  it('covers all 73 documented operations', () => {
    expect(Object.keys(REVIEW)).toHaveLength(inventory.operations.length);
  });

  it('records every implemented operation, and only those', () => {
    const implemented = NETWORK_OPERATIONS.map((descriptor) => {
      const op = byKey.get(`${descriptor.httpMethod} ${descriptor.pathTemplate}`);
      expect(op, descriptor.operationId).toBeDefined();
      return op?.vendorOperationId ?? '';
    });
    expect(implemented.sort()).toEqual(Object.keys(REVIEW).sort());
  });

  it('matches the reviewed metadata exactly', () => {
    for (const descriptor of NETWORK_OPERATIONS) {
      const op = byKey.get(`${descriptor.httpMethod} ${descriptor.pathTemplate}`);
      const row = REVIEW[op?.vendorOperationId ?? ''];
      expect(row, descriptor.operationId).toBeDefined();
      if (row === undefined || op === undefined) continue;
      const [operationId, effect, risk, approval, sensitivity, defaultDisabled, namedTool] = row;
      expect(
        {
          operationId: descriptor.operationId,
          effect: descriptor.effect,
          risk: descriptor.risk,
          approval: descriptor.approvalRequired,
          sensitivity: [...descriptor.sensitivityTags].sort(),
          defaultDisabled: descriptor.defaultDisabled ?? false,
          namedTool: descriptor.namedTool ?? null,
          permission: descriptor.permission,
          documentationUrl: descriptor.documentationUrl,
        },
        op.vendorOperationId,
      ).toEqual({
        operationId,
        effect,
        risk,
        approval,
        sensitivity: [...sensitivity].sort(),
        defaultDisabled,
        namedTool,
        permission: `network.${descriptor.category}.${effect}`,
        documentationUrl: op.documentationUrl,
      });
    }
  });

  it('documents every implemented operation in docs/applications-network.md', async () => {
    const manual = await readFile(
      join(import.meta.dirname, '../../docs/applications-network.md'),
      'utf8',
    );
    for (const descriptor of NETWORK_OPERATIONS) {
      expect(manual, descriptor.operationId).toContain(`\`${descriptor.operationId}\``);
      if (descriptor.namedTool !== undefined) {
        expect(manual, descriptor.namedTool).toContain(`\`${descriptor.namedTool}\``);
      }
    }
  });

  it('never tags an operation with the non-grantable credential tag', () => {
    for (const descriptor of NETWORK_OPERATIONS) {
      expect(descriptor.sensitivityTags, descriptor.operationId).not.toContain('credential');
    }
  });
});
