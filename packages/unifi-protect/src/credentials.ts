/**
 * Credentials never leave the service (spec §6.4, §17; ADR 0019). Reviewed against the
 * 7.4.96 contract (2026-11-11), these Protect fields carry secrets or grant access by
 * themselves:
 *
 * - `url`: the talkback session's RTP endpoint, which lets anyone send audio to a camera
 *   speaker while the session lasts. It is the only property named `url`; removing the
 *   name everywhere also covers any URL a later revision adds.
 * - `pin_code`: the PIN of an external arm profile. The contract sends it only in
 *   requests (responses say `has_pin`); it is removed here in case a console echoes it.
 * - The RTSPS stream URLs (`high`, `medium`, `low`, `package`) carry an access token in
 *   their path. Those names are also used for harmless values, so they are removed only
 *   by the stream operations themselves.
 *
 * Removal happens after every projection, at any depth. The response schemas already drop
 * every undocumented field.
 */
import { withoutFields } from '@unifi-local-mcp/core';

/** Removed from every Protect result, wherever it appears. */
export const ALWAYS_REMOVED = ['url', 'pin_code'] as const;

export function withoutCredentials(value: unknown, extra: readonly string[] = []): unknown {
  return withoutFields(value, new Set<string>([...ALWAYS_REMOVED, ...extra]));
}
