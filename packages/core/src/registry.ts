/**
 * The versioned operation registry (spec §4.3, §4.4; ADR 0010).
 *
 * Only operations registered here can ever be executed, by a named tool or by
 * `unifi_execute`. Registration validates the reviewed security metadata, the input and
 * output schemas, the path template and, through an injected predicate, that the
 * operation's method and path appear in the official vendor contract recorded in
 * `api-specs/` (AGENTS.md). A rejected descriptor is a programming error and stops startup.
 */
import { assertOperationSecurity, type OperationSecurity } from '@unifi-local-mcp/policy';
import * as z from 'zod';
import { parseRange } from './versions.ts';

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export const RETRY_CLASSES = ['safe-read', 'idempotent', 'non-idempotent'] as const;
export type RetryClass = (typeof RETRY_CLASSES)[number];

/** Where an operation is aimed. Both are explicit; there is no default console or site. */
export interface Target {
  consoleId: string;
  siteId?: string | undefined;
}

export interface OperationDescriptor<
  Input extends z.ZodObject = z.ZodObject,
  Output extends z.ZodType = z.ZodType,
> extends OperationSecurity {
  /** One or two sentences for discovery; kept short to save client context (spec §5.3). */
  description: string;
  documentationUrl: string;
  /** Vendor contract revision the operation was reviewed against, e.g. `11.0.97`. */
  contractRevision: string;
  /** Validated adapter compatibility, e.g. `>=10.1 <12`. Checked by the adapter (step 6). */
  apiVersionRange: string;
  httpMethod: HttpMethod;
  /** Fixed path from the official documentation, with `{name}` placeholders. */
  pathTemplate: string;
  /** Input fields sent as query parameters. */
  queryParameters?: readonly string[];
  /** `json`: input fields not used in the path or query form the JSON request body. */
  requestBody?: 'json';
  /** Response size cap in bytes. Default 4 MiB, maximum 32 MiB. */
  maxResponseBytes?: number;
  /** Must be a strict object schema: unknown arguments are rejected, never passed on. */
  inputSchema: Input;
  outputSchema: Output;
  retryClass: RetryClass;
  /** Upper bound for one upstream call, in milliseconds. */
  timeoutMs: number;
  /**
   * Required for writes: the resource lock key, derived from validated arguments and the
   * target, never supplied by the client. Conflicting writes with the same key run one at
   * a time.
   */
  resourceLockKey?(args: z.output<Input>, target: Target): string;
  /** Minimises validated output before it is returned (spec §6.4). */
  project?(output: z.output<Output>): unknown;
  namedTool?: string;
}

/**
 * Identity helper for adapters: infers the argument and output types from the schemas, so
 * `resourceLockKey` and `project` are type-checked against them.
 */
export function defineOperation<Input extends z.ZodObject, Output extends z.ZodType>(
  descriptor: OperationDescriptor<Input, Output>,
): OperationDescriptor<Input, Output> {
  return descriptor;
}

/** Answers whether `method pathTemplate` is in the vendor contract `module/revision`. */
export type ContractInventory = (
  moduleId: string,
  revision: string,
  method: HttpMethod,
  pathTemplate: string,
) => boolean;

const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;

export function templatePlaceholders(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER)].map((match) => match[1] ?? '');
}

function isStrictObject(schema: unknown): boolean {
  if (!(schema instanceof z.ZodObject)) return false;
  const catchall = (schema._zod.def as { catchall?: { _zod: { def: { type: string } } } }).catchall;
  return catchall?._zod.def.type === 'never';
}

