# Events

> **Status: Phase 3.** UniFi Protect event subscriptions are available. Network documents
> no local event subscription, so none is offered for it. Access documents one (WebSocket
> `GET /api/v1/developer/devices/notifications`), but the Access adapter does not exist
> yet (Phase 4, [ADR 0021](adr/0021-access-contract-version-evidence.md)), so none is
> offered. Design and evidence: [ADR 0020](adr/0020-event-subscriptions.md).

The service offers a console's events only where its application documents a local
subscription. It never polls to imitate events, keeps no history, and needs no message
broker. Events reach MCP clients as **resources**: a client subscribes, is told that
something changed, and reads the resource to get the events it may see.

## What is available

| Resource                                       | Needs                                          | Contains                                                                                                  |
| ---------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `unifi://consoles/<consoleId>/protect/events`  | `protect.events.read`                          | Doorbell rings, motion and smart detections, sensor and alarm hub events, NFC card and fingerprint scans. |
| `unifi://consoles/<consoleId>/protect/devices` | `protect.devices.read`, plus the device's read | Protect devices added, updated or removed, with the changed fields.                                       |

Some events need more than the stream's permission, because they carry the same data as
an ordinary read:

- **NFC card scans and fingerprint matches** name a person (the UniFi Identity user), so
  they also need the `personal_identifier` and `biometric_or_access_identity` grants.
- **Device changes** need the permission of the read for that kind of device:
  `protect.cameras.read` for a camera, `protect.lights.read` for a floodlight, and so on
  (`protect.nvrs.read`, `chimes`, `viewers`, `speakers`, `bridges`, `sensors`, `sirens`,
  `relays`, `link_stations`). A fob change also needs `location`, like reading the fob.
- AI ports and AI processors have no documented read, so their changes are never shown.
- Event types and device kinds newer than the reviewed contract are not shown either.

