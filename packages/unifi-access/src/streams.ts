/**
 * The documented Access notification WebSocket (§11.1), with its hand-reviewed security
 * metadata (spec §11; ADR 0023 §6). Reviewed 2026-11-15 against the transcription of the
 * 2026-03-23 PDF, which shows three messages, each selected by its `event`:
 *
 * - `access.remote_view` (a doorbell rings): the door, reader and floor, the request, and
 *   the IDs of the door guards who are called. Its `token` is removed: the PDF does not
 *   say what it grants, and next to the call's `channel` it reads as the credential for
 *   answering the call (seeing and hearing the person at the door).
 * - `access.remote_view.change` (the call ends: answered, declined, timed out, unlocked or
 *   cancelled): a reason code and the request ID.
 * - `access.data.device.remote_unlock` (an administrator unlocked a door remotely): the
 *   door's location record, as `access.spaces.get_door` returns doors. It is an entry in the
 *   door's access history, so it also needs the `access_log` grant (spec §6.4) and the door
 *   read's permission.
 *
 * The stream needs `access.notifications.read`. Events not in this table (a newer console)
 * are never delivered. Every message is minimised like a read: credential fields are
 * removed at any depth (credentials.ts), and the doorbell's `token` as well.
 */
import { defineEventStream, type MessageClass } from '@unifi-local-mcp/core';
import type { SensitivityTag } from '@unifi-local-mcp/policy';
import { withoutCredentials } from './credentials.ts';
import { ACCESS_CONTRACT_REVISION, ACCESS_MAX_VERSION } from './define.ts';
import { OPERATIONS } from './generated/access-2026-03-23.ts';
import { getDoor } from './operations/spaces.ts';

const NOTIFICATIONS = OPERATIONS['GET /api/v1/developer/devices/notifications'];

/** Every documented notification, by its `event`, and the reviewed class it is delivered as. */
export const NOTIFICATION_EVENTS: Readonly<Record<string, MessageClass>> = {
  'access.remote_view': { kind: 'doorbell_ring', sensitivityTags: [] },
  'access.remote_view.change': { kind: 'doorbell_status', sensitivityTags: [] },
  'access.data.device.remote_unlock': {
    kind: 'remote_unlock',
    equivalent: getDoor,
    sensitivityTags: ['access_log'] satisfies SensitivityTag[],
  },
};

/** The reviewed class of a notification, or undefined (never delivered). */
export function classifyNotification(message: { event: string }): MessageClass | undefined {
  return Object.hasOwn(NOTIFICATION_EVENTS, message.event)
    ? NOTIFICATION_EVENTS[message.event]
    : undefined;
}

/** A notification without credentials; a doorbell call's `token` is one. */
export function projectNotification(message: unknown): unknown {
  const clean = withoutCredentials(message) as { event?: unknown; data?: unknown };
  if (
    clean.event !== 'access.remote_view' ||
    typeof clean.data !== 'object' ||
    clean.data === null
  ) {
    return clean;
  }
  const data = Object.fromEntries(
    Object.entries(clean.data as Record<string, unknown>).filter(([key]) => key !== 'token'),
  );
  return { ...clean, data };
}

export const subscribeNotifications = defineEventStream({
  operationId: 'access.notifications.subscribe',
  moduleId: 'access',
  category: 'notifications',
  effect: 'read',
  permission: 'access.notifications.read',
  risk: 'low',
  sensitivityTags: [],
  approvalRequired: false,
  siteScoped: false,
  streamId: 'notifications',
  description:
    'Access notifications as they happen: doorbell calls and how they ended, and doors unlocked remotely by an administrator.',
  documentationUrl: NOTIFICATIONS.documentationUrl,
  contractRevision: ACCESS_CONTRACT_REVISION,
  apiVersionRange: `>=${NOTIFICATIONS.minimumVersion} <=${ACCESS_MAX_VERSION}`,
  pathTemplate: NOTIFICATIONS.path,
  messageSchema: NOTIFICATIONS.output,
  maxMessageBytes: 256 * 1024,
  classify: classifyNotification,
  project: projectNotification,
});

/** The documented Access subscriptions that are implemented (ADR 0023 §6). */
export const ACCESS_EVENT_STREAMS = [subscribeNotifications] as const;
