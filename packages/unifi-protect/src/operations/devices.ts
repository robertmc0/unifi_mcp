/**
 * Protect devices other than cameras (reviewed 2026-11-11 against 7.4.96). Reads: low
 * risk. Fobs report whether they are in range, which says whether the person carrying
 * one is at the site, so they need the `location` grant (ADR 0019 §5).
 */
import { deviceLock, protectOperation } from '../define.ts';

export const listLights = protectOperation('GET /v1/lights', {
  operationId: 'protect.lights.list',
  category: 'lights',
  effect: 'read',
  description: 'Floodlights: state, light mode and motion settings.',
});

export const getLight = protectOperation('GET /v1/lights/{id}', {
  operationId: 'protect.lights.get',
  category: 'lights',
  effect: 'read',
  description: 'One floodlight and its settings.',
});

export const listSensors = protectOperation('GET /v1/sensors', {
  operationId: 'protect.sensors.list',
  category: 'sensors',
  effect: 'read',
  description: 'Sensors: state, mount type and the readings and alerts they are set up for.',
});

export const getSensor = protectOperation('GET /v1/sensors/{id}', {
  operationId: 'protect.sensors.get',
  category: 'sensors',
  effect: 'read',
  description: 'One sensor and its settings.',
});

export const listSirens = protectOperation('GET /v1/sirens', {
  operationId: 'protect.sirens.list',
  category: 'sirens',
  effect: 'read',
  description: 'Sirens and their settings.',
});

export const getSiren = protectOperation('GET /v1/sirens/{id}', {
  operationId: 'protect.sirens.get',
  category: 'sirens',
  effect: 'read',
  description: 'One siren and its settings.',
});

export const listSpeakers = protectOperation('GET /v1/speakers', {
  operationId: 'protect.speakers.list',
  category: 'speakers',
  effect: 'read',
  description: 'Speakers and their settings.',
});

export const getSpeaker = protectOperation('GET /v1/speakers/{id}', {
  operationId: 'protect.speakers.get',
  category: 'speakers',
  effect: 'read',
  description: 'One speaker and its settings.',
});

export const listChimes = protectOperation('GET /v1/chimes', {
  operationId: 'protect.chimes.list',
  category: 'chimes',
  effect: 'read',
  description: 'Chimes: paired doorbells, volume and ring settings.',
});

export const getChime = protectOperation('GET /v1/chimes/{id}', {
  operationId: 'protect.chimes.get',
  category: 'chimes',
  effect: 'read',
  description: 'One chime and its settings.',
});

export const listRelays = protectOperation('GET /v1/relays', {
  operationId: 'protect.relays.list',
  category: 'relays',
  effect: 'read',
  description: 'Relays and their outputs.',
});

export const getRelay = protectOperation('GET /v1/relays/{id}', {
  operationId: 'protect.relays.get',
  category: 'relays',
  effect: 'read',
  description: 'One relay and its outputs.',
});

export const listBridges = protectOperation('GET /v1/bridges', {
  operationId: 'protect.bridges.list',
  category: 'bridges',
  effect: 'read',
  description: 'Bridges that connect wireless Protect devices.',
});

export const getBridge = protectOperation('GET /v1/bridges/{id}', {
  operationId: 'protect.bridges.get',
  category: 'bridges',
  effect: 'read',
  description: 'One bridge.',
});

export const listLinkStations = protectOperation('GET /v1/link-stations', {
  operationId: 'protect.link_stations.list',
  category: 'link_stations',
  effect: 'read',
  description: 'Link stations and their wireless networks.',
});

export const getLinkStation = protectOperation('GET /v1/link-stations/{id}', {
  operationId: 'protect.link_stations.get',
  category: 'link_stations',
  effect: 'read',
  description: 'One link station.',
});

export const listAlarmHubs = protectOperation('GET /v1/alarm-hubs', {
  operationId: 'protect.alarm_hubs.list',
  category: 'alarm_hubs',
  effect: 'read',
  description: 'Alarm hubs: inputs, outputs and the status of their terminals.',
});

export const getAlarmHub = protectOperation('GET /v1/alarm-hubs/{id}', {
  operationId: 'protect.alarm_hubs.get',
  category: 'alarm_hubs',
  effect: 'read',
  description: 'One alarm hub and its terminals.',
});

export const listFobs = protectOperation('GET /v1/fobs', {
  operationId: 'protect.fobs.list',
  category: 'fobs',
  effect: 'read',
  description: 'Key fobs, including whether each is in range (so whether its holder is near).',
  sensitivityTags: ['location'],
});

export const getFob = protectOperation('GET /v1/fobs/{id}', {
  operationId: 'protect.fobs.get',
  category: 'fobs',
  effect: 'read',
  description: 'One key fob and its presence state.',
  sensitivityTags: ['location'],
});

export const listNvrs = protectOperation('GET /v1/nvrs', {
  operationId: 'protect.nvrs.list',
  category: 'nvrs',
  effect: 'read',
  description: 'The recorder (NVR): arm mode, doorbell settings and features.',
});

// Writes (ADR 0019 §6). Anything that can silence or disable an alarm, a sensor's alerts
// or a security device, or acts in the physical world (sirens, relays, alarm outputs),
// is high risk. Comfort settings and audible tests are medium.
interface DeviceWrite {
  operationId: string;
  category: string;
  description: string;
  risk: 'medium' | 'high';
  retryClass: 'idempotent' | 'non-idempotent';
}

