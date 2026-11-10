/**
 * Declarative bootstrap configuration (spec §8.1, §6.2; ADR 0015).
 *
 * A YAML (or JSON) file describes the global policy, consoles and clients. `config import`
 * shows what applying it would change; `config apply` makes exactly those changes in one
 * transaction. Nothing is ever deleted: consoles and clients that are not in the file are
 * left as they are and reported. Credentials are never written in the file: modules name a
 * `credentialFile` (for example a Docker secret) that is read at apply time.
 */
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { canonicalJson } from '@unifi-local-mcp/core';
import {
  ClientPolicySchema,
  ConsolePolicySchema,
  describeValidationError,
  GlobalPolicySchema,
} from '@unifi-local-mcp/policy';
import { MODULE_IDS, type ModuleId, type TlsTrustInput } from '@unifi-local-mcp/unifi-api';
import * as z from 'zod';
import type { Services } from './context.ts';
import { CliError } from './io.ts';

const Tls = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('verify'), caFile: z.string().min(1).optional() }),
  z.strictObject({ mode: z.literal('pinned'), pins: z.array(z.string()).min(1).max(10) }),
  z.strictObject({ mode: z.literal('insecure') }),
]);

const ConsoleEntry = z.strictObject({
  alias: z.string().min(1).max(63),
  host: z.string().min(1).max(253),
  description: z.string().max(500).optional(),
  tls: Tls.default({ mode: 'verify' }),
  /** Console policy without consoleId (state, enabledSites, rules, module states). */
  policy: z.record(z.string(), z.unknown()).default({}),
  modules: z
    .partialRecord(
      z.enum(MODULE_IDS),
      z.strictObject({
        port: z.number().int().min(1).max(65535).optional(),
        credentialFile: z.string().min(1).optional(),
      }),
    )
    .default({}),
});

const ClientEntry = z.strictObject({
  id: z.string().min(1).max(64),
  description: z.string().max(500).optional(),
  /** Client policy; `consoles` keys are console aliases (or ids). */
  policy: z.record(z.string(), z.unknown()).default({}),
});

export const BootstrapSchema = z
  .strictObject({
    version: z.literal(1),
    policy: z.record(z.string(), z.unknown()).optional(),
    consoles: z.array(ConsoleEntry).default([]),
    clients: z.array(ClientEntry).default([]),
  })
  .superRefine((file, ctx) => {
    const aliases = new Set<string>();
    for (const entry of file.consoles) {
      if (aliases.has(entry.alias))
        ctx.addIssue({ code: 'custom', message: `Console alias "${entry.alias}" appears twice.` });
      aliases.add(entry.alias);
    }
    const ids = new Set<string>();
    for (const entry of file.clients) {
      if (ids.has(entry.id))
        ctx.addIssue({ code: 'custom', message: `Client "${entry.id}" appears twice.` });
      ids.add(entry.id);
    }
  });
export type BootstrapFile = z.output<typeof BootstrapSchema>;

export interface PlanEntry {
  kind: 'policy' | 'console' | 'client';
  name: string;
  action: 'create' | 'update' | 'unchanged';
  changes: string[];
}

export interface BootstrapPlan {
  entries: PlanEntry[];
  /** Existing consoles and clients that the file does not mention (left unchanged). */
  notInFile: { consoles: string[]; clients: string[] };
}

interface PreparedConsole {
  entry: z.output<typeof ConsoleEntry>;
  tls: TlsTrustInput;
  credentials: Partial<Record<ModuleId, string>>;
}

export interface Prepared {
  file: BootstrapFile;
  baseDir: string;
  consoles: PreparedConsole[];
}

export function parseBootstrap(document: unknown): BootstrapFile {
  const parsed = BootstrapSchema.safeParse(document);
  if (!parsed.success)
    throw new CliError(`The bootstrap file is invalid:\n${describeValidationError(parsed.error)}`);
  return parsed.data;
}

const PLACEHOLDER_CONSOLE_ID = '00000000-0000-4000-8000-000000000000';

/**
 * Validates the policies inside a bootstrap file without a database: the global policy,
 * each console policy, and each client policy (console references stand in as one
 * placeholder console). References to consoles that exist only in the database are
 * checked by `plan`.
 */
