/**
 * Documented Access operations that are not offered, each with its reviewed reason
 * (reviewed 2026-11-14, ADR 0023 §5). Like the security metadata, these are decisions made
 * in code, never derived from the PDF; the coverage report shows them with their reasons.
 *
 * Keys are inventory keys; `api:reconcile` and the coverage tests check that each names a
 * documented operation that is not implemented.
 */
import type { ReviewedOmission } from '@unifi-local-mcp/core';

const P = '/api/v1/developer';

/** Keyed by the inventory key `"<METHOD> <path>"`, generated or not. */
export const ACCESS_OMISSIONS: Readonly<Record<string, ReviewedOmission>> = {
  [`POST ${P}/credentials/pin_codes`]: {
    decision: 'refused',
    reason: 'Its result is a new PIN, a credential that no client may receive (spec §6.4).',
  },
  [`GET ${P}/credentials/qr_codes/download/{visitor_id}`]: {
    decision: 'refused',
    reason:
      "Its result is a visitor's QR code image, a credential that opens doors and that no client may receive (spec §6.4).",
  },
  [`POST ${P}/api_server/certificates`]: {
    decision: 'refused',
    reason:
      'It uploads a TLS private key, which would pass through an AI client; install certificates in UniFi Access instead.',
  },
  [`POST ${P}/system/logs/export`]: {
    decision: 'refused',
    reason:
      'A CSV export of up to 31 days of logs is a bulk dump (spec §6.4); access.logs.list reads the same logs in bounded pages.',
  },
  [`POST ${P}/credentials/nfc_cards/import`]: {
    decision: 'refused',
    reason:
      'It creates door credentials in bulk from an uploaded CSV file; import cards in UniFi Access instead.',
  },
  [`POST ${P}/users/{id}/avatar`]: {
    decision: 'refused',
    reason:
      "It uploads a person's picture, which Access may use to recognise their face (not documented); set pictures in UniFi Access instead.",
  },
  [`GET ${P}/system/static/{path}`]: {
    decision: 'deferred',
    reason:
      'It returns files (pictures of people, recording videos) from a free-form path, with no documented media type or size; to be reviewed against a real console.',
  },
  [`PUT ${P}/visitors/{id}/license_plates`]: {
    decision: 'deferred',
    reason:
      'The PDF prints no field table for its body, only a sample (ADR 0022 §3); until it does, request fields cannot be transcribed.',
  },
  [`PUT ${P}/devices/{device_id}/settings`]: {
    decision: 'deferred',
    reason:
      "The PDF's field table and samples disagree on the body (ADR 0022 §3); to be verified against a real console.",
  },
};
