/** The `unifi-mcp` command table (spec §13.2). */
import type { CommandTable } from '../cli.ts';
import { auditCommands } from './audit.ts';
import { consoleCommands } from './consoles.ts';
import { approvalCommands, policyCommands } from './governance.ts';
import { adminCommands, clientCommands } from './identities.ts';
import { cryptoCommands, dbCommands } from './maintenance.ts';
import { apiCoverageCommand, configCommands, doctorCommand } from './operations.ts';

export const COMMANDS: CommandTable = {
  admin: adminCommands,
  client: clientCommands,
  console: consoleCommands,
  policy: policyCommands,
  approvals: approvalCommands,
  config: configCommands,
  crypto: cryptoCommands,
  db: dbCommands,
  audit: auditCommands,
  doctor: { '': doctorCommand },
  api: { coverage: apiCoverageCommand },
};
