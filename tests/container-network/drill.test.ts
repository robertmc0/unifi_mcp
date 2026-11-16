/**
 * Maintenance drill on the container image (spec §8.2, §16 Phase 5 "backup/restore
 * drills", §17 "SQLite restart, migration, key rotation and backup/restore are tested"):
 * the commands of docs/backup-restore.md, run the way docs/installation.md says to run
 * them with Docker. `docker compose exec` while the service runs, and a one-off container
 * once it is stopped. Opt-in (`npm run test:containers`).
 */
import { spawnSync } from 'node:child_process';
import {
  openSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
  writeSync,
  closeSync,
} from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dockerProblem, project, workspace, type Project, type Workspace } from './harness.ts';

const PORT = 39310;
const PROJECT = 'umcp-nettest-drill';
const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'drill', version: '0' },
  },
});

let ws: Workspace;
let p: Project;
let token = '';
let backup = '';

function cli(...argv: string[]) {
  return p.exec('unifi-mcp', ['unifi-mcp', ...argv]);
}
/** The CLI in a one-off container, for when the service is stopped. */
function offline(...argv: string[]) {
  return p.run('unifi-mcp', 'unifi-mcp', argv);
}
function must(result: { code: number; stdout: string; stderr: string }, what: string): string {
  if (result.code !== 0) throw new Error(`${what}: ${result.stderr}${result.stdout}`);
  return result.stdout;
}

