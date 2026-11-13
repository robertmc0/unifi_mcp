/**
 * System logs (reviewed 2026-11-13, ADR 0023 §3). They record who opened which door when
 * (`access_log`, `personal_identifier`). Spec §6.4 requires Access histories to be scoped
 * with size and time limits: every log read names a window of at most 31 days (the limit
 * the PDF states for the export, §9.3) and reads at most 100 entries a page.
 */
import { accessOperation } from '../define.ts';

/** The longest window of one log read, in seconds. */
export const MAX_LOG_WINDOW_SECONDS = 31 * 24 * 60 * 60;
/** The largest page of one log read. */
export const MAX_LOG_PAGE_SIZE = 100;

export const listSystemLogs = accessOperation('POST /api/v1/developer/system/logs', {
  operationId: 'access.logs.list',
  category: 'logs',
  effect: 'read',
  description:
    'System log entries of one topic (door openings, admin activity, …) in a window of at most 31 days.',
  sensitivityTags: ['access_log', 'personal_identifier'],
  narrowInput: (input) =>
    input
      .refine(
        ({ body }) =>
          body.since !== undefined &&
          body.until !== undefined &&
          body.until > body.since &&
          body.until - body.since <= MAX_LOG_WINDOW_SECONDS,
        {
          message: 'body.since and body.until are required and at most 31 days apart.',
          path: ['body'],
        },
      )
      .refine(
        ({ page_size: size }) =>
          size === undefined || (/^[1-9]\d{0,2}$/.test(size) && Number(size) <= MAX_LOG_PAGE_SIZE),
        {
          message: `page_size is a number from 1 to ${String(MAX_LOG_PAGE_SIZE)}.`,
          path: ['page_size'],
        },
      ),
});

export const getLogResource = accessOperation('GET /api/v1/developer/system/logs/resource/{id}', {
  operationId: 'access.logs.get_resource',
  category: 'logs',
  effect: 'read',
  description: 'The video and thumbnail paths recorded with one log entry, and when.',
  sensitivityTags: ['access_log', 'recording'],
});
