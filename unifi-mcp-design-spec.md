# UniFi Local MCP — Architecture and Implementation Specification

**Status:** Implementation-ready design specification  
**Version:** 1.0-draft  
**Prepared:** 10 November 2026  
**Target implementers:** Codex, Claude Code, or a human TypeScript engineering team  
**Proposed project name:** `unifi-local-mcp` (working name; rename before publication if desired)  
**Licence:** Apache License 2.0

> **Instruction to the implementing agent:** Treat this document as the source of truth for agreed scope, security and acceptance criteria. Implement in the specified phases. Do not invent UniFi endpoints, infer an undocumented API contract, or silently broaden permissions. Where external documentation is incomplete, document the gap and mark the capability unsupported rather than improvising. For implementation details not specified here, make the smallest secure, well-tested choice and record it in an Architecture Decision Record (ADR).

---

## 1. Executive summary

Build an **independently operated, containerised Model Context Protocol (MCP) server** that connects to **official local UniFi application APIs**, exposing readable and controllable capabilities to Claude Code, Codex and other MCP-compatible clients. The AI client must connect to this server, not directly to UniFi. Credentials for UniFi never leave the server.

A single long-lived service supports multiple UniFi consoles reachable by LAN or VPN, including a dual-network deployment in which MCP clients reach one interface and UniFi consoles are reached through another. The service is offline-first. It supports **Streamable HTTP** and a **lightweight authenticated stdio bridge**. An optional independently authenticated web administration interface manages configuration, human approval and clients; CLI administration works without the web interface.

**Secure default:** read-only, least privilege, no unrestricted HTTP proxying to UniFi, no public-facing admin UI, no cloud access, and no execution of high-impact changes without independent human approval. The software is written in strict TypeScript/Node.js, packaged for Linux AMD64/ARM64, and structured for a potential public GitHub release.

### 1.1 Product goals

1. Offer comprehensive coverage of **officially documented local** read and write APIs for each supported UniFi application, progressively delivered by module.
2. Keep all UniFi keys inside trusted, self-hosted infrastructure; enforce server-side authorisation and redact sensitive outputs.
3. Make common operations intuitive via named MCP tools while allowing less common **registered** operations through validated discovery and execution tools.
4. Make support for multiple consoles, versions, clients, permissions and transport modes first-class.
5. Prevent accidental disruption by risk classification, concurrency controls, audited actions and independent approval.
6. Provide a complete operator manual and reproducible automated tests with each implementation phase.

### 1.2 Explicit non-goals

- **No Ubiquiti cloud/Site Manager API access** for control or discovery; VPN access to a local console is allowed.
- No undocumented/private/legacy reverse-engineered endpoints (even if a community project uses them).
- No remotely hosted third-party MCP relay and no transmission of UniFi credentials to AI harnesses or update services.
- No raw arbitrary URL/path/method proxy, arbitrary code execution, SSH control of consoles, or fallback web UI scraping.
- No autonomous approval of high-impact operations and no automatic production write tests.
- No broad background polling, full monitoring platform, cloud telemetry or required outbound internet access.
- No promise of capabilities for applications lacking an official local API; those remain future/unsupported modules.

### 1.3 Background and evidence (verified 10 Nov 2026)

Ubiquiti publishes **official local application APIs**, including versioned Network and Protect documentation and official Access API guidance. **No Ubiquiti-maintained official MCP server was found in the reviewed official documentation or Ubiquiti repositories** at the research date; absence cannot be proven exhaustively. Community MCP implementations exist but are not a dependency of this design. The latest documented TypeScript MCP SDK is **v2**, supporting the MCP 2026-07-28 protocol with compatibility mechanisms for older 2025-era clients. **Use the v2 server/client packages**, not the older v1-only quick-start dependency.

Source of truth for API endpoint paths/headers/schema is the **version-matched Ubiquiti documentation or officially published OpenAPI**. The API portal's sample requests may default to **cloud connector** URLs; implementations **must deliberately select the local base URL**. Do not copy `api.ui.com` routes into the local adapter.

References are enumerated in §19.

---

## 2. Confirmed architecture decisions — interview record

All entries below are **agreed requirements** unless an item is explicitly qualified as an implementation recommendation.

| # | Topic | Agreed decision |
|---|---|---|
| 01 | Application scope | Modular platform for all UniFi applications **with official local APIs**. |
| 02 | MCP transports | Streamable HTTP and stdio. |
| 03 | UniFi connectivity | Local APIs only; LAN and VPN accessible consoles. |
| 04 | Multi-console | Multiple independently configured consoles per service. |
| 05 | Permissions | Granular allow/deny by console, application and operation category. |
| 06 | MCP identity | One revocable token and identity per HTTP client. |
| 07 | Administration | Environment/YAML bootstrap and optional secured web UI. |
| 08 | API policy | Official, documented API endpoints only. |
| 09 | Write safety | Risk tiers; server-enforced two-step approval for high-impact writes. |
| 10 | Approver | Human independently approves via web UI or local CLI; never the AI. |
| 11 | Language | TypeScript/Node.js, official MCP SDK. |
| 12 | Client TLS | Built-in HTTPS or trusted reverse-proxy TLS termination. |
| 13 | Dual network | Strict separation of client-side ingress and console-side egress; no forwarding. |
| 14 | Events | On-demand operations plus native event subscriptions where official APIs provide them. |
| 15 | Persistence | Embedded SQLite in a persistent Docker volume, YAML/env for bootstrap. |
| 16 | stdio | Lightweight authenticated bridge to central persistent service. |
| 17 | Audit | All read, write, denied and admin operations; redact secrets/sensitive data. |
| 18 | Tool layout | Named common tools plus validated generic discovery/execution. |
| 19 | Development | Phased: platform, Network, Protect, Access/other applications, release. |
| 20 | Containers | Linux AMD64 + ARM64 multi-arch. |
| 21 | Live tests | Mocked API tests plus **optional live read-only** tests; no unattended live writes. |
| 22 | UniFi TLS | Verify by default; custom CA/pinning; explicit per-console insecure override. |
| 23 | API versions | Version-aware adapters, capability detection, explicit unsupported outcomes. |
| 24 | Admin bootstrap | Local CLI creation and recovery; no default administrator credentials. |
| 25 | Client scope | Per-client console/app/operation scopes intersected with wider policies. |
| 26 | Sensitive reads | Granular data permissions; minimise and redact by default. |
| 27 | Master key | Prefer Docker secret/read-only file, allow env fallback; rotate/recover safely. |
| 28 | Licence | Apache License 2.0. |
| 29 | Read-only safety | Runtime toggle plus immutable deployment-level `FORCE_READ_ONLY` override. |
| 30 | Coverage depth | Comprehensive official read/write API coverage, phased and tracked. |
| 31 | Admin listener | Separate ports/binds; loopback-only by default. |
| 32 | MFA | Optional TOTP, recovery codes and recent reauthentication; configurable mandatory. |
| 33 | Observability | Docker health checks, structured JSON logs, optional Prometheus metrics. |
| 34 | Distribution | Local builds and optional GHCR CI/CD, publishing disabled until configured. |
| 35 | Config ownership | YAML/env bootstrap, SQLite operational authority, deployment security overrides. |
| 36 | Post-approval | Original agent explicitly resumes; revalidation, single use, short expiry. |
| 37 | Internet | Offline-first, with explicitly enabled release/compatibility checks only. |
| 38 | Documentation | Markdown in repository, maintained with code. |
| 39 | Discovery | Per-client permission-filtered tool list, refreshed where protocol allows. |
| 40 | Concurrency | Per-client/console/app limits, bounded queues, conflict protection, safe retry. |

