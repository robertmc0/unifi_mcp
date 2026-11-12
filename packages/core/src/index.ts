/**
 * @unifi-local-mcp/core
 *
 * The operation registry, the single execution dispatcher used by every transport, bounded
 * fair scheduling, rate limits, resource locks and durable write executions (ADR 0010).
 */
export { canonicalJson, requestDigest, sha256Hex } from './digest.ts';
export {
  DEFAULT_DISPATCHER_LIMITS,
  Dispatcher,
  type ApprovalGate,
  type ApprovalRefusal,
  type DispatcherDependencies,
  type DispatcherLimits,
  type EnvelopeError,
  type EnvelopeStatus,
  type ExecutionCall,
  type ExecutionEnvelope,
  type ExecutionRequest,
  type ExecutionStatusView,
  type ExecutorOutcome,
  type OperationExecutor,
  type Principal,
  type ProposalContext,
  type ResumableApproval,
  type SecurityContextProvider,
  type UpstreamError,
} from './dispatcher.ts';
export {
  EXECUTION_STATUSES,
  ExecutionStore,
  TERMINAL_STATUSES,
  type ExecutionRecord,
  type ExecutionStatus,
  type NewExecution,
} from './executions.ts';
export { displaySafe, displaySafeLine } from './display.ts';
export {
  DEFAULT_EVENT_HUB_LIMITS,
  EventHub,
  type EventCloseInfo,
  type EventConnection,
  type EventConnector,
  type EventFeedKey,
  type EventFeedStatus,
  type EventHubLimits,
  type EventHubOptions,
  type EventReadResult,
  type EventTarget,
  type FeedState,
} from './event-hub.ts';
export {
  defineEventStream,
  EventStreamRegistry,
  isValidMessageClass,
  MAX_EVENT_MESSAGE_BYTES,
  MIN_EVENT_MESSAGE_BYTES,
  StreamAccess,
  validateEventStream,
  type EventStreamDescriptor,
  type MessageClass,
  type StreamAccessDependencies,
  type StreamDecision,
} from './events.ts';
export { withoutFields } from './fields.ts';
export { KeyedMutex } from './locks.ts';
export { RateLimiter, type RateDecision, type RateLimit } from './rate-limit.ts';
export { mismatchSummary } from './schema-mismatch.ts';
export {
  BINARY_RESPONSE_TYPES,
  defineOperation,
  HTTP_METHODS,
  OperationRegistry,
  renderPath,
  RETRY_CLASSES,
  templatePlaceholders,
  validateDescriptor,
  type ContractInventory,
  type HttpMethod,
  type KnownUpstreamFailure,
  type OperationDescriptor,
  type ResponseType,
  type RetryClass,
  type Target,
} from './registry.ts';
export {
  Scheduler,
  SchedulerError,
  type JobOptions,
  type SchedulerErrorCode,
  type SchedulerLimits,
} from './scheduler.ts';
export { parseRange, parseVersion, satisfies, type VersionRange } from './versions.ts';
