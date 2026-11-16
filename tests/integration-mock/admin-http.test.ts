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
  NETWORK_KEY,
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

describe('audit search and export (ADR 0027)', () => {
  it('filters by actor id and by time', async () => {
    const { t, b } = await setup();
    await signIn(b);
    t.token('reader', ['network.*.read']);
    const byActor = await b.get('/audit?actorId=alice');
    expect(byActor.body).toContain('admin.login');
    expect(byActor.body).not.toContain('client.create');
    expect(byActor.body).toContain('name="actorId" value="alice"');
    const future = await b.get('/audit?since=2999-01-01');
    expect(future.body).not.toContain('admin.login');
    expect(future.body).toContain('value="2999-01-01"');
    const past = await b.get('/audit?until=2000-01-01T00:00:00Z');
    expect(past.body).not.toContain('admin.login');
    // A malformed filter is ignored and not echoed back.
    const hostile = await b.get(
      `/audit?since=${encodeURIComponent('"><script>alert(1)</script>')}&actorId=${encodeURIComponent('<b>')}`,
    );
    expect(hostile.status).toBe(200);
    expect(hostile.body).toContain('admin.login');
    expect(hostile.body).not.toContain('<script>');
    expect(hostile.body).not.toContain('<b>');
  });

  it('exports what the filters match as CSV or JSON, and records the export', async () => {
    const { t, b } = await setup();
    await signIn(b);
    // Text a spreadsheet would run as a formula, in columns that take free text.
    t.service.audit.record({
      eventType: 'mcp.operation',
      action: 'operation.execute',
      outcome: 'denied',
      actor: { type: 'mcp_client', id: '=cmd' },
      operationId: '+SUM(1,2)',
      errorCode: '@risk',
      correlationId: '-2+3',
      details: { note: 'has "quotes", commas\nand a new line' },
    });
    const csv = await b.get('/audit/export?format=csv');
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(csv.headers['content-disposition']).toMatch(
      /^attachment; filename="unifi-mcp-audit-\d{8}T\d{6}Z\.csv"$/,
    );
    expect(csv.headers['cache-control']).toBe('no-store');
    const lines = csv.body.split('\r\n');
    expect(lines[0]).toBe(
      'seq,occurredAt,eventType,action,outcome,actorType,actorId,correlationId,consoleId,application,operationId,errorCode,durationMs,details',
    );
    const hostile = lines.find((line) => line.includes('operation.execute')) ?? '';
    expect(hostile).toContain(`"'=cmd"`);
    expect(hostile).toContain(`"'+SUM(1,2)"`);
    expect(hostile).toContain(`"'@risk"`);
    expect(hostile).toContain(`"'-2+3"`);
    expect(csv.body).toContain('has \\""quotes\\"", commas\\nand a new line');
    // No cell starts a formula: every field is quoted, and none begins with = + - @.
    expect(csv.body).not.toMatch(/(^|,)"[=+\-@]/m);

    const json = await b.get('/audit/export?format=json&actorType=admin');
    expect(json.headers['content-type']).toBe('application/json; charset=utf-8');
    const entries = JSON.parse(json.body) as { actorType: string; action: string; seq: number }[];
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((entry) => entry.actorType === 'admin')).toBe(true);
    expect(entries.map((e) => e.seq)).toEqual([...entries.map((e) => e.seq)].sort((a, c) => c - a));
    // The first export is in the second one; both are in the audit trail.
    expect(entries.some((entry) => entry.action === 'audit.export')).toBe(true);
    const recorded = t.service.audit.list({ eventType: 'admin.audit', limit: 5 });
    expect(recorded).toHaveLength(2);
    expect(recorded[0]).toMatchObject({
      action: 'audit.export',
      actorId: 'alice',
      details: { format: 'json', filters: { actorType: 'admin' } },
    });
    // Not without a session, and not by POST.
    const anonymous = browser(t.service.adminUrl ?? '');
    const refused = await anonymous.get('/audit/export?format=json');
    expect(refused.status).toBe(303);
    expect(refused.body).toBe('');
  });

  it('exports more than one page of entries, up to its limit', async () => {
    const { t, b } = await setup();
    await signIn(b);
    // One transaction: 620 separate commits are slow on a busy machine.
    t.service.storage.db.transaction(() => {
      for (let i = 0; i < 620; i++) {
        t.service.audit.record({
          eventType: 'test.fill',
          action: 'fill.entry',
          outcome: 'success',
          actor: { type: 'system' },
        });
      }
    });
    const json = await b.get('/audit/export?format=json&eventType=test.fill');
    const entries = JSON.parse(json.body) as { seq: number }[];
    expect(entries).toHaveLength(620);
    expect(new Set(entries.map((e) => e.seq)).size).toBe(620);
  });
});