---

## 3. Reference architecture

```text
  Claude Code                 Codex                Other MCP clients
      |                        |                          |
      +--------- Streamable HTTPS (client network) ------+
      |                                                   |
      +--> optional local stdio launcher/bridge ---------+ |
                                                           v
                    +-------------------------------------------+
                    | UniFi Local MCP (long-lived container)   |
                    |                                           |
                    | MCP HTTP listener  -- client auth        |
                    | stdio bridge endpoint -- client auth     |
                    | tool registry / capability discovery     |
                    | request parsing + schema validation      |
                    | policy engine + data redaction           |
                    | risk engine + approval workflow          |
                    | scheduler / concurrency / retries        |
                    | per-app versioned adapters                |
                    | audit + metrics + event manager           |
                    | SQLite + encrypted secret records         |
                    |                                           |
                    | admin HTTPS listener (separate bind)      |
                    | local CLI (bootstrap/recovery/approval)   |
                    +----------+-------------------+------------+
                               |                   |
                      egress on UniFi             persistent
                      management interface       Docker volume
                               |
                      LAN / routed VPN only
                               |
                 +-------------+-------------+
                 |                           |
           UniFi console A              UniFi console B
         Network / Protect            Network / Protect /
         ... documented apps           Access / ...
```

### 3.1 Process model

- **Central service:** one authoritative instance owns the SQLite database, encryption key, operation execution, approvals, event subscriptions and audit trail. Do not mount the same writable SQLite database into independently running service instances.
- **HTTP MCP:** independently authenticated client connections. Use a common execution dispatcher regardless of transport.
- **stdio bridge:** a lightweight *local client process* speaks stdio to its harness and forwards protocol calls over an authenticated MCP Streamable HTTP connection to the central service. It has **no direct UniFi connectivity or SQLite access** and no ability to configure the service. Each bridge has its own token/client identity.
- **Admin UI/API:** separate from the MCP listener. Browser users authenticate independently from MCP clients.
- **CLI:** uses local OS/container administrative execution context. CLI access is trusted as host administration; never expose CLI-only recovery/approval functions as MCP tools.
- **Events:** central service maintains only documented upstream subscriptions. Downstream clients receive notifications/subscriptions as supported by their negotiated MCP protocol version; no guarantees of historical event delivery after downtime unless explicitly implemented and documented.

### 3.2 Transport compatibility

Use official **TypeScript MCP SDK v2** packages, currently `@modelcontextprotocol/server`, `@modelcontextprotocol/client` and supported transport packages. Pin tested versions in a lockfile and revisit API imports against the specific pinned SDK documentation.

The MCP **2026-07-28** revision has a stateless HTTP core, newer discovery/subscription mechanisms and request headers. Earlier clients use the **2025-era** initialisation/session model. Support both with the SDK's documented compatibility entry points, and build protocol compatibility tests for both eras. Never assume all Codex or Claude Code releases implement the newest features. For change notifications, support 2026 subscription surfaces where negotiated and legacy notifications where negotiated; reconnect/refresh is an acceptable documented fallback.

**Security invariant:** the authenticated identity comes solely from the issued bearer token/mTLS-trusted external gateway if implemented later, **not** from any model-supplied `clientId`, MCP metadata, tool arguments or HTTP header that the client can forge.

---

## 4. Official UniFi API integration contract

### 4.1 Module eligibility

An application module is **eligible** only if Ubiquiti has published an official locally callable API, with usable authentication and a sufficiently specified contract. Document **source URL**, **application version**, **API revision**, **official authentication scheme**, **local endpoint base**, and **test evidence** for every adapter.

Initial module roadmap:

| Module | Initial status | Gate to implementation |
|---|---|---|
| `network` | Phase 2 — first full module | Official Network API and matching OpenAPI/source snapshots verified. |
| `protect` | Phase 3 | Official local Protect API and documented event endpoints verified. |
| `access` | Phase 4 | Official UniFi Access OpenAPI/integration guide verified **for installed application version**; authentication may differ. |
| `talk` / `connect` / other | Future plugin slots, disabled | Add only after existence of an official **local** API is verified. |

**Do not confuse a product's ordinary service ports or internal browser API with an officially supported integration API.** The official Access API may use an independently configured HTTPS/OpenAPI listener and distinct authentication; do not assume Network paths, ports or credentials apply universally. For a missing contract, show `unavailable: official_local_api_not_documented`.

### 4.2 Console model

A console record contains:

- Stable internal `consoleId` (UUID), human-readable alias, optional description; no assumed global “default” console if multiple are configured.
- HTTPS hostname/port, resolved management-network route and TLS trust method.
- Enabled modules and their application base paths and API credential references; modules can have distinct credential types.
- Console-specific allow/deny policy, maintenance/restriction labels and enabled sites.
- Last successful capability probe/version observation, validated API versions and connectivity status.

**Every state-changing tool must explicitly specify `consoleId`, and `siteId` where applicable.** Read tools should do the same except an authorised `list_consoles` discovery operation. Aliases are resolved to immutable IDs at the boundary. No default target substitution for missing or ambiguous targets.

### 4.3 Versioned operation registry

Maintain an explicit versioned registry of every supported operation:

```ts
interface OperationDescriptor {
  operationId: string;                     // e.g. network.list_networks
  moduleId: string;                        // network | protect | access | ...
  documentationUrl: string;
  apiVersionRange: string;                 // validated adapter compatibility
  httpMethod: 'GET'|'POST'|'PUT'|'PATCH'|'DELETE';
  pathTemplate: string;                   // fixed template from official docs
  inputSchema: unknown;                   // compiled runtime schema
  outputSchema: unknown;                  // compiled or validated output
  category: string;                       // networks, devices, firewall, ...
  effect: 'read'|'write';
  risk: 'low'|'medium'|'high';
  sensitivityTags: string[];
  permission: string;                     // explicit policy action
  resourceLockKey: string;                // derived, not client-specified
  retryClass: 'safe-read'|'idempotent'|'non-idempotent';
  approvalRequired: boolean;              // true for high risk
  namedTool?: string;
  outputProjection?: string;
}
```

