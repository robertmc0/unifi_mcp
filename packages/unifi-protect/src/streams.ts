/**
 * The documented Protect event subscriptions, with their hand-reviewed security metadata
 * (spec §11; ADR 0020 §6). Reviewed 2026-11-12 against 7.3.74 and 7.4.96, which document
 * the same event types and device kinds; the message schemas come from the 7.3.74 module
 * and serve later 7.x consoles like the operations do (ADR 0019 §7).
 *
 * - **Events** (`GET /v1/subscribe/events`): needs `protect.events.read`. An NFC card scan
 *   or fingerprint match names the UniFi Identity user (`ulpId`), so those two events also
 *   need `personal_identifier` and `biometric_or_access_identity`. The other events carry
 *   ids, times and detection labels only.
 * - **Devices** (`GET /v1/subscribe/devices`): needs `protect.devices.read`, and each
 *   message carries the same data as the reviewed read of that device kind, whose
 *   permission and grants it also needs: a fob update needs `protect.fobs.read` and
 *   `location`, like `protect.fobs.get`. AI processors and AI ports have no reviewed read,
 *   so their messages are never delivered.
 * - Event types and device kinds not in these tables (a newer console) are never delivered.
 * - Every message is minimised like a read: credential fields are removed at any depth.
 * - Device messages come in a single form (`id` a string) and a bulk form (`id` a string
 *   or a list), documented as `anyOf`. In both revisions the bulk forms have exactly the
 *   single forms' fields and required fields, so they are tried first: the generated
 *   order lets the single forms' tolerant fallback for unknown device kinds accept a bulk
 *   message and drop its item (`tests/contract/protect-streams.test.ts`).
 *
 * `GET /v1/subscribe/updates` (7.4.96 only) is not implemented yet (ADR 0020 §6).
 */
import { defineEventStream, type MessageClass } from '@unifi-local-mcp/core';
import * as z from 'zod';
import type { OperationSecurity, SensitivityTag } from '@unifi-local-mcp/policy';
import { withoutCredentials } from './credentials.ts';
import { documentationUrl, PROTECT_VERSION_RANGE } from './define.ts';
import { OPERATIONS as OFFICIAL } from './generated/protect-7.3.74.ts';
import { getCamera } from './operations/cameras.ts';
import {
  getBridge,
  getChime,
  getFob,
  getLight,
  getLinkStation,
  getRelay,
  getSensor,
  getSiren,
  getSpeaker,
  listNvrs,
} from './operations/devices.ts';
import { getViewer } from './operations/views.ts';

const IDENTITY: readonly SensitivityTag[] = ['personal_identifier', 'biometric_or_access_identity'];

/** Every documented event type, and the grants it needs besides `protect.events.read`. */
export const EVENT_TYPES: Readonly<Record<string, readonly SensitivityTag[]>> = {
  ring: [],
  motion: [],
  smartAudioDetect: [],
  smartDetectZone: [],
  smartDetectLine: [],
  smartDetectLoiterZone: [],
  cameraDigitalInputChanged: [],
  lightMotion: [],
  relayInputChanged: [],
  sensorAlarm: [],
  sensorBatteryLow: [],
  sensorButtonPressed: [],
  sensorClosed: [],
  sensorCoFault: [],
  sensorExtremeValues: [],
  sensorMotion: [],
  sensorOpened: [],
  sensorSmokeBatteryLow: [],
  sensorSmokeEndOfLife: [],
  sensorSmokeFault: [],
  sensorSmokeNeedsCleaning: [],
  sensorSmokeTest: [],
  sensorTamper: [],
  sensorVape: [],
  sensorWaterLeak: [],
  alarmHubBatteryConnected: [],
  alarmHubBatteryLow: [],
  alarmHubButtonPress: [],
  alarmHubDeviceTamper: [],
  alarmHubEntryClosed: [],
  alarmHubEntryOpened: [],
  alarmHubGlassBreak: [],
  alarmHubMotion: [],
  alarmHubRelaySwitched: [],
  alarmHubSmoke: [],
  alarmHubTamper: [],
  nfcCardScanned: IDENTITY,
  fingerprintIdentified: IDENTITY,
};

