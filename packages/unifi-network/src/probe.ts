/**
 * How the service learns a console's Network application version (ADR 0018 §3): one
 * `GET /v1/info`, through the reviewed `network.info.get` operation.
 */
import type { VersionProbeSpec } from '@unifi-local-mcp/unifi-api';
import { NETWORK_VERSION_RANGE } from './define.ts';

export const NETWORK_VERSION_PROBE: VersionProbeSpec = {
  moduleId: 'network',
  operationId: 'network.info.get',
  supportedRange: NETWORK_VERSION_RANGE,
  version: (output) => {
    const version = (output as { applicationVersion?: unknown } | null)?.applicationVersion;
    return typeof version === 'string' ? version : undefined;
  },
};
