/** DNS policies (reviewed 2026-11-10 against 11.0.97). */
import { networkOperation, PAGED } from '../define.ts';

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
