# Contributing

Thanks for your interest. Read [AGENTS.md](AGENTS.md) first: its rules apply to human
and AI contributors alike.

## Workflow

1. Check [docs/phase-checklist.md](docs/phase-checklist.md) and open an issue for anything
   non-trivial.
2. Use Node.js 26.13.0+ (`.node-version`) and run `npm ci`. The tests also need the
   `openssl` CLI, which generates synthetic test certificates at run time.
3. Make focused changes with tests and documentation (spec §18: the manual is a
   deliverable).
4. Run `npm run check` before pushing. If you touched `api-specs/` or the coverage
   tooling, also run `npm run api:fetch-specs && npm run api:reconcile`.
5. Record any architecture decision as an ADR in `docs/adr/`.

## Hard rules

- Only operations from official, checksum-recorded vendor contracts (`api-specs/`). No
  undocumented or reverse-engineered UniFi endpoints.
- Never commit vendor documentation, secrets, real hostnames or addresses, or production
  data. Test fixtures must be synthetic.
- Live UniFi tests are read-only and opt-in. Write paths are tested only against mocks.
- Security metadata (risk, sensitivity, permission) is hand-reviewed in code.

## Licence

Contributions are accepted under the Apache License 2.0 (see [LICENSE](LICENSE)).
