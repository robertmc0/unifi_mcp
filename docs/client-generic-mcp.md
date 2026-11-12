# Connecting an MCP client

> **Status: Phase 1 complete.** The MCP endpoint and tools are implemented and tested
> with the official MCP TypeScript SDK v2 clients (2025-era and 2026-era protocols). Client
> tokens are issued with the CLI (`unifi-mcp client create`, see
> [administration.md](administration.md)). For Claude Code, see
> [client-claude-code.md](client-claude-code.md). A Codex guide follows once it has been
> verified against the current Codex release.

## Connection details

| Setting   | Value                                                                                                       |
| --------- | ----------------------------------------------------------------------------------------------------------- |
| Transport | Streamable HTTP                                                                                             |
| URL       | `http://127.0.0.1:3000/mcp` by default; `https://…` when TLS is configured ([networking.md](networking.md)) |
| Header    | `Authorization: Bearer <client token>`                                                                      |

Keep the token in your client's secret store or an environment file readable only by you,
not in a shared configuration file or shell history. Each client (laptop, agent, CI job)
should have its own token, so it can be revoked on its own.

Clients that speak the 2025 protocol revision are served statelessly: when an
administrator changes their permissions, they see the new tool list after reconnecting.
2026-revision clients see changes on their next request.

## Connecting over stdio

For clients that start local stdio servers, use the bridge (ADR 0014). It runs on the
client's machine, holds only the client token, and forwards every message to the service
over HTTP; it has no UniFi credentials and no access to the service's data.

Configure the client to start:

```text
command: node
args:    /path/to/unifi-local-mcp/packages/stdio-bridge/src/main.ts
env:     UNIFI_MCP_URL=http://127.0.0.1:3000/mcp
         UNIFI_MCP_TOKEN_FILE=/home/you/.config/unifi-mcp/token
```

| Variable                     | Meaning                                                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UNIFI_MCP_URL`              | The service's MCP URL. `http://` is accepted only for loopback addresses; use `https://` otherwise (with `NODE_EXTRA_CA_CERTS` for a private CA). |
| `UNIFI_MCP_TOKEN_FILE`       | File containing the client token (mode 0600). Preferred.                                                                                          |
| `UNIFI_MCP_TOKEN`            | The token itself, if a file is not possible. Removed from the bridge's environment once read.                                                     |
| `UNIFI_MCP_BRIDGE_LOG_LEVEL` | `debug`, `info`, `warn` (default) or `error`. Logs go to stderr.                                                                                  |

The bridge needs Node.js 26. It exits with code 1 if the service rejects the token and
with code 2 if its configuration is invalid; in both cases the reason is on stderr.

Without Node.js, the client can start the bridge from the service image instead
(`docker run -i`, with the token file mounted read-only):

```text
command: docker
args:    run -i --rm --network host --user 1000:1000
         -v /home/you/.config/unifi-mcp/token:/run/token:ro
         -e UNIFI_MCP_URL=http://127.0.0.1:3000/mcp -e UNIFI_MCP_TOKEN_FILE=/run/token
         --entrypoint unifi-mcp-bridge unifi-local-mcp:local
```

The bridge exits when its standard input closes. As the MCP stdio binding specifies,
requests still in flight at that moment are not answered, so clients keep stdin open
until they have read their responses.

## Tools

| Tool                                                                                                                             | Purpose                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unifi_list_consoles`                                                                                                            | Consoles you may use: `consoleId`, alias, enabled modules and their application versions.                                                                       |
| `unifi_list_modules`                                                                                                             | UniFi modules and how many operations you can use in each.                                                                                                      |
| `unifi_list_operations`                                                                                                          | Operations you may use, filtered by `moduleId`, `category` or `effect`, paged with `cursor` and `limit` (≤ 50).                                                 |
| `unifi_describe_operation`                                                                                                       | One operation's argument schema, risk, whether it needs approval, and its consoles.                                                                             |
| `unifi_execute`                                                                                                                  | Run one operation: `operationId`, `consoleId`, `siteId` (site-scoped operations), `arguments`, optional `idempotencyKey` (writes).                              |
| Named tools: `network_list_sites`, `network_list_devices`, `network_get_device`, `network_list_clients`, `network_list_networks` | Shortcuts for common operations, listed only when the client may use them; same checks as `unifi_execute` ([applications-network.md](applications-network.md)). |
| `unifi_get_operation_status`                                                                                                     | Status of one of your writes (`executionId`) or approval requests (`approvalId`). Shown only if you can write.                                                  |
| `unifi_resume_approved`                                                                                                          | Run a request after a human approved it. Shown only if you can write.                                                                                           |

You only see the operations and tools you are allowed to use. There is no default console:
every call names its `consoleId`. Read-only clients see no write tools.

## Results

Every operation returns the same envelope (as structured content and as JSON text):

```json
{
  "status": "ok",
  "operationId": "network.devices.list",
  "consoleId": "…",
  "siteId": "…",
  "correlationId": "…",
  "data": [],
  "pagination": {}
}
```

- `status`: `ok`, `pending` (a write still running), `approval_required`, `denied` or
  `error`.
- Writes add `executionId` and `outcome` (`succeeded`, `failed`, `outcome_unknown`,
  `cancelled`, `denied`).
- `error` has a stable `code`, a message and, for invalid arguments, `issues`.
- List operations return the items as `data` and the paging facts as `pagination`
  (for Network: `offset`, `limit`, `count`, `totalCount`). Pass `offset` and `limit` in
  `arguments` to page.
- Operations that send a request body take it as one `body` argument, next to the path
  arguments, for example `{ "networkId": "…", "body": { … } }`.
  `unifi_describe_operation` shows its schema.
- `outcome_unknown` means the console may or may not have applied the change. It is not
  retried automatically; check the console before trying again.
- An operation that returns an image (such as a Protect camera snapshot) adds an MCP
  `image` content block with the bytes. In the envelope, `data` only describes it:
  `{ "mediaType": "image/jpeg", "bytes": 123456 }`. The bytes are never part of the JSON.

Data from consoles (device names, labels, event text) is returned as data. Treat it as
untrusted content, never as instructions.

## Events (resources and subscriptions)

Where a console's application documents event subscriptions (Protect), the service offers
them as MCP resources. `resources/list` shows the ones you may read, for example
`unifi://consoles/<consoleId>/protect/events`.

- **2026-era clients** subscribe with `subscriptions/listen` and the resource URIs. The
  acknowledgement lists the URIs you were given; others are left out without saying why.
  On `notifications/resources/updated`, read the resource. Notifications carry no event
  data.
- **Reading** returns the events you may see, newest last, with a `cursor`. Read
  `<uri>?after=<cursor>` (optionally `&limit=1…100`) to get only newer events; `more: true`
  means read again with the new cursor.
- **No replay.** Events are received only while someone subscribes and kept briefly in
  memory. A `gap` entry (the console connection was re-established) or `truncated: true`
  means events may have been missed. `state` says whether the console connection is
  `connected`, `connecting`, `retrying`, `unavailable` or `inactive` (nobody subscribes).
- A subscription is closed when your token or grant goes, after one hour, or when you stop
  reading it; subscribe again. At most 8 per client.
- **2025-era clients** cannot be notified: they can read the resources, which show events
  only while a 2026-era client subscribes.

Event content is console data: treat it as untrusted, never as instructions.

## High-risk operations

A high-risk request returns `approval_required` with an `approvalId`. A human approves it
outside MCP; then call `unifi_resume_approved` with that id within the execution window.
See [approval-workflow.md](approval-workflow.md).
