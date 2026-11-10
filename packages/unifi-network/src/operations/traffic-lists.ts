/** Traffic matching lists, used by firewall policies (reviewed 2026-11-10). */
import { networkOperation, PAGED } from '../define.ts';

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
