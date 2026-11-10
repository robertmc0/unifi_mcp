/** DNS policies (reviewed 2026-11-10 against 11.0.97). */
import { networkOperation, PAGED, siteLock } from '../define.ts';

export const listDnsPolicies = networkOperation('getDnsPolicyPage', {
  operationId: 'network.dns.list',
  category: 'dns',
  effect: 'read',
  description:
    'DNS policies of a site: local records (A, AAAA, CNAME, MX, TXT, SRV) and forwarding.',
  ...PAGED,
});

export const getDnsPolicy = networkOperation('getDnsPolicy', {
  operationId: 'network.dns.get',
  category: 'dns',
  effect: 'read',
  description: 'One DNS policy.',
});

// Writes: local DNS records can redirect any name for every client of the site, so they
// are treated as a security function (spec §6.3 high).
const DNS_LOCK = siteLock('dns');

export const createDnsPolicy = networkOperation('createDnsPolicy', {
  operationId: 'network.dns.create',
  category: 'dns',
  effect: 'write',
  risk: 'high',
  approvalRequired: true,
  retryClass: 'non-idempotent',
  resourceLockKey: DNS_LOCK,
  description: 'Create a DNS policy (a local record or forwarding). Needs human approval.',
});

export const updateDnsPolicy = networkOperation('updateDnsPolicy', {
  operationId: 'network.dns.update',
  category: 'dns',
  effect: 'write',
  risk: 'high',
  approvalRequired: true,
  retryClass: 'idempotent',
  resourceLockKey: DNS_LOCK,
  description: 'Replace a DNS policy. Needs human approval.',
});

export const deleteDnsPolicy = networkOperation('deleteDnsPolicy', {
  operationId: 'network.dns.delete',
  category: 'dns',
  effect: 'write',
  risk: 'high',
  approvalRequired: true,
  retryClass: 'idempotent',
  resourceLockKey: DNS_LOCK,
  description: 'Delete a DNS policy. Needs human approval.',
});
