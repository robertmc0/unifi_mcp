/**
 * Documented Protect operations that are not offered, each with its reviewed reason
 * (ADR 0019 §2, ADR 0020 §6). Decisions made in code; the coverage report shows them with
 * their reasons. Keys are inventory keys.
 */
import type { ReviewedOmission } from '@unifi-local-mcp/core';

export const PROTECT_OMISSIONS: Readonly<Record<string, ReviewedOmission>> = {
  'POST /v1/files/{fileType}': {
    decision: 'deferred',
    reason:
      'A multipart upload whose form field the contract does not name (ADR 0019 §2); offered once the contract names it.',
  },
  'GET /v1/subscribe/updates': {
    decision: 'deferred',
    reason:
      'Documented only for 7.4.96, newer than the official release, with message forms that overlap; reviewed when an official release documents it (ADR 0020 §6).',
  },
};
