/** ACL rules (reviewed 2026-11-10 against 11.0.97). */
import { networkOperation, PAGED, siteLock } from '../define.ts';

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

// Writes: ACL rules decide what traffic is allowed (spec §6.3 high). All ACL writes of a
// site share one lock, because they interact through the rule order.
const ACL_LOCK = siteLock('acl');

export const createAclRule = networkOperation('createAclRule', {
  operationId: 'network.acl.create',
  category: 'acl',
  effect: 'write',
  risk: 'high',
  approvalRequired: true,
  retryClass: 'non-idempotent',
  resourceLockKey: ACL_LOCK,
  description: 'Create an ACL rule (IP or MAC based). Needs human approval.',
});

export const updateAclRule = networkOperation('updateAclRule', {
  operationId: 'network.acl.update',
  category: 'acl',
  effect: 'write',
  risk: 'high',
  approvalRequired: true,
  retryClass: 'idempotent',
  resourceLockKey: ACL_LOCK,
  description: 'Replace an ACL rule. Needs human approval.',
});

export const deleteAclRule = networkOperation('deleteAclRule', {
  operationId: 'network.acl.delete',
  category: 'acl',
  effect: 'write',
  risk: 'high',
  approvalRequired: true,
  retryClass: 'idempotent',
  resourceLockKey: ACL_LOCK,
  description: 'Delete an ACL rule. Needs human approval.',
});

export const updateAclRuleOrdering = networkOperation('updateAclRuleOrdering', {
  operationId: 'network.acl.update_ordering',
  category: 'acl',
  effect: 'write',
  risk: 'high',
  approvalRequired: true,
  retryClass: 'idempotent',
  resourceLockKey: ACL_LOCK,
  description: 'Change the order in which ACL rules apply. Needs human approval.',
});
