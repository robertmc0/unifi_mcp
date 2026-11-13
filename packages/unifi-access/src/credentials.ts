/**
 * Credentials never leave the service (spec §6.4, §17; ADR 0023 §3). Reviewed against the
 * transcription of the 2026-03-23 PDF (2026-11-13), these Access result fields carry
 * secrets or grant access by themselves:
 *
 * - `pin_code.token`: the hash of a user's or visitor's PIN (§3.1, §4.1). PINs are short,
 *   so a hash can be reversed by trying every PIN. Only the token goes; an empty
 *   `pin_code` still shows that a PIN is assigned. Device settings also have a `pin_code`
 *   object (§8.2), without a token, so they are unaffected.
 * - `secret`: a webhook endpoint's signing secret (§11.3), with which anyone can forge
 *   events to the receiver.
 * - `headers`: the custom headers a webhook forwards to its receiver (§11.3), the usual
 *   place for the receiver's own credentials.
 *
 * NFC card tokens (`nfc_cards[].token`, §6.6) are kept: they identify a card in the API
 * (§6.7 to §6.10 address cards by token) and are not the card's secret. Reads that return
 * them need the `biometric_or_access_identity` grant.
 *
 * Removal happens after every projection, at any depth. The response schemas already drop
 * every field the transcription does not document.
 */
import { withoutFields } from '@unifi-local-mcp/core';

/** Removed from every Access result, wherever it appears. */
export const ALWAYS_REMOVED = ['secret', 'headers'] as const;

/** Removes the PIN hash from every `pin_code` object, at any depth. */
function withoutPinHashes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutPinHashes);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (
      key === 'pin_code' &&
      child !== null &&
      typeof child === 'object' &&
      !Array.isArray(child)
    ) {
      out[key] = withoutPinHashes(
        Object.fromEntries(
          Object.entries(child as Record<string, unknown>).filter(([name]) => name !== 'token'),
        ),
      );
    } else {
      out[key] = withoutPinHashes(child);
    }
  }
  return out;
}

export function withoutCredentials(value: unknown): unknown {
  return withoutPinHashes(withoutFields(value, new Set<string>(ALWAYS_REMOVED)));
}
