# 0020. Event subscriptions

- Status: Accepted (extended as Phase 3 step 7 proceeds)
- Date: 2026-11-12
- Phase: 3
- Spec references: §2 decisions 14, 25, 26; §5; §6.4; §10; §11; §12; §16 Phase 3; §17

## Context

Spec §11 asks for native event subscriptions where an official local API documents them,
with the same permissions, sensitive-data scopes, redaction and audit as ordinary reads,
and without polling, a message broker or an always-on history store. Protect documents
two WebSocket subscriptions in 7.3.74 (`GET /v1/subscribe/devices`,
`GET /v1/subscribe/events`) and a third in 7.4.96 (`GET /v1/subscribe/updates`). Network
and Access document none.

The owner's live run (ADR 0019 §8) showed that the subscriptions authenticate with the
same `X-API-KEY` as every other Protect request: 101 with the key, 401 with a random one.

MCP SDK 2.4.0 delivers change notifications to 2026-era clients over
`subscriptions/listen` streams. Its event bus is shared by every stream of a handler: a
`resource_updated` event reaches every open stream that listed the URI, whoever opened it
(`listenRouter`). Per-client filtering is therefore ours to do. 2025-era clients are
served statelessly (ADR 0003), so they cannot receive notifications at all.

## Decision

### 1. Event streams are reviewed registry entries

An event stream (`EventStreamDescriptor`, `packages/core/src/events.ts`) is a documented
subscription with security metadata reviewed in the adapter, like an operation:

- `operationId` `<module>.<category>.subscribe` and permission `<module>.<category>.read`;
  always a low-risk read without approval, never site-scoped, never off by default;
- the documented path (a `GET` the console upgrades), its contract revision and version
  range, checked against the operation inventory when it is registered;
- the documented message schema, a message size bound (1 KiB–4 MiB), and two reviewed
  functions: `classify` (what a message is, for authorisation) and `project` (minimise
  it, for example remove credentials).

Streams live in their own registry (`EventStreamRegistry`), not in the operation registry,
so `unifi_execute` and the tool list can never reach them.

### 2. The upstream connection

`UnifiEventConnector` (`packages/unifi-api/src/events.ts`) opens a subscription the same
way the executor sends a request: console registry → egress allowlist with DNS check →
verified TLS (CA, pin or explicit insecure override) → only then the upgrade request with
the module's key. The WebSocket client (`websocket.ts`) is ours, about 300 lines, so that
no dependency sits between the verified socket and the key:

- the upgrade offers no subprotocol or extension and refuses a response that selects one;
  `Sec-WebSocket-Accept` must match; a refused upgrade keeps only its HTTP status;
- it never sends a data frame, only ping, pong and close;
- a message larger than the stream's bound closes the connection before it is buffered,
  fragments included; text must be UTF-8; masked server frames, reserved bits and unknown
  opcodes are protocol errors;
- a ping every 30 s; without any frame within 10 s the connection is idle and closed.

Connection errors reach the rest of the service as codes only (`upgrade_unauthorized`,
`tls_pin_mismatch`, `egress_denied`, …). The key is never logged.

### 3. Who sees what

`StreamAccess` is the one place that decides, and it decides with the policy engine
(`evaluate`) and the same inputs as an ordinary read: the verified client, the global,
console and module policy, the client's console grant, the hard lock and the console's
probed version.

- **The stream**: its own permission (`protect.events.read`, `protect.devices.read`).
- **Each message**: the stream's decision again with the message's own sensitivity tags
  (an NFC or fingerprint event names a person: `personal_identifier`), and, where the
  message carries the same data as a reviewed read, that read's decision as well. A
  device update about a fob is a fob: it needs `protect.fobs.read` and `location`, like
  `protect.fobs.get`.
- A message without a reviewed class is never delivered. A message that does not match
  the documented schema is dropped and counted; its content is never logged.

Decisions are made again at every point where data could leave: when a client subscribes,
for every notification, and for every read. A client whose grant is withdrawn stops
receiving notifications and sees nothing on its next read, without reconnecting.

### 4. The event hub

`EventHub` (`packages/core/src/event-hub.ts`) manages one upstream connection per console
and stream:

- **On demand.** A feed opens when the first client subscribes and closes 30 s after the
  last one leaves. Its buffer goes with it. There is no polling and no history beyond the
  buffer.
- **Bounded buffer.** At most 500 messages and 4 MiB per feed, in memory only; the oldest
  are dropped first.
- **No replay, visible gaps.** After a reconnect a gap marker tells readers that events
  may have been missed. A read with a cursor older than the buffer, or from before the
  feed started, says `truncated`.
- **Reconnects** use exponential backoff with full jitter (1 s to 60 s). After the console
  refuses the key the feed waits 5 minutes. A connection that dropped within 10 s of
  opening does not reset the backoff. All feeds share one limit on connection attempts
  (1 per second, burst 5), so a console restart cannot cause a reconnect storm.
- **Configuration changes.** `recheck()` compares a keyed fingerprint (HMAC with a
  per-process key) of each console's address, TLS trust and stored key. A change closes
  the connection and reconnects at once. A console that is not configured or runs an
  unsupported version is `unavailable` until it is.
- **Notifications** go only to subscribed clients that may see the message, at most one
  per client and feed every 250 ms. They carry no event data: the client reads the
  resource (§5), which is filtered again.
- **Opaque cursors.** A read returns a cursor for the next read. Cursors are AES-encrypted
  sequence numbers with a key that exists only in this process, so a client cannot count
  the events it was not allowed to see from the cursor values, and a cursor from another
  process is recognised as stale.

### 5. MCP surface (next)

Planned for the next part of step 7, recorded here so that the parts fit together:

- one resource per console and stream the client may read, for example
  `unifi://consoles/<consoleId>/protect/events`; `resources/read` returns the events the
  client may see, filtered at read time, and is audited like a read;
- 2026-era clients subscribe with `subscriptions/listen`; the HTTP gate reads the request,
  keeps only the resource URIs the client may subscribe to, and registers its demand
  until the stream closes;
- one SDK handler per client, so that a client's listen streams receive only that
  client's notifications;
- open listen streams are re-authorised periodically and closed when the token or the
  grant goes, when they are too slow to read, or after a maximum lifetime;
- 2025-era clients can read the resources but cannot be notified (degraded mode).

## Consequences

- Event content leaves the service only through `resources/read`, which is authorised and
  audited per read. Notifications reveal only that something the client may see happened.
- Events received while nobody subscribes are lost; this is by design (spec §11).
- The WebSocket client is a small protocol implementation to maintain; its tests cover
  the handshake checks, framing, size bounds, protocol errors, liveness and closing.

## Tests

- `tests/unit/unifi-api/websocket.test.ts`: handshake headers and checks, refused upgrades
  by status only, fragmented and binary messages, size bounds before buffering, protocol
  errors, close frames, dropped connections, pings and idle timeout, abort.
- `tests/unit/unifi-api/events.test.ts`: the documented local path and key header, no key
  sent when egress or TLS verification fails, refused credentials, fingerprints.
- `tests/unit/core/event-hub.test.ts`: registry validation, demand and linger, validation,
  classification and minimisation, per-client filtering at notification and read time,
  opaque cursors and paging, buffer bounds and truncation, backoff and gap markers, the
  unauthorised wait, credential changes, unavailable consoles, the attempt limit,
  coalesced notifications, shutdown.

## Re-evaluation triggers

- The SDK adds per-subscription authorisation or per-client buses.
- Protect documents event replay or a recent-events read.
- Network or Access document a local subscription.
