/**
 * Builds an Access operation descriptor from two separate sources (spec §4.3, ADR 0023 §3):
 *
 * - the **generated contract facts** of one operation, by its inventory key
 *   `"<METHOD> <path>"`, from `generated/access-2026-03-23.ts`: method, path, schemas, the
 *   vendor-stated minimum version, the documentation link and the request fields that need
 *   a later version (ADR 0022). That module is generated from this project's transcription
 *   of the PDF, not from a vendor document;
 * - the **hand-reviewed security metadata** passed in `review`.
 *
 * Nothing in `review` is derived from the PDF, and regenerating the schemas cannot change
 * it. Access has no sites: every operation is console-level.
 */
import { defineOperation, type OperationDescriptor, type Target } from '@unifi-local-mcp/core';
import type { Risk, SensitivityTag } from '@unifi-local-mcp/policy';
import type * as z from 'zod';
import { withoutCredentials } from './credentials.ts';
import { OPERATIONS } from './generated/access-2026-03-23.ts';

/** The transcribed contract revision (the PDF's date; it has no version of its own). */
export const ACCESS_CONTRACT_REVISION = '2026-03-23';

/**
 * The newest Access version operations accept (ADR 0021 §5, U1): the last version the PDF's
 * change log covers. Each operation's range starts at its own stated minimum. Widening this
 * needs a version-labelled contract or a live run of the newer version, recorded in ADR 0021.
 */
export const ACCESS_MAX_VERSION = '4.2.16';

type Generated = typeof OPERATIONS;
/** `"<METHOD> <path>"` of a generated Access operation. */
export type AccessKey = keyof Generated;
type In<K extends AccessKey> = Generated[K]['input'] extends z.ZodObject
  ? Generated[K]['input']
  : never;
type Out<K extends AccessKey> = Generated[K]['output'] extends z.ZodType
  ? Generated[K]['output']
  : never;

interface ReviewCommon<K extends AccessKey> {
  /** `access.<category>.<action>`. */
  operationId: string;
  category: string;
  /** Our own one- or two-sentence description; never vendor prose. */
  description: string;
  sensitivityTags?: readonly SensitivityTag[];
  namedTool?: string;
  timeoutMs?: number;
  /** A reviewed narrowing of the generated arguments (for example a bounded time window). */
  narrowInput?: (input: In<K>) => In<K>;
}

export interface ReadReview<K extends AccessKey> extends ReviewCommon<K> {
  effect: 'read';
}

export interface WriteReview<K extends AccessKey> extends ReviewCommon<K> {
  effect: 'write';
  risk: Risk;
  approvalRequired: boolean;
  retryClass: 'idempotent' | 'non-idempotent';
  resourceLockKey: (args: z.output<In<K>>, target: Target) => string;
  defaultDisabled?: boolean;
  approvalCaution?: string;
}

/** A lock shared by every write of one kind on one console (conflicting writes run in turn). */
export function consoleLock(name: string): (args: unknown, target: Target) => string {
  return (_args, target) => `console:${target.consoleId}/access/${name}`;
}

const READ_TIMEOUT_MS = 15_000;
const WRITE_TIMEOUT_MS = 30_000;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The result a client sees: the envelope's `data` (ADR 0022 §4), without credentials. */
function dataOf(output: unknown): unknown {
  return withoutCredentials(isObject(output) ? output['data'] : null);
}

/**
 * Paging facts: `pagination: {page_num, page_size, total}` (§3.5 and other lists), or
 * `page` and `total` beside `data` (§9.2).
 */
export function pageOf(output: unknown): Readonly<Record<string, number>> | undefined {
  if (!isObject(output)) return undefined;
  const pagination = output['pagination'];
  if (isObject(pagination)) {
    const { page_num: page, page_size: size, total } = pagination;
    if (typeof page !== 'number' || typeof size !== 'number' || typeof total !== 'number') {
      return undefined;
    }
    return {
      pageNum: page,
      pageSize: size,
      total,
      ...(page * size < total ? { nextPageNum: page + 1 } : {}),
    };
  }
  const { page, total } = output;
  return typeof page === 'number' && typeof total === 'number'
    ? { pageNum: page, total }
    : undefined;
}

export function accessOperation<K extends AccessKey>(
  key: K,
  review: ReadReview<K> | WriteReview<K>,
): OperationDescriptor<In<K>, Out<K>> {
  const contract = OPERATIONS[key];
  const write = review.effect === 'write' ? review : undefined;
  const input = contract.input as In<K>;
  return defineOperation<In<K>, Out<K>>({
    operationId: review.operationId,
    moduleId: 'access',
    category: review.category,
    effect: review.effect,
    permission: `access.${review.category}.${review.effect}`,
    risk: write?.risk ?? 'low',
    sensitivityTags: review.sensitivityTags ?? [],
    approvalRequired: write?.approvalRequired ?? false,
    siteScoped: false,
    ...(write?.defaultDisabled === undefined ? {} : { defaultDisabled: write.defaultDisabled }),
    ...(write?.approvalCaution === undefined ? {} : { approvalCaution: write.approvalCaution }),
    description: review.description,
    documentationUrl: contract.documentationUrl,
    contractRevision: ACCESS_CONTRACT_REVISION,
    apiVersionRange: `>=${contract.minimumVersion} <=${ACCESS_MAX_VERSION}`,
    httpMethod: contract.method,
    pathTemplate: contract.path,
    queryParameters: contract.queryParameters,
    ...(contract.hasBody ? { requestBody: 'json' as const } : {}),
    inputSchema: review.narrowInput === undefined ? input : review.narrowInput(input),
    outputSchema: contract.output as Out<K>,
    retryClass: write?.retryClass ?? 'safe-read',
    timeoutMs: review.timeoutMs ?? (write === undefined ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS),
    ...(write === undefined ? {} : { resourceLockKey: write.resourceLockKey }),
    // Credentials are removed after the projection to `data` (credentials.ts).
    project: dataOf,
    pagination: pageOf,
    ...(contract.versionedFields.length === 0 ? {} : { versionedFields: contract.versionedFields }),
    ...(review.namedTool === undefined ? {} : { namedTool: review.namedTool }),
  });
}
