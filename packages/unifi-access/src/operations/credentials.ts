/**
 * NFC cards, card enrollment and Touch Passes: reads (reviewed 2026-11-13, ADR 0023 §3).
 * Card and pass records name their holder (`personal_identifier`) and identify the
 * credential that opens doors (`biometric_or_access_identity`). The PIN generator (§6.1)
 * is not offered: its result is a PIN, a credential (spec §6.4).
 */
import type { SensitivityTag } from '@unifi-local-mcp/policy';
import { accessOperation } from '../define.ts';
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
