/**
 * The Access API server (reviewed 2026-11-14, ADR 0023 §4). Uploading a certificate (§12.1)
 * is not generated (ADR 0022 §5).
 *
 * Deleting the uploaded certificate returns the API server to a self-generated one. This
 * service pins the Access certificate (ADR 0023 §1), so afterwards it can no longer reach
 * Access until an administrator pins the new certificate, and the service cannot undo it.
 * High risk with human approval, and off by default.
 */
import { accessOperation, consoleLock, HIGH } from '../define.ts';

export const deleteApiServerCertificate = accessOperation(
  'DELETE /api/v1/developer/api_server/certificates',
  {
    ...HIGH,
    operationId: 'access.api_server.delete_certificate',
    category: 'api_server',
    description:
      "Remove the Access API server's uploaded HTTPS certificate, returning it to a self-generated one. Off by default.",
    retryClass: 'idempotent',
    resourceLockKey: consoleLock('api_server'),
    defaultDisabled: true,
    approvalCaution:
      'If a certificate was uploaded, Access returns to a self-generated one: pin that for this console (console set-tls), or the service can no longer reach Access.',
  },
);
