# Installation

> **Status: Phase 1 in progress.** The container image and the single-host Compose example
> are implemented and tested on `linux/amd64` ([ADR 0017](adr/0017-container-image-and-compose.md)).
> `linux/arm64` is not yet verified. Images are built locally; no registry images are
> published yet. Dual-network and TLS Compose examples are Phase 5.

## Requirements

- Docker Engine with Compose v2, or Node.js 26.13.0+ (26.x LTS) to run from source.
- A local filesystem for the data directory, not NFS or SMB.
- Network access from the service to your UniFi consoles' local API ports (LAN or VPN).
  The service never needs internet access.

## With Docker Compose

1. Get the repository and build the image:

   ```sh
   git clone <repository> unifi-local-mcp && cd unifi-local-mcp
   docker build -t unifi-local-mcp:local .
   ```

2. Create a deployment directory with the example file, a data directory and the master
   key:

   ```sh
   mkdir -p ~/unifi-mcp && cp deploy/compose.single.yml ~/unifi-mcp/compose.yml
   cd ~/unifi-mcp
   mkdir -m 0700 data secrets
   (umask 077 && openssl rand -base64 32 > secrets/unifi_mcp_master_key)
   chmod 0400 secrets/unifi_mcp_master_key
   ```

   **Back up the key file now**, separately from the data directory. Without it, stored
   credentials cannot be recovered ([backup-restore.md](backup-restore.md)).

3. If your user id is not 1000, set it for Compose: put `UNIFI_MCP_UID` and
   `UNIFI_MCP_GID` in a `.env` file next to `compose.yml`, using the values from `id -u`
   and `id -g`. The container runs as the user who owns `data/` and the key file.
4. Start it and check that it is healthy:

   ```sh
   docker compose up -d
   docker compose ps                # STATUS shows (healthy)
   curl http://127.0.0.1:3000/readyz
   ```

5. Configure it with the CLI inside the container ([administration.md](administration.md)):

   ```sh
   docker compose exec unifi-mcp unifi-mcp doctor
   docker compose exec unifi-mcp unifi-mcp console add --alias home --host 192.0.2.1
   docker compose exec unifi-mcp unifi-mcp console set-credential home --module network
   docker compose exec unifi-mcp unifi-mcp client create claude-code-laptop --console home --allow 'network.*.read'
   ```

   `set-credential` asks for the API key at a hidden prompt. To read it from a file
   instead, mount the file into the container and pass `--key-file`.

6. Connect an MCP client ([client-generic-mcp.md](client-generic-mcp.md)).

What the example does:

- The MCP endpoint is published on the host's loopback only (`127.0.0.1:3000`).
- The root filesystem is read-only, all Linux capabilities are dropped, and privilege
  escalation is blocked.
- The **hard lock is on**: no write can run until you set
  `UNIFI_MCP_FORCE_READ_ONLY: 'false'` in `compose.yml` and restart.
- The admin web interface is off. To use it, set `UNIFI_MCP_ADMIN_ENABLED: 'true'`,
  uncomment the `3001` port line (it stays on the host loopback), and create an
  administrator with
  `docker compose exec unifi-mcp unifi-mcp admin bootstrap --username <name>`.
  See [networking.md](networking.md#the-admin-listener).
- Other machines cannot reach the service as configured. Use the stdio bridge over SSH,
  or put a TLS reverse proxy in front ([networking.md](networking.md)).

### Maintenance with the service stopped

Master key rotation and restore refuse to run while the service runs. Stop it, then use a
one-off container with the same volumes:

```sh
docker compose stop unifi-mcp
docker compose run --rm --no-deps --entrypoint unifi-mcp unifi-mcp db restore /data/backups/<file>.db
docker compose start unifi-mcp
```

Backups (`db backup`) and checks (`db check`) work with `exec` while the service runs. A
backup written to `/data/backups/` inside the container is in `data/backups/` on the host.

### Upgrading

1. Take a backup: `docker compose exec unifi-mcp unifi-mcp db backup`.
2. Build the new image (`git pull && docker build -t unifi-local-mcp:local .`).
3. `docker compose up -d`. If the database schema changed, the service writes a
   pre-migration backup and then upgrades the database. If anything fails, it does not
   start and the database is unchanged ([backup-restore.md](backup-restore.md)).

### Logs and health

- `docker compose logs unifi-mcp` shows the JSON runtime log. Logs are rotated: 3 files of
  10 MB.
- Docker's health check probes `/livez`. Use `/readyz` for proxies and monitoring
  ([monitoring.md](monitoring.md)).

## From source

```sh
npm ci
npm run unifi-mcp -- crypto generate-key --out secrets/unifi_mcp_master_key
export UNIFI_MCP_DATA_DIR=$PWD/data UNIFI_MCP_MASTER_KEY_FILE=$PWD/secrets/unifi_mcp_master_key
node packages/mcp-server/src/main.ts
```

The CLI is `npm run unifi-mcp -- <command>` with the same environment. Never use
`npx unifi-mcp`: that name on npm belongs to an unrelated package. Stop the service with
Ctrl+C or SIGTERM, and it shuts down cleanly.

## Uninstalling

`docker compose down` stops and removes the container. `data/` holds the database with
the encrypted credentials and the audit trail, and `secrets/` holds the master key. Delete
them yourself once you no longer need them. Also revoke the UniFi API keys you gave the
service.
