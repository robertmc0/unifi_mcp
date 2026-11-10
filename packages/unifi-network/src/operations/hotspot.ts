/**
 * Hotspot vouchers (reviewed 2026-11-10 against 11.0.97). A voucher's `code` grants guest
 * access, so it is a credential and is never returned (credentials.ts).
 */
import { networkOperation, PAGED } from '../define.ts';

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
