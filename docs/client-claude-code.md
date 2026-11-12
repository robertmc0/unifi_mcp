# Connecting Claude Code

> **Verified with Claude Code 2.1.322 on Linux (2026-11-10)** against a Phase 1 test
> service, in a separate Claude Code configuration. Both ways below reached `✔ Connected`
> in `claude mcp list`. Claude Code negotiated the `2026-07-28` protocol revision, and
> its health check fetched the tool list. Using the tools in a Claude Code session was
> not part of that check. Since then the Network operations were added
> ([applications-network.md](applications-network.md)); they appear in the same tool list
> and were not part of that check either.

Claude Code needs a **client token** for this service. It never gets a UniFi API key:
those stay inside the service.

## Before you start

1. On the service host, create a client for this machine with only the permissions it
   needs ([administration.md](administration.md)):

   ```sh
   docker compose exec unifi-mcp unifi-mcp client create claude-code-laptop --console home --allow 'network.*.read'
   ```

   Add `--sensitive personal_identifier --sensitive network_identity` only if Claude should
   see connected clients (their names and addresses).

2. On the machine where Claude Code runs, save the token in a file only you can read.
   `cat` reads the pasted token, so it stays out of your shell history:

   ```sh
   mkdir -p -m 0700 ~/.config/unifi-mcp
   (umask 077 && cat > ~/.config/unifi-mcp/token)   # paste the token, press Enter, then Ctrl+D
   ```

3. Choose how Claude Code connects:
   - **Through the stdio bridge** (recommended). The token stays in the file, and only
     the bridge reads it.
   - **Over HTTP directly**. The token has to be in an environment variable of the
     shell that starts `claude`.

## Through the stdio bridge (recommended)

The bridge is part of this repository (ADR 0014). It needs Node.js 26 and a checkout of
the repository on the Claude Code machine:

```sh
claude mcp add --scope user unifi \
  -e UNIFI_MCP_URL=http://127.0.0.1:3000/mcp \
  -e UNIFI_MCP_TOKEN_FILE="$HOME/.config/unifi-mcp/token" \
  -- /path/to/node /path/to/unifi-local-mcp/packages/stdio-bridge/src/main.ts
```

- Give the **absolute path of a Node.js 26 binary**: `command -v node` prints it while
  Node 26 is active. Claude Code starts the bridge itself, so a version manager's default
  may be an older Node.js that cannot run it.
- `UNIFI_MCP_URL` may use `http://` only for a loopback address. For a service on another
  machine, use `https://…` or an SSH tunnel ([networking.md](networking.md)).
