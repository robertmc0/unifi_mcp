/**
 * Wi-Fi broadcasts (reviewed 2026-11-10 against 11.0.97). Pre-shared keys (`passphrase`)
 * are removed from every result (credentials.ts).
 */
import { networkOperation, PAGED, siteLock } from '../define.ts';

export const listWifiBroadcasts = networkOperation('getWifiBroadcastPage', {
  operationId: 'network.wifi.list',
  category: 'wifi',
  effect: 'read',
  description: 'Wi-Fi broadcasts (SSIDs) of a site: name, network, security type and bands.',
  ...PAGED,
});

export const getWifiBroadcast = networkOperation('getWifiBroadcastDetails', {
  operationId: 'network.wifi.get',
  category: 'wifi',
  effect: 'read',
  description: 'One Wi-Fi broadcast in detail. Passphrases are never returned.',
});

// Writes: Wi-Fi broadcasts include their security settings (spec §6.3 high). A passphrase
// sent in a request is redacted from logs, the audit trail and approval summaries.
const WIFI_LOCK = siteLock('wifi');

export const createWifiBroadcast = networkOperation('createWifiBroadcast', {
  operationId: 'network.wifi.create',
  category: 'wifi',
  effect: 'write',
  risk: 'high',
  approvalRequired: true,
  retryClass: 'non-idempotent',
  resourceLockKey: WIFI_LOCK,
  description: 'Create a Wi-Fi broadcast (SSID) with its security settings. Needs human approval.',
});

export const updateWifiBroadcast = networkOperation('updateWifiBroadcast', {
  operationId: 'network.wifi.update',
  category: 'wifi',
  effect: 'write',
  risk: 'high',
  approvalRequired: true,
  retryClass: 'idempotent',
  resourceLockKey: WIFI_LOCK,
  description: 'Replace a Wi-Fi broadcast, including its security settings. Needs human approval.',
});

export const deleteWifiBroadcast = networkOperation('deleteWifiBroadcast', {
  operationId: 'network.wifi.delete',
  category: 'wifi',
  effect: 'write',
  risk: 'high',
  approvalRequired: true,
  retryClass: 'idempotent',
  resourceLockKey: WIFI_LOCK,
  description:
    'Delete a Wi-Fi broadcast; `force` deletes it even while referenced. Needs human approval.',
});
