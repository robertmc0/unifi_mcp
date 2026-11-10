/**
 * Container health probe (Dockerfile HEALTHCHECK; spec §14; ADR 0017): `GET /livez` on the
 * MCP listener inside the container. Exit 0 when the process answers, 1 otherwise.
 *
 * `/livez` answers whether to restart, not whether to route traffic; load balancers and
 * proxies should use `/readyz` (docs/monitoring.md). The probe sends no credential, so it
 * does not verify the listener's certificate when built-in TLS is used.
 */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

const env = process.env;
const port = Number(env['UNIFI_MCP_HTTP_PORT'] ?? '3000') || 3000;
const bind = env['UNIFI_MCP_HTTP_BIND']?.trim() || '127.0.0.1';
const host = bind === '0.0.0.0' ? '127.0.0.1' : bind === '::' ? '::1' : bind;
const tls = (env['UNIFI_MCP_HTTP_TLS_CERT_FILE']?.trim() ?? '') !== '';

const request = (tls ? httpsRequest : httpRequest)(
  {
    host,
    port,
    path: '/livez',
    method: 'GET',
    timeout: 3000,
    headers: { host: 'localhost' },
    ...(tls ? { rejectUnauthorized: false } : {}),
  },
  (response) => {
    response.resume();
    process.exit(response.statusCode === 200 ? 0 : 1);
  },
);
request.on('timeout', () => {
  request.destroy();
  process.exit(1);
});
request.on('error', () => process.exit(1));
request.end();
