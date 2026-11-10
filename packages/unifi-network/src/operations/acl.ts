/** ACL rules (reviewed 2026-11-10 against 11.0.97). */
import { networkOperation, PAGED } from '../define.ts';

export const listAclRules = networkOperation('getAclRulePage', {
  operationId: 'network.acl.list',
  category: 'acl',
  effect: 'read',
  description: 'ACL rules of a site (IP or MAC based): action, filters and order.',
  ...PAGED,
});

export const getAclRule = networkOperation('getAclRule', {
  operationId: 'network.acl.get',
  category: 'acl',
  effect: 'read',
  description: 'One ACL rule in detail.',
});

export const getAclRuleOrdering = networkOperation('getAclRuleOrdering', {
  operationId: 'network.acl.get_ordering',
  category: 'acl',
  effect: 'read',
  description: 'The order in which the ACL rules of a site are applied.',
});