Keep generated API schemas and handwritten *security metadata* separate: a generated spec must **never** silently change permissions, risk or sensitivity classes. Newly discovered operations default to **disabled** until reviewed, categorised and tested. Version snapshots are checked in with provenance and revision/checksum, subject to vendor terms and copyright. Prefer official OpenAPI artifacts where published. Build `scripts/reconcile-api-coverage` to list added/removed/changed official operations and fail CI for unreviewed changes.

### 4.4 Path, parameter and response safety

- Resolve only a **configured console ID**, then an **allowlisted module base** and **registered operation path template**. No arbitrary URL, free-form URL parameter or redirect to a new host.
- Validate path/query/body with exact schemas, length/range constraints, sanitised identifiers and required site ownership. Encode path parameters as path segments.
- Fixed supported HTTP methods; no user-controlled headers, custom host, absolute URLs or raw request override.
- Disable redirects by default; reject unexpected redirect/location changes. Enforce private-address/VPN endpoint allowlisting, DNS re-resolution protection and connection destination validation (SSRF prevention).
- TLS verify by default. Custom CA and **explicitly verified** pinned certificate/public key are supported. Explicit insecure override is per-console, audited, conspicuously warned and never inherited globally.
- Bound timeouts and response body size, pagination, output field projection and binary transfers. Never include API key in an exception, redirect, URL, metric, tool result or log.
- Interpret both HTTP status and any officially documented application error structure. Never treat an HTTP 200 as guaranteed success without checking the documented response shape.
- Only expose documented event subscriptions, not internal WebSocket channels.

### 4.5 Coverage matrix

`docs/api-coverage/<app>/<version>.md` and a machine-readable `api-coverage.json` must inventory **each official operation**: supported/unsupported, path, revision, source URL, named/generic tool exposure, permission, risk, sensitivity, schema validation, mock tests and optional live-read validation. **Comprehensive coverage is a target measured against official documentation, not a claim based on counting hand-written tools.** The module cannot be accepted without reconciling the complete documented operation list or explicitly recording each gap and its reason.

---

## 5. MCP tools, resources and discovery

### 5.1 Common named tools (illustrative names, not undocumented UniFi endpoint claims)

- `unifi_list_consoles` — only consoles visible to this client; minimal metadata.
- `unifi_list_sites` — site list for a permitted console.
- `unifi_list_modules` — installed/enabled module capabilities and compatible versions, filtered by scope.
- `unifi_list_operations` — registered and authorised operations, with pagination/filtering.
- `unifi_describe_operation` — validated input schema and constraints for an authorised operation.
- `unifi_execute` — execute **only** a registered, authorised operation ID with typed arguments.
- `unifi_get_operation_status` — status of this client's pending/approved/executed action; no ability to approve.
- `network_list_devices`, `network_get_device`, `network_list_clients`, `network_list_networks` — *only where supported by the verified official API version*.
- Further module-specific named tools determined from coverage and usability tests.

Do not expose `http_request`, `proxy_request`, `eval`, `execute_sql`, shell commands or wildcard raw API calls through MCP. A method that cannot be mapped to a reviewed registry descriptor is unavailable.

### 5.2 Generic `unifi_execute` request

```json
{
  "consoleId": "<configured-console-uuid>",
  "siteId": "<official-site-id-when-required>",
  "operationId": "network.list_networks",
  "arguments": { "limit": 25, "offset": 0 }
}
```

Return a stable envelope: `status`, `operationId`, `consoleId`, `siteId`, `data` (minimised), `pagination` where relevant, `correlationId`, and actionable but non-sensitive `error` fields. Do **not** return raw upstream response headers or credentials. Read results should use MCP structured content where supported; ensure compatibility with clients consuming text content.

### 5.3 Discovery guarantees

- `tools/list` and operation discovery must be evaluated for **the authenticated client**, permitted console(s), module(s), API versions, operation categories, sensitive-data scopes and the global hard lock.
- Read-only clients do not see executable write tools. Generic execution must enforce the identical policy at invocation time.
- Under a hard read-only lock, write tools do not appear and **all** execution paths deny writes, including queued/approved actions.
- Recalculate when a token is revoked, permissions change, modules change, hard lock changes or supported APIs change. Emit protocol-era-appropriate refresh notifications/subscriptions when possible; document reconnect guidance for clients that cache their tool lists.
- Scoped catalogue results must use private/client-aware cache semantics, not shared/public caching.
- Provide bounded page sizes and concise descriptions to reduce context usage by AI clients.

---

## 6. Authorisation, sensitive data and safety

### 6.1 Effective permission model

Evaluation order (deny always wins):

1. Authenticate calling MCP token and check revocation/expiry.
2. Authorise console and site membership for the token.
3. Enforce deployment `UNIFI_MCP_FORCE_READ_ONLY` hard lock, when request is a write.
4. Enforce runtime global read-only/read-write switch.
5. Enforce console and module state (`disabled`, `read-only`, `read-write`).
6. Evaluate global, console, application, operation-category and per-client allow/deny policies **by intersection**, with default-deny for writes and sensitive reads.
7. Require the validated operation to exist and to be supported by this console's API version.
8. Validate data sensitivity scopes, risk tier and approval state.
9. Recheck policy at point of execution, after queuing and after approval.

No flag in the MCP tool arguments can upgrade this authority. Policies are applied server-side, even if tool discovery has stale cached output.

**Default state:** global read-only, no write grants, no sensitive-read grants, no high-impact approval exemptions. An administrator may give selected clients non-sensitive read scopes explicitly. A server with no configured console must still start in a safe setup state.

### 6.2 Example policy (illustrative schema; final validated YAML contract required)

```yaml
security:
  runtime_mode_default: read_only
  default_effect: deny
  sensitive_data_default: deny
consoles:
  - id: home-unifi
    enabled_modules: [network, protect]
    policy:
      network:
        reads: allow
        writes: deny
      protect:
        reads: allow
        writes: deny
clients:
  - id: codex-workstation
    consoles: [home-unifi]
    scopes: [network.devices.read, network.clients.read]
```

For actual data storage, keep immutable IDs distinct from aliases. Define and document schema precedence, migration and validation; reject ambiguous or conflicting declarations. Do not include live secrets in the example.

### 6.3 Risk classification

| Risk | Examples (conditional on official endpoints) | Default behaviour |
|---|---|---|
| Low | Read operational metadata; benign reversible label changes | Read when authorised; low-risk write only if explicitly granted. Audit. |
| Medium | Change a client association or Wi-Fi setting with limited impact | Explicit write grant, schema checks, resource locks, change audit; no independent approval unless elevated by policy. |
| High | Firewall/VLAN routing, management access, gateway/device reboot, device adoption/removal, destructive changes, Access unlock, disabling security functions | Explicit write grant **and** independent human approval and original-client resume. |

