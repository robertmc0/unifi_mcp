/**
 * The event connection manager (spec §11; ADR 0020 §4).
 *
 * One upstream subscription per console and stream, open only while at least one client
 * subscribes (plus a short linger), never as a background poller or history store:
 *
 * - **Reconnects** with exponential backoff and full jitter, a longer wait after the console
 *   refuses the credential, and a global limit on connection attempts, so many feeds
 *   failing together cannot become a reconnect storm. A connection that drops soon after
 *   opening does not reset the backoff.
 * - **Credential and address changes** (`recheck`) close the connection and reconnect with
 *   the new settings at once.
 * - **Messages** are parsed, validated against the documented schema, classified and
 *   minimised by the adapter's reviewed code, then kept in a bounded in-memory buffer
 *   (entries and bytes). Messages that do not match the contract or have no reviewed class
 *   are dropped and counted, never shown.
 * - **Gaps**: after a reconnect, a gap marker tells readers that events may have been
 *   missed. There is no replay.
 * - **Fan-out**: each subscribed client that may see a message is notified, coalesced per
 *   client and feed. Reads filter again with the policy in force at read time.
 * - **Cursors** are opaque (encrypted with a key that lives only in this process), so the
 *   positions of events a client may not see cannot be inferred from them.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Logger } from '@unifi-local-mcp/telemetry';
import {
  isValidMessageClass,
  type EventStreamDescriptor,
  type MessageClass,
  type StreamAccess,
} from './events.ts';
import { RateLimiter, type RateLimit } from './rate-limit.ts';

export interface EventTarget {
  consoleId: string;
  stream: EventStreamDescriptor;
}

export interface EventCloseInfo {
  code: string;
  closeCode?: number;
}

/** One open upstream subscription. */
export interface EventConnection {
  onMessage(listener: (text: string) => void): void;
  /** Settles once when the connection has ended. Never rejects. */
  readonly closed: Promise<EventCloseInfo>;
  close(): void;
}

/** Opens upstream subscriptions (the UniFi side implements it over WebSocket). */
export interface EventConnector {
  /** Rejects with an error whose `code` names the cause (e.g. `upgrade_unauthorized`). */
  connect(target: EventTarget, signal: AbortSignal): Promise<EventConnection>;
  /**
   * Changes whenever the console's address, TLS trust or stored credential changes;
   * `undefined` when the module cannot be reached (not configured, no credential).
   */
  fingerprint(consoleId: string, moduleId: string): string | undefined;
}

export type FeedState = 'connecting' | 'connected' | 'retrying' | 'unavailable';

export interface EventHubLimits {
  bufferEntries: number;
  bufferBytes: number;
  /** How long a feed stays open after its last subscriber left. */
  lingerMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  /** Wait after the console refused the credential. */
  unauthorizedBackoffMs: number;
  /** How often an unavailable feed checks again (also on `recheck`). */
  unavailableRecheckMs: number;
  /** A connection open at least this long resets the backoff. */
  stableAfterMs: number;
  /** Connection attempts across all feeds. */
  connectRate: RateLimit;
  /** At most one notification per client and feed in this interval. */
  notifyIntervalMs: number;
  maxFeeds: number;
  /** Most events one read returns. */
  readLimit: number;
}

export const DEFAULT_EVENT_HUB_LIMITS: EventHubLimits = {
  bufferEntries: 500,
  bufferBytes: 4 * 1024 * 1024,
  lingerMs: 30_000,
  backoffBaseMs: 1_000,
  backoffMaxMs: 60_000,
  unauthorizedBackoffMs: 5 * 60_000,
  unavailableRecheckMs: 30_000,
  stableAfterMs: 10_000,
  connectRate: { ratePerSecond: 1, burst: 5 },
  notifyIntervalMs: 250,
  maxFeeds: 64,
  readLimit: 100,
};

export interface EventHubOptions {
  access: StreamAccess;
  connector: EventConnector;
  logger: Logger;
  /** Tells one client that a feed has new events it may see (coalesced). */
  notify(clientId: string, consoleId: string, stream: EventStreamDescriptor): void;
  /** Whether the console runs a version the stream supports. */
  supported(consoleId: string, stream: EventStreamDescriptor): boolean;
  limits?: Partial<EventHubLimits>;
  now?: () => Date;
  /** Tests only: jitter source in [0, 1). */
  random?: () => number;
}