- Without Node.js, the bridge can run from the service image (`docker run -i`, see
  [client-generic-mcp.md](client-generic-mcp.md#connecting-over-stdio)). Put the
  `docker` arguments after `--` in the same way. That variant was tested with the MCP SDK
  client, not with Claude Code.

## Over HTTP directly

```sh
claude mcp add --scope user --transport http unifi http://127.0.0.1:3000/mcp \
  --header 'Authorization: Bearer ${UNIFI_MCP_CLIENT_TOKEN}'
```

- Keep the **single quotes**. Claude Code then stores the `${UNIFI_MCP_CLIENT_TOKEN}`
  reference, not the token, and fills it in each time it connects.
- Set the variable in the environment you start `claude` from, for example:
  `export UNIFI_MCP_CLIENT_TOKEN="$(cat ~/.config/unifi-mcp/token)"`.
- If the variable is not set, Claude Code warns
  `Missing environment variables: UNIFI_MCP_CLIENT_TOKEN`, and the service refuses the
  connection with HTTP 401 (audited as `auth.token_missing`).
- **Do not call the variable `UNIFI_MCP_TOKEN`.** Claude Code passes its environment to
  stdio servers, and the bridge refuses to start when both `UNIFI_MCP_TOKEN` and
  `UNIFI_MCP_TOKEN_FILE` are set. This was observed with the configuration above.
- Every process Claude Code starts inherits the variable. That is why the bridge is
  recommended.

## Scopes

| `--scope`         | Stored in                                        | Use                                                                                                                                                                                                |
| ----------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `local` (default) | Your Claude Code configuration, for this project | Only you, only this project                                                                                                                                                                        |
| `user`            | Your Claude Code configuration                   | Only you, all your projects                                                                                                                                                                        |
| `project`         | `.mcp.json` in the repository                    | Shared with everyone using the repository. It must contain `${…}` references only, never a token. Claude Code shows such a server as `⏸ Pending approval` until each user approves it in `claude`. |

A shared `.mcp.json` for the HTTP variant:

```json
{
  "mcpServers": {
    "unifi": {
      "type": "http",
      "url": "http://127.0.0.1:3000/mcp",
      "headers": { "Authorization": "Bearer ${UNIFI_MCP_CLIENT_TOKEN}" }
    }
  }
}
```

Each user still needs their own client token. Only the reference is shared.

## Checking the connection

```sh
claude mcp list
```

`unifi: … - ✔ Connected` means the token was accepted. This health check also fetches the
tool list. `claude mcp get unifi` shows the configuration. It shows
`${UNIFI_MCP_CLIENT_TOKEN}` as written, not the token.

In a Claude Code session, `/mcp` shows the server. Ask Claude to list your UniFi consoles,
and it calls `unifi_list_consoles`. A read-only client sees five tools:
`unifi_list_consoles`, `unifi_list_modules`, `unifi_list_operations`,
`unifi_describe_operation` and `unifi_execute`. Clients with write permissions also see
`unifi_get_operation_status` and `unifi_resume_approved`. Once a console's Network
version is known, the named tools a client may use are listed too (`network_list_sites`,
`network_list_devices`, `network_get_device`, `network_list_networks`, and
`network_list_clients` with the client-data grants). When you change a
client's permissions, Claude Code (2026 revision) sees the new tool list on its next
request ([client-generic-mcp.md](client-generic-mcp.md)).

## What Claude Code can do with the token

- Claude Code runs commands as your user, so it can read anything you can, including the
  token file or variable. What limits the token is its **client policy** on the service.
  Grant only what this machine needs, and give each machine its own token.
- The token cannot approve anything. High-risk requests wait for a human, who approves
  them on the service host or in the admin interface
  ([approval-workflow.md](approval-workflow.md)).
- Revoking stops it at once, and open connections close within 5 seconds:
  `unifi-mcp client revoke claude-code-laptop`. `client rotate` issues a new token; put it
  in the token file.
- Device names, labels and event text from consoles are untrusted data. The service
  returns them as data. If such text looks like instructions, Claude Code should not
  follow them.
- Event resources ([events.md](events.md)) have not been verified with Claude Code yet:
  whether it lists, reads or subscribes to them. The tools work without them.

## Problems

| What you see                                                                           | Cause and fix                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `✘ Failed to connect — Server rejected the configured Authorization header (HTTP 401)` | The variable is not set, the token is wrong, or the client was revoked or its token expired or was rotated. On the service host, `unifi-mcp audit list --event-type mcp.auth` shows `auth.token_missing` or `auth.token_rejected`; `unifi-mcp client show <id>` shows the client's state. |
| `Missing environment variables: …`                                                     | Set the variable in the shell that starts `claude`.                                                                                                                                                                                                                                       |
| `✘ Failed to connect — CONNECTION_CLOSED` (bridge)                                     | The bridge exited. Run the same command yourself with the same variables and `< /dev/null`. It prints the reason on stderr and exits 2 for a configuration error, for example both token variables set, a missing token file, or `http://` to another host.                               |
| `⏸ Pending approval`                                                                   | A `.mcp.json` server not yet approved. Start `claude` in the project and approve it.                                                                                                                                                                                                      |
| HTTP 429                                                                               | Too many failed authentications from this address (10 at once, then one per 5 seconds). Fix the token and wait.                                                                                                                                                                           |

More in [troubleshooting.md](troubleshooting.md).

## Removing it

```sh
claude mcp remove unifi --scope user
```

Then revoke the client on the service host and delete `~/.config/unifi-mcp/token`.
