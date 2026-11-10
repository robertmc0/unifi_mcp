/**
 * Shared helpers for telemetry tests.
 */
import { createLogger, type Logger, type LogLevel } from '@unifi-local-mcp/telemetry';

export interface MemorySink {
  lines: string[];
  logger: Logger;
  records: () => Record<string, unknown>[];
}

/** A logger writing to memory, with a fixed clock. */
export function memoryLogger(
  level: LogLevel = 'debug',
  bindings?: Record<string, unknown>,
): MemorySink {
  const lines: string[] = [];
  const logger = createLogger({
    level,
    sink: {
      write: (line: string) => {
        lines.push(line);
      },
    },
    now: () => new Date('2026-11-10T03:15:00.000Z'),
    ...(bindings === undefined ? {} : { bindings }),
  });
  return {
    lines,
    logger,
    records: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}
