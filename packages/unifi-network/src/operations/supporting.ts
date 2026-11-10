/**
 * Supporting resources (reviewed 2026-11-10 against 11.0.97): VPN, WANs, RADIUS profiles
 * and reference data used as values in other operations.
 */
import { networkOperation, PAGED } from '../define.ts';

export const listVpnServers = networkOperation('getVpnServerPage', {
  operationId: 'network.vpn.list_servers',
  category: 'vpn',
  effect: 'read',
  description: 'VPN servers of a site: name, type and whether enabled.',
  ...PAGED,
});

export const listSiteToSiteVpnTunnels = networkOperation('getSiteToSiteVpnTunnelPage', {
  operationId: 'network.vpn.list_site_to_site_tunnels',
  category: 'vpn',
  effect: 'read',
  description: 'Site-to-site VPN tunnels of a site.',
  ...PAGED,
});

export const listWans = networkOperation('getWansOverviewPage', {
  operationId: 'network.wans.list',
  category: 'wans',
  effect: 'read',
  description: 'WAN interfaces of a site.',
  ...PAGED,
});

export const listRadiusProfiles = networkOperation('getRadiusProfileOverviewPage', {
  operationId: 'network.radius.list_profiles',
  category: 'radius',
  effect: 'read',
  description: 'RADIUS profiles of a site (names and ids; no secrets are documented).',
  ...PAGED,
});

export const listCountries = networkOperation('getCountries', {
  operationId: 'network.reference.list_countries',
  category: 'reference',
  effect: 'read',
  description: 'Country codes and names, for operations that take a country.',
  ...PAGED,
});

export const listDpiApplications = networkOperation('getDpiApplications', {
  operationId: 'network.reference.list_dpi_applications',
  category: 'reference',
  effect: 'read',
  description: 'Applications known to deep packet inspection (DPI), with ids for policies.',
  ...PAGED,
});

export const listDpiCategories = networkOperation('getDpiApplicationCategories', {
  operationId: 'network.reference.list_dpi_categories',
  category: 'reference',
  effect: 'read',
  description: 'DPI application categories, with ids for policies.',
  ...PAGED,
});
