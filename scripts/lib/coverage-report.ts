/**
 * Builds the API coverage matrix (spec §4.5, §16 Phase 2):
 *   docs/api-coverage/api-coverage.json                    machine-readable, all modules
 *   docs/api-coverage/<application>/<revision>.md          human-readable, per module
 *
 * Inputs: the committed api-specs/<app>/<revision>/{provenance,operations}.json and the
 * reviewed module adapters registered by the service (ADAPTERS). An operation is
 * `implemented` exactly when an adapter registers a descriptor for its method and path in
 * that revision; its reviewed metadata and test evidence come from there. The output is
 * deterministic (no timestamps): `npm run api:reconcile` regenerates it and fails when the
 * committed files differ.
 */
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { satisfies, type OperationDescriptor } from '@unifi-local-mcp/core';
import { ADAPTERS } from '@unifi-local-mcp/mcp-server';
import {
  COVERAGE_DIR,
  listSpecRevisions,
  readJson,
  REPO_ROOT,
  type Inventory,
  type Provenance,
} from './api-specs.ts';
import {
  classifyProvisionally,
  type ProvisionalClassification,
} from './provisional-classification.ts';

type Status = 'implemented' | 'not_implemented' | 'unsupported';

/**
 * Tests that exercise every implemented operation of a module, by effect. Each listed test
 * iterates the adapter's own operation list, so a new operation is covered automatically.
 */
const EVIDENCE: Record<string, { all: string[]; read: string[]; write: string[] }> = {
  network: {
    all: [
      'tests/contract/network-generated-schemas.test.ts',
      'tests/contract/network-security-review.test.ts',
    ],
    read: ['tests/integration-mock/network-reads.test.ts'],
    write: ['tests/integration-mock/network-writes.test.ts'],
  },
  protect: {
    all: [
      'tests/contract/protect-generated-schemas.test.ts',
      'tests/contract/protect-security-review.test.ts',
    ],
    read: [
      'tests/integration-mock/protect-reads.test.ts',
      'tests/integration-mock/protect-version-probe.test.ts',
    ],
    write: ['tests/integration-mock/protect-writes.test.ts'],
  },
};

/**
 * A reviewed result of the opt-in live read-only test (`UNIFI_LIVE_REPORT`), committed as
 * docs/api-coverage/live/<application>-<revision>.json. It holds operation ids, outcomes
 * and the console version, never names, addresses, ids or data.
 */
interface LiveRecord {
  module: string;
  revision: string;
  date: string;
  applicationVersion: string;
  results: { operationId: string; outcome: string }[];
}

function isLiveRecord(value: unknown): value is LiveRecord {
  const r = value as Partial<LiveRecord> | null;
  return (
    typeof r?.module === 'string' &&
    typeof r.revision === 'string' &&
    typeof r.date === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(r.date) &&
    typeof r.applicationVersion === 'string' &&
    /^[0-9][0-9A-Za-z.+-]{0,63}$/.test(r.applicationVersion) &&
    Array.isArray(r.results) &&
    r.results.every((x) => typeof x.operationId === 'string' && typeof x.outcome === 'string')
  );
}

async function readLiveRecord(
  liveDir: string,
  application: string,
  revision: string,
): Promise<LiveRecord | undefined> {
  const path = join(liveDir, `${application}-${revision}.json`);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
  const record: unknown = JSON.parse(text);
  if (!isLiveRecord(record) || record.module !== application || record.revision !== revision) {
    throw new Error(`${path} is not a live read-only record for ${application} ${revision}.`);
  }
  return record;
}

interface CoverageOperation {
  key: string;
  method: string;
  path: string;
  category: string;
  summary: string;
  documentationUrl: string | null;
  sourceRef: string | null;
  vendorPermission: string | null;
  transport: 'http' | 'websocket';
  status: Status;
  statusReason: string | null;
  operationId: string | null;
  exposure: { namedTool: string | null; generic: boolean } | null;
  permission: string | null;
  risk: string | null;
  approvalRequired: boolean | null;
  defaultDisabled: boolean | null;
  sensitivity: string[] | null;
  schemaValidation: boolean;
  mockTests: boolean;
  liveReadValidation: boolean;
  evidence: string[];
  provisional: ProvisionalClassification;
}

const APPLICATION_NAMES = {
  network: 'UniFi Network',
  protect: 'UniFi Protect',
  access: 'UniFi Access',
} as const;

