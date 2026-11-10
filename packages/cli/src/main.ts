#!/usr/bin/env node
/**
 * `unifi-mcp`: host-only administration (spec §13.2). Run it on the service host, or inside
 * the container with `docker exec -it`. It must never be made available to an AI agent.
 */
import { runCli } from './cli.ts';
import { COMMANDS } from './commands/index.ts';
import { processIo } from './io.ts';

process.exitCode = await runCli(COMMANDS, process.argv.slice(2), processIo(), process.env);
