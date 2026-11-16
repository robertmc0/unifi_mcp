# unifi-local-mcp documentation

> **Project status: Phase 1 (secure platform core), Phase 2 (UniFi Network) and Phase 3
> (UniFi Protect) complete; Phase 4 (UniFi Access) implemented with its gate open; Phase 5
> (release hardening) in progress. The service serves MCP over HTTP and stdio, is
> administered with the host-only `unifi-mcp` CLI, and implements all 73 documented UniFi
> Network operations, 73 of the 74 Protect 7.3.74 operations, including both event
> subscriptions, and 98 of the 107 Access operations ([applications-access.md](applications-access.md)),
> tested against synthetic consoles. Network and Protect reads were also checked on a real
> console (Network 11.0.99, Protect 7.3.74); Access has not run on a real console. Other
> applications are reported as unavailable, with the reason
> ([applications-other.md](applications-other.md)).**
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

## Operator manual

Getting started:

- [quickstart.md](quickstart.md): one Docker host, the MCP endpoint on loopback, the hard
  lock on, a first read-only tool
- [installation.md](installation.md): requirements, Docker Compose, from source,
  maintenance, upgrades, uninstalling
- [configuration.md](configuration.md): every deployment setting (hard lock, listeners,
  limits, egress, data, logging, master key, retention)
- [networking.md](networking.md): the three listeners, egress to consoles, one-host,
  HTTPS and two-network Compose examples, reverse proxy

Security and administration:

- [security.md](security.md): the security model, permissions, write safety, client
  tokens, the admin interface, connections to consoles
- [administration.md](administration.md): the `unifi-mcp` CLI, the admin web interface,
  two-step sign-in, the bootstrap file
- [approval-workflow.md](approval-workflow.md): high-risk writes and their approval
- [threat-model.md](threat-model.md): threats and their mitigations

Connecting clients:

- [client-claude-code.md](client-claude-code.md): Claude Code, over HTTP or the stdio bridge
- [client-generic-mcp.md](client-generic-mcp.md): any MCP client; tools, discovery,
  results, approval and resume
- client-codex.md: not written yet. It waits for a verified trial with the current
  Codex release (spec §18); until then, follow the generic guide.

UniFi applications:

- [applications-network.md](applications-network.md) and the optional
  [runbook-network-writes.md](runbook-network-writes.md)
- [applications-protect.md](applications-protect.md) and the optional
  [runbook-protect-writes.md](runbook-protect-writes.md)
- [applications-access.md](applications-access.md)
- [applications-other.md](applications-other.md): Talk, Connect, Drive, InnerSpace, and
  why they are unavailable
- [events.md](events.md): Protect event subscriptions and Access notifications

Running it:

- [monitoring.md](monitoring.md): logs, the audit trail, health checks, Prometheus metrics
- [backup-restore.md](backup-restore.md): backup, restore, key rotation, drills
- [troubleshooting.md](troubleshooting.md): startup, connections, refusals, consoles,
  administration

Developing and releasing:

- [development.md](development.md): contributor workflow, adding an operation, new
  contract revisions and applications, tests
- [release.md](release.md): pre-release checks, secret scan, SBOM, tagging, the
  publishing switch, what is not done
- [SECURITY.md](../SECURITY.md): reporting a vulnerability

## Contributing

See [CONTRIBUTING.md](../CONTRIBUTING.md) and [AGENTS.md](../AGENTS.md).
