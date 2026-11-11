/**
 * Registry validation, scheduler, rate limiter, resource locks and request digests
 * (spec §4.3, §4.4, §10; ADR 0010).
 */
import {
  canonicalJson,
  KeyedMutex,
  OperationRegistry,
  RateLimiter,
  requestDigest,
  Scheduler,
  SchedulerError,
  templatePlaceholders,
  type SchedulerLimits,
} from '@unifi-local-mcp/core';
import { describe, expect, it, vi } from 'vitest';
import * as z from 'zod';
import {
  deferred,
  getInfo,
  getPicture,
  inventory,
  listDevices,
  restartDevice,
} from './fixtures.ts';

describe('OperationRegistry', () => {
  it('registers valid operations, rejects duplicates and seals', () => {
    const registry = new OperationRegistry(inventory);
    registry.register(listDevices);
    registry.register({ ...restartDevice, namedTool: 'network_restart_device' });
    expect(registry.get('network.devices.list')?.pathTemplate).toBe('/v1/sites/{siteId}/devices');
    expect(registry.byNamedTool('network_restart_device')?.operationId).toBe(
      'network.devices.restart',
    );
    expect(registry.list().map((d) => d.operationId)).toEqual([
      'network.devices.list',
      'network.devices.restart',
    ]);
    expect(() => {
      registry.register(listDevices);
    }).toThrow(/duplicate operationId/);
    registry.seal();
    expect(() => {
      registry.register(getInfo);
    }).toThrow(/sealed/);
    expect(registry.inputJsonSchema('network.devices.restart')).toMatchObject({
      type: 'object',
      required: ['deviceId'],
      additionalProperties: false,
    });
  });

  it.each([
    [
      'a GET write',
      { ...restartDevice, httpMethod: 'GET' as const },
      /GET operation must be a read/,
    ],
    [
      'a write without a lock key',
      { ...restartDevice, resourceLockKey: undefined },
      /resourceLockKey/,
    ],
    [
      'a read with a write retry class',
      { ...listDevices, retryClass: 'idempotent' as const },
      /safe-read/,
    ],
    [
      'a query string in the template',
      { ...getInfo, pathTemplate: '/v1/info?all=1' },
      /pathTemplate/,
    ],
    ['a dot segment', { ...getInfo, pathTemplate: '/v1/../info' }, /pathTemplate/],
    [
      'an unbound placeholder',
      { ...getInfo, pathTemplate: '/v1/{thing}' },
      /\{thing\} has no matching input/,
    ],
    [
      'siteId as an argument',
      { ...getInfo, inputSchema: z.strictObject({ siteId: z.string() }) },
      /targets, not arguments/,
    ],
    ['a long description', { ...getInfo, description: 'x'.repeat(301) }, /description/],
    ['an absurd timeout', { ...getInfo, timeoutMs: 10 }, /timeoutMs/],
    [
      'high risk without approval',
      { ...restartDevice, risk: 'high' as const },
      /must require approval/,
    ],
    ['an undocumented binary type', { ...getInfo, responseType: 'image/png' }, /responseType/],
    [
      'a binary write',
      { ...restartDevice, responseType: 'image/jpeg' as const },
      /binary response is for GET reads only/,
    ],
    [
      'a projected binary read',
      { ...getPicture, project: (bytes: Uint8Array) => bytes.length },
      /neither projected nor paged/,
    ],
  ])('rejects %s', (_name, descriptor, pattern) => {
    const registry = new OperationRegistry(() => true);
    expect(() => {
      registry.register(descriptor as never);
    }).toThrow(pattern);
  });

  it('lists template placeholders', () => {
    expect(templatePlaceholders('/v1/sites/{siteId}/devices/{deviceId}')).toEqual([
      'siteId',
      'deviceId',
    ]);
  });
});

