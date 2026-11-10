# Runbook: validating Network writes on a real console

> **Optional and manual.** Every Network write is tested automatically against a synthetic
> console ([applications-network.md](applications-network.md)). This runbook is for an
> administrator who also wants to see writes work against a real console. It is never
> part of CI, it is never automated, and every high-risk step is approved by you.

Writes change a real network. Use a lab console, or a site and a time where a mistake
harms no one. Read each step before you run it.

## Before you start

1. Take a UniFi backup of the console in UniFi Network (Settings, System, Backups).
2. Run the [read-only checks](applications-network.md#testing-against-a-real-console)
   first. They should all pass.
3. Note what you will change, and how you will undo it.

## Unlock, narrowly

Writes are locked at five levels ([security.md](security.md#making-writes-possible)).
Unlock only what this runbook needs, and only for as long as it takes.

```sh
# 1. Deployment: set UNIFI_MCP_FORCE_READ_ONLY: 'false' in compose.yml, then:
docker compose up -d
# 2-4. Service, module, and a client that can write only what you test:
docker compose exec unifi-mcp unifi-mcp policy set-runtime-mode read_write
docker compose exec unifi-mcp unifi-mcp console enable-module lab --module network --mode read_write
docker compose exec unifi-mcp unifi-mcp client create runbook --console lab \
  --allow 'network.*.read' --allow network.firewall.write \
  --allow network.traffic_lists.write --allow network.hotspot.write --allow network.dns.write \
  --token-expires 2026-12-31
```

Connect an MCP client with the `runbook` token ([client-generic-mcp.md](client-generic-mcp.md)),
or call `unifi_execute` from any MCP client.

## Steps, from least to most impact

Before each write, read the current state. After it, read again and compare. For high-risk
steps, the call returns `approval_required`. Check the summary with
`unifi-mcp approvals show <id>`, approve it with `unifi-mcp approvals approve <id>`, then
have the client call `unifi_resume_approved`.

| #   | Operation                         | Risk   | What to do                                                                                               | Undo           |
| --- | --------------------------------- | ------ | -------------------------------------------------------------------------------------------------------- | -------------- |
| 1   | `network.firewall.patch_policy`   | medium | Pick a test policy (`network.firewall.list_policies`) and switch `loggingEnabled`.                       | Patch it back. |
| 2   | `network.traffic_lists.create`    | medium | Create a port list nothing uses, for example name `runbook-test`, one port.                              | Step 4.        |
| 3   | `network.traffic_lists.update`    | high   | Change that list's port. Approve it.                                                                     | Step 4.        |
| 4   | `network.traffic_lists.delete`    | high   | Delete the list. Approve it.                                                                             | —              |
| 5   | `network.hotspot.create_vouchers` | medium | Create one voucher with a short time limit. The code is not returned; you see it in UniFi Network.       | Step 6.        |
| 6   | `network.hotspot.delete_voucher`  | medium | Delete that voucher.                                                                                     | —              |
| 7   | `network.dns.create`              | high   | Create a record for a name nobody uses, for example `runbook-test.home.arpa` → `192.0.2.10`. Approve it. | Step 8.        |
| 8   | `network.dns.delete`              | high   | Delete it. Approve it.                                                                                   | —              |

Check after each step:

- the result has `status` `ok` and `outcome` `succeeded`;
- `unifi-mcp audit list --limit 10` shows the request, the approval (for high risk) and
  the execution;
- the read afterwards shows the change. After the undo step, it is gone again.

Test idempotency once: repeat step 2 with the same `idempotencyKey`. The second call
returns the first result, and only one list exists.

Writes with larger effects (networks, Wi-Fi, ACL and firewall policies, device restarts
and adoption) are deliberately not in this runbook. Test them only on a lab console that
nobody depends on, in the same pattern: read, write, approve, read, undo.

## Lock again

```sh
docker compose exec unifi-mcp unifi-mcp client revoke runbook
docker compose exec unifi-mcp unifi-mcp console enable-module lab --module network --mode read_only
docker compose exec unifi-mcp unifi-mcp policy set-runtime-mode read_only
# Set UNIFI_MCP_FORCE_READ_ONLY: 'true' in compose.yml again, then:
docker compose up -d
```

## Reporting

If a step fails, report the operation id, the error `code`, the `outcome`, and the
console's Network version (`unifi-mcp console probe lab`). Do not include names, addresses,
tokens or keys.
