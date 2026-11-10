/** Switching: link aggregation, MC-LAG domains and switch stacks (reviewed 2026-11-10). */
import { networkOperation, PAGED } from '../define.ts';

export const listLags = networkOperation('getLagPage', {
  operationId: 'network.switching.list_lags',
  category: 'switching',
  effect: 'read',
  description: 'Link aggregation groups (LAGs) of a site and their member ports.',
  ...PAGED,
});

export const getLag = networkOperation('getLag', {
  operationId: 'network.switching.get_lag',
  category: 'switching',
  effect: 'read',
  description: 'One link aggregation group.',
});

export const listMcLagDomains = networkOperation('getMcLagDomainPage', {
  operationId: 'network.switching.list_mc_lag_domains',
  category: 'switching',
  effect: 'read',
  description: 'Multi-chassis LAG domains of a site, with their peers and LAGs.',
  ...PAGED,
});

export const getMcLagDomain = networkOperation('getMcLagDomain', {
  operationId: 'network.switching.get_mc_lag_domain',
  category: 'switching',
  effect: 'read',
  description: 'One multi-chassis LAG domain.',
});

export const listSwitchStacks = networkOperation('getSwitchStackPage', {
  operationId: 'network.switching.list_switch_stacks',
  category: 'switching',
  effect: 'read',
  description: 'Switch stacks of a site and their member units.',
  ...PAGED,
});

export const getSwitchStack = networkOperation('getSwitchStack', {
  operationId: 'network.switching.get_switch_stack',
  category: 'switching',
  effect: 'read',
  description: 'One switch stack.',
});
