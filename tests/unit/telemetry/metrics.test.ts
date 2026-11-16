/**
 * The metrics registry: Prometheus text output, and labels that cannot grow beyond what a
 * metric declares (spec §12; ADR 0025).
 */
import { codeLabel, MetricsRegistry } from '@unifi-local-mcp/telemetry';
import { describe, expect, it } from 'vitest';

describe('metrics registry', () => {
  it('renders counters, gauges and histograms in the Prometheus text format', async () => {
    const registry = new MetricsRegistry();
    const requests = registry.counter({
      name: 'demo_requests_total',
      help: 'Requests.\nSecond line \\ with a backslash.',
      labels: { module: ['network', 'unknown'], status: ['ok', 'error'] },
    });
    const queued = registry.gauge({ name: 'demo_queued', help: 'Queued.' });
    const duration = registry.histogram({
      name: 'demo_duration_seconds',
      help: 'Duration.',
      labels: { module: ['network', 'unknown'] },
      buckets: [0.1, 1],
    });
    registry.counter({ name: 'demo_plain_total', help: 'No labels.' });
    requests.inc({ module: 'network', status: 'ok' });
    requests.inc({ module: 'network', status: 'ok' }, 2);
    requests.inc({ module: 'network', status: 'error' });
    queued.set({}, 3);
    duration.observe({ module: 'network' }, 0.05);
    duration.observe({ module: 'network' }, 0.5);
    duration.observe({ module: 'network' }, 5);

    expect(await registry.render()).toBe(
      [
        '# HELP demo_requests_total Requests.\\nSecond line \\\\ with a backslash.',
        '# TYPE demo_requests_total counter',
        'demo_requests_total{module="network",status="ok"} 3',
        'demo_requests_total{module="network",status="error"} 1',
        '# HELP demo_queued Queued.',
        '# TYPE demo_queued gauge',
        'demo_queued 3',
        '# HELP demo_duration_seconds Duration.',
        '# TYPE demo_duration_seconds histogram',
        'demo_duration_seconds_bucket{module="network",le="0.1"} 1',
        'demo_duration_seconds_bucket{module="network",le="1"} 2',
        'demo_duration_seconds_bucket{module="network",le="+Inf"} 3',
        'demo_duration_seconds_sum{module="network"} 5.55',
        'demo_duration_seconds_count{module="network"} 3',
        '# HELP demo_plain_total No labels.',
        '# TYPE demo_plain_total counter',
        'demo_plain_total 0',
        '',
      ].join('\n'),
    );
  });

  it('records an undeclared or missing label value as the fallback, never as itself', async () => {
    const registry = new MetricsRegistry();
    const counter = registry.counter({
      name: 'demo_total',
      help: 'Demo.',
      labels: { module: ['network', 'protect', 'unknown'] },
    });
    for (const value of [
      'talk',
      '192.0.2.10',
      'Office AP',
      '11111111-1111-4111-8111-111111111111',
      'a"b\n{}',
      '',
    ]) {
      counter.inc({ module: value });
    }
    counter.inc({});
    counter.inc({ module: 'protect', extra: 'ignored' });
    expect(await registry.render()).toBe(
      [
        '# HELP demo_total Demo.',
        '# TYPE demo_total counter',
        'demo_total{module="unknown"} 7',
        'demo_total{module="protect"} 1',
        '',
      ].join('\n'),
    );
  });

  it('accepts only identifiers in a code label, and only as many as declared', async () => {
    const registry = new MetricsRegistry();
    const failures = registry.counter({
      name: 'demo_failures_total',
      help: 'Demo.',
      labels: { code: codeLabel(2) },
    });
    for (const code of [
      'rate_limited',
      'hard_lock',
      'rate_limited',
      'third_code',
      'Upper',
      'has-dash',
      'api.unexpected-error',
      '192.0.2.10',
      '11111111-1111-4111-8111-111111111111',
      'x'.repeat(49),
    ]) {
      failures.inc({ code });
    }
    failures.inc({});
    const text = await registry.render();
    expect(text).toContain('demo_failures_total{code="rate_limited"} 2');
    expect(text).toContain('demo_failures_total{code="hard_lock"} 1');
    expect(text).toContain('demo_failures_total{code="other"} 8');
    expect(text.match(/^demo_failures_total\{/gm)).toHaveLength(3);
  });

  it('ignores values that are not measurements', async () => {
    const registry = new MetricsRegistry();
    const counter = registry.counter({ name: 'demo_total', help: 'Demo.' });
    const histogram = registry.histogram({ name: 'demo_seconds', help: 'Demo.', buckets: [1] });
    counter.inc({}, -1);
    counter.inc({}, Number.NaN);
    counter.inc({}, Infinity);
    histogram.observe({}, -1);
    histogram.observe({}, Number.NaN);
    const text = await registry.render();
    expect(text).toContain('demo_total 0');
    expect(text).not.toContain('demo_seconds_count');
  });

  it('runs collectors before rendering, and survives one that fails', async () => {
    const registry = new MetricsRegistry();
    const gauge = registry.gauge({
      name: 'demo_feeds',
      help: 'Demo.',
      labels: { state: ['connected', 'other'] },
    });
    let connected = 2;
    registry.collect(() => {
      gauge.reset();
      if (connected > 0) gauge.set({ state: 'connected' }, connected);
    });
    registry.collect(() => Promise.reject(new Error('collector broke')));
    const errors: unknown[] = [];
    expect(await registry.render((error) => errors.push(error))).toContain(
      'demo_feeds{state="connected"} 2',
    );
    expect(errors).toHaveLength(1);
    connected = 0;
    expect(await registry.render()).not.toContain('demo_feeds{');
  });

  it('refuses definitions that are malformed or could grow without bound', () => {
    const registry = new MetricsRegistry();
    const define = (definition: Record<string, unknown>) => () =>
      registry.counter({ name: 'demo_total', help: 'Demo.', ...definition });
    expect(define({ name: 'Demo-Total' })).toThrow(/Invalid metric name/);
    expect(define({ help: ' ' })).toThrow(/help text/);
    expect(define({ labels: { 'bad-name': ['a'] } })).toThrow(/Invalid label name/);
    expect(define({ labels: { le: ['a'] } })).toThrow(/Invalid label name/);
    expect(define({ labels: { state: [] } })).toThrow(/distinct values/);
    expect(define({ labels: { state: ['a', 'a'] } })).toThrow(/distinct values/);
    expect(define({ labels: { state: ['has space'] } })).toThrow(/Invalid value/);
    expect(define({ labels: { state: ['quote"'] } })).toThrow(/Invalid value/);
    expect(define({ labels: { code: codeLabel(0) } })).toThrow(/maximum/);
    expect(
      define({
        labels: {
          a: Array.from({ length: 30 }, (_, i) => `v${String(i)}`),
          b: Array.from({ length: 30 }, (_, i) => `v${String(i)}`),
        },
      }),
    ).toThrow(/900 series/);
    registry.counter({ name: 'demo_total', help: 'Demo.' });
    expect(define({})).toThrow(/already registered/);
    expect(() =>
      registry.histogram({ name: 'demo_seconds', help: 'Demo.', buckets: [1, 1] }),
    ).toThrow(/ascending/);
    expect(() => registry.histogram({ name: 'demo_seconds', help: 'Demo.', buckets: [] })).toThrow(
      /ascending/,
    );
  });

  it('lists its families with their declared labels', () => {
    const registry = new MetricsRegistry();
    registry.gauge({ name: 'demo_ready', help: 'Ready.' });
    registry.counter({ name: 'demo_total', help: 'Demo.', labels: { state: ['a', 'b'] } });
    expect(registry.families()).toEqual([
      { name: 'demo_ready', help: 'Ready.', type: 'gauge', labels: {} },
      { name: 'demo_total', help: 'Demo.', type: 'counter', labels: { state: ['a', 'b'] } },
    ]);
  });
});
