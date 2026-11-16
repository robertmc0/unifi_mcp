/**
 * The dispatcher under load (spec §10, §16 Phase 5 "performance/queue tests", §17
 * "Concurrency/rate limits, queue caps, safe retries and unknown write outcomes behave
 * deterministically"). The unit tests show each rule once; these show that the rules
 * hold when hundreds of requests arrive together: caps are never exceeded, every request
 * ends in exactly one stated outcome, nothing runs twice or late, and nothing is left
 * queued. Real storage and audit trail; a synthetic executor that records what overlaps.
 */
import { ClientPolicySchema, ConsolePolicySchema } from '@unifi-local-mcp/policy';
import type { ExecutionEnvelope, ExecutorOutcome } from '@unifi-local-mcp/core';
import { describe, expect, it, vi } from 'vitest';
import {
  CONSOLE,
  deferred,
  DEVICE_A,
  DEVICE_B,
  harness,
  SITE,
  type Harness,
  type HarnessOptions,
} from '../unit/core/fixtures.ts';
import { useTempDirs } from '../unit/storage/fixtures.ts';

const tempDir = useTempDirs();
const UNLIMITED = { ratePerSecond: 1_000_000, burst: 1_000_000 };
const NO_RATE_LIMIT = {
  client: UNLIMITED,
  console: UNLIMITED,
  module: UNLIMITED,
  global: UNLIMITED,
};
const WIDE_QUEUES = { globalQueue: 10_000, perKeyQueue: 10_000, perClientQueued: 10_000 };

async function setup(
  limits: HarnessOptions['limits'],
  shape: { clients?: number; consoles?: string[] } = {},
): Promise<Harness & { clientIds: string[]; consoleIds: string[] }> {
  const h = await harness({ dir: await tempDir(), limits: { rate: NO_RATE_LIMIT, ...limits } });
  const consoleIds = shape.consoles ?? [CONSOLE];
  for (const consoleId of consoleIds) {
    h.consoles.set(
      consoleId,
      ConsolePolicySchema.parse({ consoleId, modules: { network: { state: 'read_write' } } }),
    );
  }
  const clientIds = Array.from({ length: shape.clients ?? 1 }, (_, i) => `load-${String(i)}`);
  for (const clientId of clientIds) {
    h.clients.set(
      clientId,
      ClientPolicySchema.parse({
        clientId,
        consoles: Object.fromEntries(consoleIds.map((id) => [id, { sites: '*' }])),
        allow: ['network.*.*'],
      }),
    );
  }
  return { ...h, clientIds, consoleIds };
}

