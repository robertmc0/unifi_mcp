/**
 * Structured JSON logger (spec §12; ADR 0008).
 */
import { createLogger, parseLogLevel } from '@unifi-local-mcp/telemetry';
import { describe, expect, it, vi } from 'vitest';
import { memoryLogger } from './fixtures.ts';

describe('Logger', () => {
  it('writes one JSON object per line with time, level and msg first', () => {
    const { lines, logger } = memoryLogger('debug', { service: 'unifi-local-mcp' });
    logger.info('request done', { correlationId: 'c-1', durationMs: 12 });
    expect(lines).toEqual([
      '{"time":"2026-11-10T03:15:00.000Z","level":"info","msg":"request done",' +
        '"service":"unifi-local-mcp","correlationId":"c-1","durationMs":12}\n',
    ]);
  });

  it('filters by level', () => {
    const { records, logger } = memoryLogger('warn');
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    expect(records().map((r) => r['level'])).toEqual(['warn', 'error']);
    expect(logger.isLevelEnabled('info')).toBe(false);
  });

  it('adds child bindings, and later bindings win', () => {
    const { records, logger } = memoryLogger('debug', { service: 's', component: 'root' });
    logger.child({ component: 'dispatcher', correlationId: 'c-2' }).info('x');
    expect(records()[0]).toMatchObject({
      service: 's',
      component: 'dispatcher',
      correlationId: 'c-2',
    });
  });

  it('cannot overwrite reserved fields', () => {
    const { records, logger } = memoryLogger();
    logger.info('real', { time: 'fake', level: 'error', msg: 'forged' });
    expect(records()[0]).toEqual({
      time: '2026-11-10T03:15:00.000Z',
      level: 'info',
      msg: 'real',
      field_time: 'fake',
      field_level: 'error',
      field_msg: 'forged',
    });
  });

  it('redacts the message and the fields', () => {
    const { lines, logger } = memoryLogger();
    logger.error('upstream said Bearer abc123', {
      err: new Error('token rejected: Bearer abc123'),
      headers: { authorization: 'Bearer abc123' },
    });
    expect(lines[0]).not.toContain('abc123');
    expect(lines[0]).toContain('"msg":"upstream said Bearer [REDACTED]"');
  });

  it('keeps every record on one line even with hostile upstream text', () => {
    const { lines, logger } = memoryLogger();
    logger.warn('camera renamed', {
      name: 'Front door\n{"level":"error","msg":"forged"}\r\u0000\u001b[31m',
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]?.split('\n')).toHaveLength(2); // the record and the final newline
    expect(lines[0]).not.toContain('\r');
  });

  it('never throws when the sink fails', () => {
    const logger = createLogger({
      level: 'info',
      sink: {
        write: () => {
          throw new Error('EPIPE');
        },
      },
    });
    expect(() => {
      logger.info('still fine');
    }).not.toThrow();
  });

  it('writes only to its own sink, never to stdout', () => {
    const stdout = vi.spyOn(process.stdout, 'write');
    const lines: string[] = [];
    const logger = createLogger({ level: 'debug', sink: { write: (l: string) => lines.push(l) } });
    logger.debug('a');
    logger.error('b', { err: new Error('c') });
    expect(lines).toHaveLength(2);
    expect(stdout).not.toHaveBeenCalled();
  });
});

describe('parseLogLevel', () => {
  it('accepts known levels case-insensitively and defaults when unset', () => {
    expect(parseLogLevel(undefined)).toBe('info');
    expect(parseLogLevel('')).toBe('info');
    expect(parseLogLevel(' WARN ')).toBe('warn');
    expect(parseLogLevel(undefined, 'error')).toBe('error');
  });

  it('rejects unknown levels', () => {
    expect(() => parseLogLevel('verbose')).toThrow(/UNIFI_MCP_LOG_LEVEL must be one of/);
  });
});
