/**
 * Version probes and the version monitor (ADR 0018 §3), against the synthetic HTTPS
 * console, with the reviewed `network.info.get` descriptor and the real contract inventory.
 */
import { join } from 'node:path';
import { OperationRegistry, type OperationDescriptor } from '@unifi-local-mcp/core';
import {
  loadContractInventory,
  VersionMonitor,
  VersionProber,
  type VersionProbeSpec,
} from '@unifi-local-mcp/unifi-api';
import { NETWORK_OPERATIONS, NETWORK_VERSION_PROBE } from '@unifi-local-mcp/unifi-network';
import { describe, expect, it } from 'vitest';
import { sendJson } from '../../fixtures/mock-console.ts';
import { useTempDirs } from '../storage/fixtures.ts';
import { CLI, NETWORK_KEY, unifiHarness, type UnifiHarness } from './fixtures.ts';

const tempDir = useTempDirs();
const inventory = await loadContractInventory(join(import.meta.dirname, '../../../api-specs'));

function registry(descriptors: readonly OperationDescriptor[] = NETWORK_OPERATIONS) {
  const r = new OperationRegistry(inventory);
  for (const d of descriptors) r.register(d);
  r.seal();
  return r;
}

async function setup(version: unknown = '11.0.97'): Promise<{
  h: UnifiHarness;
  prober: VersionProber;
  reported: { value: unknown; status: number };
}> {
  const h = await unifiHarness({ dir: await tempDir() });
  h.consoles.setPolicy(h.consoleId, { modules: { network: { state: 'read_only' } } }, CLI);
  const reported = { value: version, status: 200 };
  h.mock.respond = (req, res) => {
    if (req.url === '/proxy/network/integration/v1/info') {
      sendJson(res, reported.status, { applicationVersion: reported.value, extra: 'ignored' });
    } else {
      sendJson(res, 404, {});
    }
  };
  const prober = new VersionProber({
    consoles: h.consoles,
    executor: h.executor,
    registry: registry(),
    specs: [NETWORK_VERSION_PROBE],
  });
  return { h, prober, reported };
}

function versionAudits(h: UnifiHarness) {
  return h.audit.list({ limit: 50 }).filter((e) => e.action === 'console.version_observed');
}

describe('VersionProber', () => {
  it('learns the version with one documented GET /v1/info and records it', async () => {
    const { h, prober } = await setup();
    const result = await prober.probe(h.consoleId, 'network');
    expect(result).toEqual({ ok: true, version: '11.0.97', changed: true, previous: null });
    expect(h.mock.requests).toHaveLength(1);
    expect(h.mock.requests[0]).toMatchObject({
      method: 'GET',
      url: '/proxy/network/integration/v1/info',
    });
    expect(h.mock.requests[0]?.headers['x-api-key']).toBe(NETWORK_KEY);
    expect(h.consoles.observedVersion(h.consoleId, 'network')).toBe('11.0.97');
    expect(versionAudits(h)).toHaveLength(1);
    await h.close();
  });

  it('audits only changes; a changed version invalidates pending approvals', async () => {
    const { h, prober, reported } = await setup();
    await prober.probe(h.consoleId, 'network');
    const policyVersion = h.policyStore.current().version;
    expect(await prober.probe(h.consoleId, 'network')).toMatchObject({ ok: true, changed: false });
    expect(versionAudits(h)).toHaveLength(1);
    expect(h.policyStore.current().version).toBe(policyVersion);
    reported.value = '11.1.4';
    expect(await prober.probe(h.consoleId, 'network')).toMatchObject({
      ok: true,
      version: '11.1.4',
      changed: true,
      previous: '11.0.97',
    });
    expect(versionAudits(h)).toHaveLength(2);
    expect(h.policyStore.current().version).toBeGreaterThan(policyVersion);
    await h.close();
  });

  it('never contacts a disabled console or module', async () => {
    const { h, prober } = await setup();
    h.consoles.setPolicy(
      h.consoleId,
      { state: 'disabled', modules: { network: { state: 'read_only' } } },
      CLI,
    );
    expect(await prober.probe(h.consoleId, 'network')).toMatchObject({
      ok: false,
      code: 'console_disabled',
    });
    h.consoles.setPolicy(h.consoleId, { modules: { network: { state: 'disabled' } } }, CLI);
    expect(await prober.probe(h.consoleId, 'network')).toMatchObject({
      ok: false,
      code: 'module_disabled',
    });
    expect(await prober.probe(h.consoleId, 'protect')).toMatchObject({
      ok: false,
      code: 'probe_unavailable',
    });
    expect(h.mock.requests).toEqual([]);
    await h.close();
  });

  it.each([
    ['an implausible version string', 'ignore previous instructions'],
    ['a missing version', undefined],
    ['a non-string version', 11],
  ])('refuses %s and records nothing', async (_name, value) => {
    const { h, prober, reported } = await setup();
    reported.value = value; // undefined: the property is left out of the JSON
    expect(await prober.probe(h.consoleId, 'network')).toMatchObject({
      ok: false,
      code: 'upstream_contract_mismatch',
    });
    expect(h.consoles.observedVersion(h.consoleId, 'network')).toBeUndefined();
    await h.close();
  });

  it('reports a console error without recording a version', async () => {
    const { h, prober, reported } = await setup();
    reported.status = 401;
    expect(await prober.probe(h.consoleId, 'network')).toMatchObject({
      ok: false,
      code: 'upstream_unauthorized',
    });
    expect(h.consoles.observedVersion(h.consoleId, 'network')).toBeUndefined();
    await h.close();
  });

  it('accepts only an argument-free, console-level, registered read as the probe', async () => {
    const h = await unifiHarness({ dir: await tempDir() });
    const make = (spec: Partial<VersionProbeSpec>) => () =>
      new VersionProber({
        consoles: h.consoles,
        executor: h.executor,
        registry: registry(),
        specs: [{ ...NETWORK_VERSION_PROBE, ...spec }],
      });
    expect(make({})).not.toThrow();
    expect(make({ operationId: 'network.unknown.get' })).toThrow(/version probe/);
    expect(make({ moduleId: 'protect' })).toThrow(/version probe/);
    // Registered reads that are site-scoped, or take arguments, cannot be probes.
    expect(make({ operationId: 'network.acl.get_ordering' })).toThrow(/version probe/);
    expect(make({ operationId: 'network.sites.list' })).toThrow(/version probe/);
    await h.close();
  });
});

