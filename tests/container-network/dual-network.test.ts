/**
 * The two-network deployment, on real containers (spec §9.2 acceptance, §17 "Dual-network
 * setup proves no routing/forwarding and correct interface-bound services"; ADR 0028).
 *
 * The service runs exactly as deploy/compose.dual.yml defines it. The two LANs are
 * isolated Docker bridges for the test. A client container is on the client network only;
 * a synthetic console is on the management network only.
 *
 *   client ──(client net)── unifi-mcp ──(management net)── console
 *
 * Opt-in (`npm run test:containers`); needs Docker. Not part of `npm run check`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ADDRESSES,
  dockerProblem,
  NETWORK_KEY,
  probe,
  project,
  workspace,
  type Project,
  type Workspace,
} from './harness.ts';

const A = ADDRESSES;
const MCP = { host: A.serviceOnClientNet, port: 3000, servername: A.publicName, ca: '/pki/ca.pem' };

let ws: Workspace;
let p: Project;
let token = '';

function cli(...argv: string[]): { code: number; out: string; err: string } {
  const result = p.exec('unifi-mcp', ['unifi-mcp', ...argv]);
  return { code: result.code, out: result.stdout, err: result.stderr };
}

/** One MCP JSON-RPC request from the client container. */
function mcp(method: string, params: object, bearer = token): { status: number; body: string } {
  const [result] = probe(p, 'client', [
    {
      type: 'https',
      ...MCP,
      path: '/mcp',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    },
  ]);
  return result as { status: number; body: string };
}

beforeAll(() => {
  const problem = dockerProblem();
  if (problem !== undefined) throw new Error(problem);
  ws = workspace('dual');
  p = project(
    'umcp-nettest-dual',
    ['deploy/compose.dual.yml', 'tests/container-network/compose.dual.test.yml'],
    ws,
    {
      UNIFI_MCP_CLIENT_NIC: 'unused-in-tests',
      UNIFI_MCP_CLIENT_SUBNET: A.clientSubnet,
      UNIFI_MCP_CLIENT_IP: A.serviceOnClientNet,
      UNIFI_MCP_PUBLIC_NAME: A.publicName,
      UNIFI_MCP_MANAGEMENT_NIC: 'unused-in-tests',
      UNIFI_MCP_MANAGEMENT_SUBNET: A.managementSubnet,
      UNIFI_MCP_MANAGEMENT_GATEWAY: A.managementGateway,
      UNIFI_MCP_MANAGEMENT_IP: A.serviceOnManagementNet,
      // Only the console may ever be contacted.
      UNIFI_MCP_CONSOLE_CIDRS: `${A.console}/32`,
    },
  );
  p.down();
  p.up();
  // Configure with the CLI inside the container, as an operator would.
  for (const argv of [
    [
      'console',
      'add',
      '--alias',
      'lab',
      '--host',
      A.console,
      '--tls',
      'verify',
      '--ca-file',
      '/pki/ca.pem',
    ],
    ['console', 'set-credential', 'lab', '--module', 'network', '--key-file', '/pki/network.key'],
    [
      'console',
      'enable-module',
      'lab',
      '--module',
      'network',
      '--mode',
      'read_only',
      '--port',
      '8443',
    ],
    ['console', 'probe', 'lab', '--module', 'network'],
  ]) {
    const result = cli(...argv);
    if (result.code !== 0) throw new Error(`${argv.join(' ')}: ${result.err}${result.out}`);
  }
  const created = cli(
    'client',
    'create',
    'probe',
    '--console',
    'lab',
    '--allow',
    'network.*.read',
    '--json',
  );
  if (created.code !== 0) throw new Error(created.err);
  token = (JSON.parse(created.out) as { token: string }).token;
}, 240_000);

afterAll(() => {
  p.down();
  ws.remove();
}, 120_000);

describe('the service container', () => {
  it('does not forward, has no capabilities and no writable root', () => {
    const forward = p.exec('unifi-mcp', ['cat', '/proc/sys/net/ipv4/ip_forward']);
    expect(forward.stdout.trim()).toBe('0');
    const status = p.exec('unifi-mcp', ['cat', '/proc/1/status']).stdout;
    for (const set of ['CapPrm', 'CapEff', 'CapBnd', 'CapAmb']) {
      expect(status, set).toMatch(new RegExp(`${set}:\\s+0000000000000000`));
    }
    expect(status).toMatch(/NoNewPrivs:\s+1/);
    expect(p.exec('unifi-mcp', ['touch', '/app/x']).code).not.toBe(0);
    // It cannot turn forwarding back on.
    expect(
      p.exec('unifi-mcp', ['sh', '-c', 'echo 1 > /proc/sys/net/ipv4/ip_forward']).code,
    ).not.toBe(0);
    expect(p.exec('unifi-mcp', ['cat', '/proc/sys/net/ipv4/ip_forward']).stdout.trim()).toBe('0');
  });

  it('listens for MCP on the client-side address only, and for admin on the management side only', () => {
    // From the management network: MCP is not there, the admin interface is.
    const fromManagement = probe(p, 'console', [
      { type: 'tcp', host: A.serviceOnManagementNet, port: 3000 },
      { type: 'tcp', host: A.serviceOnManagementNet, port: 3001 },
      { type: 'tcp', host: A.serviceOnManagementNet, port: 9464 },
    ]);
    expect(fromManagement).toEqual(['ECONNREFUSED', 'connected', 'ECONNREFUSED']);
    // From the client network: MCP is there, admin and metrics are not.
    const fromClient = probe(p, 'client', [
      { type: 'tcp', host: A.serviceOnClientNet, port: 3000 },
      { type: 'tcp', host: A.serviceOnClientNet, port: 3001 },
      { type: 'tcp', host: A.serviceOnClientNet, port: 9464 },
    ]);
    expect(fromClient).toEqual(['connected', 'ECONNREFUSED', 'ECONNREFUSED']);
  });
});

