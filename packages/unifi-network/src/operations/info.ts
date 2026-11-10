/**
 * Application info (reviewed 2026-11-10 against 11.0.97). Also the version probe.
 */
import { networkOperation } from '../define.ts';

export const getInfo = networkOperation('getInfo', {
  operationId: 'network.info.get',
  category: 'info',
  effect: 'read',
  description: 'The UniFi Network application version on the console.',
});