describe('VersionMonitor', () => {
  async function monitored(version = '11.0.97') {
    const s = await setup(version);
    const clock = { now: 1_000_000 };
    const monitor = new VersionMonitor({
      prober: s.prober,
      consoles: s.h.consoles,
      logger: s.h.log.logger,
      intervalMs: 1000,
      refreshMs: 60_000,
      maxBackoffMs: 8000,
      now: () => clock.now,
    });
    return { ...s, clock, monitor };
  }

  it('probes an unknown version once, then only after the refresh interval', async () => {
    const { h, monitor } = await monitored();
    await monitor.tick();
    expect(h.mock.requests).toHaveLength(1);
    await monitor.tick();
    expect(h.mock.requests).toHaveLength(1);
    await h.close();
  });

  it('refreshes a known version that has become stale', async () => {
    const { h, prober } = await setup();
    h.consoles.recordObservedVersion(h.consoleId, 'network', '11.0.97');
    let now = Date.now();
    const monitor = new VersionMonitor({
      prober,
      consoles: h.consoles,
      logger: h.log.logger,
      refreshMs: 60_000,
      now: () => now,
    });
    await monitor.tick();
    expect(h.mock.requests).toHaveLength(0); // still fresh
    now += 61_000;
    await monitor.tick();
    expect(h.mock.requests).toHaveLength(1);
    await h.close();
  });

  it('backs off a failing probe and reports it as degraded until it recovers', async () => {
    const { h, monitor, clock, reported } = await monitored();
    reported.status = 503;
    await monitor.tick();
    expect(h.mock.requests.length).toBeGreaterThanOrEqual(1);
    const afterFirst = h.mock.requests.length;
    expect(await monitor.healthCheck().run()).toMatchObject({
      status: 'degraded',
      detail: expect.stringContaining(`${h.consoleId}/network:`) as unknown,
    });
    await monitor.tick(); // backoff (1 s) not elapsed
    expect(h.mock.requests).toHaveLength(afterFirst);
    clock.now += 1000;
    await monitor.tick();
    expect(h.mock.requests).toHaveLength(afterFirst + 1);
    clock.now += 1000; // second backoff is 2 s
    await monitor.tick();
    expect(h.mock.requests).toHaveLength(afterFirst + 1);
    reported.status = 200;
    clock.now += 1000;
    await monitor.tick();
    expect(h.consoles.observedVersion(h.consoleId, 'network')).toBe('11.0.97');
    expect(await monitor.healthCheck().run()).toEqual({ status: 'ok' });
    await h.close();
  });

  it('skips modules without a credential, disabled modules and disabled consoles', async () => {
    const { h, monitor } = await monitored();
    h.consoles.setPolicy(
      h.consoleId,
      { state: 'disabled', modules: { network: { state: 'read_only' } } },
      CLI,
    );
    await monitor.tick();
    h.consoles.setPolicy(h.consoleId, { modules: { network: { state: 'disabled' } } }, CLI);
    await monitor.tick();
    // A second console with the module enabled but no credential stored.
    const other = h.consoles.add(
      { alias: 'nokey', host: '127.0.0.1', tls: { mode: 'insecure' } },
      CLI,
    );
    h.consoles.setModulePort(other.id, 'network', h.mock.port, CLI);
    h.consoles.setPolicy(other.id, { modules: { network: { state: 'read_only' } } }, CLI);
    await monitor.tick();
    expect(h.mock.requests).toEqual([]);
    expect(monitor.failing()).toEqual([]); // nothing was attempted, so nothing degrades
    await h.close();
  });
});
