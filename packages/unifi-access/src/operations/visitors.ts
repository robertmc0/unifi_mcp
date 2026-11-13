/**
 * Visitors: reads (reviewed 2026-11-13, ADR 0023 §3). Visitor records hold names, phone
 * numbers, e-mail addresses, companies and visit reasons (`personal_identifier`) and the
 * visitor's NFC cards, license plates and schedule (`biometric_or_access_identity`).
 */
import { accessOperation } from '../define.ts';
import { PERSON } from './users.ts';

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
