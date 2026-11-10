# 0001. Record architecture decisions

- Status: Accepted
- Date: 2026-11-10
- Phase: 0
- Spec references: preamble ("record it in an ADR"), §15, §20

## Context

The design specification fixes scope, security model and acceptance criteria. It leaves
implementation details to the implementer, provided each one is "the smallest secure,
well-tested choice", recorded in an ADR. Several agents (Codex, Claude Code) and humans
may work on the repository over time, so decisions must be discoverable in the repository
itself.

## Decision

- Record decisions as numbered Markdown ADRs in `docs/adr/`, indexed in
  `docs/adr/README.md`, using the template there.
- Authority order: (1) `unifi-mcp-design-spec.md`; (2) accepted ADRs; (3) code comments.
  An ADR may narrow or clarify the spec. It may deviate from the spec only when a published
  vendor API or MCP SDK contract conflicts with it. The ADR then cites the evidence, keeps
  least-privilege behaviour, and says so explicitly in its "Decision" section.
- ADRs are immutable once accepted, apart from status changes and clarifying notes. A changed
  decision gets a new ADR that supersedes the old one.
- Each ADR names its re-evaluation triggers, such as a new SDK major, a vendor API change or
  a failing gate.
- Unverified assumptions are listed explicitly, never implied. API-level ones live in
  `api-specs/<app>/<revision>/provenance.json` (`unverified`) and appear in the
  generated coverage pages.

## Consequences

Agents start each session from `AGENTS.md`, which points here. Reviews can check a change
against a named decision instead of tribal knowledge.
