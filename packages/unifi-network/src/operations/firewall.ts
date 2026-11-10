/** Firewall policies and zones (reviewed 2026-11-10 against 11.0.97). */
import { networkOperation, PAGED } from '../define.ts';

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
