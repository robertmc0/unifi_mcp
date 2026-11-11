# UniFi Protect

> **Status: Phase 3 in progress.** The Protect adapter targets the Protect integration API
> 7.4.96 (83 documented operations). All 38 documented HTTP reads are available and tested
> against a synthetic console. Writes and event subscriptions follow in the next steps
> ([phase-checklist.md](phase-checklist.md#phase-3--unifi-protect-in-progress)).

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

Every read is low risk and needs only the matching grant, for example
`protect.cameras.read` (or `protect.*.read` for all). Protect has no sites: every operation
is aimed at a console. Lists return the whole list; the contract has no paging.

| Operation                                                                    | Named tool                                   | What it returns                                                                  |
| ---------------------------------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------- |
| `protect.info.get`                                                           |                                              | The Protect application version.                                                 |
| `protect.cameras.list`, `protect.cameras.get`                                | `protect_list_cameras`, `protect_get_camera` | Cameras: name, model, state, video mode, microphone, HDR and detection settings. |
| `protect.cameras.get_snapshot`                                               | `protect_get_snapshot`                       | A current JPEG snapshot, as image content. **Needs the `camera_image` grant.**   |
| `protect.cameras.get_rtsps_streams`                                          |                                              | Which RTSPS stream qualities are enabled (`true`/`false`). **Never the URLs.**   |
| `protect.lights.list`, `protect.lights.get`                                  |                                              | Floodlights: state, light mode, motion settings.                                 |
| `protect.sensors.list`, `protect.sensors.get`                                |                                              | Sensors: state, mount type, readings and alerts.                                 |
| `protect.sirens.list`, `protect.sirens.get`                                  |                                              | Sirens and their settings.                                                       |
| `protect.speakers.list`, `protect.speakers.get`                              |                                              | Speakers and their settings.                                                     |
| `protect.chimes.list`, `protect.chimes.get`                                  |                                              | Chimes: paired doorbells, volume, ring settings.                                 |
| `protect.relays.list`, `protect.relays.get`                                  |                                              | Relays and their outputs.                                                        |
| `protect.bridges.list`, `protect.bridges.get`                                |                                              | Bridges for wireless Protect devices.                                            |
| `protect.link_stations.list`, `protect.link_stations.get`                    |                                              | Link stations and their wireless networks.                                       |
| `protect.alarm_hubs.list`, `protect.alarm_hubs.get`                          |                                              | Alarm hubs: inputs, outputs, terminal status.                                    |
| `protect.fobs.list`, `protect.fobs.get`                                      |                                              | Key fobs and whether each is in range. **Needs the `location` grant.**           |
| `protect.nvrs.list`                                                          |                                              | The recorder: arm mode, doorbell settings, features.                             |
| `protect.alarm.list_arm_profiles`                                            |                                              | Arm profiles of the local alarm manager.                                         |
| `protect.alarm.list_external_profiles`, `protect.alarm.get_external_profile` |                                              | External arm profiles: state, delays, alarms. PINs are never returned.           |
| `protect.viewers.list`, `protect.viewers.get`                                |                                              | Viewers (display devices) and their live view.                                   |
| `protect.liveviews.list`, `protect.liveviews.get`                            |                                              | Live views: camera layouts.                                                      |
| `protect.users.list`, `protect.users.get`                                    |                                              | Users: names and e-mail. **Needs the `personal_identifier` grant.**              |
| `protect.users.list_ulp`, `protect.users.get_ulp`                            |                                              | ULP users: names, e-mail, status. **Needs the `personal_identifier` grant.**     |
| `protect.files.list`                                                         |                                              | Device asset files of one type (`animations`).                                   |

The `get` operations take the device's `id` as an argument, for example
`{ "id": "…" }`. A snapshot takes optional `channel` and `highQuality`.

### Sensitive reads

Three kinds of data need a grant of their own besides the read permission
([security.md](security.md#sensitive-data)):

| Grant                 | Operations                     | Why                                                             |
| --------------------- | ------------------------------ | --------------------------------------------------------------- |
| `camera_image`        | `protect.cameras.get_snapshot` | What a camera sees.                                             |
| `location`            | `protect.fobs.*`               | A fob in range says that the person carrying it is at the site. |
| `personal_identifier` | `protect.users.*`              | Names and e-mail addresses.                                     |

For example:
`unifi-mcp client create <id> --console <alias> --allow 'protect.*.read' --sensitive camera_image`.

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