describe('consoles, clients, policy and settings pages (ADR 0027)', () => {
  it('need a session, like every page', async () => {
    const { b } = await setup();
    for (const path of ['/consoles', '/clients', '/clients/reader', '/policy', '/settings']) {
      const response = await b.get(path);
      expect(response.status, path).toBe(303);
      expect(response.headers['location']).toBe('/login');
    }
  });

  it('show consoles and their modules, never a credential', async () => {
    const { t, b } = await setup();
    await signIn(b);
    const list = await b.get('/consoles');
    expect(list.status).toBe(200);
    expect(list.body).toContain(`href="/consoles/${t.consoleId}"`);
    expect(list.body).toContain('network: read_write');
    const detail = await b.get(`/consoles/${t.consoleId}`);
    expect(detail.status).toBe(200);
    expect(detail.body).toContain('Console lab');
    expect(detail.body).toContain('127.0.0.1');
    expect(detail.body).toMatch(/<td class="status-ok">\s*stored\s*<\/td>/);
    expect(detail.body).toContain('1.0.5 (observed');
    expect(detail.body).toContain('&quot;state&quot;: &quot;read_write&quot;');
    expect(detail.body).toContain('verify, own CA');
    expect((await b.get('/consoles/00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await b.get('/consoles/lab')).status).toBe(404);
    // A console whose certificate is not checked says so in words.
    t.service.consoles.setTls(t.consoleId, { mode: 'insecure' }, CLI);
    expect((await b.get(`/consoles/${t.consoleId}`)).body).toContain(
      'certificate verification is DISABLED',
    );
    for (const page of [list.body, detail.body]) expect(page).not.toContain(NETWORK_KEY);
  });

  it("show a client's effective permissions exactly as the client sees them", async () => {
    const { t, b } = await setup();
    await signIn(b);
    const readerToken = t.token('reader', ['network.*.read']);
    const writerToken = t.token('writer', ['network.*.*']);
    const list = await b.get('/clients');
    expect(list.body).toContain('href="/clients/reader"');
    expect(list.body).toContain('href="/clients/writer"');

    const operationsOf = async (token: string): Promise<string[]> => {
      const client = await connect(t.mcpUrl, token);
      const result = structured(
        await client.callTool({ name: 'unifi_list_operations', arguments: { limit: 50 } }),
      );
      return (result['operations'] as { operationId: string }[]).map((o) => o.operationId).sort();
    };
    const onPage = (body: string): string[] =>
      [...body.matchAll(/<td>(network\.[a-z_.]+)<\/td>/g)].map((m) => m[1] ?? '').sort();

    const reader = await b.get('/clients/reader');
    expect(reader.status).toBe(200);
    expect(onPage(reader.body)).toEqual(await operationsOf(readerToken));
    expect(onPage(reader.body).length).toBeGreaterThan(0);
    expect(reader.body.replace(/\s+/g, ' ')).toMatch(/\d+ reads?, 0 writes\./);
    const writer = await b.get('/clients/writer');
    expect(onPage(writer.body)).toEqual(await operationsOf(writerToken));
    expect(onPage(writer.body).length).toBeGreaterThan(onPage(reader.body).length);
    expect(writer.body).toContain('only after a human approves');
    expect(writer.body).toMatch(/<td>required<\/td>/);
    expect(writer.body).toMatch(/<td>\s*lab\s*<\/td>|<td>lab<\/td>/);

    // Token ids are shown; tokens never are.
    const tokenId = t.service.clients.get('reader')?.tokens[0]?.tokenId ?? 'missing';
    expect(reader.body).toContain(tokenId);
    for (const page of [list.body, reader.body, writer.body]) {
      expect(page).not.toContain(readerToken);
      expect(page).not.toContain(writerToken);
      expect(page).not.toContain(NETWORK_KEY);
    }
    // The page follows the policy: read-only mode removes the writes, revocation everything.
    t.service.policyStore.setRuntimeMode('read_only', CLI);
    const afterReadOnly = await b.get('/clients/writer');
    expect(onPage(afterReadOnly.body)).toEqual(onPage(reader.body));
    t.service.clients.revoke('reader', CLI);
    const revoked = await b.get('/clients/reader');
    expect(onPage(revoked.body)).toEqual([]);
    expect(revoked.body).toContain('revoked');
    expect((await b.get('/clients/nobody')).status).toBe(404);
    expect((await b.get('/clients/UPPER')).status).toBe(404);
  });

  it('show hostile descriptions escaped', async () => {
    const { t, b } = await setup();
    await signIn(b);
    t.service.clients.create(
      {
        clientId: 'hostile',
        description: '<img src=x onerror=alert(1)>\u202eevil',
        policy: { allow: [], consoles: {} },
      },
      CLI,
    );
    for (const path of ['/clients', '/clients/hostile']) {
      const page = await b.get(path);
      expect(page.body).toContain('&lt;img src=x onerror=alert(1)&gt;\\u202eevil');
      expect(page.body).not.toContain('<img');
    }
  });

  it('show the policy, the hard lock and the settings without any secret', async () => {
    const { t, b } = await setup();
    await signIn(b);
    const policy = await b.get('/policy');
    expect(policy.status).toBe(200);
    expect(policy.body).toMatch(/Runtime mode<\/div>\s*<div class="status-warn">\s*read_write/);
    expect(policy.body).toMatch(/Deployment hard lock<\/div>\s*<div class="status-warn">\s*off/);
    expect(policy.body).toContain('&quot;runtimeMode&quot;: &quot;read_write&quot;');
    t.service.policyStore.setRuntimeMode('read_only', CLI);
    expect((await b.get('/policy')).body).toMatch(/<div class="status-ok">\s*read_only/);

    const settings = await b.get('/settings');
    expect(settings.status).toBe(200);
    expect(settings.body).toContain('No update check');
    expect(settings.body).toContain('Hard lock (UNIFI_MCP_FORCE_READ_ONLY)');
    expect(settings.body).toContain('Two-step sign-in required');
    expect(settings.body).toMatch(/<td>network<\/td>\s*<td class="status-ok">supported<\/td>/);
    expect(settings.body).toContain('unavailable: official_local_api_not_documented');
    expect(settings.body).toContain(t.service.storage.keyId);
    expect(settings.body).toContain('unifi-mcp db backup');
    for (const page of [policy.body, settings.body]) {
      expect(page).not.toContain(NETWORK_KEY);
      expect(page).not.toContain(PASSWORD);
    }
  });

  it('are read-only: nothing on them accepts a change', async () => {
    const { t, b } = await setup();
    await signIn(b);
    t.token('reader', ['network.*.read']);
    const csrf = await b.csrf('/');
    for (const path of [
      '/consoles',
      `/consoles/${t.consoleId}`,
      '/clients',
      '/clients/reader',
      '/policy',
      '/settings',
      '/audit/export',
    ]) {
      const page = await b.get(path);
      // The only form on these pages is the sign-out button in the header.
      expect(page.body.match(/<form /g) ?? [], path).toHaveLength(path === '/audit/export' ? 0 : 1);
      const posted = await b.post(path, { csrf, state: 'disabled' });
      expect(posted.status, path).toBe(404);
    }
    expect(t.service.consoles.get('lab')?.policy?.state).toBe('enabled');
    expect(t.service.clients.get('reader')?.policy?.status).toBe('active');
  });
});

describe('changes from the web interface (ADR 0027 §3)', () => {
  const MINUTE = 60_000;

  async function managed(options: { management?: boolean } = {}) {
    const clock = { time: Date.parse('2026-11-16T10:00:15.000Z') };
    const t = await startTestService({
      dir: await tempDir(),
      admin: true,
      management: options.management ?? true,
      now: () => new Date(clock.time),
    });
    t.service.admins.bootstrap('alice', PASSWORD, CLI);
    const b = browser(t.service.adminUrl ?? '');
    await signIn(b);
    const csrf = await b.csrf('/');
    const change = (name: string, fields: Record<string, string>) =>
      b.post(`/manage/${name}`, { csrf, ...fields });
    return { t, b, clock, csrf, change };
  }
  const lastAudit = (t: TestService, action: string) =>
    t.service.audit.list({ limit: 200 }).find((entry) => entry.action === action);

  it('are off unless the deployment enables them', async () => {
    const { t, b, change } = await managed({ management: false });
    expect((await b.get('/settings')).body.replace(/\s+/g, ' ')).toMatch(
      /UNIFI_MCP_ADMIN_MANAGEMENT\)<\/th> <td>no<\/td>/,
    );
    expect((await b.get('/consoles')).body).not.toContain('/manage/');
    for (const name of ['console.add', 'client.create', 'policy.mode', 'preview/global']) {
      const refused = await change(name, { alias: 'x', host: '192.0.2.9', mode: 'read_only' });
      expect(refused.status, name).toBe(404);
    }
    expect(t.service.consoles.list()).toHaveLength(1);
    expect(t.service.policyStore.current().document.runtimeMode).toBe('read_write');
  });

  it('offer exactly the reviewed changes, and none of the host-only ones', async () => {
    const { t, change } = await managed();
    const forms = new Set<string>();
    const b = browser(t.service.adminUrl ?? '');
    await signIn(b);
    t.token('reader', ['network.*.read']);
    for (const path of [
      '/consoles',
      `/consoles/${t.consoleId}`,
      '/clients',
      '/clients/reader',
      '/policy',
    ]) {
      for (const match of (await b.get(path)).body.matchAll(/action="\/manage\/([a-z.]+)"/g)) {
        forms.add(match[1] ?? '');
      }
    }
    expect([...forms].sort()).toEqual([
      'client.create',
      'client.policy',
      'client.remove',
      'client.revoke',
      'client.rotate',
      'console.add',
      'console.check',
      'console.credential',
      'console.details',
      'console.policy',
      'console.port',
      'console.remove',
      'console.tls',
      'policy.document',
      'policy.mode',
    ]);
    // Declaring a version, administrators and their second step, and maintenance stay on
    // the host: there is no such change, whatever the form says.
    for (const name of [
      'console.declare',
      'admin.reset',
      'admin.mfa',
      'db.backup',
      'crypto.rotate',
    ]) {
      const refused = await change(name, { consoleId: t.consoleId, version: '4.2.16' });
      expect(refused.status, name).toBe(400);
      expect(refused.body).toContain('There is no such change.');
    }
    expect((await change('NOT.valid', {})).status).toBe(404);
  });

  it('add, configure, check and remove a console, as the signed-in administrator', async () => {
    const { t, b, change } = await managed();
    const added = await change('console.add', {
      alias: 'second',
      host: '192.0.2.20',
      description: 'spare',
      tlsMode: 'verify',
    });
    expect(added.status).toBe(303);
    const view = t.service.consoles.get('second');
    expect(added.headers['location']).toBe(`/consoles/${view?.id ?? ''}`);
    expect(lastAudit(t, 'console.add')).toMatchObject({ actorType: 'admin', actorId: 'alice' });
    // The result is shown once, on the next page.
    const page = await b.get(`/consoles/${view?.id ?? ''}`);
    expect(page.body).toContain('Console &quot;second&quot; added.');
    expect((await b.get(`/consoles/${view?.id ?? ''}`)).body).not.toContain('added.');
    const id = view?.id ?? '';

    const SECRET = 'web-typed-key-SENTINEL-55';
    expect(
      (await change('console.credential', { consoleId: id, module: 'network', credential: SECRET }))
        .status,
    ).toBe(303);
    expect(t.service.consoles.connection(id, 'network')?.credential?.reveal()).toBe(SECRET);
    expect(
      (await change('console.port', { consoleId: id, module: 'network', port: '8443' })).status,
    ).toBe(303);
    expect(t.service.consoles.connection(id, 'network')?.port).toBe(8443);
    expect(
      (
        await change('console.policy', {
          consoleId: id,
          policy: JSON.stringify({ modules: { network: { state: 'read_only' } } }),
        })
      ).status,
    ).toBe(303);
    expect(t.service.consoles.policy(id)?.modules['network']?.state).toBe('read_only');
    expect(
      (await change('console.details', { consoleId: id, host: '192.0.2.21', description: '' }))
        .status,
    ).toBe(303);
    expect(t.service.consoles.get('second')).toMatchObject({
      host: '192.0.2.21',
      description: null,
    });

    // Turning certificate checks off needs the word typed; pins must be given for pinning.
    const unconfirmed = await change('console.tls', { consoleId: id, tlsMode: 'insecure' });
    expect(unconfirmed.status).toBe(400);
    expect(unconfirmed.body).toContain('needs the word');
    expect(
      (await change('console.tls', { consoleId: id, tlsMode: 'pinned', pins: '' })).status,
    ).toBe(400);
    expect(t.service.consoles.get('second')?.tls.mode).toBe('verify');
    expect(
      (
        await change('console.tls', {
          consoleId: id,
          tlsMode: 'insecure',
          insecureConfirm: 'insecure',
        })
      ).status,
    ).toBe(303);
    expect(t.service.consoles.get('second')?.tls.mode).toBe('insecure');

    // Refusals of the stores come back as "Not changed", with their code.
    const duplicate = await change('console.add', {
      alias: 'second',
      host: '192.0.2.22',
      tlsMode: 'verify',
    });
    expect(duplicate.status).toBe(400);
    expect(duplicate.body).toContain('Not changed');
    const badPolicy = await change('console.policy', {
      consoleId: id,
      policy: '{"modules": {"talk": {}}}',
    });
    expect(badPolicy.status).toBe(400);
    expect(badPolicy.body).toContain('unavailable: official_local_api_not_documented');
    expect((await change('console.policy', { consoleId: id, policy: '{not json' })).status).toBe(
      400,
    );
    const hostile = await change('console.add', {
      alias: '<script>alert(1)</script>',
      host: '192.0.2.23',
      tlsMode: 'verify',
    });
    expect(hostile.status).toBe(400);
    expect(hostile.body).not.toContain('<script>alert');

    // The check sends no request: the synthetic console sees a handshake only.
    const requestsBefore = t.mock.requests.length;
    const check = await change('console.check', { consoleId: t.consoleId, module: 'network' });
    expect(check.status).toBe(200);
    expect(check.body.replace(/\s+/g, ' ')).toMatch(/Reachable<\/th> <td>yes<\/td>/);
    expect(check.body.replace(/\s+/g, ' ')).toMatch(/Certificate trusted<\/th> <td>yes<\/td>/);
    expect(t.mock.requests.length).toBe(requestsBefore);

    expect((await change('console.remove', { consoleId: id, confirm: 'lab' })).status).toBe(400);
    expect(t.service.consoles.get('second')).toBeDefined();
    expect((await change('console.remove', { consoleId: id, confirm: 'second' })).status).toBe(303);
    expect(t.service.consoles.get('second')).toBeUndefined();
    expect(lastAudit(t, 'console.remove')).toMatchObject({ actorType: 'admin', actorId: 'alice' });

    // The typed credential is nowhere but in the encrypted store.
    const everything = [
      (await b.get('/consoles')).body,
      (await b.get('/audit')).body,
      t.logs.join('\n'),
      JSON.stringify(t.service.audit.list({ limit: 500 })),
    ].join('\n');
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain('SENTINEL-55');
  });

  it('create a client whose token is shown once, rotate, preview, revoke and remove it', async () => {
    const { t, b, change } = await managed();
    const created = await change('client.create', {
      clientId: 'webreader',
      description: 'made in the browser',
      policy: JSON.stringify({ consoles: { lab: {} }, allow: ['network.*.read'] }),
    });
    expect(created.status).toBe(200);
    expect(created.headers['cache-control']).toBe('no-store');
    const token = /<pre>([A-Za-z0-9._~+/=-]{20,})<\/pre>/.exec(created.body)?.[1] ?? '';
    expect(token).not.toBe('');
    expect(created.body).toContain('Copy it now.');
    expect(lastAudit(t, 'client.create')).toMatchObject({ actorType: 'admin', actorId: 'alice' });
    // The console alias in the policy became its id, and the token works.
    expect(Object.keys(t.service.clients.get('webreader')?.policy?.consoles ?? {})).toEqual([
      t.consoleId,
    ]);
    const client = await connect(t.mcpUrl, token);
    const before = structured(
      await client.callTool({ name: 'unifi_list_operations', arguments: { limit: 50 } }),
    );
    expect(before['total']).toBeGreaterThan(0);

    // A preview changes nothing and says what would change.
    const wider = JSON.stringify({ consoles: { lab: {} }, allow: ['network.*.*'] });
    const preview = await b.post('/manage/preview/client', {
      csrf: await b.csrf('/clients/webreader'),
      clientId: 'webreader',
      policy: wider,
    });
    expect(preview.status).toBe(200);
    expect(preview.body).toContain('Nothing was changed.');
    expect(preview.body).toContain('network.devices.restart');
    expect(preview.body).toMatch(/1 of 1 client/);
    expect(t.service.clients.get('webreader')?.policy?.allow).toEqual(['network.*.read']);
    expect(preview.body).toContain('action="/manage/client.policy"');
    const invalid = await b.post('/manage/preview/client', {
      csrf: await b.csrf('/clients/webreader'),
      clientId: 'webreader',
      policy: '{"allow": ["everything"]}',
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body).toContain('Not a usable policy');
    expect((await change('client.policy', { clientId: 'webreader', policy: wider })).status).toBe(
      303,
    );
    expect(t.service.clients.get('webreader')?.policy?.allow).toEqual(['network.*.*']);

    // Rotation shows a new token once; the first one stops working.
    const rotated = await change('client.rotate', { clientId: 'webreader' });
    expect(rotated.status).toBe(200);
    const second = /<pre>([A-Za-z0-9._~+/=-]{20,})<\/pre>/.exec(rotated.body)?.[1] ?? '';
    expect(second).not.toBe('');
    expect(second).not.toBe(token);
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    const withToken = (value: string) =>
      rawRequest(t.mcpUrl, {
        method: 'POST',
        headers: { ...headers, authorization: `Bearer ${value}` },
        body: INITIALIZE,
      });
    expect((await withToken(token)).status).toBe(401);
    expect((await withToken(second)).status).toBe(200);

    expect((await change('client.revoke', { clientId: 'webreader' })).status).toBe(303);
    expect((await withToken(second)).status).toBe(401);
    expect(t.service.clients.get('webreader')?.policy?.status).toBe('revoked');
    expect(
      (await change('client.remove', { clientId: 'webreader', confirm: 'wrong' })).status,
    ).toBe(400);
    expect(
      (await change('client.remove', { clientId: 'webreader', confirm: 'webreader' })).status,
    ).toBe(303);
    expect(t.service.clients.get('webreader')).toBeUndefined();

    // Neither token is in a later page, a log line or the audit trail.
    const everything = [
      (await b.get('/clients')).body,
      (await b.get('/audit')).body,
      t.logs.join('\n'),
      JSON.stringify(t.service.audit.list({ limit: 500 })),
    ].join('\n');
    expect(everything).not.toContain(token);
    expect(everything).not.toContain(second);
  });

  it('switch the runtime mode and edit the global policy, with a preview and a version check', async () => {
    const { t, b, change } = await managed();
    t.token('writer', ['network.*.*']);
    expect((await change('policy.mode', { mode: 'read_only' })).status).toBe(303);
    expect(t.service.policyStore.current().document.runtimeMode).toBe('read_only');
    expect((await b.get('/policy')).body).toContain('Runtime mode is read_only: no write can run.');
    expect((await change('policy.mode', { mode: 'sideways' })).status).toBe(400);
    expect((await change('policy.mode', { mode: 'read_write' })).status).toBe(303);
    expect(lastAudit(t, 'policy.runtime_mode_change')).toMatchObject({
      actorType: 'admin',
      actorId: 'alice',
    });

    const snapshot = t.service.policyStore.current();
    const denied = JSON.stringify({ ...snapshot.document, deny: ['network.gateway.write'] });
    const preview = await b.post('/manage/preview/global', {
      csrf: await b.csrf('/policy'),
      version: String(snapshot.version),
      policy: denied,
    });
    expect(preview.status).toBe(200);
    expect(preview.body.replace(/\s+/g, ' ')).toMatch(
      /<td>writer<\/td> <td>\d+<\/td> <td>\d+<\/td> <td class=""> - <\/td> <td>network\.gateway\.reboot<\/td>/,
    );
    expect(t.service.policyStore.current().version).toBe(snapshot.version);

    // A form rendered before someone else changed the policy is refused.
    t.service.policyStore.setRuntimeMode('read_only', CLI);
    const stale = await change('policy.document', {
      version: String(snapshot.version),
      policy: denied,
    });
    expect(stale.status).toBe(400);
    expect(t.service.policyStore.current().document.deny).toEqual([]);
    const current = t.service.policyStore.current();
    const saved = await change('policy.document', {
      version: String(current.version),
      policy: JSON.stringify({ ...current.document, deny: ['network.gateway.write'] }),
    });
    expect(saved.status).toBe(303);
    expect(t.service.policyStore.current().document.deny).toEqual(['network.gateway.write']);
    // The hard lock is not a setting: no field of any form reaches it.
    const lock = await change('policy.document', {
      version: String(t.service.policyStore.current().version),
      policy: JSON.stringify({ ...current.document, forceReadOnly: false }),
    });
    expect(lock.status).toBe(400);
  });

  it('need the password again once the last check is five minutes old', async () => {
    const { t, b, clock, change } = await managed();
    // Just signed in: the forms ask for nothing more.
    expect((await b.get('/policy')).body).not.toContain('name="password"');
    expect((await change('policy.mode', { mode: 'read_only' })).status).toBe(303);
    clock.time += 6 * MINUTE;
    expect((await b.get('/policy')).body).toContain('name="password"');
    const without = await change('policy.mode', { mode: 'read_write' });
    const wrong = await change('policy.mode', {
      mode: 'read_write',
      password: 'not the password!',
    });
    for (const refused of [without, wrong]) {
      expect(refused.status).toBe(401);
      expect(refused.body).toContain('nothing was changed');
    }
    expect(t.service.policyStore.current().document.runtimeMode).toBe('read_only');
    expect(lastAudit(t, 'admin.reauthenticate')).toMatchObject({
      outcome: 'denied',
      actorId: 'alice',
      details: { change: 'policy.mode' },
    });
    expect((await change('policy.mode', { mode: 'read_write', password: PASSWORD })).status).toBe(
      303,
    );
    expect(t.service.policyStore.current().document.runtimeMode).toBe('read_write');
    // The check counts for the next five minutes, not longer.
    expect((await change('policy.mode', { mode: 'read_only' })).status).toBe(303);
    clock.time += 6 * MINUTE;
    expect((await change('policy.mode', { mode: 'read_write' })).status).toBe(401);
  });

  it('need a code as well when the account has a second step', async () => {
    const { t, b, clock, change } = await managed();
    const secret = t.service.mfa.begin('alice', CLI).secret;
    t.service.mfa.confirm('alice', totpCode(secret, new Date(clock.time)), CLI);
    clock.time += 30_000;
    const signedIn = await b.post('/login', {
      username: 'alice',
      password: PASSWORD,
      code: totpCode(secret, new Date(clock.time)),
    });
    expect(signedIn.status).toBe(303);
    const csrf = await b.csrf('/');
    clock.time += 6 * MINUTE;
    const page = await b.get('/policy');
    expect(page.body).toContain('name="password"');
    expect(page.body).toContain('name="code"');
    const passwordOnly = await b.post('/manage/policy.mode', {
      csrf,
      mode: 'read_only',
      password: PASSWORD,
    });
    expect(passwordOnly.status).toBe(401);
    expect(t.service.policyStore.current().document.runtimeMode).toBe('read_write');
    const both = await b.post('/manage/policy.mode', {
      csrf,
      mode: 'read_only',
      password: PASSWORD,
      code: totpCode(secret, new Date(clock.time)),
    });
    expect(both.status).toBe(303);
    expect(t.service.policyStore.current().document.runtimeMode).toBe('read_only');
    expect(change).toBeDefined();
  });

  it('refuse forged, cross-origin and signed-out requests like every other form', async () => {
    const { t, b, csrf } = await managed();
    const fields = { mode: 'read_only' };
    expect((await b.post('/manage/policy.mode', { csrf: 'forged', ...fields })).status).toBe(403);
    expect((await b.post('/manage/policy.mode', fields)).status).toBe(403);
    expect(
      (await b.post('/manage/policy.mode', { csrf, ...fields }, { origin: 'https://evil.example' }))
        .status,
    ).toBe(403);
    const anonymous = browser(t.service.adminUrl ?? '');
    expect((await anonymous.post('/manage/policy.mode', { csrf, ...fields })).status).toBe(403);
    expect((await b.get('/manage/policy.mode')).status).toBe(404);
    expect(t.service.policyStore.current().document.runtimeMode).toBe('read_write');
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