export interface EventFeedKey {
  consoleId: string;
  stream: EventStreamDescriptor;
}

interface Entry {
  sequence: number;
  receivedAt: string;
  bytes: number;
  /** Absent for a gap marker. */
  message?: { kind: string; class: MessageClass; data: unknown };
  gap?: string;
}

export interface EventReadResult {
  /** `inactive`: nobody subscribes, so nothing is received. */
  state: FeedState | 'inactive';
  /** Why the feed is retrying or unavailable: a code, never upstream text. */
  detail?: string;
  /** Pass as `after` to read only newer events. */
  cursor: string;
  /** Events before these may have been dropped from the buffer or missed. */
  truncated: boolean;
  /** True when more visible events follow; read again with `cursor`. */
  more: boolean;
  events: (
    { receivedAt: string; kind: string; data: unknown } | { receivedAt: string; gap: string }
  )[];
}

export interface EventFeedStatus {
  consoleId: string;
  moduleId: string;
  streamId: string;
  state: FeedState;
  detail?: string;
  subscribers: number;
  buffered: number;
  dropped: { contractMismatch: number; unclassified: number };
}

class Feed {
  readonly key: string;
  readonly consoleId: string;
  readonly stream: EventStreamDescriptor;
  readonly subscribers = new Map<string, number>();
  state: FeedState = 'connecting';
  detail: string | undefined;
  entries: Entry[] = [];
  bytes = 0;
  /** Sequence of the newest entry that was dropped from the buffer. */
  evictedThrough = 0;
  connection: EventConnection | undefined;
  abort = new AbortController();
  fingerprint: string | undefined;
  attempt = 0;
  everConnected = false;
  running = false;
  stopped = false;
  linger: NodeJS.Timeout | undefined;
  wake: (() => void) | undefined;
  readonly notified = new Map<string, { last: number; timer: NodeJS.Timeout | undefined }>();
  readonly dropped = { contractMismatch: 0, unclassified: 0 };
  lastMismatchLog = 0;

  constructor(consoleId: string, stream: EventStreamDescriptor, startedAfter: number) {
    this.consoleId = consoleId;
    this.stream = stream;
    this.key = feedKey(consoleId, stream);
    // Nothing from before the feed started is in its buffer.
    this.evictedThrough = startedAfter;
  }
}

/** Read through a call: a feed can be stopped while its loop awaits. */
function stopped(feed: Feed): boolean {
  return feed.stopped;
}

function feedKey(consoleId: string, stream: EventStreamDescriptor): string {
  return `${consoleId}\u0000${stream.moduleId}\u0000${stream.streamId}`;
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : 'connect_failed';
}

const UNAUTHORIZED = new Set(['upgrade_unauthorized']);
const UNAVAILABLE = new Set(['console_not_configured', 'credentials_unreadable', 'egress_denied']);

export class EventHub {
  readonly #options: EventHubOptions;
  readonly #limits: EventHubLimits;
  readonly #feeds = new Map<string, Feed>();
  readonly #attempts = new RateLimiter();
  readonly #now: () => Date;
  readonly #random: () => number;
  /** Process-local: cursors from before a restart are recognised as stale. */
  readonly #cursorKey = randomBytes(16);
  readonly #epoch = randomBytes(8);
  #sequence = 0;
  #closed = false;

  constructor(options: EventHubOptions) {
    this.#options = options;
    this.#limits = { ...DEFAULT_EVENT_HUB_LIMITS, ...options.limits };
    this.#now = options.now ?? (() => new Date());
    this.#random = options.random ?? Math.random;
  }

