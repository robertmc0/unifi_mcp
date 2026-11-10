/**
 * `config …`, `doctor` and `api coverage` (spec §13.2, §8.1, §4.5).
 */
import { readdir, readFile, statfs } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { defaultApiSpecsDir, isLoopbackBind, loadServiceConfig } from '@unifi-local-mcp/mcp-server';
import { requireString, string, type Command, type RunContext } from '../cli.ts';
import {
  apply,
  parseBootstrap,
  plan,
  prepare,
  validateBootstrapPolicies,
  type BootstrapPlan,
} from '../bootstrap.ts';
import { CliError } from '../io.ts';
import { confirm, formatTable, readDocument } from './shared.ts';

function planLines(result: BootstrapPlan): string[] {
  const lines = formatTable([
    ['KIND', 'NAME', 'ACTION', 'CHANGES'],
    ...result.entries.map((e) => [e.kind, e.name, e.action, e.changes.join(', ') || '-']),
  ]);
  if (result.notInFile.consoles.length + result.notInFile.clients.length > 0) {
    lines.push(
      '',
      `Not in the file, left unchanged: consoles [${result.notInFile.consoles.join(', ')}], clients [${result.notInFile.clients.join(', ')}]`,
    );
  }
  return lines;
}

async function loadPlan(ctx: RunContext) {
  const path = requireString(ctx.values, 'file');
  const file = parseBootstrap(await readDocument(path));
  const services = await ctx.services();
  const prepared = await prepare(file, dirname(path));
  return { services, prepared, result: plan(services, prepared) };
}

export const configCommands: Record<string, Command> = {
  validate: {
    summary: 'Validate the deployment environment (and a bootstrap file with --file)',
    usage: '[--file <bootstrap.yaml>]',
    options: { file: { type: 'string' } },
    run: async (ctx) => {
      loadServiceConfig(ctx.env);
      const file = string(ctx.values, 'file');
      if (file !== undefined) validateBootstrapPolicies(parseBootstrap(await readDocument(file)));
      ctx.print({ valid: true }, () => ['The configuration is valid.']);
      return 0;
    },
  },
  'show-effective': {
    summary: 'Show the effective configuration (secrets are never shown)',
    usage: '',
    run: async (ctx) => {
      const services = await ctx.services();
      const { config } = services;
      const policy = services.policyStore.current();
      const effective = {
        deployment: { forceReadOnly: config.deployment.forceReadOnly },
        dataDir: config.dataDir,
        listener: {
          bind: config.http.bind,
          port: config.http.port,
          tls: config.http.tls !== undefined,
          allowPlaintext: config.http.allowPlaintext,
          allowedHosts: config.http.allowedHosts,
          allowedOrigins: config.http.allowedOrigins,
        },
        egressAllow: config.egress.allow,
        logLevel: config.logLevel,
        auditRetentionDays: config.auditRetentionDays,
        masterKeyId: services.masterKey.id,
        database: { schemaVersion: services.storage.schemaVersion, policyVersion: policy.version },
        runtimeMode: policy.document.runtimeMode,
        counts: {
          consoles: services.consoles.list().length,
          clients: services.clients.list().length,
          administrators: services.admins.count(),
          pendingApprovals: services.approvals.list({ status: 'pending' }).length,
        },
      };
      ctx.print(effective, () => [JSON.stringify(effective, null, 2)]);
      return 0;
    },
  },
  import: {
    summary: 'Show what applying a bootstrap file would change (changes nothing)',
    usage: '--file <bootstrap.yaml>',
    options: { file: { type: 'string' } },
    run: async (ctx) => {
      const { result } = await loadPlan(ctx);
      ctx.print(result, () => planLines(result));
      return 0;
    },
  },
  apply: {
    summary: 'Apply a bootstrap file in one transaction (never deletes anything)',
    usage: '--file <bootstrap.yaml> [--yes] [--dry-run]',
    options: { file: { type: 'string' }, yes: { type: 'boolean' }, 'dry-run': { type: 'boolean' } },
    run: async (ctx) => {
      const { services, prepared, result } = await loadPlan(ctx);
      if (ctx.values['dry-run'] === true) {
        ctx.print({ ...result, dryRun: true }, () => [
          ...planLines(result),
          '',
          'Dry run: nothing was changed.',
        ]);
        return 0;
      }
      if (result.entries.every((entry) => entry.action === 'unchanged')) {
        ctx.print({ ...result, tokens: [] }, () => ['Nothing to change.']);
        return 0;
      }
      if (!ctx.json) for (const line of planLines(result)) ctx.io.err(line);
      await confirm(ctx.io, 'Apply these changes', 'apply', ctx.values['yes'] === true);
      const tokens = apply(services, prepared);
      ctx.print({ ...result, tokens }, () => [
        'Applied.',
        ...tokens.flatMap(({ clientId, token }) => [
          `Token for new client "${clientId}" (shown once):`,
          `  ${token}`,
        ]),
      ]);
      return 0;
    },
  },
};

type Status = 'ok' | 'warn' | 'fail';

function describeFailure(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  return `${(error as Error).message}${typeof code === 'string' ? ` (${code})` : ''}`;
}