**Irreversible/high-consequence operations** (such as permanently disabling a camera microphone if officially documented) must be classified high and may be additionally disabled by default. Physical access/unlock actions require high risk regardless of an endpoint's HTTP verb. Treat all undocumented or unclassified writes as prohibited. Risk classifications are reviewed in code, cannot be lowered via an MCP request, and can be elevated administratively.

### 6.4 Sensitive-data policy

- Define tags such as `personal_identifier`, `network_identity`, `camera_image`, `recording`, `access_log`, `credential`, `location`, `biometric_or_access_identity`.
- Deny secrets to **all** clients; secrets are never available through read tools, debug tools or admin API responses.
- Return minimal identity/network telemetry by default. Additional fields/content require independent sensitive-read grants.
- Protect snapshots/recordings and Access histories are explicitly scoped and have content size/time restrictions; no indiscriminate bulk dump.
- Audit stores operation metadata and safe identifiers/hashed payload summaries, not complete sensitive reads or image/video data. Redact request/response bodies by schema and known key patterns before any logging.
- Treat upstream descriptions, client names, camera labels and event text as **untrusted data**, never as instructions or policy inputs.

### 6.5 High-impact human approval workflow

```text
AI calls registered high-risk operation
  -> authenticate + validate + authorise + classify
  -> prepare canonical immutable proposal
  -> persist pending approval with short TTL
  -> return pendingApprovalId + safe human-readable diff
  -> human reviews and approves via admin web UI or local CLI
  -> approval bound to exact proposal, client, console, site,
     action, arguments digest, security-policy version and expiry
  -> original client explicitly calls 'resume' with approval ID
  -> recheck token, permissions, hard lock, version, resource
     identity/preconditions and expiry; acquire relevant lock
  -> execute at most once; reconcile result; full audit trail
```

No MCP-accessible tool may approve a proposal. Administrator approval requires a recent authenticated session (and TOTP if enabled/required) or locally privileged CLI session. **Separate the approval action from the execution action.** Proposed starting defaults: request expires after 10 minutes pending review; approved execution window 2 minutes; both configurable downward by deployment policy. Single-use, cryptographically unpredictable IDs; avoid exposing an approval *secret* to an AI client. Any changed parameters, target, client scope or policy invalidates the prior approval. Atomic compare-and-set state transitions prevent double execution. Approvals in the database never override hard read-only mode.

If the console state has changed since preparation (ETag/version/field snapshot where the official API supports it), re-propose instead of applying a stale high-risk action. If the API provides no concurrency precondition, disclose this limitation and be especially conservative.

---

## 7. MCP-client authentication and admin authentication

### 7.1 MCP client tokens

- Generate **distinct high-entropy opaque bearer tokens** per client (minimum 256-bit randomness); present plaintext once at issuance.
- Store only a non-reversible verification value, e.g. keyed digest or SHA-256 of high-entropy random token, using constant-time comparison. Store client ID, scopes, creation, last use, expiry, enabled/revoked flags and token identifier.
- Do not accept client ID supplied by an AI tool as authentication. A stdio bridge token is scoped like any other HTTP token.
- Admin CLI and UI can create, rotate and revoke tokens without a service restart; revocation takes effect promptly on existing connections and subscriptions.
- Rate-limit unsuccessful authentication; never log bearer credentials.
- Do not send bearer tokens over non-loopback plaintext HTTP. Reverse proxy mode requires an authenticated trusted proxy with proven network isolation and correct forwarded-header handling.
- Scope the service to use local machine/VPN connectivity; never assume an OpenAI-hosted or Claude-hosted process can reach private addresses. The caller/bridge must be network-reachable to the MCP endpoint.

### 7.2 Administration identities

- First administrator created with local CLI (`admin bootstrap`) in an interactive, local host/container context; no default credential and no remote setup wizard.
- Passwords hashed with Argon2id (review current recommended parameters); protect against enumeration and brute force. Admin API uses secure, HttpOnly, SameSite session cookies, CSRF protections for state changes and TLS.
- Optional TOTP MFA with encrypted TOTP secrets, one-time hashed recovery codes, mandatory recent reauthentication for high-impact approvals and critical security changes; operator may require MFA globally.
- CLI `admin reset` and disaster recovery require host-level authority and are always audited. CLI approval must prove local administrator authentication or verified host privilege; never provide that path to an AI client or stdio bridge.
- Admin UI session policy: idle timeout, absolute lifetime, logout/revocation, rate limiting and security event audit.

### 7.3 Web listeners and reverse proxy

- **MCP listener and admin listener are independent**, with separate bind addresses/ports/certificates and distinct authentication middleware.
- Admin service defaults to **local-only exposure**. In Docker, clarify the distinction between **container loopback** (`127.0.0.1` inside container) and host-local published ports (`127.0.0.1:HOST_PORT:CONTAINER_PORT`): the latter requires the container service to listen on an accessible container interface. Provide separate safe deployment examples rather than assuming Docker's port publishing reaches a loopback-bound process.
- Allow explicit management-network exposure only with authenticated HTTPS and network ACLs.
- Support built-in TLS with mounted cert/key, or an explicitly trusted reverse proxy that terminates TLS. Never trust arbitrary `X-Forwarded-*` headers; define trusted proxy CIDRs and use proxy-aware origin/host checks.
- Check Host/Origin, DNS-rebinding and cross-origin policy as required by MCP HTTP transport. Do not enable wildcard CORS or unauthenticated administrative paths.
- Health and metrics paths are separately configured; readiness must not leak console identifiers or secret state to unauthenticated callers.

---

## 8. Secret management and persistence

### 8.1 Configuration precedence

1. **Immutable deployment security overrides**, notably `UNIFI_MCP_FORCE_READ_ONLY` and network listener/access restrictions.
2. **Database-managed operational settings** (authoritative after first successful bootstrap).
3. **YAML/environment bootstrap** values used to initialise missing configuration, not silently overwrite database choices after restart.

Define precisely which environment variables are true deployment overrides versus bootstrap-only values. Expose effective configuration (with secrets redacted) via local CLI/admin UI. Detect and warn on stale bootstrap fields. Support explicit idempotent `config import --dry-run` / `config apply` administrative commands instead of surprise reconciliation.

### 8.2 SQLite

