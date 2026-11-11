/**
 * Viewers and live views (reviewed 2026-11-11 against 7.4.96). Reads: low risk.
 */
import { consoleLock, deviceLock, protectOperation } from '../define.ts';

export const listViewers = protectOperation('GET /v1/viewers', {
  operationId: 'protect.viewers.list',
  category: 'viewers',
  effect: 'read',
  description: 'Viewers (display devices) and the live view each shows.',
});

export const getViewer = protectOperation('GET /v1/viewers/{id}', {
  operationId: 'protect.viewers.get',
  category: 'viewers',
  effect: 'read',
  description: 'One viewer.',
});

export const listLiveviews = protectOperation('GET /v1/liveviews', {
  operationId: 'protect.liveviews.list',
  category: 'liveviews',
  effect: 'read',
  description: 'Live views: camera layouts and their slots.',
});

export const getLiveview = protectOperation('GET /v1/liveviews/{id}', {
  operationId: 'protect.liveviews.get',
  category: 'liveviews',
  effect: 'read',
  description: 'One live view.',
});

// Writes (ADR 0019 §6): what viewers display; medium.
export const updateViewer = protectOperation('PATCH /v1/viewers/{id}', {
  operationId: 'protect.viewers.update',
  category: 'viewers',
  effect: 'write',
  description: 'Change a viewer (for example which live view it shows).',
  risk: 'medium',
  approvalRequired: false,
  retryClass: 'idempotent',
  resourceLockKey: deviceLock('viewers'),
});

export const createLiveview = protectOperation('POST /v1/liveviews', {
  operationId: 'protect.liveviews.create',
  category: 'liveviews',
  effect: 'write',
  description: 'Create a live view (a camera layout).',
  risk: 'medium',
  approvalRequired: false,
  retryClass: 'non-idempotent',
  resourceLockKey: consoleLock('liveviews'),
});

export const updateLiveview = protectOperation('PATCH /v1/liveviews/{id}', {
  operationId: 'protect.liveviews.update',
  category: 'liveviews',
  effect: 'write',
  description: 'Change a live view.',
  risk: 'medium',
  approvalRequired: false,
  retryClass: 'idempotent',
  resourceLockKey: deviceLock('liveviews'),
});
