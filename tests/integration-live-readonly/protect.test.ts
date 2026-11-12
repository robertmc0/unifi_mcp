/**
 * OPT-IN live read-only test of the Protect adapter against a real console (spec §16
 * Phase 3, decision 21; ADR 0019). Never part of `npm run check` or CI. It runs with the
 * Network live test, using the same console settings:
 *
 *   UNIFI_LIVE_HOST=<console address> \
 *   UNIFI_LIVE_TLS_PIN=sha256/…            (or UNIFI_LIVE_CA_FILE=<PEM>) \
 *   UNIFI_LIVE_NETWORK_KEY_FILE=<key file> (or UNIFI_LIVE_PROTECT_KEY_FILE=<key file>) \
 *   [UNIFI_LIVE_PROTECT_REPORT=docs/api-coverage/live/protect-7.3.74.json] \
 *   [UNIFI_LIVE_PROTECT_SNAPSHOT=1]        (also fetch one camera snapshot) \
 *   npm run test:live
 *
 * Safety:
 * - Only the Protect reads are registered; no write descriptor exists in this process.
 * - The read-only guard refuses anything that is not a GET of a read.
 * - The hard lock is on, and the client has read grants only.
 * - A snapshot is fetched only when asked for, kept in memory and discarded.
 * - Two WebSocket upgrades of the documented events subscription, with the key and with a
 *   random key, answer how subscriptions authenticate; only the status line is read.
 * - Nothing the console returns is printed or written: the report holds operation ids,
 *   outcomes, the application version and status codes, never names, ids or data.
 */
import { randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Dispatcher,
  ExecutionStore,
  OperationRegistry,
  satisfies,
  type OperationDescriptor,
} from '@unifi-local-mcp/core';
import { ClientPolicySchema, PolicyStore } from '@unifi-local-mcp/policy';
import { databasePathFor, MasterKey, openStorage } from '@unifi-local-mcp/storage';
import { AuditLog, createLogger } from '@unifi-local-mcp/telemetry';
import {
  ConsoleRegistry,
  EgressGuard,
  loadContractInventory,
  UnifiExecutor,
  VersionProber,
} from '@unifi-local-mcp/unifi-api';
import {
  PROTECT_CONTRACT_REVISIONS,
  PROTECT_READS,
  PROTECT_VERSION_PROBE,
  PROTECT_VERSION_RANGE,
} from '@unifi-local-mcp/unifi-protect';
import { afterAll, describe, expect, it } from 'vitest';
import { mismatchSummary } from '../fixtures/schema-mismatch.ts';
import { okOutcome, type Outcome, ReadOnlyGuard, upgradeStatus, writeReport } from './shared.ts';

const env = process.env;
const HOST = env['UNIFI_LIVE_HOST']?.trim() ?? '';
const KEY_FILE =
  env['UNIFI_LIVE_PROTECT_KEY_FILE']?.trim() || (env['UNIFI_LIVE_NETWORK_KEY_FILE']?.trim() ?? '');
const PIN = env['UNIFI_LIVE_TLS_PIN']?.trim() ?? '';
const CA_FILE = env['UNIFI_LIVE_CA_FILE']?.trim() ?? '';
const PORT = env['UNIFI_LIVE_PORT']?.trim() ?? '';
const REPORT = env['UNIFI_LIVE_PROTECT_REPORT']?.trim() ?? '';
const SNAPSHOT = env['UNIFI_LIVE_PROTECT_SNAPSHOT']?.trim() === '1';
const ENABLED = HOST !== '' && KEY_FILE !== '' && (PIN !== '' || CA_FILE !== '');

const CLI = { type: 'cli', id: 'live-test' } as const;
const PRINCIPAL = { clientId: 'live-viewer' };

/** List → get pairs: the get runs with the id of the first item the list returns. */
const PAIRS: [list: string, get: string][] = [
  ['protect.cameras.list', 'protect.cameras.get'],
  ['protect.lights.list', 'protect.lights.get'],
  ['protect.sensors.list', 'protect.sensors.get'],
  ['protect.sirens.list', 'protect.sirens.get'],
  ['protect.speakers.list', 'protect.speakers.get'],
  ['protect.chimes.list', 'protect.chimes.get'],
  ['protect.relays.list', 'protect.relays.get'],
  ['protect.bridges.list', 'protect.bridges.get'],
  ['protect.link_stations.list', 'protect.link_stations.get'],
  ['protect.alarm_hubs.list', 'protect.alarm_hubs.get'],
  ['protect.fobs.list', 'protect.fobs.get'],
  ['protect.viewers.list', 'protect.viewers.get'],
  ['protect.liveviews.list', 'protect.liveviews.get'],
  ['protect.users.list', 'protect.users.get'],
  ['protect.users.list_ulp', 'protect.users.get_ulp'],
  ['protect.alarm.list_external_profiles', 'protect.alarm.get_external_profile'],
];

