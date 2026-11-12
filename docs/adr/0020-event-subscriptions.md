# 0020. Event subscriptions

- Status: Accepted
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

### 5. MCP surface (step 7b)

- **Resources.** One resource per console and stream the client may read (discovery
  purpose), for example `unifi://consoles/<consoleId>/protect/events`, listed by
  `resources/list`. `resources/read` returns `{status, state, detail?, cursor, truncated,
more, events[], note}`, filtered for the reading client at read time and audited as
  `resource.read`. Newer events: the same URI with `?after=<cursor>` (and `limit`, 1–100).
  URIs are parsed strictly; anything else is not found. Results carry a private, zero-TTL
  cache hint.
- **Subscriptions** (2026-era clients). The server advertises `resources.subscribe` only to
  2026-era instances that have a stream to offer. The HTTP gate reads every POST body (up
  to 1 MiB) and, for `subscriptions/listen`, keeps only the URIs the client may subscribe
  to (at most 32): unknown and forbidden URIs are left out of the acknowledgement, the same
  way. It audits `events.subscribe` with the counts, registers the client's demand with
  the hub and releases it when the stream closes. `subscriptions/listen` in a JSON-RPC
  batch is refused.
- **One SDK handler per client.** The SDK's event bus reaches every listen stream of a
  handler, so the service keeps one handler per client (created on its first request,
  closed when it is revoked). A notification for one client can only reach that client's
  streams.
- **Closing streams.** At most 8 listen streams per client. Every 5 s the service closes
  streams whose client may no longer use one of their streams, and streams older than one
  hour; the client subscribes again and is authorised again. Revocation closes them at
  once, as before. A stream whose client has not read for 30 s while notifications wait
  (`writableNeedDrain`) is closed as a slow consumer; other clients are unaffected.
- **2025-era clients** are served statelessly (ADR 0003): they can list and read the
  resources, but are not offered subscriptions. A read shows `state: inactive` unless some
  2026-era client subscribes. This is the documented degraded mode of spec §11.
- **stdio.** The bridge relays the listen stream unchanged; a 2026-era client subscribes
  through it like over HTTP.

### 6. The Protect streams (step 7c)

`packages/unifi-protect/src/streams.ts`, reviewed 2026-11-12 against 7.3.74 and 7.4.96,
which document the same 38 event types and 14 device kinds. The message schemas come from
the 7.3.74 module and the streams serve `>=7.3.74 <8`, like the operations (ADR 0019 §7);
`api:reconcile` check 8 now compares the two streams with 7.4.96 too (additive).

- **`protect.events.subscribe`** (`GET /v1/subscribe/events`, `protect.events.read`).
  Every documented event type is reviewed. NFC card scans and fingerprint matches carry
  the UniFi Identity user id (`ulpId`), so they need `personal_identifier` and
  `biometric_or_access_identity`; the other events carry ids, times and detection labels
  only. Event removals are not documented and not delivered.
- **`protect.devices.subscribe`** (`GET /v1/subscribe/devices`, `protect.devices.read`).
  Each device kind maps to the reviewed read returning the same data (`camera` →
  `protect.cameras.get`, `fob` → `protect.fobs.get` with `location`, `nvr` →
  `protect.nvrs.list`, …), whose decision the message also needs. AI processors and AI
  ports have no documented read, so their messages are never delivered.
- Unknown event types and device kinds (a newer console) have no reviewed class and are
  dropped. Messages are minimised with the same credential removal as reads (`url`,
  `pin_code`, at any depth); the schemas drop undocumented fields.
- **Device message forms.** The contract documents device messages as `anyOf` a single
  form (`id` a string) and a bulk form (`id` a string or a list). The generated union tries
  the single forms first, and their tolerant fallback for unknown device kinds accepts a
  bulk message while dropping its ids and fields. In both revisions the bulk forms have
  exactly the single forms' fields and required fields, so the adapter tries them first
  (`DEVICE_MESSAGE`). `tests/contract/protect-streams.test.ts` checks that property from
  the vendor documents, and scans every generated union for an earlier branch that
  accepts a later branch's documented value with less data: the only cases are this
  message (handled) and the 7.4.96 update subscription (below).
- **`GET /v1/subscribe/updates`** (7.4.96 only) is not implemented: it takes a `modelKeys`
  query parameter, which this stream model does not have, and its message forms overlap
  in the same way. No official release documents it yet.

Coverage: 7.3.74 73 of 74 implemented (the upload is the reviewed omission); 7.4.96 81 of
83 (also the update subscription). Event streams appear in the matrix as resources
(`exposure.resource`), not as tools.

Tests: `tests/contract/protect-streams.test.ts`,
`tests/integration-mock/protect-events.test.ts` (every documented event type and device
kind over WebSocket to clients with different grants; credential sentinels and an
undocumented field never reach a client; bulk messages keep their ids).

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

- `tests/unit/mcp-server/event-uris.test.ts`: strict URI parsing.
- `tests/integration-mock/events.test.ts`: real SDK clients over HTTP and the stdio bridge;
  listing, subscribing, notifications and reads with cursors; one upstream connection for
  many clients and the key only upstream; per-client streams, events and notifications;
  partial acknowledgements; closing upstream after the last client; revocation; a
  withdrawn grant; lifetime; per-client limit; batches; upstream drop with a gap;
  2025-era degraded mode; a slow consumer closed without affecting another client.
- Mutation checks: the gate keeping every requested URI, and one shared SDK handler, each
  make a test fail.

## Re-evaluation triggers

- The SDK adds per-subscription authorisation or per-client buses.
- Protect documents event replay or a recent-events read.
- Network or Access document a local subscription.
