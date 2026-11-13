/**
 * Admin pages, rendered on the server from plain view models (spec §13.1; ADR 0016). There
 * is no JavaScript: every action is an HTML form posted with a CSRF token.
 */
import { html, type SafeHtml } from './html.ts';

export interface Frame {
  title: string;
  /** Signed-in administrator; undefined on the sign-in page. */
  username?: string;
  csrfToken?: string;
  notice?: { kind: 'ok' | 'error'; text: string };
}

export interface CheckView {
  name: string;
  status: string;
  detail?: string;
}

export interface ConsoleSummary {
  alias: string;
  host: string;
  state: string;
  tlsMode: string;
  modules: {
    moduleId: string;
    state: string;
    hasCredential: boolean;
    observedVersion: string | null;
    /** A current declaration (ADR 0021 §5): shown as declared, not observed. */
    declaredVersion: string | null;
  }[];
}

export interface DashboardView {
  runtimeMode: string;
  forceReadOnly: boolean;
  policyVersion: number;
  ready: boolean;
  checks: CheckView[];
  mcpListener: string;
  adminListener: string;
  consoles: ConsoleSummary[];
  clients: number;
  pendingApprovals: number;
}

export interface ApprovalRow {
  id: string;
  status: string;
  clientId: string;
  operationId: string;
  risk: string;
  consoleId: string;
  siteId: string | null;
  createdAt: string;
  expiresAt: string;
  executeBy: string | null;
}

export interface ApprovalDetail extends ApprovalRow {
  summary: unknown;
  policyVersion: number;
  decidedAt: string | null;
  decidedBy: string | null;
  decisionNote: string | null;
  closedAt: string | null;
}

export interface AuditRow {
  seq: number;
  occurredAt: string;
  eventType: string;
  action: string;
  outcome: string;
  actorType: string;
  actorId: string | null;
  consoleId: string | null;
  operationId: string | null;
  errorCode: string | null;
  details: unknown;
}

export interface AuditFilters {
  actorType?: string;
  outcome?: string;
  eventType?: string;
}

