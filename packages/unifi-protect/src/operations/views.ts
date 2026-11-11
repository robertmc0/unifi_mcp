/**
 * Viewers and live views (reviewed 2026-11-11 against 7.4.96). Reads: low risk.
 */
import { protectOperation } from '../define.ts';

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
