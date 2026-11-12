# Runbook: validating Protect writes on a real console

> **Optional and manual.** Every Protect write is tested automatically against a synthetic
> console ([applications-protect.md](applications-protect.md#writes)). This runbook is for
> an administrator who also wants to see writes work against a real console. It is never
> part of CI, it is never automated, and every high-risk step is approved by you.

Protect writes change physical security: what is recorded, what raises an alarm, what a
siren or relay does. Use a lab console, or a time where a mistake harms no one. Read each
step before you run it.

## Before you start

1. Take a backup of the console.
2. Run the [read-only checks](applications-protect.md#testing-against-a-real-console)
   first. They should all pass.
3. Note what you will change, and how you will undo it.

Part A needs no Protect devices. Part B needs at least one adopted device of the kind it
names; skip the steps for kinds you do not have.

## Unlock, narrowly

Writes are locked at five levels ([security.md](security.md#making-writes-possible)).
Unlock only what this runbook needs, and only for as long as it takes.

```sh
# 1. Deployment: set UNIFI_MCP_FORCE_READ_ONLY: 'false' in compose.yml, then:
docker compose up -d
# 2-4. Service, module, and a client that can write only what you test:
docker compose exec unifi-mcp unifi-mcp policy set-runtime-mode read_write
docker compose exec unifi-mcp unifi-mcp console enable-module lab --module protect --mode read_write
docker compose exec unifi-mcp unifi-mcp client create runbook --console lab \
  --allow 'protect.*.read' --allow protect.alarm.write \
  --token-expires 2026-12-31
```

For part B, add only the grants of the steps you run, for example
`--allow protect.lights.write --allow protect.cameras.write`.

Connect an MCP client with the `runbook` token ([client-generic-mcp.md](client-generic-mcp.md)),
or call `unifi_execute` from any MCP client. Protect has no sites: leave `siteId` out.

Before each write, read the current state. After it, read again and compare. For high-risk
steps, the call returns `approval_required`. Check the summary with
`unifi-mcp approvals show <id>`, approve it with `unifi-mcp approvals approve <id>`, then
have the client call `unifi_resume_approved`.

## Part A: an arm profile (no devices needed)

An arm profile without schedules or automations arms nothing by itself. The steps create
one, change it, and delete it; the alarm manager is never armed, and the selected profile
is never changed.

| #   | Operation                          | Risk | What to do                                                                                                                                          | Undo    |
| --- | ---------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 1   | `protect.alarm.list_arm_profiles`  | low  | Note the profiles that exist.                                                                                                                       | —       |
| 2   | `protect.alarm.create_arm_profile` | high | `body`: `{"name": "runbook-test", "automations": [], "schedules": [], "recordEverything": false, "activationDelay": 0}`. Approve it. Note its `id`. | Step 5. |
| 3   | `protect.alarm.update_arm_profile` | high | Rename it: `id`, `body`: `{"name": "runbook-test-2"}`. Approve it.                                                                                  | Step 5. |
| 4   | `protect.alarm.delete_arm_profile` | high | Ask to delete it, then **reject** the approval (`unifi-mcp approvals reject <id>`). The profile is still there.                                     | —       |
| 5   | `protect.alarm.delete_arm_profile` | high | Delete it again, and approve this time.                                                                                                             | —       |

Two more checks in this part:

- After step 2 succeeded, have the client call `unifi_resume_approved` with the same
  approval again. It returns `approval_already_used`, and only one profile exists.
- After step 4, `unifi_resume_approved` returns `approval_rejected`, and nothing was sent
  to the console (`unifi-mcp audit list --limit 10`).

Leave out `protect.alarm.update_settings`: it selects the profile the alarm manager arms
with. A 7.3.74 console may not report the current selection
([ADR 0019 §8](adr/0019-protect-adapter.md#8-live-evidence-2026-11-12-and-a-reviewed-response-exception)),
so it could not be put back reliably.

## Part B: devices

Renames are the least intrusive device writes: they change nothing a camera records or an
alarm does. Read the device first (`protect.lights.get`, `protect.cameras.get`) and note
its name.

| #   | Operation                              | Risk   | What to do                                                                                                                                   | Undo            |
| --- | -------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| 6   | `protect.lights.update`                | medium | Rename a floodlight: `id`, `body`: `{"name": "runbook-test"}`.                                                                               | Rename it back. |
| 7   | `protect.cameras.update`               | high   | Rename a camera the same way. Approve it.                                                                                                    | Rename it back. |
| 8   | `protect.cameras.create_rtsps_streams` | medium | Pick a quality `protect.cameras.get_rtsps_streams` shows as `false`: `body`: `{"qualities": ["low"]}`. The result shows `true`, never a URL. | Step 9.         |
| 9   | `protect.cameras.delete_rtsps_streams` | medium | `id`, `qualities`: `["low"]`. The quality is `false` again.                                                                                  | —               |

Check the device stream once, with a client that supports subscriptions: subscribe to
`unifi://consoles/<consoleId>/protect/devices` ([applications-protect.md](applications-protect.md#events))
before step 6, and read it after. It shows a `light_update` with the new name.

Test idempotency once: repeat step 6 with the same `idempotencyKey`. The second call
returns the first result, and the console is not asked again.

## Check after each step

- the result has `status` `ok` and `outcome` `succeeded`;
- `unifi-mcp audit list --limit 10` shows the request, the approval (for high risk) and
  the execution;
- the read afterwards shows the change. After the undo step, it is gone again.

Writes with larger effects are deliberately not in this runbook: arming and disarming,
alarm settings and webhooks, sirens, relays and alarm hub outputs, sensor and fob
settings, PTZ moves, talkback and the permanent microphone disable (which cannot be
undone). Test them only on a lab console that nobody depends on, in the same pattern:
read, write, approve, read, undo.

## Lock again

```sh
docker compose exec unifi-mcp unifi-mcp client revoke runbook
docker compose exec unifi-mcp unifi-mcp console enable-module lab --module protect --mode read_only
docker compose exec unifi-mcp unifi-mcp policy set-runtime-mode read_only
# Set UNIFI_MCP_FORCE_READ_ONLY: 'true' in compose.yml again, then:
docker compose up -d
```

## Reporting

If a step fails, report the operation id, the error `code`, the `outcome`, and the
console's Protect version (`unifi-mcp console probe lab --module protect`). Do not include
names, addresses, ids, tokens or keys.
