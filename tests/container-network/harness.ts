/**
 * Harness for the container tests: a temporary directory with a master key and a
 * synthetic PKI (generated with the openssl CLI, never committed), and a thin wrapper
 * around `docker compose` for one project. Everything runs on the local Docker engine
 * with the image under test; nothing is pulled and nothing leaves the machine.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const REPO_ROOT = join(import.meta.dirname, '../..');
export const IMAGE = process.env['UNIFI_MCP_TEST_IMAGE']?.trim() || 'unifi-local-mcp:nettest';
export const NETWORK_KEY = 'synthetic-network-key-CONTAINER-TEST-42';

/** The addresses of the dual-network test (documentation-free private test ranges). */
export const ADDRESSES = {
  clientSubnet: '172.31.210.0/24',
  serviceOnClientNet: '172.31.210.2',
  client: '172.31.210.20',
  managementSubnet: '172.31.220.0/24',
  managementGateway: '172.31.220.1',
  serviceOnManagementNet: '172.31.220.2',
  console: '172.31.220.3',
  publicName: 'mcp.test.invalid',
} as const;

export interface Workspace {
  dir: string;
  caFile: string;
  remove(): void;
}

function openssl(cwd: string, args: string[]): void {
  execFileSync('openssl', args, { cwd, stdio: 'pipe' });
}

function issue(pki: string, name: string, subjectAltName: string): void {
  const ec = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes'];
  openssl(pki, [
    'req',
    ...ec,
    '-subj',
    `/CN=${name}.test`,
    '-keyout',
    `${name}.key`,
    '-out',
    `${name}.csr`,
  ]);
  writeFileSync(
    join(pki, `${name}.ext`),
    `subjectAltName=${subjectAltName}\nbasicConstraints=CA:FALSE\n` +
      'keyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\n',
  );
  openssl(pki, [
    'x509',
    '-req',
    '-in',
    `${name}.csr`,
    '-CA',
    'ca.pem',
    '-CAkey',
    'ca.key',
    '-CAcreateserial',
    '-days',
    '2',
    '-out',
    `${name}.pem`,
    '-extfile',
    `${name}.ext`,
  ]);
}

/** A fresh data directory, master key, console key and certificates. */
export function workspace(label: string): Workspace {
  const dir = mkdtempSync(join(tmpdir(), `unifi-mcp-${label}-`));
  for (const sub of ['data', 'secrets', 'pki']) mkdirSync(join(dir, sub), { mode: 0o700 });
  writeFileSync(join(dir, 'secrets/master.key'), `${randomBytes(32).toString('base64')}\n`, {
    mode: 0o400,
  });
  const pki = join(dir, 'pki');
  openssl(pki, [
    'req',
    '-x509',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:prime256v1',
    '-nodes',
    '-days',
    '2',
    '-subj',
    '/CN=Synthetic Container Test CA',
    '-keyout',
    'ca.key',
    '-out',
    'ca.pem',
    '-addext',
    'basicConstraints=critical,CA:TRUE',
    '-addext',
    'keyUsage=critical,keyCertSign,cRLSign',
  ]);
  issue(pki, 'mcp', `DNS:${ADDRESSES.publicName},IP:${ADDRESSES.serviceOnClientNet},IP:127.0.0.1`);
  issue(pki, 'console', `IP:${ADDRESSES.console}`);
  writeFileSync(join(pki, 'network.key'), `${NETWORK_KEY}\n`);
  // Read by containers that run as this user, through read-only mounts.
  chmodSync(pki, 0o755);
  return {
    dir,
    caFile: join(pki, 'ca.pem'),
    remove: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface Project {
  up(): void;
  /** Like `up`, but returns the result instead of throwing (for starts that must fail). */
  tryUp(): ExecResult;
  stop(): void;
  down(): void;
  exec(service: string, argv: string[]): ExecResult;
  /** A one-off container of the service with another entrypoint, the service being stopped. */
  run(service: string, entrypoint: string, argv: string[]): ExecResult;
  logs(service: string): string;
}

export function dockerProblem(): string | undefined {
  const version = spawnSync('docker', ['compose', 'version', '--short'], { encoding: 'utf8' });
  if (version.status !== 0) return 'Docker with the Compose plugin is not available.';
  const image = spawnSync('docker', ['image', 'inspect', IMAGE], { encoding: 'utf8' });
  if (image.status !== 0) {
    return `The image ${IMAGE} does not exist. Build it first: npm run test:containers builds it.`;
  }
  return undefined;
}

/** One Compose project: the shipped file plus test overlays, with the given variables. */
export function project(
  name: string,
  files: string[],
  ws: Workspace,
  variables: Record<string, string>,
): Project {
  const env = {
    ...process.env,
    NETTEST_IMAGE: IMAGE,
    NETTEST_DIR: ws.dir,
    NETTEST_PROBES: join(REPO_ROOT, 'tests/container-network'),
    UNIFI_MCP_UID: String(process.getuid?.() ?? 1000),
    UNIFI_MCP_GID: String(process.getgid?.() ?? 1000),
    ...variables,
  };
  const base = ['compose', '-p', name, ...files.flatMap((file) => ['-f', join(REPO_ROOT, file)])];
  const run = (args: string[], timeout = 120_000): ExecResult => {
    const result = spawnSync('docker', [...base, ...args], { env, encoding: 'utf8', timeout });
    return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
  };
  const up = (): ExecResult =>
    run(['up', '--detach', '--force-recreate', '--wait', '--wait-timeout', '90'], 150_000);
  return {
    up: () => {
      const result = up();
      if (result.code !== 0) {
        throw new Error(
          `docker compose up failed:\n${result.stderr}\n${run(['logs', '--no-color']).stdout}`,
        );
      }
    },
    tryUp: up,
    stop: () => {
      run(['stop', '--timeout', '15']);
    },
    run: (service, entrypoint, argv) =>
      run(['run', '--rm', '--no-deps', '-T', '--entrypoint', entrypoint, service, ...argv]),
    down: () => {
      run(['down', '--volumes', '--remove-orphans', '--timeout', '5']);
    },
    exec: (service, argv) => run(['exec', '-T', service, ...argv]),
    logs: (service) => run(['logs', '--no-color', '--no-log-prefix', service]).stdout,
  };
}

/** Runs probes (tests/container-network/probe.ts) inside a container of the project. */
export function probe(target: Project, service: string, probes: object[]): unknown[] {
  const result = target.exec(service, ['node', '/probe/probe.ts', JSON.stringify(probes)]);
  if (result.code !== 0) throw new Error(`probe failed in ${service}: ${result.stderr}`);
  return JSON.parse(result.stdout) as unknown[];
}
