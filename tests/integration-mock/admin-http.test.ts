/**
 * The admin web interface (spec §7.2, §7.3, §13.1, §16 Phase 1 gate; ADR 0016):
 *
 * - disabled unless enabled, loopback by default, on its own port;
 * - its own authentication: MCP tokens do not work on it and its cookie does not work on MCP;
 * - Host allowlist, same-origin and CSRF checks on every state change, strict headers;
 * - throttled sign-in; approvals need the password again and never execute anything.
 */
import { describe, expect, it } from 'vitest';
import { totpCode } from '@unifi-local-mcp/admin-api';
import { requestDigest } from '@unifi-local-mcp/core';
import { rebootGateway, RULE } from '../unit/core/fixtures.ts';
import { useTempDirs } from '../unit/storage/fixtures.ts';
import {
  CLI,
  connect,
  INITIALIZE,
  rawRequest,
  startTestService,
  structured,
  type TestService,
} from './fixtures.ts';

const tempDir = useTempDirs();
const PASSWORD = 'correct horse battery staple';

interface Browser {
  get(path: string, headers?: Record<string, string>): ReturnType<typeof rawRequest>;
  post(
    path: string,
    form: Record<string, string>,
    headers?: Record<string, string>,
  ): ReturnType<typeof rawRequest>;
  cookie: string | undefined;
  csrf(path: string): Promise<string>;
}

function browser(adminUrl: string): Browser {
  const origin = new URL(adminUrl).origin;
  const state: { cookie: string | undefined } = { cookie: undefined };
  const remember = (response: Awaited<ReturnType<typeof rawRequest>>): typeof response => {
    const setCookie = response.headers['set-cookie'];
    const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    if (first !== undefined) {
      const value = first.split(';')[0] ?? '';
      state.cookie = value.endsWith('=') ? undefined : value;
    }
    return response;
  };
  const b: Browser = {
    get cookie() {
      return state.cookie;
    },
    set cookie(value) {
      state.cookie = value;
    },
    get: async (path, headers = {}) =>
      remember(
        await rawRequest(new URL(path, adminUrl), {
          headers: { ...(state.cookie === undefined ? {} : { cookie: state.cookie }), ...headers },
        }),
      ),
    post: async (path, form, headers = {}) =>
      remember(
        await rawRequest(new URL(path, adminUrl), {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            origin,
            ...(state.cookie === undefined ? {} : { cookie: state.cookie }),
            ...headers,
          },
          body: new URLSearchParams(form).toString(),
        }),
      ),
    csrf: async (path) => {
      const page = await b.get(path);
      const match = /name="csrf" value="([^"]+)"/.exec(page.body);
      if (match?.[1] === undefined) throw new Error(`no CSRF token on ${path}`);
      return match[1];
    },
  };
  return b;
}

async function setup(): Promise<{ t: TestService; adminUrl: string; b: Browser }> {
  const t = await startTestService({ dir: await tempDir(), admin: true });
  t.service.admins.bootstrap('alice', PASSWORD, CLI);
  const adminUrl = t.service.adminUrl ?? '';
  return { t, adminUrl, b: browser(adminUrl) };
}

async function signIn(b: Browser): Promise<void> {
  const response = await b.post('/login', { username: 'alice', password: PASSWORD });
  expect(response.status).toBe(303);
}