export const doctorCommand: Command = {
  summary: 'Check the configuration, database, key, policy and consoles',
  usage: '',
  run: async (ctx) => {
    const checks: { check: string; status: Status; detail: string }[] = [];
    const add = (check: string, status: Status, detail: string): void => {
      checks.push({ check, status, detail });
    };
    try {
      const services = await ctx.services();
      const { config } = services;
      add('configuration', 'ok', 'deployment settings are valid');
      add('master key', 'ok', `key ${services.masterKey.id} matches the database`);
      const integrity = services.storage.db.integrityCheck('quick');
      add(
        'database',
        integrity.ok ? 'ok' : 'fail',
        integrity.ok
          ? `schema v${String(services.storage.schemaVersion)}`
          : integrity.problems.join('; '),
      );
      const chain = services.audit.verifyChain();
      add(
        'audit chain',
        chain.ok ? 'ok' : 'fail',
        chain.ok
          ? `${String(chain.entriesChecked)} entries intact`
          : `broken at entry ${String(chain.firstInvalidSeq)}`,
      );
      const policy = services.policyStore.current();
      add(
        'policy',
        'ok',
        `version ${String(policy.version)}, runtime mode ${policy.document.runtimeMode}`,
      );
      add(
        'hard lock',
        'ok',
        config.deployment.forceReadOnly
          ? 'ON: no writes can run'
          : 'off: writes are possible where policy allows',
      );
      if (config.http.tls === undefined && !isLoopbackBind(config.http.bind)) {
        add(
          'listener',
          'warn',
          `plaintext HTTP on ${config.http.bind}: make sure a TLS proxy or loopback publishing protects it`,
        );
      } else {
        add(
          'listener',
          'ok',
          `${config.http.tls === undefined ? 'http' : 'https'} on ${config.http.bind}:${String(config.http.port)}`,
        );
      }
      add('egress', 'ok', config.egress.allow.join(', '));
      const consoles = services.consoles.list();
      if (consoles.length === 0) add('consoles', 'warn', 'none configured: unifi-mcp console add');
      for (const view of consoles) {
        const enabled = Object.entries(view.policy?.modules ?? {}).filter(
          ([, m]) => m.state !== 'disabled',
        );
        const problems = [
          ...(view.policy === null ? ['stored policy invalid'] : []),
          ...(view.tls.mode === 'insecure' ? ['TLS verification disabled'] : []),
          ...enabled.flatMap(([id]) => {
            const module = view.modules.find((m) => m.moduleId === id);
            return [
              ...(module?.hasCredential === true ? [] : [`${id}: no credential`]),
              ...(module?.observedVersion == null ? [`${id}: version not yet probed`] : []),
            ];
          }),
        ];
        add(
          `console ${view.alias}`,
          problems.length === 0 ? 'ok' : 'warn',
          problems.join('; ') || `${String(enabled.length)} module(s) enabled`,
        );
      }
      const clients = services.clients.list();
      add(
        'clients',
        clients.length === 0 ? 'warn' : 'ok',
        clients.length === 0
          ? 'none: unifi-mcp client create'
          : `${String(clients.length)} client(s)`,
      );
      add(
        'administrators',
        services.admins.count() === 0 ? 'warn' : 'ok',
        services.admins.count() === 0
          ? 'none: unifi-mcp admin bootstrap (needed for the admin UI)'
          : String(services.admins.count()),
      );
      const disk = await statfs(config.dataDir);
      const freeMiB = Math.floor((disk.bavail * disk.bsize) / (1024 * 1024));
      add(
        'disk space',
        freeMiB < 64 ? 'fail' : freeMiB < 512 ? 'warn' : 'ok',
        `${String(freeMiB)} MiB free on the data volume`,
      );
    } catch (error) {
      add('startup', 'fail', describeFailure(error));
    }
    ctx.print(checks, () =>
      formatTable([
        ['CHECK', 'STATUS', 'DETAIL'],
        ...checks.map((c) => [c.check, c.status.toUpperCase(), c.detail]),
      ]),
    );
    return checks.some((c) => c.status === 'fail') ? 1 : 0;
  },
};

export const apiCoverageCommand: Command = {
  summary: 'Show documented official operations per module and how many are implemented',
  usage: '',
  run: async (ctx) => {
    const dir = ctx.env['UNIFI_MCP_API_SPECS_DIR']?.trim() || defaultApiSpecsDir();
    const rows: { module: string; revision: string; documented: number; implemented: number }[] =
      [];
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      throw new CliError(`Cannot read the API inventory at ${dir}.`);
    }
    for (const app of entries.filter((e) => e.isDirectory())) {
      for (const revision of await readdir(join(dir, app.name), { withFileTypes: true })) {
        if (!revision.isDirectory()) continue;
        const inventory = JSON.parse(
          await readFile(join(dir, app.name, revision.name, 'operations.json'), 'utf8'),
        ) as {
          operations: unknown[];
        };
        rows.push({
          module: app.name,
          revision: revision.name,
          documented: inventory.operations.length,
          implemented: 0,
        });
      }
    }
    ctx.print(rows, () => [
      ...formatTable([
        ['MODULE', 'REVISION', 'DOCUMENTED', 'IMPLEMENTED'],
        ...rows.map((r) => [r.module, r.revision, String(r.documented), String(r.implemented)]),
      ]),
      '',
      'Module adapters register operations from Phase 2. Full matrix: docs/api-coverage/.',
    ]);
    return 0;
  },
};
