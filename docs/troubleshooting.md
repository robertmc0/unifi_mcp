# Troubleshooting

> **Status: Phase 2 in progress.** Covers the service, the CLI, the admin interface,
> client connections and UniFi Network operations
> ([applications-network.md](applications-network.md)). Protect and Access follow with
> their adapters; metrics arrive in Phase 5.

## Start here

Inside the container, prefix each command with `docker compose exec unifi-mcp`. From a
source checkout, use `npm run unifi-mcp --` ([administration.md](administration.md)).

1. `unifi-mcp doctor` checks the configuration, master key, database, audit chain, policy,
   hard lock, listeners, egress, consoles, clients and disk space. Every line is `OK`,
   `WARN` or `FAIL`, with what to do next.
2. `docker compose ps` should show `(healthy)`, and `curl http://127.0.0.1:3000/readyz`
   should answer `{"status":"ready"}` ([monitoring.md](monitoring.md#health-checks)).
3. `docker compose logs unifi-mcp` shows the JSON runtime log.
4. `unifi-mcp audit list` shows what was refused and why. Filter it with `--event-type`,
   `--outcome denied` or `--actor <client-id>`.

None of these outputs contains a token, API key, password or the master key. They can
contain host names, addresses and console names, so read them before you share them.

## The service does not start

The log has one line `startup failed; the service will not start`, with a `code` and a
message. The process exits with code 1. With `restart: unless-stopped`, Docker keeps
restarting it, and each attempt logs the same line.

| Code or message                                                                                   | Cause                                                                                                                                                                                                           | Fix                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MASTER_KEY_UNREADABLE` with `(EACCES)`                                                           | In Docker: the container's user is not the owner of the key file                                                                                                                                                | Set `UNIFI_MCP_UID` and `UNIFI_MCP_GID` to the owner's `id -u` and `id -g` ([installation.md](installation.md#with-docker-compose)). Do not make the key readable by everyone.               |
| Other `MASTER_KEY_…`, `DATABASE_CORRUPT`, `SCHEMA_NEWER_THAN_SOFTWARE`, `MIGRATION_…`             | Key or database problems                                                                                                                                                                                        | See [configuration.md](configuration.md#startup-failures). Never generate a new key for an existing database.                                                                                |
| `EACCES` or `EROFS` on a path under `/data`                                                       | The data directory is not writable by the container's user, or it is mounted read-only                                                                                                                          | Make `data/` belong to that user (mode 0700), and mount it without `:ro`.                                                                                                                    |
| `DATA_DIRECTORY_IN_USE`                                                                           | Another service, or a maintenance command such as `crypto rotate-key` or `db restore`, is using the data directory                                                                                              | Only one service per data directory. Wait for the command or stop the other service.                                                                                                         |
| `EADDRINUSE`                                                                                      | The port is taken                                                                                                                                                                                               | Change `UNIFI_MCP_HTTP_PORT`, or the published port (`UNIFI_MCP_HTTP_HOST_PORT` in the Compose example).                                                                                     |
| `EACCES` on `listen`                                                                              | Ports below 1024 need privileges that the service does not have                                                                                                                                                 | Use a port from 1024 up and publish it as you need.                                                                                                                                          |
| `Refusing to accept client tokens over plaintext HTTP on …`                                       | A non-loopback bind without TLS                                                                                                                                                                                 | Configure TLS, bind to loopback, or, when a TLS proxy or loopback publishing protects the port, set `UNIFI_MCP_HTTP_ALLOW_PLAINTEXT=true` ([networking.md](networking.md#the-mcp-listener)). |
| Another `ConfigError`                                                                             | An invalid setting; the message names the variable                                                                                                                                                              | [configuration.md](configuration.md). `unifi-mcp config validate` checks the environment without starting the service.                                                                       |
| `ERR_INTERNAL_ASSERTION: memory access out of bounds` in `stripTypeScriptModuleTypes`, on `arm64` | The `linux/arm64` image runs under QEMU emulation on an `amd64` host. Node.js's TypeScript stripper fails there. This has been seen only under emulation ([ADR 0017](adr/0017-container-image-and-compose.md)). | Use the image that matches the host's architecture.                                                                                                                                          |

## Not ready or degraded

- `/readyz` answers `503 {"status":"not_ready"}` when the database cannot be used, the
  audit trail cannot be written, or less than 64 MiB is free on the data volume. The
  service refuses requests rather than act without an audit trail. `unifi-mcp doctor`
  shows which check failed.
- _Degraded_ (shown by `doctor` and the admin dashboard, never by `/readyz`) means a
  console is unreachable or less than 512 MiB is free. The service keeps serving.
- `console_versions` degraded: a console module's version probe fails. The detail names
  the console id and the error code (see [The console cannot be reached](#the-console-cannot-be-reached)).
  `unifi-mcp console probe <alias>` tries again at once and shows the error.

## A client cannot connect

| What the client gets                                                 | Cause                                                                                                                                                      | Fix                                                                                                                                                                                                      |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connection refused, or the connection is closed with no reply        | The service is not running or not ready yet, the port is wrong, or the port is published only on `127.0.0.1` and the client is on another machine          | `docker compose ps`; [networking.md](networking.md). Remote clients use the stdio bridge over SSH or a TLS reverse proxy.                                                                                |
| `401 {"error":"invalid_token"}`                                      | No token, a mistyped token, or a token that was revoked, rotated or expired, or whose client was revoked                                                   | `unifi-mcp audit list --event-type mcp.auth` shows `auth.token_missing` or `auth.token_rejected`. `unifi-mcp client show <id>` shows the client and its tokens; `client rotate <id>` issues a new token. |
| `429 {"error":"too_many_failed_authentications"}` with `Retry-After` | Repeated failures from this address: 10 at once, then one every 5 seconds                                                                                  | Fix the client's token, then wait.                                                                                                                                                                       |
| `403` with `Invalid Host: …`                                         | The client used a host name the service does not accept. This protects against DNS rebinding.                                                              | Add the name to `UNIFI_MCP_HTTP_ALLOWED_HOSTS` ([networking.md](networking.md#host-and-origin-checks)).                                                                                                  |
| `403` with `Invalid Origin: …`                                       | A browser-based client on an origin that is not allowed                                                                                                    | Add its host name to `UNIFI_MCP_HTTP_ALLOWED_ORIGINS`, only if you trust that page.                                                                                                                      |
| `404 {"error":"not_found"}`                                          | The URL path is not `/mcp`                                                                                                                                 | Use `http(s)://<host>:<port>/mcp`.                                                                                                                                                                       |
| Tools are missing                                                    | Clients see only what their policy allows. Write tools appear only with write permissions. 2025-era clients see permission changes only after reconnecting | `unifi-mcp client show <id>`; [client-generic-mcp.md](client-generic-mcp.md#tools).                                                                                                                      |

Client-specific steps: [client-claude-code.md](client-claude-code.md#problems) and
[client-generic-mcp.md](client-generic-mcp.md).

### The stdio bridge

The bridge writes its reasons to stderr. Run it yourself with the same variables and
`< /dev/null` to see them.

| Exit or reply                                                               | Meaning                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exit 2                                                                      | Invalid configuration, for example: `Set only one of UNIFI_MCP_TOKEN_FILE and UNIFI_MCP_TOKEN.`, `Cannot open UNIFI_MCP_TOKEN_FILE (ENOENT).`, `The client token is not in the umcp_<id>_<secret> format.`, or `Refusing to send the client token over plaintext HTTP to …`. |
| Exit 1                                                                      | The service rejected the token (revoked, rotated, expired or mistyped). The request in flight first gets JSON-RPC error `-32002` `The unifi-local-mcp service rejected the client token.`                                                                                    |
| JSON-RPC error `-32001` `The unifi-local-mcp service could not be reached.` | The bridge started but cannot reach `UNIFI_MCP_URL`.                                                                                                                                                                                                                         |

The bridge also refuses to start when the harness passes on a `UNIFI_MCP_TOKEN` variable
from its own environment while `UNIFI_MCP_TOKEN_FILE` is set. Use another variable name
for anything else that needs the token.

## A request is refused

A refused call returns `"status": "denied"` with the reason in `error.code`. The audit
trail records the same reason. [security.md](security.md#how-a-request-is-decided) explains
the order in which they are checked.

| `error.code`                                                                                                | Meaning                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `hard_read_only`                                                                                            | The deployment hard lock (`UNIFI_MCP_FORCE_READ_ONLY`) is on. It is on by default. See [security.md](security.md#making-writes-possible). |
| `runtime_read_only`                                                                                         | The runtime mode is `read_only` (`unifi-mcp policy set-runtime-mode`).                                                                    |
| `module_disabled`, `module_read_only`, `console_disabled`, `console_read_only`                              | The console or its module is off or read-only (`unifi-mcp console enable-module`, `console enable`).                                      |
| `console_not_permitted`, `site_not_permitted`, `not_granted_to_client`                                      | The client's policy does not include this console, site or operation (`unifi-mcp client show`).                                           |
| `target_required`, `site_required`                                                                          | The call must name a `consoleId` and, for site-scoped operations, a `siteId`. There is no default console.                                |
| `denied_by_global_policy`, `denied_by_console_policy`, `denied_by_module_policy`, `denied_by_client_policy` | A deny rule matched.                                                                                                                      |
| `sensitive_scope_missing`, `sensitive_denied_by_policy`                                                     | The operation returns sensitive data, which needs an explicit grant ([security.md](security.md#sensitive-data)).                          |
| `version_unknown`                                                                                           | The service has not yet learned the console's application version, so nothing runs. It checks automatically; try again shortly.           |
| `operation_unsupported`                                                                                     | The console's application version is outside the range the operation was verified for. The message names both.                            |
| `approval_required` (as `status`)                                                                           | Not a refusal: a human must approve it first ([approval-workflow.md](approval-workflow.md)).                                              |
| `approval_expired`, `approval_invalidated`, `approval_already_used`, `approval_not_found`                   | See [approval-workflow.md](approval-workflow.md#when-an-approval-stops-working).                                                          |

## The console cannot be reached

These come back as `"status": "error"` with `error.code`. `unifi-mcp console check <alias>`
tests reachability and TLS trust without sending a request or credential.

| `error.code`                                | Meaning and fix                                                                                                                                                                                                                                                                            |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `egress_denied`                             | The console's address is outside `UNIFI_MCP_EGRESS_ALLOW_CIDRS` ([configuration.md](configuration.md#egress-allowlist)).                                                                                                                                                                   |
| `dns_failed`                                | The console host name does not resolve from the service.                                                                                                                                                                                                                                   |
| `tls_pin_mismatch`                          | The console presented a certificate with a different key than the pinned one. That is expected after the console's certificate was replaced, and it is also what an interception looks like. Compare the pin with `console check` on a network you trust, then re-pin (`console set-tls`). |
| `tls_verification_failed`                   | In `verify` mode the certificate is not trusted (self-signed consoles usually are not). Pin it, or configure its CA ([security.md](security.md#connections-to-consoles)).                                                                                                                  |
| `connect_failed`, `connect_timeout`         | No route, a firewall, or the console is down.                                                                                                                                                                                                                                              |
| `credentials_missing`                       | No API key is stored for this module: `unifi-mcp console set-credential <alias> --module <module>`.                                                                                                                                                                                        |
| `credentials_unreadable`                    | The stored key cannot be decrypted. Run `unifi-mcp db check`, then store the key again.                                                                                                                                                                                                    |
| `upstream_unauthorized`                     | The console rejected the API key (HTTP 401 or 403). The key may have been deleted in UniFi. Store a new one.                                                                                                                                                                               |
| `upstream_rate_limited`, `upstream_timeout` | The console is busy or slow. Reads are retried with backoff. A write is retried only if it was never sent.                                                                                                                                                                                 |
| `outcome_unknown` (as `outcome` of a write) | The connection broke after the request was sent. The console may have applied the change. Check the console before trying again; it is never retried automatically.                                                                                                                        |

## Administration

| Problem                                                                                        | Fix                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crypto rotate-key` or `db restore` says `DATA_DIRECTORY_IN_USE`                               | Stop the service first, then use a one-off container ([installation.md](installation.md#maintenance-with-the-service-stopped)).                                                                                        |
| `needs confirmation`, or `Approving needs a human …`                                           | Run the command in an interactive terminal. Approvals cannot be scripted ([administration.md](administration.md#common-errors)).                                                                                       |
| The admin sign-in page loads, but signing in does nothing                                      | The session cookie is `Secure`. Browsers accept it over plain HTTP only for `localhost` or `127.0.0.1`. Use an SSH tunnel to a loopback address, or TLS ([networking.md](networking.md#the-admin-listener)).           |
| Sign-in keeps failing with the right password                                                  | 5 failures per user name or 20 per address in 15 minutes block sign-in, even with the right password, until the window passes. On the host, `unifi-mcp admin reset-password` also ends all of that account's sessions. |
| `403 Forbidden host.` or `Cross-origin form submissions are refused.` from the admin interface | The name in the browser's address bar is not allowed, or a proxy changes `Host` or `Origin`. Add the public host name to `UNIFI_MCP_ADMIN_ALLOWED_HOSTS`, and have the proxy pass both headers on unchanged.           |

## Asking for help

Include the release (or commit), how you run it (Compose, source), the output of
`unifi-mcp doctor`, and the relevant log lines. Never include a token, API key, password,
cookie or the master key, and remove host names and addresses you do not want to share.
Report security problems privately as described in [SECURITY.md](../SECURITY.md).
