/**
 * Admin pages for consoles, MCP clients, the policy and the settings (spec §13.1 items 2,
 * 3, 4 and 7; ADR 0027). Like every admin page they are rendered on the server from plain
 * view models, with every value escaped, and they never receive a credential: the view
 * models have no field for one.
 */
import { html, type SafeHtml } from './html.ts';
import { layout, statusClass, type Frame } from './pages.ts';

export interface ConsoleModuleDetail {
  moduleId: string;
  state: string;
  port: number;
  hasCredential: boolean;
  versionSource: 'probe' | 'declared';
  observedVersion: string | null;
  observedAt: string | null;
  declaredVersion: string | null;
  declarationExpiresAt: string | null;
  /** The version operations are checked against now. */
  effectiveVersion: string | null;
}

export interface ConsoleRow {
  id: string;
  alias: string;
  host: string;
  state: string;
  tlsMode: string;
  modules: { moduleId: string; state: string }[];
}

export interface ConsoleDetail extends Omit<ConsoleRow, 'modules'> {
  description: string | null;
  tlsCustomCa: boolean;
  tlsPins: number;
  /** The stored console policy as JSON, or null when it is unusable. */
  policy: unknown;
  modules: ConsoleModuleDetail[];
  createdAt: string;
  updatedAt: string;
}

export interface ClientRow {
  clientId: string;
  description: string | null;
  status: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  activeTokens: number;
  consoles: number;
}

export interface EffectiveOperation {
  operationId: string;
  effect: string;
  risk: string;
  approvalRequired: boolean;
  /** Aliases of the consoles where the client can use it now. */
  consoles: string[];
}

export interface ClientDetail extends ClientRow {
  policy: unknown;
  createdAt: string;
  updatedAt: string;
  tokens: {
    tokenId: string;
    createdAt: string;
    expiresAt: string | null;
    revokedAt: string | null;
    lastUsedAt: string | null;
  }[];
  /** What the client can use right now: the same evaluation as its tool list. */
  effective: EffectiveOperation[];
}

export interface PolicyView {
  version: number;
  runtimeMode: string;
  forceReadOnly: boolean;
  document: unknown;
  registeredOperations: number;
  defaultDisabled: { operationId: string; enabled: boolean }[];
}

export interface SettingsView {
  serviceVersion: string;
  schemaVersion: number;
  masterKeyId: string;
  /** Deployment settings as name and value. Never a secret: paths, flags and numbers. */
  configuration: { name: string; value: string }[];
  modules: {
    moduleId: string;
    status: string;
    contractRevisions: string[];
    operations: number;
    eventStreams: number;
  }[];
  eventFeeds: {
    console: string;
    moduleId: string;
    streamId: string;
    state: string;
    subscribers: number;
  }[];
}

function json(value: unknown): SafeHtml {
  return html`<pre>${JSON.stringify(value, null, 2)}</pre>`;
}

const HOST_NOTE = html`<p class="muted">
  Changes are made on the host with the <code>unifi-mcp</code> CLI (docs/administration.md).
</p>`;

