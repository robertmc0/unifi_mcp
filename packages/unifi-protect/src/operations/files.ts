/**
 * Device asset files (reviewed 2026-11-11 against 7.4.96). The list is a low-risk read.
 * The upload is not implemented: its form field is undocumented (ADR 0019 §2).
 */
import { protectOperation } from '../define.ts';

export const listFiles = protectOperation('GET /v1/files/{fileType}', {
  operationId: 'protect.files.list',
  category: 'files',
  effect: 'read',
  description: 'Device asset files of one type (the contract documents `animations`).',
});
