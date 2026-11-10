# Threat model (Phase 0 notes)

Status: initial notes from Phase 0. They are refined at each phase gate. The release
version feeds `docs/security.md` (Phase 5). Spec sections are cited as §n.

## Assets

| Asset                                                                                                                             | Where                                                  | Impact if compromised                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| UniFi Network/Protect API keys                                                                                                    | SQLite `secret_records` (AEAD-encrypted)               | Treated as console-wide admin credentials. The vendor documents no scoping (ADR 0005) |
| UniFi Access API tokens                                                                                                           | Same                                                   | Physical access control within the token's vendor scopes                              |
| Master encryption key                                                                                                             | Docker secret / read-only file, never in the DB (§8.2) | Decrypts every stored UniFi credential                                                |
| MCP client bearer tokens                                                                                                          | Only a keyed digest is stored (§7.1)                   | Impersonation of an MCP client within its scopes                                      |
| Admin passwords, TOTP secrets, recovery codes, sessions                                                                           | SQLite (Argon2id / encrypted / hashed)                 | Approval of high-risk actions; policy changes                                         |
| Approval records and policy state                                                                                                 | SQLite                                                 | Bypass of the human-approval and read-only controls                                   |
| Sensitive UniFi data: client identities, camera images, stream URLs, voucher codes, Wi-Fi passphrases, PINs/NFC tokens, door logs | In transit only; minimised and redacted (§6.4)         | Privacy breach; physical-security breach                                              |
| Audit trail                                                                                                                       | SQLite                                                 | Loss of accountability                                                                |

## Actors

- **MCP client / AI agent.** Authenticated by a token, but its _intent_ is untrusted. It
  may be prompt-injected through upstream data (camera names, client hostnames, event
  text) or through the user's other content. Assume it will try any tool name and any
  argument.
- **Network attacker on the client-side network.** Can reach the MCP listener. Tries token
  guessing, DNS rebinding, cross-origin requests, and using the server as a TCP or HTTP
  proxy.
- **Network attacker on the management side or VPN.** Tries to impersonate a console (TLS
  MITM) or tamper with responses.
- **Administrator.** Trusted, but makes mistakes. Uses the admin UI or host CLI.
- **Host administrator.** Fully trusted (§3.1). Can read the master key and modify local
  files.
- **Supply chain.** npm packages, base images, CI actions, vendor documentation downloads.

## Trust boundaries

1. MCP client → MCP listener (bearer token, TLS, Host/Origin validation).
2. stdio harness → stdio bridge → MCP listener. The bridge holds only a client token.
3. Browser → admin listener (separate port and auth, session + CSRF + optional TOTP).
4. Host shell → CLI (host privilege is the authority).
5. Service → UniFi consoles (egress allowlist, TLS verification or pinning, fixed operation
   templates).
6. Service → SQLite / master key on the persistent volume.

## Threats and planned mitigations