/**
 * Every documented device kind (`modelKey`), and the reviewed read returning the same data;
 * `null` where none exists, so the messages are never delivered.
 */
export const DEVICE_KINDS: Readonly<Record<string, OperationSecurity | null>> = {
  nvr: listNvrs,
  camera: getCamera,
  chime: getChime,
  light: getLight,
  viewer: getViewer,
  speaker: getSpeaker,
  bridge: getBridge,
  sensor: getSensor,
  siren: getSiren,
  fob: getFob,
  relay: getRelay,
  linkstation: getLinkStation,
  aiport: null,
  aiprocessor: null,
};

const ACTIONS = new Set(['add', 'update', 'remove']);

function parts(message: unknown): { action: string; item: Record<string, unknown> } | undefined {
  const { type, item } = message as { type?: unknown; item?: unknown };
  if (typeof type !== 'string' || !ACTIONS.has(type)) return undefined;
  if (typeof item !== 'object' || item === null || Array.isArray(item)) return undefined;
  return { action: type, item: item as Record<string, unknown> };
}

/** The reviewed class of an event message, or undefined (never delivered). */
export function classifyEvent(message: unknown): MessageClass | undefined {
  const found = parts(message);
  const type = found?.item['type'];
  if (found === undefined || found.action === 'remove' || typeof type !== 'string')
    return undefined;
  if (!Object.hasOwn(EVENT_TYPES, type)) return undefined;
  return { kind: type, sensitivityTags: EVENT_TYPES[type] ?? [] };
}

/** The reviewed class of a device message, or undefined (never delivered). */
export function classifyDevice(message: unknown): MessageClass | undefined {
  const found = parts(message);
  const modelKey = found?.item['modelKey'];
  if (found === undefined || typeof modelKey !== 'string') return undefined;
  if (!Object.hasOwn(DEVICE_KINDS, modelKey)) return undefined;
  const equivalent = DEVICE_KINDS[modelKey];
  if (equivalent === null || equivalent === undefined) return undefined;
  return { kind: `${modelKey}_${found.action}`, equivalent, sensitivityTags: [] };
}

const EVENTS = OFFICIAL['GET /v1/subscribe/events'];
const DEVICES = OFFICIAL['GET /v1/subscribe/devices'];
const [singleDeviceForms, bulkDeviceForms] = DEVICES.output.options;
/** Bulk forms first: they accept every single-form message with the same fields. */
export const DEVICE_MESSAGE = z.union([bulkDeviceForms, singleDeviceForms]);

const common = {
  moduleId: 'protect',
  effect: 'read',
  risk: 'low',
  sensitivityTags: [],
  approvalRequired: false,
  siteScoped: false,
  contractRevision: '7.3.74',
  apiVersionRange: PROTECT_VERSION_RANGE,
} as const;

export const subscribeEvents = defineEventStream({
  ...common,
  operationId: 'protect.events.subscribe',
  category: 'events',
  permission: 'protect.events.read',
  streamId: 'events',
  description:
    'Protect events as they happen: doorbell rings, motion and smart detections, sensor and ' +
    'alarm hub events, NFC and fingerprint scans.',
  documentationUrl: documentationUrl(EVENTS.method, EVENTS.path, '7.3.74'),
  pathTemplate: EVENTS.path,
  messageSchema: EVENTS.output,
  maxMessageBytes: 256 * 1024,
  classify: classifyEvent,
  project: (message) => withoutCredentials(message),
});

export const subscribeDevices = defineEventStream({
  ...common,
  operationId: 'protect.devices.subscribe',
  category: 'devices',
  permission: 'protect.devices.read',
  streamId: 'devices',
  description:
    'Changes to Protect devices as they happen: devices added, updated or removed, with the ' +
    'changed fields.',
  documentationUrl: documentationUrl(DEVICES.method, DEVICES.path, '7.3.74'),
  pathTemplate: DEVICES.path,
  messageSchema: DEVICE_MESSAGE,
  maxMessageBytes: 1024 * 1024,
  classify: classifyDevice,
  project: (message) => withoutCredentials(message),
});

/** The documented Protect subscriptions that are implemented (ADR 0020 §6). */
export const PROTECT_EVENT_STREAMS = [subscribeEvents, subscribeDevices] as const;
