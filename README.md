# unifi-local-mcp

A self-hosted [Model Context Protocol](https://modelcontextprotocol.io) server that gives
MCP clients such as Claude Code and Codex controlled access to the **official local
APIs** of UniFi applications (Network, Protect, Access). AI clients connect to this
server, never to UniFi. UniFi credentials never leave the server.

> **Status: Phase 0 (research and contract baseline) is complete. There is no runnable
> server yet.** See [docs/phase-checklist.md](docs/phase-checklist.md).

## Design principles

- **Secure by default:** read-only, least privilege, deny by default. An immutable
  `UNIFI_MCP_FORCE_READ_ONLY` deployment lock is available.
- **Official local APIs only:** no cloud or Site Manager access, no undocumented endpoints,
  no raw HTTP proxy tools.
- **Independent human approval** for high-impact changes, via the admin UI or local CLI.
  An AI can never approve.
- **Per-client identity:** one revocable token per MCP client, with permission-filtered
  tool lists.
- Streamable HTTP and an authenticated stdio bridge; MCP 2026-07-28 and 2025-era clients.

## Repository map

| Path                                                   | Contents                                                                 |
| ------------------------------------------------------ | ------------------------------------------------------------------------ |
| [`unifi-mcp-design-spec.md`](unifi-mcp-design-spec.md) | The design specification (source of truth)                               |
| [`docs/`](docs/index.md)                               | Manual, ADRs, threat model, API coverage                                 |
| [`api-specs/`](api-specs/README.md)                    | Vendor contract provenance and operation inventories                     |
| `packages/`                                            | Workspace packages (skeletons until Phase 1)                             |
| `scripts/`                                             | API contract tooling (fetch, reconcile, coverage report)                 |
| `tests/`                                               | Contract and (later) unit, security, integration and compatibility tests |

## Development

Requires Node.js 26.13.0+ (26.x LTS) and npm 11.

```sh
npm ci
npm run check              # format check, lint, typecheck, tests
npm run api:fetch-specs    # download and verify vendor API artefacts (internet needed)
npm run api:reconcile      # check the inventories against the vendor contracts
```

## Licence

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). UniFi is a trademark of
Ubiquiti Inc.; this project is independent and not affiliated with Ubiquiti.
