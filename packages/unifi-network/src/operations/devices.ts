/** UniFi devices (reviewed 2026-11-10 against 11.0.97). Infrastructure, not people. */
import { networkOperation, PAGED } from '../define.ts';

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
