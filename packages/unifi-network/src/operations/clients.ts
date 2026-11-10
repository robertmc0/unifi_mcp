/**
 * Connected clients (reviewed 2026-11-10 against 11.0.97). Client names usually identify
 * people ("Alice's phone") and MAC and IP addresses identify their devices, so these reads
 * need explicit sensitive grants (spec §6.4).
 */
import { networkOperation, PAGED } from '../define.ts';

const PEOPLE = ['personal_identifier', 'network_identity'] as const;

export const listClients = networkOperation('getConnectedClientOverviewPage', {
  operationId: 'network.clients.list',
  category: 'clients',
  effect: 'read',
  sensitivityTags: PEOPLE,
  description:
    'Clients connected to a site: name, type (wired, wireless, VPN), IP and MAC address, uplink.',
  namedTool: 'network_list_clients',
  ...PAGED,
});

export const getClient = networkOperation('getConnectedClientDetails', {
  operationId: 'network.clients.get',
  category: 'clients',
  effect: 'read',
  sensitivityTags: PEOPLE,
  description: 'One connected client in detail.',
});

// Writes: authorising or withdrawing guest access changes one client's association
// (spec §6.3 medium). It acts on a person's device, so it needs the same sensitive grants
// as the client reads.

export const runClientAction = networkOperation('executeConnectedClientAction', {
  operationId: 'network.clients.run_action',
  category: 'clients',
  effect: 'write',
  risk: 'medium',
  approvalRequired: false,
  sensitivityTags: PEOPLE,
  retryClass: 'non-idempotent',
  resourceLockKey: (args) => `client:${args.clientId}`,
  description:
    'Authorise or withdraw guest access for a connected client (AUTHORIZE_GUEST_ACCESS, UNAUTHORIZE_GUEST_ACCESS).',
});
