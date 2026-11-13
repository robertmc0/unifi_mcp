/**
 * Doors, door groups and door states: reads (reviewed 2026-11-13, ADR 0023 §3).
 * Infrastructure: names, floors, lock and door-position states, lock rules and the
 * emergency state of all doors. No personal data.
 */
import { accessOperation } from '../define.ts';

export const getDoorTopology = accessOperation('GET /api/v1/developer/door_groups/topology', {
  operationId: 'access.spaces.get_topology',
  category: 'spaces',
  effect: 'read',
  description:
    'Buildings, floors and their doors, for assigning locations to policies and visitors.',
});

export const listDoorGroups = accessOperation('GET /api/v1/developer/door_groups', {
  operationId: 'access.spaces.list_door_groups',
  category: 'spaces',
  effect: 'read',
  description: 'Custom door groups and their doors.',
});

export const getDoorGroup = accessOperation('GET /api/v1/developer/door_groups/{id}', {
  operationId: 'access.spaces.get_door_group',
  category: 'spaces',
  effect: 'read',
  description: 'One door group (custom, or the building group of all doors) and its doors.',
});

export const listDoors = accessOperation('GET /api/v1/developer/doors', {
  operationId: 'access.spaces.list_doors',
  category: 'spaces',
  effect: 'read',
  description: 'Doors with their floor, lock state and door-position state.',
  namedTool: 'access_list_doors',
});

export const getDoor = accessOperation('GET /api/v1/developer/doors/{id}', {
  operationId: 'access.spaces.get_door',
  category: 'spaces',
  effect: 'read',
  description: 'One door: floor, lock state, door-position state and whether a hub can open it.',
  namedTool: 'access_get_door',
});

export const getDoorLockRule = accessOperation('GET /api/v1/developer/doors/{id}/lock_rule', {
  operationId: 'access.spaces.get_lock_rule',
  category: 'spaces',
  effect: 'read',
  description:
    "One door's temporary locking rule (kept locked or unlocked, custom) and when it ends.",
});

export const getEmergencyStatus = accessOperation(
  'GET /api/v1/developer/doors/settings/emergency',
  {
    operationId: 'access.spaces.get_emergency_status',
    category: 'spaces',
    effect: 'read',
    description: 'Whether all doors are in lockdown (kept locked) or evacuation (kept unlocked).',
  },
);
