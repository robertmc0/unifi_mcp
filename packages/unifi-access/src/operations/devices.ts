/**
 * Access devices (reviewed against the transcription: reads 2026-11-13, ADR 0023 §3; the
 * doorbell 2026-11-14, ADR 0023 §4). Device names, types and the access methods a reader
 * accepts. No personal data.
 *
 * Ringing a doorbell is high risk with human approval: it acts in the physical world, and
 * whoever answers the call may open the door for the "visitor". Changing a reader's
 * access methods (§8.3) is not generated (ADR 0022).
 */
import { accessOperation, HIGH, objectLock } from '../define.ts';

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

export const ringDoorbell = accessOperation('POST /api/v1/developer/devices/{device_id}/doorbell', {
  ...HIGH,
  operationId: 'access.devices.ring_doorbell',
  category: 'devices',
  description: "Ring a reader's doorbell, naming a room, or cancel the ringing.",
  retryClass: 'non-idempotent',
  resourceLockKey: objectLock('devices', 'device_id'),
  approvalCaution:
    'The doorbell rings its receivers as if someone were at the door; whoever answers may open it.',
});
