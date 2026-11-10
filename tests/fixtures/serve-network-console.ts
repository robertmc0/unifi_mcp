/**
 * Starts the synthetic Network console (network-console.ts) for a dry run of the opt-in
 * live test, without a real console:
 *
 *   node tests/fixtures/serve-network-console.ts <info.json>
 *
 * Writes `{ "port": …, "pin": "sha256/…" }` to <info.json>. On SIGTERM it writes the
 * method and path of every request it received to `<info.json>.requests` and exits.
 */
import { X509Certificate } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { spkiSha256 } from '@unifi-local-mcp/unifi-api';
import { startNetworkConsole } from './network-console.ts';
import { testPki } from './test-pki.ts';

const out = process.argv[2];
if (out === undefined) throw new Error('usage: serve-network-console.ts <info.json>');
const pki = testPki();
const mock = await startNetworkConsole({ key: pki.serverKey, cert: pki.serverCert });
const pin = `sha256/${spkiSha256(new X509Certificate(pki.serverCert))}`;
writeFileSync(out, JSON.stringify({ port: mock.port, pin }));
process.on('SIGTERM', () => {
  const requests = mock.requests.map((r) => `${r.method} ${r.url.split('?')[0] ?? ''}`);
  writeFileSync(`${out}.requests`, JSON.stringify(requests));
  void mock.stop().then(() => process.exit(0));
});
