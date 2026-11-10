/**
 * Hotspot vouchers (reviewed 2026-11-10 against 11.0.97). A voucher's `code` grants guest
 * access, so it is a credential and is never returned (credentials.ts).
 */
import { networkOperation, PAGED, siteLock } from '../define.ts';

export const VOUCHER_CREDENTIALS = ['code'] as const;

export const listVouchers = networkOperation('getVouchers', {
  operationId: 'network.hotspot.list_vouchers',
  category: 'hotspot',
  effect: 'read',
  description:
    'Hotspot vouchers of a site: limits, usage and expiry. Voucher codes are never returned.',
  credentialFields: VOUCHER_CREDENTIALS,
  ...PAGED,
});

export const getVoucher = networkOperation('getVoucher', {
  operationId: 'network.hotspot.get_voucher',
  category: 'hotspot',
  effect: 'read',
  description: 'One hotspot voucher. The voucher code is never returned.',
  credentialFields: VOUCHER_CREDENTIALS,
});

// Writes: vouchers grant guest access with limits (medium). Deleting by filter can delete
// every voucher of the site at once, so it is high and disabled by default. The codes of
// new vouchers are not returned either: they are shown in UniFi Network.
const VOUCHERS_LOCK = siteLock('vouchers');

export const createVouchers = networkOperation('createVouchers', {
  operationId: 'network.hotspot.create_vouchers',
  category: 'hotspot',
  effect: 'write',
  risk: 'medium',
  approvalRequired: false,
  retryClass: 'non-idempotent',
  resourceLockKey: VOUCHERS_LOCK,
  credentialFields: VOUCHER_CREDENTIALS,
  description:
    'Create hotspot vouchers with limits. Their codes are not returned; print them from UniFi Network.',
});

export const deleteVoucher = networkOperation('deleteVoucher', {
  operationId: 'network.hotspot.delete_voucher',
  category: 'hotspot',
  effect: 'write',
  risk: 'medium',
  approvalRequired: false,
  retryClass: 'idempotent',
  resourceLockKey: VOUCHERS_LOCK,
  description: 'Delete one hotspot voucher; guests using it lose access.',
});

export const deleteVouchers = networkOperation('deleteVouchers', {
  operationId: 'network.hotspot.delete_vouchers',
  category: 'hotspot',
  effect: 'write',
  risk: 'high',
  approvalRequired: true,
  defaultDisabled: true,
  retryClass: 'idempotent',
  resourceLockKey: VOUCHERS_LOCK,
  description:
    'Delete every voucher matching a filter (all of them without one). Disabled by default; needs human approval.',
});
