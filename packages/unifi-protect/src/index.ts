/**
 * @unifi-local-mcp/unifi-protect
 *
 * The official local UniFi Protect integration API adapter (ADR 0019): generated request
 * and response schemas for contract revision 7.4.96, and the hand-reviewed security
 * metadata of every implemented operation. Only operations recorded in
 * `api-specs/protect/7.4.96/` can be implemented here.
 */
import type { OperationDescriptor } from '@unifi-local-mcp/core';
import {
  getExternalArmProfile,
  listArmProfiles,
  listExternalArmProfiles,
} from './operations/alarm.ts';
import { getCamera, getRtspsStreams, getSnapshot, listCameras } from './operations/cameras.ts';
import {
  getAlarmHub,
  getBridge,
  getChime,
  getFob,
  getLight,
  getLinkStation,
  getRelay,
  getSensor,
  getSiren,
  getSpeaker,
  listAlarmHubs,
  listBridges,
  listChimes,
  listFobs,
  listLights,
  listLinkStations,
  listNvrs,
  listRelays,
  listSensors,
  listSirens,
  listSpeakers,
} from './operations/devices.ts';
import { listFiles } from './operations/files.ts';
import { getInfo } from './operations/info.ts';
import { getUlpUser, getUser, listUlpUsers, listUsers } from './operations/users.ts';
import { getLiveview, getViewer, listLiveviews, listViewers } from './operations/views.ts';

export { ALWAYS_REMOVED, withoutCredentials } from './credentials.ts';
export {
  consoleLock,
  documentationUrl,
  PROTECT_CONTRACT_REVISION,
  PROTECT_VERSION_RANGE,
  protectOperation,
  type VendorKey,
} from './define.ts';
export { streamQualities } from './operations/cameras.ts';
export { PROTECT_VERSION_PROBE } from './probe.ts';

/** Every documented Protect HTTP read (38), reviewed 2026-11-11 (ADR 0019 §5). */
export const PROTECT_READS: readonly OperationDescriptor[] = [
  getInfo,
  listCameras,
  getCamera,
  getSnapshot,
  getRtspsStreams,
  listLights,
  getLight,
  listSensors,
  getSensor,
  listSirens,
  getSiren,
  listSpeakers,
  getSpeaker,
  listChimes,
  getChime,
  listRelays,
  getRelay,
  listBridges,
  getBridge,
  listLinkStations,
  getLinkStation,
  listAlarmHubs,
  getAlarmHub,
  listFobs,
  getFob,
  listNvrs,
  listArmProfiles,
  listExternalArmProfiles,
  getExternalArmProfile,
  listViewers,
  getViewer,
  listLiveviews,
  getLiveview,
  listUsers,
  getUser,
  listUlpUsers,
  getUlpUser,
  listFiles,
];

/** The documented Protect writes implemented so far (ADR 0019). */
export const PROTECT_WRITES: readonly OperationDescriptor[] = [];

/** Every implemented Protect operation, registered by the service at startup. */
export const PROTECT_OPERATIONS: readonly OperationDescriptor[] = [
  ...PROTECT_READS,
  ...PROTECT_WRITES,
];
