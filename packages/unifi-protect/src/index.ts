/**
 * @unifi-local-mcp/unifi-protect
 *
 * The official local UniFi Protect integration API adapter (ADR 0019): generated request
 * and response schemas for contract revision 7.4.96, and the hand-reviewed security
 * metadata of every implemented operation. Only operations recorded in
 * `api-specs/protect/7.4.96/` can be implemented here.
 */
import type { OperationDescriptor } from '@unifi-local-mcp/core';
import { getInfo } from './operations/info.ts';

export { ALWAYS_REMOVED, withoutCredentials } from './credentials.ts';
export {
  consoleLock,
  documentationUrl,
  PROTECT_CONTRACT_REVISION,
  PROTECT_VERSION_RANGE,
  protectOperation,
  type VendorKey,
} from './define.ts';
export { PROTECT_VERSION_PROBE } from './probe.ts';

/** The documented Protect reads implemented so far (ADR 0019). */
export const PROTECT_READS: readonly OperationDescriptor[] = [getInfo];

/** The documented Protect writes implemented so far (ADR 0019). */
export const PROTECT_WRITES: readonly OperationDescriptor[] = [];

/** Every implemented Protect operation, registered by the service at startup. */
export const PROTECT_OPERATIONS: readonly OperationDescriptor[] = [
  ...PROTECT_READS,
  ...PROTECT_WRITES,
];
