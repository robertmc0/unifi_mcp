/**
 * Protect devices other than cameras (reviewed 2026-11-11 against 7.4.96). Reads: low
 * risk. Fobs report whether they are in range, which says whether the person carrying
 * one is at the site, so they need the `location` grant (ADR 0019 §5).
 */
import { protectOperation } from '../define.ts';

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
