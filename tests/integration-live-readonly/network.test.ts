/**
 * OPT-IN live read-only test of the Network adapter against a real console (spec §16
 * Phase 2, decision 21; ADR 0018 §7). Never part of `npm run check` or CI:
 *
 *   UNIFI_LIVE_HOST=<console address> \
 *   UNIFI_LIVE_NETWORK_KEY_FILE=<file with the API key> \
 *   UNIFI_LIVE_TLS_PIN=sha256/…            (or UNIFI_LIVE_CA_FILE=<PEM>) \
 *   [UNIFI_LIVE_PORT=443] [UNIFI_LIVE_REPORT=docs/api-coverage/live/network-11.0.97.json] \
 *   npm run test:live
 *
 * Safety:
 * - Only the 41 reads are registered; no write descriptor exists in this process.
 * - A guard in front of the executor refuses anything that is not a GET of a read, and
 *   every request is recorded and checked.
 * - The hard lock is on, and the client has read grants only.
 * - Nothing the console returns is printed or written: the report holds operation ids,
 *   outcomes and the application version, never names, addresses, ids or data. Where a
 *   response does not match the contract, it names the fields (paths with list positions
 *   removed) and the kind of mismatch, never their values.
 */
import { randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defineOperation,
  Dispatcher,
  ExecutionStore,
  mismatchSummary,
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
  PLAUSIBLE_VERSION,
  UnifiExecutor,
  VersionProber,
} from '@unifi-local-mcp/unifi-api';
import {
  NETWORK_READS,
  NETWORK_VERSION_PROBE,
  NETWORK_VERSION_RANGE,
} from '@unifi-local-mcp/unifi-network';
import { afterAll, describe, expect, it } from 'vitest';
import * as z from 'zod';
import {
  category,
  httpDetail,
  okOutcome,
  type Outcome,
  ReadOnlyGuard,
  writeReport,
} from './shared.ts';

const env = process.env;
const HOST = env['UNIFI_LIVE_HOST']?.trim() ?? '';
const KEY_FILE = env['UNIFI_LIVE_NETWORK_KEY_FILE']?.trim() ?? '';
const PIN = env['UNIFI_LIVE_TLS_PIN']?.trim() ?? '';
const CA_FILE = env['UNIFI_LIVE_CA_FILE']?.trim() ?? '';
const PORT = env['UNIFI_LIVE_PORT']?.trim() ?? '';
const REPORT = env['UNIFI_LIVE_REPORT']?.trim() ?? '';
const ENABLED = HOST !== '' && KEY_FILE !== '' && (PIN !== '' || CA_FILE !== '');

const CLI = { type: 'cli', id: 'live-test' } as const;
const PRINCIPAL = { clientId: 'live-reader' };

