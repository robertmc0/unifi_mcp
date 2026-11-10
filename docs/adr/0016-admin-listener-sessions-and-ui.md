# 0016. Admin web listener, sessions and a server-rendered interface

- Status: Accepted
- Date: 2026-11-10
- Phase: 1
- Spec references: §2 (decisions 07, 24, 31), §7.2, §7.3, §13.1, §14, §16 Phase 1 gate, §17

## Context

The Phase 1 gate requires that the admin interface is local-only by default, and that the
MCP and admin listeners use separate authentication and ports. §7.2 requires:

- Argon2id passwords, with protection against enumeration and brute force;
- secure, HttpOnly, SameSite session cookies;
- CSRF protection for state changes;
- idle timeout, absolute lifetime and sign-out;
- recent re-authentication for high-impact approvals.

§13.1 requires server-side access checks, CSP, output escaping and no credentials in
responses, and says the UI must never be required for headless operation. §14 asks for
pinned versions and few dependencies. Phase 1 lists the admin UI as optional; MFA is a
Phase 5 task.

## Decision

### One service, two independent listeners

The admin listener runs in the service process, using the same stores, but has its own
HTTP(S) server and settings:

- `UNIFI_MCP_ADMIN_ENABLED` (default **false**), `_BIND` (default `127.0.0.1`) and
  `_PORT` (default 3001; it must differ from the MCP port).
- Its own TLS files: `_TLS_CERT_FILE` and `_TLS_KEY_FILE`.
- Its own Host allowlist, `_ALLOWED_HOSTS`; the local names are always included.
- Session limits: `_SESSION_IDLE_MINUTES` (default 30) and `_SESSION_MAX_HOURS`
  (default 12).

Plaintext HTTP on a non-loopback bind is refused unless `_ALLOW_PLAINTEXT=true`, as for
the MCP listener. In Docker the container must bind a reachable interface and publish the
port on host loopback (`127.0.0.1:3001:3001`); see docs/networking.md.

The authentication is separate in both directions:

- The admin listener has no `/mcp` path and ignores `Authorization` headers.
- The MCP listener ignores cookies and has no admin paths.
- A client token never opens an admin page, and an admin cookie never opens MCP.

### Sessions (migration 9, `admin_sessions`)

- Sign-in checks the password with `AdminStore.verify` (Argon2id, constant time, dummy
  hash for unknown users, ADR 0015). Each sign-in creates a new session, so a session id
  cannot be fixed in advance.
- The cookie is `__Host-umcp_admin=<16-hex id>.<256-bit secret>; Path=/; Secure;
HttpOnly; SameSite=Strict`, with no `Domain`. Only the SHA-256 of the secret is stored,
  and it is compared in constant time.
- A session ends after 30 idle minutes or 12 hours (both configurable), at sign-out, when
  the password is reset on the host (`admin reset-password` revokes all of the account's
  sessions), or when the account is disabled. Ended sessions are pruned daily.
- Failed sign-ins are throttled: 5 per username and 20 per address per 15 minutes. Once
  the limit is reached, even a correct password is refused until the window passes. Failed
  attempts are audited without the attempted username, which may be a mistyped password.
  Sign-in, sign-out, failures and re-authentication failures are audited (`admin.auth`).

### Requests

- Every request must carry a Host in the allowlist (DNS rebinding).
- Every POST must carry an `Origin` header whose host equals the `Host`. If
  `Sec-Fetch-Site` is present, it must be `same-origin`. Modern browsers send `Origin` on
  every form POST, and `SameSite=Strict` already withholds the cookie cross-site.
- Every signed-in POST must carry a CSRF token. The token is the HMAC of the session
  secret, so it needs no storage and only the cookie holder can compute it. It is compared
  in constant time.
- Forms are `application/x-www-form-urlencoded`, at most 16 KiB. Only `GET`, `HEAD` and
  `POST` are accepted.
