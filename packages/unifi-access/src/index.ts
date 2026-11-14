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
import { deleteApiServerCertificate } from './operations/api-server.ts';
import { getDeviceAccessMethods, listDevices, ringDoorbell } from './operations/devices.ts';
import {
  cancelNfcEnrollment,
  deleteNfcCard,
  getNfcCard,
  getNfcEnrollment,
  getTouchPass,
  listAssignableTouchPasses,
  listNfcCards,
  listTouchPasses,
  purchaseTouchPasses,
  searchTouchPasses,
  startNfcEnrollment,
  updateNfcCard,
  updateTouchPass,
} from './operations/credentials.ts';
import { getLogResource, listSystemLogs } from './operations/logs.ts';
import {
  createAccessPolicy,
  createHolidayGroup,
  createSchedule,
  deleteAccessPolicy,
  deleteHolidayGroup,
  deleteSchedule,
  getAccessPolicy,
  getHolidayGroup,
  getSchedule,
  listAccessPolicies,
  listHolidayGroups,
  listSchedules,
  updateAccessPolicy,
  updateHolidayGroup,
  updateSchedule,
} from './operations/policies.ts';
import {
  createDoorGroup,
  deleteDoorGroup,
  getDoor,
  getDoorGroup,
  getDoorLockRule,
  getDoorTopology,
  getEmergencyStatus,
  listDoorGroups,
  listDoors,
  setDoorLockRule,
  setEmergencyStatus,
  unlockDoor,
  updateDoorGroup,
} from './operations/spaces.ts';
import {
  addUserGroupMembers,
  assignTouchPasses,
  assignUserAccessPolicies,
  assignUserGroupAccessPolicies,
  assignUserGroupIdentityResources,
  assignUserIdentityResources,
  assignUserLicensePlates,
  assignUserNfcCard,
  assignUserPin,
  assignUserTouchPass,
  createUser,
  createUserGroup,
  deleteUser,
  deleteUserGroup,
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
  removeUserGroupMembers,
  searchUsers,
  sendIdentityInvitations,
  unassignUserLicensePlate,
  unassignUserNfcCard,
  unassignUserPin,
  unassignUserTouchPass,
  updateUser,
  updateUserGroup,
} from './operations/users.ts';
import {
  assignVisitorNfcCard,
  assignVisitorPin,
  assignVisitorQrCode,
  createVisitor,
  deleteVisitor,
  getVisitor,
  listVisitors,
  unassignVisitorLicensePlate,
  unassignVisitorNfcCard,
  unassignVisitorPin,
  unassignVisitorQrCode,
  updateVisitor,
} from './operations/visitors.ts';
import {
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  listWebhookEndpoints,
  updateWebhookEndpoint,
} from './operations/webhooks.ts';

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

/**
 * Every documented Access write that is offered (58), reviewed 2026-11-14 (ADR 0023 §4):
 * 51 high risk with human approval, 7 medium; 7 off by default.
 */
export const ACCESS_WRITES: readonly OperationDescriptor[] = [
  // Users, their credentials and policies.
  createUser,
  updateUser,
  deleteUser,
  assignUserAccessPolicies,
  assignUserNfcCard,
  unassignUserNfcCard,
  assignUserPin,
  unassignUserPin,
  assignUserLicensePlates,
  unassignUserLicensePlate,
  assignUserTouchPass,
  unassignUserTouchPass,
  assignTouchPasses,
  // User groups.
  createUserGroup,
  updateUserGroup,
  deleteUserGroup,
  addUserGroupMembers,
  removeUserGroupMembers,
  assignUserGroupAccessPolicies,
  // UniFi Identity.
  sendIdentityInvitations,
  assignUserIdentityResources,
  assignUserGroupIdentityResources,
  // Visitors.
  createVisitor,
  updateVisitor,
  deleteVisitor,
  assignVisitorNfcCard,
  unassignVisitorNfcCard,
  assignVisitorPin,
  unassignVisitorPin,
  assignVisitorQrCode,
  unassignVisitorQrCode,
  unassignVisitorLicensePlate,
  // Access policies, holiday groups, schedules.
  createAccessPolicy,
  updateAccessPolicy,
  deleteAccessPolicy,
  createHolidayGroup,
  updateHolidayGroup,
  deleteHolidayGroup,
  createSchedule,
  updateSchedule,
  deleteSchedule,
  // Credentials.
  startNfcEnrollment,
  cancelNfcEnrollment,
  updateNfcCard,
  deleteNfcCard,
  purchaseTouchPasses,
  updateTouchPass,
  // Door control and door groups.
  unlockDoor,
  setDoorLockRule,
  setEmergencyStatus,
  createDoorGroup,
  updateDoorGroup,
  deleteDoorGroup,
  // Devices, webhooks, the API server.
  ringDoorbell,
  createWebhookEndpoint,
  updateWebhookEndpoint,
  deleteWebhookEndpoint,
  deleteApiServerCertificate,
];

/** Every implemented Access operation, registered by the service at startup. */
export const ACCESS_OPERATIONS: readonly OperationDescriptor[] = [
  ...ACCESS_READS,
  ...ACCESS_WRITES,
];