describe.skipIf(!ENABLED)('live read-only: UniFi Protect', () => {
  const outcomes: Outcome[] = [];
  const report: Record<string, unknown> = {
    module: 'protect',
    revision: PROTECT_CONTRACT_REVISIONS[0],
    date: new Date().toISOString().slice(0, 10),
  };
  let dir = '';
  let close: (() => void) | undefined;

  afterAll(async () => {
    close?.();
    if (REPORT !== '') await writeReport(REPORT, { ...report, results: outcomes });
    if (dir !== '') await rm(dir, { recursive: true, force: true });
  });

  it('reads Protect with GET requests only, and every read matches the contract', async () => {
    dir = await mkdtemp(join(tmpdir(), 'unifi-live-protect-'));
    const storage = await openStorage({
      databasePath: databasePathFor(join(dir, 'data')),
      masterKey: MasterKey.fromBytes(randomBytes(32)),
    });
    close = () => {
      storage.close();
      close = undefined;
    };
    const logger = createLogger({ level: 'error', sink: { write: () => undefined } });
    const audit = new AuditLog(storage.db, { logger });
    const policyStore = new PolicyStore(storage.db, audit);
    policyStore.current();
    const consoles = new ConsoleRegistry({
      db: storage.db,
      audit,
      secrets: storage.secrets,
      logger,
    });
    const view = consoles.add(
      {
        alias: 'live',
        host: HOST,
        tls:
          PIN !== ''
            ? { mode: 'pinned', pins: [PIN] }
            : { mode: 'verify', caPem: await readFile(CA_FILE, 'utf8') },
      },
      CLI,
    );
    if (PORT !== '') consoles.setModulePort(view.id, 'protect', Number(PORT), CLI);
    const key = (await readFile(KEY_FILE, 'utf8')).trim();
    consoles.setCredential(view.id, 'protect', key, CLI);
    consoles.setPolicy(view.id, { modules: { protect: { state: 'read_only' } } }, CLI);

    const address = isIP(HOST) === 0 ? (await lookup(HOST)).address : HOST;
    const egress = new EgressGuard({ allow: [`${address}/${isIP(address) === 6 ? 128 : 32}`] });
    const guard = new ReadOnlyGuard(new UnifiExecutor({ consoles, egress, logger }));
    const inventory = await loadContractInventory(join(import.meta.dirname, '../../api-specs'));
    const registry = new OperationRegistry(inventory);
    for (const descriptor of PROTECT_READS) registry.register(descriptor);
    registry.seal();
    const descriptorOf = (operationId: string): OperationDescriptor => {
      const descriptor = registry.get(operationId);
      if (descriptor === undefined) throw new Error(`${operationId} is not registered.`);
      return descriptor;
    };

    /** Asks again for a response that missed its schema, and says where it missed. */
    const diagnose = async (
      descriptor: OperationDescriptor,
      args: Record<string, unknown>,
    ): Promise<string[]> => {
      const input = descriptor.inputSchema.safeParse(args);
      if (!input.success) return ['(the test sent arguments outside the contract)'];
      const outcome = await guard.execute({
        descriptor,
        arguments: input.data,
        target: { consoleId: view.id },
        signal: AbortSignal.timeout(descriptor.timeoutMs),
        correlationId: 'live-diagnose',
        attempt: 1,
      });
      if (!outcome.ok) return [`(the second request failed: ${outcome.error.code})`];
      const output = descriptor.outputSchema.safeParse(outcome.data);
      return output.success
        ? ['(the second response matched)']
        : mismatchSummary(output.error.issues);
    };

    // 1. Version: which reads this console supports.
    const probe = await new VersionProber({
      consoles,
      executor: guard,
      registry,
      specs: [PROTECT_VERSION_PROBE],
    }).probe(view.id, 'protect');
    if (!probe.ok) {
      report['probe'] = probe.code;
      outcomes.push({ operationId: 'protect.info.get', outcome: probe.code });
      expect.fail(`The Protect version probe failed: ${probe.code}: ${probe.message}`);
    }
    const version = probe.version;
    report['applicationVersion'] = version;
    report['supported'] = satisfies(version, PROTECT_VERSION_RANGE);
    // The record belongs to the newest contract revision the console reaches.
    report['revision'] =
      [...PROTECT_CONTRACT_REVISIONS].reverse().find((r) => satisfies(version, `>=${r}`)) ??
      PROTECT_CONTRACT_REVISIONS[0];
    expect(report['supported'], `Protect ${version} is outside ${PROTECT_VERSION_RANGE}`).toBe(
      true,
    );

    const client = ClientPolicySchema.parse({
      clientId: PRINCIPAL.clientId,
      consoles: { [view.id]: { sites: '*' } },
      allow: ['protect.*.read'],
      sensitive: ['personal_identifier', 'location', 'camera_image'],
    });
    const dispatcher = new Dispatcher({
      registry,
      executor: guard,
      security: {
        clientPolicy: (id) => (id === client.clientId ? client : undefined),
        consolePolicy: (id) => consoles.policy(id),
        capability: (id, descriptor) => consoles.capability(id, descriptor),
      },
      policyStore,
      deployment: { forceReadOnly: true },
      audit,
      executions: new ExecutionStore(storage.db),
      logger,
    });

    const run = async (operationId: string, args: Record<string, unknown> = {}) => {
      const descriptor = descriptorOf(operationId);
      if (!satisfies(version, descriptor.apiVersionRange)) {
        outcomes.push({ operationId, outcome: `skipped: needs ${descriptor.apiVersionRange}` });
        return undefined;
      }
      let envelope;
      for (let attempt = 0; ; attempt++) {
        envelope = await dispatcher.execute(PRINCIPAL, {
          operationId,
          consoleId: view.id,
          arguments: args,
        });
        if (envelope.error?.code !== 'rate_limited' || attempt >= 10) break;
        const wait = (envelope.error as { retryAfterMs?: number }).retryAfterMs ?? 1000;
        await new Promise((resolve) => setTimeout(resolve, Math.min(wait + 50, 5000)));
      }
      const outcome =
        envelope.status === 'ok'
          ? okOutcome(envelope.data)
          : (envelope.error?.code ?? envelope.status);
      const mismatches =
        outcome === 'upstream_contract_mismatch' ? await diagnose(descriptor, args) : [];
      outcomes.push({ operationId, outcome, ...(mismatches.length === 0 ? {} : { mismatches }) });
      return envelope.status === 'ok' ? envelope : undefined;
    };
    const skip = (operationId: string, why = 'nothing to read'): void => {
      outcomes.push({ operationId, outcome: `skipped: ${why}` });
    };
    const firstId = (envelope: unknown): string | undefined => {
      const data = (envelope as { data?: unknown } | undefined)?.data;
      const first = Array.isArray(data) ? (data[0] as { id?: unknown } | undefined) : undefined;
      return typeof first?.id === 'string' ? first.id : undefined;
    };

    // 2. Console-level reads.
    await run('protect.nvrs.list');
    await run('protect.alarm.list_arm_profiles');
    await run('protect.files.list', { fileType: 'animations' });

    // 3. Each list, then a get of its first item.
    const firsts = new Map<string, string>();
    for (const [list, get] of PAIRS) {
      const page = await run(list);
      const id = firstId(page);
      if (id !== undefined) firsts.set(list, id);
      if (!satisfies(version, descriptorOf(get).apiVersionRange)) {
        skip(get, `needs ${descriptorOf(get).apiVersionRange}`);
      } else if (id === undefined) skip(get);
      else await run(get, { id });
    }

    // 4. Camera extras: stream qualities, and a snapshot only when asked for.
    const camera = firsts.get('protect.cameras.list');
    if (camera === undefined) {
      skip('protect.cameras.get_rtsps_streams');
      skip('protect.cameras.get_snapshot');
    } else {
      await run('protect.cameras.get_rtsps_streams', { id: camera });
      if (SNAPSHOT) await run('protect.cameras.get_snapshot', { id: camera });
      else skip('protect.cameras.get_snapshot', 'not requested (UNIFI_LIVE_PROTECT_SNAPSHOT=1)');
    }

    // 5. How WebSocket subscriptions authenticate (provenance: unverified): an upgrade of
    //    the documented events subscription with the key, and with a random key.
    const connection = consoles.connection(view.id, 'protect');
    if (connection === undefined) throw new Error('No Protect connection.');
    const withKey = await upgradeStatus({
      connection,
      egress,
      path: '/v1/subscribe/events',
      credential: key,
    });
    const withRandomKey = await upgradeStatus({
      connection,
      egress,
      path: '/v1/subscribe/events',
      credential: randomBytes(24).toString('base64url'),
    });
    report['websocketAuth'] = { withKey, withRandomKey };
    report['websocketAcceptsApiKey'] =
      withKey === 101 && withRandomKey === 401
        ? 'yes'
        : withKey === 101
          ? `inconclusive (random key: ${String(withRandomKey)})`
          : `no (${String(withKey)})`;

    close();

    // 6. The report holds no free text (no URLs, no e-mail addresses), only GETs were sent,
    //    and every read either worked or was skipped.
    expect(JSON.stringify({ ...report, results: outcomes })).not.toMatch(/:\/\/|@/);
    expect(guard.sent.every((request) => request.startsWith('GET '))).toBe(true);
    const failed = outcomes.filter(
      (o) => !o.outcome.startsWith('ok') && !o.outcome.startsWith('skipped'),
    );
    expect(failed, 'reads that failed against the live console').toEqual([]);
  }, 120_000);
});

describe.runIf(!ENABLED)('live read-only: UniFi Protect (not configured)', () => {
  it.skip('set UNIFI_LIVE_HOST, a key file and UNIFI_LIVE_TLS_PIN to run', () => undefined);
});
