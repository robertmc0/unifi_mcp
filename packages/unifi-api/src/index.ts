/**
 * @unifi-local-mcp/unifi-api
 *
 * The console registry, the egress allowlist with DNS re-validation, verified TLS
 * (CA, pinning, explicit insecure override), the bounded HTTPS transport and the
 * OperationExecutor that the dispatcher uses to reach consoles (ADR 0012), and the version
 * probes that learn each console module's application version (ADR 0018).
 */
export { checkConsoleConnection, type ConsoleCheck } from './check.ts';
export {
  ConsoleError,
  ConsoleRegistry,
  type ConsoleConnection,
  type ConsoleErrorCode,
  type ConsoleInput,
  type ConsoleModuleView,
  type ConsoleRegistryOptions,
  type ConsoleView,
  type ModuleVersion,
  type TlsTrustInput,
} from './consoles.ts';
export {
  DEFAULT_EGRESS_ALLOW,
  EGRESS_ALLOW_ENV,
  EgressError,
  EgressGuard,
  parseCidr,
  parseEgressPolicy,
  type EgressErrorCode,
  type EgressPolicy,
  type Lookup,
  type ResolvedAddress,
} from './egress.ts';
export { UnifiExecutor, type UnifiExecutorOptions } from './executor.ts';
export { loadContractInventory } from './inventory.ts';
export {
  PLAUSIBLE_VERSION,
  VersionMonitor,
  VersionProber,
  type ProbeResult,
  type VersionMonitorOptions,
  type VersionProberOptions,
  type VersionProbeSpec,
} from './probe.ts';
export {
  ACCESS_ENVELOPE,
  DECLARATION_TTL_MS,
  isModuleId,
  MODULE_ENDPOINTS,
  MODULE_IDS,
  type EnvelopeErrorClass,
  type ModuleEndpoint,
  type ModuleId,
  type ResultEnvelope,
} from './modules.ts';
export {
  connectTls,
  sendHttp,
  spkiSha256,
  TransportError,
  type ConnectOptions,
  type HttpRequest,
  type HttpResponse,
  type TlsTrust,
  type TransportErrorCode,
} from './transport.ts';
export {
  openWebSocket,
  WebSocketConnection,
  WebSocketError,
  type WebSocketClose,
  type WebSocketCloseCode,
  type WebSocketErrorCode,
  type WebSocketOptions,
} from './websocket.ts';
export {
  EventConnectError,
  UnifiEventConnector,
  type UnifiEventConnectorOptions,
} from './events.ts';
