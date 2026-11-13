/**
 * The reviewed security metadata of every Access operation (spec §4.3, §6.3, §6.4;
 * ADR 0023 §3). The table below is the review record: a change to permissions, risk,
 * approval, sensitivity, default state or named tools must change this table too, so it
 * cannot happen silently, for instance through a regenerated schema.
 *
 * Columns: operationId, effect, risk, approval required, sensitivity tags, default
 * disabled, named tool. The permission is always `access.<category>.<effect>`. Rows are
 * keyed by the inventory key `"<METHOD> <path>"`.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ACCESS_MAX_VERSION,
  ACCESS_OPERATIONS,
  ALWAYS_REMOVED,
  MAX_LOG_PAGE_SIZE,
  MAX_LOG_WINDOW_SECONDS,
} from '@unifi-local-mcp/unifi-access';
import { describe, expect, it } from 'vitest';
import { OPERATIONS } from '../../packages/unifi-access/src/generated/access-2026-03-23.ts';

type Row = [
  operationId: string,
  effect: 'read' | 'write',
  risk: 'low' | 'medium' | 'high',
  approval: boolean,
  sensitivity: string[],
  defaultDisabled: boolean,
  namedTool: string | null,
];

const PERSON = ['biometric_or_access_identity', 'personal_identifier'];
const P = '/api/v1/developer';

/** Reviewed 2026-11-13 against the transcription of the 2026-03-23 PDF, by inventory key. */
// prettier-ignore
const REVIEW: Record<string, Row> = {
  // Reads: low risk, no approval. People and what lets them in need sensitive grants.
  [`GET ${P}/users/{id}`]: ['access.users.get', 'read', 'low', false, PERSON, false, null],
  [`GET ${P}/users`]: ['access.users.list', 'read', 'low', false, PERSON, false, null],
  [`GET ${P}/users/search`]: ['access.users.search', 'read', 'low', false, PERSON, false, null],
  [`GET ${P}/users/{id}/access_policies`]: ['access.users.list_access_policies', 'read', 'low', false, [], false, null],
  [`GET ${P}/user_groups`]: ['access.user_groups.list', 'read', 'low', false, [], false, null],
  [`GET ${P}/user_groups/{id}`]: ['access.user_groups.get', 'read', 'low', false, [], false, null],
  [`GET ${P}/user_groups/{id}/users`]: ['access.user_groups.list_users', 'read', 'low', false, PERSON, false, null],
  [`GET ${P}/user_groups/{id}/users/all`]: ['access.user_groups.list_all_users', 'read', 'low', false, PERSON, false, null],
  [`GET ${P}/user_groups/{id}/access_policies`]: ['access.user_groups.list_access_policies', 'read', 'low', false, [], false, null],
  [`GET ${P}/users/identity/assignments`]: ['access.identity.list_resources', 'read', 'low', false, [], false, null],
  [`GET ${P}/users/{id}/identity/assignments`]: ['access.identity.list_user_resources', 'read', 'low', false, [], false, null],
  [`GET ${P}/user_groups/{id}/identity/assignments`]: ['access.identity.list_group_resources', 'read', 'low', false, [], false, null],
  [`GET ${P}/visitors/{id}`]: ['access.visitors.get', 'read', 'low', false, PERSON, false, null],
  [`GET ${P}/visitors`]: ['access.visitors.list', 'read', 'low', false, PERSON, false, null],
  [`GET ${P}/access_policies/{id}`]: ['access.policies.get', 'read', 'low', false, [], false, null],
  [`GET ${P}/access_policies`]: ['access.policies.list', 'read', 'low', false, [], false, null],
  [`GET ${P}/access_policies/holiday_groups/{id}`]: ['access.policies.get_holiday_group', 'read', 'low', false, [], false, null],
  [`GET ${P}/access_policies/holiday_groups`]: ['access.policies.list_holiday_groups', 'read', 'low', false, [], false, null],
  [`GET ${P}/access_policies/schedules/{id}`]: ['access.policies.get_schedule', 'read', 'low', false, [], false, null],
  [`GET ${P}/access_policies/schedules`]: ['access.policies.list_schedules', 'read', 'low', false, [], false, null],
  [`GET ${P}/credentials/nfc_cards/sessions/{id}`]: ['access.credentials.get_nfc_enrollment', 'read', 'low', false, ['biometric_or_access_identity'], false, null],
  [`GET ${P}/credentials/nfc_cards/tokens/{token}`]: ['access.credentials.get_nfc_card', 'read', 'low', false, PERSON, false, null],
  [`GET ${P}/credentials/nfc_cards/tokens`]: ['access.credentials.list_nfc_cards', 'read', 'low', false, PERSON, false, null],
  [`GET ${P}/credentials/touch_passes`]: ['access.credentials.list_touch_passes', 'read', 'low', false, PERSON, false, null],
  [`GET ${P}/credentials/touch_passes/search`]: ['access.credentials.search_touch_passes', 'read', 'low', false, PERSON, false, null],
  [`GET ${P}/credentials/touch_passes/assignable`]: ['access.credentials.list_assignable_touch_passes', 'read', 'low', false, PERSON, false, null],
  [`GET ${P}/credentials/touch_passes/{id}`]: ['access.credentials.get_touch_pass', 'read', 'low', false, PERSON, false, null],
  [`GET ${P}/door_groups/topology`]: ['access.spaces.get_topology', 'read', 'low', false, [], false, null],
  [`GET ${P}/door_groups`]: ['access.spaces.list_door_groups', 'read', 'low', false, [], false, null],
  [`GET ${P}/door_groups/{id}`]: ['access.spaces.get_door_group', 'read', 'low', false, [], false, null],
  [`GET ${P}/doors`]: ['access.spaces.list_doors', 'read', 'low', false, [], false, 'access_list_doors'],
  [`GET ${P}/doors/{id}`]: ['access.spaces.get_door', 'read', 'low', false, [], false, 'access_get_door'],
  [`GET ${P}/doors/{id}/lock_rule`]: ['access.spaces.get_lock_rule', 'read', 'low', false, [], false, null],
  [`GET ${P}/doors/settings/emergency`]: ['access.spaces.get_emergency_status', 'read', 'low', false, [], false, null],
  [`GET ${P}/devices`]: ['access.devices.list', 'read', 'low', false, [], false, null],
  [`GET ${P}/devices/{device_id}/settings`]: ['access.devices.get_access_methods', 'read', 'low', false, [], false, null],
  [`POST ${P}/system/logs`]: ['access.logs.list', 'read', 'low', false, ['access_log', 'personal_identifier'], false, null],
  [`GET ${P}/system/logs/resource/{id}`]: ['access.logs.get_resource', 'read', 'low', false, ['access_log', 'recording'], false, null],
  [`GET ${P}/webhooks/endpoints`]: ['access.webhooks.list_endpoints', 'read', 'low', false, [], false, null],
};