- Every response has the headers below. They forbid scripts entirely, and no inline styles
  are allowed:
  - `Content-Security-Policy: default-src 'none'; style-src 'self'; img-src 'self';
form-action 'self'; frame-ancestors 'none'; base-uri 'none'`;
  - `Cache-Control: no-store`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
    `Referrer-Policy: no-referrer`, COOP/CORP `same-origin`, and a restrictive
    `Permissions-Policy`;
  - HSTS when the listener terminates TLS.

### Approvals need the password every time

Approving needs the account password, entered on the approval form, every time. It is
verified, renews the session's `authenticatedAt` and is passed as the approver's
authentication time. `ApprovalService` independently requires it to be less than 5 minutes
old (ADR 0011). Rejecting needs no password. Approving never executes anything: the
requesting client must resume. Wrong passwords count towards the sign-in throttle.

### A server-rendered interface without JavaScript

`packages/admin-ui` renders pages on the server from plain view models. The tagged `html`
template escapes every interpolation. Control, C1 and bidirectional characters are first
made visible as `\uXXXX`, by the same `displaySafe` that the CLI uses (moved to
`@unifi-local-mcp/core`), so request text cannot hide or reorder what an approver reads.
Every action is an HTML form. There is no client-side code, no frontend framework, no
build step and no new dependency. The stylesheet is served from `/static/admin.css`.

Phase 1 pages:

- sign-in;
- a dashboard: hard lock, runtime mode, policy version, readiness and check details,
  listeners, consoles with module states, credential presence and observed versions, and
  counts;
- approvals: pending and recent, a detail page, approve and reject;
- audit: filters by actor type, outcome and event type, paged with `before`.

The other §13.1 pages are not in Phase 1: editing consoles, clients and policy, the
permission preview, settings, audit export, MFA, and with it `admin reset-mfa`. The CLI
does these meanwhile (ADR 0015). They are listed in the phase checklist for Phase 5, next
to the spec's "admin MFA" task.

### Repository hygiene

A contract test fails if any source or document file contains a raw control, C1 or
bidirectional formatting character ("Trojan Source", CVE-2021-42574). This step's own test
files briefly contained such characters, and they now use escapes.

## Evidence

- `tests/integration-mock/admin-http.test.ts`:
  - off by default, separate port, no cross-use of MCP tokens and admin cookies;
  - headers, Host refusal, Origin, `Sec-Fetch-Site` and CSRF refusals;
  - cookie flags, sign-out, throttling, sessions ended by a password reset;
  - approval only with the password, no execution until the client resumes, rejection;
  - hostile request text escaped;
  - audit filters and paging.
- `tests/unit/admin-api/sessions.test.ts`: digest-only storage, exact cookie match, CSRF
  per session, idle and absolute limits, sign-out, reset, disabled accounts, pruning.
- `tests/unit/admin-ui/html.test.ts`, the config tests in
  `tests/unit/mcp-server/clients.test.ts`, and `tests/contract/source-hygiene.test.ts`
  (checked against a planted U+202E).
- Mutation checks: 16 safeguards disabled one at a time, and a test failed each time.

## Consequences

- An administrator can approve from a browser on the host, or through an SSH tunnel or a
  TLS reverse proxy. Without TLS, only a loopback address works, because the cookie is
  `Secure` and browsers accept that over plain HTTP only for localhost.
- Without JavaScript, pages reload on every action. That is acceptable for an
  administration console and removes a whole class of client-side risks.
- Login throttling is per process and in memory. A restart resets it, and behind a proxy
  all users share the proxy's address.

## Re-evaluation triggers

- MFA (Phase 5): TOTP secrets encrypted with the master key, hashed recovery codes,
  `mfaVerified` passed to `ApprovalService`, and `admin reset-mfa`.
- The remaining §13.1 pages need interactivity that forms cannot provide.
- A deployment needs the admin interface on a separate host from the MCP service.
