/**
 * @unifi-local-mcp/telemetry
 *
 * Structured JSON logging with redaction, the persistent hash-chained audit trail, and
 * liveness/readiness checks (ADR 0008). Prometheus metrics are Phase 5.
 */
export {
  AUDIT_ACTOR_TYPES,
  AUDIT_OUTCOMES,
  AuditLog,
  AuditUnavailableError,
  DEFAULT_AUDIT_RETENTION_DAYS,
  type AuditActorType,
  type AuditEntry,
  type AuditEvent,
  type AuditLogOptions,
  type AuditOutcome,
  type AuditQuery,
  type ChainVerification,
} from './audit.ts';
export {
  auditCheck,
  createHealthHandler,
  databaseCheck,
  DEFAULT_HEALTH_PATHS,
  diskSpaceCheck,
  HealthMonitor,
  type CheckReport,
  type CheckStatus,
  type HealthCheck,
  type HealthCheckResult,
  type HealthEndpointPaths,
  type ReadinessReport,
} from './health.ts';
export {
  createLogger,
  LOG_LEVEL_ENV,
  LOG_LEVELS,
  Logger,
  parseLogLevel,
  silentLogger,
  type LogFields,
  type LoggerOptions,
  type LogLevel,
  type LogSink,
} from './logger.ts';
export {
  isSensitiveFieldName,
  LOG_LIMITS,
  redact,
  REDACTED,
  redactString,
  type JsonValue,
  type RedactionLimits,
} from './redact.ts';
