/**
 * The reviewed Access notification stream (§11.1, ADR 0023 §6): its security metadata, a
 * reviewed class for every documented event and none for anything else, messages kept
 * apart by their `event`, and the doorbell call's token never passed on.
 */
import {
  ACCESS_EVENT_STREAMS,
  ACCESS_MAX_VERSION,
  classifyNotification,
  NOTIFICATION_EVENTS,
  projectNotification,
  subscribeNotifications,
} from '@unifi-local-mcp/unifi-access';
import { describe, expect, it } from 'vitest';
import type * as z from 'zod';
import { OPERATIONS } from '../../packages/unifi-access/src/generated/access-2026-03-23.ts';

const NOTIFICATIONS = OPERATIONS['GET /api/v1/developer/devices/notifications'];

const options = (schema: z.ZodType): z.ZodType[] =>
  (schema as unknown as { _zod: { def: { options: z.ZodType[] } } })._zod.def.options;
const literalOf = (schema: z.ZodType): unknown => {
  const event = (schema as unknown as { shape: Record<string, z.ZodType> }).shape['event'];
  const def = (event as unknown as { _zod: { def: { type: string; values?: unknown[] } } })._zod
    .def;
  return def.type === 'literal' ? def.values?.[0] : undefined;
};

describe('Access notification stream', () => {
  it('is reviewed: a low-risk read of its own permission, up to the declared bound', () => {
    expect(ACCESS_EVENT_STREAMS).toEqual([subscribeNotifications]);
    expect(subscribeNotifications).toMatchObject({
      operationId: 'access.notifications.subscribe',
      moduleId: 'access',
      category: 'notifications',
      effect: 'read',
      permission: 'access.notifications.read',
      risk: 'low',
      sensitivityTags: [],
      approvalRequired: false,
      siteScoped: false,
      streamId: 'notifications',
      contractRevision: '2026-03-23',
      apiVersionRange: `>=1.20.11 <=${ACCESS_MAX_VERSION}`,
      pathTemplate: '/api/v1/developer/devices/notifications',
      documentationUrl: 'https://assets.identity.ui.com/unifi-access/api_reference.pdf#page=170',
    });
    expect(NOTIFICATIONS.transport).toBe('websocket');
  });

  it('classifies exactly the documented events, the remote unlock as access history', () => {
    const documented = options(NOTIFICATIONS.output).map(literalOf).filter(Boolean);
    expect(documented.sort()).toEqual(Object.keys(NOTIFICATION_EVENTS).sort());
    expect(
      Object.fromEntries(
        Object.entries(NOTIFICATION_EVENTS).map(([event, c]) => [
          event,
          [c.kind, [...c.sensitivityTags], c.equivalent?.permission ?? null],
        ]),
      ),
    ).toEqual({
      'access.remote_view': ['doorbell_ring', [], null],
      'access.remote_view.change': ['doorbell_status', [], null],
      'access.data.device.remote_unlock': ['remote_unlock', ['access_log'], 'access.spaces.read'],
    });
    expect(classifyNotification({ event: 'access.door.unlock' })).toBeUndefined();
    expect(classifyNotification({ event: 'toString' })).toBeUndefined();
  });

  it('keeps each message in its own shape, selected by its event', () => {
    const unlock = {
      event: 'access.data.device.remote_unlock',
      event_object_id: 'hub-1',
      data: { name: 'Front', full_name: 'Site - 1F - Front', extras: { dps: 'off' } },
    };
    expect(NOTIFICATIONS.output.parse(unlock)).toEqual(unlock);
    const status = { event: 'access.remote_view.change', data: { reason_code: 105 } };
    expect(NOTIFICATIONS.output.parse(status)).toEqual(status);
    // A documented event that misses its own shape is refused, not reduced to the fallback.
    expect(
      NOTIFICATIONS.output.safeParse({ event: 'access.remote_view', data: 'ringing' }).success,
    ).toBe(false);
    // An undocumented event keeps only its name (and is then never delivered).
    expect(NOTIFICATIONS.output.parse({ event: 'access.door.unlock', data: { x: 1 } })).toEqual({
      event: 'access.door.unlock',
    });
    // The event is required.
    expect(NOTIFICATIONS.output.safeParse({ data: {} }).success).toBe(false);
  });

  it("removes the doorbell call's token and every credential field", () => {
    const ring = NOTIFICATIONS.output.parse({
      event: 'access.remote_view',
      data: { channel: 'c1', token: 'SENTINEL-CALL-TOKEN', door_name: 'Front' },
    });
    expect(projectNotification(ring)).toEqual({
      event: 'access.remote_view',
      data: { channel: 'c1', door_name: 'Front' },
    });
    expect(
      JSON.stringify(projectNotification({ event: 'x', data: { secret: 'S', headers: {} } })),
    ).toBe('{"event":"x","data":{}}');
  });
});
