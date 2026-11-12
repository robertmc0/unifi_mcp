/**
 * A synthetic UniFi console with Network and Protect, for exercising tests that normally
 * need a real one (tests only). It answers every documented Network and Protect read with
 * a sample from the response schema (a JPEG for the snapshot), reports Network 11.0.97 and
 * Protect 7.3.74, accepts a WebSocket upgrade of a Protect subscription only with the
 * expected key, refuses everything else, and records each request. Used to check the
 * opt-in live tests themselves (ADR 0018 §7, ADR 0019).
 */
import type { OperationDescriptor } from '@unifi-local-mcp/core';
import { NETWORK_READS } from '@unifi-local-mcp/unifi-network';
import { PROTECT_READS } from '@unifi-local-mcp/unifi-protect';
import { MockConsole, sendJson } from './mock-console.ts';
import { sample } from './zod-samples.ts';

const BASE = '/proxy/network/integration';
const PROTECT = '/proxy/protect/integration';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

function matcher(template: string, base = BASE): RegExp {
  const pattern = template
    .split(/\{[A-Za-z]\w*\}/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/?]+');
  return new RegExp(`^${base}${pattern}(\\?.*)?$`);
}

export async function startNetworkConsole(
  tls: { key: string; cert: string },
  /** The key a Protect WebSocket upgrade must carry to be accepted. */
  protectKey?: string,
): Promise<MockConsole> {
  const placeholders = (t: string): number => (t.match(/\{/g) ?? []).length;
  const routes = [
    ...NETWORK_READS.map((d: OperationDescriptor) => ({ d, re: matcher(d.pathTemplate) })),
    ...PROTECT_READS.map((d: OperationDescriptor) => ({ d, re: matcher(d.pathTemplate, PROTECT) })),
  ]
    // Literal segments win over placeholders (/acl-rules/ordering over /acl-rules/{id}),
    // then longer templates (/devices/{id}/statistics/latest over /devices/{id}).
    .sort(
      (a, b) =>
        placeholders(a.d.pathTemplate) - placeholders(b.d.pathTemplate) ||
        b.d.pathTemplate.length - a.d.pathTemplate.length,
    );
  const mock = await MockConsole.start(tls);
  mock.respond = (req, res) => {
    if (req.method !== 'GET') {
      sendJson(res, 405, { code: 'synthetic.method-not-allowed' });
      return;
    }
    if (req.url === `${BASE}/v1/info`) {
      sendJson(res, 200, { applicationVersion: '11.0.97' });
      return;
    }
    if (req.url === `${PROTECT}/v1/meta/info`) {
      sendJson(res, 200, { applicationVersion: '7.3.74' });
      return;
    }
    const route = routes.find((r) => r.re.test(req.url));
    if (route === undefined) {
      sendJson(res, 401, { code: 'api.authentication.missing-credentials' });
      return;
    }
    if (route.d.responseType === 'image/jpeg') {
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      res.end(JPEG);
      return;
    }
    sendJson(res, 200, sample(route.d.outputSchema));
  };
  mock.upgrade = (req, socket) => {
    const accepted =
      req.url.startsWith(`${PROTECT}/v1/subscribe/`) &&
      protectKey !== undefined &&
      req.headers['x-api-key'] === protectKey;
    socket.end(
      accepted
        ? 'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'
        : 'HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n',
    );
  };
  return mock;
}
