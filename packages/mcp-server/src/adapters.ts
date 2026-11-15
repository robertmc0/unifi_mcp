/**
 * The reviewed module adapters (Phase 2+). One list for the service, the CLI and the
 * coverage tooling, so they cannot disagree about what is implemented.
 */
import {
  satisfies,
  type EventStreamDescriptor,
  type OperationDescriptor,
  type ReviewedOmission,
} from '@unifi-local-mcp/core';
import {
  ACCESS_CONTRACT_REVISION,
  ACCESS_EVENT_STREAMS,
  ACCESS_OMISSIONS,
  ACCESS_OPERATIONS,
} from '@unifi-local-mcp/unifi-access';
import type { ModuleId, VersionProbeSpec } from '@unifi-local-mcp/unifi-api';
import {
  NETWORK_CONTRACT_REVISION,
  NETWORK_OPERATIONS,
  NETWORK_VERSION_PROBE,
} from '@unifi-local-mcp/unifi-network';
import {
  PROTECT_CONTRACT_REVISIONS,
  PROTECT_EVENT_STREAMS,
  PROTECT_OMISSIONS,
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
  /** Documented operations not offered, by inventory key, with their reviewed reasons. */
  omissions: Readonly<Record<string, ReviewedOmission>>;
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
    omissions: {},
    probe: NETWORK_VERSION_PROBE,
  },
  {
    moduleId: 'protect',
    contractRevisions: PROTECT_CONTRACT_REVISIONS,
    operations: PROTECT_OPERATIONS,
    eventStreams: PROTECT_EVENT_STREAMS,
    omissions: PROTECT_OMISSIONS,
    probe: PROTECT_VERSION_PROBE,
  },
  {
    moduleId: 'access',
    contractRevisions: [ACCESS_CONTRACT_REVISION],
    operations: ACCESS_OPERATIONS,
    // The §11.1 notification WebSocket (ADR 0023 §6).
    eventStreams: ACCESS_EVENT_STREAMS,
    omissions: ACCESS_OMISSIONS,
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

/** What `implementsRevision` needs of a registered operation or event stream. */
export interface Implementation {
  moduleId: string;
  httpMethod: string;
  pathTemplate: string;
  contractRevision: string;
  apiVersionRange: string;
}

/**
 * Whether a registered operation (or event stream, as a GET) implements the documented
 * operation `method path` of `module` in contract `revision`: same module, method and path,
 * and built from that revision or from an older one whose verified version range includes
 * it (ADR 0019 §7). Access revisions are dates, not versions, so only the first applies.
 * The CLI and the coverage report use this one rule.
 */
export function implementsRevision(
  implementation: Implementation,
  module: string,
  revision: string,
  method: string,
  path: string,
): boolean {
  if (
    implementation.moduleId !== module ||
    implementation.httpMethod !== method ||
    implementation.pathTemplate !== path
  ) {
    return false;
  }
  if (implementation.contractRevision === revision) return true;
  return /^\d+\.\d+\.\d+$/.test(revision) && satisfies(revision, implementation.apiVersionRange);
}