  /**
   * Registers a client's interest in feeds and opens them as needed. The caller has
   * authorised every key. Returns the release function; releasing twice is harmless.
   */
  subscribe(clientId: string, keys: readonly EventFeedKey[]): () => void {
    if (this.#closed) throw new Error('The event hub is closed.');
    const feeds: Feed[] = [];
    for (const { consoleId, stream } of keys) {
      const key = feedKey(consoleId, stream);
      let feed = this.#feeds.get(key);
      if (feed === undefined) {
        if (this.#feeds.size >= this.#limits.maxFeeds) {
          throw new Error('Too many event feeds are open.');
        }
        feed = new Feed(consoleId, stream, this.#sequence);
        this.#feeds.set(key, feed);
      }
      feeds.push(feed);
    }
    for (const feed of feeds) {
      feed.subscribers.set(clientId, (feed.subscribers.get(clientId) ?? 0) + 1);
      clearTimeout(feed.linger);
      feed.linger = undefined;
      if (!feed.running) void this.#run(feed);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const feed of feeds) this.#release(feed, clientId);
    };
  }

  /**
   * The events of a feed the client may see, after `after` (a cursor from an earlier
   * read). The caller has authorised the client for the stream.
   */
  read(
    clientId: string,
    consoleId: string,
    stream: EventStreamDescriptor,
    options: { after?: string; limit?: number } = {},
  ): EventReadResult {
    const feed = this.#feeds.get(feedKey(consoleId, stream));
    const limit = Math.max(
      1,
      Math.min(options.limit ?? this.#limits.readLimit, this.#limits.readLimit),
    );
    const after = options.after === undefined ? undefined : this.#decodeCursor(options.after);
    if (feed === undefined) {
      return {
        state: 'inactive',
        cursor: this.#encodeCursor(after ?? this.#sequence),
        truncated: options.after !== undefined && after === undefined,
        more: false,
        events: [],
      };
    }
    const from = after ?? 0;
    // With a cursor, `truncated` says events after it may be missing: dropped from the
    // buffer, or never received because nobody subscribed. A cursor that does not decode
    // (another process, or altered) reads from the oldest buffered event and says so.
    const truncated =
      options.after !== undefined && (after === undefined || from < feed.evictedThrough);
    const events: EventReadResult['events'] = [];
    let cursor = from;
    let more = false;
    for (const entry of feed.entries) {
      if (entry.sequence <= from) continue;
      const visible =
        entry.message === undefined ||
        this.#options.access.message(clientId, consoleId, stream, entry.message.class);
      if (!visible) {
        cursor = entry.sequence;
        continue;
      }
      if (events.length >= limit) {
        more = true;
        break;
      }
      cursor = entry.sequence;
      events.push(
        entry.message === undefined
          ? { receivedAt: entry.receivedAt, gap: entry.gap ?? 'unknown' }
          : { receivedAt: entry.receivedAt, kind: entry.message.kind, data: entry.message.data },
      );
    }
    return {
      state: feed.state,
      ...(feed.detail === undefined ? {} : { detail: feed.detail }),
      cursor: this.#encodeCursor(more ? cursor : Math.max(cursor, this.#latest(feed))),
      truncated,
      more,
      events,
    };
  }

  /** Feed states for the operator (no data, no ids beyond console and stream). */
  status(): EventFeedStatus[] {
    return [...this.#feeds.values()].map((feed) => ({
      consoleId: feed.consoleId,
      moduleId: feed.stream.moduleId,
      streamId: feed.stream.streamId,
      state: feed.state,
      ...(feed.detail === undefined ? {} : { detail: feed.detail }),
      subscribers: [...feed.subscribers.values()].reduce((a, b) => a + b, 0),
      buffered: feed.entries.filter((e) => e.message !== undefined).length,
      dropped: { ...feed.dropped },
    }));
  }

  /**
   * Reconnects feeds whose console settings or credential changed, and wakes feeds that
   * wait because the console was unavailable.
   */
  recheck(): void {
    for (const feed of this.#feeds.values()) {
      if (feed.stopped) continue;
      if (feed.connection !== undefined) {
        const current = this.#options.connector.fingerprint(feed.consoleId, feed.stream.moduleId);
        const supported = this.#options.supported(feed.consoleId, feed.stream);
        if (current !== feed.fingerprint || !supported) {
          this.#options.logger.info('event feed reconnects after a console change', {
            consoleId: feed.consoleId,
            stream: feed.stream.operationId,
          });
          feed.attempt = 0;
          feed.connection.close();
        }
      } else if (feed.state === 'unavailable') {
        feed.wake?.();
      }
    }
  }

  /** Closes every feed. */
  async close(): Promise<void> {
    this.#closed = true;
    const feeds = [...this.#feeds.values()];
    for (const feed of feeds) this.#stop(feed);
    await Promise.all(feeds.map((feed) => feed.connection?.closed ?? Promise.resolve(undefined)));
  }

  #latest(feed: Feed): number {
    return feed.entries.at(-1)?.sequence ?? feed.evictedThrough;
  }

  #release(feed: Feed, clientId: string): void {
    const count = (feed.subscribers.get(clientId) ?? 0) - 1;
    if (count > 0) {
      feed.subscribers.set(clientId, count);
      return;
    }
    feed.subscribers.delete(clientId);
    const notified = feed.notified.get(clientId);
    clearTimeout(notified?.timer);
    feed.notified.delete(clientId);
    if (feed.subscribers.size === 0 && !feed.stopped) {
      clearTimeout(feed.linger);
      feed.linger = setTimeout(() => {
        if (feed.subscribers.size === 0) this.#stop(feed);
      }, this.#limits.lingerMs);
      feed.linger.unref();
    }
  }

  #stop(feed: Feed): void {
    if (feed.stopped) return;
    feed.stopped = true;
    clearTimeout(feed.linger);
    for (const { timer } of feed.notified.values()) clearTimeout(timer);
    feed.notified.clear();
    feed.abort.abort();
    feed.connection?.close();
    feed.wake?.();
    // The buffer goes with the feed: nothing is kept once nobody subscribes.
    feed.entries = [];
    feed.bytes = 0;
    this.#feeds.delete(feed.key);
  }

  async #sleep(feed: Feed, ms: number): Promise<void> {
    if (feed.stopped) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms);
      timer.unref();
      function done(): void {
        clearTimeout(timer);
        resolve();
      }
      feed.wake = done;
    });
    feed.wake = undefined;
  }

  #backoff(feed: Feed): number {
    const ceiling = Math.min(
      this.#limits.backoffMaxMs,
      this.#limits.backoffBaseMs * 2 ** Math.min(feed.attempt, 20),
    );
    // Full jitter, but never immediately.
    return Math.max(this.#limits.backoffBaseMs / 2, Math.floor(this.#random() * ceiling));
  }

  async #run(feed: Feed): Promise<void> {
    feed.running = true;
    try {
      while (!feed.stopped) {
        const fingerprint = this.#options.connector.fingerprint(
          feed.consoleId,
          feed.stream.moduleId,
        );
        if (fingerprint === undefined || !this.#options.supported(feed.consoleId, feed.stream)) {
          feed.state = 'unavailable';
          feed.detail =
            fingerprint === undefined ? 'console_not_configured' : 'operation_unsupported';
          await this.#sleep(feed, this.#limits.unavailableRecheckMs);
          continue;
        }
        const turn = this.#attempts.take([{ key: 'connect', limit: this.#limits.connectRate }]);
        if (!turn.ok) {
          await this.#sleep(feed, turn.retryAfterMs);
          continue;
        }
        feed.state = 'connecting';
        let connection: EventConnection;
        try {
          connection = await this.#options.connector.connect(
            { consoleId: feed.consoleId, stream: feed.stream },
            feed.abort.signal,
          );
        } catch (error) {
          if (stopped(feed)) break;
          const code = errorCode(error);
          feed.detail = code;
          if (UNAVAILABLE.has(code)) {
            feed.state = 'unavailable';
            await this.#sleep(feed, this.#limits.unavailableRecheckMs);
            continue;
          }
          feed.state = 'retrying';
          const wait = UNAUTHORIZED.has(code)
            ? this.#limits.unauthorizedBackoffMs
            : this.#backoff(feed);
          feed.attempt++;
          this.#options.logger.warn('event feed could not connect', {
            consoleId: feed.consoleId,
            stream: feed.stream.operationId,
            code,
            retryInMs: wait,
          });
          await this.#sleep(feed, wait);
          continue;
        }
        if (stopped(feed)) {
          connection.close();
          break;
        }
        const openedAt = this.#now().getTime();
        feed.connection = connection;
        feed.fingerprint = fingerprint;
        feed.state = 'connected';
        feed.detail = undefined;
        if (feed.everConnected) this.#append(feed, { gap: 'reconnected' });
        feed.everConnected = true;
        connection.onMessage((text) => {
          this.#receive(feed, text);
        });
        const closed = await connection.closed;
        feed.connection = undefined;
        if (stopped(feed)) break;
        feed.detail = closed.code;
        if (this.#now().getTime() - openedAt >= this.#limits.stableAfterMs) feed.attempt = 0;
        if (feed.attempt === 0 && closed.code === 'closed') {
          // Closed by recheck (new settings): reconnect at once, through the attempt limit.
          continue;
        }
        feed.state = 'retrying';
        const wait = this.#backoff(feed);
        feed.attempt++;
        this.#options.logger.warn('event feed disconnected', {
          consoleId: feed.consoleId,
          stream: feed.stream.operationId,
          code: closed.code,
          retryInMs: wait,
        });
        await this.#sleep(feed, wait);
      }
    } catch (error) {
      this.#options.logger.error('event feed failed', {
        consoleId: feed.consoleId,
        stream: feed.stream.operationId,
        err: error,
      });
      this.#stop(feed);
    } finally {
      feed.running = false;
    }
  }

  #receive(feed: Feed, text: string): void {
    if (feed.stopped) return;
    const { stream } = feed;
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      this.#mismatch(feed);
      return;
    }
    const parsed = stream.messageSchema.safeParse(value);
    if (!parsed.success) {
      this.#mismatch(feed);
      return;
    }
    const messageClass = stream.classify(parsed.data);
    if (messageClass === undefined || !isValidMessageClass(messageClass)) {
      feed.dropped.unclassified++;
      return;
    }
    const data = stream.project(parsed.data);
    this.#append(feed, { message: { kind: messageClass.kind, class: messageClass, data } });
    for (const clientId of feed.subscribers.keys()) {
      if (this.#options.access.message(clientId, feed.consoleId, stream, messageClass)) {
        this.#notify(feed, clientId);
      }
    }
  }

  #mismatch(feed: Feed): void {
    feed.dropped.contractMismatch++;
    const now = this.#now().getTime();
    if (now - feed.lastMismatchLog >= 60_000) {
      feed.lastMismatchLog = now;
      // Counts only: upstream content is never logged.
      this.#options.logger.warn('event messages do not match the contract and were dropped', {
        consoleId: feed.consoleId,
        stream: feed.stream.operationId,
        dropped: feed.dropped.contractMismatch,
      });
    }
  }

  #append(feed: Feed, content: Pick<Entry, 'message' | 'gap'>): void {
    const bytes =
      content.message === undefined ? 64 : JSON.stringify(content.message.data).length + 64;
    const entry: Entry = {
      sequence: ++this.#sequence,
      receivedAt: this.#now().toISOString(),
      bytes,
      ...content,
    };
    feed.entries.push(entry);
    feed.bytes += bytes;
    while (
      feed.entries.length > this.#limits.bufferEntries ||
      (feed.bytes > this.#limits.bufferBytes && feed.entries.length > 1)
    ) {
      const evicted = feed.entries.shift();
      if (evicted === undefined) break;
      feed.bytes -= evicted.bytes;
      feed.evictedThrough = evicted.sequence;
    }
  }

  #notify(feed: Feed, clientId: string): void {
    const state = feed.notified.get(clientId) ?? { last: 0, timer: undefined };
    feed.notified.set(clientId, state);
    if (state.timer !== undefined) return;
    const now = this.#now().getTime();
    const wait = state.last + this.#limits.notifyIntervalMs - now;
    const send = (): void => {
      state.timer = undefined;
      state.last = this.#now().getTime();
      if (feed.stopped || !feed.subscribers.has(clientId)) return;
      try {
        this.#options.notify(clientId, feed.consoleId, feed.stream);
      } catch (error) {
        this.#options.logger.error('event notification failed', { clientId, err: error });
      }
    };
    if (wait <= 0) {
      send();
    } else {
      state.timer = setTimeout(send, wait);
      state.timer.unref();
    }
  }

  #encodeCursor(sequence: number): string {
    const block = Buffer.alloc(16);
    this.#epoch.copy(block, 0);
    block.writeBigUInt64BE(BigInt(sequence), 8);
    const cipher = createCipheriv('aes-128-ecb', this.#cursorKey, null);
    cipher.setAutoPadding(false);
    return Buffer.concat([cipher.update(block), cipher.final()]).toString('base64url');
  }

  #decodeCursor(cursor: string): number | undefined {
    if (!/^[A-Za-z0-9_-]{22}$/.test(cursor)) return undefined;
    const decipher = createDecipheriv('aes-128-ecb', this.#cursorKey, null);
    decipher.setAutoPadding(false);
    const block = Buffer.concat([
      decipher.update(Buffer.from(cursor, 'base64url')),
      decipher.final(),
    ]);
    if (!block.subarray(0, 8).equals(this.#epoch)) return undefined;
    const sequence = Number(block.readBigUInt64BE(8));
    return sequence <= this.#sequence ? sequence : undefined;
  }
}
