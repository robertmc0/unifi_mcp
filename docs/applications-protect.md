# UniFi Protect

> **Status: Phase 3 in progress.** The Protect adapter supports the official release 7.3.74
> and the newest documented revision 7.4.96 of the Protect integration API. All 38
> documented HTTP reads, 41 of the 42 writes and both 7.3.74 event subscriptions
> ([Events](#events)) are available and tested against a synthetic console. The reads
> passed a live read-only test on a 7.3.74 console without devices, with one reviewed
> exception ([Limitations](#limitations)). The remaining steps
> ([phase-checklist.md](phase-checklist.md#phase-3--unifi-protect-in-progress)).

The service uses the **official local** UniFi Protect integration API on each console,
`https://<console>/proxy/protect/integration/v1/…`, with the API key you stored for the
`protect` module. It never uses the cloud connector. Every operation is reviewed against
the published contract of the oldest supported revision that documents it
([ADR 0019](adr/0019-protect-adapter.md)).

## Supported versions

| Protect application version | Result                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------ |
| 7.4.96 and later 7.x        | Supported: every implemented operation.                                              |
| 7.3.74 up to 7.4.96         | Supported, except the operations 7.4.96 added (below), which are hidden and refused. |
| Earlier, or 8 and later     | Refused as `operation_unsupported`; the message names the version.                   |
| Not yet known               | Refused as `version_unknown`. The service checks the version within a minute.        |

The operations 7.4.96 added are the external arm profiles (`protect.alarm.*_external_profile*`,
`protect.alarm.arm_external_profile`, `protect.alarm.disarm_external_profile`) and
`protect.speakers.stop_siren`. Everything else is built from the 7.3.74 contract, which
newer 7.x consoles keep: the service checks that every later change is an addition. On a
7.4.x console, the newest fields (an NVR's feature flags, whether a sensor is mounted
incorrectly) are not returned, and the camera video mode `antiFlicker` cannot be set.

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

## Events

Protect documents two event subscriptions, and the service offers both as MCP resources
([client-generic-mcp.md](client-generic-mcp.md#events-resources-and-subscriptions),
[ADR 0020](adr/0020-event-subscriptions.md)):

| Resource                                       | Grant                  | What it carries                                                                             |
| ---------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------- |
| `unifi://consoles/<consoleId>/protect/events`  | `protect.events.read`  | Rings, motion and smart detections, sensor and alarm hub events, NFC and fingerprint scans. |
| `unifi://consoles/<consoleId>/protect/devices` | `protect.devices.read` | Devices added, updated (the changed fields) or removed.                                     |

Who sees which event is decided like a read:

- **NFC card and fingerprint scans** name the UniFi Identity user, so they also need
  `personal_identifier` and `biometric_or_access_identity`. Without both, a client does
  not see them at all.
- **A device change** carries the same data as reading that device, so it also needs that
  read's permission and grants: a camera change needs `protect.cameras.read`, a fob change
  `protect.fobs.read` and `location`. AI processors and AI ports have no documented read, so
  their changes are never shown.
- Event types or device kinds that a newer Protect adds are not shown until they are
  reviewed.

The service connects to the console only while a client subscribes, and keeps the most
recent events briefly in memory. There is no history and no replay: events that happen
while nobody subscribes are not seen. 2026-era clients subscribe with
`subscriptions/listen`; 2025-era clients can only read the resources.

For example: `unifi-mcp client create <id> --console <alias> --allow 'protect.events.read'`.

## Writes

No write can run until every gate allows it ([security.md](security.md#making-writes-possible)):
the hard lock is off, the runtime mode is `read_write`, the console's `protect` module is
`read_write`, and the client has a write grant such as `protect.lights.write`. Grants are
per category, so a client can be allowed to move cameras (`protect.cameras.write`) without
being allowed to arm or disarm the alarm (`protect.alarm.write`).

- **High risk** writes return `approval_required` and an `approvalId`. Nothing is sent to
  the console until a human approves on the host or in the admin interface; the same
  client then calls `unifi_resume_approved` ([approval-workflow.md](approval-workflow.md)).
  Everything that can arm or disarm the alarm, silence or disable an alarm, a siren or a
  sensor's alerts, or act in the physical world (sirens, relays, alarm outputs) is high
  risk.
- **Medium risk** writes run once the grants allow them: comfort settings, live views, PTZ
  moves, short test sounds, and enabling or disabling RTSPS streams.
- Writes that take a body get it as one `body` argument next to `id`, for example
  `{ "id": "…", "body": { "name": "Porch" } }`. `unifi_describe_operation` shows the schema.
- Pass an `idempotencyKey` to make a retry safe. A write whose connection broke after
  sending returns `outcome_unknown` and is never retried automatically.
- An arm-profile PIN (`pin_code`) in a request is sent to the console, but never logged,
  audited, shown to approvers or returned.

| Operation                                                                                                                                   | Risk                       | What it does                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `protect.cameras.update`                                                                                                                    | high                       | Camera settings, including motion and smart detection, microphone, LEDs, overlays.                                                |
| `protect.cameras.create_rtsps_streams`, `protect.cameras.delete_rtsps_streams`                                                              | medium                     | Enable or disable RTSPS streams. Returns which qualities exist, never the URLs.                                                   |
| `protect.cameras.disable_microphone_permanently`                                                                                            | high, **off by default**   | Disables a camera microphone for good. Cannot be undone.                                                                          |
| `protect.cameras.start_talkback`                                                                                                            | medium, **off by default** | Starts a talkback session. Returns only the audio format: the session endpoint is never returned, so an MCP client cannot use it. |
| `protect.cameras.ptz_goto`, `protect.cameras.ptz_start_patrol`, `protect.cameras.ptz_stop_patrol`                                           | medium                     | Move a PTZ camera to a preset, or start and stop a patrol.                                                                        |
| `protect.cameras.add_pos_transaction`                                                                                                       | medium                     | Attaches a point-of-sale transaction to a camera's recording.                                                                     |
| `protect.lights.update`                                                                                                                     | medium                     | Floodlight settings.                                                                                                              |
| `protect.sensors.update`                                                                                                                    | high                       | Sensor settings, including which readings raise alerts.                                                                           |
| `protect.sirens.update`, `protect.sirens.play`, `protect.sirens.stop`                                                                       | high                       | Siren settings; sound a siren; stop a sounding siren.                                                                             |
| `protect.sirens.test_sound`, `protect.speakers.test_sound`                                                                                  | medium                     | A short test sound.                                                                                                               |
| `protect.speakers.update`, `protect.chimes.update`, `protect.bridges.update`                                                                | medium                     | Speaker, chime and bridge settings.                                                                                               |
| `protect.speakers.stop_siren`                                                                                                               | high                       | Stops a siren sound playing on a speaker.                                                                                         |
| `protect.relays.update`, `protect.relays.activate_output`                                                                                   | high                       | Relay settings; switch a relay output (doors, gates).                                                                             |
| `protect.link_stations.update`                                                                                                              | high                       | Link station settings, including its sensors' wireless network.                                                                   |
| `protect.alarm_hubs.update`, `protect.alarm_hubs.trigger_output`                                                                            | high                       | Alarm hub settings; trigger an output wired to it.                                                                                |
| `protect.fobs.update`                                                                                                                       | high                       | Fob settings, including whether it may arm and disarm.                                                                            |
| `protect.alarm.create_arm_profile`, `protect.alarm.update_arm_profile`, `protect.alarm.delete_arm_profile`, `protect.alarm.update_settings` | high                       | Arm profiles and settings of the local alarm manager.                                                                             |
| `protect.alarm.arm`, `protect.alarm.disarm`                                                                                                 | high                       | Arm or disarm the local alarm manager.                                                                                            |
| `protect.alarm.trigger_webhook`                                                                                                             | high                       | Triggers an alarm manager webhook, which runs its alarm and actions.                                                              |
| `protect.alarm.create_external_profile`, `protect.alarm.update_external_profile`, `protect.alarm.delete_external_profile`                   | high                       | External arm profiles, with an optional PIN.                                                                                      |
| `protect.alarm.arm_external_profile`, `protect.alarm.disarm_external_profile`                                                               | high                       | Arm or disarm an external arm profile.                                                                                            |
| `protect.viewers.update`, `protect.liveviews.create`, `protect.liveviews.update`                                                            | medium                     | What viewers show; live view layouts.                                                                                             |

Operations that are off by default must be listed in the global policy's
`enabledOperations` before any client can use them
([administration.md](administration.md)); the microphone disable still needs approval.

None of these writes has a concurrency precondition in the contract (no version or ETag).
An approved write applies the approved arguments to whatever the console holds at that
moment, so review the current state before approving.

## Testing against a real console

`npm run test:live` runs the Protect reads your console's version supports, together with
the Network reads ([applications-network.md](applications-network.md#testing-against-a-real-console)),
with the same settings. It is never part of `npm run check` or CI.

```sh
UNIFI_LIVE_HOST=<console address> \
UNIFI_LIVE_NETWORK_KEY_FILE=<file with the API key> \
UNIFI_LIVE_TLS_PIN=sha256/… \
UNIFI_LIVE_PROTECT_REPORT=docs/api-coverage/live/protect-7.3.74.json \
npm run test:live
```

Add `UNIFI_LIVE_REPORT=docs/api-coverage/live/network-11.0.97.json` to refresh the Network
record as well.

- Only the Protect reads are registered, a guard refuses anything that is not a GET, the
  hard lock is on and the client can only read. `UNIFI_LIVE_PROTECT_KEY_FILE` sets a
  different key for Protect.
- Reads that need a newer Protect than the console runs are skipped. Name the report after
  the revision the console reaches: `protect-7.3.74.json` for 7.3.x, `protect-7.4.96.json`
  for 7.4.x.
- Each list is followed by a read of its first item. Without devices of a kind, the item
  read is skipped, and the list is reported as `ok (empty)`: it matches the contract but
  checks no item, so the coverage matrix does not count it as validated.
- A camera snapshot is fetched only with `UNIFI_LIVE_PROTECT_SNAPSHOT=1`. It stays in
  memory and is discarded.
- To learn how event subscriptions authenticate, it asks the documented
  `/v1/subscribe/events` for a WebSocket upgrade twice: with your key, and with a random
  key as the control (one failed login on the console). Only the status line is read; no
  event is.
- The report holds operation ids, outcomes, the Protect version and the two upgrade
  statuses. It holds no names, ids, e-mail addresses or data. Read it before you commit it.

### Writes

Validating writes on a real console is a manual runbook, approved step by step by you:
[runbook-protect-writes.md](runbook-protect-writes.md). Its first part needs no Protect
devices.

## Credentials are never returned

Some Protect results grant access by themselves. The service removes them from every
result, at any depth:

- talkback session URLs (an RTP endpoint for sending audio to a camera speaker);
- external arm profile PINs (`pin_code`; the contract only returns `has_pin`);
- RTSPS stream URLs, which carry an access token in their path (removed by the stream
  operations).

## Limitations

- **The 7.4.96 model update subscription** (`GET /v1/subscribe/updates`) is not offered
  yet. It takes a list of model kinds, and its documented message forms overlap so that a
  tolerant schema would drop data; it will be reviewed when an official release documents
  it ([ADR 0020 §6](adr/0020-event-subscriptions.md)).

- **The NVR's selected arm profile may be missing.** The contract requires
  `armMode.armProfileId` (a profile id or `null`) in `protect.nvrs.list`, but a 7.3.74
  console was seen leaving it out. The service accepts the NVR without it and returns it
  without the field; it does not fill in `null`. Any other missing or mistyped field still
  fails the read with `upstream_contract_mismatch`
  ([ADR 0019 §8](adr/0019-protect-adapter.md#8-live-evidence-2026-11-12-and-a-reviewed-response-exception)).
- **Device reads have not been checked against a real console yet.** The console tested so
  far had no Protect devices. The schemas come from the contract and pass the synthetic
  tests.

- **Device asset upload** (`POST /v1/files/{fileType}`) is not implemented. The contract
  documents its multipart body only as a binary string, without the name of the form
  field that carries the file. Sending it would mean guessing
  ([ADR 0019](adr/0019-protect-adapter.md)).