- Store database under `/data` persistent volume; one central writer. WAL/transaction mode tuned for the filesystem, busy timeout, migrations under transaction, integrity checks, safe backups, retention and pruning.
- Suggested tables: `schema_migrations`, `admins`, `admin_sessions`, `mfa_recovery`, `clients`, `client_tokens`, `consoles`, `console_modules`, `secret_records`, `policies`, `operations_catalog`, `capability_snapshots`, `approval_requests`, `operation_executions`, `audit_entries`, `event_subscriptions`, `app_settings`.
- Encrypt **credential-bearing/sensitive fields** before writing to SQLite, with AEAD such as AES-256-GCM: random nonce per record, authenticated associated data binding type/record ID, versioned ciphertext format and key identifier.
- The master encryption key is stored separately, preferably a Docker secret or **read-only mounted key file**; environment-variable fallback explicitly documented as less isolated.
- A missing/wrong key must fail closed with an actionable error: **never silently generate a new key over an existing database**.
- Key rotation: preserve access to old key until all records successfully re-encrypted, verify counts/checksums, commit transactionally and document backup/recovery. Database backup alone must not restore encrypted credentials without the backed-up key.
- Document permissions, restore validation and failure modes. Audit records may contain sensitive *metadata* and should be included in retention/privacy policy.

### 8.3 Example `.env.example` — **illustrative, non-secret values only**

```dotenv
NODE_ENV=production
UNIFI_MCP_DATA_DIR=/data
UNIFI_MCP_FORCE_READ_ONLY=true
UNIFI_MCP_HTTP_BIND=0.0.0.0
UNIFI_MCP_HTTP_PORT=3000
UNIFI_MCP_ADMIN_ENABLED=false
UNIFI_MCP_ADMIN_BIND=127.0.0.1
UNIFI_MCP_ADMIN_PORT=3001
UNIFI_MCP_MASTER_KEY_FILE=/run/secrets/unifi_mcp_master_key
UNIFI_MCP_METRICS_ENABLED=false
UNIFI_MCP_ONLINE_CHECKS_ENABLED=false
UNIFI_MCP_LOG_LEVEL=info
```

Use a documented listener and host-port-publishing strategy; **the `HTTP_BIND=0.0.0.0` example is safe only if host-level bind/firewall/TLS controls enforce the intended exposure**. Example files must never include real API keys, passwords, tokens, encryption keys, deployment hostnames or sensitive addresses. Put `.env`, `/data`, `*.db*`, credential files, TLS private keys and logs in `.gitignore` / `.dockerignore` as appropriate.

---

## 9. Single-interface and dual-interface networking

### 9.1 Single-interface Docker example

Ship `deploy/compose.single.yml` as a ready-to-edit reference:

- Service attaches to one user-created Docker network.
- Publish MCP and optional admin ports on host loopback by default, then explicitly configure routable exposure as needed.
- Read-only or Docker-secret master key, persistent `/data`, explicit least-privilege user, read-only root filesystem, tmpfs for `/tmp`, `no-new-privileges`, dropped capabilities, resource limits and Docker healthcheck.
- No `network_mode: host`, privileged container or Docker socket mount by default.
- Admin web UI disabled unless enabled, and never accidentally accessible merely because MCP port was published.

### 9.2 Dual-interface Docker example

Ship `deploy/compose.dual.yml` and `docs/networking.md`:

- `mcp_client_net`: only for MCP client ingress; exposed MCP listener bound to the selected client-side container IP/address.
- `unifi_management_net`: outbound HTTPS/API access to allowlisted console addresses over LAN/VPN; optional specifically configured admin management ingress if chosen.
- No Linux packet forwarding, IP masquerading, network bridge/repeater services, wildcard listening on the wrong interface, or `NET_ADMIN` capability.
- `net.ipv4.ip_forward=0` and IPv6 forwarding disabled where available and compatible; host-level ACL/firewall and Docker network isolation are part of the security boundary. Merely using two NICs is **not sufficient** to enforce isolation.
- Restrict management-side outbound destinations to configured UniFi console addresses/ports, plus opt-in allowlisted update endpoints if enabled. No generic routing/tunnelling between networks.
- Prove egress selection via explicit route/destination tests; bind/source-address control or dedicated routing policy may require host-level Docker network setup. **Do not grant container network-admin privileges just to configure routing inside it.**
- Validate source IP and DNS results before connecting; ensure an application-level request cannot redirect egress to an arbitrary client-side IP.
- Provide a diagram and operator commands for verifying no forwarding and validating ingress/egress in both IPv4 and IPv6 environments.

**Acceptance:** a client on the MCP network can call a permitted MCP read tool but cannot use the container as a TCP proxy, reach an arbitrary management host, or reach the admin UI unless independently authorised and explicitly exposed.

### 9.3 VPN and disconnected agents

A remote/local AI harness must be able to reach the MCP **client-side endpoint** or run the stdio launcher on a machine that can. The MCP reaches UniFi over LAN/VPN. No claim that stdio bypasses network reachability. Document certificates/hostnames, split DNS, routes and firewall policy for VPN-connected consoles.

---

## 10. Concurrency, execution correctness and API protection

- Configurable **per-client, per-console, per-application and global** rate limits. Prefer conservative defaults and adapt to published vendor limits when documented.
- Bounded queues with deadlines/cancellation, fair scheduling and clear `rate_limited`, `queue_full`, `deadline_exceeded` responses. No unbounded in-memory backlog.
- Lock state-changing operations by computed resource ID and operation family; serialise conflicting writes to same console/site/resource where necessary.
- Validate auth/policy **on enqueue** and again **just before dispatch**.
- For GET/read, bounded retry with jitter and exponential backoff for transient failures; respect upstream `Retry-After` if documented.
- For **writes**, retry automatically **only if operation semantics and an idempotency mechanism make it provably safe**. If a timeout leaves execution uncertain, record `outcome_unknown`, attempt documented read-back reconciliation, and require human intervention/review if still unresolved.
- Persist durable operation IDs/approved proposal states. Use atomic transitions to prevent duplicate execution after process restart or double-call.
- Requests with a repeated idempotency key return the known result/status rather than re-executing. Do not treat a client-provided idempotency key as a substitute for server verification.
- Only permitted clients can query their own operation status; admins can see all in the admin UI. Cancel pending-but-unexecuted work on token revocation, hard lock or policy invalidation.
- Cap payload sizes, pagination and response processing time to protect the server from large UniFi API responses.

---

## 11. Event subscriptions

- Implement a per-application `EventAdapter` only for **officially documented** local event/WebSocket/subscription APIs. Protect has documented WebSocket update/event surfaces; Network and other applications must independently prove equivalent supported APIs before enabling native events.
- Connection manager handles reconnect/backoff, credential changes, bounded queues, heartbeat/idle detection, source reconnection, fan-out to authorised client subscriptions and shutdown.
- Events use the same client-sensitive-data scopes, console/site permissions, redaction and audit requirements as ordinary reads.
- Do not silently start polling to imitate events. No external message broker, monitoring platform or always-on history store required.
- If a client's MCP protocol or SDK does not support suitable notifications, document a standards-compatible degraded mode (e.g. on-demand `list_recent_events` **only if an official endpoint exists**, or event capability unavailable). Do not invent event replay guarantees.
- Add tests for subscription expiry, token revocation, client disconnect, upstream disconnect, reconnect storms, redaction and slow consumers.

