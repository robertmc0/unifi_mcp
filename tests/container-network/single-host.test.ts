/**
 * The single-host Compose examples on real containers (spec §9.1, §7.3, §17 "Docker
 * Compose examples are runnable and secure by default"; ADR 0017, ADR 0028):
 * deploy/compose.single.yml (loopback publishing) and deploy/compose.tls.yml (built-in
 * HTTPS on one host address). Opt-in (`npm run test:containers`); needs Docker.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ADDRESSES,
  dockerProblem,
  project,
  workspace,
  type Project,
  type Workspace,
} from './harness.ts';

const SINGLE_PORT = 39300;
const TLS_PORT = 39443;

function get(
  secure: boolean,
  options: { port: number; path: string; host?: string; ca?: string; servername?: string },
): Promise<number | string> {
  return new Promise((resolve) => {
    const req = (secure ? httpsRequest : httpRequest)(
      {
        host: '127.0.0.1',
        port: options.port,
        path: options.path,
        timeout: 5000,
        headers: { host: options.host ?? 'localhost' },
        ...(secure
          ? {
              servername: options.servername ?? ADDRESSES.publicName,
              ...(options.ca === undefined ? {} : { ca: readFileSync(options.ca) }),
            }
          : {}),
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.once('timeout', () => {
      req.destroy();
      resolve('timeout');
    });
    req.once('error', (error: NodeJS.ErrnoException) => {
      resolve(error.code ?? 'error');
    });
    req.end();
  });
}

function tcp(host: string, port: number): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect({ host, port, timeout: 3000 });
    socket.once('connect', () => {
      socket.destroy();
      resolve('connected');
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve('timeout');
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      resolve(error.code ?? 'error');
    });
  });
}

/** An IPv4 address of this host that is not loopback and not a Docker bridge, if any. */
function routableAddress(): string | undefined {
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    if (/^(lo|docker|br-|veth)/.test(name)) continue;
    const entry = entries?.find((e) => e.family === 'IPv4' && !e.internal);
    if (entry !== undefined) return entry.address;
  }
  return undefined;
}

function published(projectName: string): string[] {
  const result = spawnSync(
    'docker',
    ['ps', '--filter', `label=com.docker.compose.project=${projectName}`, '--format', '{{.Ports}}'],
    { encoding: 'utf8' },
  );
  return result.stdout
    .trim()
    .split(/,\s*/)
    .filter((entry) => entry.includes('->'));
}

beforeAll(() => {
  const problem = dockerProblem();
  if (problem !== undefined) throw new Error(problem);
});

describe('deploy/compose.single.yml', () => {
  let ws: Workspace;
  let p: Project;

  beforeAll(() => {
    ws = workspace('single');
    p = project(
      'umcp-nettest-single',
      ['deploy/compose.single.yml', 'tests/container-network/compose.single.test.yml'],
      ws,
      { UNIFI_MCP_HTTP_HOST_PORT: String(SINGLE_PORT) },
    );
    p.down();
    p.up();
  });
  afterAll(() => {
    p.down();
    ws.remove();
  });

  it('starts healthy, read-only and locked, with no console configured', async () => {
    expect(await get(false, { port: SINGLE_PORT, path: '/livez' })).toBe(200);
    expect(await get(false, { port: SINGLE_PORT, path: '/readyz' })).toBe(200);
    const doctor = p.exec('unifi-mcp', ['unifi-mcp', 'doctor']);
    expect(doctor.code).toBe(0);
    expect(doctor.stdout).toMatch(/hard lock\s+OK\s+ON: no writes can run/);
    expect(doctor.stdout).toMatch(/metrics\s+OK\s+off/);
    const status = p.exec('unifi-mcp', ['cat', '/proc/1/status']).stdout;
    expect(status).toMatch(/CapEff:\s+0000000000000000/);
    expect(p.exec('unifi-mcp', ['touch', '/app/x']).code).not.toBe(0);
    expect(p.exec('unifi-mcp', ['id', '-u']).stdout.trim()).toBe(String(process.getuid?.()));
  });

  it('publishes the MCP port on the host loopback only, and nothing else', async () => {
    expect(published('umcp-nettest-single')).toEqual([
      `127.0.0.1:${String(SINGLE_PORT)}->3000/tcp`,
    ]);
    const other = routableAddress();
    // On a host with another interface, the port is not open there.
    if (other !== undefined) expect(await tcp(other, SINGLE_PORT)).toBe('ECONNREFUSED');
    // The MCP endpoint is there and wants a token.
    expect(await get(false, { port: SINGLE_PORT, path: '/mcp' })).toBe(401);
    expect(await get(false, { port: SINGLE_PORT, path: '/metrics' })).toBe(404);
  });

  it('stops cleanly on SIGTERM', () => {
    const id = spawnSync(
      'docker',
      ['ps', '-q', '--filter', 'label=com.docker.compose.project=umcp-nettest-single'],
      { encoding: 'utf8' },
    ).stdout.trim();
    expect(spawnSync('docker', ['stop', '--time', '15', id]).status).toBe(0);
    const exit = spawnSync('docker', ['inspect', '--format', '{{.State.ExitCode}}', id], {
      encoding: 'utf8',
    }).stdout.trim();
    expect(exit).toBe('0');
    expect(spawnSync('docker', ['logs', id], { encoding: 'utf8' }).stdout).toContain(
      '"msg":"service stopped"',
    );
  });
});

describe('deploy/compose.tls.yml', () => {
  let ws: Workspace;
  let p: Project;

  beforeAll(() => {
    ws = workspace('tls');
    p = project(
      'umcp-nettest-tls',
      [
        'deploy/compose.tls.yml',
        'tests/container-network/compose.single.test.yml',
        'tests/container-network/compose.tls.test.yml',
      ],
      ws,
      {
        UNIFI_MCP_PUBLISH_IP: '127.0.0.1',
        UNIFI_MCP_PUBLIC_NAME: ADDRESSES.publicName,
        UNIFI_MCP_HTTP_HOST_PORT: String(TLS_PORT),
      },
    );
    p.down();
    p.up();
  });
  afterAll(() => {
    p.down();
    ws.remove();
  });

  it('serves HTTPS with the mounted certificate, under the configured name', async () => {
    const trusted = { port: TLS_PORT, ca: ws.caFile, host: ADDRESSES.publicName };
    expect(await get(true, { ...trusted, path: '/livez' })).toBe(200);
    expect(await get(true, { ...trusted, path: '/mcp' })).toBe(401);
    // A client that does not trust the certificate's CA does not get through.
    expect(await get(true, { port: TLS_PORT, path: '/livez' })).toMatch(
      /SELF_SIGNED|UNABLE_TO_VERIFY|CERT/,
    );
    // Another name in the Host header is refused on the MCP endpoint (DNS rebinding).
    expect(await get(true, { ...trusted, host: 'evil.example', path: '/mcp' })).toBe(403);
  });

  it('has no plaintext listener, and publishes one port on one address', async () => {
    const plain = await get(false, { port: TLS_PORT, path: '/livez' });
    expect(plain).not.toBe(200);
    expect(published('umcp-nettest-tls')).toEqual([`127.0.0.1:${String(TLS_PORT)}->3000/tcp`]);
    const doctor = p.exec('unifi-mcp', ['unifi-mcp', 'doctor']);
    expect(doctor.code).toBe(0);
    expect(doctor.stdout).toMatch(/listener\s+OK\s+https on 0\.0\.0\.0:3000/);
  });
});
