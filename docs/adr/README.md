# Architecture Decision Records

ADRs record decisions not already fixed by `unifi-mcp-design-spec.md`. They also record any
evidence-backed deviation from the spec (spec §20, "Final change-control rule"). The process
is defined in [ADR 0001](0001-record-architecture-decisions.md).

| ADR                                                   | Title                                                                   | Status                                   |
| ----------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------- |
| [0001](0001-record-architecture-decisions.md)         | Record architecture decisions                                           | Accepted                                 |
| [0002](0002-runtime-and-toolchain.md)                 | Runtime and toolchain: Node.js 26 LTS, TypeScript 6, npm workspaces     | Accepted                                 |
| [0003](0003-mcp-sdk-v2-and-protocol-eras.md)          | MCP TypeScript SDK v2 and protocol-era support                          | Accepted (stdio bridge design: Proposed) |
| [0004](0004-sqlite-driver.md)                         | SQLite driver: built-in `node:sqlite` behind a storage port             | Accepted, re-evaluate at Phase 1 exit    |
| [0005](0005-official-local-unifi-api-contracts.md)    | Official local UniFi API contracts and module eligibility               | Accepted                                 |
| [0006](0006-vendor-api-artefact-handling.md)          | Vendor API artefacts: reference, verify, do not redistribute            | Accepted                                 |
| [0007](0007-storage-encryption-migrations-backups.md) | Storage: secret encryption, master key handling, migrations and backups | Accepted                                 |
| [0008](0008-telemetry-logging-audit-health.md)        | Telemetry: structured logs, redaction, audit trail and health checks    | Accepted                                 |
| [0009](0009-policy-evaluation-model.md)               | Policy evaluation model, policy schemas and the policy version          | Accepted                                 |
| [0010](0010-operation-registry-and-dispatcher.md)     | Operation registry and the central dispatcher                           | Accepted                                 |

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
