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
  armExternal,
  armLocal,
  createArmProfile,
  createExternalArmProfile,
  deleteArmProfile,
  deleteExternalArmProfile,
  disarmExternal,
  disarmLocal,
  getExternalArmProfile,
  listArmProfiles,
  listExternalArmProfiles,
  triggerAlarmWebhook,
  updateArmProfile,
  updateArmProfileSettings,
  updateExternalArmProfile,
} from './operations/alarm.ts';
import {
  createPosTransaction,
  createRtspsStreams,
  deleteRtspsStreams,
  disableMicrophonePermanently,
  getCamera,
  getRtspsStreams,
  getSnapshot,
  listCameras,
  ptzGoto,
  ptzStartPatrol,
  ptzStopPatrol,
  startTalkbackSession,
  updateCamera,
} from './operations/cameras.ts';
import {
  activateRelayOutput,
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
  playSiren,
  stopSiren,
  stopSpeakerSiren,
  testSiren,
  testSpeaker,
  triggerAlarmHubOutput,
  updateAlarmHub,
  updateBridge,
  updateChime,
  updateFob,
  updateLight,
  updateLinkStation,
  updateRelay,
  updateSensor,
  updateSiren,
  updateSpeaker,
} from './operations/devices.ts';
import { listFiles } from './operations/files.ts';
import { getInfo } from './operations/info.ts';
import { getUlpUser, getUser, listUlpUsers, listUsers } from './operations/users.ts';
import {
  createLiveview,
  getLiveview,
  getViewer,
  listLiveviews,
  listViewers,
  updateLiveview,
  updateViewer,
} from './operations/views.ts';

export { ALWAYS_REMOVED, withoutCredentials } from './credentials.ts';
export {
  consoleLock,
  deviceLock,
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

/**
 * Every documented Protect write except the multipart upload (41), reviewed 2026-11-11
 * (ADR 0019 §6): 25 high risk (human approval), 16 medium. Two are also disabled until a
 * global policy enables them: the permanent microphone disable and talkback.
 */
export const PROTECT_WRITES: readonly OperationDescriptor[] = [
  updateCamera,
  createRtspsStreams,
  deleteRtspsStreams,
  disableMicrophonePermanently,
  startTalkbackSession,
  ptzGoto,
  ptzStartPatrol,
  ptzStopPatrol,
  createPosTransaction,
  updateLight,
  updateSensor,
  updateSiren,
  playSiren,
  stopSiren,
  testSiren,
  updateSpeaker,
  testSpeaker,
  stopSpeakerSiren,
  updateChime,
  updateRelay,
  activateRelayOutput,
  updateBridge,
  updateLinkStation,
  updateAlarmHub,
  triggerAlarmHubOutput,
  updateFob,
  createArmProfile,
  updateArmProfileSettings,
  updateArmProfile,
  deleteArmProfile,
  armLocal,
  disarmLocal,
  triggerAlarmWebhook,
  createExternalArmProfile,
  updateExternalArmProfile,
  deleteExternalArmProfile,
  armExternal,
  disarmExternal,
  updateViewer,
  createLiveview,
  updateLiveview,
];

/** Every implemented Protect operation, registered by the service at startup. */
export const PROTECT_OPERATIONS: readonly OperationDescriptor[] = [
  ...PROTECT_READS,
  ...PROTECT_WRITES,
];
