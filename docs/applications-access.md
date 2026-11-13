# UniFi Access

> **Status: Phase 4, in progress.** All 39 Access reads are available and tested against a
> synthetic Access API. Writes are not available yet. Access has not been tested against a
> real console: the project's test console has no Access, and the contract is a PDF
> transcribed by this project ([Limitations](#limitations)). What is carried forward:
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

## Credentials are never returned

- A user's or visitor's `pin_code.token`, the hash of their PIN: removed. An empty
  `pin_code` still shows that a PIN is assigned.
- A webhook endpoint's `secret` and its forwarded `headers`: removed.
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
- Not offered yet: writes, the notification WebSocket (§11.1), and the downloads and
  uploads (QR codes, CSV export and import, static files, profile pictures, certificates).
