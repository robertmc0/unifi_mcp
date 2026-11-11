# UniFi Protect

> **Status: Phase 3 in progress.** The Protect adapter targets the Protect integration API
> 7.4.96 (83 documented operations). So far the service probes the Protect version and
> serves `protect.info.get`. Camera and device reads, writes and event subscriptions
> follow in the next steps ([phase-checklist.md](phase-checklist.md#phase-3--unifi-protect-in-progress)).

The service uses the **official local** UniFi Protect integration API on each console,
`https://<console>/proxy/protect/integration/v1/…`, with the API key you stored for the
`protect` module. It never uses the cloud connector. Every operation is reviewed against
the published contract, revision 7.4.96 ([ADR 0019](adr/0019-protect-adapter.md)).

## Supported versions

| Protect application version | Result                                                                        |
| --------------------------- | ----------------------------------------------------------------------------- |
| 7.4.96 and later 7.x        | Supported.                                                                    |
| Earlier, or 8 and later     | Refused as `operation_unsupported`; the message names the version.            |
| Not yet known               | Refused as `version_unknown`. The service checks the version within a minute. |

The service learns each console's Protect version by itself (`GET /v1/meta/info`) and
refreshes it every 6 hours. `unifi-mcp console probe <alias> --module protect` checks at
once. The operations of an unsupported console are not listed to clients.

## Getting started

1. A key created in UniFi Network under _Integrations_ also works for Protect on the same
   console ([ADR 0005](adr/0005-official-local-unifi-api-contracts.md#live-evidence-phase-2-2026-11-11)).
   Store it for the `protect` module and enable the module, read-only:
   `unifi-mcp console set-credential <alias> --module protect` and
   `unifi-mcp console enable-module <alias> --module protect`.
2. Check the version: `unifi-mcp console probe <alias> --module protect`.
3. Give a client the reads it needs, for example
   `unifi-mcp client create <id> --console <alias> --allow 'protect.*.read'`.

## Reads

| Operation          | What it returns                  |
| ------------------ | -------------------------------- |
| `protect.info.get` | The Protect application version. |

## Credentials are never returned

Some Protect results grant access by themselves. The service removes them from every
result, at any depth:

- talkback session URLs (an RTP endpoint for sending audio to a camera speaker);
- external arm profile PINs (`pin_code`; the contract only returns `has_pin`);
- RTSPS stream URLs, which carry an access token in their path (removed by the stream
  operations).

## Limitations

- **Device asset upload** (`POST /v1/files/{fileType}`) is not implemented. The contract
  documents its multipart body only as a binary string, without the name of the form
  field that carries the file. Sending it would mean guessing
  ([ADR 0019](adr/0019-protect-adapter.md)).
