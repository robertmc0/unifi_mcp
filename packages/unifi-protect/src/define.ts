/**
 * Builds a Protect operation descriptor from two separate sources (spec §4.3, ADR 0019):
 *
 * - the **generated contract facts** of one vendor operation, by its inventory key
 *   `"<METHOD> <path>"` (the contract has no operationIds), from the oldest supported
 *   revision that documents it (ADR 0019 §7): `generated/protect-7.3.74.ts` for the
 *   operations of the current official release, `generated/protect-7.4.96.ts` for those
 *   only the newer revision documents;
 * - the **hand-reviewed security metadata** passed in `review`.
 *
 * Nothing in `review` is derived from the vendor document, and regenerating the schemas
 * cannot change it. Protect has no sites: every operation is console-level.
 */
import { defineOperation, type OperationDescriptor, type Target } from '@unifi-local-mcp/core';
import type { Risk, SensitivityTag } from '@unifi-local-mcp/policy';
import type * as z from 'zod';
import { withoutCredentials } from './credentials.ts';
import { OPERATIONS as OFFICIAL } from './generated/protect-7.3.74.ts';
import { OPERATIONS as NEWEST } from './generated/protect-7.4.96.ts';

/**
 * The contract revisions Protect operations are reviewed against (ADR 0019 §7): 7.3.74,
 * the current official release, and 7.4.96, the newest documented revision.
 */
export const PROTECT_CONTRACT_REVISIONS = ['7.3.74', '7.4.96'] as const;
export type ProtectRevision = (typeof PROTECT_CONTRACT_REVISIONS)[number];

/**
 * Protect application versions the adapter accepts (ADR 0019 §7): 7.3.74 and later 7.x.
 * Each operation narrows it to the revision it is built from: operations that 7.3.74
 * documents run on `>=7.3.74 <8` (every later difference is additive, checked by
 * `api:reconcile`); the ones only 7.4.96 documents need `>=7.4.96 <8`. Anything else is
 * refused with `operation_unsupported`.
 */
export const PROTECT_VERSION_RANGE = '>=7.3.74 <8';

type Official = typeof OFFICIAL;
type Newest = typeof NEWEST;
/** `"<METHOD> <path>"` of a documented HTTP operation (any supported revision). */
export type VendorKey = {
  [K in keyof Newest]: Newest[K]['transport'] extends 'http' ? K : never;
}[keyof Newest];
/** The generated facts the operation is built from: the oldest revision documenting it. */
type Contract<K extends VendorKey> = K extends keyof Official ? Official[K] : Newest[K];
type In<K extends VendorKey> = Contract<K>['input'] extends z.ZodObject
  ? Contract<K>['input']
  : never;
type Out<K extends VendorKey> = Contract<K>['output'] extends z.ZodType
  ? Contract<K>['output']
  : never;

/** The oldest supported revision that documents an operation, and its generated facts. */
function contractOf<K extends VendorKey>(
  key: K,
): { revision: ProtectRevision; contract: Contract<K> } {
  const official = (OFFICIAL as Record<string, unknown>)[key];
  return official === undefined
    ? { revision: '7.4.96', contract: NEWEST[key] as Contract<K> }
    : { revision: '7.3.74', contract: official as Contract<K> };
}

/** The vendor's documentation page of an operation (checked against the inventory). */
export function documentationUrl(method: string, path: string, revision: ProtectRevision): string {
  const slug = `${method.toLowerCase()}-${path.replace(/[/{}]/g, '').toLowerCase()}`;
  return `https://developer.ui.com/protect/v${revision}/${slug}`;
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
  const { revision, contract } = contractOf(key);
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
    documentationUrl: documentationUrl(contract.method, contract.path, revision),
    contractRevision: revision,
    apiVersionRange: `>=${revision} <8`,
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
