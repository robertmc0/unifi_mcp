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

/** The note under a page: where changes are made. */
function changeNote(frame: Frame): SafeHtml {
  return frame.manage === undefined
    ? HOST_NOTE
    : html`<p class="muted">
        Changes made here are recorded in the audit trail under your name. A change asks for your
        password again when the last check is more than five minutes old.
      </p>`;
}

/** The hidden CSRF field and, when the last password check is old, the password fields. */
function authFields(frame: Frame, id: string): SafeHtml {
  const manage = frame.manage;
  return html`<input type="hidden" name="csrf" value="${frame.csrfToken ?? ''}" />${
      manage?.passwordNeeded === true
        ? html`<label for="${id}-password">Your password</label>
            <input
              id="${id}-password"
              name="password"
              type="password"
              autocomplete="current-password"
              required
              maxlength="1024"
            />${
              manage.codeNeeded
                ? html`<label for="${id}-code">A new code from your authenticator app</label>
                    <input
                      id="${id}-code"
                      name="code"
                      autocomplete="one-time-code"
                      inputmode="numeric"
                      required
                      maxlength="64"
                    />`
                : ''
            }`
        : ''
    }`;
}

function tlsFields(id: string, mode: string): SafeHtml {
  const option = (value: string, label: string): SafeHtml =>
    html`<option value="${value}" ${value === mode ? html` selected` : ''}>${label}</option>`;
  return html`<label for="${id}-tls">TLS trust</label>
    <select id="${id}-tls" name="tlsMode">
      ${option('verify', 'verify: public CAs, or the CA below')}
      ${option('pinned', 'pinned: only the certificates pinned below')}
      ${option('insecure', 'insecure: do not check the certificate')}
    </select>
    <label for="${id}-ca">CA certificate (PEM), for verify with your own CA</label>
    <textarea id="${id}-ca" name="caPem" rows="4" maxlength="32768"></textarea>
    <label for="${id}-pins">Pins (sha256/…), one per line, for pinned</label>
    <textarea id="${id}-pins" name="pins" rows="2" maxlength="2048"></textarea>
    <label for="${id}-insecure">Type "insecure" to disable certificate checks</label>
    <input id="${id}-insecure" name="insecureConfirm" maxlength="16" autocomplete="off" />`;
}

function policyEditor(
  frame: Frame,
  kind: 'global' | 'console' | 'client',
  policy: unknown,
  hidden: Record<string, string>,
): SafeHtml {
  return html`<form
    class="card"
    method="post"
    action="/manage/${kind === 'global' ? 'policy.document' : `${kind}.policy`}"
  >
    ${authFields(frame, `${kind}-policy`)}
    ${Object.entries(hidden).map(
      ([name, value]) => html`<input type="hidden" name="${name}" value="${value}" />`,
    )}
    <label for="${kind}-policy-json">Policy (JSON)</label>
    <textarea id="${kind}-policy-json" name="policy" rows="16" maxlength="60000" spellcheck="false">
${JSON.stringify(policy ?? {}, null, 2)}</textarea>
    <button class="secondary" type="submit" formaction="/manage/preview/${kind}">
      Preview the effect
    </button>
    <button class="danger" type="submit">Save</button>
  </form>`;
}

export interface PreviewView {
  title: string;
  clients: { clientId: string; before: number; after: number; gained: string[]; lost: string[] }[];
}

/** What a policy change would do to each client, with the form that makes it. */
export function previewPage(
  frame: Frame,
  preview: PreviewView,
  form: { kind: string; policy: string; consoleId: string; clientId: string; version: string },
): string {
  const changed = preview.clients.filter((c) => c.gained.length + c.lost.length > 0);
  return layout(
    frame,
    html`<h1>Preview</h1>
      <p>
        If you save this change to ${preview.title},
        ${
          changed.length === 0
            ? 'no client gains or loses an operation.'
            : `${String(changed.length)} of ${String(preview.clients.length)} client${preview.clients.length === 1 ? '' : 's'} can use different operations.`
        }
      </p>
      <div class="card scroll">
        <table>
          <thead>
            <tr>
              <th>Client</th>
              <th>Now</th>
              <th>After</th>
              <th>Gains</th>
              <th>Loses</th>
            </tr>
          </thead>
          <tbody>
            ${preview.clients.map(
              (c) =>
                html`<tr>
                  <td>${c.clientId}</td>
                  <td>${c.before}</td>
                  <td>${c.after}</td>
                  <td class="${c.gained.length > 0 ? 'status-warn' : ''}">
                    ${c.gained.length === 0 ? '-' : c.gained.join(', ')}
                  </td>
                  <td>${c.lost.length === 0 ? '-' : c.lost.join(', ')}</td>
                </tr>`,
            )}
          </tbody>
        </table>
      </div>
      <p class="muted">
        Nothing was changed. The preview uses the consoles, versions and grants as they are now; it
        is worked out again when you save.
      </p>
      <form
        class="card"
        method="post"
        action="/manage/${form.kind === 'global' ? 'policy.document' : `${form.kind}.policy`}"
      >
        ${authFields(frame, 'preview')}
        <input type="hidden" name="consoleId" value="${form.consoleId}" />
        <input type="hidden" name="clientId" value="${form.clientId}" />
        <input type="hidden" name="version" value="${form.version}" />
        <label for="preview-policy">Policy (JSON)</label>
        <textarea id="preview-policy" name="policy" rows="12" maxlength="60000" spellcheck="false">
${form.policy}</textarea>
        <button class="secondary" type="submit" formaction="/manage/preview/${form.kind}">
          Preview again
        </button>
        <button class="danger" type="submit">Save</button>
      </form>`,
  );
}