const read = (consoleId: string, maxWaitMs?: number) => ({
  operationId: 'network.info.get',
  consoleId,
  ...(maxWaitMs === undefined ? {} : { maxWaitMs }),
});
const restart = (deviceId: string, idempotencyKey?: string) => ({
  operationId: 'network.devices.restart',
  consoleId: CONSOLE,
  siteId: SITE,
  arguments: { deviceId },
  ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
});
const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const codes = (envelopes: ExecutionEnvelope[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const envelope of envelopes) {
    const key = envelope.status === 'ok' ? 'ok' : (envelope.error?.code ?? envelope.status);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
};

describe('concurrency caps', () => {
  it('are never exceeded by 600 simultaneous reads, and every read is answered once', async () => {
    const h = await setup(
      { scheduler: { globalConcurrency: 6, perKeyConcurrency: 2, ...WIDE_QUEUES } },
      { clients: 10, consoles: ['c-1', 'c-2', 'c-3', 'c-4'] },
    );
    let inFlight = 0;
    let maxInFlight = 0;
    const perConsole = new Map<string, number>();
    let maxPerConsole = 0;
    h.executor.handler = async (call): Promise<ExecutorOutcome> => {
      const consoleId = call.target.consoleId;
      inFlight += 1;
      perConsole.set(consoleId, (perConsole.get(consoleId) ?? 0) + 1);
      maxInFlight = Math.max(maxInFlight, inFlight);
      maxPerConsole = Math.max(maxPerConsole, perConsole.get(consoleId) ?? 0);
      await tick(1);
      inFlight -= 1;
      perConsole.set(consoleId, (perConsole.get(consoleId) ?? 0) - 1);
      return { ok: true, data: { version: '1.0.0' } };
    };
    const results = await Promise.all(
      Array.from({ length: 600 }, (_, i) =>
        h.dispatcher.execute(
          { clientId: h.clientIds[i % h.clientIds.length] ?? '' },
          read(h.consoleIds[i % h.consoleIds.length] ?? ''),
        ),
      ),
    );
    expect(codes(results)).toEqual({ ok: 600 });
    expect(h.executor.calls).toHaveLength(600);
    expect(new Set(results.map((r) => r.correlationId)).size).toBe(600);
    // The caps were reached, and never passed.
    expect(maxInFlight).toBe(6);
    expect(maxPerConsole).toBe(2);
    expect(h.dispatcher.load).toEqual({ running: 0, queued: 0 });
    // One audit entry per read.
    const audited = h.storage.db.get(
      "SELECT count(*) AS n FROM audit_entries WHERE action = 'operation.execute' AND outcome = 'success'",
    );
    expect(audited?.['n']).toBe(600);
    h.storage.close();
  }, 30_000);
});

describe('bounded queues', () => {
  it('accept exactly what fits and refuse the rest at once, per client and in total', async () => {
    const h = await setup(
      {
        scheduler: {
          globalConcurrency: 2,
          perKeyConcurrency: 2,
          globalQueue: 10,
          perKeyQueue: 10,
          perClientQueued: 4,
        },
      },
      { clients: 3 },
    );
    const gate = deferred();
    h.executor.handler = async () => {
      await gate.promise;
      return { ok: true, data: { version: '1.0.0' } };
    };
    const settled: ExecutionEnvelope[] = [];
    const pending: Promise<void>[] = [];
    for (let i = 0; i < 60; i++) {
      pending.push(
        h.dispatcher
          .execute({ clientId: h.clientIds[i % 3] ?? '' }, read(CONSOLE))
          .then((envelope) => {
            settled.push(envelope);
          }),
      );
    }
    // While the console is busy: 2 run, 10 wait, and the other 48 are already refused.
    await vi.waitFor(() => {
      expect(settled).toHaveLength(48);
    });
    expect(codes(settled)).toEqual({ queue_full: 48 });
    expect(h.dispatcher.load).toEqual({ running: 2, queued: 10 });
    expect(h.executor.calls).toHaveLength(2);
    gate.resolve();
    await Promise.all(pending);
    expect(codes(settled)).toEqual({ queue_full: 48, ok: 12 });
    expect(h.executor.calls).toHaveLength(12);
    expect(h.dispatcher.load).toEqual({ running: 0, queued: 0 });
    h.storage.close();
  });

  it('give no client more than its share of the queue', async () => {
    const h = await setup(
      {
        scheduler: {
          globalConcurrency: 1,
          perKeyConcurrency: 1,
          globalQueue: 100,
          perKeyQueue: 100,
          perClientQueued: 5,
        },
      },
      { clients: 2 },
    );
    const gate = deferred();
    h.executor.handler = async () => {
      await gate.promise;
      return { ok: true, data: { version: '1.0.0' } };
    };
    const [greedy = '', modest = ''] = h.clientIds;
    const greedyResults = Array.from({ length: 40 }, () =>
      h.dispatcher.execute({ clientId: greedy }, read(CONSOLE)),
    );
    await vi.waitFor(() => {
      expect(h.dispatcher.load).toEqual({ running: 1, queued: 5 });
    });
    // The other client still gets in, although the first sent forty requests.
    const modestResult = h.dispatcher.execute({ clientId: modest }, read(CONSOLE));
    await vi.waitFor(() => {
      expect(h.dispatcher.load.queued).toBe(6);
    });
    gate.resolve();
    expect((await modestResult).status).toBe('ok');
    expect(codes(await Promise.all(greedyResults))).toEqual({ ok: 6, queue_full: 34 });
    h.storage.close();
  });
});

describe('fair scheduling', () => {
  it('serves a client with one request before the backlog of a client with many', async () => {
    const h = await setup(
      { scheduler: { globalConcurrency: 1, perKeyConcurrency: 1, ...WIDE_QUEUES } },
      { clients: 2 },
    );
    const gate = deferred();
    const order: string[] = [];
    h.executor.handler = async () => {
      await gate.promise;
      return { ok: true, data: { version: '1.0.0' } };
    };
    const [busy = '', quiet = ''] = h.clientIds;
    const all: Promise<unknown>[] = [];
    for (let i = 0; i < 30; i++) {
      all.push(
        h.dispatcher.execute({ clientId: busy }, read(CONSOLE)).then(() => order.push('busy')),
      );
    }
    await vi.waitFor(() => {
      expect(h.dispatcher.load).toEqual({ running: 1, queued: 29 });
    });
    all.push(
      h.dispatcher.execute({ clientId: quiet }, read(CONSOLE)).then(() => order.push('quiet')),
    );
    await vi.waitFor(() => {
      expect(h.dispatcher.load.queued).toBe(30);
    });
    gate.resolve();
    await Promise.all(all);
    expect(order).toHaveLength(31);
    // Round-robin between clients: it does not wait behind the 29 queued requests.
    expect(order.indexOf('quiet')).toBeLessThanOrEqual(2);
    h.storage.close();
  });
});

describe('deadlines', () => {
  it('fail waiting requests on time, and never run them afterwards', async () => {
    const h = await setup({
      scheduler: { globalConcurrency: 1, perKeyConcurrency: 1, ...WIDE_QUEUES },
    });
    const gate = deferred();
    h.executor.handler = async () => {
      await gate.promise;
      return { ok: true, data: { version: '1.0.0' } };
    };
    const [client = ''] = h.clientIds;
    const running = h.dispatcher.execute({ clientId: client }, read(CONSOLE));
    await vi.waitFor(() => {
      expect(h.executor.calls).toHaveLength(1);
    });
    const started = performance.now();
    const waiting = await Promise.all(
      Array.from({ length: 50 }, () =>
        h.dispatcher.execute({ clientId: client }, read(CONSOLE, 60)),
      ),
    );
    const waited = performance.now() - started;
    expect(codes(waiting)).toEqual({ deadline_exceeded: 50 });
    expect(waited).toBeGreaterThanOrEqual(50);
    expect(waited).toBeLessThan(2000);
    expect(h.dispatcher.load).toEqual({ running: 1, queued: 0 });
    gate.resolve();
    expect((await running).status).toBe('ok');
    await tick(20);
    // The console is free again, and none of the fifty runs late.
    expect(h.executor.calls).toHaveLength(1);
    h.storage.close();
  });
});

describe('rate limits', () => {
  it('let a burst through up to the bucket and answer the rest with a retry time', async () => {
    const h = await setup({
      scheduler: { globalConcurrency: 16, perKeyConcurrency: 16, ...WIDE_QUEUES },
      rate: { ...NO_RATE_LIMIT, client: { ratePerSecond: 1, burst: 20 } },
    });
    const [client = ''] = h.clientIds;
    const results = await Promise.all(
      Array.from({ length: 500 }, () => h.dispatcher.execute({ clientId: client }, read(CONSOLE))),
    );
    const counts = codes(results);
    // Twenty at once; a little more only if the burst itself took over a second.
    expect(counts['ok']).toBeGreaterThanOrEqual(20);
    expect(counts['ok']).toBeLessThanOrEqual(23);
    expect(counts['rate_limited']).toBe(500 - (counts['ok'] ?? 0));
    for (const limited of results.filter((r) => r.error?.code === 'rate_limited')) {
      expect(limited.error?.retryAfterMs).toBeGreaterThan(0);
      expect(limited.executionId).toBeUndefined();
    }
    expect(h.executor.calls).toHaveLength(counts['ok'] ?? 0);
    h.storage.close();
  }, 30_000);

  it('limit one client without slowing another', async () => {
    const h = await setup(
      {
        scheduler: { globalConcurrency: 16, perKeyConcurrency: 16, ...WIDE_QUEUES },
        rate: { ...NO_RATE_LIMIT, client: { ratePerSecond: 1, burst: 5 } },
      },
      { clients: 2 },
    );
    const [noisy = '', calm = ''] = h.clientIds;
    const noisyResults = await Promise.all(
      Array.from({ length: 100 }, () => h.dispatcher.execute({ clientId: noisy }, read(CONSOLE))),
    );
    expect(codes(noisyResults)['rate_limited']).toBeGreaterThanOrEqual(94);
    const calmResults = await Promise.all(
      Array.from({ length: 5 }, () => h.dispatcher.execute({ clientId: calm }, read(CONSOLE))),
    );
    expect(codes(calmResults)).toEqual({ ok: 5 });
    h.storage.close();
  });
});

describe('writes under contention', () => {
  it('run once for 100 simultaneous requests with one idempotency key', async () => {
    const h = await setup({
      scheduler: { globalConcurrency: 16, perKeyConcurrency: 16, ...WIDE_QUEUES },
    });
    const [client = ''] = h.clientIds;
    h.executor.handler = async () => {
      await tick(5);
      return { ok: true, data: { accepted: true } };
    };
    const results = await Promise.all(
      Array.from({ length: 100 }, () =>
        h.dispatcher.execute({ clientId: client }, restart(DEVICE_A, 'one-key')),
      ),
    );
    expect(h.executor.calls).toHaveLength(1);
    expect(new Set(results.map((r) => r.executionId)).size).toBe(1);
    expect(results.every((r) => r.status === 'ok' || r.status === 'pending')).toBe(true);
    expect(results.filter((r) => r.outcome === 'succeeded').length).toBeGreaterThanOrEqual(1);
    h.storage.close();
  });

  it('run every one of 80 writes exactly once, one at a time per device', async () => {
    const h = await setup(
      { scheduler: { globalConcurrency: 16, perKeyConcurrency: 16, ...WIDE_QUEUES } },
      { clients: 4 },
    );
    const busy = new Map<string, number>();
    let overlaps = 0;
    let bothDevicesAtOnce = false;
    h.executor.handler = async (call) => {
      const device = String(call.arguments['deviceId']);
      busy.set(device, (busy.get(device) ?? 0) + 1);
      if ((busy.get(device) ?? 0) > 1) overlaps += 1;
      if ([...busy.values()].filter((n) => n > 0).length === 2) bothDevicesAtOnce = true;
      await tick(1);
      busy.set(device, (busy.get(device) ?? 0) - 1);
      return { ok: true, data: { accepted: true } };
    };
    const results = await Promise.all(
      Array.from({ length: 80 }, (_, i) =>
        h.dispatcher.execute(
          { clientId: h.clientIds[i % 4] ?? '' },
          restart(i % 2 === 0 ? DEVICE_A : DEVICE_B),
        ),
      ),
    );
    expect(codes(results)).toEqual({ ok: 80 });
    expect(h.executor.calls).toHaveLength(80);
    expect(new Set(results.map((r) => r.executionId)).size).toBe(80);
    // Never two writes to one device at once; different devices do run together.
    expect(overlaps).toBe(0);
    expect(bothDevicesAtOnce).toBe(true);
    for (const result of results) {
      expect(h.executions.get(result.executionId ?? '')?.status).toBe('succeeded');
    }
    h.storage.close();
  }, 30_000);

  it('record an uncertain outcome once and never try again', async () => {
    const h = await setup({
      scheduler: { globalConcurrency: 8, perKeyConcurrency: 8, ...WIDE_QUEUES },
    });
    const [client = ''] = h.clientIds;
    let n = 0;
    h.executor.handler = async () => {
      const mine = n++;
      await tick(1);
      return mine % 3 === 0
        ? {
            ok: false,
            error: { code: 'upstream_timeout', message: 'no answer', outcomeUncertain: true },
          }
        : { ok: true, data: { accepted: true } };
    };
    const results = await Promise.all(
      Array.from({ length: 60 }, (_, i) =>
        h.dispatcher.execute({ clientId: client }, restart(i % 2 === 0 ? DEVICE_A : DEVICE_B)),
      ),
    );
    const unknown = results.filter((r) => r.outcome === 'outcome_unknown');
    expect(unknown).toHaveLength(20);
    expect(results.filter((r) => r.outcome === 'succeeded')).toHaveLength(40);
    // Sixty requests, sixty calls: an uncertain write is not retried.
    expect(h.executor.calls).toHaveLength(60);
    for (const result of unknown) {
      expect(result.error?.code).toBe('outcome_unknown');
      expect(h.executions.get(result.executionId ?? '')?.status).toBe('outcome_unknown');
    }
    h.storage.close();
  });
});

describe('cancellation', () => {
  it('ends the queued work of a revoked client, and only that', async () => {
    const h = await setup(
      { scheduler: { globalConcurrency: 1, perKeyConcurrency: 1, ...WIDE_QUEUES } },
      { clients: 2 },
    );
    const gate = deferred();
    h.executor.handler = async () => {
      await gate.promise;
      return { ok: true, data: { version: '1.0.0' } };
    };
    const [revoked = '', other = ''] = h.clientIds;
    const first = h.dispatcher.execute({ clientId: other }, read(CONSOLE));
    await vi.waitFor(() => {
      expect(h.executor.calls).toHaveLength(1);
    });
    const doomed = Array.from({ length: 25 }, () =>
      h.dispatcher.execute({ clientId: revoked }, read(CONSOLE)),
    );
    const kept = Array.from({ length: 5 }, () =>
      h.dispatcher.execute({ clientId: other }, read(CONSOLE)),
    );
    await vi.waitFor(() => {
      expect(h.dispatcher.load).toEqual({ running: 1, queued: 30 });
    });
    expect(h.dispatcher.cancelClient(revoked)).toBe(25);
    expect(codes(await Promise.all(doomed))).toEqual({ cancelled: 25 });
    expect(h.dispatcher.load).toEqual({ running: 1, queued: 5 });
    gate.resolve();
    expect(codes(await Promise.all([first, ...kept]))).toEqual({ ok: 6 });
    expect(h.executor.calls).toHaveLength(6);
    h.storage.close();
  });
});

describe('throughput', () => {
  it('handles audited reads at a usable rate with an instant console', async () => {
    const h = await setup({
      scheduler: { globalConcurrency: 16, perKeyConcurrency: 16, ...WIDE_QUEUES },
    });
    const [client = ''] = h.clientIds;
    const COUNT = 400;
    const started = performance.now();
    for (let i = 0; i < COUNT; i++) {
      const result = await h.dispatcher.execute({ clientId: client }, read(CONSOLE));
      if (result.status !== 'ok') throw new Error(`read ${String(i)}: ${result.error?.code ?? ''}`);
    }
    const sequential = (COUNT / (performance.now() - started)) * 1000;
    const startedParallel = performance.now();
    await Promise.all(
      Array.from({ length: COUNT }, () =>
        h.dispatcher.execute({ clientId: client }, read(CONSOLE)),
      ),
    );
    const parallel = (COUNT / (performance.now() - startedParallel)) * 1000;
    // A floor far below what was measured, to catch a collapse, not to benchmark.
    expect(sequential).toBeGreaterThan(100);
    expect(parallel).toBeGreaterThan(100);
    const report = process.env['UNIFI_MCP_PERF_REPORT'];
    if (report !== undefined && report !== '') {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(
        report,
        JSON.stringify({
          sequentialPerSecond: Math.round(sequential),
          parallelPerSecond: Math.round(parallel),
        }),
      );
    }
    h.storage.close();
  }, 60_000);
});
