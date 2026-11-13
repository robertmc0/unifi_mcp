# unifi-local-mcp documentation

> **Project status: Phase 1 (secure platform core), Phase 2 (UniFi Network) and Phase 3
> (UniFi Protect) complete; Phase 4 (UniFi Access) next. The service serves MCP over HTTP and stdio, is
> administered with the host-only `unifi-mcp` CLI, and implements all 73 documented UniFi
> Network operations and 73 of the 74 Protect 7.3.74 operations, including both event
> subscriptions, tested against synthetic consoles. Reads were also checked on a real
> console (Network 11.0.99, Protect 7.3.74).**
> See [phase-checklist.md](phase-checklist.md) for what is implemented and what is next.

## Design and decisions

- [Design specification](../unifi-mcp-design-spec.md): agreed scope, security model and acceptance criteria
- [Plan and phase checklist](phase-checklist.md)
- [Architecture Decision Records](adr/README.md)
- [Threat model (Phase 0 notes)](threat-model.md)

## UniFi API contracts

- [API sources, provenance and terms](../api-specs/README.md)
- [API coverage matrix](api-coverage/README.md): [Network 11.0.97](api-coverage/network/11.0.97.md),
  [Protect 7.3.74](api-coverage/protect/7.3.74.md), [Protect 7.4.96](api-coverage/protect/7.4.96.md), [Access 2026-03-23](api-coverage/access/2026-03-23.md)

## Operator manual (written with each phase)

| Page                                                                                                                | Phase           |
| ------------------------------------------------------------------------------------------------------------------- | --------------- |
| [configuration.md](configuration.md) (hard lock, listener, egress, data, logging, master key, retention)            | 1 (started)     |
| [backup-restore.md](backup-restore.md) (backup, restore, key rotation)                                              | 1 (started)     |
| [monitoring.md](monitoring.md) (logs, audit trail, health; metrics in Phase 5)                                      | 1 (started) / 5 |
| [security.md](security.md) (permissions, write safety, client tokens, console connections)                          | 1 (started)     |
| [installation.md](installation.md) (Docker Compose, from source, maintenance, upgrades)                             | 1 (started)     |
| [quickstart.md](quickstart.md) (one Docker host, loopback, hard lock on)                                            | 1               |
| [approval-workflow.md](approval-workflow.md)                                                                        | 1 (started)     |
| [administration.md](administration.md) (the `unifi-mcp` CLI, bootstrap file, maintenance)                           | 1 (started)     |
| [client-generic-mcp.md](client-generic-mcp.md) (HTTP and stdio connection, tools, results)                          | 1 (started)     |
| [client-claude-code.md](client-claude-code.md) (bridge and HTTP; verified with Claude Code 2.1.322)                 | 1               |
| client-codex.md                                                                                                     | 1               |
| [networking.md](networking.md) (MCP listener, egress)                                                               | 1 (started) / 5 |
| [troubleshooting.md](troubleshooting.md) (startup, connections, refusals, consoles, admin)                          | 1 / 5           |
| [applications-network.md](applications-network.md) (versions, reads, sensitive data, limitations)                   | 2 (started)     |
| [runbook-network-writes.md](runbook-network-writes.md) (optional manual write validation on a real console)         | 2               |
| [applications-protect.md](applications-protect.md) (versions, reads, events, writes, credentials, limitations)      | 3               |
| [runbook-protect-writes.md](runbook-protect-writes.md) (optional manual write validation on a real console)         | 3               |
| [events.md](events.md) (Protect events: subscriptions, reads, guarantees, reconnects, limits, troubleshooting)      | 3               |
| [applications-access.md](applications-access.md) (versions, setup, reads, sensitive data, credentials, limitations) | 4 (started)     |
| release.md, development.md                                                                                          | 5               |

## Contributing

See [CONTRIBUTING.md](../CONTRIBUTING.md) and [AGENTS.md](../AGENTS.md).
