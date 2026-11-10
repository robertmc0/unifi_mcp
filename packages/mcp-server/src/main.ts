/**
 * Service entry point: `node packages/mcp-server/src/main.ts`, from a checkout or in the
 * container (Node.js runs the sources directly, ADR 0002). Exits non-zero when startup
 * fails, never starting in a partially configured state. Registers the reviewed module
 * adapters (Phase 2: Network).
 */
import { createLogger, parseLogLevel } from '@unifi-local-mcp/telemetry';
import { NETWORK_OPERATIONS, NETWORK_VERSION_PROBE } from '@unifi-local-mcp/unifi-network';
import { loadServiceConfig } from './config.ts';
import { startService } from './service.ts';

const bootLogger = createLogger({
  level: (() => {
    try {
      return parseLogLevel(process.env['UNIFI_MCP_LOG_LEVEL']);
    } catch {
      return 'info';
    }
  })(),
  sink: process.stdout,
  bindings: { service: 'unifi-local-mcp' },
});

try {
  const service = await startService({
    config: loadServiceConfig(process.env),
    operations: NETWORK_OPERATIONS,
    probes: [NETWORK_VERSION_PROBE],
  });
  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    service.logger.info('shutting down', { signal });
    service.stop().then(
      () => process.exit(0),
      (error: unknown) => {
        service.logger.error('shutdown failed', { err: error });
        process.exit(1);
      },
    );
  };
  process.once('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.once('SIGINT', () => {
    shutdown('SIGINT');
  });
} catch (error) {
  bootLogger.error('startup failed; the service will not start', {
    code: (error as { code?: unknown }).code,
    err: error,
  });
  process.exitCode = 1;
}
