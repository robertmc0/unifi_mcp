/**
 * Network reads of networks and VLANs against response shapes seen on a real console
 * (Network 11.0.99, 2026-11-12), with synthetic values only: dispatcher → registry (real
 * contract inventory) → HTTPS executor → synthetic console.
 *
 * On that console `network.networks.list` and `network.networks.get` answered for every
 * network, including those in use, while `network.networks.get_references` failed with
 * HTTP 500 for networks in use. These tests pin down that the service reads networks the
 * same way: one documented request each, no enrichment calls, the values as the console
 * sent them, and errors that say whether the console or the response was at fault.
 */
import { join } from 'node:path';
import { Dispatcher, ExecutionStore, OperationRegistry } from '@unifi-local-mcp/core';
import { ClientPolicySchema } from '@unifi-local-mcp/policy';
import { loadContractInventory } from '@unifi-local-mcp/unifi-api';
import { NETWORK_OPERATIONS } from '@unifi-local-mcp/unifi-network';
import { describe, expect, it } from 'vitest';
import { sendJson } from '../fixtures/mock-console.ts';
import { TEST_LIMITS } from '../unit/core/fixtures.ts';
import { useTempDirs } from '../unit/storage/fixtures.ts';
import { CLI, unifiHarness } from '../unit/unifi-api/fixtures.ts';

const tempDir = useTempDirs();
const inventory = await loadContractInventory(join(import.meta.dirname, '../../api-specs'));
const SITE = '00000000-0000-4000-8000-00000000a51e';
const NETWORKS = `/proxy/network/integration/v1/sites/${SITE}/networks`;
const PRINCIPAL = { clientId: 'reader' };
const ZONE = '00000000-0000-4000-8000-0000000020e1';
const REQUEST_ID = '00000000-0000-4000-8000-00000000e500';

/** A copy of an object without some of its properties. */
const without = (value: object, ...keys: string[]): Record<string, unknown> =>
  Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));

const networkId = (vlanId: number) =>
  `00000000-0000-4000-8000-${vlanId.toString(16).padStart(12, '0')}`;

/** Ten networks as the list returns them: summaries, one system-defined default. */
const VLANS = [1, 10, 20, 40, 50, 60, 70, 80, 90, 100];
const SUMMARIES = VLANS.map((vlanId) => ({
  management: 'GATEWAY',
  id: networkId(vlanId),
  name: vlanId === 1 ? 'Default' : `Network ${String(vlanId)}`,
  enabled: true,
  vlanId,
  metadata: { origin: vlanId === 1 ? 'SYSTEM_DEFINED' : 'USER_DEFINED' },
  zoneId: ZONE,
  default: vlanId === 1,
}));

/** A gateway network in detail, including the empty strings the console pads lists with. */
const DETAIL = {
  management: 'GATEWAY',
  id: networkId(80),
  name: 'Network 80',
  enabled: true,
  vlanId: 80,
  metadata: { origin: 'USER_DEFINED' },
  zoneId: ZONE,
  dhcpGuarding: { trustedDhcpServerIpAddresses: ['192.0.2.1', '', ''] },
  isolationEnabled: false,
  cellularBackupEnabled: false,
  internetAccessEnabled: true,
  mdnsForwardingEnabled: true,
  ipv4Configuration: {
    autoScaleEnabled: false,
    hostIpAddress: '192.0.2.1',
    prefixLength: 24,
    dhcpConfiguration: {
      mode: 'SERVER',
      dnsServerIpAddressesOverride: ['198.51.100.53', ''],
      ipAddressRange: { start: '192.0.2.6', stop: '192.0.2.254' },
      leaseTimeSeconds: 86_400,
      pingConflictDetectionEnabled: true,
    },
  },
  default: false,
};

const UNEXPECTED_ERROR = {
  statusCode: 500,
  statusName: 'INTERNAL_SERVER_ERROR',
  code: 'api.unexpected-error',
  message: 'Unexpected error',
  timestamp: '2026-11-12T00:00:00Z',
  requestPath: '/integration/v1/sites/…/networks/…/references',
  requestId: REQUEST_ID,
};

async function stack() {
  const h = await unifiHarness({ dir: await tempDir() });
  h.consoles.setPolicy(h.consoleId, { modules: { network: { state: 'read_only' } } }, CLI);
  h.consoles.recordObservedVersion(h.consoleId, 'network', '11.0.97');
  const registry = new OperationRegistry(inventory);
  for (const descriptor of NETWORK_OPERATIONS) registry.register(descriptor);
  registry.seal();
  const client = ClientPolicySchema.parse({
    clientId: PRINCIPAL.clientId,
    consoles: { [h.consoleId]: { sites: '*' } },
    allow: ['network.*.read'],
  });
  const dispatcher = new Dispatcher({
    registry,
    executor: h.executor,
    security: {
      clientPolicy: (id) => (id === client.clientId ? client : undefined),
      consolePolicy: (id) => h.consoles.policy(id),
      capability: (id, descriptor) => h.consoles.capability(id, descriptor),
    },
    policyStore: h.policyStore,
    deployment: { forceReadOnly: true },
    audit: h.audit,
    executions: new ExecutionStore(h.storage.db),
    logger: h.log.logger,
    limits: TEST_LIMITS,
  });
  const read = (operationId: string, args?: Record<string, unknown>) =>
    dispatcher.execute(PRINCIPAL, {
      operationId,
      consoleId: h.consoleId,
      siteId: SITE,
      ...(args === undefined ? {} : { arguments: args }),
    });
  const logged = (msg: string) => h.log.records().filter((record) => record['msg'] === msg);
  return { h, read, logged };
}

