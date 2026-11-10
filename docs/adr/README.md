# Architecture Decision Records

ADRs record decisions not already fixed by `unifi-mcp-design-spec.md`. They also record any
evidence-backed deviation from the spec (spec §20, "Final change-control rule"). The process
is defined in [ADR 0001](0001-record-architecture-decisions.md).

| ADR                                                         | Title                                                                            | Status                                   |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------- |
| [0001](0001-record-architecture-decisions.md)               | Record architecture decisions                                                    | Accepted                                 |
| [0002](0002-runtime-and-toolchain.md)                       | Runtime and toolchain: Node.js 26 LTS, TypeScript 6, npm workspaces              | Accepted                                 |
| [0003](0003-mcp-sdk-v2-and-protocol-eras.md)                | MCP TypeScript SDK v2 and protocol-era support                                   | Accepted (bridge design settled in 0014) |
| [0004](0004-sqlite-driver.md)                               | SQLite driver: built-in `node:sqlite` behind a storage port                      | Accepted, re-evaluate at Phase 1 exit    |
| [0005](0005-official-local-unifi-api-contracts.md)          | Official local UniFi API contracts and module eligibility                        | Accepted                                 |
| [0006](0006-vendor-api-artefact-handling.md)                | Vendor API artefacts: reference, verify, do not redistribute                     | Accepted                                 |
| [0007](0007-storage-encryption-migrations-backups.md)       | Storage: secret encryption, master key handling, migrations and backups          | Accepted                                 |
| [0008](0008-telemetry-logging-audit-health.md)              | Telemetry: structured logs, redaction, audit trail and health checks             | Accepted                                 |
| [0009](0009-policy-evaluation-model.md)                     | Policy evaluation model, policy schemas and the policy version                   | Accepted                                 |
| [0010](0010-operation-registry-and-dispatcher.md)           | Operation registry and the central dispatcher                                    | Accepted                                 |
| [0011](0011-human-approval-workflow.md)                     | Human approval workflow for high-risk operations                                 | Accepted                                 |
| [0012](0012-unifi-transport-egress-and-console-registry.md) | UniFi transport, egress control and the console registry                         | Accepted                                 |
| [0013](0013-mcp-server-tokens-gate-and-tools.md)            | MCP server: client tokens, the HTTP gate, the tool set and the service lifecycle | Accepted                                 |
| [0014](0014-stdio-bridge-transport-relay.md)                | stdio bridge: a message relay with one client token                              | Accepted                                 |
| [0015](0015-host-administration-cli.md)                     | Host administration CLI, administrator accounts and the data-directory lock      | Accepted                                 |
| [0016](0016-admin-listener-sessions-and-ui.md)              | Admin web listener, sessions and a server-rendered interface                     | Accepted                                 |
| [0017](0017-container-image-and-compose.md)                 | Container image, Compose example and basic CI                                    | Accepted                                 |

## Template

```markdown
# NNNN. Title

- Status: Proposed | Accepted | Superseded by NNNN | Deprecated
- Date: YYYY-MM-DD
- Phase: N
- Spec references: §x.y

## Context

## Decision

## Evidence

## Consequences

## Re-evaluation triggers
```
