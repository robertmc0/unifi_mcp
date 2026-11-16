/**
 * Network probes run inside a test container (no dependency: it runs in the service
 * image). Usage: `node /probe/probe.ts '<JSON array of probes>'`. Prints a JSON array of
 * results:
 *
 *   tcp    connected | timeout | an error code such as ECONNREFUSED or ENETUNREACH
 *   https  { status, body } | timeout | an error code
 *   raw    the first line of the answer to bytes sent over TLS | timeout | an error code
 */
import { readFileSync } from 'node:fs';
import { request } from 'node:https';
import { connect as tcpConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

const TIMEOUT_MS = 4000;

interface TcpProbe {
  type: 'tcp';
  host: string;
  port: number;
}
interface HttpsProbe {
  type: 'https';
  host: string;
  port: number;
  path: string;
  servername?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  ca?: string;
}
interface RawProbe {
  type: 'raw';
  host: string;
  port: number;
  servername: string;
  ca: string;
  send: string;
}
type Probe = TcpProbe | HttpsProbe | RawProbe;
type Result = string | { status: number; body: string };

function code(error: NodeJS.ErrnoException): string {
  return error.code ?? 'error';
}

function tcp(probe: TcpProbe): Promise<Result> {
  return new Promise((resolve) => {
    const socket = tcpConnect({ host: probe.host, port: probe.port, timeout: TIMEOUT_MS });
    socket.once('connect', () => {
      socket.destroy();
      resolve('connected');
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve('timeout');
    });
    socket.once('error', (error) => {
      resolve(code(error));
    });
  });
}

function https(probe: HttpsProbe): Promise<Result> {
  return new Promise((resolve) => {
    const req = request(
      {
        host: probe.host,
        port: probe.port,
        servername: probe.servername ?? probe.host,
        path: probe.path,
        method: probe.method ?? 'GET',
        headers: { host: probe.servername ?? probe.host, ...probe.headers },
        timeout: TIMEOUT_MS,
        ...(probe.ca === undefined ? {} : { ca: readFileSync(probe.ca) }),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
        });
      },
    );
    req.once('timeout', () => {
      req.destroy();
      resolve('timeout');
    });
    req.once('error', (error) => {
      resolve(code(error));
    });
    req.end(probe.body);
  });
}

function raw(probe: RawProbe): Promise<Result> {
  return new Promise((resolve) => {
    const socket = tlsConnect({
      host: probe.host,
      port: probe.port,
      servername: probe.servername,
      ca: readFileSync(probe.ca),
      timeout: TIMEOUT_MS,
    });
    let answer = '';
    const firstLine = (): string => answer.split('\r\n')[0] ?? '';
    socket.once('secureConnect', () => socket.write(probe.send));
    socket.on('data', (chunk: Buffer) => {
      answer += chunk.toString('latin1');
      if (answer.includes('\r\n')) {
        socket.destroy();
        resolve(firstLine());
      }
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve('timeout');
    });
    socket.once('end', () => {
      resolve(firstLine() || 'closed');
    });
    socket.once('error', (error) => {
      resolve(code(error));
    });
  });
}

const probes = JSON.parse(process.argv[2] ?? '[]') as Probe[];
const results: Result[] = [];
for (const probe of probes) {
  results.push(
    probe.type === 'tcp'
      ? await tcp(probe)
      : probe.type === 'raw'
        ? await raw(probe)
        : await https(probe),
  );
}
console.log(JSON.stringify(results));
