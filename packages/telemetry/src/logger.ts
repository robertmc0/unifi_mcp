/**
 * Structured JSON logger (spec §12, ADR 0008).
 *
 * - One JSON object per line. JSON escaping neutralises newlines and control characters in
 *   untrusted upstream text, so a log line cannot be forged by injected content.
 * - Every record is redacted (see redact.ts) before it is serialised, including `msg`.
 * - The sink is always explicit. The service logs to stdout (the container log driver);
 *   the stdio bridge must log to stderr because stdout carries MCP protocol frames only.
 * - Logging never throws: a failing sink or an unserialisable value cannot break a request.
 */
import { LOG_LIMITS, redact, redactString, type JsonValue } from './redact.ts';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const SEVERITY: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const RESERVED_FIELDS = new Set(['time', 'level', 'msg']);

export const LOG_LEVEL_ENV = 'UNIFI_MCP_LOG_LEVEL';

/** Anything with a `write(string)` method, such as `process.stdout` or `process.stderr`. */
export interface LogSink {
  write(line: string): unknown;
}

export type LogFields = Readonly<Record<string, unknown>>;

export interface LoggerOptions {
  level: LogLevel;
  sink: LogSink;
  /** Fields added to every record, for example `{ service: 'unifi-local-mcp' }`. */
  bindings?: LogFields;
  now?: () => Date;
}

/** Parses `UNIFI_MCP_LOG_LEVEL`. Unset or empty gives `fallback`; anything else unknown is an error. */
export function parseLogLevel(value: string | undefined, fallback: LogLevel = 'info'): LogLevel {
  if (value === undefined || value.trim() === '') return fallback;
  const normalised = value.trim().toLowerCase();
  if ((LOG_LEVELS as readonly string[]).includes(normalised)) return normalised as LogLevel;
  throw new Error(
    `${LOG_LEVEL_ENV} must be one of ${LOG_LEVELS.join(', ')} (got an unrecognised value).`,
  );
}

export class Logger {
  readonly level: LogLevel;
  readonly #sink: LogSink;
  readonly #bindings: LogFields;
  readonly #now: () => Date;

  constructor(options: LoggerOptions) {
    this.level = options.level;
    this.#sink = options.sink;
    this.#bindings = options.bindings ?? {};
    this.#now = options.now ?? (() => new Date());
  }

  /** A logger that adds `bindings` (for example a correlation id) to every record. */
  child(bindings: LogFields): Logger {
    return new Logger({
      level: this.level,
      sink: this.#sink,
      bindings: { ...this.#bindings, ...bindings },
      now: this.#now,
    });
  }

  isLevelEnabled(level: LogLevel): boolean {
    return SEVERITY[level] >= SEVERITY[this.level];
  }

  debug(msg: string, fields?: LogFields): void {
    this.#write('debug', msg, fields);
  }

  info(msg: string, fields?: LogFields): void {
    this.#write('info', msg, fields);
  }

  warn(msg: string, fields?: LogFields): void {
    this.#write('warn', msg, fields);
  }

  error(msg: string, fields?: LogFields): void {
    this.#write('error', msg, fields);
  }

  #write(level: LogLevel, msg: string, fields: LogFields | undefined): void {
    if (!this.isLevelEnabled(level)) return;
    let line: string;
    try {
      const record: Record<string, JsonValue> = {
        time: this.#now().toISOString(),
        level,
        msg: redactString(msg, LOG_LIMITS.maxStringLength),
      };
      const extra = redact({ ...this.#bindings, ...fields });
      if (extra !== null && typeof extra === 'object' && !Array.isArray(extra)) {
        for (const [key, value] of Object.entries(extra)) {
          record[RESERVED_FIELDS.has(key) ? `field_${key}` : key] = value;
        }
      }
      line = `${JSON.stringify(record)}\n`;
    } catch {
      line = `${JSON.stringify({ time: new Date().toISOString(), level, msg: 'unserialisable log record' })}\n`;
    }
    try {
      this.#sink.write(line);
    } catch {
      // A broken sink (for example EPIPE) must not affect request handling.
    }
  }
}

export function createLogger(options: LoggerOptions): Logger {
  return new Logger(options);
}

/** A logger that discards everything; for tests and tools that must stay silent. */
export function silentLogger(): Logger {
  return new Logger({ level: 'error', sink: { write: () => undefined } });
}
