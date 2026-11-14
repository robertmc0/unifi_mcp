/**
 * Visitors (reviewed against the transcription: reads 2026-11-13, ADR 0023 §3; writes
 * 2026-11-14, ADR 0023 §4). Visitor records hold names, phone numbers, e-mail addresses,
 * companies and visit reasons (`personal_identifier`) and the visitor's NFC cards, license
 * plates and schedule (`biometric_or_access_identity`).
 *
 * Every visitor write is high risk with human approval: a visitor record names the doors
 * and times of a visit, and the credentials grant entry. Setting a PIN is off by default,
 * as for users.
 */
import { accessOperation, consoleLock, HIGH, objectLock } from '../define.ts';
import { PERSON, PIN_CAUTION } from './users.ts';

export const getVisitor = accessOperation('GET /api/v1/developer/visitors/{id}', {
  operationId: 'access.visitors.get',
  category: 'visitors',
  effect: 'read',
  description:
    'One visitor: contact details, visit time and reason, locations, schedule and cards.',
  sensitivityTags: PERSON,
});

export const listVisitors = accessOperation('GET /api/v1/developer/visitors', {
  operationId: 'access.visitors.list',
  category: 'visitors',
  effect: 'read',
  description: 'Visitors, a page at a time, optionally by status or name prefix.',
  sensitivityTags: PERSON,
});

// Writes (reviewed 2026-11-14, ADR 0023 §4).

const VISITOR = objectLock('visitors', 'id');
const CARD = ['biometric_or_access_identity'] as const;

export const createVisitor = accessOperation('POST /api/v1/developer/visitors', {
  ...HIGH,
  operationId: 'access.visitors.create',
  category: 'visitors',
  description:
    'Register a visitor: who, why, the visit window, and the doors and weekly times they may use.',
  sensitivityTags: PERSON,
  retryClass: 'non-idempotent',
  resourceLockKey: consoleLock('visitors'),
});

export const updateVisitor = accessOperation('PUT /api/v1/developer/visitors/{id}', {
  ...HIGH,
  operationId: 'access.visitors.update',
  category: 'visitors',
  description: "Change a visitor's details, visit window, doors or weekly times.",
  sensitivityTags: ['personal_identifier'],
  retryClass: 'idempotent',
  resourceLockKey: VISITOR,
});

export const deleteVisitor = accessOperation('DELETE /api/v1/developer/visitors/{id}', {
  ...HIGH,
  operationId: 'access.visitors.delete',
  category: 'visitors',
  description: 'Delete a visitor.',
  retryClass: 'idempotent',
  resourceLockKey: VISITOR,
  approvalCaution: 'The visitor and their credentials are removed; this cannot be undone.',
});

export const assignVisitorNfcCard = accessOperation(
  'PUT /api/v1/developer/visitors/{id}/nfc_cards',
  {
    ...HIGH,
    operationId: 'access.visitors.assign_nfc_card',
    category: 'visitors',
    description: 'Assign an enrolled NFC card to a visitor.',
    sensitivityTags: CARD,
    retryClass: 'idempotent',
    resourceLockKey: VISITOR,
    approvalCaution:
      'With force_add, a card that belongs to someone else is moved to this visitor.',
  },
);

export const unassignVisitorNfcCard = accessOperation(
  'PUT /api/v1/developer/visitors/{id}/nfc_cards/delete',
  {
    ...HIGH,
    operationId: 'access.visitors.unassign_nfc_card',
    category: 'visitors',
    description: 'Remove an NFC card from a visitor.',
    sensitivityTags: CARD,
    retryClass: 'idempotent',
    resourceLockKey: VISITOR,
  },
);

export const assignVisitorPin = accessOperation('PUT /api/v1/developer/visitors/{id}/pin_codes', {
  ...HIGH,
  operationId: 'access.visitors.assign_pin',
  category: 'visitors',
  description: "Set a visitor's PIN code. Off by default.",
  sensitivityTags: CARD,
  retryClass: 'idempotent',
  resourceLockKey: VISITOR,
  defaultDisabled: true,
  approvalCaution: PIN_CAUTION,
});

export const unassignVisitorPin = accessOperation(
  'DELETE /api/v1/developer/visitors/{id}/pin_codes',
  {
    ...HIGH,
    operationId: 'access.visitors.unassign_pin',
    category: 'visitors',
    description: "Remove a visitor's PIN code.",
    sensitivityTags: CARD,
    retryClass: 'idempotent',
    resourceLockKey: VISITOR,
  },
);

export const assignVisitorQrCode = accessOperation('PUT /api/v1/developer/visitors/{id}/qr_codes', {
  ...HIGH,
  operationId: 'access.visitors.assign_qr_code',
  category: 'visitors',
  description: 'Give a visitor a QR code credential. The code itself is not returned.',
  sensitivityTags: CARD,
  retryClass: 'non-idempotent',
  resourceLockKey: VISITOR,
});

export const unassignVisitorQrCode = accessOperation(
  'DELETE /api/v1/developer/visitors/{id}/qr_codes',
  {
    ...HIGH,
    operationId: 'access.visitors.unassign_qr_code',
    category: 'visitors',
    description: "Remove a visitor's QR code credential.",
    sensitivityTags: CARD,
    retryClass: 'idempotent',
    resourceLockKey: VISITOR,
  },
);

export const unassignVisitorLicensePlate = accessOperation(
  'DELETE /api/v1/developer/visitors/{visitor_id}/license_plates/{license_plate_id}',
  {
    ...HIGH,
    operationId: 'access.visitors.unassign_license_plate',
    category: 'visitors',
    description: 'Remove one license plate number from a visitor.',
    sensitivityTags: CARD,
    retryClass: 'idempotent',
    resourceLockKey: objectLock('visitors', 'visitor_id'),
  },
);