/** A secret shown once: it is in this page only, and the page is never cached. */
export function revealPage(
  frame: Frame,
  notice: string,
  reveal: { label: string; value: string },
  continueHref: string,
): string {
  return layout(
    { ...frame, notice: { kind: 'ok', text: notice } },
    html`<h1>${reveal.label}</h1>
      <div class="card">
        <pre>${reveal.value}</pre>
        <p>
          <strong>Copy it now.</strong> It is not stored and cannot be shown again. If it is lost,
          issue a new one.
        </p>
      </div>
      <p><a href="${continueHref}">Continue</a></p>`,
  );
}

export function reportPage(
  frame: Frame,
  notice: string,
  rows: [string, string][],
  continueHref: string,
): string {
  return layout(
    frame,
    html`<h1>${notice}</h1>
      <div class="card scroll">
        <table>
          ${rows.map(
            ([name, value]) =>
              html`<tr>
                <th>${name}</th>
                <td>${value}</td>
              </tr>`,
          )}
        </table>
      </div>
      <p class="muted">
        Nothing was sent to the console but a TLS handshake: no request, no credential.
      </p>
      <p><a href="${continueHref}">Back</a></p>`,
  );
}

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
      ${
        frame.manage === undefined
          ? ''
          : html`<h2>Add a console</h2>
              <form class="card" method="post" action="/manage/console.add">
                ${authFields(frame, 'add')}
                <label for="add-alias">Alias</label>
                <input id="add-alias" name="alias" required maxlength="63" />
                <label for="add-host">Host name or address</label>
                <input id="add-host" name="host" required maxlength="253" />
                <label for="add-description">Description (optional)</label>
                <input id="add-description" name="description" maxlength="500" />
                ${tlsFields('add', 'verify')}
                <button type="submit">Add console</button>
              </form>`
      }
      ${changeNote(frame)}`,
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
          : frame.manage === undefined
            ? html`<div class="card scroll">${json(c.policy)}</div>`
            : ''
      }
      ${
        frame.manage === undefined
          ? ''
          : html`${policyEditor(frame, 'console', c.policy, { consoleId: c.id })}
              <p class="muted">
                A module is enabled by its entry under "modules", for example {"modules":
                {"network": {"state": "read_only"}}}.
              </p>
              <h2>Change this console</h2>
              <div class="grid">
                <form class="card" method="post" action="/manage/console.details">
                  ${authFields(frame, 'details')}
                  <input type="hidden" name="consoleId" value="${c.id}" />
                  <label for="details-host">Host name or address</label>
                  <input id="details-host" name="host" required maxlength="253" value="${c.host}" />
                  <label for="details-description">Description</label>
                  <input
                    id="details-description"
                    name="description"
                    maxlength="500"
                    value="${c.description ?? ''}"
                  />
                  <button type="submit">Save details</button>
                </form>
                <form class="card" method="post" action="/manage/console.tls">
                  ${authFields(frame, 'tls')}
                  <input type="hidden" name="consoleId" value="${c.id}" />
                  ${tlsFields('tls', c.tlsMode)}
                  <button type="submit">Save TLS trust</button>
                </form>
                <form class="card" method="post" action="/manage/console.credential">
                  ${authFields(frame, 'credential')}
                  <input type="hidden" name="consoleId" value="${c.id}" />
                  <label for="credential-module">Module</label>
                  <select id="credential-module" name="module">
                    ${c.modules.map((m) => html`<option value="${m.moduleId}">${m.moduleId}</option>`)}
                  </select>
                  <label for="credential-value">API key or token (stored, never shown again)</label>
                  <input
                    id="credential-value"
                    name="credential"
                    type="password"
                    autocomplete="off"
                    required
                    maxlength="4096"
                  />
                  <button type="submit">Store credential</button>
                </form>
                <form class="card" method="post" action="/manage/console.port">
                  ${authFields(frame, 'port')}
                  <input type="hidden" name="consoleId" value="${c.id}" />
                  <label for="port-module">Module</label>
                  <select id="port-module" name="module">
                    ${c.modules.map((m) => html`<option value="${m.moduleId}">${m.moduleId}</option>`)}
                  </select>
                  <label for="port-value">Port (empty for the default)</label>
                  <input id="port-value" name="port" inputmode="numeric" maxlength="5" />
                  <button type="submit">Save port</button>
                </form>
                <form class="card" method="post" action="/manage/console.check">
                  ${authFields(frame, 'check')}
                  <input type="hidden" name="consoleId" value="${c.id}" />
                  <label for="check-module">Module</label>
                  <select id="check-module" name="module">
                    ${c.modules.map((m) => html`<option value="${m.moduleId}">${m.moduleId}</option>`)}
                  </select>
                  <button class="secondary" type="submit">Check the connection</button>
                </form>
                <form class="card" method="post" action="/manage/console.remove">
                  ${authFields(frame, 'remove')}
                  <input type="hidden" name="consoleId" value="${c.id}" />
                  <label for="remove-confirm"
                    >Type the alias "${c.alias}" to remove this console</label
                  >
                  <input
                    id="remove-confirm"
                    name="confirm"
                    maxlength="63"
                    autocomplete="off"
                    required
                  />
                  <button class="danger" type="submit">Remove console</button>
                </form>
              </div>
              <p class="muted">
                An application version that the console cannot report (UniFi Access) is declared on
                the host only: <code>unifi-mcp console declare-version</code>.
              </p>`
      }
      ${changeNote(frame)}`,
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
      ${
        frame.manage === undefined
          ? ''
          : html`<h2>Create a client</h2>
              <form class="card" method="post" action="/manage/client.create">
                ${authFields(frame, 'create')}
                <label for="create-id">Client id (lowercase letters, digits, ".", "_", "-")</label>
                <input id="create-id" name="clientId" required maxlength="64" />
                <label for="create-description">Description (optional)</label>
                <input id="create-description" name="description" maxlength="500" />
                <label for="create-policy">Policy (JSON; empty grants nothing)</label>
                <textarea
                  id="create-policy"
                  name="policy"
                  rows="8"
                  maxlength="60000"
                  spellcheck="false"
                  placeholder='{"consoles": {"home": {}}, "allow": ["network.*.read"]}'
                ></textarea>
                <button type="submit">Create client and show its token once</button>
              </form>`
      }
      ${changeNote(frame)}`,
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
          : frame.manage === undefined
            ? html`<div class="card scroll">${json(c.policy)}</div>`
            : ''
      }
      ${
        frame.manage === undefined
          ? ''
          : html`${policyEditor(frame, 'client', c.policy, { clientId: c.clientId })}
              <h2>Change this client</h2>
              <div class="grid">
                <form class="card" method="post" action="/manage/client.rotate">
                  ${authFields(frame, 'rotate')}
                  <input type="hidden" name="clientId" value="${c.clientId}" />
                  <p>Issue a new token. The earlier tokens stop working at once.</p>
                  <button type="submit">Rotate the token</button>
                </form>
                <form class="card" method="post" action="/manage/client.revoke">
                  ${authFields(frame, 'revoke')}
                  <input type="hidden" name="clientId" value="${c.clientId}" />
                  <p>Revoke the client. Open connections are closed; it cannot be undone here.</p>
                  <button class="danger" type="submit">Revoke</button>
                </form>
                <form class="card" method="post" action="/manage/client.remove">
                  ${authFields(frame, 'remove')}
                  <input type="hidden" name="clientId" value="${c.clientId}" />
                  <label for="remove-confirm"
                    >Type the id "${c.clientId}" to remove this client</label
                  >
                  <input
                    id="remove-confirm"
                    name="confirm"
                    maxlength="64"
                    autocomplete="off"
                    required
                  />
                  <button class="danger" type="submit">Remove client</button>
                </form>
              </div>`
      }
      ${changeNote(frame)}`,
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
      ${
        frame.manage === undefined
          ? ''
          : html`<form class="card" method="post" action="/manage/policy.mode">
              ${authFields(frame, 'mode')}
              <p>
                Runtime mode. <strong>read_only</strong> stops every write at once, for all clients.
              </p>
              <button type="submit" name="mode" value="read_only">Switch to read_only</button>
              <button class="danger" type="submit" name="mode" value="read_write">
                Switch to read_write
              </button>
            </form>`
      }
      <h2>Global policy</h2>
      ${
        frame.manage === undefined
          ? html`<div class="card scroll">${json(p.document)}</div>`
          : policyEditor(frame, 'global', p.document, { version: String(p.version) })
      }
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
      ${changeNote(frame)}`,
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
