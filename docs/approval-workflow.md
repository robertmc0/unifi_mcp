# Approval workflow

> **Status: Phase 1 in progress.** The workflow is implemented and tested in
> `packages/approvals` and the dispatcher (ADR 0011), with the MCP tools (ADR 0013) and
> the CLI commands (ADR 0015). The admin UI page is Phase 1 step 10.

High-risk operations, such as changing firewall rules, rebooting a gateway or unlocking a
door, never run just because an AI client asks. A human approves each one.

## How it works

1. **The AI client asks.** The request is checked like any other (permissions, hard lock,
   arguments). Because it is high risk, it is not executed. The client receives
   `approval_required`, an **approval id**, the expiry time and a summary.
2. **A human decides.** An administrator reviews the request in the admin UI, or a host
   administrator uses the CLI (`unifi-mcp approvals list|show|approve|reject`, see
   [administration.md](administration.md#approvals-approvals)), and approves or rejects
   it.
3. **The same AI client resumes.** It calls `unifi_resume_approved` with the approval id.
   Only the client that made the request can do this.
4. **Everything is checked again.** The approval's expiry, the client, the security
   policy, the hard lock and every permission are checked again before the action runs. It
   then runs exactly once, through the same path as every other write.

The AI client cannot approve anything. There is no MCP tool for it, and the service
refuses any approval that does not come from an administrator or the CLI.

## Time limits

| Window                                  | Default    | Configurable          |
| --------------------------------------- | ---------- | --------------------- |
| From request to decision                | 10 minutes | Shorter only (≥ 30 s) |
| From approval to the client resuming it | 2 minutes  | Shorter only (≥ 30 s) |

Requests that miss a window expire. The client then has to make the request again.

## What reviewers see

The summary shows the operation, the target console and site, the risk and the requested
arguments, with sensitive values such as passwords or pre-shared keys shown as
`[REDACTED]`. The full arguments are stored encrypted with the master key and deleted as
soon as the request is approved and used, rejected, expired or invalidated.

Administrators must have signed in within the last 5 minutes to approve. A deployment can
also require a verified second factor (MFA arrives with the admin UI).

### Approving with the CLI

`unifi-mcp approvals approve <id>` works only at an interactive terminal: it shows the
request and asks you to type the first 8 characters of its id. It cannot be scripted or
piped, and there is no `--yes`. Request text comes from the AI client, so control
characters, terminal escape sequences and bidirectional-text characters in it are shown
as `\uXXXX` and cannot rewrite or reorder the screen. The decision is recorded as
`cli:<operating-system user>`. `approvals reject` can be scripted.

## When an approval stops working

| Situation                                                                                           | Result                                          |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Used once already                                                                                   | `approval_already_used`                         |
| A window passed                                                                                     | `approval_expired`                              |
| The security policy changed in any way (including another client's permissions or the runtime mode) | `approval_invalidated`                          |
| The stored request was altered                                                                      | `approval_invalidated`                          |
| Another client tries to resume it                                                                   | `approval_not_found`                            |
| The hard lock is on, or the client was revoked or lost the permission                               | Denied; the approval is not used up and expires |

Every request, decision, resumption, refusal and expiry is recorded in the audit trail.

## Limitations

- The summary shows the requested call, not yet a comparison with the console's current
  state (planned with the Network adapter, Phase 2).
- Some UniFi APIs offer no way to detect that the target changed between the request and
  the approval. Operation descriptions will say so where that applies.
