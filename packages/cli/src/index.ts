/**
 * @unifi-local-mcp/cli
 *
 * The host-only `unifi-mcp` administration CLI (spec §13.2; ADR 0015).
 */
export {
  BootstrapSchema,
  parseBootstrap,
  plan,
  prepare,
  apply,
  type BootstrapPlan,
  type PlanEntry,
} from './bootstrap.ts';
export { runCli, type Command, type CommandTable, type RunContext } from './cli.ts';
export { COMMANDS } from './commands/index.ts';
export { CliError, oneLine, processIo, terminalSafe, type CliIo } from './io.ts';
