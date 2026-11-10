# unifi-local-mcp documentation

> **Project status: Phase 1 in progress. The service starts and serves MCP over HTTP and stdio,
> and is administered with the host-only `unifi-mcp` CLI; no UniFi operations are registered
> until the Network adapter (Phase 2).**
> See [phase-checklist.md](phase-checklist.md) for what is implemented and what is next.

## Design and decisions

- [Design specification](../unifi-mcp-design-spec.md): agreed scope, security model and acceptance criteria
- [Plan and phase checklist](phase-checklist.md)
- [Architecture Decision Records](adr/README.md)
- [Threat model (Phase 0 notes)](threat-model.md)

## UniFi API contracts

- [API sources, provenance and terms](../api-specs/README.md)
- [API coverage matrix](api-coverage/README.md): [Network 11.0.97](api-coverage/network/11.0.97.md),
  [Protect 7.3.74](api-coverage/protect/7.3.74.md), [Access 2026-03-23](api-coverage/access/2026-03-23.md)

## Operator manual (written with each phase)

| Page                                                                                                     | Phase           |
| -------------------------------------------------------------------------------------------------------- | --------------- |
| [configuration.md](configuration.md) (hard lock, listener, egress, data, logging, master key, retention) | 1 (started)     |
| [backup-restore.md](backup-restore.md) (backup, restore, key rotation)                                   | 1 (started)     |
| [monitoring.md](monitoring.md) (logs, audit trail, health; metrics in Phase 5)                           | 1 (started) / 5 |
| [security.md](security.md) (permissions, write safety, client tokens, console connections)               | 1 (started)     |
| [installation.md](installation.md) (Docker Compose, from source, maintenance, upgrades)                  | 1 (started)     |
| quickstart.md                                                                                            | 1               |
| [approval-workflow.md](approval-workflow.md)                                                             | 1 (started)     |
| [administration.md](administration.md) (the `unifi-mcp` CLI, bootstrap file, maintenance)                | 1 (started)     |
| [client-generic-mcp.md](client-generic-mcp.md) (HTTP and stdio connection, tools, results)               | 1 (started)     |
| client-claude-code.md, client-codex.md                                                                   | 1               |
| [networking.md](networking.md) (MCP listener, egress)                                                    | 1 (started) / 5 |
| troubleshooting.md                                                                                       | 1 / 5           |
| applications-network.md                                                                                  | 2               |
| applications-protect.md, events.md                                                                       | 3               |
| applications-access.md                                                                                   | 4               |
| release.md, development.md                                                                               | 5               |

## Contributing

See [CONTRIBUTING.md](../CONTRIBUTING.md) and [AGENTS.md](../AGENTS.md).
