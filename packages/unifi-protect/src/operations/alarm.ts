/**
 * The alarm manager (reviewed 2026-11-11 against 7.4.96): arm profiles of the local
 * alarm manager and external arm profiles. Reads: low risk; PINs are never returned (the
 * contract reports only `has_pin`).
 */
import { consoleLock, protectOperation } from '../define.ts';

export const listArmProfiles = protectOperation('GET /v1/arm-profiles', {
  operationId: 'protect.alarm.list_arm_profiles',
  category: 'alarm',
  effect: 'read',
  description: 'Arm profiles of the local alarm manager and their schedules.',
});

export const listExternalArmProfiles = protectOperation('GET /v1/external/arm-profiles', {
  operationId: 'protect.alarm.list_external_profiles',
  category: 'alarm',
  effect: 'read',
  description: 'External arm profiles: state (armed, disarmed …), delays and alarms.',
});

export const getExternalArmProfile = protectOperation('GET /v1/external/arm-profiles/{id}', {
  operationId: 'protect.alarm.get_external_profile',
  category: 'alarm',
  effect: 'read',
  description: 'One external arm profile.',
});

// Writes (ADR 0019 §6). Arming and disarming a security system is like locking and
// unlocking a door (spec §6.3): every alarm-manager write is high risk and needs human
// approval. PINs sent in requests are redacted in audit entries and approval summaries.
const ALARM = consoleLock('alarm');
const HIGH = {
  category: 'alarm',
  effect: 'write',
  risk: 'high',
  approvalRequired: true,
  resourceLockKey: ALARM,
} as const;

export const createArmProfile = protectOperation('POST /v1/arm-profiles', {
  ...HIGH,
  operationId: 'protect.alarm.create_arm_profile',
  description: 'Create an arm profile for the local alarm manager.',
  retryClass: 'non-idempotent',
});

export const updateArmProfileSettings = protectOperation('PATCH /v1/arm-profiles/settings', {
  ...HIGH,
  operationId: 'protect.alarm.update_settings',
  description: 'Change the local alarm manager settings shared by all arm profiles.',
  retryClass: 'idempotent',
});

export const updateArmProfile = protectOperation('PATCH /v1/arm-profiles/{id}', {
  ...HIGH,
  operationId: 'protect.alarm.update_arm_profile',
  description: 'Change an arm profile of the local alarm manager.',
  retryClass: 'idempotent',
});

export const deleteArmProfile = protectOperation('DELETE /v1/arm-profiles/{id}', {
  ...HIGH,
  operationId: 'protect.alarm.delete_arm_profile',
  description: 'Delete an arm profile of the local alarm manager.',
  retryClass: 'idempotent',
});

export const armLocal = protectOperation('POST /v1/arm-profiles/enable', {
  ...HIGH,
  operationId: 'protect.alarm.arm',
  description: 'Arm the local alarm manager.',
  retryClass: 'non-idempotent',
});

export const disarmLocal = protectOperation('POST /v1/arm-profiles/disable', {
  ...HIGH,
  operationId: 'protect.alarm.disarm',
  description: 'Disarm the local alarm manager.',
  retryClass: 'non-idempotent',
});

export const triggerAlarmWebhook = protectOperation('POST /v1/alarm-manager/webhook/{id}', {
  ...HIGH,
  operationId: 'protect.alarm.trigger_webhook',
  description: 'Trigger an alarm manager webhook (its configured alarm and actions run).',
  retryClass: 'non-idempotent',
});

export const createExternalArmProfile = protectOperation('POST /v1/external/arm-profiles', {
  ...HIGH,
  operationId: 'protect.alarm.create_external_profile',
  description: 'Create an external arm profile (with an optional PIN).',
  retryClass: 'non-idempotent',
});

export const updateExternalArmProfile = protectOperation('PATCH /v1/external/arm-profiles/{id}', {
  ...HIGH,
  operationId: 'protect.alarm.update_external_profile',
  description: 'Change an external arm profile (delays, schedule, alarms, PIN).',
  retryClass: 'idempotent',
});

export const deleteExternalArmProfile = protectOperation('DELETE /v1/external/arm-profiles/{id}', {
  ...HIGH,
  operationId: 'protect.alarm.delete_external_profile',
  description: 'Delete an external arm profile.',
  retryClass: 'idempotent',
});

export const armExternal = protectOperation('POST /v1/external/arm-profiles/{id}/actions/arm', {
  ...HIGH,
  operationId: 'protect.alarm.arm_external_profile',
  description: 'Arm an external arm profile.',
  retryClass: 'non-idempotent',
});

export const disarmExternal = protectOperation(
  'POST /v1/external/arm-profiles/{id}/actions/disarm',
  {
    ...HIGH,
    operationId: 'protect.alarm.disarm_external_profile',
    description: 'Disarm an external arm profile.',
    retryClass: 'non-idempotent',
  },
);