describe('admin listener', () => {
  it('is off by default and separate from the MCP listener when enabled', async () => {
    const off = await startTestService({ dir: await tempDir() });
    expect(off.service.adminUrl).toBeUndefined();
    const { t, adminUrl } = await setup();
    expect(new URL(adminUrl).hostname).toBe('127.0.0.1');
    expect(new URL(adminUrl).port).not.toBe(new URL(t.mcpUrl).port);
    // The admin listener serves no MCP endpoint, the MCP listener no admin pages.
    expect(
      (await rawRequest(new URL('/mcp', adminUrl), { method: 'POST', body: INITIALIZE })).status,
    ).not.toBe(200);
    expect((await rawRequest(new URL('/login', t.mcpUrl), {})).status).toBe(404);
  });

  it('sends strict security headers and refuses foreign Host headers', async () => {
    const { adminUrl } = await setup();
    const page = await rawRequest(new URL('/login', adminUrl), {});
    expect(page.status).toBe(200);
    expect(page.headers['content-security-policy']).toContain("default-src 'none'");
    expect(page.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(page.headers['content-security-policy']).not.toContain('script-src');
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.headers['x-frame-options']).toBe('DENY');
    expect(page.headers['x-content-type-options']).toBe('nosniff');
    expect(page.headers['referrer-policy']).toBe('no-referrer');
    expect(page.body).not.toContain('<script');
    expect(
      (await rawRequest(new URL('/login', adminUrl), { headers: { host: 'attacker.example' } }))
        .status,
    ).toBe(403);
  });
});

describe('admin sign-in and sessions', () => {
  it('signs in with a secure cookie, and signs out', async () => {
    const { t, b } = await setup();
    expect((await b.get('/')).headers['location']).toBe('/login');
    const wrong = await b.post('/login', { username: 'alice', password: 'not the password' });
    expect(wrong.status).toBe(401);
    expect(wrong.body).toContain('The username, password or code is wrong.');
    const login = await b.post('/login', { username: 'alice', password: PASSWORD });
    expect(login.status).toBe(303);
    const setCookie = String(login.headers['set-cookie']);
    expect(setCookie).toMatch(
      /^__Host-umcp_admin=[0-9a-f]{16}\.[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Strict$/,
    );
    const dashboard = await b.get('/');
    expect(dashboard.status).toBe(200);
    expect(dashboard.body).toContain('Hard lock off');
    expect(
      t.service.audit
        .list({ eventType: 'admin.auth', limit: 5 })
        .map((e) => `${e.action}:${e.outcome}:${e.actorId ?? '-'}`),
    ).toEqual(['admin.login:success:alice', 'admin.login:denied:-']);
    const csrf = await b.csrf('/');
    expect((await b.post('/logout', { csrf: 'wrong' })).status).toBe(403);
    expect((await b.post('/logout', { csrf })).status).toBe(303);
    expect(b.cookie).toBeUndefined();
    expect((await b.get('/', {})).status).toBe(303);
  });

  it('refuses cross-origin and token-less form posts', async () => {
    const { b } = await setup();
    expect(
      (
        await b.post(
          '/login',
          { username: 'alice', password: PASSWORD },
          { origin: 'https://attacker.example' },
        )
      ).status,
    ).toBe(403);
    const noOrigin = await b.post(
      '/login',
      { username: 'alice', password: PASSWORD },
      { origin: '' },
    );
    expect(noOrigin.status).toBe(403);
    expect(
      (
        await b.post(
          '/login',
          { username: 'alice', password: PASSWORD },
          { 'sec-fetch-site': 'cross-site' },
        )
      ).status,
    ).toBe(403);
    await signIn(b);
    expect(
      (await b.post('/approvals/00000000-0000-4000-8000-000000000000/reject', {})).status,
    ).toBe(403);
  });

  it('throttles repeated failures for a username, even with the right password next', async () => {
    const { b } = await setup();
    for (let i = 0; i < 5; i++) {
      expect(
        (await b.post('/login', { username: 'alice', password: `wrong password ${String(i)}` }))
          .status,
      ).toBe(401);
    }
    expect((await b.post('/login', { username: 'alice', password: PASSWORD })).status).toBe(429);
  });

  it('does not accept MCP tokens, and MCP does not accept its cookie', async () => {
    const { t, b } = await setup();
    const token = t.token('reader', ['network.*.read']);
    expect((await b.get('/', { authorization: `Bearer ${token}` })).status).toBe(303);
    await signIn(b);
    const mcp = await rawRequest(t.mcpUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        cookie: b.cookie ?? '',
      },
      body: INITIALIZE,
    });
    expect(mcp.status).toBe(401);
  });

  it('ends sessions when the password is reset on the host', async () => {
    const { t, b } = await setup();
    await signIn(b);
    expect((await b.get('/')).status).toBe(200);
    t.service.admins.resetPassword('alice', 'another long passphrase', CLI);
    expect((await b.get('/')).status).toBe(303);
  });
});

