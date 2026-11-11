/**
 * The reviewed module adapters (Phase 2+). One list for the service, the CLI and the
 * coverage tooling, so they cannot disagree about what is implemented.
 */
import type { OperationDescriptor } from '@unifi-local-mcp/core';
import type { ModuleId, VersionProbeSpec } from '@unifi-local-mcp/unifi-api';
import {
  NETWORK_CONTRACT_REVISION,
  NETWORK_OPERATIONS,
  NETWORK_VERSION_PROBE,
} from '@unifi-local-mcp/unifi-network';
import {
  PROTECT_CONTRACT_REVISION,
  PROTECT_OPERATIONS,
  PROTECT_VERSION_PROBE,
} from '@unifi-local-mcp/unifi-protect';

export interface ModuleAdapter {
  moduleId: ModuleId;
  /** The vendor contract revision the operations were reviewed against (api-specs/). */
  contractRevision: string;
  operations: readonly OperationDescriptor[];
  probe: VersionProbeSpec;
}

export const ADAPTERS: readonly ModuleAdapter[] = [
  {
    moduleId: 'network',
    contractRevision: NETWORK_CONTRACT_REVISION,
    operations: NETWORK_OPERATIONS,
    probe: NETWORK_VERSION_PROBE,
  },
  {
    moduleId: 'protect',
    contractRevision: PROTECT_CONTRACT_REVISION,
    operations: PROTECT_OPERATIONS,
    probe: PROTECT_VERSION_PROBE,
  },
];

export const ADAPTER_OPERATIONS: readonly OperationDescriptor[] = ADAPTERS.flatMap(
  (adapter) => adapter.operations,
);

export const ADAPTER_PROBES: readonly VersionProbeSpec[] = ADAPTERS.map((adapter) => adapter.probe);
