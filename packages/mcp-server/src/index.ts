/**
 * @unifi-local-mcp/mcp-server
 *
 * The Streamable HTTP MCP endpoint: client tokens, the bearer and Host/Origin gate in front
 * of the MCP SDK v2 handler, the per-client tool set, service configuration and lifecycle
 * (ADR 0003, ADR 0013).
 */
export { ADAPTER_OPERATIONS, ADAPTER_PROBES, ADAPTERS, type ModuleAdapter } from './adapters.ts';
export {
  ClientError,
  ClientStore,
  type AuthenticatedClient,
  type ClientErrorCode,
  type ClientStoreOptions,
  type ClientView,
  type IssuedToken,
} from './clients.ts';
export {
  ConfigError,
  defaultApiSpecsDir,
  isLoopbackBind,
  loadServiceConfig,
  type HttpConfig,
  type AdminListenerConfig,
  type ServiceConfig,
} from './config.ts';
export {
  checkSubscription,
  eventUri,
  MAX_SUBSCRIBED_URIS,
  parseEventUri,
  registerEventResources,
  visibleStreams,
  type EventServices,
  type ParsedEventUri,
  type SubscriptionCheck,
} from './events.ts';
export {
  DEFAULT_LISTEN_LIMITS,
  MCP_PATH,
  McpHttpService,
  type ListenLimits,
  type McpHttpOptions,
} from './http.ts';
export {
  SERVICE_VERSION,
  startService,
  type RunningService,
  type ServiceOptions,
} from './service.ts';
export { buildMcpServer, discoverOperations, type ToolContext } from './tools.ts';
