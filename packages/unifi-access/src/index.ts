/**
 * @unifi-local-mcp/unifi-access
 *
 * The official local UniFi Access API adapter (ADR 0023): request and response schemas
 * generated from this project's transcription of the Access API reference PDF (ADR 0022),
 * and the hand-reviewed security metadata of every implemented operation. Only operations
 * recorded in `api-specs/access/` can be implemented here. Access reports no version: an
 * administrator declares it (ADR 0021 §5).
 */
import type { OperationDescriptor } from '@unifi-local-mcp/core';
import { getDeviceAccessMethods, listDevices } from './operations/devices.ts';
import {
  getNfcCard,
  getNfcEnrollment,
  getTouchPass,
  listAssignableTouchPasses,
  listNfcCards,
  listTouchPasses,
  searchTouchPasses,
} from './operations/credentials.ts';
import { getLogResource, listSystemLogs } from './operations/logs.ts';
import {
  getAccessPolicy,
  getHolidayGroup,
  getSchedule,
  listAccessPolicies,
  listHolidayGroups,
  listSchedules,
} from './operations/policies.ts';
import {
  getDoor,
  getDoorGroup,
  getDoorLockRule,
  getDoorTopology,
  getEmergencyStatus,
  listDoorGroups,
  listDoors,
} from './operations/spaces.ts';
import {
  getUser,
  getUserGroup,
  listAllUserGroupMembers,
  listIdentityResources,
  listUserAccessPolicies,
  listUserGroupAccessPolicies,
  listUserGroupIdentityResources,
  listUserGroupMembers,
  listUserGroups,
  listUserIdentityResources,
  listUsers,
  searchUsers,
} from './operations/users.ts';
import { getVisitor, listVisitors } from './operations/visitors.ts';
import { listWebhookEndpoints } from './operations/webhooks.ts';

export { ACCESS_CONTRACT_REVISION, ACCESS_MAX_VERSION, pageOf } from './define.ts';
export { ALWAYS_REMOVED, withoutCredentials } from './credentials.ts';
export { MAX_LOG_PAGE_SIZE, MAX_LOG_WINDOW_SECONDS } from './operations/logs.ts';

/** Every documented Access read (39), reviewed 2026-11-13 (ADR 0023 §3). */
export const ACCESS_READS: readonly OperationDescriptor[] = [
  getUser,
  listUsers,
  searchUsers,
  listUserAccessPolicies,
  listUserGroups,
  getUserGroup,
  listUserGroupMembers,
  listAllUserGroupMembers,
  listUserGroupAccessPolicies,
  listIdentityResources,
  listUserIdentityResources,
  listUserGroupIdentityResources,
  getVisitor,
  listVisitors,
  getAccessPolicy,
  listAccessPolicies,
  getHolidayGroup,
  listHolidayGroups,
  getSchedule,
  listSchedules,
  getNfcEnrollment,
  getNfcCard,
  listNfcCards,
  listTouchPasses,
  searchTouchPasses,
  listAssignableTouchPasses,
  getTouchPass,
  getDoorTopology,
  listDoorGroups,
  getDoorGroup,
  listDoors,
  getDoor,
  getDoorLockRule,
  getEmergencyStatus,
  listDevices,
  getDeviceAccessMethods,
  listSystemLogs,
  getLogResource,
  listWebhookEndpoints,
];

/** Every implemented Access operation, registered by the service at startup. */
export const ACCESS_OPERATIONS: readonly OperationDescriptor[] = [...ACCESS_READS];