/** HTTP status of an MCP initialize with the client token. */
function tokenStatus(): Promise<number | string> {
  return new Promise((resolve) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: PORT,
        path: '/mcp',
        method: 'POST',
        timeout: 5000,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${token}`,
        },
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
    req.end(INITIALIZE);
  });
}

function containerLogs(): string {
  const id = spawnSync(
    'docker',
    ['ps', '-aq', '--filter', `label=com.docker.compose.project=${PROJECT}`],
    { encoding: 'utf8' },
  ).stdout.trim();
  return id === '' ? '' : spawnSync('docker', ['logs', id], { encoding: 'utf8' }).stdout;
}

beforeAll(() => {
  const problem = dockerProblem();
  if (problem !== undefined) throw new Error(problem);
  ws = workspace('drill');
  writeFileSync(join(ws.dir, 'secrets/network.key'), 'synthetic-network-key-DRILL-9\n');
  p = project(
    PROJECT,
    [
      'deploy/compose.single.yml',
      'tests/container-network/compose.single.test.yml',
      'tests/container-network/compose.drill.test.yml',
    ],
    ws,
    { UNIFI_MCP_HTTP_HOST_PORT: String(PORT) },
  );
  p.down();
  p.up();
  must(cli('console', 'add', '--alias', 'lab', '--host', '192.0.2.10'), 'console add');
  must(
    cli(
      'console',
      'set-credential',
      'lab',
      '--module',
      'network',
      '--key-file',
      '/keys/network.key',
    ),
    'set-credential',
  );
  must(cli('console', 'enable-module', 'lab', '--module', 'network'), 'enable-module');
  const created = must(
    cli('client', 'create', 'probe', '--console', 'lab', '--allow', 'network.*.read', '--json'),
    'client create',
  );
  token = (JSON.parse(created) as { token: string }).token;
});

afterAll(() => {
  p.down();
  ws.remove();
});

describe('maintenance drill on the image', () => {
  it('backs up while the service runs, and refuses offline operations until it is stopped', async () => {
    expect(await tokenStatus()).toBe(200);
    const result = JSON.parse(must(cli('db', 'backup', '--json'), 'db backup')) as {
      path: string;
      keyId: string;
    };
    backup = result.path;
    expect(backup).toMatch(/^\/data\/backups\/manual-\d{8}T\d{6}Z\.db$/);
    expect(statSync(join(ws.dir, 'data/backups', backup.split('/').pop() ?? '')).mode & 0o777).toBe(
      0o600,
    );
    must(cli('db', 'check', '--backup', backup), 'db check --backup');
    // A change made after the backup, to see that a restore really goes back.
    must(cli('client', 'create', 'later', '--json'), 'client create later');
    for (const argv of [
      ['db', 'restore', backup, '--yes'],
      ['crypto', 'rotate-key', '--new-key-file', '/keys/none.key', '--yes'],
    ]) {
      const refused = cli(...argv);
      expect(refused.code, argv.join(' ')).not.toBe(0);
      expect(refused.stderr).toContain('DATA_DIRECTORY_IN_USE');
    }
    expect(await tokenStatus()).toBe(200);
  });

  it('restores with the service stopped, and comes back with the same clients and tokens', async () => {
    p.stop();
    const restored = offline('db', 'restore', backup, '--yes');
    expect(restored.code).toBe(0);
    expect(restored.stdout).toContain('The previous database was kept as');
    p.up();
    const clients = JSON.parse(must(cli('client', 'list', '--json'), 'client list')) as {
      clientId: string;
    }[];
    expect(clients.map((c) => c.clientId)).toEqual(['probe']);
    expect(await tokenStatus()).toBe(200);
    expect(cli('db', 'check').code).toBe(0);
    expect(cli('audit', 'verify').code).toBe(0);
    const kinds = (
      JSON.parse(must(cli('db', 'backups', '--json'), 'db backups')) as { kind: string }[]
    ).map((f) => f.kind);
    expect(kinds.sort()).toEqual(['manual', 'pre-restore']);
  });

  it('survives being killed: the next start is healthy and the audit chain is intact', async () => {
    const id = spawnSync(
      'docker',
      ['ps', '-q', '--filter', `label=com.docker.compose.project=${PROJECT}`],
      { encoding: 'utf8' },
    ).stdout.trim();
    expect(spawnSync('docker', ['kill', '--signal', 'KILL', id]).status).toBe(0);
    p.up();
    expect(await tokenStatus()).toBe(200);
    expect(cli('audit', 'verify').code).toBe(0);
    expect(cli('doctor').code).toBe(0);
  });

  it('refuses to start on a corrupted database, and a restore repairs it', async () => {
    p.stop();
    const file = join(ws.dir, 'data/unifi-mcp.db');
    const size = statSync(file).size;
    const fd = openSync(file, 'r+');
    writeSync(fd, Buffer.alloc(8192, 0x5a), 0, 8192, Math.floor(size / 2 / 4096) * 4096);
    closeSync(fd);
    const failed = p.tryUp();
    expect(failed.code).not.toBe(0);
    expect(containerLogs()).toContain('DATABASE_CORRUPT');
    expect(await tokenStatus()).not.toBe(200);
    p.stop();
    expect(offline('db', 'restore', backup, '--yes').code).toBe(0);
    p.up();
    expect(await tokenStatus()).toBe(200);
    expect(cli('db', 'check').code).toBe(0);
  });

  it('rotates the master key offline; only the new key starts the service afterwards', async () => {
    p.stop();
    must(offline('crypto', 'generate-key', '--out', '/keys/next.key'), 'generate-key');
    const rotated = offline(
      'crypto',
      'rotate-key',
      '--new-key-file',
      '/keys/next.key',
      '--yes',
      '--json',
    );
    expect(rotated.code).toBe(0);
    expect((JSON.parse(rotated.stdout) as { reencrypted: number }).reencrypted).toBe(1);
    // Still configured with the old key: the service must not start.
    const stale = p.tryUp();
    expect(stale.code).not.toBe(0);
    expect(containerLogs()).toContain('MASTER_KEY_MISMATCH');
    p.stop();
    // The operator points the deployment at the new key and archives the old one.
    renameSync(join(ws.dir, 'secrets/master.key'), join(ws.dir, 'secrets/retired.key'));
    renameSync(join(ws.dir, 'secrets/next.key'), join(ws.dir, 'secrets/master.key'));
    p.up();
    expect(await tokenStatus()).toBe(200);
    expect(cli('db', 'check').code).toBe(0);
    expect(cli('doctor').code).toBe(0);
    // The pre-rotation backup exists and needs the retired key.
    const backups = readdirSync(join(ws.dir, 'data/backups'));
    const preRotation = backups.find((name) => name.startsWith('pre-rotation-'));
    expect(preRotation).toBeDefined();
    expect(cli('db', 'check', '--backup', `/data/backups/${preRotation ?? ''}`).code).not.toBe(0);
  });
});
