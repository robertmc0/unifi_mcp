/**
 * Credentials never leave the service (spec §6.4, §17; ADR 0018 §4). Reviewed against the
 * 11.0.97 contract (2026-11-10), these Network response fields carry secrets:
 *
 * - `passphrase`: Wi-Fi pre-shared keys, in every WPA personal security configuration and
 *   in each entry of `presharedKeys`;
 * - `code`: the access code of a hotspot voucher. The name `code` is also used for
 *   harmless values (country codes), so it is removed only where an operation names it.
 *
 * Removal happens after every projection, at any depth, so a field nested deeper or
 * returned by another operation cannot slip through. The response schemas already drop
 * every undocumented field.
 */

import { withoutFields } from '@unifi-local-mcp/core';

/** Removed from every Network result, wherever it appears. */
export const ALWAYS_REMOVED = ['passphrase'] as const;

export function withoutCredentials(value: unknown, extra: readonly string[] = []): unknown {
  return withoutFields(value, new Set<string>([...ALWAYS_REMOVED, ...extra]));
}
