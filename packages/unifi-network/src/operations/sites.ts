/** Sites (reviewed 2026-11-10 against 11.0.97). */
import { networkOperation, PAGED } from '../define.ts';

export const listSites = networkOperation('getSiteOverviewPage', {
  operationId: 'network.sites.list',
  category: 'sites',
  effect: 'read',
  description:
    'Sites on the console, with their siteId. Site-scoped operations need one of these ids.',
  namedTool: 'network_list_sites',
  ...PAGED,
});