| #   | Threat (STRIDE)                                                | Boundary | Mitigation (spec)                                                                                                                                                                                                                          | Phase |
| --- | -------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- |
| T1  | Agent invokes an undocumented or arbitrary UniFi endpoint (E)  | 5        | Registry of reviewed operations only; no `http_request`/proxy tools; fixed path templates with segment-encoded params; fixed methods; no user headers (§4.4, §5.1)                                                                         | 1–2   |
| T2  | SSRF: agent steers the server to an arbitrary host (I/E)       | 5        | Console IDs resolve to configured hosts only; private/VPN allowlist; DNS re-resolution check at connect; redirects refused (§4.4, §9.2)                                                                                                    | 1     |
| T3  | Agent self-approves a high-risk action (E)                     | 1        | No MCP approval tool; approval via admin UI or CLI only, with recent auth/TOTP; proposal bound to client/args digest/policy version; single use; expiry (§6.5)                                                                             | 1     |
| T4  | Write despite read-only mode (E)                               | all      | `UNIFI_MCP_FORCE_READ_ONLY` checked at enqueue, dispatch and resume; write tools hidden; approvals never override it (§6.1, §5.3)                                                                                                          | 1     |
| T5  | Token theft or guessing (S)                                    | 1        | 256-bit opaque tokens, digest storage, constant-time compare, auth rate limiting, no plaintext non-loopback HTTP, per-request verification so revocation is immediate (§7.1, ADR 0003)                                                     | 1     |
| T6  | Identity spoofing through tool arguments or headers (S)        | 1        | Identity only from verified `authInfo`; SDK passes it through, and the contract test confirms it (ADR 0003)                                                                                                                                | 1     |
| T7  | DNS rebinding / CSRF against the listeners (S/T)               | 1, 3     | Host and Origin allowlists in front of the SDK handler (it validates neither); no wildcard CORS; admin CSRF tokens and SameSite cookies (§7.3)                                                                                             | 1     |
| T8  | Prompt injection through upstream data (T/E)                   | 5 → 1    | Upstream text is returned as data, never interpreted as policy; output projection; no tool whose behaviour depends on upstream text (§6.4)                                                                                                 | 1–4   |
| T9  | Sensitive data over-exposure (I)                               | 1        | Default-deny sensitive reads; per-tag grants; redaction by schema. Phase 0 flagged surfaces: Wi-Fi `passphrase`, voucher `code`, Protect snapshot/RTSPS/talkback URLs, Access credentials and logs (coverage pages)                        | 2–4   |
| T10 | Console impersonation / TLS MITM (S/T)                         | 5        | TLS verification by default; per-console CA or pin. Access's 12445 listener uses a self-generated certificate (vendor-stated), so pinning is the expected path; insecure override per console, audited (§4.4, ADR 0005)                    | 1, 4  |
| T11 | Credential leakage in logs, errors or metrics (I)              | all      | Structured redaction; secrets never in URLs; error mapping drops upstream headers; no secret labels in metrics (§12)                                                                                                                       | 1     |
| T12 | Master key loss or substitution (D/T)                          | 6        | Fail closed on missing or wrong key; never generate over an existing DB; AEAD with record-bound AAD; rotation with verification (§8.2)                                                                                                     | 1     |
| T13 | Double execution / replay of writes (T)                        | 5        | Durable operation IDs, atomic state transitions, idempotency keys, `outcome_unknown` with read-back (§10)                                                                                                                                  | 1–2   |
| T14 | Upstream resource exhaustion (D)                               | 5        | Per-client/console/app limits; bounded queues; response size caps. Vendor rate limits are undocumented, so conservative defaults apply (§10, ADR 0005)                                                                                     | 1     |
| T15 | Container used as a pivot between networks (E)                 | host     | No forwarding/NAT, no `NET_ADMIN`, interface-bound listeners, egress allowlist, verified by container-network tests (§9.2)                                                                                                                 | 5     |
| T16 | Supply-chain compromise (T)                                    | build    | Exact pins + lockfile; `npm audit` clean (dev-only minimatch override, ADR 0002); no native addons (ADR 0004); vendor artefacts fetched only from allowlisted origins with checksum verification (ADR 0006); SBOM and image scanning (§14) | 0, 5  |
| T17 | Console-side exfiltration features invoked through the API (I) | 5        | Access webhook-endpoint writes (console pushes events to any URL), API certificate replacement, Touch Pass purchase and Protect permanent mic disable are proposed default-disabled even with write grants                                 | 2–4   |
| T18 | Physical-safety actions (E)                                    | 5        | Door unlock, emergency status, lock rules, relay/alarm/siren actuation: always high risk with human approval (§6.3)                                                                                                                        | 3–4   |

## Phase 0 findings that change the risk picture

1. **Network/Protect keys are unscoped as far as the vendor documents.** One leaked key
   may grant full administrative API access to the console, so this project's policy
   engine is the only least-privilege layer (ADR 0005). Operator guidance: a dedicated key,
   rotation, encrypted storage.
2. **The Access API has its own vendor-enforced scopes and token expiry.** Recommend tokens
   scoped to exactly what is granted, so vendor enforcement backs up this project's policy.
3. **Cloud connector URLs appear in every vendor OpenAPI document.** A contract test
   prevents them from becoming base URLs. Code review must reject `api.ui.com` in adapters.
4. **Access documents an inbound webhook model.** This project exposes no inbound webhook
   receiver: native events come only from documented outbound subscriptions (WebSocket),
   spec §11.
5. **Access and Network HTTP 200 is not success.** Access uses `{code: "SUCCESS"}`, and
   Network has a documented error body. Result mapping must check the documented shape,
   or an action could be reported as done when it was not (§4.4).

## Out of scope / accepted risks

- A malicious host administrator (§3.1, §12).
- Vulnerabilities in UniFi console firmware. The project limits what it asks a console to
  do; it cannot harden the console.
- Availability of consoles over VPN links. Disconnected consoles degrade gracefully (§12).
