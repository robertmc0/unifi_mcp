# API specifications: sources, provenance and terms

This directory is the auditable contract baseline for every UniFi adapter (spec §4, §19;
ADR 0005, ADR 0006). The project may implement **only** operations listed here, and only
against the **local** base URLs recorded here.

## Layout

```text
api-specs/
  <application>/<revision>/
    provenance.json    committed: source URLs, SHA-256, sizes, local/forbidden base URLs,
                       authentication, notes, unverified assumptions
    operations.json    committed: derived factual inventory (method, path, id, title, link)
    vendor/            NOT committed (gitignored): verbatim vendor artefacts, verified by checksum
```

## Terms and redistribution

No redistribution licence was found for Ubiquiti's developer documentation (OpenAPI JSON,
`llms.txt`) or the UniFi Access API reference PDF. This repository therefore does not
contain them. It records where they are published and how to verify them, and keeps only
the minimal interoperability facts needed to reconcile coverage (ADR 0006). UniFi is a
trademark of Ubiquiti Inc. This project is not affiliated with Ubiquiti.

## Baseline inventory (retrieved 2026-11-10; Protect 7.4.96 on 2026-11-11)

Protect keeps two revisions ([ADR 0019 §7](../docs/adr/0019-protect-adapter.md)): 7.3.74, the
current official release, and 7.4.96, the newest documented revision. Reads include the
WebSocket subscriptions (2 in 7.3.74, 3 in 7.4.96).

| Application | Revision   | Contract artefact                                                                                           | SHA-256                                                            | Operations               |
| ----------- | ---------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------ |
| Network     | 11.0.97    | [openapi.json](https://developer.ui.com/network/v11.0.97/openapi.json) (412,138 B)                          | `0828aa9f017cce92cd035429c7e19c933d0b3387c561aac17c468b4c2ca8be66` | 73 (41 read / 32 write)  |
| Network     | 11.0.97    | [llms.txt](https://developer.ui.com/network/v11.0.97/llms.txt) index (11,175 B)                             | `511cdf651a5b6864b5412765ccd6ef199ef44fd161ed1fa9e35e161628172575` | identical set            |
| Protect     | 7.3.74     | [openapi.json](https://developer.ui.com/protect/v7.3.74/openapi.json) (440,739 B)                           | `85caa3c70a5febd8ae2e4f90dbe31b8ad544fc9b74b6c02ca477c8af03d14dc6` | 74 (38 read / 36 write)  |
| Protect     | 7.3.74     | [llms.txt](https://developer.ui.com/protect/v7.3.74/llms.txt) index (10,178 B)                              | `5ee56a5109a0024e1386a45d9bc351ed7b27183074f634d17b0dbde5ccf219b3` | identical set            |
| Protect     | 7.4.96     | [openapi.json](https://developer.ui.com/protect/v7.4.96/openapi.json) (558,984 B)                           | `21e24ef35a13616accb6978d5b99af7ee139fee80b8f738c364a310f5821d96d` | 83 (41 read / 42 write)  |
| Protect     | 7.4.96     | [llms.txt](https://developer.ui.com/protect/v7.4.96/llms.txt) index (11,504 B)                              | `da7fb3dabca8fae71b99eefdbb0c49b070109ead7c62813b8873e04b069c7339` | identical set            |
| Access      | 2026-03-23 | [api_reference.pdf](https://assets.identity.ui.com/unifi-access/api_reference.pdf) (2,150,514 B, 194 pages) | `6abb576c43637535143d5bfdc720c5025657063e5a983b29cd564e76441e896e` | 107 (43 read / 64 write) |

Supporting sources consulted (not artefacts of record):

- Developer portal root index `https://developer.ui.com/llms.txt` (lists Network, Protect,
  Mobility, InnerSpace, Site Manager, Carrier Fabric, with version histories).
- `https://developer.ui.com/network/v11.0.97/gettingstarted`: "Obtaining an API Key",
  local variant ("Sign in to the Local Site → Integrations → Create New API Key").
- `https://developer.ui.com/network/v11.0.97/error-handling`: the error body fields.
- help.ui.com 30076656117655 "Getting Started with the Official UniFi API" (updated
  2026-09-22): local application APIs; Access API reference link.
- help.ui.com 218506997 "Required Ports Reference" (updated 2026-11-06).
- help.ui.com 17452334269975 "Getting Started with UniFi Access" (updated 2026-10-02).

## Local vs cloud

Each OpenAPI document lists two servers. Only the **Local Console** server is used:

| Application | Local (used)                                                  | Cloud connector (never used)                                                     |
| ----------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Network     | `https://{consoleHost}/proxy/network/integration`             | `https://api.ui.com/v1/connector/consoles/{consoleId}/proxy/network/integration` |
| Protect     | `https://{consoleHost}/proxy/protect/integration`             | `https://api.ui.com/v1/connector/consoles/{consoleId}/proxy/protect/integration` |
| Access      | `https://{consoleHost}:12445` (paths `/api/v1/developer/...`) | —                                                                                |

The portal's code samples and its "Remote" API-key instructions target the cloud connector
and `unifi.ui.com`. Do not copy them into adapters (spec §1.3).

## Application availability

See [ADR 0005](../docs/adr/0005-official-local-unifi-api-contracts.md). In short: Network,
Protect and Access have official local APIs. InnerSpace has a local server in its OpenAPI
but is not in the roadmap. Site Manager, Mobility and Carrier Fabric are cloud-only and
excluded. No official local API was found for Talk, Connect or Drive.

## Workflow

```sh
npm run api:fetch-specs      # download vendor artefacts into vendor/ and verify SHA-256
npm run api:reconcile        # fail on any drift between vendor, operations.json and coverage
npm run api:coverage-report  # regenerate docs/api-coverage/
```

### Adding a new vendor revision

1. Create `api-specs/<app>/<new-revision>/provenance.json` with URLs. Run
   `npm run api:fetch-specs` once with placeholder checksums, inspect the quarantined
   `*.mismatch` files, then record the real SHA-256 and size.
2. For OpenAPI sources, run `node scripts/reconcile-api-coverage.ts --write` and review the
   `operations.json` diff: added, removed and changed operations.
3. Re-check local base URL, authentication and error semantics against the new revision's
   documentation. Update `notes` and `unverified`.
4. Regenerate coverage, update the adapter's reviewed security metadata (Phase 2+), and
   add an ADR if behaviour or assumptions changed.
5. Never edit a recorded checksum to make a mismatch "pass" without that review.
