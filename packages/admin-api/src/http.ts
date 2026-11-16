/**
 * The admin web listener (spec §7.2, §7.3, §13.1; ADR 0016).
 *
 * Separate from the MCP listener: its own port, bind and certificate, and its own
 * authentication (password sign-in and a session cookie). It never accepts MCP bearer
 * tokens, and the MCP listener never accepts its cookie.
 *
 * Every response carries a strict CSP (no scripts at all), `no-store`, framing and MIME
 * sniffing protection. Every request must name an allowed Host (DNS rebinding). Every POST
 * must come from the same origin (`Origin` required) and, once signed in, carry the
 * session's CSRF token. Sign-in failures are throttled per username and per address.
 *
 * Two-step sign-in (ADR 0026): an account with an active second step signs in with its
 * password and a code in one form, and approves with both. A failure says only that the
 * username, password or code is wrong. With `requireMfa`, an account without a second
 * step cannot sign in at all.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  accountPage,
  ADMIN_CSS,
  approvalPage,
  approvalsPage,
  auditPage,
  clientPage,
  clientsPage,
  consolePage,
  consolesPage,
  dashboardPage,
  errorPage,
  loginPage,
  policyPage,
  previewPage,
  reportPage,
  revealPage,
  settingsPage,
  type ApprovalRow,
  type AuditFilters,
  type ClientDetail,
  type ClientRow,
  type ConsoleDetail,
  type ConsoleRow,
  type DashboardView,
  type Frame,
  type PolicyView,
  type SettingsView,
} from '@unifi-local-mcp/admin-ui';
import { ApprovalError, type ApprovalService, type ApprovalView } from '@unifi-local-mcp/approvals';
import type {
  AuditActorType,
  AuditEntry,
  AuditLog,
  AuditOutcome,
  AuditQuery,
  Logger,
} from '@unifi-local-mcp/telemetry';
import type { AdminStore } from './admins.ts';
import type { AdminMfa } from './mfa.ts';
import { safeEqual, type AdminSession, type AdminSessionStore } from './sessions.ts';

export const SESSION_COOKIE = '__Host-umcp_admin';
const MAX_BODY_BYTES = 64 * 1024;
/** How long after a password check changes need no new one (approvals always need one). */
const REAUTH_WINDOW_MS = 5 * 60_000;
const MAX_FLASHES = 1000;
const AUDIT_PAGE_SIZE = 50;
const AUDIT_EXPORT_MAX = 5000;
const AUDIT_EXPORT_BATCH = 500;
const FAILURE_WINDOW_MS = 15 * 60_000;
const MAX_FAILURES_PER_USERNAME = 5;
const MAX_FAILURES_PER_ADDRESS = 20;

const CSP =
  "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

/**
 * Read-only views of consoles, clients, the policy and the settings (spec §13.1; ADR
 * 0027), assembled by the service from its stores. None of them carries a credential.
 */
export interface AdminViews {
  consoles(): ConsoleRow[];
  console(id: string): ConsoleDetail | undefined;
  clients(): ClientRow[];
  client(id: string): ClientDetail | undefined;
  policy(): PolicyView;
  settings(): SettingsView;
}

/** What a change came to (ADR 0027 §3). */
export interface ChangeOutcome {
  /** Where the administrator continues. */
  redirect: string;
  notice: string;
  /** A secret shown once, in the page that answers this request (a new client token). */
  reveal?: { label: string; value: string };
  /** A result to read, as name and value rows (a connection check). */
  report?: [string, string][];
}

/** What a policy change would do to each client's usable operations. */
export interface PolicyPreview {
  title: string;
  clients: { clientId: string; before: number; after: number; gained: string[]; lost: string[] }[];
}

/**
 * Changes from the web interface (ADR 0027 §3), provided by the service only when the
 * deployment enables them. Refusals are errors with a `code` and a message.
 */
