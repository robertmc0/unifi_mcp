/**
 * @unifi-local-mcp/unifi-network
 *
 * The official local UniFi Network Integration API adapter (ADR 0018): generated request
 * and response schemas for contract revision 11.0.97, and the hand-reviewed security
 * metadata of every implemented operation. Only operations recorded in
 * `api-specs/network/11.0.97/` can be implemented here.
 */
import type { OperationDescriptor } from '@unifi-local-mcp/core';
import { getInfo } from './operations/info.ts';

export {
  NETWORK_CONTRACT_REVISION,
  NETWORK_VERSION_RANGE,
  networkOperation,
  type VendorOperationId,
} from './define.ts';
export { NETWORK_VERSION_PROBE } from './probe.ts';

/** Every implemented Network operation, registered by the service at startup. */
export const NETWORK_OPERATIONS: readonly OperationDescriptor[] = [getInfo];
