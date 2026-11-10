/**
 * Builds a Network operation descriptor from two separate sources (spec §4.3, ADR 0018):
 *
 * - the **generated contract facts** of one vendor operation (method, path, query names,
 *   body placement, input and output schemas), from `generated/network-11.0.97.ts`;
 * - the **hand-reviewed security metadata** passed in `review` (operation id, category,
 *   effect, risk, sensitivity, approval, lock key, retry class, projection).
 *
 * Nothing in `review` is derived from the vendor document, and regenerating the schemas
 * cannot change it.
 */
import { defineOperation, type OperationDescriptor, type Target } from '@unifi-local-mcp/core';
import type { Risk, SensitivityTag } from '@unifi-local-mcp/policy';
import type * as z from 'zod';
import { withoutCredentials } from './credentials.ts';
import { OPERATIONS } from './generated/network-11.0.97.ts';

/** The vendor contract revision every Network operation was reviewed against. */
export const NETWORK_CONTRACT_REVISION = '11.0.97';

/**
 * Network application versions the adapter accepts (ADR 0018 §3). The contract was
 * verified for 11.0.97. Later 11.x releases are accepted as compatible, because they keep
 * the `/v1` integration API. Anything else is refused with `operation_unsupported`.
 */
export const NETWORK_VERSION_RANGE = '>=11.0.97 <12';

type Generated = typeof OPERATIONS;
export type VendorOperationId = keyof Generated;
type In<K extends VendorOperationId> = Generated[K]['input'] extends z.ZodObject
  ? Generated[K]['input']
  : never;
type Out<K extends VendorOperationId> = Generated[K]['output'] extends z.ZodType
  ? Generated[K]['output']
  : never;

interface ReviewCommon<K extends VendorOperationId> {
  /** `network.<category>.<action>`. */
  operationId: string;
  category: string;
  /** Our own one- or two-sentence description; never vendor prose. */
  description: string;
  sensitivityTags?: readonly SensitivityTag[];
  namedTool?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  project?: (output: z.output<Out<K>>) => unknown;
  pagination?: (output: z.output<Out<K>>) => Readonly<Record<string, number>> | undefined;
  /** Fields of this operation's result that carry credentials, besides `passphrase`. */
  credentialFields?: readonly string[];
}

/** A lock shared by every write of one kind on one site (conflicting writes run in turn). */
export function siteLock(name: string): (args: unknown, target: Target) => string {
  return (_args, target) => `site:${target.siteId ?? ''}/${name}`;
}

/** The shape of every Network list response. */
export interface NetworkPage {
  offset: number;
  limit: number;
  count: number;
  totalCount: number;
  data: unknown[];
}

/** For list operations: the items become `data`, the paging facts `pagination`. */
export const PAGED = {
  project: (page: NetworkPage): unknown => page.data,
  pagination: ({ offset, limit, count, totalCount }: NetworkPage): Record<string, number> => ({
    offset,
    limit,
    count,
    totalCount,
    ...(offset + count < totalCount ? { nextOffset: offset + count } : {}),
  }),
} as const;

export interface ReadReview<K extends VendorOperationId> extends ReviewCommon<K> {
  effect: 'read';
}

export interface WriteReview<K extends VendorOperationId> extends ReviewCommon<K> {
  effect: 'write';
  risk: Risk;
  approvalRequired: boolean;
  retryClass: 'idempotent' | 'non-idempotent';
  resourceLockKey: (args: z.output<In<K>>, target: Target) => string;
  defaultDisabled?: boolean;
}

const READ_TIMEOUT_MS = 15_000;
const WRITE_TIMEOUT_MS = 30_000;

export function networkOperation<K extends VendorOperationId>(
  vendorOperationId: K,
  review: ReadReview<K> | WriteReview<K>,
): OperationDescriptor<In<K>, Out<K>> {
  const contract = OPERATIONS[vendorOperationId];
  const write = review.effect === 'write' ? review : undefined;
  return defineOperation<In<K>, Out<K>>({
    operationId: review.operationId,
    moduleId: 'network',
    category: review.category,
    effect: review.effect,
    permission: `network.${review.category}.${review.effect}`,
    risk: write?.risk ?? 'low',
    sensitivityTags: review.sensitivityTags ?? [],
    approvalRequired: write?.approvalRequired ?? false,
    siteScoped: contract.path.includes('{siteId}'),
    ...(write?.defaultDisabled === undefined ? {} : { defaultDisabled: write.defaultDisabled }),
    description: review.description,
    documentationUrl: `https://developer.ui.com/network/v${NETWORK_CONTRACT_REVISION}/${vendorOperationId.toLowerCase()}`,
    contractRevision: NETWORK_CONTRACT_REVISION,
    apiVersionRange: NETWORK_VERSION_RANGE,
    httpMethod: contract.method,
    pathTemplate: contract.path,
    queryParameters: contract.queryParameters,
    ...(contract.hasBody ? { requestBody: 'json' as const } : {}),
    ...(review.maxResponseBytes === undefined ? {} : { maxResponseBytes: review.maxResponseBytes }),
    inputSchema: contract.input as In<K>,
    outputSchema: contract.output as Out<K>,
    retryClass: write?.retryClass ?? 'safe-read',
    timeoutMs: review.timeoutMs ?? (write === undefined ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS),
    ...(write === undefined ? {} : { resourceLockKey: write.resourceLockKey }),
    // Credentials are removed after every projection (credentials.ts).
    project: (output: z.output<Out<K>>) =>
      withoutCredentials(
        review.project === undefined ? output : review.project(output),
        review.credentialFields,
      ),
    ...(review.pagination === undefined ? {} : { pagination: review.pagination }),
    ...(review.namedTool === undefined ? {} : { namedTool: review.namedTool }),
  });
}
