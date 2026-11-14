/**
 * NFC cards, card enrollment and Touch Passes (reviewed against the transcription: reads
 * 2026-11-13, ADR 0023 §3; writes 2026-11-14, ADR 0023 §4). Card and pass records name
 * their holder (`personal_identifier`) and identify the credential that opens doors
 * (`biometric_or_access_identity`). The PIN generator (§6.1) is not offered: its result is
 * a PIN, a credential (spec §6.4).
 *
 * Writes: enrolling a card puts a reader into enrollment and can reset a UniFi card, and
 * deleting a card or changing a Touch Pass's status changes who gets in: high risk with
 * human approval. Buying Touch Passes spends money and is off by default. Renaming a card
 * and ending an enrollment session change nobody's access: medium.
 */
import type { SensitivityTag } from '@unifi-local-mcp/policy';
import { accessOperation, consoleLock, HIGH, MEDIUM, objectLock } from '../define.ts';
import { PERSON } from './users.ts';

const CARD: readonly SensitivityTag[] = ['biometric_or_access_identity'];

export const getNfcEnrollment = accessOperation(
  'GET /api/v1/developer/credentials/nfc_cards/sessions/{id}',
  {
    operationId: 'access.credentials.get_nfc_enrollment',
    category: 'credentials',
    effect: 'read',
    description: 'The state of an NFC card enrollment session: the enrolled card, once read.',
    sensitivityTags: CARD,
  },
);

export const getNfcCard = accessOperation(
  'GET /api/v1/developer/credentials/nfc_cards/tokens/{token}',
  {
    operationId: 'access.credentials.get_nfc_card',
    category: 'credentials',
    effect: 'read',
    description: 'One NFC card: its display ID, status, alias and holder.',
    sensitivityTags: PERSON,
  },
);

export const listNfcCards = accessOperation('GET /api/v1/developer/credentials/nfc_cards/tokens', {
  operationId: 'access.credentials.list_nfc_cards',
  category: 'credentials',
  effect: 'read',
  description: 'NFC cards, a page at a time, with their holders.',
  sensitivityTags: PERSON,
});

export const listTouchPasses = accessOperation('GET /api/v1/developer/credentials/touch_passes', {
  operationId: 'access.credentials.list_touch_passes',
  category: 'credentials',
  effect: 'read',
  description: 'Touch Passes (mobile credentials), a page at a time, optionally by status.',
  sensitivityTags: PERSON,
});

export const searchTouchPasses = accessOperation(
  'GET /api/v1/developer/credentials/touch_passes/search',
  {
    operationId: 'access.credentials.search_touch_passes',
    category: 'credentials',
    effect: 'read',
    description: 'Touch Passes matching a card ID or holder name.',
    sensitivityTags: PERSON,
  },
);

export const listAssignableTouchPasses = accessOperation(
  'GET /api/v1/developer/credentials/touch_passes/assignable',
  {
    operationId: 'access.credentials.list_assignable_touch_passes',
    category: 'credentials',
    effect: 'read',
    description: 'Suspended or inactive Touch Passes that can be assigned to a user.',
    sensitivityTags: PERSON,
  },
);

export const getTouchPass = accessOperation('GET /api/v1/developer/credentials/touch_passes/{id}', {
  operationId: 'access.credentials.get_touch_pass',
  category: 'credentials',
  effect: 'read',
  description: 'One Touch Pass: status, holder and the phones it is installed on.',
  sensitivityTags: PERSON,
});

// Writes (reviewed 2026-11-14, ADR 0023 §4).

const NFC_CARD = objectLock('nfc_cards', 'token');

export const startNfcEnrollment = accessOperation(
  'POST /api/v1/developer/credentials/nfc_cards/sessions',
  {
    ...HIGH,
    operationId: 'access.credentials.start_nfc_enrollment',
    category: 'credentials',
    description:
      'Put a reader into NFC card enrollment; returns the session to read the enrolled card from.',
    sensitivityTags: CARD,
    retryClass: 'non-idempotent',
    resourceLockKey: (args, target) =>
      `console:${target.consoleId}/access/devices/${args.body.device_id}`,
    approvalCaution:
      'The reader enrolls the next card held to it; with reset_ua_card, a UniFi card is reset first.',
  },
);

export const cancelNfcEnrollment = accessOperation(
  'DELETE /api/v1/developer/credentials/nfc_cards/sessions/{id}',
  {
    ...MEDIUM,
    operationId: 'access.credentials.cancel_nfc_enrollment',
    category: 'credentials',
    description: 'End an NFC card enrollment session.',
    retryClass: 'idempotent',
    resourceLockKey: objectLock('nfc_sessions', 'id'),
  },
);

export const updateNfcCard = accessOperation(
  'PUT /api/v1/developer/credentials/nfc_cards/tokens/{token}',
  {
    ...MEDIUM,
    operationId: 'access.credentials.update_nfc_card',
    category: 'credentials',
    description: "Change an NFC card's alias.",
    sensitivityTags: CARD,
    retryClass: 'idempotent',
    resourceLockKey: NFC_CARD,
  },
);

export const deleteNfcCard = accessOperation(
  'DELETE /api/v1/developer/credentials/nfc_cards/tokens/{token}',
  {
    ...HIGH,
    operationId: 'access.credentials.delete_nfc_card',
    category: 'credentials',
    description: 'Delete an NFC card; it no longer opens any door.',
    sensitivityTags: CARD,
    retryClass: 'idempotent',
    resourceLockKey: NFC_CARD,
  },
);

export const purchaseTouchPasses = accessOperation(
  'POST /api/v1/developer/credentials/touch_passes',
  {
    ...HIGH,
    operationId: 'access.credentials.purchase_touch_passes',
    category: 'credentials',
    description: 'Buy Touch Passes. Off by default: it spends money.',
    sensitivityTags: PERSON,
    retryClass: 'non-idempotent',
    resourceLockKey: consoleLock('touch_passes'),
    defaultDisabled: true,
    approvalCaution: 'Purchasing charges the payment method configured in Access.',
  },
);

export const updateTouchPass = accessOperation(
  'PUT /api/v1/developer/credentials/touch_passes/{id}',
  {
    ...HIGH,
    operationId: 'access.credentials.update_touch_pass',
    category: 'credentials',
    description: 'Rename a Touch Pass, suspend or reactivate it, or disable its bundles.',
    sensitivityTags: PERSON,
    retryClass: 'idempotent',
    resourceLockKey: objectLock('touch_passes', 'id'),
  },
);
