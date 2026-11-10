/**
 * HTML escaping of the admin pages (ADR 0016).
 */
import { approvalPage, escapeHtml, html, SafeHtml } from '@unifi-local-mcp/admin-ui';
import { describe, expect, it } from 'vitest';

describe('html', () => {
  it('escapes every interpolation unless it is SafeHtml', () => {
    const name = '<img src=x onerror=alert(1)> & "quotes" \'too\'';
    expect(html`<p title="${name}">${name}</p>`.value).toBe(
      '<p title="&lt;img src=x onerror=alert(1)&gt; &amp; &quot;quotes&quot; &#39;too&#39;">&lt;img src=x onerror=alert(1)&gt; &amp; &quot;quotes&quot; &#39;too&#39;</p>',
    );
    expect(html`<div>${new SafeHtml('<b>ok</b>')}${['<i>', html`<u>${'<'}</u>`]}</div>`.value).toBe(
      '<div><b>ok</b>&lt;i&gt;<u>&lt;</u></div>',
    );
    expect(html`${undefined}${null}${false}${0}`.value).toBe('0');
  });

  it('shows control and bidirectional characters visibly', () => {
    expect(escapeHtml('a\u202eb\u001bc\u009bd\u2066e')).toBe('a\\u202eb\\u001bc\\u009bd\\u2066e');
  });

  it('renders approval pages with escaped summaries and a password-protected approve form', () => {
    const page = approvalPage(
      { title: 'x', username: 'alice', csrfToken: 'tok"en' },
      {
        id: '00000000-0000-4000-8000-000000000001',
        status: 'pending',
        clientId: 'agent',
        operationId: 'network.gateway.reboot',
        risk: 'high',
        consoleId: 'c',
        siteId: '</td><script>x</script>',
        createdAt: 't',
        expiresAt: 't',
        executeBy: null,
        summary: { note: '</pre><script>y</script>' },
        policyVersion: 3,
        decidedAt: null,
        decidedBy: null,
        decisionNote: null,
        closedAt: null,
      },
    );
    expect(page).not.toContain('<script>');
    expect(page).toContain('value="tok&quot;en"');
    expect(page).toMatch(
      /action="\/approvals\/00000000-0000-4000-8000-000000000001\/approve"[\s\S]*type="password"[\s\S]*required/,
    );
  });
});
