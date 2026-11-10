/**
 * A synthetic UniFi Network console for exercising tests that normally need a real one
 * (tests only). It answers every documented Network read with a sample from the response
 * schema, reports `applicationVersion` 11.0.97, refuses everything else, and records each
 * request. Used to check the opt-in live test itself (ADR 0018 §7).
 */
import { NETWORK_READS } from '@unifi-local-mcp/unifi-network';
import { MockConsole, sendJson } from './mock-console.ts';
import { sample } from './zod-samples.ts';

const BASE = '/proxy/network/integration';

function matcher(template: string): RegExp {
  const pattern = template
    .split(/\{[A-Za-z]\w*\}/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/?]+');
  return new RegExp(`^${BASE}${pattern}(\\?.*)?$`);
}

export async function startNetworkConsole(tls: {
  key: string;
  cert: string;
}): Promise<MockConsole> {
  const placeholders = (t: string): number => (t.match(/\{/g) ?? []).length;
  const routes = NETWORK_READS.map((d) => ({ d, re: matcher(d.pathTemplate) }))
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
    const route = routes.find((r) => r.re.test(req.url));
    if (route === undefined) {
      sendJson(res, 401, { code: 'api.authentication.missing-credentials' });
      return;
    }
    sendJson(res, 200, sample(route.d.outputSchema));
  };
  return mock;
}
