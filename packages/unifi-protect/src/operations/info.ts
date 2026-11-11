/**
 * Application info (reviewed 2026-11-11 against 7.4.96). Also the version probe.
 */
import { protectOperation } from '../define.ts';

export const getInfo = protectOperation('GET /v1/meta/info', {
  operationId: 'protect.info.get',
  category: 'info',
  effect: 'read',
  description: 'The UniFi Protect application version on the console.',
});