function moduleTitle(p: Provenance): string {
  return `${APPLICATION_NAMES[p.application]} — ${p.vendorVersionLabel ?? `document revision ${p.revision}`}`;
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function markdown(p: Provenance, ops: CoverageOperation[], live?: LiveRecord): string {
  const contract = p.artifacts.find((a) => a.role === 'contract');
  const count = (pred: (o: CoverageOperation) => boolean): number => ops.filter(pred).length;
  const implemented = count((o) => o.status === 'implemented');
  const lines = [
    `# ${moduleTitle(p)}`,
    '',
    '> Generated by `scripts/generate-coverage-report.ts` from',
    `> \`api-specs/${p.application}/${p.revision}/\` and the registered adapters. Do not edit by hand.`,
    '',
    '| Item | Value |',
    '|---|---|',
    `| Contract source | ${contract ? `[${contract.name}](${contract.url})` : '—'} |`,
    `| Contract SHA-256 | \`${contract?.sha256 ?? '—'}\` |`,
    `| Retrieved | ${p.retrievedAt} |`,
    `| Local base URL | \`${p.localBaseUrlTemplate}\` |`,
    `| Authentication | \`${p.authentication.header}: ${p.authentication.valueFormat}\` |`,
    `| Minimum application version | ${p.minimumApplicationVersion ?? 'not stated by vendor'} |`,
    `| Documented operations | ${ops.length} (${count((o) => o.provisional.effect === 'read')} read, ${count((o) => o.provisional.effect === 'write')} write) |`,
    `| Implemented | ${implemented} |`,
    `| Unsupported (with reason) | ${count((o) => o.status === 'unsupported')} |`,
    `| Not yet implemented | ${count((o) => o.status === 'not_implemented')} |`,
  ];
  if (implemented > 0) {
    const reviewed = ops.filter((o) => o.status === 'implemented');
    const risk = (r: string): number => reviewed.filter((o) => o.risk === r).length;
    lines.push(
      `| Reviewed risk | ${risk('high')} high (human approval), ${risk('medium')} medium, ${risk('low')} low |`,
      `| Off by default | ${reviewed.filter((o) => o.defaultDisabled === true).length} |`,
      `| Live read-only validation | ${count((o) => o.liveReadValidation)}${live === undefined ? ' (opt-in, never in CI; not yet recorded)' : ` (${live.date}, ${APPLICATION_NAMES[p.application]} ${live.applicationVersion}; opt-in, never in CI)`} |`,
      '',
      '## Evidence',
      '',
      'Schemas: generated from the contract above (`schemaValidation`). Security metadata:',
      'reviewed by hand in the adapter and pinned by a contract test. Mock tests: every',
      'implemented operation runs end to end against a synthetic console:',
      '',
      ...[...new Set(reviewed.flatMap((o) => o.evidence))].sort().map((e) => `- \`${e}\``),
      '',
      '## Operations',
      '',
      '| # | Method | Path | Operation | Risk | Approval | Sensitivity | Named tool | Status |',
      '|---:|---|---|---|---|---|---|---|---|',
    );
    ops.forEach((o, i) => {
      const pathCell = o.documentationUrl
        ? `[\`${o.path}\`](${o.documentationUrl})`
        : `\`${o.path}\``;
      const done = o.status === 'implemented';
      lines.push(
        `| ${i + 1} | ${o.method} | ${pathCell} | ${done ? `\`${o.operationId ?? ''}\`` : '—'} | ${done ? (o.risk ?? '') : '—'} | ${done ? (o.approvalRequired === true ? 'yes' : 'no') + (o.defaultDisabled === true ? ', **off**' : '') : '—'} | ${done ? o.sensitivity?.join(', ') || '—' : '—'} | ${done && o.exposure?.namedTool ? `\`${o.exposure.namedTool}\`` : '—'} | ${o.status}${o.statusReason ? `: ${escapeCell(o.statusReason)}` : ''} |`,
      );
    });
  } else {
    lines.push(
      '',
      '## Provisional classification',
      '',
      'The **Prov.** columns are Phase 0 planning proposals from',
      '`scripts/lib/provisional-classification.ts`. They are not the reviewed security metadata',
      'required by spec §4.3 and do not enable anything. An operation marked **off** is proposed',
      'to stay disabled by default even when writes are granted.',
      '',
      `Provisional risk: ${count((o) => o.provisional.risk === 'high')} high, ${count((o) => o.provisional.risk === 'medium')} medium, ${count((o) => o.provisional.risk === 'low')} low; ${count((o) => o.provisional.defaultDisabled)} proposed default-disabled.`,
      '',
      '## Operations',
      '',
      '| # | Method | Path | Category | Status | Prov. effect | Prov. risk | Prov. sensitivity | Notes |',
      '|---:|---|---|---|---|---|---|---|---|',
    );
    ops.forEach((o, i) => {
      const pathCell = o.documentationUrl
        ? `[\`${o.path}\`](${o.documentationUrl})`
        : `\`${o.path}\``;
      const notes = [
        o.transport === 'websocket' ? 'WebSocket' : '',
        o.vendorPermission ? `perm \`${o.vendorPermission}\`` : '',
        o.sourceRef ?? '',
        o.provisional.defaultDisabled ? '**off**' : '',
        o.provisional.rationale,
      ]
        .filter((s) => s !== '')
        .join('; ');
      lines.push(
        `| ${i + 1} | ${o.method} | ${pathCell} | ${escapeCell(o.category)} | ${o.status} | ${o.provisional.effect} | ${o.provisional.risk} | ${o.provisional.sensitivity.join(', ') || '—'} | ${escapeCell(notes)} |`,
      );
    });
  }
  if (p.unverified.length > 0) {
    lines.push('', '## Unverified assumptions and open questions', '');
    for (const u of p.unverified) lines.push(`- ${u}`);
  }
  if (p.notes.length > 0) {
    lines.push('', '## Notes', '');
    for (const n of p.notes) lines.push(`- ${n}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Every coverage file, by path relative to the repository root, with its content. */
export async function buildCoverageFiles(
  options: { liveDir?: string } = {},
): Promise<Map<string, string>> {
  const liveDir = options.liveDir ?? join(COVERAGE_DIR, 'live');
  const files = new Map<string, string>();
  const modules = [];
  const registered = ADAPTERS.flatMap((adapter) => adapter.operations);
  /**
   * The registered operation implementing a documented one in a revision: same module,
   * method and path, and a verified version range that includes the revision (an
   * operation built from an older revision covers later ones it stays valid for,
   * ADR 0019 §7).
   */
  const implementing = (application: string, revision: string, method: string, path: string) =>
    registered.find(
      (d) =>
        d.moduleId === application &&
        d.httpMethod === method &&
        d.pathTemplate === path &&
        satisfies(revision, d.apiVersionRange),
    );
  const matched = new Set<OperationDescriptor>();
  for (const rev of await listSpecRevisions()) {
    const p = rev.provenance;
    const inventory = await readJson<Inventory>(join(rev.dir, 'operations.json'));
    const evidence = EVIDENCE[p.application];
    const live = await readLiveRecord(liveDir, p.application, p.revision);
    const liveOk = new Set(
      (live?.results ?? []).filter((r) => r.outcome === 'ok').map((r) => r.operationId),
    );
    for (const file of evidence === undefined
      ? []
      : [...evidence.all, ...evidence.read, ...evidence.write]) {
      await access(join(REPO_ROOT, file)).catch(() => {
        throw new Error(`Coverage evidence ${file} does not exist.`);
      });
    }
    const ops: CoverageOperation[] = inventory.operations.map((op) => {
      const d = implementing(p.application, p.revision, op.method, op.path);
      if (d !== undefined) matched.add(d);
      return {
        key: op.key,
        method: op.method,
        path: op.path,
        category: op.category,
        summary: op.summary,
        documentationUrl: op.documentationUrl,
        sourceRef: op.sourceRef ?? null,
        vendorPermission: op.vendorPermission ?? null,
        transport: op.transport,
        status: d === undefined ? 'not_implemented' : 'implemented',
        statusReason: null,
        operationId: d?.operationId ?? null,
        exposure: d === undefined ? null : { namedTool: d.namedTool ?? null, generic: true },
        permission: d?.permission ?? null,
        risk: d?.risk ?? null,
        approvalRequired: d?.approvalRequired ?? null,
        defaultDisabled: d === undefined ? null : (d.defaultDisabled ?? false),
        sensitivity: d === undefined ? null : [...d.sensitivityTags].sort(),
        schemaValidation: d !== undefined,
        mockTests: d !== undefined && evidence !== undefined,
        liveReadValidation: d !== undefined && d.effect === 'read' && liveOk.has(d.operationId),
        evidence:
          d === undefined || evidence === undefined
            ? []
            : [...evidence.all, ...(d.effect === 'read' ? evidence.read : evidence.write)],
        provisional: classifyProvisionally(p.application, op),
      };
    });
    files.set(`docs/api-coverage/${p.application}/${p.revision}.md`, markdown(p, ops, live));
    modules.push({
      application: p.application,
      revision: p.revision,
      vendorVersionLabel: p.vendorVersionLabel,
      contractKind: p.contractKind,
      contractSha256: p.artifacts.find((a) => a.role === 'contract')?.sha256 ?? null,
      localBaseUrlTemplate: p.localBaseUrlTemplate,
      totals: {
        documented: ops.length,
        implemented: ops.filter((o) => o.status === 'implemented').length,
        unsupported: ops.filter((o) => o.status === 'unsupported').length,
        notImplemented: ops.filter((o) => o.status === 'not_implemented').length,
      },
      operations: ops,
    });
  }
  const unmatched = registered
    .filter((d) => !matched.has(d))
    .map((d) => `${d.moduleId} ${d.contractRevision} ${d.httpMethod} ${d.pathTemplate}`);
  if (unmatched.length > 0) {
    throw new Error(`Registered operations missing from api-specs/: ${unmatched.join(', ')}`);
  }
  files.set(
    'docs/api-coverage/api-coverage.json',
    `${JSON.stringify(
      { schemaVersion: 1, generatedBy: 'scripts/generate-coverage-report.ts', modules },
      null,
      2,
    )}\n`,
  );
  return files;
}

export { COVERAGE_DIR };
