/**
 * Access policies, holiday groups and schedules (reviewed against the transcription: reads
 * 2026-11-13, ADR 0023 §3; writes 2026-11-14, ADR 0023 §4). Configuration only: which
 * locations a policy opens and when; no personal data.
 *
 * Writes: creating a policy, schedule or holiday group is medium risk, because nothing
 * uses it until it is assigned (a policy) or referenced (a schedule, a holiday group), and
 * that assignment is itself high risk. Changing or deleting one changes door access for
 * everyone who holds it, so it is high risk with human approval.
 */
import { accessOperation, consoleLock, HIGH, MEDIUM, objectLock } from '../define.ts';

export const getAccessPolicy = accessOperation('GET /api/v1/developer/access_policies/{id}', {
  operationId: 'access.policies.get',
  category: 'policies',
  effect: 'read',
  description: 'One access policy: the doors and door groups it opens, and its schedule.',
});

export const listAccessPolicies = accessOperation('GET /api/v1/developer/access_policies', {
  operationId: 'access.policies.list',
  category: 'policies',
  effect: 'read',
  description: 'Access policies, with the doors and door groups each opens.',
});

export const getHolidayGroup = accessOperation(
  'GET /api/v1/developer/access_policies/holiday_groups/{id}',
  {
    operationId: 'access.policies.get_holiday_group',
    category: 'policies',
    effect: 'read',
    description: 'One holiday group and its holidays.',
  },
);

export const listHolidayGroups = accessOperation(
  'GET /api/v1/developer/access_policies/holiday_groups',
  {
    operationId: 'access.policies.list_holiday_groups',
    category: 'policies',
    effect: 'read',
    description: 'Holiday groups, with the number of holidays in each.',
  },
);

export const getSchedule = accessOperation('GET /api/v1/developer/access_policies/schedules/{id}', {
  operationId: 'access.policies.get_schedule',
  category: 'policies',
  effect: 'read',
  description: 'One door access schedule: weekly periods, holiday group and holiday periods.',
});

export const listSchedules = accessOperation('GET /api/v1/developer/access_policies/schedules', {
  operationId: 'access.policies.list_schedules',
  category: 'policies',
  effect: 'read',
  description: 'Door access schedules.',
});

// Writes (reviewed 2026-11-14, ADR 0023 §4).

const POLICY = objectLock('policies', 'id');
const HOLIDAY_GROUP = objectLock('holiday_groups', 'id');
const SCHEDULE = objectLock('schedules', 'id');

export const createAccessPolicy = accessOperation('POST /api/v1/developer/access_policies', {
  ...MEDIUM,
  operationId: 'access.policies.create',
  category: 'policies',
  description: 'Create an access policy: doors or door groups and a schedule. Assigned to nobody.',
  retryClass: 'non-idempotent',
  resourceLockKey: consoleLock('policies'),
});

export const updateAccessPolicy = accessOperation('PUT /api/v1/developer/access_policies/{id}', {
  ...HIGH,
  operationId: 'access.policies.update',
  category: 'policies',
  description: "Change an access policy's name, doors or schedule.",
  retryClass: 'idempotent',
  resourceLockKey: POLICY,
  approvalCaution:
    'Changes which doors open, and when, for every user and group that holds this policy.',
});

export const deleteAccessPolicy = accessOperation('DELETE /api/v1/developer/access_policies/{id}', {
  ...HIGH,
  operationId: 'access.policies.delete',
  category: 'policies',
  description: 'Delete an access policy.',
  retryClass: 'idempotent',
  resourceLockKey: POLICY,
  approvalCaution: 'Users and groups that hold this policy may lose the door access it gives.',
});

export const createHolidayGroup = accessOperation(
  'POST /api/v1/developer/access_policies/holiday_groups',
  {
    ...MEDIUM,
    operationId: 'access.policies.create_holiday_group',
    category: 'policies',
    description: 'Create a holiday group (named dates). No schedule uses it yet.',
    retryClass: 'non-idempotent',
    resourceLockKey: consoleLock('holiday_groups'),
  },
);

export const updateHolidayGroup = accessOperation(
  'PUT /api/v1/developer/access_policies/holiday_groups/{id}',
  {
    ...HIGH,
    operationId: 'access.policies.update_holiday_group',
    category: 'policies',
    description: "Change a holiday group's name, description or holidays.",
    retryClass: 'idempotent',
    resourceLockKey: HOLIDAY_GROUP,
    approvalCaution:
      'Changes when doors open on holidays, for every schedule that uses this group.',
  },
);

export const deleteHolidayGroup = accessOperation(
  'DELETE /api/v1/developer/access_policies/holiday_groups/{id}',
  {
    ...HIGH,
    operationId: 'access.policies.delete_holiday_group',
    category: 'policies',
    description: 'Delete a holiday group.',
    retryClass: 'idempotent',
    resourceLockKey: HOLIDAY_GROUP,
  },
);

export const createSchedule = accessOperation('POST /api/v1/developer/access_policies/schedules', {
  ...MEDIUM,
  operationId: 'access.policies.create_schedule',
  category: 'policies',
  description: 'Create a weekly schedule, with holiday times. No policy uses it yet.',
  retryClass: 'non-idempotent',
  resourceLockKey: consoleLock('schedules'),
});

export const updateSchedule = accessOperation(
  'PUT /api/v1/developer/access_policies/schedules/{id}',
  {
    ...HIGH,
    operationId: 'access.policies.update_schedule',
    category: 'policies',
    description: "Change a schedule's name, weekly times, holiday group or holiday times.",
    retryClass: 'idempotent',
    resourceLockKey: SCHEDULE,
    approvalCaution: 'Changes when doors open for every access policy that uses this schedule.',
  },
);

export const deleteSchedule = accessOperation(
  'DELETE /api/v1/developer/access_policies/schedules/{id}',
  {
    ...HIGH,
    operationId: 'access.policies.delete_schedule',
    category: 'policies',
    description: 'Delete a schedule.',
    retryClass: 'idempotent',
    resourceLockKey: SCHEDULE,
  },
);
