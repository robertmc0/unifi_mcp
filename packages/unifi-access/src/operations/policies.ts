/**
 * Access policies, holiday groups and schedules: reads (reviewed 2026-11-13, ADR 0023 §3).
 * Configuration only: which locations a policy opens and when; no personal data.
 */
import { accessOperation } from '../define.ts';

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
