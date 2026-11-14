/**
 * Doors, door groups and door states (reviewed against the transcription: reads 2026-11-13,
 * ADR 0023 §3; writes 2026-11-14, ADR 0023 §4). Infrastructure: names, floors, lock and
 * door-position states, lock rules and the emergency state of all doors. No personal data.
 *
 * Writes:
 * - **Door control** (`access.doors.write`, its own permission, so a client can manage
 *   door groups without being able to open a door): the remote unlock, temporary lock
 *   rules and the emergency state are physical-access actions, high risk with human
 *   approval whatever their HTTP method (spec §6.3). The emergency state acts on every door
 *   at once and is off by default. The unlock does not accept `actor_id` and `actor_name`:
 *   a model must not choose whose name the console's access log records for an unlock.
 * - **Door groups** (`access.spaces.write`): a new group is medium, because no policy uses
 *   it yet; changing or deleting one changes every policy that includes it, so high.
 */
import { accessOperation, consoleLock, HIGH, MEDIUM, objectLock } from '../define.ts';

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

// Writes (reviewed 2026-11-14, ADR 0023 §4).

const DOOR = objectLock('doors', 'id');
const DOOR_GROUP = objectLock('door_groups', 'id');

export const unlockDoor = accessOperation('PUT /api/v1/developer/doors/{id}/unlock', {
  ...HIGH,
  operationId: 'access.doors.unlock',
  category: 'doors',
  description:
    'Unlock a door remotely, or open, close or stop a gate (control_cmd, Access 4.2.16).',
  retryClass: 'non-idempotent',
  resourceLockKey: DOOR,
  approvalCaution:
    'This unlocks a physical door or moves a gate: anyone there can pass while it is open.',
  // Reviewed narrowing: the console records actor_id and actor_name as who unlocked the
  // door. The service sends no body, so the model cannot write a name into that log.
  narrowInput: (input) => input.omit({ body: true }) as unknown as typeof input,
});

export const setDoorLockRule = accessOperation('PUT /api/v1/developer/doors/{id}/lock_rule', {
  ...HIGH,
  operationId: 'access.doors.set_lock_rule',
  category: 'doors',
  description:
    'Set a temporary rule on a door: keep it locked or unlocked, unlock for a while, or end the rule.',
  retryClass: 'idempotent',
  resourceLockKey: DOOR,
  approvalCaution:
    'keep_unlock and custom leave the door unlocked until the rule ends or is reset.',
});

export const setEmergencyStatus = accessOperation(
  'PUT /api/v1/developer/doors/settings/emergency',
  {
    ...HIGH,
    operationId: 'access.doors.set_emergency',
    category: 'doors',
    description: 'Switch lockdown (all doors locked) or evacuation (all doors unlocked) on or off.',
    retryClass: 'idempotent',
    resourceLockKey: consoleLock('emergency'),
    defaultDisabled: true,
    approvalCaution:
      'Evacuation unlocks every door of this console and lockdown locks every door, until switched off.',
  },
);

export const createDoorGroup = accessOperation('POST /api/v1/developer/door_groups', {
  ...MEDIUM,
  operationId: 'access.spaces.create_door_group',
  category: 'spaces',
  description: 'Create a door group. No policy uses it yet.',
  retryClass: 'non-idempotent',
  resourceLockKey: consoleLock('door_groups'),
});

export const updateDoorGroup = accessOperation('PUT /api/v1/developer/door_groups/{id}', {
  ...HIGH,
  operationId: 'access.spaces.update_door_group',
  category: 'spaces',
  description: 'Rename a door group or change its doors.',
  retryClass: 'idempotent',
  resourceLockKey: DOOR_GROUP,
  approvalCaution: 'Changes the doors of every access policy and visitor that includes this group.',
});

export const deleteDoorGroup = accessOperation('DELETE /api/v1/developer/door_groups/{id}', {
  ...HIGH,
  operationId: 'access.spaces.delete_door_group',
  category: 'spaces',
  description: 'Delete a door group.',
  retryClass: 'idempotent',
  resourceLockKey: DOOR_GROUP,
});
