/**
 * @unifi-local-mcp/unifi-api
 *
 * The console registry, the egress allowlist with DNS re-validation, verified TLS
 * (CA, pinning, explicit insecure override), the bounded HTTPS transport and the
 * OperationExecutor that the dispatcher uses to reach consoles (ADR 0012).
 */
export {
  ConsoleError,
  ConsoleRegistry,
  type ConsoleConnection,
  type ConsoleErrorCode,
  type ConsoleInput,
  type ConsoleModuleView,
  type ConsoleRegistryOptions,
  type ConsoleView,
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
  isModuleId,
  MODULE_ENDPOINTS,
  MODULE_IDS,
  type ModuleEndpoint,
  type ModuleId,
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
