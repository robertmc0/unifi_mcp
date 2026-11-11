/**
 * How the service learns a console's Protect application version (ADR 0019 §4): one
 * `GET /v1/meta/info`, through the reviewed `protect.info.get` operation.
 */
import type { VersionProbeSpec } from '@unifi-local-mcp/unifi-api';
import { PROTECT_VERSION_RANGE } from './define.ts';

export const PROTECT_VERSION_PROBE: VersionProbeSpec = {
  moduleId: 'protect',
  operationId: 'protect.info.get',
  supportedRange: PROTECT_VERSION_RANGE,
  version: (output) => {
    const version = (output as { applicationVersion?: unknown } | null)?.applicationVersion;
    return typeof version === 'string' ? version : undefined;
  },
};
