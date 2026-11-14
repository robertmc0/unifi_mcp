# UniFi Access

> **Status: Phase 4, in progress.** All 39 Access reads and 58 writes are available and
> tested against a synthetic Access API. Access has not been tested against a real console:
> the project's test console has no Access, and the contract is a PDF transcribed by this
> project ([Limitations](#limitations)). What is carried forward:
> [phase-checklist.md](phase-checklist.md#phase-4--access-and-other-documented-modules).

The service uses the **official local** UniFi Access API on each console,
`https://<console>:12445/api/v1/developer/…`, with the API token you stored for the
`access` module ([ADR 0023](adr/0023-access-adapter.md)). Ubiquiti publishes this API only
as a PDF. Its request and response schemas are this project's transcription of that PDF,
checked against its text but not against a console
([ADR 0022](adr/0022-access-contract-transcription.md)).

## Supported versions

Access does not report its version through its API. **An administrator declares it**,
and the service labels it "declared, not observed" wherever it is used
([ADR 0021](adr/0021-access-contract-version-evidence.md) §5).

| Declared Access version                      | Result                                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| From an operation's stated minimum, ≤ 4.2.16 | Supported. Each operation has its own minimum (1.9.1 for most, up to 4.0.10), as the PDF states. |
| Above 4.2.16 (for example 4.3.x)             | Refused as `operation_unsupported`. The PDF covers releases up to 4.2.16.                        |
| Not declared, or the declaration expired     | Refused as `version_unknown`, with a message saying an administrator must declare it.            |

Some arguments need a later version than their operation, for example `expand[]` on
`access.visitors.list` (1.22.16). A call that uses one on an older declared version is
refused before anything is sent, and the message names the argument and the version.

A declaration counts for **30 days**. Declare the version again after every Access update
and before it expires; `unifi-mcp doctor` warns 7 days before. Every declaration is
audited, and changing it invalidates pending approvals.

## Getting started

1. In UniFi Access, create an API token (Settings > General > Advanced > API Token) with
   the permission scopes the reads need (`view:user`, `view:space`, …). The token is shown
   once. Store it for the `access` module:
   `unifi-mcp console set-credential <alias> --module access --key-file <file>`.
2. Pin the Access certificate. Access serves its own self-signed certificate on port
   12445, different from the console's. `unifi-mcp console check <alias> --module access`
   shows its pin; store it beside the console's own:
   `unifi-mcp console set-tls <alias> --tls pinned --pin sha256/<console> --pin sha256/<access>`.
3. Enable the module, read-only:
   `unifi-mcp console enable-module <alias> --module access`. If your Access listens on
   another port (a Ubiquiti help article names 12455), add `--port <n>`.
4. Declare the installed Access version:
   `unifi-mcp console declare-version <alias> --module access --version <x.y.z>`.
5. Give a client the reads it needs, for example
   `unifi-mcp client create <id> --console <alias> --allow 'access.spaces.read'`.

## Reads

Every read is low risk and needs only the matching grant, for example
`access.spaces.read` (or `access.*.read` for all). Access has no sites: every operation is
aimed at a console. Lists that the PDF documents as paged return `pagination` with
`pageNum`, `pageSize`, `total` and, while more remain, `nextPageNum`.

| Operations                                                                                    | Named tool                             | What they return                                                          |
| --------------------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------- |
| `access.spaces.list_doors`, `access.spaces.get_door`                                          | `access_list_doors`, `access_get_door` | Doors: floor, lock state, door-position state, whether a hub can open it. |
| `access.spaces.get_topology`, `list_door_groups`, `get_door_group`                            |                                        | Buildings, floors, doors and door groups.                                 |
| `access.spaces.get_lock_rule`, `get_emergency_status`                                         |                                        | A door's temporary lock rule; lockdown or evacuation of all doors.        |
| `access.devices.list`, `get_access_methods`                                                   |                                        | Hubs, readers and intercoms; the access methods a reader accepts.         |
| `access.policies.*` (6)                                                                       |                                        | Access policies, schedules and holiday groups.                            |
| `access.user_groups.list`, `get`, `list_access_policies`; `access.users.list_access_policies` |                                        | User groups, and the policies of a user or group.                         |
| `access.identity.*` (3)                                                                       |                                        | UniFi Identity resources (Wi-Fi, VPN, EV stations) and their assignments. |
| `access.webhooks.list_endpoints`                                                              |                                        | Webhook endpoints and their events. **Never their secrets or headers.**   |
| `access.users.*` (3), `access.user_groups.list_users`, `list_all_users`                       |                                        | Users. **Sensitive** (below).                                             |
| `access.visitors.list`, `get`                                                                 |                                        | Visitors. **Sensitive.**                                                  |
| `access.credentials.*` (7)                                                                    |                                        | NFC cards, card enrollment and Touch Passes. **Sensitive.**               |
| `access.logs.list`, `get_resource`                                                            |                                        | System logs and the recordings they refer to. **Sensitive, bounded.**     |

### Sensitive reads

| Grant                          | Needed for                                                                  |
| ------------------------------ | --------------------------------------------------------------------------- |
| `personal_identifier`          | users, visitors, user group members, NFC cards, Touch Passes, system logs   |
| `biometric_or_access_identity` | users, visitors, user group members, NFC cards and enrollment, Touch Passes |
| `access_log`                   | system logs and log resources                                               |
| `recording`                    | log resources (paths of video recordings and thumbnails)                    |

Without a grant the read is refused (`sensitive_scope_missing`) and nothing is sent.

`access.logs.list` reads one topic in a window of **at most 31 days** (`body.since` and
`body.until`, both required) and **at most 100 entries** a page (`page_size`), as spec §6.4
requires for access histories.

## Writes

Access controls physical doors. No write can run until every gate allows it
([security.md](security.md#making-writes-possible)): the hard lock is off, the runtime mode
is `read_write`, the console's `access` module is `read_write`, the version is declared,
and the client has a write grant. Grants are per category:

| Grant                      | Covers                                                                         |
| -------------------------- | ------------------------------------------------------------------------------ |
| `access.doors.write`       | Remote unlock, temporary lock rules, lockdown and evacuation.                  |
| `access.spaces.write`      | Door groups only. **It does not open doors.**                                  |
| `access.users.write`       | Users, their credentials (NFC cards, PINs, plates, Touch Passes) and policies. |
| `access.user_groups.write` | User groups, their members and policies.                                       |
| `access.visitors.write`    | Visitors and their credentials.                                                |
| `access.policies.write`    | Access policies, schedules and holiday groups.                                 |
| `access.credentials.write` | NFC card enrollment, cards, Touch Passes.                                      |
| `access.identity.write`    | UniFi Identity invitations and Wi-Fi, VPN and EV-station assignments.          |
| `access.devices.write`     | Ringing a doorbell.                                                            |
| `access.webhooks.write`    | Webhook endpoints.                                                             |
| `access.api_server.write`  | Removing the API server's uploaded certificate.                                |

- **High risk (51 writes): human approval first.** Every write that can open, lock or ring a
  door, or change who may open which door, when, or with what credential, is high risk
  whatever its HTTP method (spec §6.3). So is every deletion, anything that sends data or
  invitations away from the console, buying Touch Passes, and the certificate removal. The
  call returns `approval_required`; nothing is sent until a human approves on the host or
  in the admin interface, and the same client then calls `unifi_resume_approved`
  ([approval-workflow.md](approval-workflow.md)). Approvers see the declared-version notice
  and, for many writes, a caution that names the consequence (for example "This unlocks a
  physical door or moves a gate").
- **Medium risk (7 writes)** run once the grants allow them. They change nobody's access by
  themselves: creating an access policy, schedule, holiday group, door group or empty user
  group (assigning or referencing them is high risk), renaming an NFC card, and ending a
  card enrollment session.
- **Off by default (7 writes)**: they must be listed in the global policy's
  `enabledOperations` ([administration.md](administration.md)) before any client can use
  them, and still need approval.

| Off by default                                                       | Why                                                                                                                     |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `access.users.assign_pin`, `access.visitors.assign_pin`              | The client chooses the PIN, so it knows it, and the approver cannot see it.                                             |
| `access.doors.set_emergency`                                         | Lockdown or evacuation acts on every door at once.                                                                      |
| `access.webhooks.create_endpoint`, `access.webhooks.update_endpoint` | The console then sends events, including who opened which door, to any address, outside this service's egress controls. |
| `access.credentials.purchase_touch_passes`                           | It charges the payment method configured in Access.                                                                     |
| `access.api_server.delete_certificate`                               | Access returns to a self-generated certificate, and the service cannot reach it until you pin that one.                 |

Other rules:

- The Access API token needs the matching `edit:` scope for each write (for example
  `edit:space` for the unlock, `edit:user` for users);
  [api-coverage.json](api-coverage/api-coverage.json) lists each operation's
  `vendorPermission`. The service's grants and approvals apply on top of the token's
  scopes.
- **The remote unlock names no actor.** `access.doors.unlock` takes the door `id`, and
  optionally `reader_id`, `entry_method` and `control_cmd` (gates, Access 4.2.16). It does
  not accept the PDF's `actor_id` and `actor_name`: the console records them as the person
  who unlocked the door, and a model must not choose that name. The request is sent
  without a body.
- **PINs** in requests are sent to the console, but never logged, audited, shown to
  approvers or returned. An approver sees `[REDACTED]` in their place, and also for NFC
  card tokens.
- Writes that take a body get it as one `body` argument, for example
  `{ "id": "…", "body": { "name": "Front door" } }`. `unifi_describe_operation` shows the
  schema.
- Pass an `idempotencyKey` to make a retry safe. A console refusal (any result code other
  than `SUCCESS`) is reported as failed and never retried. A broken connection, a success
  status without a result code, or `CODE_SYSTEM_ERROR` after sending returns
  `outcome_unknown` and is never retried automatically: check the console before trying
  again.
- None of these writes has a concurrency precondition in the contract. An approved write
  applies the approved arguments to whatever the console holds at that moment.

| Operations                                                                                                                             | Risk                     | What they do                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------- |
| `access.doors.unlock`                                                                                                                  | high                     | Unlock a door, or open, close or stop a gate.                                                 |
| `access.doors.set_lock_rule`                                                                                                           | high                     | Keep a door locked or unlocked, unlock it for a while, lock it early or now, or end the rule. |
| `access.doors.set_emergency`                                                                                                           | high, **off by default** | Lockdown (all doors locked) or evacuation (all doors unlocked), on or off.                    |
| `access.spaces.create_door_group`; `update_door_group`, `delete_door_group`                                                            | medium; high             | Door groups.                                                                                  |
| `access.devices.ring_doorbell`                                                                                                         | high                     | Ring a reader's doorbell, or cancel the ringing.                                              |
| `access.users.create`, `update`, `delete`                                                                                              | high                     | Users, including their status (active or deactivated). **Sensitive.**                         |
| `access.users.assign_access_policies`                                                                                                  | high                     | Which policies a user holds.                                                                  |
| `access.users.assign_nfc_card`, `unassign_nfc_card`, `unassign_pin`, `assign_license_plates`, `unassign_license_plate`                 | high                     | A user's credentials. **Sensitive.**                                                          |
| `access.users.assign_pin`                                                                                                              | high, **off by default** | Set a user's PIN.                                                                             |
| `access.users.assign_touch_pass`, `unassign_touch_pass`, `assign_touch_passes`                                                         | high                     | Touch Passes of one or several users. **Sensitive.**                                          |
| `access.user_groups.create`; `update`, `delete`, `add_users`, `remove_users`, `assign_access_policies`                                 | medium; high             | User groups, their members and policies.                                                      |
| `access.identity.send_invitations`, `assign_user_resources`, `assign_group_resources`                                                  | high                     | UniFi Identity invitations (by e-mail); Wi-Fi, VPN and EV-station assignments.                |
| `access.visitors.create`, `update`, `delete`                                                                                           | high                     | Visitors, their visit window, doors and weekly times. **Sensitive.**                          |
| `access.visitors.assign_nfc_card`, `unassign_nfc_card`, `unassign_pin`, `assign_qr_code`, `unassign_qr_code`, `unassign_license_plate` | high                     | A visitor's credentials. The QR code itself is not returned. **Sensitive.**                   |
| `access.visitors.assign_pin`                                                                                                           | high, **off by default** | Set a visitor's PIN.                                                                          |
| `access.policies.create`, `create_schedule`, `create_holiday_group`                                                                    | medium                   | New policies, schedules and holiday groups, used by nobody yet.                               |
| `access.policies.update`, `delete`, `update_schedule`, `delete_schedule`, `update_holiday_group`, `delete_holiday_group`               | high                     | Change or delete them, for everyone who holds or uses them.                                   |
| `access.credentials.start_nfc_enrollment`                                                                                              | high                     | Put a reader into card enrollment; returns the session to read the card from. **Sensitive.**  |
| `access.credentials.cancel_nfc_enrollment`, `update_nfc_card`                                                                          | medium                   | End an enrollment session; rename a card.                                                     |
| `access.credentials.delete_nfc_card`, `update_touch_pass`                                                                              | high                     | Delete a card; rename, suspend or reactivate a Touch Pass. **Sensitive.**                     |
| `access.credentials.purchase_touch_passes`                                                                                             | high, **off by default** | Buy Touch Passes.                                                                             |
| `access.webhooks.create_endpoint`, `update_endpoint`                                                                                   | high, **off by default** | Webhook endpoints. Their secret is never returned.                                            |
| `access.webhooks.delete_endpoint`                                                                                                      | high                     | Delete a webhook endpoint.                                                                    |
| `access.api_server.delete_certificate`                                                                                                 | high, **off by default** | Remove the API server's uploaded certificate.                                                 |

Writes marked **Sensitive** need the same grants as the matching reads
([Sensitive reads](#sensitive-reads)): `personal_identifier` for names and contact details,
`biometric_or_access_identity` for credentials.

## Credentials are never returned

- A user's or visitor's `pin_code.token`, the hash of their PIN: removed. An empty
  `pin_code` still shows that a PIN is assigned.
- A webhook endpoint's `secret` and its forwarded `headers`: removed, also from the
  results of creating or changing an endpoint, so no MCP client learns a receiver's
  signing secret.
- The PIN generator (`POST /api/v1/developer/credentials/pin_codes`) is not offered: its
  result is a PIN.

NFC card tokens are returned (they address cards in the API and are not the card's
secret); they need the `biometric_or_access_identity` grant.

## Limitations

- **Not tested on a real Access console.** The schemas follow this project's transcription
  of the PDF; where the PDF disagrees with itself, the transcription records the choice
  ([ADR 0022](adr/0022-access-contract-transcription.md), Evidence). A real console may
  answer differently: a response that does not match is refused as
  `upstream_contract_mismatch`.
- **Some fields are not returned:** a user's `touch_pass` (the PDF types it as a list but
  shows one object; read Touch Passes through `access.credentials.*`), Touch Pass
  `activated_at` and `expired_at`, and `bundles` where the PDF does not document their
  items.
- **Versions above 4.2.16 are refused** until a version-labelled contract or a live run
  covers them (ADR 0021).
- How a real console reports errors through HTTP statuses is not documented; the service
  relies on the documented result codes (ADR 0023 §1).
- **Writes not tested on a console**, like the reads. In particular, the PDF does not say
  whether a new user starts with any access, what a user group inherits from its parent,
  or what deleting a policy, schedule or group in use does; the risk review assumes the
  worst case (ADR 0023 §4).
- Not offered: changing a reader's access methods (§8.3, its body is not verified), the
  notification WebSocket (§11.1), and the downloads and uploads (QR code images, CSV export
  and import, static files, profile pictures, certificates, a visitor's license plates).
