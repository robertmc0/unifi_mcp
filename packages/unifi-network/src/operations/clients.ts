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