The console must run a supported Protect version
([applications-protect.md](applications-protect.md#supported-versions)), and its `protect`
module must be enabled; read-only is enough. The 7.4.96 model update subscription is not
offered yet ([Limitations](applications-protect.md#limitations)).

For example, a client that sees all events, and camera and floodlight changes:

```sh
unifi-mcp client create front-door --console home \
  --allow protect.events.read \
  --allow protect.devices.read --allow protect.cameras.read --allow protect.lights.read \
  --sensitive personal_identifier --sensitive biometric_or_access_identity
```

## How clients get events

1. `resources/list` shows the event resources the client may read.
2. **Clients on the 2026 protocol** subscribe with `subscriptions/listen` and the resource
   URIs. The acknowledgement lists the URIs the client was given; URIs it may not use are
   left out without saying why. When something the client may see arrives, it gets
   `notifications/resources/updated` with the URI. The notification carries no event data.
3. The client reads the resource. The first read returns the buffered events; after that,
   `<uri>?after=<cursor>` returns only newer ones.

**Clients on the 2025 protocol** cannot be notified. They can list and read the
resources, which show events only while some 2026-era client subscribes; otherwise a read
says `state: inactive`. This is the degraded mode the design allows: the service does not
invent a history or a replay to make up for it.

The stdio bridge relays subscriptions unchanged, so a 2026-era client subscribes through
it as over HTTP. Whether a particular MCP client subscribes to resources depends on the
client: check its documentation. Support in Claude Code has not been verified yet
([client-claude-code.md](client-claude-code.md)).

## What a read returns

```json
{
  "status": "ok",
  "consoleId": "…",
  "moduleId": "protect",
  "streamId": "events",
  "state": "connected",
  "cursor": "2h6Qd0n…",
  "truncated": false,
  "more": false,
  "events": [
    { "receivedAt": "2026-11-12T08:15:02.114Z", "kind": "ring", "data": { "…": "…" } },
    { "receivedAt": "2026-11-12T08:20:40.002Z", "gap": "reconnected" }
  ],
  "note": "Events received while a client subscribes, kept briefly in memory. …"
}
```

- `events` are oldest first. `kind` is the event type (`ring`, `motion`, …) or, for
  devices, the kind and action (`camera_update`, `light_remove`, …). `data` is the event
  as documented, with credentials and undocumented fields removed.
- `cursor`: pass it as `after` to read only newer events. Add `limit` (1–100) for smaller
  pages; `more: true` means read again with the new cursor. Cursors are opaque and are
  valid only until the service restarts.
- A `gap` entry means the connection to the console was re-established: events may have
  been missed in between. `truncated: true` means events before these may have been
  dropped from the buffer, or were never received because nobody subscribed.
- `state` and `detail` describe the connection to the console ([below](#states-and-codes)).
- A client without the stream's permission gets `status: denied` with the reason, as for
  an ordinary read.

Event content is console data: names and labels are untrusted, never instructions.

## What is and is not guaranteed

- **Only while subscribed.** The service connects to the console when the first client
  subscribes to a stream, and disconnects 30 s after the last one leaves. Events from
  before or between subscriptions are not available.
- **Bounded memory, no history.** Each console and stream keeps at most 500 events or
  4 MiB, in memory only; the oldest are dropped first. A restart empties the buffer.
- **No replay.** After a reconnect, a gap entry marks where events may be missing. The
  service never claims more than it received.
- **In order.** Events are kept in the order the console sent them.
- **Coalesced notifications.** At most one notification per client and stream every
  250 ms. Read the resource to get everything that arrived.

## Reconnects and console changes

The connection to the console takes the same path as every other request: the console
registry, the egress allowlist with its DNS check, TLS verification or the pinned key,
then the WebSocket upgrade of the documented path with the stored API key
([security.md](security.md#connections-to-consoles)). It only listens: it never sends the
console anything but keep-alive and closing frames.

- **Keep-alive.** A ping every 30 s. A connection with no traffic for 10 s after a ping is
  treated as lost.
- **Backoff.** After a lost connection or a failed attempt, the service waits 1 s, then up
  to twice as long each time (randomised), at most 60 s. A connection that lasted less
  than 10 s does not reset the wait.
- **A refused key** (the console answers the upgrade with 401 or 403) waits 5 minutes
  before the next attempt.
- **No reconnect storms.** All streams of all consoles share one limit of one connection
  attempt per second (bursts of 5). At most 64 streams can be open at once.
- **Changed settings.** When a console's address, port, TLS trust or stored key changes,
  open connections are closed and re-opened within 5 s with the new settings. A console
  whose version is no longer supported is disconnected.
- A console that is not configured, or whose key cannot be read, is checked again every
  30 s.

## Subscription limits

- At most 8 open subscriptions per client, and at most 64 console streams in the whole
  service. More are refused with `Subscription limit reached`.
- Only the first 32 resource URIs of one subscription are considered; the others are left
  out of the acknowledgement.
- A subscription lasts at most one hour; the client subscribes again and is authorised
  again.
- A subscription is closed within 5 s when the client may no longer use one of its
  streams (a withdrawn grant, a module switched off, a policy change), or when the client
  is revoked or its token expires (at once for a revocation in the admin interface).
- A client that has not read its subscription stream for 30 s while notifications wait is
  closed as a slow consumer. Other clients are not affected.
- `subscriptions/listen` cannot be sent inside a JSON-RPC batch.

These limits are fixed in this release.

## States and codes

| `state`       | Meaning                                                                                      |
| ------------- | -------------------------------------------------------------------------------------------- |
| `inactive`    | Nobody subscribes to this stream, so nothing is received.                                    |
| `connecting`  | The service is connecting to the console.                                                    |
| `connected`   | Events are being received.                                                                   |
| `retrying`    | The connection failed or was lost; the service tries again with backoff (`detail` says why). |
| `unavailable` | The service cannot connect until something changes (`detail` says what).                     |

| `detail`                                                                     | Meaning and fix                                                                                                                                                               |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `console_not_configured`                                                     | The console, its `protect` module or its key is not set up: `unifi-mcp console set-credential <alias> --module protect` and `console enable-module <alias> --module protect`. |
| `credentials_unreadable`                                                     | The stored key cannot be decrypted. Run `unifi-mcp db check`, then store the key again.                                                                                       |
| `operation_unsupported`                                                      | The console's Protect version is outside the supported range (`unifi-mcp console probe <alias> --module protect`).                                                            |
| `egress_denied`, `dns_failed`, `tls_pin_mismatch`, `tls_verification_failed` | As for requests: see [troubleshooting.md](troubleshooting.md#the-console-cannot-be-reached).                                                                                  |
| `connect_failed`, `connect_timeout`, `handshake_timeout`                     | No route, a firewall, or the console is down or slow.                                                                                                                         |
| `upgrade_unauthorized`                                                       | The console refused the key for the subscription (HTTP 401 or 403). Store a new key; the service reconnects within 5 s.                                                       |
| `upgrade_refused`, `handshake_invalid`                                       | The console did not accept the subscription, or answered in a way the WebSocket protocol does not allow. Report it with the Protect version.                                  |
| `connection_lost`, `idle_timeout`, `closed_by_console`                       | The connection dropped, went silent, or the console closed it. The service reconnects; readers see a gap.                                                                     |
| `protocol_error`, `message_too_large`                                        | The console sent a malformed frame, or a message larger than the stream allows (256 KiB for events, 1 MiB for devices). The connection is closed and re-opened.               |

## Logs and audit

| `msg`                                                       | Level | Meaning                                                                                                    |
| ----------------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------- |
| `event subscription open`                                   | info  | Connected to a console's stream (`consoleId`, `stream`).                                                   |
| `event feed could not connect`                              | warn  | An attempt failed (`code`, `retryInMs`).                                                                   |
| `event feed disconnected`                                   | warn  | An open connection ended (`code`, `retryInMs`).                                                            |
| `event feed reconnects after a console change`              | info  | The console's settings or key changed.                                                                     |
| `event messages do not match the contract and were dropped` | warn  | Messages that do not match the documented schema, as a count (at most once a minute). Never their content. |
| `event subscription closed`                                 | info  | A client's subscription was closed (`reason`: `lifetime` or `no_longer_permitted`).                        |
| `event subscription closed: the client is not reading`      | warn  | A slow consumer was closed (`clientId`).                                                                   |
| `event subscription refused`                                | warn  | A subscription was refused because 64 console streams are already open (`clientId`).                       |
| `event feed failed`, `event notification failed`            | error | An internal error. Please report it.                                                                       |

The audit trail records every subscription (`events.subscribe`, with how many URIs were
accepted and refused) and every read (`resource.read`, with the number of events and the
state, or the reason it was denied). Event content is never logged or audited.

There is no status page for event connections yet; the logs and a resource read show
their state. Metrics for event subscriptions are planned with the Prometheus endpoint
(Phase 5).

## Troubleshooting

- **No event resources are listed.** The client lacks the stream's permission, is not
  granted the console, or the console's Protect version is unknown or unsupported
  (`unifi-mcp client show <id>`, `unifi-mcp console probe <alias> --module protect`).
- **`state: inactive`.** No 2026-era client subscribes. A 2025-era client alone never
  starts the connection.
- **Some events never arrive for one client.** It lacks a grant the event needs: the
  identity grants for NFC and fingerprint events, or the device's read for device changes.
  Another client with more grants sees them; that is by design.
- **Notifications stop after an hour.** Subscriptions last at most one hour; subscribe
  again.
- **Notifications never arrive through a reverse proxy.** The proxy buffers or cuts the
  subscription stream. It must not buffer `text/event-stream` responses and must allow
  them to stay open for an hour ([networking.md](networking.md#reverse-proxies)).
