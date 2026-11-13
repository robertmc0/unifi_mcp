/**
 * The reviewed module adapters (Phase 2+). One list for the service, the CLI and the
 * coverage tooling, so they cannot disagree about what is implemented.
 */
import type { EventStreamDescriptor, OperationDescriptor } from '@unifi-local-mcp/core';
import { ACCESS_CONTRACT_REVISION, ACCESS_OPERATIONS } from '@unifi-local-mcp/unifi-access';
import type { ModuleId, VersionProbeSpec } from '@unifi-local-mcp/unifi-api';
import {
  NETWORK_CONTRACT_REVISION,
  NETWORK_OPERATIONS,
  NETWORK_VERSION_PROBE,
} from '@unifi-local-mcp/unifi-network';
import {
  PROTECT_CONTRACT_REVISIONS,
  PROTECT_EVENT_STREAMS,
  PROTECT_OPERATIONS,
  PROTECT_VERSION_PROBE,
} from '@unifi-local-mcp/unifi-protect';

export interface ModuleAdapter {
  moduleId: ModuleId;
  /** The vendor contract revisions the operations were reviewed against (api-specs/). */
  contractRevisions: readonly string[];
  operations: readonly OperationDescriptor[];
  /** Documented event subscriptions (ADR 0020). */
  eventStreams: readonly EventStreamDescriptor[];
  /** How the version is learned; absent where an administrator declares it (ADR 0021 §5). */
  probe?: VersionProbeSpec;
}

export const ADAPTERS: readonly ModuleAdapter[] = [
  {
    moduleId: 'network',
    contractRevisions: [NETWORK_CONTRACT_REVISION],
    operations: NETWORK_OPERATIONS,
    // UniFi Network documents no local subscription (spec §11).
    eventStreams: [],
    probe: NETWORK_VERSION_PROBE,
  },
  {
    moduleId: 'protect',
    contractRevisions: PROTECT_CONTRACT_REVISIONS,
    operations: PROTECT_OPERATIONS,
    eventStreams: PROTECT_EVENT_STREAMS,
    probe: PROTECT_VERSION_PROBE,
  },
  {
    moduleId: 'access',
    contractRevisions: [ACCESS_CONTRACT_REVISION],
    operations: ACCESS_OPERATIONS,
    // The §11.1 notification WebSocket waits for its own decision (ADR 0022 §5).
    eventStreams: [],
    // Access documents no version read: its version is declared (ADR 0021 §5).
  },
];

export const ADAPTER_OPERATIONS: readonly OperationDescriptor[] = ADAPTERS.flatMap(
  (adapter) => adapter.operations,
);

export const ADAPTER_EVENT_STREAMS: readonly EventStreamDescriptor[] = ADAPTERS.flatMap(
  (adapter) => adapter.eventStreams,
);

export const ADAPTER_PROBES: readonly VersionProbeSpec[] = ADAPTERS.flatMap((adapter) =>
  adapter.probe === undefined ? [] : [adapter.probe],
);
