/**
 * Protect credentials never leave the service (ADR 0019): `url` and `pin_code` are removed
 * from every result at any depth; other names only where an operation names them.
 */
import {
  ALWAYS_REMOVED,
  documentationUrl,
  protectOperation,
  withoutCredentials,
} from '@unifi-local-mcp/unifi-protect';
import { describe, expect, it } from 'vitest';

describe('Protect credential removal', () => {
  it('removes url and pin_code at any depth, in lists and objects', () => {
    expect(ALWAYS_REMOVED).toEqual(['url', 'pin_code']);
    expect(
      withoutCredentials({
        url: 'rtp://h.invalid:7004',
        codec: 'opus',
        nested: [{ pin_code: '1234', has_pin: true, deeper: { url: 'x' } }],
      }),
    ).toEqual({ codec: 'opus', nested: [{ has_pin: true, deeper: {} }] });
  });

  it('removes operation-specific names only when asked, and leaves bytes alone', () => {
    const streams = { high: 'rtsps://h.invalid:7441/token?enableSrtp', low: null };
    expect(withoutCredentials(streams)).toEqual(streams);
    expect(withoutCredentials(streams, ['high', 'low'])).toEqual({});
    const bytes = new Uint8Array([0xff, 0xd8, 0xff]);
    expect(withoutCredentials(bytes)).toBe(bytes);
  });

  it('builds the vendor documentation URL from method and path', () => {
    expect(documentationUrl('GET', '/v1/cameras/{id}/snapshot')).toBe(
      'https://developer.ui.com/protect/v7.4.96/get-v1camerasidsnapshot',
    );
    expect(documentationUrl('POST', '/v1/alarm-manager/webhook/{id}')).toBe(
      'https://developer.ui.com/protect/v7.4.96/post-v1alarm-managerwebhookid',
    );
  });
});

describe('protectOperation', () => {
  it('strips credentials from every projected result', () => {
    const info = protectOperation('GET /v1/meta/info', {
      operationId: 'protect.info.get',
      category: 'info',
      effect: 'read',
      description: 'Test.',
    });
    // Wider than the schema, as a projection may see after a future schema change.
    const output = { applicationVersion: '7.4.96', url: 'rtp://h.invalid:7004' };
    expect(info.project?.(output)).toEqual({ applicationVersion: '7.4.96' });
  });

  it('makes every operation console-level, and binary reads unprojected bytes', () => {
    const snapshot = protectOperation('GET /v1/cameras/{id}/snapshot', {
      operationId: 'protect.cameras.get_snapshot',
      category: 'cameras',
      effect: 'read',
      description: 'Test.',
    });
    expect(snapshot).toMatchObject({
      siteScoped: false,
      responseType: 'image/jpeg',
      moduleId: 'protect',
      permission: 'protect.cameras.read',
    });
    expect(Object.hasOwn(snapshot, 'project')).toBe(false);
  });
});