describe('Scheduler', () => {
  const limits: SchedulerLimits = {
    globalConcurrency: 2,
    perKeyConcurrency: 1,
    globalQueue: 10,
    perKeyQueue: 3,
    perClientQueued: 2,
  };
  const later = () => Date.now() + 10_000;

  it('caps concurrency per key and globally, and bounds queues', async () => {
    const scheduler = new Scheduler(limits);
    const gate = deferred();
    const task = () => gate.promise;
    const a = scheduler.run({ key: 'k1', clientId: 'c1', startBy: later() }, task);
    const b = scheduler.run({ key: 'k2', clientId: 'c1', startBy: later() }, task);
    expect(scheduler.running).toBe(2);
    const queued = [
      scheduler.run({ key: 'k1', clientId: 'c2', startBy: later() }, task),
      scheduler.run({ key: 'k1', clientId: 'c2', startBy: later() }, task),
    ];
    await expect(
      scheduler.run({ key: 'k1', clientId: 'c2', startBy: later() }, task),
    ).rejects.toMatchObject({
      code: 'queue_full',
    });
    expect(scheduler.queued).toBe(2);
    gate.resolve();
    await Promise.all([a, b, ...queued]);
    expect(scheduler.running).toBe(0);
    expect(scheduler.queued).toBe(0);
  });

  it('serves waiting clients round-robin', async () => {
    const scheduler = new Scheduler({
      ...limits,
      globalConcurrency: 1,
      perClientQueued: 5,
      perKeyQueue: 10,
    });
    const gate = deferred();
    const order: string[] = [];
    const blocker = scheduler.run(
      { key: 'k', clientId: 'x', startBy: later() },
      () => gate.promise,
    );
    const jobs = ['a1', 'a2', 'a3', 'b1', 'b2'].map((name) =>
      scheduler.run({ key: 'k', clientId: name[0] ?? '', startBy: later() }, () => {
        order.push(name);
        return Promise.resolve();
      }),
    );
    gate.resolve();
    await Promise.all([blocker, ...jobs]);
    expect(order).toEqual(['a1', 'b1', 'a2', 'b2', 'a3']);
  });

  it('fails jobs that cannot start before their deadline', async () => {
    const scheduler = new Scheduler(limits);
    const gate = deferred();
    const running = scheduler.run(
      { key: 'k', clientId: 'c', startBy: later() },
      () => gate.promise,
    );
    await expect(
      scheduler.run({ key: 'k', clientId: 'c', startBy: Date.now() + 20 }, () => Promise.resolve()),
    ).rejects.toMatchObject({ code: 'deadline_exceeded' });
    gate.resolve();
    await running;
  });

  it('cancels queued jobs per client, and drains', async () => {
    const scheduler = new Scheduler(limits);
    const gate = deferred();
    const running = scheduler.run(
      { key: 'k', clientId: 'c1', startBy: later() },
      () => gate.promise,
    );
    const mine = scheduler.run({ key: 'k', clientId: 'c1', startBy: later() }, () =>
      Promise.resolve(),
    );
    const theirs = scheduler.run({ key: 'k', clientId: 'c2', startBy: later() }, () =>
      Promise.resolve('ok'),
    );
    expect(scheduler.cancelClient('c1')).toBe(1);
    await expect(mine).rejects.toBeInstanceOf(SchedulerError);
    const drained = scheduler.drain();
    await expect(theirs).rejects.toMatchObject({ code: 'cancelled' });
    gate.resolve();
    await running;
    await drained;
    await expect(
      scheduler.run({ key: 'k', clientId: 'c', startBy: later() }, () => Promise.resolve()),
    ).rejects.toMatchObject({
      code: 'shutting_down',
    });
  });
});

describe('RateLimiter', () => {
  it('takes from all buckets or none, and refills over time', () => {
    let now = 0;
    const limiter = new RateLimiter(() => now);
    const slow = { ratePerSecond: 1, burst: 1 };
    const fast = { ratePerSecond: 100, burst: 100 };
    expect(
      limiter.take([
        { key: 'a', limit: slow },
        { key: 'g', limit: fast },
      ]),
    ).toEqual({ ok: true });
    expect(
      limiter.take([
        { key: 'a', limit: slow },
        { key: 'g', limit: fast },
      ]),
    ).toEqual({
      ok: false,
      retryAfterMs: 1000,
      bucket: 'a',
    });
    // The refused request took nothing from the global bucket.
    for (let i = 0; i < 99; i++) expect(limiter.take([{ key: 'g', limit: fast }]).ok).toBe(true);
    expect(limiter.take([{ key: 'g', limit: fast }]).ok).toBe(false);
    now = 1000;
    expect(limiter.take([{ key: 'a', limit: slow }]).ok).toBe(true);
  });
});

describe('KeyedMutex', () => {
  it('grants in arrival order per key and lets waiters give up', async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];
    const release1 = await mutex.acquire('k');
    const controller = new AbortController();
    const second = mutex.acquire('k', controller.signal);
    const third = mutex.acquire('k').then((release) => {
      order.push('third');
      release();
    });
    const other = await mutex.acquire('other');
    order.push('other');
    other();
    controller.abort(new Error('gave up'));
    await expect(second).rejects.toThrow('gave up');
    release1();
    await third;
    expect(order).toEqual(['other', 'third']);
    expect(mutex.isLocked('k')).toBe(false);
    const signal = AbortSignal.abort(new Error('already'));
    await expect(mutex.acquire('k', signal)).rejects.toThrow('already');
    await vi.waitFor(() => {
      expect(mutex.isLocked('k')).toBe(false);
    });
  });
});

describe('request digests', () => {
  it('are independent of key order and sensitive to every value', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[1,{"x":1,"y":2}]},"b":1}',
    );
    const base = {
      operationId: 'network.devices.restart',
      consoleId: 'c1',
      siteId: 's1',
      arguments: { a: 1, b: 2 },
    };
    expect(requestDigest(base)).toBe(requestDigest({ ...base, arguments: { b: 2, a: 1 } }));
    expect(requestDigest(base)).not.toBe(requestDigest({ ...base, siteId: 's2' }));
    expect(requestDigest(base)).not.toBe(requestDigest({ ...base, arguments: { a: 1, b: 3 } }));
    expect(() => canonicalJson({ x: Number.NaN })).toThrow();
    expect(() => canonicalJson({ f: () => 1 })).toThrow();
  });
});