---

## 12. Observability and data retention

- Structured JSON logs to stdout/stderr; no stdout debug chatter in the **stdio bridge** because stdout is reserved for MCP protocol frames.
- Fields: UTC timestamp, severity, correlation ID, client identifier (non-secret), console/module/operation IDs (as policy permits), outcome, duration and error code. Never log authorization bearer tokens, UniFi API credentials, sensitive response bodies, cookies or TOTP values.
- Persistent immutable-in-app audit entries for **all** MCP reads/writes, permission denials, admin logins/security changes, approval decisions and important failures. Hash-chain or tamper-evident audit export is a desirable hardening enhancement; host administrators remain trusted and can modify local files.
- Configurable audit retention/rotation. Proposed starting defaults: keep audit metadata 90 days, structured runtime logs delegated to the container log driver; expose these values in admin UI and CLI. Storage exhaustion must fail safely for write/audit-critical operations rather than proceed with no audit trail.
- Docker healthcheck distinguishes **liveness** (process running) from **readiness** (database/migrations/server usable). A disconnected optional console should not always cause the entire container to restart.
- Optional authenticated/management-only Prometheus endpoint: request counts/latencies, queue depth, error rates, API/connectivity health, event subscriptions, active MCP clients and DB health. Avoid IP/MAC addresses, client names, unbounded labels, secrets and personal information.
- Document example Prometheus scrape configuration and Grafana dashboard queries without requiring Prometheus to run inside the container.

---

## 13. Web administration and local CLI

### 13.1 Web interface minimum pages

1. **Dashboard:** service mode, hard-lock indicator, module health, console health, listener status and errors.
2. **Consoles:** add/edit/remove, test connection, TLS trust/pins, enabled modules/sites, API versions and credentials (write-only secret fields).
3. **MCP clients:** issue/rotate/revoke tokens, audit last use, assign scopes, verify effective permissions; token displayed **once**.
4. **Policy editor:** global read-only toggle, console/module/operation grants/denials, sensitivity grants, risk rule elevation and permission preview.
5. **Approvals:** pending, safe proposed diff, initiator/target/expiry, approve/reject; recent-auth requirement; **no automatic execution**.
6. **Audit:** searchable/filterable events, pagination and export with redaction.
7. **Settings/maintenance:** backup/restore guidance, API-compatibility data, events, metrics, update-check toggle, effective configuration and troubleshooting.

Use server-side access checks on every admin endpoint, CSRF protection, CSP, secure cookie flags, output escaping and no credentials in HTML/JS API responses. UI must never be required for normal headless runtime.

### 13.2 CLI minimum commands (names are provisional; keep documented/consistent)

```text
unifi-mcp admin bootstrap
unifi-mcp admin reset-password
unifi-mcp admin reset-mfa
unifi-mcp client create|list|rotate|revoke
unifi-mcp console add|list|check|disable
unifi-mcp policy show|validate|set-runtime-mode
unifi-mcp approvals list|show|approve|reject
unifi-mcp config validate|show-effective|import|apply
unifi-mcp crypto generate-key|rotate-key
unifi-mcp db backup|restore|check
unifi-mcp doctor
unifi-mcp api coverage
```

`--dry-run` for import/permission changes where possible. No administrative functions exposed to an ordinary MCP client. CLI is permitted to be invoked with `docker exec` by a **human host administrator**, not by an AI harness granted access to the Docker socket.

---

## 14. Packaging, dependency management and supply chain

- TypeScript strict mode; supported current Node.js LTS line, version pinned and documented at implementation time. Prefer npm workspaces + locked dependencies; consider `pnpm` only with explicit rationale and locked versions.
- MCP TypeScript SDK **v2**. Pin versions of SDK, HTTP framework, SQLite driver, schema validator (e.g. Zod 4), test framework and UI framework; avoid unnecessary dependencies.
- Build multi-stage Docker images for `linux/amd64` and `linux/arm64`; small runtime image, non-root user, explicit writable volumes, no compiler/build secrets in final layer, `HEALTHCHECK`, graceful shutdown and signal handling.
- SQLite native module compatibility must be tested for both CPU architectures (or use a supported runtime SQLite solution with reproducible packaging). Never silently install prebuilt binaries from untrusted URLs during runtime.
- Prefer immutable package/image versions and SHA digest pinning in deployment examples; document reproducible local builds and software bill of materials (SBOM).
- CI: formatting/lint/typecheck/unit/contract tests, container build, SCA/dependency alerts, secret scanning, container vulnerability scanning, architecture checks and release provenance where available.
- GHCR release publishing **disabled until explicit opt-in/configuration**; releases use SemVer, changelog, signed tags/images if feasible, and migration/rollback instructions.
- Repo must contain no production data, console IPs, private keys, copied proprietary docs beyond allowed terms or generated credentials.

---

## 15. Suggested repository layout

```text
unifi-local-mcp/
├── LICENSE
├── NOTICE
├── README.md
├── CHANGELOG.md
├── CONTRIBUTING.md
├── SECURITY.md
├── CODE_OF_CONDUCT.md
├── AGENTS.md                       # instructions for Codex/Claude and contributors
├── .env.example
├── .gitignore
├── .dockerignore
├── package.json
├── package-lock.json
├── tsconfig.base.json
├── Dockerfile
├── deploy/
│   ├── compose.single.yml
│   ├── compose.dual.yml
│   ├── compose.tls.yml
│   ├── example-bootstrap.yaml
│   └── example-reverse-proxy.md
├── packages/
│   ├── core/                       # operation registry, validation and dispatch
│   ├── policy/                     # permissions, risk and sensitivity
│   ├── approvals/                  # prepare/approve/resume state machine
│   ├── storage/                    # SQLite, migrations, crypto, backup
│   ├── unifi-api/                  # HTTP transport, console registry, TLS, versions
│   ├── unifi-network/              # first official API adapter + operation metadata
│   ├── unifi-protect/              # second adapter + documented events
│   ├── unifi-access/               # conditional on verified official contract
│   ├── mcp-server/                 # MCP protocol handlers + Streamable HTTP
│   ├── stdio-bridge/               # authenticated MCP stdio-to-HTTP bridge
│   ├── admin-api/                  # separate admin endpoints and auth
│   ├── admin-ui/                   # optional web interface bundle
│   ├── cli/                        # host-only administration commands
│   └── telemetry/                  # audit, logging, health, Prometheus
├── api-specs/
│   ├── README.md                   # provenance/terms and source checksums
│   └── <application>/<version>/
├── docs/
│   ├── index.md
│   ├── quickstart.md
│   ├── installation.md
│   ├── configuration.md
│   ├── networking.md
│   ├── security.md
│   ├── approval-workflow.md
│   ├── administration.md
│   ├── client-claude-code.md
│   ├── client-codex.md
│   ├── client-generic-mcp.md
│   ├── applications-network.md
│   ├── applications-protect.md
│   ├── applications-access.md
│   ├── events.md
│   ├── monitoring.md
│   ├── backup-restore.md
│   ├── troubleshooting.md
│   ├── development.md
│   ├── release.md
│   ├── api-coverage/
│   └── adr/
├── tests/
│   ├── fixtures/                   # sanitised, synthetic only
│   ├── unit/
│   ├── contract/
│   ├── security/
│   ├── integration-mock/
│   ├── integration-live-readonly/  # disabled unless explicitly enabled
│   ├── mcp-compatibility/
│   └── container-network/
├── scripts/
│   ├── reconcile-api-coverage.*
│   ├── generate-coverage-report.*
│   ├── seed-synthetic-fixtures.*
│   └── verify-release.*
└── .github/
    ├── workflows/ci.yml
    ├── workflows/container-build.yml
    ├── workflows/release.yml       # publish gated/disabled initially
    ├── dependabot.yml
    └── ISSUE_TEMPLATE/
```