export interface AdminActions {
  names(): string[];
  run(
    change: string,
    form: URLSearchParams,
    actor: { type: 'admin'; id: string },
  ): Promise<ChangeOutcome>;
  preview(kind: 'global' | 'console' | 'client', form: URLSearchParams): PolicyPreview;
}

export interface AdminHttpOptions {
  admins: AdminStore;
  sessions: AdminSessionStore;
  /** Two-step sign-in (ADR 0026). */
  mfa: AdminMfa;
  /** Refuse sign-in to accounts without an active second step. */
  requireMfa: boolean;
  approvals: ApprovalService;
  audit: AuditLog;
  logger: Logger;
  /** Dashboard data, assembled by the service from its stores. */
  status: () => Promise<DashboardView>;
  views: AdminViews;
  /** Undefined unless the deployment allows changes from the web interface. */
  actions?: AdminActions | undefined;
  /** Host header names accepted (DNS-rebinding protection). */
  allowedHosts: string[];
  /** True when this listener terminates TLS itself (adds HSTS). */
  tls: boolean;
  now?: () => Date;
}

class HttpFailure extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function hostName(header: string | undefined): string | undefined {
  if (header === undefined || header === '') return undefined;
  const value = header.trim().toLowerCase();
  const bracketed = /^(\[[0-9a-f:.]+\])(?::\d{1,5})?$/.exec(value);
  if (bracketed !== null) return bracketed[1];
  const plain = /^([a-z0-9.-]{1,253})(?::\d{1,5})?$/.exec(value);
  return plain?.[1];
}

function cookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const type = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
  if (type !== 'application/x-www-form-urlencoded') {
    throw new HttpFailure(415, 'Forms must be sent as application/x-www-form-urlencoded.');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpFailure(413, 'The form is too large.');
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

function field(form: URLSearchParams, name: string, max: number): string {
  return (form.get(name) ?? '').slice(0, max);
}

function toRow(view: ApprovalView): ApprovalRow {
  return {
    id: view.id,
    status: view.status,
    clientId: view.clientId,
    operationId: view.operationId,
    risk: view.risk,
    consoleId: view.consoleId,
    siteId: view.siteId,
    createdAt: view.createdAt,
    expiresAt: view.expiresAt,
    executeBy: view.executeBy,
  };
}

const ACTOR_TYPES = new Set<string>(['mcp_client', 'admin', 'cli', 'system']);
const OUTCOMES = new Set<string>(['success', 'denied', 'failure', 'pending', 'outcome_unknown']);
const DONE_NOTICES: Record<string, string> = {
  approved: 'Approved. The requesting client can now resume it until the time shown.',
  rejected: 'Rejected.',
};

interface Failures {
  count: number;
  since: number;
}

export class AdminHttpService {
  readonly #o: AdminHttpOptions;
  readonly #now: () => Date;
  readonly #failures = new Map<string, Failures>();
  /** One notice per session, shown on its next page: the result of a change. */
  readonly #flash = new Map<string, string>();

  constructor(options: AdminHttpOptions) {
    this.#o = options;
    this.#now = options.now ?? (() => new Date());
  }

  /** The `node:http` / `node:https` request listener. */
  readonly listener = (req: IncomingMessage, res: ServerResponse): void => {
    this.#handle(req, res).catch((error: unknown) => {
      if (error instanceof HttpFailure) {
        this.#send(
          res,
          error.status,
          errorPage({ title: 'Error' }, 'Request refused', error.message),
        );
        return;
      }
      this.#o.logger.error('admin request failed', { err: error });
      this.#send(
        res,
        500,
        errorPage({ title: 'Error' }, 'Something went wrong', 'The error was logged.'),
      );
    });
  };

  #headers(res: ServerResponse): void {
    res.setHeader('content-security-policy', CSP);
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('cross-origin-opener-policy', 'same-origin');
    res.setHeader('cross-origin-resource-policy', 'same-origin');
    res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    if (this.#o.tls) res.setHeader('strict-transport-security', 'max-age=31536000');
  }

  #send(
    res: ServerResponse,
    status: number,
    body: string,
    type = 'text/html; charset=utf-8',
  ): void {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    this.#headers(res);
    res.writeHead(status, { 'content-type': type });
    res.end(body);
  }

  #redirect(res: ServerResponse, location: string, setCookie?: string): void {
    this.#headers(res);
    res.writeHead(303, {
      location,
      ...(setCookie === undefined ? {} : { 'set-cookie': setCookie }),
    });
    res.end();
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = hostName(req.headers.host);
    if (host === undefined || !this.#o.allowedHosts.includes(host)) {
      this.#send(res, 403, 'Forbidden host.', 'text/plain; charset=utf-8');
      return;
    }
    const url = new URL(req.url ?? '/', 'http://admin.invalid');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') {
      throw new HttpFailure(405, 'Method not allowed.');
    }
    if (method === 'POST') this.#checkOrigin(req);

    if (path === '/static/admin.css' && method !== 'POST') {
      this.#send(res, 200, ADMIN_CSS, 'text/css; charset=utf-8');
      return;
    }
    if (path === '/login') {
      if (method === 'POST') await this.#login(req, res);
      else if (this.#session(req) !== undefined) this.#redirect(res, '/');
      else this.#send(res, 200, loginPage({ title: 'Sign in' }, this.#o.requireMfa));
      return;
    }

    const session = this.#session(req);
    if (session === undefined) {
      if (method === 'POST') throw new HttpFailure(403, 'Your session has ended. Sign in again.');
      this.#redirect(res, '/login');
      return;
    }
    const flash = method === 'GET' ? this.#flash.get(session.id) : undefined;
    if (flash !== undefined) this.#flash.delete(session.id);
    const frame: Frame = {
      title: '',
      username: session.admin.username,
      csrfToken: session.csrfToken,
      ...(flash === undefined ? {} : { notice: { kind: 'ok' as const, text: flash } }),
      ...(this.#o.actions === undefined
        ? {}
        : {
            manage: {
              passwordNeeded: !this.#recentlyAuthenticated(session),
              codeNeeded: this.#o.mfa.status(session.admin.id).state === 'active',
            },
          }),
    };
    let form: URLSearchParams | undefined;
    if (method === 'POST') {
      form = await readForm(req);
      if (!safeEqual(form.get('csrf') ?? '', session.csrfToken)) {
        throw new HttpFailure(403, 'The form has expired. Reload the page and try again.');
      }
    }

    if (path === '/logout' && form !== undefined) {
      this.#o.sessions.revoke(session.id);
      this.#audit('admin.logout', 'success', session.admin.username, req, {});
      this.#redirect(
        res,
        '/login',
        `${SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`,
      );
      return;
    }
    if (path === '/' && form === undefined) {
      this.#send(res, 200, dashboardPage({ ...frame, title: 'Dashboard' }, await this.#o.status()));
      return;
    }
    if (path === '/account' && form === undefined) {
      const mfa = this.#o.mfa.status(session.admin.id);
      const usedRecovery = url.searchParams.get('recovery') === 'used';
      this.#send(
        res,
        200,
        accountPage(
          {
            ...frame,
            title: 'Account',
            ...(usedRecovery
              ? {
                  notice: {
                    kind: 'error' as const,
                    text: `You signed in with a recovery code. It cannot be used again; ${String(mfa.recoveryCodesLeft)} are left.`,
                  },
                }
              : {}),
          },
          {
            username: session.admin.username,
            lastLoginAt: session.admin.lastLoginAt,
            sessionExpiresAt: session.expiresAt,
            mfaState: mfa.state,
            mfaConfirmedAt: mfa.confirmedAt,
            recoveryCodesLeft: mfa.recoveryCodesLeft,
            requireMfa: this.#o.requireMfa,
          },
        ),
      );
      return;
    }
    if (path === '/approvals' && form === undefined) {
      const pending = this.#o.approvals.list({ status: 'pending' }).map(toRow);
      const recent = this.#o.approvals
        .list()
        .filter((a) => a.status !== 'pending')
        .slice(0, 50)
        .map(toRow);
      this.#send(res, 200, approvalsPage({ ...frame, title: 'Approvals' }, pending, recent));
      return;
    }
    const approval = /^\/approvals\/([0-9a-f-]{36})(?:\/(approve|reject))?$/.exec(path);
    if (approval !== null) {
      const id = approval[1] ?? '';
      const action = approval[2];
      if (action === undefined && form === undefined) {
        const done = url.searchParams.get('done') ?? '';
        const notice = DONE_NOTICES[done];
        this.#showApproval(
          res,
          { ...frame, ...(notice === undefined ? {} : { notice: { kind: 'ok', text: notice } }) },
          id,
          200,
          session.admin.id,
        );
        return;
      }
      if (action !== undefined && form !== undefined) {
        this.#decide(req, res, frame, session, id, action, form);
        return;
      }
    }
    if (path === '/audit' && form === undefined) {
      this.#auditPage(res, frame, url.searchParams);
      return;
    }
    if (path === '/audit/export' && form === undefined) {
      this.#auditExport(req, res, session, url.searchParams);
      return;
    }
    if (form === undefined && this.#managePage(res, frame, path)) return;
    const manage = /^\/manage\/(preview\/(global|console|client)|[a-z]+\.[a-z]+)$/.exec(path);
    if (manage !== null && form !== undefined && this.#o.actions !== undefined) {
      const kind = manage[2] as 'global' | 'console' | 'client' | undefined;
      if (kind !== undefined) this.#preview(res, frame, this.#o.actions, kind, form);
      else await this.#change(req, res, frame, session, this.#o.actions, manage[1] ?? '', form);
      return;
    }
    this.#send(res, 404, errorPage(frame, 'Not found', 'There is no such page.'));
  }

  #checkOrigin(req: IncomingMessage): void {
    const origin = req.headers.origin;
    let originHost: string | undefined;
    try {
      originHost =
        origin === undefined || origin === 'null' ? undefined : new URL(origin).host.toLowerCase();
    } catch {
      originHost = undefined;
    }
    const site = req.headers['sec-fetch-site'];
    if (
      originHost === undefined ||
      originHost !== (req.headers.host ?? '').toLowerCase() ||
      (site !== undefined && site !== 'same-origin')
    ) {
      throw new HttpFailure(403, 'Cross-origin form submissions are refused.');
    }
  }

  #session(req: IncomingMessage): AdminSession | undefined {
    return this.#o.sessions.authenticate(cookie(req, SESSION_COOKIE));
  }

  #remote(req: IncomingMessage): string {
    return req.socket.remoteAddress ?? 'unknown';
  }

  #blocked(keys: string[]): boolean {
    const now = this.#now().getTime();
    return keys.some((key) => {
      const entry = this.#failures.get(key);
      if (entry === undefined) return false;
      if (now - entry.since > FAILURE_WINDOW_MS) {
        this.#failures.delete(key);
        return false;
      }
      return (
        entry.count >=
        (key.startsWith('user:') ? MAX_FAILURES_PER_USERNAME : MAX_FAILURES_PER_ADDRESS)
      );
    });
  }

  #failed(keys: string[]): void {
    const now = this.#now().getTime();
    for (const key of keys) {
      const entry = this.#failures.get(key);
      if (entry === undefined || now - entry.since > FAILURE_WINDOW_MS)
        this.#failures.set(key, { count: 1, since: now });
      else entry.count += 1;
    }
  }

  #audit(
    action: string,
    outcome: AuditOutcome,
    username: string | undefined,
    req: IncomingMessage,
    details: Record<string, unknown>,
  ): void {
    this.#o.audit.record({
      eventType: 'admin.auth',
      action,
      outcome,
      actor: username === undefined ? { type: 'admin' } : { type: 'admin', id: username },
      details: { remoteAddress: this.#remote(req), ...details },
    });
  }

  async #login(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const form = await readForm(req);
    const username = field(form, 'username', 64).trim().toLowerCase();
    const password = field(form, 'password', 1024);
    const code = field(form, 'code', 64);
    const keys = [`user:${username}`, `addr:${this.#remote(req)}`];
    const refuse = (status: number, text: string): void => {
      this.#send(
        res,
        status,
        loginPage({ title: 'Sign in', notice: { kind: 'error', text } }, this.#o.requireMfa),
      );
    };
    if (this.#blocked(keys)) {
      // The attempted username is not recorded: it may be a mistyped password.
      this.#audit('admin.login', 'denied', undefined, req, { reason: 'throttled' });
      refuse(429, 'Too many failed sign-ins. Wait 15 minutes and try again.');
      return;
    }
    const admin = username === '' ? undefined : this.#o.admins.verify(username, password);
    if (admin === undefined) {
      this.#failed(keys);
      this.#audit('admin.login', 'denied', undefined, req, { reason: 'invalid_credentials' });
      refuse(401, 'The username, password or code is wrong.');
      return;
    }
    // The password is right. From here the audit names the account: a correct password
    // with a wrong code is worth noticing.
    let secondFactor: string | undefined;
    if (this.#o.mfa.status(admin.id).state === 'active') {
      secondFactor = this.#o.mfa.verify(admin.id, code);
      if (secondFactor === undefined) {
        this.#failed(keys);
        this.#audit('admin.login', 'denied', admin.username, req, {
          reason: 'second_step_failed',
        });
        refuse(401, 'The username, password or code is wrong.');
        return;
      }
    } else if (this.#o.requireMfa) {
      this.#failed(keys);
      this.#audit('admin.login', 'denied', admin.username, req, { reason: 'second_step_required' });
      refuse(
        403,
        'This service requires two-step sign-in, and this account has none. Set it up on ' +
          'the host with "unifi-mcp admin enable-mfa".',
      );
      return;
    }
    this.#failures.delete(keys[0] ?? '');
    const { cookieValue } = this.#o.sessions.create(admin);
    this.#o.admins.recordLogin(admin.id);
    this.#audit('admin.login', 'success', admin.username, req, {
      ...(secondFactor === undefined ? {} : { secondStep: secondFactor }),
    });
    if (secondFactor === 'recovery_code') {
      this.#o.logger.warn('an administrator signed in with a recovery code', {
        username: admin.username,
      });
    }
    this.#redirect(
      res,
      secondFactor === 'recovery_code' ? '/account?recovery=used' : '/',
      `${SESSION_COOKIE}=${cookieValue}; Path=/; Secure; HttpOnly; SameSite=Strict`,
    );
  }

  #showApproval(
    res: ServerResponse,
    frame: Frame,
    id: string,
    status: number,
    adminId: string,
  ): void {
    const view = this.#o.approvals.get(id);
    if (view === undefined) {
      this.#send(res, 404, errorPage(frame, 'Not found', 'There is no such approval request.'));
      return;
    }
    this.#send(
      res,
      status,
      approvalPage(
        { ...frame, title: 'Approval request' },
        { ...toRow(view), ...view },
        this.#o.mfa.status(adminId).state === 'active',
      ),
    );
  }

  #decide(
    req: IncomingMessage,
    res: ServerResponse,
    frame: Frame,
    session: AdminSession,
    id: string,
    action: string,
    form: URLSearchParams,
  ): void {
    const note = field(form, 'note', 500).trim();
    const username = session.admin.username;
    try {
      if (action === 'approve') {
        // Recent re-authentication: every approval needs the password again, and a fresh
        // code when the account has a second step (ADR 0026).
        const keys = [`user:${username}`, `addr:${this.#remote(req)}`];
        const mfaActive = this.#o.mfa.status(session.admin.id).state === 'active';
        const verified =
          !this.#blocked(keys) &&
          this.#o.admins.verify(username, field(form, 'password', 1024)) !== undefined &&
          (!mfaActive ||
            this.#o.mfa.verify(session.admin.id, field(form, 'code', 64)) !== undefined);
        if (!verified) {
          this.#failed(keys);
          this.#audit('admin.reauthenticate', 'denied', username, req, { approvalId: id });
          this.#showApproval(
            res,
            {
              ...frame,
              notice: {
                kind: 'error',
                text: mfaActive
                  ? 'The password or code is wrong; nothing was approved. A code works once: wait for the next one.'
                  : 'The password is wrong; nothing was approved.',
              },
            },
            id,
            401,
            session.admin.id,
          );
          return;
        }
        const authenticatedAt = this.#o.sessions.reauthenticated(session.id);
        this.#o.approvals.approve(
          id,
          { type: 'admin', id: username, authenticatedAt },
          note === '' ? undefined : note,
        );
        this.#redirect(res, `/approvals/${id}?done=approved`);
        return;
      }
      this.#o.approvals.reject(
        id,
        { type: 'admin', id: username, authenticatedAt: session.authenticatedAt },
        note === '' ? undefined : note,
      );
      this.#redirect(res, `/approvals/${id}?done=rejected`);
    } catch (error) {
      if (!(error instanceof ApprovalError)) throw error;
      this.#showApproval(
        res,
        { ...frame, notice: { kind: 'error', text: `${error.message} (${error.code})` } },
        id,
        409,
        session.admin.id,
      );
    }
  }

  #recentlyAuthenticated(session: AdminSession): boolean {
    return this.#now().getTime() - session.authenticatedAt.getTime() <= REAUTH_WINDOW_MS;
  }

  /**
   * Recent re-authentication for a change (spec §7.2): the password was checked within the
   * last five minutes, or the form carries it (and a code, with a second step) now.
   */
  #reauthenticate(req: IncomingMessage, session: AdminSession, form: URLSearchParams): boolean {
    if (this.#recentlyAuthenticated(session)) return true;
    const username = session.admin.username;
    const keys = [`user:${username}`, `addr:${this.#remote(req)}`];
    const mfaActive = this.#o.mfa.status(session.admin.id).state === 'active';
    const verified =
      !this.#blocked(keys) &&
      this.#o.admins.verify(username, field(form, 'password', 1024)) !== undefined &&
      (!mfaActive || this.#o.mfa.verify(session.admin.id, field(form, 'code', 64)) !== undefined);
    if (!verified) {
      this.#failed(keys);
      return false;
    }
    this.#o.sessions.reauthenticated(session.id);
    return true;
  }

  /** One change from the web interface: re-authenticate, run it, show what it came to. */
  async #change(
    req: IncomingMessage,
    res: ServerResponse,
    frame: Frame,
    session: AdminSession,
    actions: AdminActions,
    change: string,
    form: URLSearchParams,
  ): Promise<void> {
    const username = session.admin.username;
    if (!this.#reauthenticate(req, session, form)) {
      this.#audit('admin.reauthenticate', 'denied', username, req, { change });
      this.#send(
        res,
        401,
        errorPage(
          frame,
          'Not changed',
          'The password or code is wrong, or missing; nothing was changed. Go back and try again.',
        ),
      );
      return;
    }
    let outcome: ChangeOutcome;
    try {
      outcome = await actions.run(change, form, { type: 'admin', id: username });
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (!(error instanceof Error) || typeof code !== 'string') throw error;
      this.#send(res, 400, errorPage(frame, 'Not changed', `${error.message} (${code})`));
      return;
    }
    if (outcome.reveal !== undefined) {
      this.#send(
        res,
        200,
        revealPage(
          { ...frame, title: 'Shown once' },
          outcome.notice,
          outcome.reveal,
          outcome.redirect,
        ),
      );
      return;
    }
    if (outcome.report !== undefined) {
      this.#send(
        res,
        200,
        reportPage({ ...frame, title: 'Result' }, outcome.notice, outcome.report, outcome.redirect),
      );
      return;
    }
    if (this.#flash.size >= MAX_FLASHES) this.#flash.clear();
    this.#flash.set(session.id, outcome.notice);
    this.#redirect(res, outcome.redirect);
  }

  /** Shows what a policy change would do. Changes nothing, so it needs no password. */
  #preview(
    res: ServerResponse,
    frame: Frame,
    actions: AdminActions,
    kind: 'global' | 'console' | 'client',
    form: URLSearchParams,
  ): void {
    let preview: PolicyPreview;
    try {
      preview = actions.preview(kind, form);
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (!(error instanceof Error) || typeof code !== 'string') throw error;
      this.#send(res, 400, errorPage(frame, 'Not a usable policy', `${error.message} (${code})`));
      return;
    }
    this.#send(
      res,
      200,
      previewPage({ ...frame, title: 'Preview' }, preview, {
        kind,
        policy: field(form, 'policy', MAX_BODY_BYTES),
        consoleId: field(form, 'consoleId', 64),
        clientId: field(form, 'clientId', 64),
        version: field(form, 'version', 16),
      }),
    );
  }

  /** Consoles, clients, policy and settings: read-only pages. True when one was sent. */
  #managePage(res: ServerResponse, frame: Frame, path: string): boolean {
    const views = this.#o.views;
    const notFound = (what: string): true => {
      this.#send(res, 404, errorPage(frame, 'Not found', `There is no such ${what}.`));
      return true;
    };
    if (path === '/consoles') {
      this.#send(res, 200, consolesPage({ ...frame, title: 'Consoles' }, views.consoles()));
      return true;
    }
    const consoleMatch = /^\/consoles\/([0-9a-f-]{36})$/.exec(path);
    if (consoleMatch !== null) {
      const view = views.console(consoleMatch[1] ?? '');
      if (view === undefined) return notFound('console');
      this.#send(res, 200, consolePage({ ...frame, title: `Console ${view.alias}` }, view));
      return true;
    }
    if (path === '/clients') {
      this.#send(res, 200, clientsPage({ ...frame, title: 'MCP clients' }, views.clients()));
      return true;
    }
    const clientMatch = /^\/clients\/([a-z0-9._-]{1,64})$/.exec(path);
    if (clientMatch !== null) {
      const view = views.client(clientMatch[1] ?? '');
      if (view === undefined) return notFound('client');
      this.#send(res, 200, clientPage({ ...frame, title: `Client ${view.clientId}` }, view));
      return true;
    }
    if (path === '/policy') {
      this.#send(res, 200, policyPage({ ...frame, title: 'Policy' }, views.policy()));
      return true;
    }
    if (path === '/settings') {
      this.#send(res, 200, settingsPage({ ...frame, title: 'Settings' }, views.settings()));
      return true;
    }
    return false;
  }

  /** The audit filters of a query string: what to echo in the form, and what to query. */
  #auditFilters(params: URLSearchParams): { filters: AuditFilters; query: AuditQuery } {
    const filters: AuditFilters = {};
    const query: AuditQuery = {};
    const actorType = params.get('actorType') ?? '';
    if (ACTOR_TYPES.has(actorType)) {
      filters.actorType = actorType;
      query.actorType = actorType as AuditActorType;
    }
    const outcome = params.get('outcome') ?? '';
    if (OUTCOMES.has(outcome)) {
      filters.outcome = outcome;
      query.outcome = outcome as AuditOutcome;
    }
    const eventType = params.get('eventType') ?? '';
    if (/^[a-z][a-z0-9_.-]{0,63}$/.test(eventType)) {
      filters.eventType = eventType;
      query.eventType = eventType;
    }
    const actorId = params.get('actorId') ?? '';
    if (/^[A-Za-z0-9._:@-]{1,128}$/.test(actorId)) {
      filters.actorId = actorId;
      query.actorId = actorId;
    }
    for (const bound of ['since', 'until'] as const) {
      const text = (params.get(bound) ?? '').trim();
      if (!/^\d{4}-\d{2}-\d{2}([T ][0-9:.]{5,12}(Z|[+-]\d{2}:\d{2})?)?$/.test(text)) continue;
      // A date without a time or zone is the start of that day in UTC.
      const date = new Date(/[T ]/.test(text) ? text.replace(' ', 'T') : `${text}T00:00:00Z`);
      if (Number.isNaN(date.getTime())) continue;
      filters[bound] = text;
      query[bound] = date;
    }
    return { filters, query };
  }

  #auditPage(res: ServerResponse, frame: Frame, params: URLSearchParams): void {
    const { filters, query } = this.#auditFilters(params);
    query.limit = AUDIT_PAGE_SIZE;
    const before = Number(params.get('before') ?? '');
    if (Number.isSafeInteger(before) && before > 0) query.beforeSeq = before;
    const rows = this.#o.audit.list(query);
    const last = rows.at(-1);
    const older =
      rows.length === AUDIT_PAGE_SIZE && last !== undefined
        ? `/audit?${new URLSearchParams({ ...filters, before: String(last.seq) }).toString()}`
        : undefined;
    this.#send(res, 200, auditPage({ ...frame, title: 'Audit' }, rows, filters, older));
  }

  /**
   * Downloads the entries the filters match, newest first, as CSV or JSON. Entries were
   * redacted when they were written. The export is recorded before anything is sent.
   */
  #auditExport(
    req: IncomingMessage,
    res: ServerResponse,
    session: AdminSession,
    params: URLSearchParams,
  ): void {
    const format = params.get('format') === 'json' ? 'json' : 'csv';
    const { filters, query } = this.#auditFilters(params);
    const entries: AuditEntry[] = [];
    let beforeSeq: number | undefined;
    while (entries.length < AUDIT_EXPORT_MAX) {
      const batch = this.#o.audit.list({
        ...query,
        limit: Math.min(AUDIT_EXPORT_BATCH, AUDIT_EXPORT_MAX - entries.length),
        ...(beforeSeq === undefined ? {} : { beforeSeq }),
      });
      entries.push(...batch);
      const last = batch.at(-1);
      if (batch.length < AUDIT_EXPORT_BATCH || last === undefined) break;
      beforeSeq = last.seq;
    }
    this.#o.audit.record({
      eventType: 'admin.audit',
      action: 'audit.export',
      outcome: 'success',
      actor: { type: 'admin', id: session.admin.username },
      details: { remoteAddress: this.#remote(req), format, entries: entries.length, filters },
    });
    const stamp = this.#now().toISOString().slice(0, 19).replace(/[-:]/g, '');
    this.#headers(res);
    res.writeHead(200, {
      'content-type':
        format === 'json' ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="unifi-mcp-audit-${stamp}Z.${format}"`,
    });
    res.end(format === 'json' ? `${JSON.stringify(entries, null, 2)}\n` : auditCsv(entries));
  }
}

const CSV_COLUMNS = [
  'seq',
  'occurredAt',
  'eventType',
  'action',
  'outcome',
  'actorType',
  'actorId',
  'correlationId',
  'consoleId',
  'application',
  'operationId',
  'errorCode',
  'durationMs',
  'details',
] as const;

/**
 * One CSV cell: always quoted. A value a spreadsheet would run as a formula (it starts
 * with `=`, `+`, `-`, `@`, a tab or a carriage return) gets a leading apostrophe, because
 * audit details can hold text that came from a client or a console.
 */
function csvCell(value: unknown): string {
  const text =
    value === null || value === undefined
      ? ''
      : typeof value === 'string'
        ? value
        : typeof value === 'number'
          ? String(value)
          : JSON.stringify(value);
  const guarded = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${guarded.replace(/"/g, '""')}"`;
}

function auditCsv(entries: AuditEntry[]): string {
  const lines = [CSV_COLUMNS.join(',')];
  for (const entry of entries) {
    lines.push(CSV_COLUMNS.map((column) => csvCell(entry[column])).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}