describe.skipIf(!ENABLED)('live read-only: UniFi Network', () => {
  const outcomes: Outcome[] = [];
  const report: Record<string, unknown> = {
    module: 'network',
    revision: '11.0.97',
    date: new Date().toISOString().slice(0, 10),
  };
  let dir = '';
  let close: (() => void) | undefined;

  afterAll(async () => {
    close?.();
    if (REPORT !== '') await writeReport(REPORT, { ...report, results: outcomes });
    if (dir !== '') await rm(dir, { recursive: true, force: true });
  });

  it('reads the console with GET requests only, and every read matches the contract', async () => {
    dir = await mkdtemp(join(tmpdir(), 'unifi-live-'));
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
    if (PORT !== '') {
      // Network and Protect share the console's HTTPS port.
      consoles.setModulePort(view.id, 'network', Number(PORT), CLI);
      consoles.setModulePort(view.id, 'protect', Number(PORT), CLI);
    }
    const key = (await readFile(KEY_FILE, 'utf8')).trim();
    consoles.setCredential(view.id, 'network', key, CLI);
    consoles.setPolicy(view.id, { modules: { network: { state: 'read_only' } } }, CLI);

    const address = isIP(HOST) === 0 ? (await lookup(HOST)).address : HOST;
    const egress = new EgressGuard({ allow: [`${address}/${isIP(address) === 6 ? 128 : 32}`] });
    const guard = new ReadOnlyGuard(new UnifiExecutor({ consoles, egress, logger }));
    const inventory = await loadContractInventory(join(import.meta.dirname, '../../api-specs'));
    const registry = new OperationRegistry(inventory);
    for (const descriptor of NETWORK_READS) registry.register(descriptor);
    registry.seal();

    /** Asks again for a response that missed its schema, and says where it missed. */
    const diagnose = async (
      descriptor: OperationDescriptor,
      args: Record<string, unknown>,
      siteId?: string,
    ): Promise<string[]> => {
      const input = descriptor.inputSchema.safeParse(args);
      if (!input.success) return ['(the test sent arguments outside the contract)'];
      const outcome = await guard.execute({
        descriptor,
        arguments: input.data,
        target: { consoleId: view.id, ...(siteId === undefined ? {} : { siteId }) },
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
    const descriptorOf = (operationId: string): OperationDescriptor => {
      const descriptor = registry.get(operationId);
      if (descriptor === undefined) throw new Error(`${operationId} is not registered.`);
      return descriptor;
    };

    // 1. Version.
    const probe = await new VersionProber({
      consoles,
      executor: guard,
      registry,
      specs: [NETWORK_VERSION_PROBE],
    }).probe(view.id, 'network');
    if (!probe.ok) {
      report['probe'] = probe.code;
      const mismatches =
        probe.code === 'upstream_contract_mismatch'
          ? await diagnose(descriptorOf(NETWORK_VERSION_PROBE.operationId), {})
          : [];
      outcomes.push({
        operationId: NETWORK_VERSION_PROBE.operationId,
        outcome: probe.code,
        ...(mismatches.length === 0 ? {} : { mismatches }),
      });
      expect.fail(
        `The version probe failed: ${probe.code}: ${probe.message}` +
          mismatches.map((line) => `\n  ${line}`).join(''),
      );
    }
    const version = probe.version;
    report['applicationVersion'] = version;
    report['supported'] = satisfies(version, NETWORK_VERSION_RANGE);
    expect(report['supported'], `Network ${version} is outside ${NETWORK_VERSION_RANGE}`).toBe(
      true,
    );

    const client = ClientPolicySchema.parse({
      clientId: PRINCIPAL.clientId,
      consoles: { [view.id]: { sites: '*' } },
      allow: ['network.*.read'],
      sensitive: ['personal_identifier', 'network_identity'],
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

    const run = async (
      operationId: string,
      args: Record<string, unknown> = {},
      siteId?: string,
    ): Promise<unknown> => {
      // The service's own rate limits apply; wait as told, which also keeps the load on
      // the console low.
      let envelope;
      for (let attempt = 0; ; attempt++) {
        envelope = await dispatcher.execute(PRINCIPAL, {
          operationId,
          consoleId: view.id,
          ...(siteId === undefined ? {} : { siteId }),
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
        outcome === 'upstream_contract_mismatch'
          ? await diagnose(descriptorOf(operationId), args, siteId)
          : [];
      outcomes.push({ operationId, outcome, ...(mismatches.length === 0 ? {} : { mismatches }) });
      return envelope.status === 'ok' ? envelope : undefined;
    };
    const firstId = (envelope: unknown, key = 'id'): string | undefined => {
      const data = (envelope as { data?: unknown } | undefined)?.data;
      const first = Array.isArray(data)
        ? (data[0] as Record<string, unknown> | undefined)
        : undefined;
      const id = first?.[key];
      return typeof id === 'string' ? id : undefined;
    };
    const skip = (operationId: string): void => {
      outcomes.push({ operationId, outcome: 'skipped: nothing to read' });
    };

    // 2. Console-level reads.
    await run('network.info.get');
    for (const id of [
      'network.devices.list_pending',
      'network.reference.list_countries',
      'network.reference.list_dpi_applications',
      'network.reference.list_dpi_categories',
    ]) {
      await run(id, { limit: 5 });
    }
    const sites = await run('network.sites.list', { limit: 5 });
    const siteId = firstId(sites);
    if (siteId === undefined) {
      const last = outcomes.at(-1);
      expect.fail(
        sites === undefined
          ? `network.sites.list failed: ${last?.outcome ?? 'unknown'}` +
              (last?.mismatches ?? []).map((line) => `\n  ${line}`).join('')
          : 'The console reports no site.',
      );
    }

    // 3. Site lists, each followed by a get of the first item where there is one.
    const pairs: [list: string, get: string | null, argument: string][] = [
      ['network.devices.list', 'network.devices.get', 'deviceId'],
      ['network.clients.list', 'network.clients.get', 'clientId'],
      ['network.networks.list', 'network.networks.get', 'networkId'],
      ['network.wifi.list', 'network.wifi.get', 'wifiBroadcastId'],
      ['network.firewall.list_policies', 'network.firewall.get_policy', 'firewallPolicyId'],
      ['network.firewall.list_zones', 'network.firewall.get_zone', 'firewallZoneId'],
      ['network.acl.list', 'network.acl.get', 'aclRuleId'],
      ['network.dns.list', 'network.dns.get', 'dnsPolicyId'],
      ['network.hotspot.list_vouchers', 'network.hotspot.get_voucher', 'voucherId'],
      ['network.switching.list_lags', 'network.switching.get_lag', 'lagId'],
      [
        'network.switching.list_mc_lag_domains',
        'network.switching.get_mc_lag_domain',
        'mcLagDomainId',
      ],
      [
        'network.switching.list_switch_stacks',
        'network.switching.get_switch_stack',
        'switchStackId',
      ],
      ['network.traffic_lists.list', 'network.traffic_lists.get', 'trafficMatchingListId'],
      ['network.devices.list_tags', null, ''],
      ['network.vpn.list_servers', null, ''],
      ['network.vpn.list_site_to_site_tunnels', null, ''],
      ['network.wans.list', null, ''],
      ['network.radius.list_profiles', null, ''],
    ];
    const firsts = new Map<string, string>();
    for (const [list, get, argument] of pairs) {
      const page = await run(list, { limit: 2 }, siteId);
      const id = firstId(page);
      if (id !== undefined) firsts.set(argument, id);
      if (get === null) continue;
      if (id === undefined) skip(get);
      else await run(get, { [argument]: id }, siteId);
    }
    const deviceId = firsts.get('deviceId');
    if (deviceId === undefined) skip('network.devices.get_statistics');
    else await run('network.devices.get_statistics', { deviceId }, siteId);
    const networkId = firsts.get('networkId');
    if (networkId === undefined) skip('network.networks.get_references');
    else await run('network.networks.get_references', { networkId }, siteId);

    // 3b. Every network (up to 25), informational: its details, checked against the
    //     contract, and its references. On Network 11.0.99 the details answered for every
    //     network while the references failed for networks in use. Only the network's
    //     categories and the results are kept.
    const networks = await run('network.networks.list', { limit: 25 }, siteId);
    const details = descriptorOf('network.networks.get');
    const references = descriptorOf('network.networks.get_references');
    const perNetwork: Record<string, unknown>[] = [];
    const read = async (descriptor: OperationDescriptor, networkId: string) => {
      const outcome = await guard.execute({
        descriptor,
        arguments: { networkId },
        target: { consoleId: view.id, siteId },
        signal: AbortSignal.timeout(descriptor.timeoutMs),
        correlationId: 'live-per-network',
        attempt: 1,
      });
      if (!outcome.ok)
        return { result: `${outcome.error.code}${httpDetail(outcome.error.message)}` };
      const output = descriptor.outputSchema.safeParse(outcome.data);
      return output.success
        ? { result: 'ok' }
        : {
            result: 'upstream_contract_mismatch',
            mismatches: mismatchSummary(output.error.issues),
          };
    };
    for (const network of ((networks as { data?: unknown[] } | undefined)?.data ?? []).slice(
      0,
      25,
    )) {
      const entry = network as {
        id?: unknown;
        management?: unknown;
        default?: unknown;
        metadata?: { origin?: unknown };
      };
      if (typeof entry.id !== 'string') continue;
      const detail = await read(details, entry.id);
      const reference = await read(references, entry.id);
      perNetwork.push({
        management: category(entry.management),
        default: entry.default === true,
        origin: category(entry.metadata?.origin),
        details: detail.result,
        ...(detail.mismatches === undefined ? {} : { detailMismatches: detail.mismatches }),
        references: reference.result,
        ...(reference.mismatches === undefined
          ? {}
          : { referenceMismatches: reference.mismatches }),
      });
    }
    report['networks'] = perNetwork;
    await run('network.acl.get_ordering', {}, siteId);
    const zones = await run('network.firewall.list_zones', { limit: 2 }, siteId);
    const zoneIds = ((zones as { data?: { id?: string }[] } | undefined)?.data ?? []).map(
      (z) => z.id,
    );
    if (zoneIds.length < 2 || zoneIds.some((id) => id === undefined)) {
      skip('network.firewall.get_policy_ordering');
    } else {
      await run(
        'network.firewall.get_policy_ordering',
        { sourceFirewallZoneId: zoneIds[0], destinationFirewallZoneId: zoneIds[1] },
        siteId,
      );
    }

    // 4. Paging: a page of one, then the next page, on the first list with two or more
    //    items. Only whether paging behaved is kept, never counts or ids.
    type Page =
      | {
          data?: { id?: unknown }[];
          pagination?: { count?: number; totalCount?: number; nextOffset?: number };
        }
      | undefined;
    const pageable: [list: string, siteId: string | undefined][] = [
      ['network.sites.list', undefined],
      ['network.networks.list', siteId],
      ['network.devices.list', siteId],
      ['network.firewall.list_zones', siteId],
      ['network.firewall.list_policies', siteId],
    ];
    let paging: Record<string, unknown> = { list: null };
    for (const [list, site] of pageable) {
      const first = (await run(list, { limit: 1, offset: 0 }, site)) as Page;
      const page = first?.pagination;
      if (page === undefined || (page.totalCount ?? 0) < 2) continue;
      const next = (await run(list, { limit: 1, offset: page.nextOffset ?? 1 }, site)) as Page;
      const a = first?.data?.[0]?.id;
      const b = next?.data?.[0]?.id;
      paging = {
        list,
        firstPageHasOne: page.count === 1 && first?.data?.length === 1,
        morePages: page.nextOffset === 1,
        nextPageOk: next !== undefined,
        nextPageHasOne: next?.pagination?.count === 1 && next.data?.length === 1,
        distinctItems: typeof a === 'string' && typeof b === 'string' && a !== b,
      };
      break;
    }
    report['pagination'] = paging;

    // 5. Filtering, informational: does the console accept a documented filter expression?
    const filtered = await run('network.sites.list', { filter: `id.eq(${siteId})`, limit: 5 });
    report['filter'] = { accepted: filtered !== undefined };

    // 6. Key scope (ADR 0005, unverified): does the Network key also authorise Protect?
    //    One documented Protect read, through the same guard, with the same key, and once
    //    more with a random key as the control.
    const protectRegistry = new OperationRegistry(inventory);
    const protectInfo = defineOperation({
      operationId: 'protect.info.get',
      moduleId: 'protect',
      category: 'info',
      effect: 'read',
      permission: 'protect.info.read',
      risk: 'low',
      sensitivityTags: [],
      approvalRequired: false,
      siteScoped: false,
      description: 'Live test only: Protect application information.',
      documentationUrl: 'https://developer.ui.com/protect/v7.4.96/get-v1metainfo',
      contractRevision: '7.4.96',
      apiVersionRange: '>=0',
      httpMethod: 'GET',
      pathTemplate: '/v1/meta/info',
      inputSchema: z.strictObject({}),
      outputSchema: z.unknown().transform(() => null),
      retryClass: 'safe-read',
      timeoutMs: 15_000,
    });
    protectRegistry.register(protectInfo); // proves the path is in the Protect contract
    consoles.setCredential(view.id, 'protect', key, CLI);
    consoles.setPolicy(
      view.id,
      { modules: { network: { state: 'read_only' }, protect: { state: 'read_only' } } },
      CLI,
    );
    const askProtect = () =>
      guard.execute({
        descriptor: protectInfo,
        arguments: {},
        target: { consoleId: view.id },
        signal: AbortSignal.timeout(15_000),
        correlationId: 'live-key-scope',
        attempt: 1,
      });
    const protect = await askProtect();
    // The Protect contract declares no authentication, so a success alone could mean the
    // endpoint answers anyone. Control: the same request with a random key nobody issued.
    consoles.setCredential(view.id, 'protect', randomBytes(24).toString('base64url'), CLI);
    const control = await askProtect();
    const protectVersion = protect.ok
      ? (protect.data as { applicationVersion?: unknown } | null)?.applicationVersion
      : undefined;
    if (typeof protectVersion === 'string' && PLAUSIBLE_VERSION.test(protectVersion)) {
      report['protectApplicationVersion'] = protectVersion;
    }
    report['protectKeyCheck'] = {
      withNetworkKey: protect.ok ? 'ok' : protect.error.code,
      withRandomKey: control.ok ? 'ok' : control.error.code,
    };
    report['networkKeyAuthorisesProtect'] = !protect.ok
      ? protect.error.code === 'upstream_unauthorized'
        ? 'no'
        : `inconclusive (${protect.error.code})`
      : control.ok
        ? 'inconclusive (Protect also answered a random key)'
        : control.error.code === 'upstream_unauthorized'
          ? 'yes'
          : `inconclusive (control: ${control.error.code})`;

    close();

    // 7. Only GETs were sent, and every read either worked or had nothing to read.
    expect(guard.sent.every((request) => request.startsWith('GET '))).toBe(true);
    const failed = outcomes.filter(
      (o) => !o.outcome.startsWith('ok') && !o.outcome.startsWith('skipped'),
    );
    expect(failed, 'reads that failed against the live console').toEqual([]);
  }, 120_000);
});

describe.runIf(!ENABLED)('live read-only: UniFi Network (not configured)', () => {
  it.skip('set UNIFI_LIVE_HOST, UNIFI_LIVE_NETWORK_KEY_FILE and UNIFI_LIVE_TLS_PIN to run', () =>
    undefined);
});
