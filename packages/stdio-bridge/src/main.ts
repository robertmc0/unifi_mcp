/**
 * stdio bridge entry point: `node packages/stdio-bridge/src/main.ts` (or the built
 * `dist/main.js`). An MCP harness starts it as a local stdio server.
 *
 * stdout carries MCP protocol frames only. Everything else (logs, warnings, errors) goes to
 * stderr; `console` output is redirected to stderr too, in case any dependency writes to it.
 *
 * Exit codes: 0 when the harness closes stdin or on SIGTERM/SIGINT; 1 when the service
 * rejects the token; 2 for invalid configuration.
 */
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createLogger } from '@unifi-local-mcp/telemetry/logger';
import { BridgeConfigError, loadBridgeConfig } from './config.ts';
import { Relay } from './relay.ts';
import { redirectConsole } from './stdout-guard.ts';

// Never let anything but protocol frames reach stdout.
redirectConsole(process.stderr);

const logger = createLogger({
  level: 'warn',
  sink: process.stderr,
  bindings: { component: 'unifi-local-mcp-stdio-bridge' },
});

let config;
try {
  config = await loadBridgeConfig(process.env);
} catch (error) {
  logger.error(error instanceof BridgeConfigError ? error.message : 'invalid configuration', {
    ...(error instanceof BridgeConfigError ? {} : { err: error }),
  });
  process.exit(2);
}

const runtime = createLogger({
  level: config.logLevel,
  sink: process.stderr,
  bindings: { component: 'unifi-local-mcp-stdio-bridge' },
});
for (const warning of config.warnings) runtime.warn(warning);

const token = config.token;
const upstream = new StreamableHTTPClientTransport(config.url, {
  // The SDK default, pinned: no cross-origin redirects. `redirect: 'error'` below also
  // refuses same-origin ones, so the token is only ever sent to the configured URL.
  redirectPolicy: 'same-origin',
  fetch: (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set('authorization', `Bearer ${token}`);
    // Never follow a redirect with the token.
    return fetch(input, { ...init, headers, redirect: 'error' });
  },
});

const relay = new Relay({
  downstream: new StdioServerTransport(),
  upstream,
  logger: runtime,
  onFatal: () => {
    process.exitCode = 1;
    void relay.close();
  },
  onClosed: () => {
    process.exit();
  },
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void relay.close();
  });
}

await relay.start();
runtime.info('bridge ready', { service: config.url.origin });