export function consolesPage(frame: Frame, rows: ConsoleRow[]): string {
  return layout(
    frame,
    html`<h1>Consoles</h1>
      ${
        rows.length === 0
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
                  ${rows.map(
                    (c) =>
                      html`<tr>
                        <td><a href="/consoles/${encodeURIComponent(c.id)}">${c.alias}</a></td>
                        <td>${c.host}</td>
                        <td>${c.state}</td>
                        <td class="${c.tlsMode === 'insecure' ? 'status-bad' : ''}">
                          ${c.tlsMode}
                        </td>
                        <td>${c.modules.map((m) => `${m.moduleId}: ${m.state}`).join(', ')}</td>
                      </tr>`,
                  )}
                </tbody>
              </table>
            </div>`
      }
      ${HOST_NOTE}`,
  );
}

export function consolePage(frame: Frame, c: ConsoleDetail): string {
  return layout(
    frame,
    html`<h1>Console ${c.alias}</h1>
      <div class="card scroll">
        <table>
          <tr>
            <th>Id</th>
            <td>${c.id}</td>
          </tr>
          <tr>
            <th>Description</th>
            <td>${c.description ?? '-'}</td>
          </tr>
          <tr>
            <th>Host</th>
            <td>${c.host}</td>
          </tr>
          <tr>
            <th>State</th>
            <td>${c.state}</td>
          </tr>
          <tr>
            <th>TLS trust</th>
            <td class="${c.tlsMode === 'insecure' ? 'status-bad' : ''}">
              ${c.tlsMode}${c.tlsMode === 'insecure' ? ': certificate verification is DISABLED' : ''}${c.tlsCustomCa ? ', own CA' : ''}${c.tlsPins > 0 ? `, ${String(c.tlsPins)} pin(s)` : ''}
            </td>
          </tr>
          <tr>
            <th>Created</th>
            <td>${c.createdAt}</td>
          </tr>
          <tr>
            <th>Changed</th>
            <td>${c.updatedAt}</td>
          </tr>
        </table>
      </div>
      <h2>Modules</h2>
      <div class="card scroll">
        <table>
          <thead>
            <tr>
              <th>Module</th>
              <th>Mode</th>
              <th>Port</th>
              <th>Credential</th>
              <th>Application version</th>
            </tr>
          </thead>
          <tbody>
            ${c.modules.map(
              (m) =>
                html`<tr>
                  <td>${m.moduleId}</td>
                  <td>${m.state}</td>
                  <td>${m.port}</td>
                  <td class="${m.hasCredential ? 'status-ok' : 'status-warn'}">
                    ${m.hasCredential ? 'stored' : 'none'}
                  </td>
                  <td>
                    ${
                      m.versionSource === 'declared'
                        ? m.effectiveVersion === null
                          ? m.declaredVersion === null
                            ? 'not declared'
                            : `${m.declaredVersion} (declared, expired ${m.declarationExpiresAt ?? ''})`
                          : `${m.effectiveVersion} (declared, not observed; until ${m.declarationExpiresAt ?? ''})`
                        : m.observedVersion === null
                          ? 'not yet observed'
                          : `${m.observedVersion} (observed ${m.observedAt ?? ''})`
                    }
                  </td>
                </tr>`,
            )}
          </tbody>
        </table>
      </div>
      <p class="muted">A stored credential is never shown, here or by any command.</p>
      <h2>Console policy</h2>
      ${
        c.policy === null
          ? html`<p class="status-bad">
              The stored policy is unusable, so nothing can use this console.
            </p>`
          : html`<div class="card scroll">${json(c.policy)}</div>`
      }
      ${HOST_NOTE}`,
  );
}

export function clientsPage(frame: Frame, rows: ClientRow[]): string {
  return layout(
    frame,
    html`<h1>MCP clients</h1>
      ${
        rows.length === 0
          ? html`<p class="muted">
              No client. Create one with <code>unifi-mcp client create</code>.
            </p>`
          : html`<div class="card scroll">
              <table>
                <thead>
                  <tr>
                    <th>Client</th>
                    <th>Description</th>
                    <th>Status</th>
                    <th>Expires</th>
                    <th>Usable tokens</th>
                    <th>Consoles</th>
                    <th>Last used</th>
                  </tr>
                </thead>
                <tbody>
                  ${rows.map(
                    (c) =>
                      html`<tr>
                        <td>
                          <a href="/clients/${encodeURIComponent(c.clientId)}">${c.clientId}</a>
                        </td>
                        <td>${c.description ?? ''}</td>
                        <td class="${c.status === 'active' ? 'status-ok' : 'status-bad'}">
                          ${c.status}
                        </td>
                        <td>${c.expiresAt ?? '-'}</td>
                        <td>${c.activeTokens}</td>
                        <td>${c.consoles}</td>
                        <td>${c.lastUsedAt ?? '-'}</td>
                      </tr>`,
                  )}
                </tbody>
              </table>
            </div>`
      }
      ${HOST_NOTE}`,
  );
}

export function clientPage(frame: Frame, c: ClientDetail): string {
  const reads = c.effective.filter((o) => o.effect === 'read').length;
  const writes = c.effective.length - reads;
  const approvals = c.effective.filter((o) => o.approvalRequired).length;
  return layout(
    frame,
    html`<h1>Client ${c.clientId}</h1>
      <div class="card scroll">
        <table>
          <tr>
            <th>Description</th>
            <td>${c.description ?? '-'}</td>
          </tr>
          <tr>
            <th>Status</th>
            <td class="${c.status === 'active' ? 'status-ok' : 'status-bad'}">${c.status}</td>
          </tr>
          <tr>
            <th>Expires</th>
            <td>${c.expiresAt ?? '-'}</td>
          </tr>
          <tr>
            <th>Created</th>
            <td>${c.createdAt}</td>
          </tr>
          <tr>
            <th>Changed</th>
            <td>${c.updatedAt}</td>
          </tr>
          <tr>
            <th>Last used</th>
            <td>${c.lastUsedAt ?? '-'}</td>
          </tr>
        </table>
      </div>
      <h2>Tokens</h2>
      <div class="card scroll">
        <table>
          <thead>
            <tr>
              <th>Token id</th>
              <th>Created</th>
              <th>Expires</th>
              <th>Revoked</th>
              <th>Last used</th>
            </tr>
          </thead>
          <tbody>
            ${c.tokens.map(
              (t) =>
                html`<tr>
                  <td>${t.tokenId}</td>
                  <td>${t.createdAt}</td>
                  <td>${t.expiresAt ?? '-'}</td>
                  <td class="${t.revokedAt === null ? '' : 'status-bad'}">${t.revokedAt ?? '-'}</td>
                  <td>${t.lastUsedAt ?? '-'}</td>
                </tr>`,
            )}
          </tbody>
        </table>
      </div>
      <p class="muted">
        A token id names a token in logs and here. It is not the token, which was shown once when it
        was created and is not stored.
      </p>
      <h2>What this client can use now</h2>
      <p>
        ${c.effective.length} operation${c.effective.length === 1 ? '' : 's'}: ${reads}
        read${reads === 1 ? '' : 's'}, ${writes}
        write${writes === 1 ? '' : 's'}${approvals === 0 ? '' : `, ${String(approvals)} of them only after a human approves`}.
      </p>
      <p class="muted">
        This is the list the client itself is shown, worked out from the global policy, each
        console's policy and state, the versions of its applications, the hard lock and this
        client's grants. Every request is checked again when it runs.
      </p>
      ${
        c.effective.length === 0
          ? ''
          : html`<div class="card scroll">
              <table>
                <thead>
                  <tr>
                    <th>Operation</th>
                    <th>Effect</th>
                    <th>Risk</th>
                    <th>Approval</th>
                    <th>Consoles</th>
                  </tr>
                </thead>
                <tbody>
                  ${c.effective.map(
                    (o) =>
                      html`<tr>
                        <td>${o.operationId}</td>
                        <td class="${o.effect === 'write' ? 'status-warn' : ''}">${o.effect}</td>
                        <td class="${o.risk === 'high' ? 'status-bad' : ''}">${o.risk}</td>
                        <td>${o.approvalRequired ? 'required' : '-'}</td>
                        <td>${o.consoles.join(', ')}</td>
                      </tr>`,
                  )}
                </tbody>
              </table>
            </div>`
      }
      <h2>Client policy</h2>
      ${
        c.policy === null
          ? html`<p class="status-bad">
              The stored policy is unusable, so the client can do nothing.
            </p>`
          : html`<div class="card scroll">${json(c.policy)}</div>`
      }
      ${HOST_NOTE}`,
  );
}

export function policyPage(frame: Frame, p: PolicyView): string {
  return layout(
    frame,
    html`<h1>Policy</h1>
      <div class="grid">
        <div class="card">
          <div class="muted">Deployment hard lock</div>
          <div class="${p.forceReadOnly ? 'status-ok' : 'status-warn'}">
            ${p.forceReadOnly ? 'ON: no write can run, whatever the policy says' : 'off'}
          </div>
          <div class="muted">UNIFI_MCP_FORCE_READ_ONLY; changed only by redeploying.</div>
        </div>
        <div class="card">
          <div class="muted">Runtime mode</div>
          <div class="${p.runtimeMode === 'read_only' ? 'status-ok' : 'status-warn'}">
            ${p.runtimeMode}
          </div>
          <div class="muted">Policy version ${p.version}</div>
        </div>
        <div class="card">
          <div class="muted">Operations</div>
          <div>${p.registeredOperations} registered</div>
          <div class="muted">
            ${p.defaultDisabled.filter((o) => o.enabled).length} of ${p.defaultDisabled.length}
            off-by-default operations enabled
          </div>
        </div>
      </div>
      <h2>Global policy</h2>
      <div class="card scroll">${json(p.document)}</div>
      <h2>Operations that are off unless enabled here</h2>
      ${
        p.defaultDisabled.length === 0
          ? html`<p class="muted">None.</p>`
          : html`<div class="card scroll">
              <table>
                <thead>
                  <tr>
                    <th>Operation</th>
                    <th>State</th>
                  </tr>
                </thead>
                <tbody>
                  ${p.defaultDisabled.map(
                    (o) =>
                      html`<tr>
                        <td>${o.operationId}</td>
                        <td class="${o.enabled ? 'status-warn' : ''}">
                          ${o.enabled ? 'enabled' : 'off'}
                        </td>
                      </tr>`,
                  )}
                </tbody>
              </table>
            </div>`
      }
      <p class="muted">
        A client's grants are on its own page, under Clients, with what they come to. Console
        policies are under Consoles.
      </p>
      ${HOST_NOTE}`,
  );
}

export function settingsPage(frame: Frame, s: SettingsView): string {
  return layout(
    frame,
    html`<h1>Settings and maintenance</h1>
      <div class="grid">
        <div class="card">
          <div class="muted">Service</div>
          <div>Version ${s.serviceVersion}</div>
          <div class="muted">Database schema ${s.schemaVersion}</div>
        </div>
        <div class="card">
          <div class="muted">Master key</div>
          <div>${s.masterKeyId}</div>
          <div class="muted">The identifier only. The key is never shown.</div>
        </div>
        <div class="card">
          <div class="muted">Updates</div>
          <div>No update check</div>
          <div class="muted">This service never contacts the internet.</div>
        </div>
      </div>
      <h2>Effective configuration</h2>
      <div class="card scroll">
        <table>
          <tbody>
            ${s.configuration.map(
              (entry) =>
                html`<tr>
                  <th>${entry.name}</th>
                  <td>${entry.value}</td>
                </tr>`,
            )}
          </tbody>
        </table>
      </div>
      <p class="muted">
        Set through the environment at start (docs/configuration.md). Secrets are files; only their
        paths appear here.
      </p>
      <h2>Applications</h2>
      <div class="card scroll">
        <table>
          <thead>
            <tr>
              <th>Module</th>
              <th>Status</th>
              <th>Official contract</th>
              <th>Operations</th>
              <th>Event streams</th>
            </tr>
          </thead>
          <tbody>
            ${s.modules.map(
              (m) =>
                html`<tr>
                  <td>${m.moduleId}</td>
                  <td class="${m.status === 'supported' ? 'status-ok' : 'muted'}">${m.status}</td>
                  <td>${m.contractRevisions.join(', ') || '-'}</td>
                  <td>${m.operations}</td>
                  <td>${m.eventStreams}</td>
                </tr>`,
            )}
          </tbody>
        </table>
      </div>
      <h2>Event connections</h2>
      ${
        s.eventFeeds.length === 0
          ? html`<p class="muted">None: no client is subscribed to events.</p>`
          : html`<div class="card scroll">
              <table>
                <thead>
                  <tr>
                    <th>Console</th>
                    <th>Module</th>
                    <th>Stream</th>
                    <th>State</th>
                    <th>Subscribers</th>
                  </tr>
                </thead>
                <tbody>
                  ${s.eventFeeds.map(
                    (f) =>
                      html`<tr>
                        <td>${f.console}</td>
                        <td>${f.moduleId}</td>
                        <td>${f.streamId}</td>
                        <td class="${statusClass(f.state === 'connected' ? 'ok' : 'degraded')}">
                          ${f.state}
                        </td>
                        <td>${f.subscribers}</td>
                      </tr>`,
                  )}
                </tbody>
              </table>
            </div>`
      }
      <h2>Maintenance</h2>
      <div class="card">
        <p>Maintenance is done on the host, never from this page:</p>
        <table>
          <tr>
            <th>Back up</th>
            <td><code>unifi-mcp db backup</code> (docs/backup-restore.md)</td>
          </tr>
          <tr>
            <th>Restore</th>
            <td><code>unifi-mcp db restore</code>, with the service stopped</td>
          </tr>
          <tr>
            <th>Check</th>
            <td><code>unifi-mcp doctor</code> and <code>unifi-mcp db check</code></td>
          </tr>
          <tr>
            <th>Rotate the master key</th>
            <td><code>unifi-mcp crypto rotate-key</code>, with the service stopped</td>
          </tr>
          <tr>
            <th>Emergency read-only</th>
            <td>
              <code>unifi-mcp policy set-runtime-mode read_only</code>, or redeploy with
              <code>UNIFI_MCP_FORCE_READ_ONLY=true</code>
            </td>
          </tr>
          <tr>
            <th>Problems</th>
            <td>docs/troubleshooting.md</td>
          </tr>
        </table>
      </div>`,
  );
}
