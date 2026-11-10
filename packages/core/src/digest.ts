/**
 * Canonical JSON and digests of validated requests. The digest identifies "the same
 * request" for idempotency keys and, in step 5, binds an approval to the exact operation,
 * target and arguments (spec §6.5).
 */
import { createHash } from 'node:crypto';

/** JSON with object keys sorted at every level. Rejects values JSON cannot represent. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalise(value, new WeakSet()));
}

function normalise(value: unknown, ancestors: WeakSet<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Cannot canonicalise a non-finite number.');
    return value;
  }
  if (typeof value !== 'object') {
    throw new TypeError(`Cannot canonicalise a value of type ${typeof value}.`);
  }
  if (ancestors.has(value)) throw new TypeError('Cannot canonicalise a cyclic value.');
  ancestors.add(value);
  try {
    if (Array.isArray(value))
      return value.map((item: unknown) => normalise(item ?? null, ancestors));
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const field = (value as Record<string, unknown>)[key];
      if (field !== undefined) result[key] = normalise(field, ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Digest of a validated request: operation, target and arguments. */
export function requestDigest(request: {
  operationId: string;
  consoleId: string;
  siteId?: string | undefined;
  arguments: unknown;
}): string {
  return sha256Hex(
    canonicalJson({
      operationId: request.operationId,
      consoleId: request.consoleId,
      siteId: request.siteId ?? null,
      arguments: request.arguments,
    }),
  );
}
