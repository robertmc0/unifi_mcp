/**
 * Cameras (reviewed 2026-11-11 against 7.4.96). Reads: low risk. The snapshot is a camera
 * image (its own sensitive grant); the RTSPS stream URLs carry access tokens and are never
 * returned, only which qualities exist (ADR 0019 §5).
 */
import { deviceLock, protectOperation } from '../define.ts';

/** Snapshots are JPEG images; 8 MiB covers high-quality frames with room to spare. */
const SNAPSHOT_MAX_BYTES = 8 * 1024 * 1024;

export const listCameras = protectOperation('GET /v1/cameras', {
  operationId: 'protect.cameras.list',
  category: 'cameras',
  effect: 'read',
  description: 'Cameras: name, model, state, video mode, microphone, HDR and detection settings.',
  namedTool: 'protect_list_cameras',
});

export const getCamera = protectOperation('GET /v1/cameras/{id}', {
  operationId: 'protect.cameras.get',
  category: 'cameras',
  effect: 'read',
  description: 'One camera and its settings.',
  namedTool: 'protect_get_camera',
});

export const getSnapshot = protectOperation('GET /v1/cameras/{id}/snapshot', {
  operationId: 'protect.cameras.get_snapshot',
  category: 'cameras',
  effect: 'read',
  description: 'A current JPEG snapshot from a camera, returned as image content.',
  sensitivityTags: ['camera_image'],
  maxResponseBytes: SNAPSHOT_MAX_BYTES,
  timeoutMs: 20_000,
  namedTool: 'protect_get_snapshot',
});

/** Which RTSPS stream qualities exist; the URLs themselves never leave the service. */
export function streamQualities(streams: Record<string, string | null | undefined>): unknown {
  return Object.fromEntries(
    Object.entries(streams).map(([quality, url]) => [quality, typeof url === 'string']),
  );
}

export const getRtspsStreams = protectOperation('GET /v1/cameras/{id}/rtsps-stream', {
  operationId: 'protect.cameras.get_rtsps_streams',
  category: 'cameras',
  effect: 'read',
  description:
    'Which RTSPS stream qualities are enabled for a camera (true or false). The stream ' +
    'URLs grant access and are never returned.',
  project: streamQualities,
});

// Writes (ADR 0019 §6). Camera settings include motion and smart detection, so changing
// them can blind monitoring: high. Stream and PTZ actions are visible and reversible:
// medium. Disabling the microphone permanently cannot be undone: high, and off until a
// global policy enables it.
const CAMERA = deviceLock('cameras');

export const updateCamera = protectOperation('PATCH /v1/cameras/{id}', {
  operationId: 'protect.cameras.update',
  category: 'cameras',
  effect: 'write',
  description:
    'Change camera settings (name, video mode, HDR, LEDs, overlays, microphone, detection).',
  risk: 'high',
  approvalRequired: true,
  retryClass: 'idempotent',
  resourceLockKey: CAMERA,
});

export const createRtspsStreams = protectOperation('POST /v1/cameras/{id}/rtsps-stream', {
  operationId: 'protect.cameras.create_rtsps_streams',
  category: 'cameras',
  effect: 'write',
  description:
    'Enable RTSPS streams at the given qualities. Returns which qualities exist; the URLs ' +
    'grant access and are never returned.',
  risk: 'medium',
  approvalRequired: false,
  retryClass: 'non-idempotent',
  resourceLockKey: CAMERA,
  project: streamQualities,
});

export const deleteRtspsStreams = protectOperation('DELETE /v1/cameras/{id}/rtsps-stream', {
  operationId: 'protect.cameras.delete_rtsps_streams',
  category: 'cameras',
  effect: 'write',
  description: 'Disable RTSPS streams at the given qualities (their URLs stop working).',
  risk: 'medium',
  approvalRequired: false,
  retryClass: 'idempotent',
  resourceLockKey: CAMERA,
});

export const disableMicrophonePermanently = protectOperation(
  'POST /v1/cameras/{id}/disable-mic-permanently',
  {
    operationId: 'protect.cameras.disable_microphone_permanently',
    category: 'cameras',
    effect: 'write',
    description: 'Disable a camera microphone PERMANENTLY. This cannot be undone.',
    risk: 'high',
    approvalRequired: true,
    retryClass: 'non-idempotent',
    resourceLockKey: CAMERA,
    defaultDisabled: true,
  },
);

export const startTalkbackSession = protectOperation('POST /v1/cameras/{id}/talkback-session', {
  operationId: 'protect.cameras.start_talkback',
  category: 'cameras',
  effect: 'write',
  description:
    'Start a talkback session. Returns only the audio format: the session endpoint grants ' +
    'access and is never returned. Off by default.',
  risk: 'medium',
  approvalRequired: false,
  retryClass: 'non-idempotent',
  resourceLockKey: CAMERA,
  defaultDisabled: true,
});

export const ptzGoto = protectOperation('POST /v1/cameras/{id}/ptz/goto/{slot}', {
  operationId: 'protect.cameras.ptz_goto',
  category: 'cameras',
  effect: 'write',
  description: 'Move a PTZ camera to a saved preset position.',
  risk: 'medium',
  approvalRequired: false,
  retryClass: 'non-idempotent',
  resourceLockKey: CAMERA,
});

export const ptzStartPatrol = protectOperation('POST /v1/cameras/{id}/ptz/patrol/start/{slot}', {
  operationId: 'protect.cameras.ptz_start_patrol',
  category: 'cameras',
  effect: 'write',
  description: 'Start a saved PTZ patrol.',
  risk: 'medium',
  approvalRequired: false,
  retryClass: 'non-idempotent',
  resourceLockKey: CAMERA,
});

export const ptzStopPatrol = protectOperation('POST /v1/cameras/{id}/ptz/patrol/stop', {
  operationId: 'protect.cameras.ptz_stop_patrol',
  category: 'cameras',
  effect: 'write',
  description: 'Stop the current PTZ patrol.',
  risk: 'medium',
  approvalRequired: false,
  retryClass: 'non-idempotent',
  resourceLockKey: CAMERA,
});

export const createPosTransaction = protectOperation('POST /v1/pos/cameras/{id}/transactions', {
  operationId: 'protect.cameras.add_pos_transaction',
  category: 'cameras',
  effect: 'write',
  description: 'Attach a point-of-sale transaction to a camera recording.',
  risk: 'medium',
  approvalRequired: false,
  retryClass: 'non-idempotent',
  resourceLockKey: CAMERA,
});