This is a *target logical layout*; adjust implementation details only with an ADR and preservation of boundaries. Avoid needlessly publishing many npm packages: workspaces can remain private modules within one repository and container.

---

## 16. Build phases, deliverables and acceptance gates

### Phase 0 — Research and contract baseline

**Tasks:** confirm official local API availability by application; verify Network 11.0.97 documentation and source artefacts, distinguish local from cloud examples, verify SDK v2 APIs and selected Node LTS. Record official Access integration guidance, local auth and port requirements. Create API/version/source inventory and ADRs.

**Deliverables:** `docs/adr/0001-*`, `api-specs/README.md`, initial API coverage inventory, threat-model notes, dependency lockfile and repo skeleton.

**Gate:** no undocumented endpoints in roadmap; local authentication and URL bases documented by official sources; unverified assumptions explicitly flagged.

### Phase 1 — Secure platform core

**Tasks:** create MCP HTTP server, stdio bridge, identity/token store, SQLite migrations, secret encryption, console registry, policy engine, read-only hard lock, operation registry, risk/approval state machine, CLI bootstrap/recovery, optional admin UI, audit, health, safe Docker examples and mock API fixtures.

**Gate / required tests:** 

- Connect from both 2025-era and 2026-era compliant MCP test clients over Streamable HTTP and stdio.
- Two differently scoped tokens receive different tool lists; revocation blocks subsequent calls and subscriptions.
- No configured console: server starts safely, no write tools available.
- Hard read-only lock denies a registered write, **including** direct `unifi_execute`, queued work and a previously approved action.
- Generic operation cannot invoke an unregistered path, alternate URL or arbitrary HTTP verb.
- High-risk action cannot run without independent authenticated CLI/UI approval, and cannot be approved through MCP.
- Approval reused, expired, parameter changed, wrong-client or policy-changed attempts all fail.
- Master key wrong/missing and database migration failure fail closed; migrations/backups tested.
- Stdio bridge has no UniFi API key/DB access, and emits no debugging bytes to stdout.
- Admin interface defaults local-only; MCP and admin listeners have separate auth and ports.

### Phase 2 — UniFi Network

**Tasks:** import and review official Network API operations and schemas for the selected version; implement version probes; build per-operation permissions/risk/sensitivity metadata; expose named common tools and generic discovery/execution; implement all documented reads and writes in measurable slices, with mocked contracts and error conditions.

**Gate / required tests:**

- All Network operations in the selected source baseline appear in coverage report with status/test evidence.
- Compatible versions work; incompatible version produces clear unsupported error, no guessed endpoint fallback.
- All documented reads pass mock tests and sanitised output checks; writes pass mocked authorisation, approval and duplicate-execution tests.
- Optional **live read-only** test verifies console/site/device/client/network reads with no state-changing HTTP request.
- Compare version-specific field shapes, pagination, filtering and error responses against official documentation.
- No production write automation. Human-approved manual write validation must be documented as a separate optional runbook, not a CI step.

### Phase 3 — UniFi Protect

**Tasks:** same coverage and tests as Network; implement documented device/camera capabilities, snapshots and other sensitive features with explicit permissions; add officially documented Protect event/WebSocket subscriptions and downstream MCP notification compatibility.

**Gate:** permission-filtered image/event content, event reconnection, disconnect/revocation, privacy/redaction and no undocumented video/stream endpoints. High-consequence operations, if documented, require independent approval.

### Phase 4 — Access and other documented modules

**Tasks:** verify official Access local OpenAPI and its distinct auth/base path; implement full version-scoped operation registry, sensitive access control data rules and high-risk physical access actions. Other applications get adapter scaffolds only until official local API contracts are available.

**Gate:** verified source contracts, special treatment of physical-access writes and sensitive events, full coverage report and negative tests; no unsupported API assumptions.

### Phase 5 — Production/release hardening

**Tasks:** dual-network Docker tests, TLS pinning/CA and override warnings, admin MFA, Prometheus metrics, backup/restore drills, docs completeness, CI/security checks, AMD64/ARM64 builds, performance/queue tests, SBOM and optional GHCR workflow.

**Gate:** all security invariants in §17 pass, public-repo scan finds no secrets, two architectures build/boot, both networking modes tested, and manual instructions match actual commands and UI.

**Milestone rule:** each phase requires code, tests, operator documentation and updated API coverage before being marked complete. Record deferred functionality explicitly instead of silently omitting it.

---

## 17. End-to-end acceptance checklist (release-blocking)

### Functional

- [ ] Central server supports two or more independently configured consoles with correct console/site targeting.
- [ ] MCP stdio and Streamable HTTP work; documented tested client versions include Claude Code, Codex and one generic Inspector/client.
- [ ] MCP protocol 2025-era and 2026-era clients negotiate/operate correctly to the extent supported by the pinned SDK.
- [ ] All officially documented operations for the targeted adapter version are accounted for in the API coverage matrix.
- [ ] All registered operations have explicit schemas, version ranges, permission, risk, sensitivity, timeout and retry classification.
- [ ] No cloud UniFi endpoint is called by operational API adapters.
- [ ] Event subscriptions work only through documented official APIs; failures are visible and recover safely.

### Security

- [ ] All write paths, including generic, named, resumed and queued writes, are blocked by the deployment read-only hard lock.
- [ ] Read-only client sees no write tools and cannot invoke writes by guessing names.
- [ ] Different client tokens have strictly isolated scopes and audit identities; revoked tokens stop working.
- [ ] Sensitive information is minimised; API credentials and admin secrets are never returned via MCP.
- [ ] High-risk operations cannot be executed by an agent that merely calls prepare then confirm; human approval is independent.
- [ ] Approval binds exact operation/target/parameters/client, expires and is single-use; resumption repeats security checks.
- [ ] No arbitrary destination/path/header/method or indirect SSRF through generic operation arguments.
- [ ] No plaintext remote tokens; trusted CA/pins enforced by default; insecure TLS overrides are explicit per console.
- [ ] Separate admin authentication, optional MFA, CSRF protections and no default web admin credentials.
- [ ] Master key not in database; missing/wrong key fails closed; secrets excluded from repo/logs/audit.
- [ ] Dual-network setup proves no routing/forwarding and correct interface-bound services.

