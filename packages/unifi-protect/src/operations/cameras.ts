/**
 * Cameras (reviewed 2026-11-11 against 7.4.96). Reads: low risk. The snapshot is a camera
 * image (its own sensitive grant); the RTSPS stream URLs carry access tokens and are never
 * returned, only which qualities exist (ADR 0019 §5).
 */
import { protectOperation } from '../define.ts';

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
