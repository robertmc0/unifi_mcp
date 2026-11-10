# Quickstart

> **Status: Phase 2 in progress.** The service, CLI, admin interface and container image
> work. The Network adapter is being added: so far an MCP client can list your consoles
> and modules and read the console's Network version (`network.info.get`). The other
> Network reads and writes follow.

The shortest safe path: one Docker host, the MCP endpoint on its loopback, and the hard
lock on. [installation.md](installation.md) explains each step.

## 1. Build and prepare

```sh
git clone <repository> unifi-local-mcp && cd unifi-local-mcp
docker build -t unifi-local-mcp:local .

mkdir -p ~/unifi-mcp && cp deploy/compose.single.yml ~/unifi-mcp/compose.yml && cd ~/unifi-mcp
mkdir -m 0700 data secrets
(umask 077 && openssl rand -base64 32 > secrets/unifi_mcp_master_key)
chmod 0400 secrets/unifi_mcp_master_key
```

Copy `secrets/unifi_mcp_master_key` somewhere safe and offline now. If your user id is
not 1000, set `UNIFI_MCP_UID` and `UNIFI_MCP_GID` in a `.env` file next to `compose.yml`.

## 2. Start

```sh
docker compose up -d
docker compose ps        # wait for (healthy)
```

## 3. Add your console

Create an API key in UniFi Network under _Integrations → Create New API Key_; it is
shown once. UniFi documents no way to limit what such a key can do, so treat it as an
administrator credential: the service keeps it encrypted, never shows it to clients, and
limits what each client can do with it ([ADR 0005](adr/0005-official-local-unifi-api-contracts.md)).
Then:

```sh
docker compose exec unifi-mcp unifi-mcp console add --alias home --host 192.0.2.1
docker compose exec unifi-mcp unifi-mcp console set-credential home --module network
docker compose exec unifi-mcp unifi-mcp console check home
```

`console check` shows the console's certificate and its `sha256/…` pin. If it is your
console's certificate, pin it and enable the module, read-only:

```sh
docker compose exec unifi-mcp unifi-mcp console set-tls home --tls pinned --pin sha256/…
docker compose exec unifi-mcp unifi-mcp console enable-module home --module network --mode read_only
docker compose exec unifi-mcp unifi-mcp console probe home
```

`console probe` shows the console's UniFi Network version and whether it is supported
(11.0.97 and later 11.x). The service checks it by itself as well.

If the host is outside the default private ranges, set `UNIFI_MCP_EGRESS_ALLOW_CIDRS` in
`compose.yml` ([configuration.md](configuration.md#egress-allowlist)).

## 4. Create a client and connect it

```sh
docker compose exec unifi-mcp unifi-mcp client create my-agent --console home --allow 'network.*.read'
```

The token is printed once. Store it in your MCP client's secret store and configure the
client for `http://127.0.0.1:3000/mcp` with `Authorization: Bearer <token>`, or start the
stdio bridge ([client-generic-mcp.md](client-generic-mcp.md)).

## 5. Check

```sh
docker compose exec unifi-mcp unifi-mcp doctor
```

Then ask your MCP client to list the UniFi consoles: it calls `unifi_list_consoles`.

## Next

- Writes stay impossible until you turn off the hard lock, switch the runtime mode to
  `read_write`, set the module to `read_write` **and** grant a client write scopes
  ([security.md](security.md#making-writes-possible)).
  High-risk writes then wait for your approval
  ([approval-workflow.md](approval-workflow.md)).
- Day-to-day administration: [administration.md](administration.md).
- Backups: [backup-restore.md](backup-restore.md).
