/**
 * Builds a Protect operation descriptor from two separate sources (spec §4.3, ADR 0019):
 *
 * - the **generated contract facts** of one vendor operation, by its inventory key
 *   `"<METHOD> <path>"` (the contract has no operationIds), from
 *   `generated/protect-7.4.96.ts`;
 * - the **hand-reviewed security metadata** passed in `review`.
 *
 * Nothing in `review` is derived from the vendor document, and regenerating the schemas
 * cannot change it. Protect has no sites: every operation is console-level.
 */
import { defineOperation, type OperationDescriptor, type Target } from '@unifi-local-mcp/core';
import type { Risk, SensitivityTag } from '@unifi-local-mcp/policy';
import type * as z from 'zod';
import { withoutCredentials } from './credentials.ts';
import { OPERATIONS } from './generated/protect-7.4.96.ts';

/** The vendor contract revision every Protect operation was reviewed against. */
export const PROTECT_CONTRACT_REVISION = '7.4.96';

/**
 * Protect application versions the adapter accepts (ADR 0019 §4). The contract was
 * verified for 7.4.96. Later 7.x releases are accepted as compatible, because they keep
 * the `/v1` integration API. Anything else is refused with `operation_unsupported`.
 */
export const PROTECT_VERSION_RANGE = '>=7.4.96 <8';

type Generated = typeof OPERATIONS;
/** `"<METHOD> <path>"` of a documented HTTP operation. */
export type VendorKey = {
  [K in keyof Generated]: Generated[K]['transport'] extends 'http' ? K : never;
}[keyof Generated];
type In<K extends VendorKey> = Generated[K]['input'] extends z.ZodObject
  ? Generated[K]['input']
  : never;
type Out<K extends VendorKey> = Generated[K]['output'] extends z.ZodType
  ? Generated[K]['output']
  : never;

/** The vendor's documentation page of an operation (checked against the inventory). */
export function documentationUrl(method: string, path: string): string {
  const slug = `${method.toLowerCase()}-${path.replace(/[/{}]/g, '').toLowerCase()}`;
  return `https://developer.ui.com/protect/v${PROTECT_CONTRACT_REVISION}/${slug}`;
}

interface ReviewCommon<K extends VendorKey> {
  /** `protect.<category>.<action>`. */
  operationId: string;
  category: string;
  /** Our own one- or two-sentence description; never vendor prose. */
  description: string;
  sensitivityTags?: readonly SensitivityTag[];
  namedTool?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  project?: (output: z.output<Out<K>>) => unknown;
  /** Fields of this operation's result that carry credentials, besides `url`, `pin_code`. */
  credentialFields?: readonly string[];
}

export interface ReadReview<K extends VendorKey> extends ReviewCommon<K> {
  effect: 'read';
}

export interface WriteReview<K extends VendorKey> extends ReviewCommon<K> {
  effect: 'write';
  risk: Risk;
  approvalRequired: boolean;
  retryClass: 'idempotent' | 'non-idempotent';
  resourceLockKey: (args: z.output<In<K>>, target: Target) => string;
  defaultDisabled?: boolean;
}

/** A lock shared by every write of one kind on one console (conflicting writes run in turn). */
export function consoleLock(name: string): (args: unknown, target: Target) => string {
  return (_args, target) => `console:${target.consoleId}/protect/${name}`;
}

/** A lock per device: writes to one device run in turn, different devices in parallel. */
export function deviceLock(kind: string): (args: { id: string }, target: Target) => string {
  return (args, target) => `console:${target.consoleId}/protect/${kind}/${args.id}`;
}

const READ_TIMEOUT_MS = 15_000;
const WRITE_TIMEOUT_MS = 30_000;

export function protectOperation<K extends VendorKey>(
  key: K,
  review: ReadReview<K> | WriteReview<K>,
): OperationDescriptor<In<K>, Out<K>> {
  const contract = OPERATIONS[key];
  const write = review.effect === 'write' ? review : undefined;
  const binary = contract.responseType === 'image/jpeg';
  return defineOperation<In<K>, Out<K>>({
    operationId: review.operationId,
    moduleId: 'protect',
    category: review.category,
    effect: review.effect,
    permission: `protect.${review.category}.${review.effect}`,
    risk: write?.risk ?? 'low',
    sensitivityTags: review.sensitivityTags ?? [],
    approvalRequired: write?.approvalRequired ?? false,
    siteScoped: false,
    ...(write?.defaultDisabled === undefined ? {} : { defaultDisabled: write.defaultDisabled }),
    description: review.description,
    documentationUrl: documentationUrl(contract.method, contract.path),
    contractRevision: PROTECT_CONTRACT_REVISION,
    apiVersionRange: PROTECT_VERSION_RANGE,
    httpMethod: contract.method,
    pathTemplate: contract.path,
    queryParameters: contract.queryParameters,
    ...(contract.hasBody ? { requestBody: 'json' as const } : {}),
    ...(binary ? { responseType: 'image/jpeg' as const } : {}),
    ...(review.maxResponseBytes === undefined ? {} : { maxResponseBytes: review.maxResponseBytes }),
    inputSchema: contract.input as In<K>,
    outputSchema: contract.output as Out<K>,
    retryClass: write?.retryClass ?? 'safe-read',
    timeoutMs: review.timeoutMs ?? (write === undefined ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS),
    ...(write === undefined ? {} : { resourceLockKey: write.resourceLockKey }),
    // Credentials are removed after every projection (credentials.ts). Binary results are
    // bytes, neither projected nor stripped.
    ...(binary
      ? {}
      : {
          project: (output: z.output<Out<K>>) =>
            withoutCredentials(
              review.project === undefined ? output : review.project(output),
              review.credentialFields,
            ),
        }),
    ...(review.namedTool === undefined ? {} : { namedTool: review.namedTool }),
  });
}
