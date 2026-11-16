# 0026. Two-step sign-in for administrators (TOTP)

- Status: Accepted
- Date: 2026-11-16
- Phase: 5
- Spec references: §7.2, §13.1, §13.2, §17 ("Separate admin authentication, optional MFA"), §18 item 6

## Context

Spec §7.2 asks for "optional TOTP MFA with encrypted TOTP secrets, one-time hashed
recovery codes, mandatory recent reauthentication for high-impact approvals and critical
security changes; operator may require MFA globally", and §13.2 lists
`unifi-mcp admin reset-mfa`. Phase 1 built password sign-in, sessions and the approval
page (ADR 0016) and deferred the second step to Phase 5.

The admin interface has no JavaScript (ADR 0016), the project avoids dependencies
(spec §14), and the host CLI is the root of administration: the first administrator and
every recovery action are created there (ADR 0015).

## Decision

1. **TOTP as every authenticator app implements it.** RFC 6238 with HMAC-SHA-1, 6 digits,
   a 30-second step and a 160-bit random key shown in Base32. Other parameters are in
   the RFC but not in most apps. It is implemented on `node:crypto`
   (`packages/admin-api/src/totp.ts`, about 100 lines) and checked against the RFC 4226
   and RFC 6238 test vectors.

2. **One step of drift, and a code works once.** The current step and one either side
   are accepted. The last accepted step is stored with the account, and no step at or
   before it is accepted again. A code seen over a shoulder or replayed from a recording
   is useless once used. The cost: after signing in, an approval needs the app's next
   code.

3. **The key is encrypted, and shown once.** It is a `secret_records` entry of kind
   `admin.totp_secret`, sealed with the master key like console credentials (ADR 0007),
   so backups, restores and key rotation treat it as they treat those. No command or page
   reads it back out.

4. **Ten recovery codes, hashed, one use each.** Each has 80 random bits and is shown
   once, at setup or renewal. Only SHA-256 digests are stored. With that much entropy a
   plain digest cannot be searched, so a slow password hash would add nothing. A recovery
   code is accepted wherever a TOTP code is.

5. **Set up, renewed and removed on the host only.** `admin enable-mfa` (shows the key,
   asks for a code from the app before anything is activated, then shows the recovery
   codes), `admin new-recovery-codes` and `admin reset-mfa` are CLI commands; the store
   refuses any other actor. All three are audited. The first two are interactive only and
   refuse `--json`, so the key and codes are never written to a pipe or a file. The web
   interface shows the state (Account page) and cannot change it.
   - A stolen browser session therefore cannot remove or replace the second step. This
     is how "recent reauthentication for critical security changes" is met for these
     changes: they need host access, which is stronger than a password prompt.
   - Recovery for a lost device is `admin reset-mfa`, as password recovery is
     `admin reset-password`: host authority, audited.

6. **One sign-in form.** The form has a third, optional field for the code. A wrong
   username, password or code gives one message and one status. There is no second page
   and no half-authenticated session to protect. The audit trail, which needs host
   access, does record `second_step_failed` with the account name: a correct password
   with a wrong code is worth noticing. Wrong codes count towards the existing sign-in
   throttle (5 per username, 20 per address, per 15 minutes).

7. **Approvals need the password and a new code.** With a second step on the account,
   every approval in the web interface needs both. Without one, the password alone, as
   before (ADR 0016).

8. **It can be required.** `UNIFI_MCP_ADMIN_REQUIRE_MFA=true` refuses sign-in to an
   account without a second step, after its password was verified, and says how to set
   it up. It is a deployment setting like the rest of the admin listener, so nothing in
   the database or the interface can turn it off. The default is off: the listener is
   loopback-only by default, and the spec makes the second step optional.

9. **Sessions end when the second step changes.** Activating or removing it revokes the
   account's sessions, like a password reset.

10. **The CLI is outside it.** `approvals approve` and every other CLI command rely on
    host authority (ADR 0015), not on the administrator account. A second step on an
    account does not, and cannot, protect against someone who controls the host.

## Not done

- **No QR code.** Drawing one needs a QR encoder, in the service or in the page. The page
  has no scripts, and an encoder is a dependency or several hundred lines for a
  convenience. The key is typed into the app (32 characters), and the `otpauth://` link
  is shown for tools that accept one.
- **No setup from the web interface.** See 5. The remaining admin pages (Phase 5 step 3)
  do not change this.
- **No WebAuthn or passkeys.** They need scripts in the page.

## Evidence

- `tests/unit/admin-api/totp.test.ts`: RFC 4648 Base32 vectors; RFC 4226 Appendix D; RFC
  6238 Appendix B (SHA-1, SHA-256, SHA-512); the drift window; refusal at or before the
  last accepted step; malformed input.
- `tests/unit/admin-api/mfa.test.ts`: pending until confirmed; only the CLI actor;
  codes and recovery codes work once; renewal; reset removes the rows and the secret
  record and ends sessions; the database file, rows, log and audit trail contain neither
  the key nor a recovery code.
- `tests/integration-mock/admin-http.test.ts` ("two-step sign-in"), against a running
  service with a movable clock: the single message for wrong password or code; reuse of
  a code refused; recovery code once, with the count shown; the throttle; approval with
  password and a fresh code only; the requirement; sessions ended by setup and reset; no
  code, key or recovery code in any page, log line or audit entry.
- `tests/unit/cli/cli.test.ts`: setup with a code computed from the printed key;
  interactive only; nothing left after a wrong code; renewal; reset; `doctor`.
- Mutation checks (2026-11-16), each caught by these tests: no replay protection;
  approval without the code; sign-in without the code; a reusable recovery code; the
  requirement ignored.

**Not verified:** sign-in with a real authenticator app. The codes equal the RFC test
vectors and the `otpauth://` link follows the usual key-URI format, but no app has been
enrolled against this service yet.

## Consequences

- An administrator with a second step needs the device (or a recovery code) for the web
  interface, and host access to change it.
- Clocks matter: more than about 30 seconds apart and codes fail.
- Storage migration 11 adds two tables. Older backups restore and migrate as usual.
- The single-form sign-in shows a code field to everyone, including accounts without a
  second step.

## Re-evaluation triggers

- More than one administrator account, or roles: review who may reset whose second step.
- A trial with a real authenticator app that fails.
- A wish for QR codes or passkeys strong enough to justify scripts in the admin pages or
  a dependency.
