/**
 * The Access transport (ADR 0023 §1): every generated Access operation (ADR 0022), sent by
 * the real HTTPS executor to a synthetic Access API on its own port with a bearer token,
 * answered inside the documented result envelope, and read back through the operation's
 * generated response schema. No Access descriptors exist yet: each call uses a bare
 * descriptor built from the generated operation, so this checks transport and schemas,
 * not reviewed metadata.
 */
import type { OperationDescriptor } from '@unifi-local-mcp/core';
import { describe, expect, it } from 'vitest';
import { ACCESS_OPERATIONS, accessResponder, envelope } from '../fixtures/access-console.ts';
import { sendJson } from '../fixtures/mock-console.ts';
import { sample } from '../fixtures/zod-samples.ts';
import { getInfo } from '../unit/core/fixtures.ts';
import { useTempDirs } from '../unit/storage/fixtures.ts';
import { call, CLI, unifiHarness } from '../unit/unifi-api/fixtures.ts';

const tempDir = useTempDirs();
const TOKEN = 'synthetic-access-token-SENTINEL-23';

function descriptorFor(key: string): OperationDescriptor {
  const op = ACCESS_OPERATIONS[key];
  if (op === undefined) throw new Error(`no operation ${key}`);
  return {
    ...getInfo,
    operationId: `access.synthetic.${key}`,
    moduleId: 'access',
    effect: op.method === 'GET' ? 'read' : 'write',
    httpMethod: op.method,
    pathTemplate: op.path,
    queryParameters: op.queryParameters,
    ...(op.hasBody ? { requestBody: 'json' } : {}),
    inputSchema: op.input,
    outputSchema: op.output,
  } as OperationDescriptor;
}

async function harness() {
  const h = await unifiHarness({ dir: await tempDir() });
  h.consoles.setCredential(h.consoleId, 'access', TOKEN, CLI);
  h.mock.respond = accessResponder(TOKEN);
  return h;
}

describe('Access transport against a synthetic Access API', () => {
  it('sends every generated operation as documented and reads its response schema', async () => {
    const h = await harness();
    const keys = Object.keys(ACCESS_OPERATIONS);
    expect(keys.length).toBe(98);
    for (const key of keys) {
      const op = ACCESS_OPERATIONS[key];
      if (op === undefined) continue;
      const args = sample(op.input) as Record<string, unknown>;
      expect(op.input.safeParse(args).success, key).toBe(true);
      const before = h.mock.requests.length;
      const outcome = await h.executor.execute(call(descriptorFor(key), h.consoleId, args));
      expect(outcome.ok, key).toBe(true);
      if (!outcome.ok) continue;
      const parsed = op.output.parse(outcome.data);
      // The envelope's code and msg never reach a result.
      if (parsed !== null) expect(Object.keys(parsed as object), key).not.toContain('msg');
      expect(h.mock.requests.length, key).toBe(before + 1);
      const request = h.mock.requests.at(-1);
      expect(request?.method, key).toBe(op.method);
      expect(request?.headers['authorization'], key).toBe(`Bearer ${TOKEN}`);
      const pattern = op.path
        .split(/\{[A-Za-z]\w*\}/)
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('[^/?]+');
      expect(request?.url.split('?')[0], key).toMatch(new RegExp(`^${pattern}$`));
      const query = new URLSearchParams(request?.url.split('?')[1] ?? '');
      for (const name of op.queryParameters) {
        if (args[name] !== undefined) expect(query.has(name), `${key} ${name}`).toBe(true);
      }
      expect(request?.body, key).toBe(op.hasBody ? JSON.stringify(args['body']) : '');
    }
    await h.close();
  });

  it('reports a refused token as unauthorized and a missing resource as not found', async () => {
    const h = await harness();
    const read = descriptorFor('GET /api/v1/developer/users/{id}');
    h.consoles.setCredential(h.consoleId, 'access', 'a-revoked-token', CLI);
    expect(await h.executor.execute(call(read, h.consoleId, { id: 'u-1' }))).toMatchObject({
      ok: false,
      error: { code: 'upstream_unauthorized', upstreamCode: 'CODE_UNAUTHORIZED' },
    });
    h.consoles.setCredential(h.consoleId, 'access', TOKEN, CLI);
    h.mock.respond = (_req, res) => {
      sendJson(res, 200, envelope({ data: null }, 'CODE_USER_WORKER_NOT_EXISTS'));
    };
    expect(await h.executor.execute(call(read, h.consoleId, { id: 'u-1' }))).toMatchObject({
      ok: false,
      error: { code: 'upstream_not_found', status: 200 },
    });
    await h.close();
  });
});