describe('admin approvals', () => {
  async function propose(
    t: TestService,
  ): Promise<{ approvalId: string; resume: () => Promise<Record<string, unknown>> }> {
    const writer = await connect(t.mcpUrl, t.token('writer', ['network.*.*']));
    const proposed = structured(
      await writer.callTool({
        name: 'unifi_execute',
        arguments: {
          operationId: 'network.firewall.update_rule',
          consoleId: t.consoleId,
          siteId: 'site-1',
          arguments: { ruleId: RULE, body: { action: 'block' } },
        },
      }),
    );
    expect(proposed['status']).toBe('approval_required');
    const approvalId = String(proposed['approvalId']);
    return {
      approvalId,
      resume: async () =>
        structured(
          await writer.callTool({ name: 'unifi_resume_approved', arguments: { approvalId } }),
        ),
    };
  }

  it('approves only with the password again, and never executes by itself', async () => {
    const { t, b } = await setup();
    const { approvalId, resume } = await propose(t);
    await signIn(b);
    expect((await b.get('/approvals')).body).toContain(`/approvals/${approvalId}`);
    const csrf = await b.csrf(`/approvals/${approvalId}`);
    const noPassword = await b.post(`/approvals/${approvalId}/approve`, { csrf });
    expect(noPassword.status).toBe(401);
    expect(noPassword.body).toContain('nothing was approved');
    expect(
      (await b.post(`/approvals/${approvalId}/approve`, { csrf: 'forged', password: PASSWORD }))
        .status,
    ).toBe(403);
    expect(t.service.approvals.get(approvalId)?.status).toBe('pending');
    const approved = await b.post(`/approvals/${approvalId}/approve`, {
      csrf,
      password: PASSWORD,
      note: 'checked',
    });
    expect(approved.status).toBe(303);
    const view = t.service.approvals.get(approvalId);
    expect(view).toMatchObject({
      status: 'approved',
      decidedBy: 'admin:alice',
      decisionNote: 'checked',
    });
    expect(t.mock.requests.filter((r) => r.method !== 'GET')).toEqual([]); // nothing ran
    expect(await resume()).toMatchObject({ status: 'ok', outcome: 'succeeded' });
    expect((await b.get(`/approvals/${approvalId}`)).body).toContain('consumed');
  });

  it('rejects without the password', async () => {
    const { t, b } = await setup();
    const { approvalId, resume } = await propose(t);
    await signIn(b);
    const csrf = await b.csrf(`/approvals/${approvalId}`);
    expect((await b.post(`/approvals/${approvalId}/reject`, { csrf, note: 'no' })).status).toBe(
      303,
    );
    expect(t.service.approvals.get(approvalId)?.status).toBe('rejected');
    expect(await resume()).toMatchObject({ status: 'denied' });
  });

  it('shows hostile request text escaped and visible', async () => {
    const { t, b } = await setup();
    const hostile = '<script>alert(1)</script>\u202eevil\u001b[2K';
    // Stored request text can come from a client or from UniFi; the MCP layer validates site
    // ids, so the request is created directly to check rendering on its own.
    const target = { consoleId: t.consoleId, siteId: hostile };
    const envelope = t.service.approvals.propose({
      principal: { clientId: 'agent' },
      descriptor: rebootGateway,
      arguments: {},
      target,
      argumentsSha256: requestDigest({
        operationId: rebootGateway.operationId,
        ...target,
        arguments: {},
      }),
      policyVersion: t.service.policyStore.current().version,
      effectiveRisk: 'high',
      correlationId: 'corr-hostile',
    });
    const approvalId = envelope.approvalId ?? '';
    await signIn(b);
    const page = await b.get(`/approvals/${approvalId}`);
    expect(page.status).toBe(200);
    expect(page.body).not.toContain('<script>alert');
    // eslint-disable-next-line no-control-regex -- detecting raw control characters is the point
    expect(page.body).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e]/u);
    expect(page.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;\\u202eevil\\u001b[2K');
  });
});