### Reliability/operations

- [ ] Concurrency/rate limits, queue caps, safe retries and unknown write outcomes behave deterministically.
- [ ] SQLite restart, migration, key rotation and backup/restore are tested.
- [ ] Logs/audit are redacted and correlatable; metrics do not leak sensitive identifiers.
- [ ] Health checks and graceful shutdown work with disconnected/unavailable consoles.
- [ ] Fully offline operation tested with external internet blocked.
- [ ] AMD64 and ARM64 images build and run with the same validated feature set.
- [ ] Docker Compose examples are runnable and secure by default.
- [ ] Markdown documentation reflects actual commands and has passed a user walkthrough.

---

## 18. Implementation manual requirement

**The user manual is a required project deliverable, not a task to postpone until after implementation.** The implementing agent must update the corresponding `docs/` page in each phase and verify commands against runnable integration/CLI smoke tests. `docs/index.md` is the navigation index and `README.md` the short getting-started entry point.

Minimum manual coverage:

1. Quick start from clone to first read-only MCP tool; system requirements and supported platforms.
2. Security model in plain English, trust boundaries, client tokens, human approval and immutable read-only mode.
3. Local UniFi API key acquisition by application/version; least-privilege UniFi account considerations and credential rotation.
4. Environment/bootstrap variables, YAML schema, secrets, SQLite precedence, configuration backup and effective settings.
5. Single-network and dual-network Docker Compose deployment, port binding, VPN access, reverse proxy and TLS examples.
6. Initial CLI admin creation, optional admin UI, user sessions, MFA recovery, token creation/rotation/revocation.
7. Client setup: Claude Code, Codex, generic stdio and generic HTTP; placeholders only, no hard-coded real secrets; show how to verify tool discovery.
8. Operation discovery, aliases/UUIDs, API coverage, pagination, named and generic tools, write operations, risk tiers and approval/resume examples.
9. Module guides: Network, Protect, Access and unsupported/future modules; version constraints and known limitations.
10. Documented native events and notification compatibility; reconnect/refresh behaviours.
11. Auditing, Docker health, optional Prometheus/Grafana and troubleshooting.
12. Backup/restore, upgrade/migrations, key rotation, emergency read-only response and disaster recovery.
13. Contributor workflow, plugin adapter guide, writing mock contract tests, reviewing new official endpoints and avoiding undocumented APIs.
14. Release process, vulnerability reporting and Apache 2.0 attribution.

**Client config examples must be validated against the actual release of the named harness at implementation time.** Prefer a standard token env-file or system secret store, not literals in shell histories or committed client configs. For a local stdio launcher, describe that the harness machine must reach the central MCP listener and needs a **client token only**, never a UniFi API key.

---

## 19. Primary references and verification notes

Official/standards sources (checked 10 November 2026):

1. UniFi Network API v11.0.97 — https://developer.ui.com/network/v11.0.97/gettingstarted
2. UniFi Network AI onboarding markdown supplied by product owner — https://developer.ui.com/network/v11.0.97/ai-gettingstarted.md  
   *The markdown endpoint is a vendor-provided reference; automated retrieval may require a Markdown-capable fetcher. Check it during Phase 0. Do not mistake the example's cloud-connector routes for required local routes.*
3. UniFi Network endpoint example (`GET /v1/sites/{siteId}/networks`) — https://developer.ui.com/network/v11.0.97/getnetworksoverviewpage
4. UniFi Protect API/current application version selection — https://developer.ui.com/protect
5. Ubiquiti official API overview including Network and Access local APIs — https://help.ui.com/hc/en-us/articles/30076656117655-Getting-Started-with-the-Official-UniFi-API
6. UniFi Access official documentation and OpenAPI service information — https://help.ui.com/hc/en-us/articles/17452334269975-Getting-Started-with-UniFi-Access
7. TypeScript MCP SDK **v2**, current stable package names — https://ts.sdk.modelcontextprotocol.io/v2/
8. MCP protocol compatibility: modern 2026 versus legacy 2025 — https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions
9. MCP 2026-07-28 changes — https://blog.modelcontextprotocol.io/posts/2026-07-28/
10. MCP official specification — https://modelcontextprotocol.io/specification/2026-07-28
11. Ubiquiti required ports reference (cross-check with version-specific app docs; **not** a substitute for the API contract) — https://help.ui.com/hc/en-us/articles/218506997-Required-Ports-Reference

Relevant independent implementations **for comparative context only; not a runtime dependency or official authority**:

- https://github.com/sirkirby/unifi-mcp
- https://github.com/enuno/unifi-mcp-server

**Verification caution:** There is no established, vendor-maintained official UniFi MCP project in the sources reviewed as of this document's date. Repeat verification before release. The capability, endpoint and version tables in this document are **design targets**; the version-specific official spec inventory created in Phase 0 is the implementation's auditable contract. The network may contain older console/software versions with materially fewer published capabilities.

---

## 20. Instructions to Codex / Claude Code for implementation handoff

Use this as the task brief when opening the repository:

> You are implementing `unifi-local-mcp` according to `unifi-mcp-design-spec.md`. Treat all recorded decisions and release-blocking security invariants as mandatory. First inspect existing repository state. Complete **Phase 0** and then **Phase 1**, with code, tests and docs; do not implement undocumented UniFi endpoints. Use the official MCP TypeScript SDK v2 and verify current SDK imports/examples before coding. Produce a short plan and a phase checklist in the repository. Implement security gates centrally so named and generic tools cannot bypass them. Use synthetic/mock APIs for all write tests; live UniFi calls must be strictly read-only and separately opted in. Maintain `docs/` and the API coverage matrix as you go. Run lint, typecheck, relevant automated tests, and Docker build/smoke tests. At the end of each phase, report which acceptance criteria passed, which remain open and the exact next phase. Do not claim an integration, endpoint or test passed without actually verifying it.

### Required phase report format

```text
Phase: <number/name>
Implemented:
Documented:
API coverage: <version, supported / total official ops, explicit gaps>
Tests run: <commands and pass/fail>
Security invariants verified:
Known limitations:
Decisions/ADRs:
Next phase:
```

### Final change-control rule

If the implementing agent discovers a conflict between this specification and a published API or MCP SDK contract, it **must not silently work around the conflict**. It should create an ADR with the evidence, preserve least-privilege behaviour and explain any necessary deviation before continuing.

---

**End of design specification.**
