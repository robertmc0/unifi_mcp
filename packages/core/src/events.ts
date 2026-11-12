/**
 * Documented event subscriptions as reviewed registry entries, and the one place that
 * decides who may see them (spec §11; ADR 0020 §1, §3).
 *
 * An event stream is a documented subscription (`GET` + WebSocket upgrade) with reviewed
 * security metadata, like an operation. It is never executed through `unifi_execute`: the
 * event hub connects to it while clients subscribe, and clients read what it received as
 * an MCP resource.
 *
 * Who sees what is decided by the policy engine, with the same inputs as an ordinary read:
 *
 * - the stream itself: its permission (`<module>.<category>.read`), the console and module
 *   state, the client's console grant, the console's probed version;
 * - each message: its own sensitivity tags (an NFC scan names a person) and, where the
 *   message carries the same data as a reviewed read (a device update is a camera), that
 *   read's permission and sensitivity as well. A message without a reviewed class is
 *   never delivered.
 */
import {
  assertOperationSecurity,
  evaluate,
  PolicyError,
  type DenyReason,
  type DeploymentOverrides,
  type OperationSecurity,
  type PolicyStore,
  type SensitivityTag,
} from '@unifi-local-mcp/policy';
import * as z from 'zod';
import type { SecurityContextProvider } from './dispatcher.ts';
import { parseRange } from './versions.ts';
import type { ContractInventory } from './registry.ts';

/** What one validated message is, for authorisation. */
export interface MessageClass {
  /** A short label from the adapter's reviewed list (`sensorOpened`, `camera`). */
  kind: string;
  /** Security of a reviewed read that returns the same data; the client must be allowed to run it. */
  equivalent?: OperationSecurity;
  /** Sensitivity of the message itself, in addition to the stream's. */
  sensitivityTags: readonly SensitivityTag[];
}

export interface EventStreamDescriptor<
  Message extends z.ZodType = z.ZodType,
> extends OperationSecurity {
  /** Used in resource URIs: `events`, `devices`. */
  streamId: string;
  /** One or two sentences for discovery. */
  description: string;
  documentationUrl: string;
  /** Vendor contract revision the stream was reviewed against. */
  contractRevision: string;
  /** Validated compatibility, e.g. `>=7.3.74 <8`. */
  apiVersionRange: string;
  /** The documented subscription path (a `GET` upgraded to a WebSocket), without placeholders. */
  pathTemplate: string;
  /** One message as documented. Messages that do not match are dropped and counted. */
  messageSchema: Message;
  /** Upper bound of one message in bytes; larger messages close the connection. */
  maxMessageBytes: number;
  /** The reviewed class of a validated message; `undefined` means it is never delivered. */
  classify(message: z.output<Message>): MessageClass | undefined;
  /** Minimises a validated message before it is buffered (spec §6.4). */
  project(message: z.output<Message>): unknown;
}

/** Identity helper for adapters: types `classify` and `project` against the schema. */
export function defineEventStream<Message extends z.ZodType>(
  descriptor: EventStreamDescriptor<Message>,
): EventStreamDescriptor<Message> {
  return descriptor;
}

const STREAM_ID = /^[a-z][a-z0-9_]{0,31}$/;
const KIND = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
export const MIN_EVENT_MESSAGE_BYTES = 1024;
export const MAX_EVENT_MESSAGE_BYTES = 4 * 1024 * 1024;

