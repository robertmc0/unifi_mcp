/**
 * Phase 1 gate, end to end over Streamable HTTP with real MCP SDK v2 clients
 * (spec §16 Phase 1, §5.3, §7.1, §7.3; ADR 0003, ADR 0013).
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { JPEG, RULE } from '../unit/core/fixtures.ts';
import { useTempDirs } from '../unit/storage/fixtures.ts';
import { CLI, connect, INITIALIZE, rawRequest, startTestService, structured } from './fixtures.ts';

const tempDir = useTempDirs();
const DISCOVERY = [
  'unifi_describe_operation',
  'unifi_execute',
  'unifi_list_consoles',
  'unifi_list_modules',
  'unifi_list_operations',
];

async function toolNames(client: Awaited<ReturnType<typeof connect>>): Promise<string[]> {
  return (await client.listTools()).tools.map((tool) => tool.name).sort();
}

describe('protocol eras', () => {
  for (const mode of ['legacy', 'auto'] as const) {
    it(`a ${mode === 'auto' ? '2026' : '2025'}-era client connects, discovers and calls tools`, async () => {
      const t = await startTestService({ dir: await tempDir() });
      const client = await connect(t.mcpUrl, t.token('reader', ['network.*.read']), mode);
      expect(client.getProtocolEra()).toBe(mode === 'auto' ? 'modern' : 'legacy');
      const consoles = structured(
        await client.callTool({ name: 'unifi_list_consoles', arguments: {} }),
      );
      expect(consoles['consoles']).toEqual([
        {
          consoleId: t.consoleId,
          alias: 'lab',
          description: null,
          modules: [{ moduleId: 'network', state: 'read_write', applicationVersion: '1.0.5' }],
        },
      ]);
      const devices = await client.callTool({
        name: 'network_list_devices',
        arguments: { consoleId: t.consoleId, siteId: 'site-1', limit: 2 },
      });
      expect(structured(devices)).toMatchObject({
        status: 'ok',
        data: [{ id: 'dev-1', name: 'Office AP' }],
      });
      expect(JSON.stringify(devices)).not.toContain('macAddress');
      expect(t.mock.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
        'GET /proxy/network/integration/v1/sites/site-1/devices?limit=2',
      ]);
    });
  }
});

describe('binary reads (ADR 0019)', () => {
  for (const mode of ['legacy', 'auto'] as const) {
    it(`reach a ${mode === 'auto' ? '2026' : '2025'}-era client as image content, outside the JSON`, async () => {
      const t = await startTestService({ dir: await tempDir() });
      const client = await connect(t.mcpUrl, t.token('viewer', ['network.devices.read']), mode);
      const result = (await client.callTool({
        name: 'unifi_execute',
        arguments: {
          operationId: 'network.devices.get_picture',
          consoleId: t.consoleId,
          siteId: 'site-1',
          arguments: { deviceId: RULE },
        },
      })) as {
        content: { type: string; text?: string; data?: string; mimeType?: string }[];
        structuredContent: Record<string, unknown>;
        isError?: boolean;
      };
      expect(result.isError).toBe(false);
      expect(result.content.map((c) => c.type)).toEqual(['text', 'image']);
      expect(result.content[1]).toEqual({
        type: 'image',
        data: Buffer.from(JPEG).toString('base64'),
        mimeType: 'image/jpeg',
      });
      expect(result.structuredContent).toMatchObject({
        status: 'ok',
        data: { mediaType: 'image/jpeg', bytes: JPEG.length },
      });
      expect(result.structuredContent).not.toHaveProperty('media');
      expect(result.content[0]?.text).not.toContain(Buffer.from(JPEG).toString('base64'));
      expect(JSON.parse(result.content[0]?.text ?? '{}')).toEqual(result.structuredContent);
    });
  }
});

describe('per-client discovery', () => {
  it('shows differently scoped tokens different tools; read-only clients see no write tools', async () => {
    const t = await startTestService({ dir: await tempDir() });
    const reader = await connect(t.mcpUrl, t.token('reader', ['network.*.read']));
    const writer = await connect(t.mcpUrl, t.token('writer', ['network.*.*']));
    expect(await toolNames(reader)).toEqual([...DISCOVERY, 'network_list_devices'].sort());
    expect(await toolNames(writer)).toEqual(
      [
        ...DISCOVERY,
        'network_list_devices',
        'network_restart_device',
        'unifi_get_operation_status',
        'unifi_resume_approved',
      ].sort(),
    );
    const listed = structured(
      await reader.callTool({ name: 'unifi_list_operations', arguments: {} }),
    );
    expect((listed['operations'] as { operationId: string }[]).map((o) => o.operationId)).toEqual([
      'network.devices.get_picture',
      'network.devices.list',
      'network.info.get',
    ]);
    const hidden = await reader.callTool({
      name: 'unifi_describe_operation',
      arguments: { operationId: 'network.devices.restart' },
    });
    expect(hidden.isError).toBe(true);
    expect(structured(hidden)['error']).toMatchObject({ code: 'unknown_operation' });
  });

  it('marks tool lists as private to the client and not cacheable', async () => {
    const t = await startTestService({ dir: await tempDir() });
    const token = t.token('reader', ['network.*.read']);
    const seen: { mode: string; body: string; cacheControl: string | null }[] = [];
    for (const mode of ['auto', 'legacy'] as const) {
      const client = new Client(
        { name: 'cache-probe', version: '0' },
        { versionNegotiation: { mode } },
      );
      await client.connect(
        new StreamableHTTPClientTransport(t.mcpUrl, {
          fetch: async (input: string | URL | Request, init?: RequestInit) => {
            const headers = new Headers(init?.headers);
            headers.set('authorization', `Bearer ${token}`);
            const response = await fetch(input, { ...init, headers });
            if (typeof init?.body === 'string' && init.body.includes('"tools/list"')) {
              seen.push({
                mode,
                body: await response.clone().text(),
                cacheControl: response.headers.get('cache-control'),
              });
            }
            return response;
          },
        }),
      );
      await client.listTools();
      await client.close();
    }
    const modern = seen.find((entry) => entry.mode === 'auto');
    expect(modern?.body).toContain('"ttlMs":0');
    expect(modern?.body).toContain('"cacheScope":"private"');
    expect(modern?.cacheControl).toBe('no-store');
    expect(seen.find((entry) => entry.mode === 'legacy')?.cacheControl).toMatch(/no-(store|cache)/);
  });

  it('starts safely with no console configured: discovery only, nothing to execute', async () => {
    const t = await startTestService({ dir: await tempDir(), withConsole: false });
    const client = await connect(t.mcpUrl, t.token('writer', ['*.*.*']));
    expect(await toolNames(client)).toEqual(DISCOVERY);
    expect(
      structured(await client.callTool({ name: 'unifi_list_consoles', arguments: {} }))['consoles'],
    ).toEqual([]);
    expect((await t.service.health.readiness()).ready).toBe(true);
  });
});

describe('writes through MCP', () => {
  it('are denied by the hard lock through every path', async () => {
    const t = await startTestService({ dir: await tempDir(), forceReadOnly: true });
    const writer = await connect(t.mcpUrl, t.token('writer', ['network.*.*']));
    expect(await toolNames(writer)).not.toContain('network_restart_device');
    const generic = await writer.callTool({
      name: 'unifi_execute',
      arguments: {
        operationId: 'network.devices.restart',
        consoleId: t.consoleId,
        siteId: 'site-1',
        arguments: { deviceId: RULE },
      },
    });
    expect(structured(generic)).toMatchObject({
      status: 'denied',
      error: { code: 'hard_read_only' },
    });
    expect(t.mock.requests).toEqual([]);
  });

  it('need independent approval for high risk, and resume through MCP once', async () => {
    const t = await startTestService({ dir: await tempDir() });
    const writer = await connect(t.mcpUrl, t.token('writer', ['network.*.*']));
    const proposed = structured(
      await writer.callTool({
        name: 'unifi_execute',
        arguments: {
          operationId: 'network.firewall.update_rule',
          consoleId: t.consoleId,
          siteId: 'site-1',
          arguments: { ruleId: RULE, body: { action: 'block' } },
        },
      }),
    );
    expect(proposed['status']).toBe('approval_required');
    const approvalId = String(proposed['approvalId']);
    expect(t.mock.requests).toEqual([]);
    // There is no MCP tool that approves.
    const attempt = await writer
      .callTool({ name: 'unifi_approve', arguments: { approvalId } })
      .then((r) => r.isError === true)
      .catch(() => true);
    expect(attempt).toBe(true);
    expect(
      structured(
        await writer.callTool({ name: 'unifi_get_operation_status', arguments: { approvalId } }),
      ),
    ).toMatchObject({ status: 'ok', approval: { approvalId, status: 'pending' } });
    t.service.approvals.approve(approvalId, CLI);
    const resumed = structured(
      await writer.callTool({ name: 'unifi_resume_approved', arguments: { approvalId } }),
    );
    expect(resumed).toMatchObject({ status: 'ok', outcome: 'succeeded', data: { updated: true } });
    const again = structured(
      await writer.callTool({ name: 'unifi_resume_approved', arguments: { approvalId } }),
    );
    expect(again).toMatchObject({ status: 'denied', error: { code: 'approval_already_used' } });
    expect(t.mock.requests.map((r) => r.method)).toEqual(['PUT']);
  });

  it('refuse a client id smuggled into the arguments', async () => {
    const t = await startTestService({ dir: await tempDir() });
    const writer = await connect(t.mcpUrl, t.token('writer', ['network.*.*']));
    const result = await writer
      .callTool({
        name: 'unifi_execute',
        arguments: { operationId: 'network.info.get', consoleId: t.consoleId, clientId: 'admin' },
      })
      .then((r) => r.isError === true)
      .catch(() => true);
    expect(result).toBe(true);
    expect(t.mock.requests).toEqual([]);
  });
});

describe('revocation', () => {
  it('blocks the next call and closes calls that are in flight', async () => {
    const t = await startTestService({ dir: await tempDir() });
    const client = await connect(t.mcpUrl, t.token('reader', ['network.*.read']));
    expect((await client.callTool({ name: 'unifi_list_consoles', arguments: {} })).isError).toBe(
      false,
    );
    t.mock.respond = () => undefined; // the console never answers
    const inFlight = client
      .callTool({
        name: 'unifi_execute',
        arguments: { operationId: 'network.info.get', consoleId: t.consoleId },
      })
      .then(
        () => 'resolved',
        () => 'rejected',
      );
    await new Promise((resolve) => setTimeout(resolve, 200));
    t.service.clients.revoke('reader', CLI);
    expect(await inFlight).toBe('rejected');
    await expect(client.callTool({ name: 'unifi_list_consoles', arguments: {} })).rejects.toThrow();
  });
});

describe('the HTTP gate', () => {
  it('rejects missing and wrong tokens with 401 and throttles repeated failures', async () => {
    const t = await startTestService({ dir: await tempDir() });
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    const missing = await rawRequest(t.mcpUrl, { method: 'POST', headers, body: INITIALIZE });
    expect(missing.status).toBe(401);
    expect(missing.headers['www-authenticate']).toBe('Bearer realm="unifi-local-mcp"');
    let last = 0;
    for (let i = 0; i < 12; i++) {
      last = (
        await rawRequest(t.mcpUrl, {
          method: 'POST',
          headers: { ...headers, authorization: 'Bearer wrong' },
          body: INITIALIZE,
        })
      ).status;
    }
    expect(last).toBe(429);
    expect(t.service.audit.list({ eventType: 'mcp.auth', limit: 1 })[0]).toMatchObject({
      outcome: 'denied',
    });
  });

  it('protects against DNS rebinding and cross-origin requests', async () => {
    const t = await startTestService({ dir: await tempDir() });
    const token = t.token('reader', ['network.*.read']);
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    };
    expect(
      (
        await rawRequest(t.mcpUrl, {
          method: 'POST',
          headers: { ...headers, host: 'attacker.example' },
          body: INITIALIZE,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await rawRequest(t.mcpUrl, {
          method: 'POST',
          headers: { ...headers, origin: 'https://attacker.example' },
          body: INITIALIZE,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await rawRequest(t.mcpUrl, {
          method: 'POST',
          headers: { ...headers, origin: 'http://localhost:5173' },
          body: INITIALIZE,
        })
      ).status,
    ).toBe(200);
  });

  it('serves minimal, unauthenticated health endpoints and nothing else', async () => {
    const t = await startTestService({ dir: await tempDir() });
    const live = await rawRequest(new URL('/livez', t.service.url), {});
    expect([live.status, live.body]).toEqual([200, '{"status":"alive"}']);
    const ready = await rawRequest(new URL('/readyz', t.service.url), {});
    expect([ready.status, ready.body]).toEqual([200, '{"status":"ready"}']);
    expect((await rawRequest(new URL('/admin', t.service.url), {})).status).toBe(404);
  });

  it('never writes tokens or credentials to logs, audit or the database', async () => {
    const t = await startTestService({ dir: await tempDir() });
    const token = t.token('reader', ['network.*.read']);
    const client = await connect(t.mcpUrl, token);
    await client.callTool({
      name: 'network_list_devices',
      arguments: { consoleId: t.consoleId, siteId: 'site-1' },
    });
    await rawRequest(t.mcpUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}x` },
      body: INITIALIZE,
    });
    const secret = token.slice(18);
    const everything = t.logs.join('') + JSON.stringify(t.service.audit.list({ limit: 500 }));
    expect(everything).not.toContain(secret);
    expect(everything).not.toContain('SENTINEL');
    await t.service.stop();
    const dataDir = join(t.service.storage.db.path, '..');
    for (const file of await readdir(dataDir)) {
      if (file === 'backups') continue;
      const content = await readFile(join(dataDir, file));
      expect(content.includes(Buffer.from(secret)), file).toBe(false);
      expect(content.includes(Buffer.from('SENTINEL')), file).toBe(false);
    }
  });
});
