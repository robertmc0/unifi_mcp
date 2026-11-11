/**
 * The reviewed security metadata of every Protect operation (spec §4.3, §6.3, §6.4;
 * ADR 0019). The table below is the review record: a change to permissions, risk,
 * approval, sensitivity, default state or named tools must change this table too, so it
 * cannot happen silently, for instance through a regenerated schema.
 *
 * Columns: operationId, effect, risk, approval required, sensitivity tags, default
 * disabled, named tool. The permission is always `protect.<category>.<effect>`. Rows are
 * keyed by the inventory key `"<METHOD> <path>"` (the contract has no operationIds).
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PROTECT_OPERATIONS } from '@unifi-local-mcp/unifi-protect';
import { describe, expect, it } from 'vitest';

type Row = [
  operationId: string,
  effect: 'read' | 'write',
  risk: 'low' | 'medium' | 'high',
  approval: boolean,
  sensitivity: string[],
  defaultDisabled: boolean,
  namedTool: string | null,
];

const PEOPLE = ['personal_identifier'];

/** Reviewed 2026-11-11 against contract 7.4.96, by inventory key. */
// prettier-ignore
const REVIEW: Record<string, Row> = {
  // Reads: low risk, no approval. People, presence and images need sensitive grants.
  'GET /v1/meta/info': ['protect.info.get', 'read', 'low', false, [], false, null],
  'GET /v1/cameras': ['protect.cameras.list', 'read', 'low', false, [], false, 'protect_list_cameras'],
  'GET /v1/cameras/{id}': ['protect.cameras.get', 'read', 'low', false, [], false, 'protect_get_camera'],
  'GET /v1/cameras/{id}/snapshot': ['protect.cameras.get_snapshot', 'read', 'low', false, ['camera_image'], false, 'protect_get_snapshot'],
  'GET /v1/cameras/{id}/rtsps-stream': ['protect.cameras.get_rtsps_streams', 'read', 'low', false, [], false, null],
  'GET /v1/lights': ['protect.lights.list', 'read', 'low', false, [], false, null],
  'GET /v1/lights/{id}': ['protect.lights.get', 'read', 'low', false, [], false, null],
  'GET /v1/sensors': ['protect.sensors.list', 'read', 'low', false, [], false, null],
  'GET /v1/sensors/{id}': ['protect.sensors.get', 'read', 'low', false, [], false, null],
  'GET /v1/sirens': ['protect.sirens.list', 'read', 'low', false, [], false, null],
  'GET /v1/sirens/{id}': ['protect.sirens.get', 'read', 'low', false, [], false, null],
  'GET /v1/speakers': ['protect.speakers.list', 'read', 'low', false, [], false, null],
  'GET /v1/speakers/{id}': ['protect.speakers.get', 'read', 'low', false, [], false, null],
  'GET /v1/chimes': ['protect.chimes.list', 'read', 'low', false, [], false, null],
  'GET /v1/chimes/{id}': ['protect.chimes.get', 'read', 'low', false, [], false, null],
  'GET /v1/relays': ['protect.relays.list', 'read', 'low', false, [], false, null],
  'GET /v1/relays/{id}': ['protect.relays.get', 'read', 'low', false, [], false, null],
  'GET /v1/bridges': ['protect.bridges.list', 'read', 'low', false, [], false, null],
  'GET /v1/bridges/{id}': ['protect.bridges.get', 'read', 'low', false, [], false, null],
  'GET /v1/link-stations': ['protect.link_stations.list', 'read', 'low', false, [], false, null],
  'GET /v1/link-stations/{id}': ['protect.link_stations.get', 'read', 'low', false, [], false, null],
  'GET /v1/alarm-hubs': ['protect.alarm_hubs.list', 'read', 'low', false, [], false, null],
  'GET /v1/alarm-hubs/{id}': ['protect.alarm_hubs.get', 'read', 'low', false, [], false, null],
  'GET /v1/fobs': ['protect.fobs.list', 'read', 'low', false, ['location'], false, null],
  'GET /v1/fobs/{id}': ['protect.fobs.get', 'read', 'low', false, ['location'], false, null],
  'GET /v1/nvrs': ['protect.nvrs.list', 'read', 'low', false, [], false, null],
  'GET /v1/arm-profiles': ['protect.alarm.list_arm_profiles', 'read', 'low', false, [], false, null],
  'GET /v1/external/arm-profiles': ['protect.alarm.list_external_profiles', 'read', 'low', false, [], false, null],
  'GET /v1/external/arm-profiles/{id}': ['protect.alarm.get_external_profile', 'read', 'low', false, [], false, null],
  'GET /v1/viewers': ['protect.viewers.list', 'read', 'low', false, [], false, null],
  'GET /v1/viewers/{id}': ['protect.viewers.get', 'read', 'low', false, [], false, null],
  'GET /v1/liveviews': ['protect.liveviews.list', 'read', 'low', false, [], false, null],
  'GET /v1/liveviews/{id}': ['protect.liveviews.get', 'read', 'low', false, [], false, null],
  'GET /v1/users': ['protect.users.list', 'read', 'low', false, PEOPLE, false, null],
  'GET /v1/users/{id}': ['protect.users.get', 'read', 'low', false, PEOPLE, false, null],
  'GET /v1/ulp-users': ['protect.users.list_ulp', 'read', 'low', false, PEOPLE, false, null],
  'GET /v1/ulp-users/{id}': ['protect.users.get_ulp', 'read', 'low', false, PEOPLE, false, null],
  'GET /v1/files/{fileType}': ['protect.files.list', 'read', 'low', false, [], false, null],
};

