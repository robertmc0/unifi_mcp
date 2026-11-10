/**
 * Derives a factual operation inventory from a vendor OpenAPI document and its
 * companion llms.txt endpoint index. Only method, path, operationId, first tag and
 * summary are copied (ADR 0006): schemas and prose stay in the uncommitted vendor cache.
 */
import {
  HTTP_METHODS,
  operationKey,
  sortOperations,
  type HttpMethod,
  type InventoryOperation,
} from './api-specs.ts';

interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  tags?: string[];
}

interface OpenApiDocument {
  openapi?: string;
  servers?: { url: string; description?: string }[];
  paths?: Record<string, Partial<Record<Lowercase<HttpMethod>, OpenApiOperation>>>;
}

/** Endpoints whose vendor documentation declares a WebSocket upgrade rather than plain HTTP. */
const WEBSOCKET_PATH = /^\/v1\/subscribe\//;

export function parseOpenApi(text: string): OpenApiDocument {
  const doc = JSON.parse(text) as OpenApiDocument;
  if (typeof doc.openapi !== 'string' || !doc.openapi.startsWith('3.')) {
    throw new Error('Not an OpenAPI 3.x document');
  }
  return doc;
}

export function openApiServers(doc: OpenApiDocument): string[] {
  return (doc.servers ?? []).map((s) => s.url);
}

/** Parses "- `METHOD /path` - [Summary](url)" lines from a developer.ui.com llms.txt. */
export function parseLlmsIndex(text: string): Map<string, { summary: string; url: string }> {
  const index = new Map<string, { summary: string; url: string }>();
  const line = /^- `(GET|POST|PUT|PATCH|DELETE) (\/\S+)` - \[([^\]]+)\]\((https:\/\/[^)\s]+)\)\s*$/;
  for (const raw of text.split(/\r?\n/)) {
    const m = line.exec(raw);
    if (m?.[1] === undefined || m[2] === undefined || m[3] === undefined || m[4] === undefined) {
      continue;
    }
    index.set(operationKey(m[1] as HttpMethod, m[2]), { summary: m[3], url: m[4] });
  }
  return index;
}

export function inventoryFromOpenApi(
  doc: OpenApiDocument,
  docIndex: Map<string, { summary: string; url: string }>,
): InventoryOperation[] {
  const ops: InventoryOperation[] = [];
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const op = item[method.toLowerCase() as Lowercase<HttpMethod>];
      if (op === undefined) continue;
      const key = operationKey(method, path);
      const indexed = docIndex.get(key);
      ops.push({
        key,
        method,
        path,
        vendorOperationId: op.operationId ?? null,
        category: op.tags?.[0] ?? 'Uncategorised',
        summary: op.summary ?? indexed?.summary ?? '',
        documentationUrl: indexed?.url ?? null,
        transport: WEBSOCKET_PATH.test(path) ? 'websocket' : 'http',
      });
    }
  }
  return sortOperations(ops);
}
