/**
 * Webhook endpoints (reviewed against the transcription: reads 2026-11-13, ADR 0023 §3;
 * writes 2026-11-14, ADR 0023 §4). Each endpoint's signing `secret` and forwarded
 * `headers` are removed from every result (credentials.ts).
 *
 * Adding an endpoint or changing its address makes the console send the chosen events,
 * which can include who opened which door, to any address, outside this service's egress
 * controls. Both are high risk with human approval and off by default. Deleting an
 * endpoint can silence another system's monitoring: high risk.
 */
import { accessOperation, consoleLock, HIGH, objectLock } from '../define.ts';

export const listWebhookEndpoints = accessOperation('GET /api/v1/developer/webhooks/endpoints', {
  operationId: 'access.webhooks.list_endpoints',
  category: 'webhooks',
  effect: 'read',
  description: 'Webhook endpoints: name, receiver URL and subscribed events (secrets removed).',
});

// Writes (reviewed 2026-11-14, ADR 0023 §4).

const ENDPOINT = objectLock('webhooks', 'id');
const EGRESS_CAUTION =
  "The console will send the chosen events, which can include who opened which door, to this address, outside this service's egress controls.";

export const createWebhookEndpoint = accessOperation('POST /api/v1/developer/webhooks/endpoints', {
  ...HIGH,
  operationId: 'access.webhooks.create_endpoint',
  category: 'webhooks',
  description: 'Add a webhook endpoint: a receiver URL and the events sent to it. Off by default.',
  retryClass: 'non-idempotent',
  resourceLockKey: consoleLock('webhooks'),
  defaultDisabled: true,
  approvalCaution: EGRESS_CAUTION,
});

export const updateWebhookEndpoint = accessOperation(
  'PUT /api/v1/developer/webhooks/endpoints/{id}',
  {
    ...HIGH,
    operationId: 'access.webhooks.update_endpoint',
    category: 'webhooks',
    description: "Change a webhook endpoint's receiver URL, name or events. Off by default.",
    retryClass: 'idempotent',
    resourceLockKey: ENDPOINT,
    defaultDisabled: true,
    approvalCaution: EGRESS_CAUTION,
  },
);

export const deleteWebhookEndpoint = accessOperation(
  'DELETE /api/v1/developer/webhooks/endpoints/{id}',
  {
    ...HIGH,
    operationId: 'access.webhooks.delete_endpoint',
    category: 'webhooks',
    description: 'Delete a webhook endpoint; its receiver gets no more events.',
    retryClass: 'idempotent',
    resourceLockKey: ENDPOINT,
  },
);
