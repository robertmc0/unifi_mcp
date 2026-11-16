# 0027. Admin pages for consoles, clients, policy, audit export and settings

- Status: Accepted
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

### 3. Changes from the web interface

Spec §13.1 asks for consoles to be added, edited and removed, client tokens to be issued,
rotated and revoked, and policy to be edited, from the browser.

1. **Off unless the deployment enables it.** `UNIFI_MCP_ADMIN_MANAGEMENT=true` adds the
   change forms and their routes. Without it there is no route: a POST to `/manage/…` is
   404, and the pages are the read-only ones of section 1. It is a deployment setting, so
   nothing in the database or the interface can turn it on. The reason for the default:
   with management on, a browser session and its password can create a client with any
   grant. With it off, a session can read and approve. The service logs a warning at
   start when it is on, and the Settings page shows the state.

2. **Every change is the CLI's change.** A form calls the same store method as the CLI
   command of the same name, with `admin:<username>` as the actor
   (`packages/mcp-server/src/admin-actions.ts`). Validation, audit entries, policy-version
   bumps, token revocation and closing of open connections are therefore the same code.
   The module adds no capability the CLI lacks.

3. **The changes:** add a console; change its host and description, TLS trust, a
   module's credential and port, and its policy; check its connection; remove it. Create a
   client; change its policy; rotate its token; revoke it; remove it. Switch the runtime
   mode; replace the global policy. A test pins this list against the forms on the pages.

4. **What stays on the host:** declaring an application version (ADR 0021 §5),
   administrators, passwords and the second step (ADR 0015, ADR 0026), backup, restore
   and key rotation, and the hard lock, which is not a setting at all. No change exists
   for them, whatever a request says.

5. **Recent re-authentication.** A change needs the password to have been checked within
   the last five minutes: at sign-in, or on the change form (with a code from the
   authenticator app when the account has a second step). The forms show the password
   fields only when they are needed. A refused re-authentication counts towards the
   sign-in throttle and is audited. Approvals keep their stricter rule: the password
   every time (ADR 0016, ADR 0026).

6. **Policy is edited as JSON, with a preview.** The console, client and global policies
   are shown in a text area and validated by the same schemas as everywhere else.
   _Preview the effect_ changes nothing and lists, for every client, the operations it
   would gain and lose, computed by `discoverOperations` with the candidate policy in
   place of the stored one. Saving the global policy carries the policy version the form
   was rendered with, so a form that is out of date is refused. A structured editor (one
   control per rule) was not built: it would be a second, larger description of the policy
   model to keep in step with the schema.

7. **Secrets go one way.** A console credential is typed into a password field, stored
   encrypted and never rendered. A new client token is in the page that answers the
   request that created it (never cached, like every admin page), and nowhere else: not
   in a redirect, a later page, a log line or an audit entry.

8. **Dangerous choices need typing.** Removing a console or a client needs its alias or
   id typed. Turning certificate verification off needs the word `insecure` typed.

9. **The result of a change** is shown once on the next page, from a per-session notice
   held in memory. Nothing from the URL is reflected into a page.

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
- The same file, "changes from the web interface", with management enabled and a
  movable clock:
  - off by default: no form, and 404 for every change route;
  - the forms on the pages are exactly the reviewed list; host-only changes do not exist;
  - a console added, given a credential, port, policy, details and TLS trust, checked
    (the synthetic console receives no request) and removed, each audited as
    `admin:alice`; store refusals shown as "Not changed"; the typed credential in no
    page, log or audit entry;
  - a client created with a console alias in its policy; its token shown once and
    working; a preview that changes nothing and lists the operations gained; rotation and
    revocation taking effect on the MCP listener at once; neither token anywhere later;
  - the runtime mode and the global policy changed; a preview listing the operation a
    client would lose; a stale form refused; an unknown field such as `forceReadOnly`
    refused;
  - the password needed again after five minutes, and a code too with a second step;
  - forged, cross-origin and signed-out requests refused.
- Mutation checks (2026-11-16), each caught: re-authentication skipped; management wired
  regardless of the setting; removal without the typed confirmation; insecure TLS
  without the typed word.

## Consequences

- With management enabled, the admin listener is as powerful as the CLI for consoles,
  clients and policy. It should then be reachable only over TLS or loopback, with
  two-step sign-in required (`UNIFI_MCP_ADMIN_REQUIRE_MFA=true`). The manual says so.
- An administrator can review consoles, clients, grants and their effect from a browser.
  A stolen session can now read them too; it could already read the audit trail, which
  holds much of the same.
- An export leaves the service. What an administrator does with the file is theirs to
  protect; it contains client ids, console ids and operation ids.

## Re-evaluation triggers

- A structured policy editor is wanted in place of JSON.
- More than one administrator, or roles: management would need per-role limits.
- Audit exports beyond 5000 entries are needed: `unifi-mcp audit list` on the host has no
  such limit per call, and can be extended.