function write(spec: DeviceWrite) {
  return {
    ...spec,
    effect: 'write' as const,
    approvalRequired: spec.risk === 'high',
    resourceLockKey: deviceLock(spec.category),
  };
}

export const updateLight = protectOperation(
  'PATCH /v1/lights/{id}',
  write({
    operationId: 'protect.lights.update',
    category: 'lights',
    description: 'Change floodlight settings (mode, brightness, motion sensitivity).',
    risk: 'medium',
    retryClass: 'idempotent',
  }),
);

export const updateSensor = protectOperation(
  'PATCH /v1/sensors/{id}',
  write({
    operationId: 'protect.sensors.update',
    category: 'sensors',
    description: 'Change sensor settings, including which readings raise alerts.',
    risk: 'high',
    retryClass: 'idempotent',
  }),
);

export const updateSiren = protectOperation(
  'PATCH /v1/sirens/{id}',
  write({
    operationId: 'protect.sirens.update',
    category: 'sirens',
    description: 'Change siren settings (volume, duration).',
    risk: 'high',
    retryClass: 'idempotent',
  }),
);

export const playSiren = protectOperation(
  'POST /v1/sirens/{id}/play',
  write({
    operationId: 'protect.sirens.play',
    category: 'sirens',
    description: 'Sound a siren.',
    risk: 'high',
    retryClass: 'non-idempotent',
  }),
);

export const stopSiren = protectOperation(
  'POST /v1/sirens/{id}/stop',
  write({
    operationId: 'protect.sirens.stop',
    category: 'sirens',
    description: 'Stop a sounding siren (which may be a real alarm).',
    risk: 'high',
    retryClass: 'non-idempotent',
  }),
);

export const testSiren = protectOperation(
  'POST /v1/sirens/{id}/test-sound',
  write({
    operationId: 'protect.sirens.test_sound',
    category: 'sirens',
    description: 'Play a short test sound on a siren.',
    risk: 'medium',
    retryClass: 'non-idempotent',
  }),
);

export const updateSpeaker = protectOperation(
  'PATCH /v1/speakers/{id}',
  write({
    operationId: 'protect.speakers.update',
    category: 'speakers',
    description: 'Change speaker settings (volume and the like).',
    risk: 'medium',
    retryClass: 'idempotent',
  }),
);

export const testSpeaker = protectOperation(
  'POST /v1/speakers/{id}/test-sound',
  write({
    operationId: 'protect.speakers.test_sound',
    category: 'speakers',
    description: 'Play a short test sound on a speaker.',
    risk: 'medium',
    retryClass: 'non-idempotent',
  }),
);

export const stopSpeakerSiren = protectOperation(
  'POST /v1/speakers/{id}/stop-siren',
  write({
    operationId: 'protect.speakers.stop_siren',
    category: 'speakers',
    description: 'Stop a siren sound playing on a speaker (which may be a real alarm).',
    risk: 'high',
    retryClass: 'non-idempotent',
  }),
);

export const updateChime = protectOperation(
  'PATCH /v1/chimes/{id}',
  write({
    operationId: 'protect.chimes.update',
    category: 'chimes',
    description: 'Change chime settings (volume, ring tones, paired doorbells).',
    risk: 'medium',
    retryClass: 'idempotent',
  }),
);

export const updateRelay = protectOperation(
  'PATCH /v1/relays/{id}',
  write({
    operationId: 'protect.relays.update',
    category: 'relays',
    description: 'Change relay settings. Relays can drive doors, gates and alarms.',
    risk: 'high',
    retryClass: 'idempotent',
  }),
);

export const activateRelayOutput = protectOperation(
  'POST /v1/relays/{id}/outputs/{outputId}/activate',
  write({
    operationId: 'protect.relays.activate_output',
    category: 'relays',
    description: 'Switch a relay output, which may open a door or gate.',
    risk: 'high',
    retryClass: 'non-idempotent',
  }),
);

export const updateBridge = protectOperation(
  'PATCH /v1/bridges/{id}',
  write({
    operationId: 'protect.bridges.update',
    category: 'bridges',
    description: 'Change bridge settings.',
    risk: 'medium',
    retryClass: 'idempotent',
  }),
);

export const updateLinkStation = protectOperation(
  'PATCH /v1/link-stations/{id}',
  write({
    operationId: 'protect.link_stations.update',
    category: 'link_stations',
    description: 'Change link station settings, including the wireless network its sensors use.',
    risk: 'high',
    retryClass: 'idempotent',
  }),
);

export const updateAlarmHub = protectOperation(
  'PATCH /v1/alarm-hubs/{id}',
  write({
    operationId: 'protect.alarm_hubs.update',
    category: 'alarm_hubs',
    description: 'Change alarm hub settings (inputs, outputs, terminals).',
    risk: 'high',
    retryClass: 'idempotent',
  }),
);

export const triggerAlarmHubOutput = protectOperation(
  'POST /v1/alarm-hubs/{id}/outputs/{outputId}/trigger',
  write({
    operationId: 'protect.alarm_hubs.trigger_output',
    category: 'alarm_hubs',
    description: 'Trigger an alarm hub output (a siren, strobe or relay wired to it).',
    risk: 'high',
    retryClass: 'non-idempotent',
  }),
);

export const updateFob = protectOperation(
  'PATCH /v1/fobs/{id}',
  write({
    operationId: 'protect.fobs.update',
    category: 'fobs',
    description: 'Change fob settings, including whether it may arm and disarm the alarm.',
    risk: 'high',
    retryClass: 'idempotent',
  }),
);
