/**
 * Access devices: reads (reviewed 2026-11-13, ADR 0023 §3). Device names, types and the
 * access methods a reader accepts. No personal data.
 */
import { accessOperation } from '../define.ts';

export const listDevices = accessOperation('GET /api/v1/developer/devices', {
  operationId: 'access.devices.list',
  category: 'devices',
  effect: 'read',
  description: 'Access devices (hubs, readers, intercoms) with their IDs, names and types.',
});

export const getDeviceAccessMethods = accessOperation(
  'GET /api/v1/developer/devices/{device_id}/settings',
  {
    operationId: 'access.devices.get_access_methods',
    category: 'devices',
    effect: 'read',
    description:
      'The access methods one reader accepts (NFC, PIN, mobile, face, QR code, Touch Pass).',
  },
);