/** Documented operations deliberately not offered, and why (ADR 0023 §3). */
const NOT_OFFERED: Record<string, string> = {
  [`POST ${P}/credentials/pin_codes`]: 'its result is a PIN, a credential (spec §6.4)',
};

interface Inventory {
  operations: { key: string; documentationUrl: string; minimumApplicationVersion: string }[];
}
const inventory = JSON.parse(
  await readFile(
    join(import.meta.dirname, '../../api-specs/access/2026-03-23/operations.json'),
    'utf8',
  ),
) as Inventory;
const byKey = new Map(inventory.operations.map((op) => [op.key, op]));
const generated = OPERATIONS as unknown as Record<string, { minimumVersion: string }>;

describe('Access security review', () => {
  it('records every implemented operation, and only those', () => {
    const implemented = ACCESS_OPERATIONS.map((d) => `${d.httpMethod} ${d.pathTemplate}`);
    expect(implemented.sort()).toEqual(Object.keys(REVIEW).sort());
    for (const key of Object.keys(NOT_OFFERED)) expect(implemented).not.toContain(key);
  });

  it('matches the reviewed metadata exactly', () => {
    for (const descriptor of ACCESS_OPERATIONS) {
      const key = `${descriptor.httpMethod} ${descriptor.pathTemplate}`;
      const row = REVIEW[key];
      const op = byKey.get(key);
      expect(row, descriptor.operationId).toBeDefined();
      if (row === undefined || op === undefined) continue;
      const [operationId, effect, risk, approval, sensitivity, defaultDisabled, namedTool] = row;
      const category = operationId.split('.')[1] ?? '';
      expect(
        {
          operationId: descriptor.operationId,
          moduleId: descriptor.moduleId,
          effect: descriptor.effect,
          risk: descriptor.risk,
          approval: descriptor.approvalRequired,
          sensitivity: [...descriptor.sensitivityTags].sort(),
          defaultDisabled: descriptor.defaultDisabled ?? false,
          namedTool: descriptor.namedTool ?? null,
          permission: descriptor.permission,
          siteScoped: descriptor.siteScoped,
          documentationUrl: descriptor.documentationUrl,
          contractRevision: descriptor.contractRevision,
        },
        key,
      ).toEqual({
        operationId,
        moduleId: 'access',
        effect,
        risk,
        approval,
        sensitivity: [...sensitivity].sort(),
        defaultDisabled,
        namedTool,
        permission: `access.${category}.${effect}`,
        siteScoped: false,
        documentationUrl: op.documentationUrl,
        contractRevision: '2026-03-23',
      });
    }
  });

  it('accepts versions from each stated minimum up to 4.2.16 (ADR 0021 §5, U1)', () => {
    expect(ACCESS_MAX_VERSION).toBe('4.2.16');
    for (const descriptor of ACCESS_OPERATIONS) {
      const key = `${descriptor.httpMethod} ${descriptor.pathTemplate}`;
      const minimum = generated[key]?.minimumVersion;
      expect(descriptor.apiVersionRange, key).toBe(`>=${String(minimum)} <=4.2.16`);
      // The generated minimum is the inventory's, raised only where ADR 0021 §3 says.
      const stated = byKey.get(key)?.minimumApplicationVersion;
      expect(
        minimum === stated || key.endsWith('/user_groups/{id}/identity/assignments'),
        key,
      ).toBe(true);
    }
    expect(generated[`GET ${P}/user_groups/{id}/identity/assignments`]?.minimumVersion).toBe(
      '2.2.6',
    );
  });

  it('removes credentials and bounds the logs as reviewed', () => {
    expect([...ALWAYS_REMOVED].sort()).toEqual(['headers', 'secret']);
    expect(MAX_LOG_WINDOW_SECONDS).toBe(31 * 24 * 60 * 60);
    expect(MAX_LOG_PAGE_SIZE).toBe(100);
  });
});
