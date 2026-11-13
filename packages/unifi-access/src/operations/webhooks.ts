/**
 * Webhook endpoints: reads (reviewed 2026-11-13, ADR 0023 §3). Each endpoint's signing
 * `secret` and forwarded `headers` are removed (credentials.ts).
 */
import { accessOperation } from '../define.ts';

export const listWebhookEndpoints = accessOperation('GET /api/v1/developer/webhooks/endpoints', {
  operationId: 'access.webhooks.list_endpoints',
  category: 'webhooks',
  effect: 'read',
  description: 'Webhook endpoints: name, receiver URL and subscribed events (secrets removed).',
});