export function validateDescriptor(
  descriptor: OperationDescriptor,
  inventory: ContractInventory,
): string[] {
  const problems: string[] = [];
  try {
    assertOperationSecurity(descriptor);
  } catch (error) {
    problems.push((error as Error).message);
  }
  if (descriptor.description.trim() === '' || descriptor.description.length > 300) {
    problems.push('description must be 1–300 characters');
  }
  if (!descriptor.documentationUrl.startsWith('https://')) {
    problems.push('documentationUrl must be an https:// URL');
  }
  if (!(HTTP_METHODS as readonly string[]).includes(descriptor.httpMethod)) {
    problems.push('unsupported httpMethod');
  }
  if (descriptor.httpMethod === 'GET' && descriptor.effect !== 'read') {
    problems.push('a GET operation must be a read');
  }
  if ((descriptor.effect === 'read') !== (descriptor.retryClass === 'safe-read')) {
    problems.push('reads and only reads use retryClass "safe-read"');
  }
  if (descriptor.effect === 'write' && descriptor.resourceLockKey === undefined) {
    problems.push('writes need a resourceLockKey');
  }
  if (
    !Number.isInteger(descriptor.timeoutMs) ||
    descriptor.timeoutMs < 100 ||
    descriptor.timeoutMs > 120_000
  ) {
    problems.push('timeoutMs must be an integer from 100 to 120000');
  }
  if (descriptor.namedTool !== undefined && !TOOL_NAME.test(descriptor.namedTool)) {
    problems.push('invalid namedTool');
  }
  if (parseRange(descriptor.apiVersionRange) === undefined) {
    problems.push('apiVersionRange must be comparators such as ">=10.1 <12"');
  }
  if (descriptor.requestBody === 'json' && descriptor.httpMethod === 'GET') {
    problems.push('a GET operation has no request body');
  }
  if (
    descriptor.maxResponseBytes !== undefined &&
    (!Number.isInteger(descriptor.maxResponseBytes) ||
      descriptor.maxResponseBytes < 1 ||
      descriptor.maxResponseBytes > 32 * 1024 * 1024)
  ) {
    problems.push('maxResponseBytes must be an integer from 1 to 33554432');
  }

  const template = descriptor.pathTemplate;
  if (
    !template.startsWith('/') ||
    /[?#\s\\]|\/\/|(^|\/)\.\.?(\/|$)|%/.test(template) ||
    template.replace(PLACEHOLDER, '').includes('{') ||
    template.replace(PLACEHOLDER, '').includes('}')
  ) {
    problems.push(
      'pathTemplate must be an absolute path without query, fragment, dot segments or encoding',
    );
  }
  if (!isStrictObject(descriptor.inputSchema)) {
    problems.push('inputSchema must be a strict object schema (z.strictObject)');
  } else {
    const keys = new Set(Object.keys(descriptor.inputSchema.shape));
    const placeholders = templatePlaceholders(template);
    for (const name of placeholders) {
      if (name === 'siteId' ? !descriptor.siteScoped : !keys.has(name)) {
        problems.push(`path placeholder {${name}} has no matching input field`);
      }
    }
    if (descriptor.siteScoped && !placeholders.includes('siteId')) {
      problems.push('site-scoped operations need a {siteId} placeholder');
    }
    if (keys.has('siteId') || keys.has('consoleId')) {
      problems.push('consoleId and siteId are targets, not arguments');
    }
    // Every argument has exactly one, declared place in the request.
    const query = new Set(descriptor.queryParameters ?? []);
    for (const name of query) {
      if (!keys.has(name)) problems.push(`query parameter ${name} is not an input field`);
      if (placeholders.includes(name))
        problems.push(`${name} is both a path and a query parameter`);
    }
    for (const key of keys) {
      if (!placeholders.includes(key) && !query.has(key) && descriptor.requestBody !== 'json') {
        problems.push(`argument ${key} has no place in the request (path, query or body)`);
      }
    }
  }
  if (
    !inventory(
      descriptor.moduleId,
      descriptor.contractRevision,
      descriptor.httpMethod,
      descriptor.pathTemplate,
    )
  ) {
    problems.push(
      `${descriptor.httpMethod} ${descriptor.pathTemplate} is not in the official ` +
        `${descriptor.moduleId} ${descriptor.contractRevision} contract (api-specs/)`,
    );
  }
  return problems;
}

export class OperationRegistry {
  readonly #operations = new Map<string, OperationDescriptor>();
  readonly #namedTools = new Map<string, string>();
  readonly #inventory: ContractInventory;
  #sealed = false;

  constructor(inventory: ContractInventory) {
    this.#inventory = inventory;
  }

  register<Input extends z.ZodObject, Output extends z.ZodType>(
    descriptor: OperationDescriptor<Input, Output>,
  ): void {
    if (this.#sealed) throw new Error('The operation registry is sealed.');
    const generic = descriptor as unknown as OperationDescriptor;
    const problems = validateDescriptor(generic, this.#inventory);
    if (this.#operations.has(descriptor.operationId)) problems.push('duplicate operationId');
    if (descriptor.namedTool !== undefined && this.#namedTools.has(descriptor.namedTool)) {
      problems.push('duplicate namedTool');
    }
    if (problems.length > 0) {
      throw new TypeError(
        `Operation ${descriptor.operationId} cannot be registered: ${problems.join('; ')}.`,
      );
    }
    this.#operations.set(descriptor.operationId, Object.freeze({ ...generic }));
    if (descriptor.namedTool !== undefined) {
      this.#namedTools.set(descriptor.namedTool, descriptor.operationId);
    }
  }

  /** Prevents further registration once startup is complete. */
  seal(): void {
    this.#sealed = true;
  }

  get(operationId: string): OperationDescriptor | undefined {
    return this.#operations.get(operationId);
  }

  byNamedTool(tool: string): OperationDescriptor | undefined {
    const operationId = this.#namedTools.get(tool);
    return operationId === undefined ? undefined : this.#operations.get(operationId);
  }

  list(): OperationDescriptor[] {
    return [...this.#operations.values()].sort((a, b) =>
      a.operationId.localeCompare(b.operationId),
    );
  }

  /** JSON Schema of an operation's arguments, for `unifi_describe_operation`. */
  inputJsonSchema(operationId: string): unknown {
    const descriptor = this.#operations.get(operationId);
    return descriptor === undefined ? undefined : z.toJSONSchema(descriptor.inputSchema);
  }
}

/**
 * Renders a path template. Every value becomes exactly one percent-encoded path segment,
 * so a value can never add segments, traverse upwards, or carry a query or fragment.
 */
export function renderPath(
  template: string,
  values: Readonly<Record<string, string | number>>,
): string {
  return template.replace(PLACEHOLDER, (_match, name: string) => {
    const value = values[name];
    if (value === undefined) throw new TypeError(`Missing path parameter {${name}}.`);
    const text = String(value);
    if (text === '' || text === '.' || text === '..') {
      throw new TypeError(`Invalid value for path parameter {${name}}.`);
    }
    return encodeURIComponent(text);
  });
}
