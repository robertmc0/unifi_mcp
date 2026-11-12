/**
 * Integration harness: the real service (listener, gate, MCP SDK handler, dispatcher,
 * HTTPS executor) on 127.0.0.1 with an ephemeral port, a synthetic console behind it, and
 * synthetic operations registered against a synthetic contract inventory. Clients are real
 * MCP SDK v2 clients over Streamable HTTP.
 */
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  defineOperation,
  type ContractInventory,
  type EventHubLimits,
  type EventStreamDescriptor,
  type OperationDescriptor,
} from '@unifi-local-mcp/core';
import {
  loadServiceConfig,
  startService,
  type ListenLimits,
  type RunningService,
} from '@unifi-local-mcp/mcp-server';
import { afterEach } from 'vitest';
import { MockConsole, sendJson } from '../fixtures/mock-console.ts';
import { testPki } from '../fixtures/test-pki.ts';
import { ServerWebSocket } from '../fixtures/ws-server.ts';
import {
  getInfo,
  getPicture,
  inventory,
  JPEG,
  listDevices,
  rebootGateway,
  restartDevice,
  updateFirewallRule,
} from '../unit/core/fixtures.ts';
import { testKey } from '../unit/storage/fixtures.ts';

export const CLI = { type: 'cli', id: 'root' } as const;

export const OPERATIONS: OperationDescriptor[] = [
  defineOperation({ ...listDevices, namedTool: 'network_list_devices' }),
  getInfo,
  defineOperation({ ...restartDevice, namedTool: 'network_restart_device' }),
  rebootGateway,
  updateFirewallRule,
  getPicture,
];

export const NETWORK_KEY = 'synthetic-network-key-SENTINEL-77';

/** The synthetic inventory plus one documented subscription for event tests. */
export const EVENT_INVENTORY: ContractInventory = (moduleId, revision, method, path) =>
  inventory(moduleId, revision, method, path) ||
  (moduleId === 'network' &&
    revision === '1.0' &&
    method === 'GET' &&
    path === '/v1/subscribe/things');

export interface TestService {
  service: RunningService;
  mock: MockConsole;
  /** WebSocket subscriptions the synthetic console accepted, in order. */
  sockets: ServerWebSocket[];
  consoleId: string;
  logs: string[];
  mcpUrl: URL;
  /** Creates a client with the given grants on the test console and returns its token. */
  token(clientId: string, allow: string[], consoles?: boolean, sensitive?: string[]): string;
}

const running: { stop: () => Promise<void> }[] = [];
afterEach(async () => {
  await Promise.allSettled(running.splice(0).map((entry) => entry.stop()));
});

export async function startTestService(options: {
  dir: string;
  forceReadOnly?: boolean;
  withConsole?: boolean;
  streamRecheckMs?: number;
  /** Enable the admin listener on an ephemeral loopback port. */
  admin?: boolean;
  eventStreams?: EventStreamDescriptor[];
  eventHubLimits?: Partial<EventHubLimits>;
  listenLimits?: Partial<ListenLimits>;
}): Promise<TestService> {
  const pki = testPki();
  const logs: string[] = [];
  const base = loadServiceConfig({ UNIFI_MCP_DATA_DIR: join(options.dir, 'data') });
  const config = {
    ...base,
    deployment: { forceReadOnly: options.forceReadOnly ?? false },
    egress: { allow: ['127.0.0.1/32'] },
    http: { ...base.http, port: 0 },
    admin:
      options.admin === true
        ? {
            bind: '127.0.0.1',
            port: 0,
            tls: undefined,
            allowPlaintext: false,
            allowedHosts: ['localhost', '127.0.0.1', '[::1]'],
            sessionIdleMinutes: 30,
            sessionMaxHours: 12,
          }
        : undefined,
  };
  const service = await startService({
    config,
    masterKey: testKey('service'),
    operations: OPERATIONS,
    inventory: EVENT_INVENTORY,
    logSink: { write: (line: string) => logs.push(line) },
    ...(options.eventStreams === undefined ? {} : { eventStreams: options.eventStreams }),
    ...(options.eventHubLimits === undefined ? {} : { eventHubLimits: options.eventHubLimits }),
    ...(options.listenLimits === undefined ? {} : { listenLimits: options.listenLimits }),
    ...(options.streamRecheckMs === undefined ? {} : { streamRecheckMs: options.streamRecheckMs }),
  });
  const mock = await MockConsole.start({ key: pki.serverKey, cert: pki.serverCert });
  running.push({
    stop: async () => {
      await service.stop();
      await mock.stop();
    },
  });
  const sockets: ServerWebSocket[] = [];
  mock.upgrade = (request, socket) => {
    if (request.headers['x-api-key'] !== NETWORK_KEY) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    sockets.push(new ServerWebSocket(request, socket));
  };
  mock.respond = (req, res) => {
    if (req.url.endsWith('/picture')) {
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      res.end(Buffer.from(JPEG));
    } else if (req.url.includes('/devices')) {
      if (req.method === 'GET') {
        sendJson(res, 200, {
          data: [{ id: 'dev-1', name: 'Office AP', macAddress: '00:00:5e:00:53:01' }],
        });
      } else {
        sendJson(res, 200, { accepted: true });
      }
    } else if (req.url.includes('/firewall/')) {
      sendJson(res, 200, { updated: true });
    } else {
      sendJson(res, 200, { version: '1.0.5' });
    }
  };
  service.policyStore.setRuntimeMode('read_write', CLI);
  let consoleId = '';
  if (options.withConsole ?? true) {
    const view = service.consoles.add(
      { alias: 'lab', host: '127.0.0.1', tls: { mode: 'verify', caPem: pki.caPem } },
      CLI,
    );
    consoleId = view.id;
    service.consoles.setModulePort(consoleId, 'network', mock.port, CLI);
    service.consoles.setCredential(consoleId, 'network', NETWORK_KEY, CLI);
    service.consoles.setPolicy(consoleId, { modules: { network: { state: 'read_write' } } }, CLI);
    service.consoles.recordObservedVersion(consoleId, 'network', '1.0.5');
  }
  return {
    service,
    mock,
    sockets,
    consoleId,
    logs,
    mcpUrl: new URL('/mcp', service.url),
    token: (clientId, allow, consoles = true, sensitive = []) =>
      service.clients.create(
        {
          clientId,
          policy: {
            allow,
            consoles: consoles && consoleId !== '' ? { [consoleId]: {} } : {},
            ...(sensitive.length === 0 ? {} : { sensitive }),
          },
        },
        CLI,
      ).token,
  };
}

const openClients: Client[] = [];
afterEach(async () => {
  await Promise.allSettled(openClients.splice(0).map((client) => client.close()));
});

export async function connect(
  url: URL,
  token: string | undefined,
  mode: 'legacy' | 'auto' = 'auto',
): Promise<Client> {
  const client = new Client(
    { name: 'integration-test', version: '0.0.0' },
    { versionNegotiation: { mode } },
  );
  openClients.push(client);
  await client.connect(
    new StreamableHTTPClientTransport(url, {
      fetch: (input: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        if (token !== undefined) headers.set('authorization', `Bearer ${token}`);
        return fetch(input, { ...init, headers });
      },
    }),
  );
  return client;
}

export function structured(result: unknown): Record<string, unknown> {
  return (result as { structuredContent?: Record<string, unknown> }).structuredContent ?? {};
}

/** A raw HTTP request with full control over headers (fetch cannot set Host). */
export function rawRequest(
  url: URL,
  options: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      url,
      { method: options.method ?? 'GET', headers: options.headers ?? {} },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });
}

export const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'raw', version: '0' },
  },
});