export function validateBootstrapPolicies(file: BootstrapFile): void {
  if (file.policy !== undefined) {
    const parsed = GlobalPolicySchema.safeParse(file.policy);
    if (!parsed.success) {
      throw new CliError(`The global policy is invalid:\n${describeValidationError(parsed.error)}`);
    }
  }
  for (const entry of file.consoles) {
    try {
      consolePolicyFor(PLACEHOLDER_CONSOLE_ID, entry.policy);
    } catch (error) {
      throw new CliError(`Console "${entry.alias}": ${(error as Error).message}`);
    }
  }
  for (const entry of file.clients) {
    const consoles = (entry.policy['consoles'] ?? {}) as Record<string, unknown>;
    const placeholders = Object.fromEntries(
      Object.values(consoles).map((value, index) => [
        `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        value,
      ]),
    );
    const parsed = ClientPolicySchema.safeParse({
      ...entry.policy,
      consoles: placeholders,
      clientId: entry.id,
    });
    if (!parsed.success) {
      throw new CliError(
        `Client "${entry.id}" policy is invalid:\n${describeValidationError(parsed.error)}`,
      );
    }
  }
}

async function readRelative(baseDir: string, path: string): Promise<string> {
  const full = isAbsolute(path) ? path : resolve(baseDir, path);
  try {
    return (await readFile(full, 'utf8')).trim();
  } catch (error) {
    throw new CliError(
      `Cannot read ${full} (${(error as NodeJS.ErrnoException).code ?? 'error'}).`,
    );
  }
}

/** Reads every referenced file (CA certificates, credentials) before anything is changed. */
export async function prepare(file: BootstrapFile, baseDir: string): Promise<Prepared> {
  const consoles: PreparedConsole[] = [];
  for (const entry of file.consoles) {
    const tls: TlsTrustInput =
      entry.tls.mode === 'verify'
        ? entry.tls.caFile === undefined
          ? { mode: 'verify' }
          : { mode: 'verify', caPem: await readRelative(baseDir, entry.tls.caFile) }
        : entry.tls.mode === 'pinned'
          ? { mode: 'pinned', pins: entry.tls.pins }
          : { mode: 'insecure' };
    const credentials: Partial<Record<ModuleId, string>> = {};
    for (const [moduleId, module] of Object.entries(entry.modules) as [
      ModuleId,
      { credentialFile?: string } | undefined,
    ][]) {
      if (module?.credentialFile !== undefined)
        credentials[moduleId] = await readRelative(baseDir, module.credentialFile);
    }
    consoles.push({ entry, tls, credentials });
  }
  return { file, baseDir, consoles };
}

function same(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/** True when the console's stored TLS trust differs from the wanted one. */
function tlsDiffers(services: Services, consoleId: string, wanted: TlsTrustInput): boolean {
  const current = services.consoles.connection(consoleId, 'network')?.trust;
  const normalised =
    wanted.mode === 'pinned'
      ? {
          mode: 'pinned',
          spkiSha256: wanted.pins.map((pin) => pin.trim().replace(/^sha256\//, '')),
        }
      : wanted.mode === 'verify' && wanted.caPem !== undefined
        ? { mode: 'verify', caPem: wanted.caPem }
        : { mode: wanted.mode };
  return current === undefined || !same(current, normalised);
}

function consolePolicyFor(id: string, policy: Record<string, unknown>) {
  const parsed = ConsolePolicySchema.safeParse({ ...policy, consoleId: id });
  if (!parsed.success)
    throw new CliError(`Console policy is invalid:\n${describeValidationError(parsed.error)}`);
  return parsed.data;
}

function clientPolicyFor(
  services: Services,
  prepared: Prepared,
  entry: z.output<typeof ClientEntry>,
  ids: Map<string, string>,
) {
  const consoles = (entry.policy['consoles'] ?? {}) as Record<string, unknown>;
  const resolved: Record<string, unknown> = {};
  for (const [ref, value] of Object.entries(consoles)) {
    const id = ids.get(ref) ?? services.consoles.get(ref)?.id;
    if (id === undefined && !prepared.file.consoles.some((c) => c.alias === ref)) {
      throw new CliError(`Client "${entry.id}" refers to unknown console "${ref}".`);
    }
    resolved[id ?? `pending:${ref}`] = value;
  }
  const parsed = ClientPolicySchema.safeParse({
    ...entry.policy,
    consoles: resolved,
    clientId: entry.id,
  });
  if (!parsed.success && Object.keys(resolved).every((key) => !key.startsWith('pending:'))) {
    throw new CliError(
      `Client "${entry.id}" policy is invalid:\n${describeValidationError(parsed.error)}`,
    );
  }
  return parsed.success ? parsed.data : undefined;
}

export function plan(services: Services, prepared: Prepared): BootstrapPlan {
  const entries: PlanEntry[] = [];
  if (prepared.file.policy !== undefined) {
    const parsed = GlobalPolicySchema.safeParse(prepared.file.policy);
    if (!parsed.success)
      throw new CliError(`The global policy is invalid:\n${describeValidationError(parsed.error)}`);
    const current = services.policyStore.current().document;
    entries.push({
      kind: 'policy',
      name: 'global',
      action: same(parsed.data, current) ? 'unchanged' : 'update',
      changes: same(parsed.data, current) ? [] : ['global policy'],
    });
  }
  const ids = new Map<string, string>();
  for (const { entry, tls, credentials } of prepared.consoles) {
    const existing = services.consoles.get(entry.alias);
    if (existing === undefined) {
      consolePolicyFor(PLACEHOLDER_CONSOLE_ID, entry.policy);
      entries.push({
        kind: 'console',
        name: entry.alias,
        action: 'create',
        changes: ['new console'],
      });
      continue;
    }
    ids.set(entry.alias, existing.id);
    const changes: string[] = [];
    if (existing.host !== entry.host) changes.push(`host ${existing.host} → ${entry.host}`);
    if (
      (existing.description ?? undefined) !== entry.description &&
      entry.description !== undefined
    )
      changes.push('description');
    if (tlsDiffers(services, existing.id, tls))
      changes.push(`tls ${existing.tls.mode} → ${tls.mode}`);
    if (!same(consolePolicyFor(existing.id, entry.policy), existing.policy)) changes.push('policy');
    for (const moduleId of MODULE_IDS) {
      const wanted = entry.modules[moduleId];
      const view = existing.modules.find((m) => m.moduleId === moduleId);
      if (wanted?.port !== undefined && view?.port !== wanted.port)
        changes.push(`${moduleId} port`);
      const credential = credentials[moduleId];
      if (
        credential !== undefined &&
        services.consoles.connection(existing.id, moduleId)?.credential?.reveal() !== credential
      ) {
        changes.push(`${moduleId} credential`);
      }
    }
    entries.push({
      kind: 'console',
      name: entry.alias,
      action: changes.length === 0 ? 'unchanged' : 'update',
      changes,
    });
  }
  for (const entry of prepared.file.clients) {
    const existing = services.clients.get(entry.id);
    const policy = clientPolicyFor(services, prepared, entry, ids);
    if (existing === undefined) {
      entries.push({
        kind: 'client',
        name: entry.id,
        action: 'create',
        changes: ['new client (token issued)'],
      });
    } else {
      const changed = policy === undefined || !same(policy, existing.policy);
      entries.push({
        kind: 'client',
        name: entry.id,
        action: changed ? 'update' : 'unchanged',
        changes: changed ? ['policy'] : [],
      });
    }
  }
  return {
    entries,
    notInFile: {
      consoles: services.consoles
        .list()
        .map((c) => c.alias)
        .filter((alias) => !prepared.file.consoles.some((c) => c.alias === alias)),
      clients: services.clients
        .list()
        .map((c) => c.clientId)
        .filter((id) => !prepared.file.clients.some((c) => c.id === id)),
    },
  };
}

/** Applies the plan in one transaction. Returns the tokens of newly created clients. */
export function apply(
  services: Services,
  prepared: Prepared,
): { clientId: string; token: string }[] {
  const { actor } = services;
  return services.storage.db.transaction(() => {
    const tokens: { clientId: string; token: string }[] = [];
    if (prepared.file.policy !== undefined) {
      const current = services.policyStore.current();
      if (!same(GlobalPolicySchema.parse(prepared.file.policy), current.document)) {
        services.policyStore.replace(prepared.file.policy, actor, current.version);
      }
    }
    const ids = new Map<string, string>();
    for (const { entry, tls, credentials } of prepared.consoles) {
      let view = services.consoles.get(entry.alias);
      if (view === undefined) {
        view = services.consoles.add(
          {
            alias: entry.alias,
            host: entry.host,
            tls,
            ...(entry.description === undefined ? {} : { description: entry.description }),
          },
          actor,
        );
      } else {
        if (
          view.host !== entry.host ||
          (entry.description !== undefined && view.description !== entry.description)
        ) {
          view = services.consoles.updateDetails(
            view.id,
            {
              host: entry.host,
              ...(entry.description === undefined ? {} : { description: entry.description }),
            },
            actor,
          );
        }
        if (tlsDiffers(services, view.id, tls)) services.consoles.setTls(view.id, tls, actor);
      }
      ids.set(entry.alias, view.id);
      if (!same(consolePolicyFor(view.id, entry.policy), view.policy)) {
        services.consoles.setPolicy(view.id, entry.policy, actor);
      }
      for (const moduleId of MODULE_IDS) {
        const port = entry.modules[moduleId]?.port;
        const currentPort = view.modules.find((m) => m.moduleId === moduleId)?.port;
        if (port !== undefined && port !== currentPort)
          services.consoles.setModulePort(view.id, moduleId, port, actor);
        const credential = credentials[moduleId];
        if (
          credential !== undefined &&
          services.consoles.connection(view.id, moduleId)?.credential?.reveal() !== credential
        ) {
          services.consoles.setCredential(view.id, moduleId, credential, actor);
        }
      }
    }
    for (const entry of prepared.file.clients) {
      const policy = clientPolicyFor(services, prepared, entry, ids);
      const existing = services.clients.get(entry.id);
      if (existing === undefined) {
        const issued = services.clients.create(
          {
            clientId: entry.id,
            policy,
            ...(entry.description === undefined ? {} : { description: entry.description }),
          },
          actor,
        );
        tokens.push({ clientId: entry.id, token: issued.token });
      } else if (!same(policy, existing.policy)) {
        services.clients.setPolicy(entry.id, policy, actor);
      }
    }
    return tokens;
  });
}
