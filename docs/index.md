# unifi-local-mcp documentation

> **Project status: Phase 1 in progress (storage, telemetry, policy, dispatcher, approvals and UniFi transport done). Nothing is runnable yet.**
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

| Page                                                                                                 | Phase           |
| ---------------------------------------------------------------------------------------------------- | --------------- |
| [configuration.md](configuration.md) (hard lock, egress, data directory, logging, master key so far) | 1 (started)     |
| [backup-restore.md](backup-restore.md) (backup, restore, key rotation)                               | 1 (started)     |
| [monitoring.md](monitoring.md) (logs, audit trail, health; metrics in Phase 5)                       | 1 (started) / 5 |
| [security.md](security.md) (permissions, write safety, console connections so far)                   | 1 (started)     |
| quickstart.md, installation.md                                                                       | 1               |
| [approval-workflow.md](approval-workflow.md)                                                         | 1 (started)     |
| administration.md                                                                                    | 1               |
| client-claude-code.md, client-codex.md, client-generic-mcp.md                                        | 1               |
| networking.md (single and dual interface), troubleshooting.md                                        | 1 / 5           |
| applications-network.md                                                                              | 2               |
| applications-protect.md, events.md                                                                   | 3               |
| applications-access.md                                                                               | 4               |
| release.md, development.md                                                                           | 5               |

## Contributing

See [CONTRIBUTING.md](../CONTRIBUTING.md) and [AGENTS.md](../AGENTS.md).
