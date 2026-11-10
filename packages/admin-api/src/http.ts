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
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ADMIN_CSS,
  approvalPage,
  approvalsPage,
  auditPage,
  dashboardPage,
  errorPage,
  loginPage,
  type ApprovalRow,
  type AuditFilters,
  type DashboardView,
  type Frame,
} from '@unifi-local-mcp/admin-ui';
import { ApprovalError, type ApprovalService, type ApprovalView } from '@unifi-local-mcp/approvals';
import type {
  AuditActorType,
  AuditLog,
  AuditOutcome,
  AuditQuery,
  Logger,
} from '@unifi-local-mcp/telemetry';
import type { AdminStore } from './admins.ts';
import { safeEqual, type AdminSession, type AdminSessionStore } from './sessions.ts';

export const SESSION_COOKIE = '__Host-umcp_admin';
const MAX_BODY_BYTES = 16 * 1024;
const AUDIT_PAGE_SIZE = 50;
const FAILURE_WINDOW_MS = 15 * 60_000;
const MAX_FAILURES_PER_USERNAME = 5;
const MAX_FAILURES_PER_ADDRESS = 20;

const CSP =
  "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

export interface AdminHttpOptions {
  admins: AdminStore;
  sessions: AdminSessionStore;
  approvals: ApprovalService;
  audit: AuditLog;
  logger: Logger;
  /** Dashboard data, assembled by the service from its stores. */
  status: () => Promise<DashboardView>;
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
      else this.#send(res, 200, loginPage({ title: 'Sign in' }));
      return;
    }

    const session = this.#session(req);
    if (session === undefined) {
      if (method === 'POST') throw new HttpFailure(403, 'Your session has ended. Sign in again.');
      this.#redirect(res, '/login');
      return;
    }
    const frame: Frame = {
      title: '',
      username: session.admin.username,
      csrfToken: session.csrfToken,
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
    const keys = [`user:${username}`, `addr:${this.#remote(req)}`];
    if (this.#blocked(keys)) {
      // The attempted username is not recorded: it may be a mistyped password.
      this.#audit('admin.login', 'denied', undefined, req, { reason: 'throttled' });
      this.#send(
        res,
        429,
        loginPage({
          title: 'Sign in',
          notice: {
            kind: 'error',
            text: 'Too many failed sign-ins. Wait 15 minutes and try again.',
          },
        }),
      );
      return;
    }
    const admin = username === '' ? undefined : this.#o.admins.verify(username, password);
    if (admin === undefined) {
      this.#failed(keys);
      this.#audit('admin.login', 'denied', undefined, req, { reason: 'invalid_credentials' });
      this.#send(
        res,
        401,
        loginPage({
          title: 'Sign in',
          notice: { kind: 'error', text: 'The username or password is wrong.' },
        }),
      );
      return;
    }
    this.#failures.delete(keys[0] ?? '');
    const { cookieValue } = this.#o.sessions.create(admin);
    this.#o.admins.recordLogin(admin.id);
    this.#audit('admin.login', 'success', admin.username, req, {});
    this.#redirect(
      res,
      '/',
      `${SESSION_COOKIE}=${cookieValue}; Path=/; Secure; HttpOnly; SameSite=Strict`,
    );
  }

  #showApproval(res: ServerResponse, frame: Frame, id: string, status: number): void {
    const view = this.#o.approvals.get(id);
    if (view === undefined) {
      this.#send(res, 404, errorPage(frame, 'Not found', 'There is no such approval request.'));
      return;
    }
    this.#send(
      res,
      status,
      approvalPage({ ...frame, title: 'Approval request' }, { ...toRow(view), ...view }),
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
        // Recent re-authentication: every approval needs the password again.
        const keys = [`user:${username}`, `addr:${this.#remote(req)}`];
        const verified =
          !this.#blocked(keys) &&
          this.#o.admins.verify(username, field(form, 'password', 1024)) !== undefined;
        if (!verified) {
          this.#failed(keys);
          this.#audit('admin.reauthenticate', 'denied', username, req, { approvalId: id });
          this.#showApproval(
            res,
            {
              ...frame,
              notice: { kind: 'error', text: 'The password is wrong; nothing was approved.' },
            },
            id,
            401,
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
      );
    }
  }

  #auditPage(res: ServerResponse, frame: Frame, params: URLSearchParams): void {
    const filters: AuditFilters = {};
    const query: AuditQuery = { limit: AUDIT_PAGE_SIZE };
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
}
