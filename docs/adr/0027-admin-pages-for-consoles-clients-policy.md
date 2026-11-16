# 0027. Admin pages for consoles, clients, policy, audit export and settings

- Status: Accepted (extended as Phase 5 step 3 proceeds)
- Date: 2026-11-16
- Phase: 5
- Spec references: §13.1 items 2, 3, 4, 6, 7; §7.2; §12; §17

## Context

ADR 0016 built the admin listener with three pages: dashboard, approvals and audit. Spec
§13.1 lists four more as the minimum: consoles, MCP clients, a policy editor with a
permission preview, audit search and export, and settings and maintenance. Until now the
CLI covered them.

The pages fall into two kinds. Showing consoles, clients, policy and settings changes
nothing. Adding a console, issuing a token or editing policy from a browser changes what
a stolen admin session is worth: today it can approve a request, and only with the
password.

## Decision

### 1. Read-only pages (this step)

- **Consoles** (`/consoles`, `/consoles/<id>`): alias, host, state, TLS trust, each
  module's mode, port, version (observed, or declared and labelled so) and whether a
  credential is stored; the console policy as JSON.
- **Clients** (`/clients`, `/clients/<id>`): status, expiry, last use, token ids with
  their dates, the client policy as JSON, and **what the client can use now**.
- **Policy** (`/policy`): the hard lock, the runtime mode, the policy version, the global
  policy as JSON, and the off-by-default operations with their state.
- **Settings and maintenance** (`/settings`): versions, the master key id, the effective
  deployment settings, the applications with their contract revisions and counts
  (unavailable applications included, ADR 0024), event connections, and the host commands
  for backup, restore, checks, key rotation and emergency read-only. It also states that
  the service has no update check: it never contacts the internet.

**The permission preview is the client's own tool list.** A client's effective
operations are computed by `discoverOperations`, the function that builds the tool list
the client is shown, with the same policy evaluation. The page cannot disagree with what
the client sees, and a test compares the two.

**View models cannot carry a secret.** The pages get plain view models built in
`packages/mcp-server/src/admin-views.ts`. They have no field for a console credential, a
client token, the master key, a password or a TOTP key, so no template can show one.
Token ids, which name tokens in logs, are shown. The master key appears as its id.

### 2. Audit search and export (this step)

- The audit page also filters by actor id and by time (`since`, `until`, UTC).
- `/audit/export` downloads what the filters match, newest first, as CSV or JSON, at most
  5000 entries per download. Entries were redacted when written (ADR 0008); the export
  adds nothing to them.
- **CSV cells are quoted, and formula-like values are defused.** A value starting with
  `=`, `+`, `-`, `@`, a tab or a carriage return gets a leading apostrophe, because audit
  fields can hold text that came from a client.
- **An export is audited** (`admin.audit` / `audit.export`, with the format, the number
  of entries and the filters), before anything is sent.

### 3. Changes from the web interface (next step)

Console, client and policy changes from the browser will be a separate capability,
**off unless the deployment enables it**, with re-authentication for every change. Until
it is built, the pages say that changes are made with the CLI on the host. This section
will record the design when it is implemented.

## Evidence

- `tests/integration-mock/admin-http.test.ts`, against a running service:
  - every new page needs a session;
  - consoles and modules shown, the console key on no page;
  - a client's operations on the page equal the list the client gets from
    `unifi_list_operations`, for a reader and a writer; they follow the runtime mode and
    revocation; client tokens on no page;
  - hostile descriptions escaped, with bidirectional characters made visible;
  - policy, hard lock and settings shown; no key or password on them;
  - the pages have no form but sign-out, and a POST to any of them is 404;
  - audit filters, including malformed and hostile values; CSV and JSON export; formula
    values defused; the export recorded; more than one batch exported; no export without
    a session.

## Consequences

- An administrator can review consoles, clients, grants and their effect from a browser.
  A stolen session can now read them too; it could already read the audit trail, which
  holds much of the same.
- An export leaves the service. What an administrator does with the file is theirs to
  protect; it contains client ids, console ids and operation ids.

## Re-evaluation triggers

- The management capability (section 3) is built or dropped.
- Audit exports beyond 5000 entries are needed: `unifi-mcp audit list` on the host has no
  such limit per call, and can be extended.