interface InventoryOperation {
  key: string;
  method: string;
  path: string;
  documentationUrl: string;
}

const inventory = JSON.parse(
  await readFile(
    join(import.meta.dirname, '../../api-specs/protect/7.4.96/operations.json'),
    'utf8',
  ),
) as { operations: InventoryOperation[] };
const byKey = new Map(inventory.operations.map((op) => [op.key, op]));

describe('Protect security review', () => {
  it('records every implemented operation, and only those', () => {
    const implemented = PROTECT_OPERATIONS.map((descriptor) => {
      const key = `${descriptor.httpMethod} ${descriptor.pathTemplate}`;
      expect(byKey.get(key), descriptor.operationId).toBeDefined();
      return key;
    });
    expect(implemented.sort()).toEqual(Object.keys(REVIEW).sort());
  });

  it('matches the reviewed metadata exactly', () => {
    for (const descriptor of PROTECT_OPERATIONS) {
      const key = `${descriptor.httpMethod} ${descriptor.pathTemplate}`;
      const op = byKey.get(key);
      const row = REVIEW[key];
      expect(row, descriptor.operationId).toBeDefined();
      if (row === undefined || op === undefined) continue;
      const [operationId, effect, risk, approval, sensitivity, defaultDisabled, namedTool] = row;
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
        },
        key,
      ).toEqual({
        operationId,
        moduleId: 'protect',
        effect,
        risk,
        approval,
        sensitivity: [...sensitivity].sort(),
        defaultDisabled,
        namedTool,
        permission: `protect.${descriptor.category}.${effect}`,
        siteScoped: false,
        documentationUrl: op.documentationUrl,
      });
    }
  });

  it('documents every implemented operation in docs/applications-protect.md', async () => {
    const manual = await readFile(
      join(import.meta.dirname, '../../docs/applications-protect.md'),
      'utf8',
    );
    for (const descriptor of PROTECT_OPERATIONS) {
      expect(manual, descriptor.operationId).toContain(`\`${descriptor.operationId}\``);
      if (descriptor.namedTool !== undefined) {
        expect(manual, descriptor.namedTool).toContain(`\`${descriptor.namedTool}\``);
      }
    }
  });

  it('never tags an operation with the non-grantable credential tag', () => {
    for (const descriptor of PROTECT_OPERATIONS) {
      expect(descriptor.sensitivityTags, descriptor.operationId).not.toContain('credential');
    }
  });
});