describe('a client on the client network', () => {
  it('reads through MCP over HTTPS, and the console sees only the service', () => {
    const [live] = probe(p, 'client', [{ type: 'https', ...MCP, path: '/livez' }]) as {
      status: number;
    }[];
    expect(live?.status).toBe(200);
    const result = mcp('tools/call', {
      name: 'unifi_execute',
      arguments: { operationId: 'network.info.get', consoleId: consoleId() },
    });
    expect(result.status).toBe(200);
    expect(result.body).toContain('"status":"ok"');
    expect(result.body).toContain('11.0.97');
    const seen = p
      .logs('console')
      .split('\n')
      .filter((line) => line.includes('"url"'))
      .map((line) => JSON.parse(line) as { remote: string; authorised: boolean; url: string });
    expect(seen.length).toBeGreaterThan(0);
    for (const request of seen) {
      expect(request.remote.replace('::ffff:', '')).toBe(A.serviceOnManagementNet);
      expect(request.authorised).toBe(true);
      expect(request.url).toBe('/proxy/network/integration/v1/info');
    }
  });

  it('is refused without a token, and never sees the console key', () => {
    const anonymous = mcp('tools/list', {}, 'not-a-token');
    expect(anonymous.status).toBe(401);
    const listed = mcp('tools/call', { name: 'unifi_list_consoles', arguments: {} });
    expect(listed.status).toBe(200);
    expect(listed.body).not.toContain(NETWORK_KEY);
    expect(listed.body).not.toContain('CONTAINER-TEST');
  });

  it('cannot reach the management network, the console or the admin interface', () => {
    const results = probe(p, 'client', [
      { type: 'tcp', host: A.console, port: 8443 },
      { type: 'tcp', host: A.serviceOnManagementNet, port: 3000 },
      { type: 'tcp', host: A.serviceOnManagementNet, port: 3001 },
      { type: 'tcp', host: A.managementGateway, port: 22 },
    ]);
    for (const result of results) {
      expect(['ENETUNREACH', 'EHOSTUNREACH', 'timeout']).toContain(result);
    }
  });

  it('cannot use the MCP listener as a proxy or a tunnel', () => {
    const target = `${A.console}:8443`;
    const results = probe(p, 'client', [
      { type: 'raw', ...MCP, send: `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n` },
      {
        type: 'raw',
        ...MCP,
        send: `GET https://${target}/proxy/network/integration/v1/info HTTP/1.1\r\nHost: ${target}\r\n\r\n`,
      },
      { type: 'https', ...MCP, path: `/mcp/../proxy/network/integration/v1/info` },
      { type: 'https', ...MCP, path: `/?url=https://${target}/` },
    ]) as (string | { status: number; body: string })[];
    expect(results[0]).not.toMatch(/^HTTP\/1\.1 2/);
    expect(results[1]).not.toMatch(/^HTTP\/1\.1 2/);
    expect((results[2] as { status: number }).status).toBe(404);
    expect((results[3] as { status: number }).status).toBe(404);
    // Nor through an operation: arguments cannot name a destination.
    const smuggled = mcp('tools/call', {
      name: 'unifi_execute',
      arguments: {
        operationId: 'network.info.get',
        consoleId: consoleId(),
        arguments: { host: A.client, url: `https://${A.client}/`, port: 22 },
      },
    });
    expect(smuggled.body).not.toContain('"status":"ok"');
    expect(smuggled.body).toContain('invalid_arguments');
    // The console saw nothing but the documented read.
    expect(p.logs('console')).not.toMatch(/"url":"(?!\/proxy\/network\/integration\/v1\/info")/);
  });
});

describe('egress', () => {
  it('refuses a console address outside the allowlist, such as one on the client network', () => {
    const added = cli(
      'console',
      'add',
      '--alias',
      'wrong',
      '--host',
      A.client,
      '--tls',
      'insecure',
    );
    expect(added.code).toBe(0);
    cli(
      'console',
      'set-credential',
      'wrong',
      '--module',
      'network',
      '--key-file',
      '/pki/network.key',
    );
    cli('console', 'enable-module', 'wrong', '--module', 'network', '--port', '8443');
    const check = cli('console', 'check', 'wrong', '--module', 'network');
    expect(check.code).not.toBe(0);
    expect(`${check.out}${check.err}`).toMatch(/egress|allowlist|not allowed/i);
    const probed = cli('console', 'probe', 'wrong', '--module', 'network');
    expect(probed.code).not.toBe(0);
    expect(cli('console', 'remove', 'wrong', '--yes').code).toBe(0);
  });
});

function consoleId(): string {
  const listed = cli('console', 'list', '--json');
  return (
    (JSON.parse(listed.out) as { id: string; alias: string }[]).find((c) => c.alias === 'lab')
      ?.id ?? ''
  );
}