function layout(frame: Frame, body: SafeHtml): string {
  const signedIn = frame.username !== undefined;
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="referrer" content="no-referrer" />
        <title>${frame.title} · unifi-local-mcp admin</title>
        <link rel="stylesheet" href="/static/admin.css" />
      </head>
      <body>
        <header>
          <span class="brand">unifi-local-mcp admin</span>
          ${
            signedIn
              ? html`<nav>
                    <a href="/">Dashboard</a><a href="/approvals">Approvals</a
                    ><a href="/audit">Audit</a>
                  </nav>
                  <form method="post" action="/logout">
                    <input type="hidden" name="csrf" value="${frame.csrfToken ?? ''}" /><span
                      class="muted"
                      >${frame.username ?? ''}</span
                    >
                    <button class="secondary" type="submit">Sign out</button>
                  </form>`
              : ''
          }
        </header>
        <main>
          ${frame.notice === undefined ? '' : html`<div class="notice ${frame.notice.kind}" role="status">${frame.notice.text}</div>`}
          ${body}
        </main>
      </body>
    </html> `.value;
}

export function loginPage(frame: Frame): string {
  return layout(
    frame,
    html`<h1>Sign in</h1>
      <form class="card" method="post" action="/login">
        <label for="username">Username</label>
        <input
          id="username"
          name="username"
          autocomplete="username"
          required
          maxlength="64"
          autofocus
        />
        <label for="password">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          autocomplete="current-password"
          required
          maxlength="1024"
        />
        <button type="submit">Sign in</button>
      </form>
      <p class="muted">
        Administrators are created and recovered on the host with
        <code>unifi-mcp admin bootstrap</code> and <code>unifi-mcp admin reset-password</code>.
      </p>`,
  );
}

function statusClass(status: string): string {
  return status === 'ok' || status === 'success'
    ? 'status-ok'
    : status === 'degraded' || status === 'pending'
      ? 'status-warn'
      : 'status-bad';
}

export function dashboardPage(frame: Frame, view: DashboardView): string {
  return layout(
    frame,
    html`<h1>Dashboard</h1>
      <div class="grid">
        <div class="card">
          <div class="muted">Writes</div>
          <div class="${view.forceReadOnly ? 'status-ok' : 'status-warn'}">
            ${view.forceReadOnly ? 'Hard lock ON: no writes can run' : 'Hard lock off'}
          </div>
          <div>Runtime mode: ${view.runtimeMode}</div>
          <div class="muted">Policy version ${view.policyVersion}</div>
        </div>
        <div class="card">
          <div class="muted">Service</div>
          <div class="${view.ready ? 'status-ok' : 'status-bad'}">
            ${view.ready ? 'Ready' : 'Not ready'}
          </div>
          <div>MCP listener: ${view.mcpListener}</div>
          <div>Admin listener: ${view.adminListener}</div>
        </div>
        <div class="card">
          <div class="muted">Activity</div>
          <div>
            <a href="/approvals"
              >${view.pendingApprovals} pending approval${view.pendingApprovals === 1 ? '' : 's'}</a
            >
          </div>
          <div>${view.clients} MCP client${view.clients === 1 ? '' : 's'}</div>
        </div>
      </div>
      <h2>Health checks</h2>
      <div class="card scroll">
        <table>
          <thead>
            <tr>
              <th>Check</th>
              <th>Status</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            ${view.checks.map(
              (c) =>
                html`<tr>
                  <td>${c.name}</td>
                  <td class="${statusClass(c.status)}">${c.status}</td>
                  <td>${c.detail ?? ''}</td>
                </tr>`,
            )}
          </tbody>
        </table>
      </div>
      <h2>Consoles</h2>
      ${
        view.consoles.length === 0
          ? html`<p class="muted">
              No console configured. Add one with <code>unifi-mcp console add</code>.
            </p>`
          : html`<div class="card scroll">
              <table>
                <thead>
                  <tr>
                    <th>Alias</th>
                    <th>Host</th>
                    <th>State</th>
                    <th>TLS</th>
                    <th>Modules</th>
                  </tr>
                </thead>
                <tbody>
                  ${view.consoles.map(
                    (c) =>
                      html`<tr>
                        <td>${c.alias}</td>
                        <td>${c.host}</td>
                        <td>${c.state}</td>
                        <td class="${c.tlsMode === 'insecure' ? 'status-bad' : ''}">
                          ${c.tlsMode}
                        </td>
                        <td>
                          ${c.modules.map(
                            (m) =>
                              html`<div>
                                ${m.moduleId}:
                                ${m.state}${m.hasCredential ? '' : ' (no credential)'}${m.observedVersion === null ? '' : `, v${m.observedVersion}`}${m.declaredVersion === null ? '' : `, v${m.declaredVersion} (declared, not observed)`}
                              </div>`,
                          )}
                        </td>
                      </tr>`,
                  )}
                </tbody>
              </table>
            </div>`
      }
      <p class="muted">
        Consoles, clients and policy are managed with the <code>unifi-mcp</code> CLI on the host
        (docs/administration.md).
      </p>`,
  );
}

function approvalTable(rows: ApprovalRow[]): SafeHtml {
  if (rows.length === 0) return html`<p class="muted">None.</p>`;
  return html`<div class="card scroll">
    <table>
      <thead>
        <tr>
          <th>Requested</th>
          <th>Client</th>
          <th>Operation</th>
          <th>Risk</th>
          <th>Status</th>
          <th>Expires</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(
          (r) =>
            html`<tr>
              <td><a href="/approvals/${encodeURIComponent(r.id)}">${r.createdAt}</a></td>
              <td>${r.clientId}</td>
              <td>${r.operationId}</td>
              <td>${r.risk}</td>
              <td class="${statusClass(r.status)}">${r.status}</td>
              <td>${r.executeBy ?? r.expiresAt}</td>
            </tr>`,
        )}
      </tbody>
    </table>
  </div>`;
}

export function approvalsPage(frame: Frame, pending: ApprovalRow[], recent: ApprovalRow[]): string {
  return layout(
    frame,
    html`<h1>Approvals</h1>
      <p class="muted">
        High-risk requests from MCP clients wait here for a human decision. Approving does not run
        anything: the requesting client must resume the request before the approval expires.
      </p>
      <h2>Pending</h2>
      ${approvalTable(pending)}
      <h2>Recent</h2>
      ${approvalTable(recent)}`,
  );
}

export function approvalPage(frame: Frame, a: ApprovalDetail): string {
  const pending = a.status === 'pending';
  return layout(
    frame,
    html`<h1>Approval request</h1>
      <div class="card scroll">
        <table>
          <tbody>
            <tr>
              <th>Status</th>
              <td class="${statusClass(a.status)}">${a.status}</td>
            </tr>
            <tr>
              <th>Client</th>
              <td>${a.clientId}</td>
            </tr>
            <tr>
              <th>Operation</th>
              <td>${a.operationId}</td>
            </tr>
            <tr>
              <th>Risk</th>
              <td>${a.risk}</td>
            </tr>
            <tr>
              <th>Console</th>
              <td>${a.consoleId}</td>
            </tr>
            <tr>
              <th>Site</th>
              <td>${a.siteId ?? '-'}</td>
            </tr>
            <tr>
              <th>Requested</th>
              <td>${a.createdAt}</td>
            </tr>
            <tr>
              <th>Expires</th>
              <td>${a.expiresAt}</td>
            </tr>
            ${
              a.decidedAt === null
                ? ''
                : html`<tr>
                    <th>Decided</th>
                    <td>
                      ${a.decidedAt} by
                      ${a.decidedBy ?? '-'}${a.decisionNote === null ? '' : html` (${a.decisionNote})`}
                    </td>
                  </tr>`
            }
            ${
              a.executeBy === null
                ? ''
                : html`<tr>
                    <th>Resume by</th>
                    <td>${a.executeBy}</td>
                  </tr>`
            }
            <tr>
              <th>Policy version</th>
              <td>${a.policyVersion}</td>
            </tr>
            <tr>
              <th>Id</th>
              <td><code>${a.id}</code></td>
            </tr>
          </tbody>
        </table>
      </div>
      <h2>Requested call (redacted)</h2>
      <div class="card"><pre>${JSON.stringify(a.summary, null, 2)}</pre></div>
      ${
        pending
          ? html`<div class="grid">
              <form
                class="card"
                method="post"
                action="/approvals/${encodeURIComponent(a.id)}/approve"
              >
                <input type="hidden" name="csrf" value="${frame.csrfToken ?? ''}" />
                <label for="password">Your password (required for every approval)</label>
                <input
                  id="password"
                  name="password"
                  type="password"
                  autocomplete="current-password"
                  required
                  maxlength="1024"
                />
                <label for="approve-note">Note (optional)</label>
                <input id="approve-note" name="note" maxlength="500" />
                <button class="danger" type="submit">Approve</button>
              </form>
              <form
                class="card"
                method="post"
                action="/approvals/${encodeURIComponent(a.id)}/reject"
              >
                <input type="hidden" name="csrf" value="${frame.csrfToken ?? ''}" />
                <label for="reject-note">Note (optional)</label>
                <input id="reject-note" name="note" maxlength="500" />
                <button class="secondary" type="submit">Reject</button>
              </form>
            </div>`
          : ''
      }`,
  );
}

export function auditPage(
  frame: Frame,
  rows: AuditRow[],
  filters: AuditFilters,
  olderHref: string | undefined,
): string {
  const option = (value: string, current: string | undefined): SafeHtml =>
    html`<option value="${value}" ${value === (current ?? '') ? html` selected` : ''}>
      ${value === '' ? 'any' : value}
    </option>`;
  return layout(
    frame,
    html`<h1>Audit trail</h1>
      <form class="card filters" method="get" action="/audit">
        <div>
          <label for="actorType">Actor</label
          ><select id="actorType" name="actorType">
            ${['', 'mcp_client', 'admin', 'cli', 'system'].map((v) => option(v, filters.actorType))}
          </select>
        </div>
        <div>
          <label for="outcome">Outcome</label
          ><select id="outcome" name="outcome">
            ${['', 'success', 'denied', 'failure', 'pending', 'outcome_unknown'].map((v) => option(v, filters.outcome))}
          </select>
        </div>
        <div>
          <label for="eventType">Event type</label
          ><input
            id="eventType"
            name="eventType"
            value="${filters.eventType ?? ''}"
            maxlength="64"
          />
        </div>
        <div><button type="submit">Filter</button></div>
      </form>
      <div class="card scroll">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Time</th>
              <th>Event</th>
              <th>Action</th>
              <th>Outcome</th>
              <th>Actor</th>
              <th>Operation</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(
              (r) =>
                html`<tr>
                  <td>${r.seq}</td>
                  <td>${r.occurredAt}</td>
                  <td>${r.eventType}</td>
                  <td>${r.action}</td>
                  <td class="${statusClass(r.outcome)}">
                    ${r.outcome}${r.errorCode === null ? '' : html` (${r.errorCode})`}
                  </td>
                  <td>${r.actorId === null ? r.actorType : `${r.actorType}:${r.actorId}`}</td>
                  <td>${r.operationId ?? ''}</td>
                  <td><pre>${JSON.stringify(r.details)}</pre></td>
                </tr>`,
            )}
          </tbody>
        </table>
      </div>
      ${olderHref === undefined ? '' : html`<p><a href="${olderHref}">Older entries</a></p>`}`,
  );
}

export function errorPage(frame: Frame, heading: string, text: string): string {
  return layout(
    frame,
    html`<h1>${heading}</h1>
      <p>${text}</p>
      <p><a href="/">Back to the dashboard</a></p>`,
  );
}