describe('admin audit page', () => {
  it('lists, filters and pages through entries', async () => {
    const { t, b } = await setup();
    await signIn(b);
    const all = await b.get('/audit');
    expect(all.status).toBe(200);
    expect(all.body).toContain('admin.login');
    const filtered = await b.get('/audit?actorType=admin&outcome=success');
    expect(filtered.body).toContain('admin.login');
    expect(filtered.body).not.toContain('service.start');
    for (let i = 0; i < 60; i++)
      t.service.policyStore.setRuntimeMode(i % 2 === 0 ? 'read_only' : 'read_write', CLI);
    const first = await b.get('/audit');
    const older = /href="(\/audit\?[^"]*before=\d+[^"]*)"/.exec(first.body)?.[1];
    expect(older).toBeDefined();
    expect((await b.get((older ?? '').replaceAll('&amp;', '&'))).status).toBe(200);
  });
});

describe('two-step sign-in (ADR 0026)', () => {
  const STEP_MS = 30_000;

  /** A service with a movable clock, and alice enrolled with a second step. */
  async function withSecondStep(options: { requireMfa?: boolean; enrol?: boolean } = {}) {
    const clock = { time: Date.parse('2026-11-16T10:00:15.000Z') };
    const now = (): Date => new Date(clock.time);
    const t = await startTestService({
      dir: await tempDir(),
      admin: true,
      now,
      ...(options.requireMfa === undefined ? {} : { requireMfa: options.requireMfa }),
    });
    t.service.admins.bootstrap('alice', PASSWORD, CLI);
    let secret = '';
    let codes: string[] = [];
    if (options.enrol ?? true) {
      secret = t.service.mfa.begin('alice', CLI).secret;
      codes = t.service.mfa.confirm('alice', totpCode(secret, now()), CLI);
      clock.time += STEP_MS; // the confirming code is used
    }
    const adminUrl = t.service.adminUrl ?? '';
    return {
      t,
      b: browser(adminUrl),
      adminUrl,
      clock,
      secret,
      codes,
      code: (): string => totpCode(secret, now()),
      next: (): void => {
        clock.time += STEP_MS;
      },
    };
  }
  const login = (b: Browser, extra: Record<string, string>) =>
    b.post('/login', { username: 'alice', password: PASSWORD, ...extra });

  it('asks for a code in the same form, and says only that something is wrong', async () => {
    const { t, b, code, next } = await withSecondStep();
    const page = await b.get('/login');
    expect(page.body).toContain('name="code"');
    expect(page.body).toContain('only if two-step sign-in is on');

    const noCode = await login(b, {});
    const wrongCode = await login(b, { code: '000000' });
    const wrongPassword = await b.post('/login', {
      username: 'alice',
      password: 'not the password!',
      code: code(),
    });
    for (const refused of [noCode, wrongCode, wrongPassword]) {
      expect(refused.status).toBe(401);
      expect(refused.body).toContain('The username, password or code is wrong.');
      expect(refused.headers['set-cookie']).toBeUndefined();
    }
    expect(noCode.body).toBe(wrongPassword.body);
    // The audit trail, which needs host access, does say which: the password was right.
    const denied = t.service.audit.list({ eventType: 'admin.auth', outcome: 'denied', limit: 3 });
    expect(denied.map((e) => [e.actorId, (e.details as { reason: string }).reason])).toEqual([
      [null, 'invalid_credentials'],
      ['alice', 'second_step_failed'],
      ['alice', 'second_step_failed'],
    ]);

    // The wrong password with the right code did not use the code up.
    const used = code();
    const ok = await login(b, { code: used });
    expect(ok.status).toBe(303);
    expect(ok.headers['location']).toBe('/');
    expect((await b.get('/')).status).toBe(200);
    expect(t.service.audit.list({ eventType: 'admin.auth', limit: 1 })[0]).toMatchObject({
      action: 'admin.login',
      outcome: 'success',
      actorId: 'alice',
      details: { secondStep: 'totp' },
    });

    // A code works once: a second sign-in with it fails, the next code works.
    const other = browser(t.service.adminUrl ?? '');
    expect((await login(other, { code: used })).status).toBe(401);
    next();
    expect((await login(other, { code: code() })).status).toBe(303);
  });

  it('accepts a recovery code once, and tells the administrator how many are left', async () => {
    const { t, b, codes } = await withSecondStep();
    const recovery = codes[0] ?? '';
    const ok = await login(b, { code: recovery.toLowerCase() });
    expect(ok.status).toBe(303);
    expect(ok.headers['location']).toBe('/account?recovery=used');
    const account = await b.get('/account?recovery=used');
    expect(account.status).toBe(200);
    expect(account.body).toContain('You signed in with a recovery code');
    expect(account.body).toContain('9 are left');
    expect(account.body).toMatch(
      /Two-step sign-in<\/th>\s*<td>\s*<span class="status-ok">on<\/span>/,
    );
    expect(account.body).toContain('unifi-mcp admin new-recovery-codes');
    expect(account.body).not.toContain(recovery);
    expect(t.service.audit.list({ eventType: 'admin.auth', limit: 1 })[0]).toMatchObject({
      outcome: 'success',
      details: { secondStep: 'recovery_code' },
    });
    expect(t.logs.join('\n')).toContain('an administrator signed in with a recovery code');
    const again = browser(t.service.adminUrl ?? '');
    expect((await login(again, { code: recovery })).status).toBe(401);
  });

  it('counts wrong codes towards the sign-in throttle', async () => {
    const { b, code, next } = await withSecondStep();
    for (let i = 0; i < 5; i++) expect((await login(b, { code: '000000' })).status).toBe(401);
    next();
    const blocked = await login(b, { code: code() });
    expect(blocked.status).toBe(429);
    expect(blocked.headers['set-cookie']).toBeUndefined();
  });

  it('approves only with the password and a code that was not used before', async () => {
    const { t, b, code, next } = await withSecondStep();
    const client = await connect(t.mcpUrl, t.token('writer', ['network.*.*']));
    const proposed = structured(
      await client.callTool({
        name: 'unifi_execute',
        arguments: {
          operationId: 'network.firewall.update_rule',
          consoleId: t.consoleId,
          siteId: 'site-1',
          arguments: { ruleId: RULE, body: { action: 'block' } },
        },
      }),
    );
    expect(proposed['status']).toBe('approval_required');
    const approvalId = String(proposed['approvalId']);
    const signInCode = code();
    expect((await login(b, { code: signInCode })).status).toBe(303);
    const page = await b.get(`/approvals/${approvalId}`);
    expect(page.body).toContain('A new code from your authenticator app');
    const csrf = await b.csrf(`/approvals/${approvalId}`);
    const approve = (form: Record<string, string>) =>
      b.post(`/approvals/${approvalId}/approve`, { csrf, ...form });

    const passwordOnly = await approve({ password: PASSWORD });
    const reusedCode = await approve({ password: PASSWORD, code: signInCode });
    const codeOnly = await approve({ password: 'not the password!', code: signInCode });
    for (const refused of [passwordOnly, reusedCode, codeOnly]) {
      expect(refused.status).toBe(401);
      expect(refused.body).toContain('The password or code is wrong; nothing was approved.');
    }
    expect(t.service.approvals.get(approvalId)?.status).toBe('pending');
    next();
    const approved = await approve({ password: PASSWORD, code: code() });
    expect(approved.status).toBe(303);
    expect(t.service.approvals.get(approvalId)).toMatchObject({
      status: 'approved',
      decidedBy: 'admin:alice',
    });
  });

  it('can be required: an account without a second step cannot sign in', async () => {
    const { t, b, clock } = await withSecondStep({ requireMfa: true, enrol: false });
    const page = await b.get('/login');
    expect(page.body).toMatch(/Code from your authenticator app\s*\(required\)/);
    const refused = await login(b, {});
    expect(refused.status).toBe(403);
    expect(refused.body).toContain('requires two-step sign-in');
    expect(refused.body).toContain('unifi-mcp admin enable-mfa');
    expect(refused.headers['set-cookie']).toBeUndefined();
    expect(t.service.audit.list({ eventType: 'admin.auth', limit: 1 })[0]).toMatchObject({
      outcome: 'denied',
      actorId: 'alice',
      details: { reason: 'second_step_required' },
    });
    // A wrong password still gets the generic answer, whatever the requirement.
    const wrong = await b.post('/login', { username: 'alice', password: 'not the password!' });
    expect(wrong.status).toBe(401);
    expect(wrong.body).not.toContain('requires two-step sign-in');

    const secret = t.service.mfa.begin('alice', CLI).secret;
    t.service.mfa.confirm('alice', totpCode(secret, new Date(clock.time)), CLI);
    clock.time += STEP_MS;
    const ok = await login(b, { code: totpCode(secret, new Date(clock.time)) });
    expect(ok.status).toBe(303);
  });

  it('ends open sessions when the second step is set up or removed on the host', async () => {
    const { t, b, clock } = await withSecondStep({ enrol: false });
    expect((await login(b, {})).status).toBe(303);
    const account = await b.get('/account');
    expect(account.body).toMatch(/<span class="status-warn">off<\/span>/);
    expect(account.body).not.toContain('Recovery codes left');
    const secret = t.service.mfa.begin('alice', CLI).secret;
    expect((await b.get('/account')).status).toBe(200); // pending changes nothing
    t.service.mfa.confirm('alice', totpCode(secret, new Date(clock.time)), CLI);
    expect((await b.get('/account')).status).toBe(303);
    clock.time += STEP_MS;
    expect((await login(b, {})).status).toBe(401);
    expect((await login(b, { code: totpCode(secret, new Date(clock.time)) })).status).toBe(303);
    t.service.mfa.reset('alice', CLI);
    expect((await b.get('/account')).status).toBe(303);
    // Password only again, as before it was set up.
    expect((await login(b, {})).status).toBe(303);
  });

  it('never puts a code, the secret or a recovery code in a page, log or audit entry', async () => {
    const { t, b, secret, codes, code } = await withSecondStep();
    const used = code();
    await login(b, { code: '123456' });
    await login(b, { code: codes[1] ?? '' });
    await login(browser(t.service.adminUrl ?? ''), { code: used });
    const pages = [
      (await b.get('/account')).body,
      (await b.get('/')).body,
      (await b.get('/audit')).body,
    ].join('\n');
    const records = `${t.logs.join('\n')}\n${JSON.stringify(t.service.audit.list({ limit: 500 }))}`;
    for (const value of [secret, ...codes, ...codes.map((c) => c.replace(/-/g, ''))]) {
      expect(pages, value).not.toContain(value);
      expect(records, value).not.toContain(value);
    }
    // Six digits can occur by chance inside an id or a time: look for them standing alone.
    for (const value of [used, '123456']) {
      const alone = new RegExp(`(?<![0-9A-Za-z.:-])${value}(?![0-9A-Za-z.:-])`);
      expect(pages, value).not.toMatch(alone);
      expect(records, value).not.toMatch(alone);
    }
  });
});
