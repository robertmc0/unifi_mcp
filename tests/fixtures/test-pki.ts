/**
 * Synthetic test PKI, generated at test time with the openssl CLI into a temporary
 * directory and deleted when the process exits. No private key is ever committed
 * (spec §14; .gitignore excludes *.pem and *.key).
 *
 * - `ca` signs `server`, whose certificate is valid for DNS:console.test and IP:127.0.0.1.
 * - `self` is a self-signed certificate for IP:127.0.0.1, like a factory console certificate.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface TestPki {
  caPem: string;
  serverKey: string;
  serverCert: string;
  selfKey: string;
  selfCert: string;
}

let cached: TestPki | undefined;

const EC = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes'];

export function testPki(): TestPki {
  if (cached !== undefined) return cached;
  const dir = mkdtempSync(join(tmpdir(), 'unifi-mcp-pki-'));
  process.once('exit', () => {
    rmSync(dir, { recursive: true, force: true });
  });
  const openssl = (args: string[]): void => {
    execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
  };
  openssl([
    'req',
    '-x509',
    ...EC,
    '-days',
    '2',
    '-subj',
    '/CN=Synthetic Test CA',
    '-keyout',
    'ca.key',
    '-out',
    'ca.pem',
    '-addext',
    'basicConstraints=critical,CA:TRUE',
    '-addext',
    'keyUsage=critical,keyCertSign,cRLSign',
  ]);
  openssl([
    'req',
    ...EC,
    '-subj',
    '/CN=console.test',
    '-keyout',
    'server.key',
    '-out',
    'server.csr',
  ]);
  writeFileSync(
    join(dir, 'server.ext'),
    'subjectAltName=DNS:console.test,IP:127.0.0.1\nbasicConstraints=CA:FALSE\n' +
      'keyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\n',
  );
  openssl([
    'x509',
    '-req',
    '-in',
    'server.csr',
    '-CA',
    'ca.pem',
    '-CAkey',
    'ca.key',
    '-CAcreateserial',
    '-days',
    '2',
    '-out',
    'server.pem',
    '-extfile',
    'server.ext',
  ]);
  openssl([
    'req',
    '-x509',
    ...EC,
    '-days',
    '2',
    '-subj',
    '/CN=Synthetic self-signed console',
    '-keyout',
    'self.key',
    '-out',
    'self.pem',
    '-addext',
    'subjectAltName=IP:127.0.0.1',
  ]);
  const read = (name: string): string => readFileSync(join(dir, name), 'utf8');
  cached = {
    caPem: read('ca.pem'),
    serverKey: read('server.key'),
    serverCert: read('server.pem'),
    selfKey: read('self.key'),
    selfCert: read('self.pem'),
  };
  return cached;
}
