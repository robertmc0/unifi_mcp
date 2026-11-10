/** UniFi devices (reviewed 2026-11-10 against 11.0.97). Infrastructure, not people. */
import { networkOperation, PAGED, siteLock } from '../define.ts';

export const listDevices = networkOperation('getAdoptedDeviceOverviewPage', {
  operationId: 'network.devices.list',
  category: 'devices',
  effect: 'read',
  description:
    'Adopted UniFi devices of a site: id, name, model, state, firmware, IP and MAC address.',
  namedTool: 'network_list_devices',
  ...PAGED,
});

export const getDevice = networkOperation('getAdoptedDeviceDetails', {
  operationId: 'network.devices.get',
  category: 'devices',
  effect: 'read',
  description: 'One adopted device in detail, including its interfaces and uplink.',
  namedTool: 'network_get_device',
});

export const getDeviceStatistics = networkOperation('getAdoptedDeviceLatestStatistics', {
  operationId: 'network.devices.get_statistics',
  category: 'devices',
  effect: 'read',
  description: 'Latest statistics of one device: uptime, CPU, memory, load and interfaces.',
});

export const listPendingDevices = networkOperation('getPendingDevicePage', {
  operationId: 'network.devices.list_pending',
  category: 'devices',
  effect: 'read',
  description: 'Devices waiting to be adopted, with model, firmware and addresses.',
  ...PAGED,
});

export const listDeviceTags = networkOperation('getDeviceTagPage', {
  operationId: 'network.devices.list_tags',
  category: 'devices',
  effect: 'read',
  description: 'Device tags of a site and the devices they are attached to.',
  ...PAGED,
});

// Writes: adoption, removal and restarts are high risk (spec §6.3). Removing a device
// resets it to defaults, so it is also disabled until a global policy enables it.

export const adoptDevice = networkOperation('adoptDevice', {
  operationId: 'network.devices.adopt',
  category: 'devices',
  effect: 'write',
  risk: 'high',
  approvalRequired: true,
  retryClass: 'non-idempotent',
  resourceLockKey: siteLock('adoption'),
  description: 'Adopt a pending device into the site by its MAC address. Needs human approval.',
});

export const removeDevice = networkOperation('removeDevice', {
  operationId: 'network.devices.remove',
  category: 'devices',
  effect: 'write',
  risk: 'high',
  approvalRequired: true,
  defaultDisabled: true,
  retryClass: 'idempotent',
  resourceLockKey: (args) => `device:${args.deviceId}`,
  description:
    'Remove (forget) an adopted device; it is reset. Disabled by default; needs human approval.',
});

export const restartDevice = networkOperation('executeAdoptedDeviceAction', {
  operationId: 'network.devices.run_action',
  category: 'devices',
  effect: 'write',
  risk: 'high',
  approvalRequired: true,
  retryClass: 'non-idempotent',
  resourceLockKey: (args) => `device:${args.deviceId}`,
  description: 'Run a device action: RESTART (the only documented one). Needs human approval.',
});

export const powerCyclePort = networkOperation('executePortAction', {
  operationId: 'network.devices.run_port_action',
  category: 'devices',
  effect: 'write',
  risk: 'high',
  approvalRequired: true,
  retryClass: 'non-idempotent',
  resourceLockKey: (args) => `device:${args.deviceId}`,
  description:
    'Run a port action: POWER_CYCLE cuts PoE power to the port briefly. Needs human approval.',
});
