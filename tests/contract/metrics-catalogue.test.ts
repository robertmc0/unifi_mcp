/**
 * The metrics catalogue is reviewed (spec §12, §17; ADR 0025): every metric the service
 * publishes, with its type and every label value it can ever carry, is pinned here.
 * Adding a metric or a label value changes this file, which is where the question "could
 * this identify a console, a client or a person?" gets asked. The operator manual must
 * list the same metrics with the same labels.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServiceMetrics } from '@unifi-local-mcp/mcp-server';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../..');
const MODULES = ['network', 'protect', 'access', 'unknown'];
const EFFECTS = ['read', 'write', 'unknown'];

/** name → [type, labels]. A label is its complete value list, or a code label's maximum. */
const CATALOGUE: Record<string, [string, Record<string, string[] | { code: true; max: number }>]> =
  {
    unifi_mcp_http_requests_total: [
      'counter',
      {
        path: ['mcp', 'health', 'other'],
        code: [
          '200',
          '202',
          '204',
          '400',
          '401',
          '403',
          '404',
          '405',
          '406',
          '413',
          '429',
          '500',
          '503',
          'no_response',
          'other',
        ],
      },
    ],
    unifi_mcp_operations_total: [
      'counter',
      {
        module: MODULES,
        effect: EFFECTS,
        status: ['ok', 'pending', 'denied', 'approval_required', 'error'],
      },
    ],
    unifi_mcp_operation_failures_total: [
      'counter',
      { status: ['denied', 'error'], code: { code: true, max: 64 } },
    ],
    unifi_mcp_operation_duration_seconds: ['histogram', { module: MODULES, effect: EFFECTS }],
    unifi_mcp_upstream_requests_total: [
      'counter',
      { module: MODULES, result: ['2xx', '3xx', '4xx', '5xx', 'no_response', 'other'] },
    ],
    unifi_mcp_upstream_request_duration_seconds: ['histogram', { module: MODULES }],
    unifi_mcp_build_info: ['gauge', { version: ['9.9.9'] }],
    process_start_time_seconds: ['gauge', {}],
    process_resident_memory_bytes: ['gauge', {}],
    unifi_mcp_ready: ['gauge', {}],
    unifi_mcp_health_check_status: [
      'gauge',
      {
        check: ['database', 'audit', 'disk_space', 'console_versions', 'other'],
        status: ['ok', 'degraded', 'fail'],
      },
    ],
    unifi_mcp_hard_lock: ['gauge', {}],
    unifi_mcp_runtime_mode: ['gauge', { mode: ['read_only', 'read_write'] }],
    unifi_mcp_policy_version: ['gauge', {}],
    unifi_mcp_operations_running: ['gauge', {}],
    unifi_mcp_operations_queued: ['gauge', {}],
    unifi_mcp_clients_connected: ['gauge', {}],
    unifi_mcp_open_responses: ['gauge', {}],
    unifi_mcp_clients_configured: ['gauge', {}],
    unifi_mcp_event_subscriptions: ['gauge', {}],
    unifi_mcp_event_feeds: [
      'gauge',
      { module: MODULES, state: ['connecting', 'connected', 'retrying', 'unavailable', 'other'] },
    ],
    unifi_mcp_event_messages_dropped: [
      'gauge',
      { module: MODULES, reason: ['contract_mismatch', 'unclassified'] },
    ],
    unifi_mcp_consoles: ['gauge', { state: ['enabled', 'read_only', 'disabled', 'invalid'] }],
    unifi_mcp_console_modules: [
      'gauge',
      {
        module: MODULES,
        state: ['read_only', 'read_write', 'disabled'],
        version: ['known', 'unknown'],
      },
    ],
    unifi_mcp_approvals_pending: ['gauge', {}],
    unifi_mcp_database_size_bytes: ['gauge', {}],
    unifi_mcp_data_volume_free_bytes: ['gauge', {}],
  };

/** Label names that would identify something, whatever their values. */
const FORBIDDEN_LABELS =
  /console|client|site|device|host|address|alias|name|user|token|operation|path_template|remote|ip|mac|id$/;

describe('metrics catalogue (ADR 0025)', () => {
  const families = createServiceMetrics('9.9.9').registry.families();

  it('is exactly the reviewed list, with every label value', () => {
    expect(
      Object.fromEntries(families.map((family) => [family.name, [family.type, family.labels]])),
    ).toEqual(CATALOGUE);
  });

  it('has no label that names a console, client, site, device, address or operation', () => {
    for (const family of families) {
      expect(family.name).toMatch(/^(unifi_mcp|process)_[a-z0-9_]+$/);
      for (const label of Object.keys(family.labels)) {
        expect(label, `${family.name}{${label}}`).not.toMatch(FORBIDDEN_LABELS);
      }
    }
    // The module ids are the only words taken from the deployment's vocabulary.
    const values = new Set(
      families.flatMap((family) =>
        Object.values(family.labels).flatMap((set) => ('code' in set ? [] : [...set])),
      ),
    );
    for (const value of values) expect(value).toMatch(/^[a-z0-9_.]{1,20}$/);
  });

  it('is what the operator manual lists, with the same types and labels', () => {
    const page = readFileSync(join(ROOT, 'docs/monitoring.md'), 'utf8');
    const rows = page
      .split('\n')
      .filter((line) => /^\| `(unifi_mcp|process)_/.test(line))
      .map((line) =>
        line
          .slice(1, -1)
          .split('|')
          .map((cell) => cell.trim()),
      );
    expect(rows.map(([name, type, labels]) => [name, type, labels])).toEqual(
      families.map((family) => [
        `\`${family.name}\``,
        family.type,
        Object.keys(family.labels)
          .map((label) => `\`${label}\``)
          .join(', '),
      ]),
    );
    // The manual mentions no metric that does not exist (histogram series included).
    const mentioned = new Set(page.match(/\b(?:unifi_mcp|process)_[a-z0-9_]+\b/g) ?? []);
    const known = new Set(
      families.flatMap((family) =>
        family.type === 'histogram'
          ? [family.name, `${family.name}_bucket`, `${family.name}_sum`, `${family.name}_count`]
          : [family.name],
      ),
    );
    const documentedOnly = [...mentioned].filter(
      (name) => !known.has(name) && !name.startsWith('unifi_mcp_metrics_token'),
    );
    expect(documentedOnly).toEqual([]);
  });
});
