/**
 * Phase 0 contract test: verifies the pinned MCP TypeScript SDK v2 surface that the
 * Phase 1 design relies on (ADR 0003), entirely in-process (no network listener):
 *
 *  - `createMcpHandler` serves both the 2026-07-28 ("modern") era and 2025-era
 *    ("legacy", stateless fallback) clients from one endpoint.
 *  - Authentication is pass-through: identity reaches tool handlers only via the
 *    `authInfo` that *our* verifier passes to `handler.fetch`, never from client input.
 *  - A per-request factory can register a different tool list per authenticated client.
 *  - Requests without a valid bearer token are rejected before reaching the SDK.
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler, McpServer, type AuthInfo } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import * as z from 'zod/v4';

const ENDPOINT = new URL('http://mcp.invalid/mcp');

/** Synthetic token table. Real tokens are hashed and stored in SQLite (Phase 1). */
const TOKENS: Record<string, AuthInfo> = {
  'token-reader': { token: 'token-reader', clientId: 'client-reader', scopes: ['read'] },
  'token-writer': { token: 'token-writer', clientId: 'client-writer', scopes: ['read', 'write'] },
};

const handler = createMcpHandler(({ authInfo }) => {
  const server = new McpServer({ name: 'unifi-local-mcp-contract', version: '0.0.0' });
  server.registerTool(
    'whoami',
    { description: 'Return the authenticated client id', inputSchema: z.object({}) },
    (_args, ctx) => ({
      content: [{ type: 'text', text: ctx.http?.authInfo?.clientId ?? 'anonymous' }],
    }),
  );
  if (authInfo?.scopes.includes('write') === true) {
    server.registerTool(
      'write_probe',
      { description: 'Only visible to write-scoped clients', inputSchema: z.object({}) },
      () => ({ content: [{ type: 'text', text: 'ok' }] }),
    );
  }
  return server;
});

/** Minimal bearer gate in front of the SDK handler, mirroring the Phase 1 design. */
async function gatedFetch(request: Request): Promise<Response> {
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/.exec(header);
  const authInfo = match?.[1] === undefined ? undefined : TOKENS[match[1]];
  if (authInfo === undefined) {
    return new Response(JSON.stringify({ error: 'invalid_token' }), {
      status: 401,
      headers: { 'content-type': 'application/json', 'www-authenticate': 'Bearer' },
    });
  }
  return handler.fetch(request, { authInfo });
}

function transportFor(token: string | undefined): StreamableHTTPClientTransport {
  return new StreamableHTTPClientTransport(ENDPOINT, {
    fetch: (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      if (token !== undefined) headers.set('authorization', `Bearer ${token}`);
      return gatedFetch(new Request(input, { ...init, headers }));
    },
  });
}

const openClients: Client[] = [];
afterEach(async () => {
  await Promise.allSettled(openClients.splice(0).map((c) => c.close()));
});

async function connect(token: string | undefined, mode: 'legacy' | 'auto'): Promise<Client> {
  const client = new Client(
    { name: 'contract-test', version: '0.0.0' },
    { versionNegotiation: { mode } },
  );
  openClients.push(client);
  await client.connect(transportFor(token));
  return client;
}

function firstText(result: unknown): string | undefined {
  const content = (result as { content?: { type: string; text?: string }[] }).content;
  return content?.find((c) => c.type === 'text')?.text;
}

describe('MCP TypeScript SDK v2 contract (pinned version)', () => {
  for (const mode of ['legacy', 'auto'] as const) {
    const expectedEra = mode === 'auto' ? 'modern' : 'legacy';

    describe(`client negotiation mode "${mode}" lands on the ${expectedEra} era`, () => {
      it('negotiates the expected protocol era', async () => {
        const client = await connect('token-reader', mode);
        expect(client.getProtocolEra()).toBe(expectedEra);
      });

      it('passes verified identity to tool handlers via authInfo', async () => {
        const client = await connect('token-writer', mode);
        const result = await client.callTool({ name: 'whoami', arguments: {} });
        expect(firstText(result)).toBe('client-writer');
      });

      it('lets the per-request factory filter tools per authenticated client', async () => {
        const reader = await connect('token-reader', mode);
        const writer = await connect('token-writer', mode);
        const readerTools = (await reader.listTools()).tools.map((t) => t.name).sort();
        const writerTools = (await writer.listTools()).tools.map((t) => t.name).sort();
        expect(readerTools).toEqual(['whoami']);
        expect(writerTools).toEqual(['whoami', 'write_probe']);
      });

      it('rejects connections without a valid bearer token', async () => {
        await expect(connect(undefined, mode)).rejects.toThrow();
        await expect(connect('not-a-real-token', mode)).rejects.toThrow();
      });
    });
  }
});
