# UniFi Network

> **Status: Phase 2 complete.** All 73 documented operations of the Network Integration
> API 11.0.97 (41 reads, 32 writes) are implemented and tested against a synthetic console.
> 23 reads returned data from a real console running Network 11.0.99 and matched the
> contract; the others returned empty lists, had nothing to read there, or failed in the
> console (see Limitations). Testing against your
> own console is optional and opt-in ([below](#testing-against-a-real-console)).

The service uses the **official local** UniFi Network Integration API on each console,
`https://<console>/proxy/network/integration/v1/…`, with the API key you stored for the
`network` module. It never uses the cloud connector. Every operation was reviewed against
the published contract, revision 11.0.97 ([ADR 0018](adr/0018-network-adapter.md)).

## Supported versions

| Network application version | Result                                                                        |
| --------------------------- | ----------------------------------------------------------------------------- |
| 11.0.97 and later 11.x      | Supported.                                                                    |
| Earlier, or 12 and later    | Refused as `operation_unsupported`; the message names the version.            |
| Not yet known               | Refused as `version_unknown`. The service checks the version within a minute. |

The service learns each console's version by itself (`GET /v1/info`) and refreshes it every
6 hours. `unifi-mcp console probe <alias>` checks at once. The operations of an
unsupported console are not listed to clients.

## Getting started

1. Store the API key and enable the module, read-only:
   `unifi-mcp console set-credential <alias> --module network` and
   `unifi-mcp console enable-module <alias> --module network`.
2. Give a client the reads it needs, for example everything except client data:
   `unifi-mcp client create <id> --console <alias> --allow 'network.*.read'`.
3. The client first calls `network_list_sites` (or `unifi_execute` with
   `network.sites.list`) to learn the `siteId` that site-scoped operations need.

## Reads

Every read is low risk and needs only the matching grant, for example `network.devices.read`
(or `network.*.read` for all). Lists take optional `offset` and `limit` (up to 200), and most
take a `filter` in the console's documented filter syntax (for example
`name.eq('Office AP')`). Their results carry `pagination` with `offset`, `limit`, `count`,
`totalCount` and, while more items remain, `nextOffset`.

| Operation                                                                                                              | Named tool                                   | What it returns                                                         |
| ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------- |
| `network.info.get`                                                                                                     |                                              | The Network application version.                                        |
| `network.sites.list`                                                                                                   | `network_list_sites`                         | Sites and their `siteId`.                                               |
| `network.devices.list`, `network.devices.get`                                                                          | `network_list_devices`, `network_get_device` | Adopted devices: model, state, firmware, addresses, interfaces, uplink. |
| `network.devices.get_statistics`                                                                                       |                                              | Uptime, CPU, memory, load and interface statistics of a device.         |
| `network.devices.list_pending`                                                                                         |                                              | Devices waiting to be adopted (console-wide).                           |
| `network.devices.list_tags`                                                                                            |                                              | Device tags. No `filter` (see Limitations).                             |
| `network.clients.list`, `network.clients.get`                                                                          | `network_list_clients`                       | Connected clients. **Needs sensitive grants** (below).                  |
| `network.networks.list`, `network.networks.get`, `network.networks.get_references`                                     | `network_list_networks`                      | Networks and VLANs, their IP configuration, and what refers to them.    |
| `network.wifi.list`, `network.wifi.get`                                                                                |                                              | Wi-Fi broadcasts (SSIDs). **Passphrases are never returned.**           |
| `network.firewall.list_policies`, `network.firewall.get_policy`, `network.firewall.get_policy_ordering`                |                                              | Firewall policies and their order between two zones.                    |
| `network.firewall.list_zones`, `network.firewall.get_zone`                                                             |                                              | Firewall zones and their networks.                                      |
| `network.acl.list`, `network.acl.get`, `network.acl.get_ordering`                                                      |                                              | ACL rules and their order.                                              |
| `network.dns.list`, `network.dns.get`                                                                                  |                                              | DNS policies: local records and forwarding.                             |
| `network.hotspot.list_vouchers`, `network.hotspot.get_voucher`                                                         |                                              | Hotspot vouchers. **Voucher codes are never returned.**                 |
| `network.switching.list_lags`, `network.switching.get_lag`                                                             |                                              | Link aggregation groups.                                                |
| `network.switching.list_mc_lag_domains`, `network.switching.get_mc_lag_domain`                                         |                                              | Multi-chassis LAG domains.                                              |
| `network.switching.list_switch_stacks`, `network.switching.get_switch_stack`                                           |                                              | Switch stacks.                                                          |
| `network.traffic_lists.list`, `network.traffic_lists.get`                                                              |                                              | Traffic matching lists (ports, IPv4 and IPv6 addresses).                |
| `network.vpn.list_servers`, `network.vpn.list_site_to_site_tunnels`                                                    |                                              | VPN servers and site-to-site tunnels.                                   |
| `network.wans.list`                                                                                                    |                                              | WAN interfaces.                                                         |
| `network.radius.list_profiles`                                                                                         |                                              | RADIUS profiles (names only).                                           |
| `network.reference.list_countries`, `network.reference.list_dpi_applications`, `network.reference.list_dpi_categories` |                                              | Reference values for other operations (console-wide).                   |

`unifi_list_operations` lists what a client may use, and `unifi_describe_operation` shows
the arguments of each.

### Client data needs sensitive grants

Client names usually identify people, and MAC and IP addresses identify their devices. The
two client reads therefore carry the `personal_identifier` and `network_identity` tags. A
client must be granted both, for example
`unifi-mcp client create <id> --console <alias> --allow 'network.*.read' --sensitive personal_identifier --sensitive network_identity`.
Without them the reads are refused (`sensitive_scope_missing`) and not listed.

### What is never returned

- **Credentials.** Wi-Fi passphrases (including every entry of `presharedKeys`) and hotspot
  voucher codes are removed from every result, at any depth.
- **Undocumented fields.** Anything the console sends that the contract does not document
  is dropped, so a newer console cannot leak a new field.
- The console's own error text. Only the HTTP status and a documented error code are passed
  on.

## Writes

No write can run until every gate allows it ([security.md](security.md#making-writes-possible)):
the hard lock is off, the runtime mode is `read_write`, the console's `network` module is
`read_write`, and the client has a write grant such as `network.firewall.write`.

- **High risk** writes return `approval_required` and an `approvalId`. Nothing is sent to
  the console until a human approves on the host or in the admin interface; the same
  client then calls `unifi_resume_approved` ([approval-workflow.md](approval-workflow.md)).
- **Medium risk** writes run once the grants allow them.
- Writes that take a body get it as one `body` argument, next to the path arguments, for
  example `{ "networkId": "…", "body": { "management": "GATEWAY", … } }`.
  `unifi_describe_operation` shows the full schema.
- Pass an `idempotencyKey` to make a retry safe: the same key returns the first result and
  sends nothing again. A write whose connection broke after sending returns
  `outcome_unknown` and is never retried automatically; check the console first.
- A passphrase in a request (Wi-Fi) is sent to the console, but never logged, audited,
  shown to approvers or returned.

| Operation                                                                                                                                       | Risk                     | What it does                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `network.acl.create`, `network.acl.update`, `network.acl.delete`, `network.acl.update_ordering`                                                 | high                     | ACL rules and their order.                                                                                   |
| `network.firewall.create_policy`, `network.firewall.update_policy`, `network.firewall.delete_policy`, `network.firewall.update_policy_ordering` | high                     | Firewall policies and their order between two zones.                                                         |
| `network.firewall.patch_policy`                                                                                                                 | medium                   | Turns a policy's logging or flow reporting on or off; does not change what is allowed.                       |
| `network.firewall.create_zone`, `network.firewall.update_zone`, `network.firewall.delete_zone`                                                  | high                     | Firewall zones and their networks.                                                                           |
| `network.networks.create`, `network.networks.update`, `network.networks.delete`                                                                 | high                     | Networks and VLANs. `delete` with `force` deletes even while referenced.                                     |
| `network.wifi.create`, `network.wifi.update`, `network.wifi.delete`                                                                             | high                     | Wi-Fi broadcasts and their security settings.                                                                |
| `network.dns.create`, `network.dns.update`, `network.dns.delete`                                                                                | high                     | DNS policies. Local records can redirect any name for every client.                                          |
| `network.traffic_lists.create`                                                                                                                  | medium                   | A new traffic matching list; it changes nothing until a policy uses it.                                      |
| `network.traffic_lists.update`, `network.traffic_lists.delete`                                                                                  | high                     | Changes what the policies using the list match.                                                              |
| `network.devices.adopt`                                                                                                                         | high                     | Adopts a pending device by MAC address.                                                                      |
| `network.devices.remove`                                                                                                                        | high, **off by default** | Removes (forgets) a device, which resets it.                                                                 |
| `network.devices.run_action`                                                                                                                    | high                     | `RESTART` a device.                                                                                          |
| `network.devices.run_port_action`                                                                                                               | high                     | `POWER_CYCLE` a PoE port.                                                                                    |
| `network.clients.run_action`                                                                                                                    | medium                   | `AUTHORIZE_GUEST_ACCESS` or `UNAUTHORIZE_GUEST_ACCESS` for a client. Needs the client-data sensitive grants. |
| `network.hotspot.create_vouchers`                                                                                                               | medium                   | Creates vouchers. Their codes are not returned; print them from UniFi Network.                               |
| `network.hotspot.delete_voucher`                                                                                                                | medium                   | Deletes one voucher.                                                                                         |
| `network.hotspot.delete_vouchers`                                                                                                               | high, **off by default** | Deletes every voucher matching a filter, or all without one.                                                 |

Operations that are off by default must be listed in the global policy's
`enabledOperations` before any client can use them
([administration.md](administration.md)), and they still need approval.

None of these writes has a concurrency precondition in the contract (no version or ETag).
An approved write applies the approved arguments to whatever the console holds at that
moment, so review the current state before approving.

## Testing against a real console

### Read-only checks

`npm run test:live` runs every read against your console from a source checkout, and the
Protect reads as well ([applications-protect.md](applications-protect.md#testing-against-a-real-console)).
It is never part of `npm run check` or CI.

- Only the reads are registered in that process.
- A guard refuses anything that is not a GET.
- The hard lock is on, and the client can only read.
- It runs one documented Protect read with the same key, to learn whether a Network key
  also works for Protect (an open question, [ADR 0005](adr/0005-official-local-unifi-api-contracts.md)).
  The Protect contract declares no authentication, so it repeats the read with a random
  key as a control. Only if Protect accepts the real key and rejects the random one is
  the answer `yes`.

```sh
unifi-mcp console check <alias>          # shows the certificate pin
UNIFI_LIVE_HOST=<console address> \
UNIFI_LIVE_NETWORK_KEY_FILE=<file with the API key> \
UNIFI_LIVE_TLS_PIN=sha256/… \
UNIFI_LIVE_REPORT=docs/api-coverage/live/network-11.0.97.json \
npm run test:live
```

Instead of `UNIFI_LIVE_TLS_PIN` you can give `UNIFI_LIVE_CA_FILE` (a PEM file). Set
`UNIFI_LIVE_PORT` if the console does not use 443.

The test fails on any read that does not match the contract. Reads with nothing to read
(for example, no vouchers) are reported as skipped. A list that returns no items is
reported as `ok (empty)`: it matches the contract but checks no item, so the coverage
matrix does not count it as validated. A failure names its cause, for example
`tls_pin_mismatch` or `upstream_unauthorized`. For a response that does not match the
contract, the output and the report name the fields and the kind of mismatch
(`data[].name: invalid_type (expected string)`), never their values. The report folder is
created if it does not exist. Read the report before you commit it.

The report records only these facts:

- the outcome of each operation (`ok`, `ok (empty)`, skipped or the error code);
- the console's Network version;
- whether paging across two pages and a filter worked;
- whether the key also worked for Protect, with a random key as the control, and the
  Protect version it reported;
- for every network (up to 25), the network's kind (management, default, origin) and the
  results of reading its details and its references, with the fields of any contract
  mismatch.

It holds no names, addresses, ids or data. Read it, then commit it as
`docs/api-coverage/live/network-11.0.97.json` and run `npm run api:coverage-report`. The
coverage matrix then marks the reads that passed as live-validated.

The test was dry-run against the synthetic console (`tests/fixtures/serve-network-console.ts`).

### Writes

Validating writes on a real console is a manual runbook, approved step by step by you:
[runbook-network-writes.md](runbook-network-writes.md).

## Limitations

- **Device tag filter.** The contract documents the `filter` of `network.devices.list_tags`
  as an object rather than a string, so the service does not send it. Filter the result
  yourself, or page through it.
- **Required fields.** A console that omits a field the contract marks as required makes
  that read fail with `upstream_contract_mismatch`, rather than returning partial data.
  That includes a response of a documented type, for example a `GATEWAY` network, that
  lacks a field its type requires: it is refused, not returned without that type's fields.
  The service log names the fields ([troubleshooting.md](troubleshooting.md#the-console-answered-with-an-error-or-not-as-documented)).
  Please report it with the console version.
- **Network references fail for networks in use.** On a console running Network 11.0.99,
  `network.networks.get_references` returned HTTP 500 (`api.unexpected-error`) for 5 of
  10 networks, with requests of the same documented form. It failed for every network
  used by clients or devices: networks with clients, the one carrying the access points,
  and one with no clients that is assigned to switch ports. It worked for every network
  used only by a Wi-Fi broadcast, or by nothing. Assigning one unused switch port to an
  empty network that had answered normally made it fail as well. So a device reference
  alone is enough to make the read fail, and every network with clients failed too. The
  error says only "Unexpected error", and the console's logs show nothing; the cause is not
  known. The networks themselves read normally: with direct requests to the same console,
  `network.networks.list` returned all 10 networks and `network.networks.get` answered for
  each of them, those in use included (2026-11-12). Reading a network sends only that one
  request, so a failing references read never affects it. The service reports the
  references failure as `upstream_unavailable`, and retrying does not help. Before you
  change or delete a network, check what uses it in UniFi Network.
- **API key scope.** UniFi documents no way to limit what an API key can do, and a Network
  key also works for Protect on the same console (observed on Network 11.0.99,
  [ADR 0005](adr/0005-official-local-unifi-api-contracts.md#live-evidence-phase-2-2026-11-11)).
  Treat the key as an administrator credential for the whole console.
- Rate limits of the local API are not documented. The service limits its own request rate
  per client, console and module.
- **Voucher codes** are never returned, not even for new vouchers. An agent can create
  vouchers, but a person prints or reads the codes in UniFi Network.
- Writes are tested only against the synthetic console. Validating them against a real
  console is a manual, human-approved runbook, never part of CI.
