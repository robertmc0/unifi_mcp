/**
 * Wi-Fi broadcasts (reviewed 2026-11-10 against 11.0.97). Pre-shared keys (`passphrase`)
 * are removed from every result (credentials.ts).
 */
import { networkOperation, PAGED } from '../define.ts';

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
