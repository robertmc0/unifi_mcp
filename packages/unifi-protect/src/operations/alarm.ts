/**
 * The alarm manager (reviewed 2026-11-11 against 7.4.96): arm profiles of the local
 * alarm manager and external arm profiles. Reads: low risk; PINs are never returned (the
 * contract reports only `has_pin`).
 */
import { protectOperation } from '../define.ts';

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
