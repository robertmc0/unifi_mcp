# Security policy

## Supported versions

No release has been published yet. The project is pre-1.0. Security fixes will target the
latest release once releases exist.

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Use GitHub's private
vulnerability reporting ("Report a vulnerability" on the repository's Security tab) once
the repository is published. Include:

- affected version or commit, and deployment mode (HTTP, stdio, admin UI enabled or not);
- reproduction steps, using synthetic data only, never real API keys, tokens or addresses;
- the impact you observed.

You can expect an acknowledgement within 7 days. Please allow a reasonable disclosure
window before publishing details.

## Scope

In scope: authorisation bypass, approval-workflow bypass, read-only lock bypass, SSRF or
proxying through the server, credential or sensitive-data disclosure, admin interface
weaknesses, supply-chain issues in this repository.

Out of scope: vulnerabilities in UniFi firmware or applications (report those to
Ubiquiti), and attacks that require host-administrator privileges (spec §3.1).

See [docs/threat-model.md](docs/threat-model.md) for the threat model.

## How the repository is checked

Every change is scanned for secrets, private keys, certificate pins and real addresses,
its dependencies are audited against known vulnerabilities and registry signatures, and
every workflow action is pinned by commit ([docs/release.md](docs/release.md),
[ADR 0029](docs/adr/0029-supply-chain-and-release.md)). The image is not signed and is
not scanned for operating-system vulnerabilities by this project; scan it with a scanner
you trust.