describe('Network networks reads (shapes seen on Network 11.0.99)', () => {
  it('lists all ten networks, system- and user-defined, with their paging facts', async () => {
    const { h, read } = await stack();
    h.mock.respond = (_req, res) => {
      sendJson(res, 200, { offset: 0, limit: 25, count: 10, totalCount: 10, data: SUMMARIES });
    };
    const envelope = await read('network.networks.list');
    expect(envelope.status).toBe('ok');
    expect(envelope.data).toEqual(SUMMARIES);
    expect(envelope.pagination).toEqual({ offset: 0, limit: 25, count: 10, totalCount: 10 });
    expect(h.mock.requests.map((r) => `${r.method} ${r.url}`)).toEqual([`GET ${NETWORKS}`]);
    await h.close();
  });

  it('pages: the next offset until the last page', async () => {
    const { h, read } = await stack();
    h.mock.respond = (req, res) => {
      const offset = Number(new URL(req.url, 'https://console').searchParams.get('offset'));
      const data = SUMMARIES.slice(offset, offset + 5);
      sendJson(res, 200, { offset, limit: 5, count: data.length, totalCount: 10, data });
    };
    const first = await read('network.networks.list', { offset: 0, limit: 5 });
    expect(first.pagination).toMatchObject({ count: 5, totalCount: 10, nextOffset: 5 });
    const last = await read('network.networks.list', { offset: 5, limit: 5 });
    expect(last.pagination).toEqual({ offset: 5, limit: 5, count: 5, totalCount: 10 });
    expect([...(first.data as unknown[]), ...(last.data as unknown[])]).toEqual(SUMMARIES);
    await h.close();
  });

  it('reads one network by its UUID, as the console sent it (empty list entries kept)', async () => {
    const { h, read } = await stack();
    h.mock.respond = (_req, res) => {
      sendJson(res, 200, DETAIL); // a single object, not wrapped in `data`
    };
    const envelope = await read('network.networks.get', { networkId: networkId(80) });
    expect(envelope.status).toBe('ok');
    expect(envelope.data).toEqual(DETAIL);
    expect(envelope.pagination).toBeUndefined();
    // Exactly the documented request: no references, devices or other enrichment.
    expect(h.mock.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      `GET ${NETWORKS}/${networkId(80)}`,
    ]);
    await h.close();
  });

  it('reads networks without their optional properties, of every management type', async () => {
    const { h, read } = await stack();
    const ipv4 = without(DETAIL.ipv4Configuration, 'dhcpConfiguration');
    const minimal = [
      {
        ...without(DETAIL, 'dhcpGuarding', 'zoneId'),
        ipv4Configuration: ipv4,
        metadata: { origin: 'SYSTEM_DEFINED' },
      },
      {
        management: 'SWITCH',
        id: networkId(70),
        name: 'Network 70',
        enabled: true,
        vlanId: 70,
        metadata: { origin: 'USER_DEFINED' },
        default: false,
        cellularBackupEnabled: false,
        isolationEnabled: false,
        deviceId: '00000000-0000-4000-8000-0000000de71c',
        ipv4Configuration: ipv4,
      },
      {
        management: 'UNMANAGED',
        id: networkId(90),
        name: 'Network 90',
        enabled: false,
        vlanId: 90,
        metadata: { origin: 'USER_DEFINED' },
        default: false,
      },
    ];
    for (const network of minimal) {
      h.mock.respond = (_req, res) => {
        sendJson(res, 200, network);
      };
      const envelope = await read('network.networks.get', { networkId: network.id });
      expect(envelope.status, network.management).toBe('ok');
      expect(envelope.data, network.management).toEqual(network);
    }
    await h.close();
  });

  it('refuses a known network type that misses its own fields, rather than dropping them', async () => {
    const { h, read, logged } = await stack();
    const malformed = [
      // Before the fix, both came back as `ok` with only the base fields: no IPv4
      // configuration, isolation or internet access.
      [
        without(DETAIL, 'ipv4Configuration'),
        'ipv4Configuration: invalid_type (expected object, received undefined)',
      ],
      [{ ...DETAIL, zoneId: null }, 'zoneId: invalid_type (expected string, received null)'],
    ] as const;
    for (const [network, mismatch] of malformed) {
      h.mock.respond = (_req, res) => {
        sendJson(res, 200, network);
      };
      const envelope = await read('network.networks.get', { networkId: networkId(80) });
      expect(envelope).toMatchObject({
        status: 'error',
        error: { code: 'upstream_contract_mismatch' },
      });
      expect(envelope.data).toBeUndefined();
      // A local validation failure, logged with the field, never with values.
      expect(logged('console response does not match the contract').at(-1)).toMatchObject({
        level: 'warn',
        operationId: 'network.networks.get',
        contractRevision: '11.0.97',
        mismatches: [mismatch],
      });
    }
    expect(h.log.lines.join('\n')).not.toContain('192.0.2.1');
    await h.close();
  });

  it('takes the network UUID, never the VLAN id, and sends nothing for a VLAN id', async () => {
    const { h, read } = await stack();
    for (const networkIdArgument of ['80', 80]) {
      const envelope = await read('network.networks.get', { networkId: networkIdArgument });
      expect(envelope).toMatchObject({ status: 'error', error: { code: 'invalid_arguments' } });
    }
    expect(h.mock.requests).toEqual([]);
    await h.close();
  });

  it('a failing references read leaves the network reads intact', async () => {
    const { h, read } = await stack();
    h.mock.respond = (req, res) => {
      if (req.url.endsWith('/references')) sendJson(res, 500, UNEXPECTED_ERROR);
      else if (req.url.startsWith(`${NETWORKS}/`)) sendJson(res, 200, DETAIL);
      else sendJson(res, 200, { offset: 0, limit: 25, count: 10, totalCount: 10, data: SUMMARIES });
    };
    const args = { networkId: networkId(80) };
    expect((await read('network.networks.list')).status).toBe('ok');
    expect((await read('network.networks.get', args)).data).toEqual(DETAIL);
    expect(h.mock.requests.some((r) => r.url.endsWith('/references'))).toBe(false);

    const references = await read('network.networks.get_references', args);
    expect(references).toMatchObject({ status: 'error', error: { code: 'upstream_unavailable' } });
    // The reviewed meaning follows the console's error: in use, never unused.
    expect(references.error?.message).toBe(
      'The console reported an internal error (HTTP 500, code api.unexpected-error). The ' +
        'console could not list what uses this network. On Network 11.0.99 this happens for ' +
        'networks used by clients or devices: treat the network as in use, never as unused, ' +
        'and check in UniFi Network. Retrying does not help.',
    );
    // One request each: list and get succeeded, and the known failure was not retried.
    expect(h.mock.requests.map((r) => r.url.split('/').at(-1))).toEqual([
      'networks',
      networkId(80),
      'references',
    ]);
    await h.close();
  });

  it('still retries and plainly reports any other console error of the references read', async () => {
    const { h, read } = await stack();
    for (const body of [
      { ...UNEXPECTED_ERROR, code: 'api.other-error' },
      { message: 'no documented code' },
    ]) {
      h.mock.requests.length = 0;
      h.mock.respond = (_req, res) => {
        sendJson(res, 500, body);
      };
      const envelope = await read('network.networks.get_references', {
        networkId: networkId(80),
      });
      expect(envelope.error?.code).toBe('upstream_unavailable');
      expect(envelope.error?.message).toMatch(
        /^The console reported an internal error \(HTTP 500[^)]*\)\.$/u,
      );
      expect(h.mock.requests).toHaveLength(1 + TEST_LIMITS.readRetries);
    }
    // A 502 with the same code is not the known failure either.
    h.mock.requests.length = 0;
    h.mock.respond = (_req, res) => {
      sendJson(res, 502, UNEXPECTED_ERROR);
    };
    await read('network.networks.get_references', { networkId: networkId(80) });
    expect(h.mock.requests).toHaveLength(1 + TEST_LIMITS.readRetries);
    await h.close();
  });

  it('tells a console error, a body that is not JSON and a contract mismatch apart', async () => {
    const { h, read, logged } = await stack();
    const args = { networkId: networkId(80) };
    h.mock.respond = (_req, res) => {
      sendJson(res, 500, UNEXPECTED_ERROR);
    };
    const upstream = await read('network.networks.get_references', args);
    expect(upstream.error?.code).toBe('upstream_unavailable');
    // The documented request id is logged for the administrator, never returned.
    expect(JSON.stringify(upstream)).not.toContain(REQUEST_ID);
    expect(logged('console returned an error').at(-1)).toMatchObject({
      level: 'warn',
      method: 'GET',
      pathTemplate: '/v1/sites/{siteId}/networks/{networkId}/references',
      status: 500,
      upstreamCode: 'api.unexpected-error',
      upstreamRequestId: REQUEST_ID,
    });
    expect(logged('upstream request').at(-1)).toMatchObject({ status: 500 });

    h.mock.respond = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>login</html>');
    };
    expect((await read('network.networks.get', args)).error?.code).toBe('invalid_response');

    h.mock.respond = (_req, res) => {
      sendJson(res, 200, { data: [DETAIL] }); // a list-shaped body for a single network
    };
    expect((await read('network.networks.get', args)).error?.code).toBe(
      'upstream_contract_mismatch',
    );
    expect(logged('console response does not match the contract')).toHaveLength(1);
    await h.close();
  });
});
