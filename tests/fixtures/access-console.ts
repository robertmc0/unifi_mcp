/**
 * A synthetic UniFi Access API (tests only; ADR 0023). It answers every generated Access
 * operation (from this project's transcription, ADR 0022) inside the documented result
 * envelope, `{code: "SUCCESS", msg, ...}`, with a sample of the operation's response schema,
 * and refuses a request without the expected bearer token with the documented
 * `CODE_UNAUTHORIZED`. It implements no real Access behaviour.
 */
import type { ServerResponse } from 'node:http';
import { OPERATIONS } from '../../packages/unifi-access/src/generated/access-2026-03-23.ts';
import { sendJson, type RecordedRequest, type Responder } from './mock-console.ts';
import { sample } from './zod-samples.ts';

export interface GeneratedAccessOperation {
  method: string;
  path: string;
  queryParameters: readonly string[];
  hasBody: boolean;
  responseType: string;
  input: Parameters<typeof sample>[0];
  output: Parameters<typeof sample>[0];
}

export const ACCESS_OPERATIONS = OPERATIONS as unknown as Readonly<
  Record<string, GeneratedAccessOperation>
>;

function matcher(template: string): RegExp {
  const pattern = template
    .split(/\{[A-Za-z]\w*\}/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/?]+');
  return new RegExp(`^${pattern}(\\?.*)?$`);
}

/** The documented envelope around a payload (PDF §2.8). */
export function envelope(payload: object, code = 'SUCCESS'): object {
  return { code, msg: code === 'SUCCESS' ? 'success' : 'synthetic error', ...payload };
}

/** A responder for a MockConsole that serves the generated Access operations. */
export function accessResponder(token: string): Responder {
  const placeholders = (t: string): number => (t.match(/\{/g) ?? []).length;
  const routes = Object.values(ACCESS_OPERATIONS)
    .map((op) => ({ op, re: matcher(op.path) }))
    // Literal segments win over placeholders (/users/search over /users/{id}).
    .sort((a, b) => placeholders(a.op.path) - placeholders(b.op.path));
  return (request: RecordedRequest, response: ServerResponse) => {
    if (request.headers['authorization'] !== `Bearer ${token}`) {
      sendJson(response, 401, envelope({ data: null }, 'CODE_UNAUTHORIZED'));
      return;
    }
    const route = routes.find((r) => r.op.method === request.method && r.re.test(request.url));
    if (route === undefined) {
      sendJson(response, 404, envelope({ data: null }, 'CODE_RESOURCE_NOT_FOUND'));
      return;
    }
    const payload =
      route.op.responseType === 'none' ? { data: null } : (sample(route.op.output) as object);
    sendJson(response, 200, envelope(payload));
  };
}