/** Problems with a stream descriptor; empty when it may be registered. */
export function validateEventStream(
  stream: EventStreamDescriptor,
  inventory: ContractInventory,
): string[] {
  const problems: string[] = [];
  try {
    assertOperationSecurity(stream);
  } catch (error) {
    problems.push((error as Error).message);
  }
  if (!STREAM_ID.test(stream.streamId)) problems.push('invalid streamId');
  if (stream.operationId !== `${stream.moduleId}.${stream.category}.subscribe`) {
    problems.push('operationId must be "<moduleId>.<category>.subscribe"');
  }
  if (stream.effect !== 'read' || stream.risk !== 'low' || stream.approvalRequired) {
    problems.push('an event stream is a low-risk read without approval');
  }
  if (stream.siteScoped) problems.push('site-scoped event streams are not supported');
  if (stream.defaultDisabled === true) problems.push('event streams cannot be off by default');
  if (/[{}?#]/.test(stream.pathTemplate) || !stream.pathTemplate.startsWith('/')) {
    problems.push('pathTemplate must be a fixed absolute path');
  }
  if (!inventory(stream.moduleId, stream.contractRevision, 'GET', stream.pathTemplate)) {
    problems.push(
      `GET ${stream.pathTemplate} is not in ${stream.moduleId}/${stream.contractRevision}`,
    );
  }
  if (
    !Number.isInteger(stream.maxMessageBytes) ||
    stream.maxMessageBytes < MIN_EVENT_MESSAGE_BYTES ||
    stream.maxMessageBytes > MAX_EVENT_MESSAGE_BYTES
  ) {
    problems.push('maxMessageBytes must be between 1 KiB and 4 MiB');
  }
  if (parseRange(stream.apiVersionRange) === undefined) {
    problems.push('apiVersionRange must be comparators such as ">=7.3.74 <8"');
  }
  return problems;
}

/** The registered event streams, sealed before the service starts. */
export class EventStreamRegistry {
  readonly #streams = new Map<string, EventStreamDescriptor>();
  readonly #inventory: ContractInventory;
  #sealed = false;

  constructor(inventory: ContractInventory) {
    this.#inventory = inventory;
  }

  register(stream: EventStreamDescriptor): void {
    if (this.#sealed) throw new Error('The event stream registry is sealed.');
    const problems = validateEventStream(stream, this.#inventory);
    if (problems.length > 0) {
      throw new Error(`Invalid event stream ${stream.operationId}: ${problems.join('; ')}.`);
    }
    const key = `${stream.moduleId}/${stream.streamId}`;
    if (this.#streams.has(key)) throw new Error(`Event stream ${key} is already registered.`);
    this.#streams.set(key, stream);
  }

  seal(): void {
    this.#sealed = true;
  }

  list(): readonly EventStreamDescriptor[] {
    return [...this.#streams.values()];
  }

  get(moduleId: string, streamId: string): EventStreamDescriptor | undefined {
    return this.#streams.get(`${moduleId}/${streamId}`);
  }
}

/** Checks a class returned by an adapter: a known kind and known tags. */
export function isValidMessageClass(value: MessageClass): boolean {
  return KIND.test(value.kind);
}

export interface StreamAccessDependencies {
  security: SecurityContextProvider;
  policyStore: PolicyStore;
  deployment: DeploymentOverrides;
  now: () => Date;
}

export type StreamDecision =
  { allowed: true } | { allowed: false; reason: DenyReason | 'policy_unavailable' };

/**
 * Who may subscribe to a stream and see its messages. Every decision is made by the policy
 * engine from the verified client, the server-side policy and reviewed metadata, and is
 * made again whenever it matters: at subscription, at each notification and at each read.
 */
export class StreamAccess {
  readonly #deps: StreamAccessDependencies;

  constructor(deps: StreamAccessDependencies) {
    this.#deps = deps;
  }

  /**
   * May the client use this stream on this console? `discover` is for listings; `execute`
   * for subscribing and reading.
   */
  stream(
    clientId: string,
    consoleId: string,
    stream: EventStreamDescriptor,
    purpose: 'discover' | 'execute' = 'execute',
  ): StreamDecision {
    return this.#decide(clientId, consoleId, stream, stream, purpose);
  }

  /** May the client see this message of the stream? */
  message(
    clientId: string,
    consoleId: string,
    stream: EventStreamDescriptor,
    message: MessageClass,
  ): boolean {
    const tags = [...new Set([...stream.sensitivityTags, ...message.sensitivityTags])];
    if (!this.#decide(clientId, consoleId, stream, { ...stream, sensitivityTags: tags }).allowed) {
      return false;
    }
    return (
      message.equivalent === undefined ||
      this.#decide(clientId, consoleId, stream, message.equivalent).allowed
    );
  }

  #decide(
    clientId: string,
    consoleId: string,
    stream: EventStreamDescriptor,
    operation: OperationSecurity,
    purpose: 'discover' | 'execute' = 'execute',
  ): StreamDecision {
    let snapshot;
    try {
      snapshot = this.#deps.policyStore.current();
    } catch (error) {
      if (error instanceof PolicyError) return { allowed: false, reason: 'policy_unavailable' };
      throw error;
    }
    const client = this.#deps.security.clientPolicy(clientId);
    if (client?.clientId !== clientId) return { allowed: false, reason: 'client_inactive' };
    const consolePolicy = this.#deps.security.consolePolicy(consoleId);
    const decision = evaluate({
      now: this.#deps.now(),
      deployment: this.#deps.deployment,
      policy: { version: snapshot.version, document: snapshot.document },
      client,
      console: consolePolicy,
      operation,
      target: { consoleId },
      // The console runs the stream's version; the equivalent read is a permission check.
      capability:
        consolePolicy === undefined ? 'unknown' : this.#deps.security.capability(consoleId, stream),
      purpose,
    });
    return decision.allowed ? { allowed: true } : { allowed: false, reason: decision.reason };
  }
}
