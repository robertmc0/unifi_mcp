/**
 * @unifi-local-mcp/stdio-bridge
 *
 * A local stdio MCP server that relays every message to the central service over
 * authenticated Streamable HTTP (ADR 0003, ADR 0014). It holds one client token and nothing
 * else: no UniFi credentials, no database and no console connectivity.
 */
export {
  BridgeConfigError,
  LOG_LEVEL_ENV,
  loadBridgeConfig,
  parseServiceUrl,
  TOKEN_ENV,
  TOKEN_FILE_ENV,
  URL_ENV,
  type BridgeConfig,
} from './config.ts';
export {
  BRIDGE_ERROR,
  Relay,
  type RelayOptions,
  type RelayTransport,
  type UpstreamTransport,
} from './relay.ts';
export { redirectConsole } from './stdout-guard.ts';
