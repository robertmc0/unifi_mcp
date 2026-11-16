/**
 * Changes made from the admin web interface (spec §13.1 items 2, 3, 4; ADR 0027 §3).
 *
 * Every change calls the same store method as the CLI command of the same name, with the
 * signed-in administrator as the actor, so validation, audit entries, policy-version
 * bumps and revocation behave identically. This module only turns form fields into those
 * calls. It adds no capability the CLI lacks, and three things stay on the host: declaring
 * an application version (ADR 0021 §5), everything about administrators and their second
 * step (ADR 0015, ADR 0026), and maintenance (backup, restore, key rotation).
 *
 * A secret travels one way: a console credential comes in and is stored; a new client
 * token goes out once, in the page that answers the request that created it.
 */
import type { AdminActions, ChangeOutcome, PolicyPreview } from '@unifi-local-mcp/admin-api';
import type { OperationRegistry, SecurityContextProvider } from '@unifi-local-mcp/core';
import {
  validateGlobalPolicy,
  type ClientPolicy,
  type ConsolePolicy,
  type GlobalPolicy,
  type PolicyActor,
  type PolicyStore,
} from '@unifi-local-mcp/policy';
import {
  checkConsoleConnection,
  isModuleId,
  type ConsoleRegistry,
  type EgressGuard,
  type ModuleId,
  type TlsTrustInput,
} from '@unifi-local-mcp/unifi-api';
import type { ClientStore } from './clients.ts';
import type { ServiceConfig } from './config.ts';
import { discoverOperations } from './tools.ts';

export interface AdminActionSources {
  config: ServiceConfig;
  consoles: ConsoleRegistry;
  clients: ClientStore;
  policyStore: PolicyStore;
  registry: OperationRegistry;
  security: SecurityContextProvider;
  egress: EgressGuard;
  now: () => Date;
}

/** A refusal with a message for the administrator. The stores' own errors pass through. */
export class AdminActionError extends Error {
  override readonly name = 'AdminActionError';
  readonly code = 'invalid_input';
}

function text(form: URLSearchParams, name: string, max = 4096): string {
  return (form.get(name) ?? '').slice(0, max).trim();
}

function required(form: URLSearchParams, name: string, label: string, max = 4096): string {
  const value = text(form, name, max);
  if (value === '') throw new AdminActionError(`${label} is required.`);
  return value;
}

function jsonDocument(form: URLSearchParams, name: string): unknown {
  const raw = (form.get(name) ?? '').trim();
  if (raw === '') throw new AdminActionError('The policy is empty.');
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new AdminActionError(`The policy is not valid JSON: ${(error as Error).message}`);
  }
}

function moduleOf(form: URLSearchParams): ModuleId {
  const value = text(form, 'module', 32);
  if (!isModuleId(value))
    throw new AdminActionError('The module must be network, protect or access.');
  return value;
}

function tlsOf(form: URLSearchParams): TlsTrustInput {
  const mode = text(form, 'tlsMode', 16);
  if (mode === 'verify') {
    const caPem = text(form, 'caPem', 32_768);
    return caPem === '' ? { mode } : { mode, caPem };
  }
  if (mode === 'pinned') {
    const pins = (form.get('pins') ?? '')
      .split(/[\s,]+/)
      .map((pin) => pin.trim())
      .filter((pin) => pin !== '');
    if (pins.length === 0) throw new AdminActionError('Pinned trust needs at least one pin.');
    return { mode, pins };
  }
  if (mode === 'insecure') {
    if (text(form, 'insecureConfirm', 16) !== 'insecure') {
      throw new AdminActionError(
        'Disabling certificate verification needs the word "insecure" typed in its confirmation field.',
      );
    }
    return { mode };
  }
  throw new AdminActionError('The TLS mode must be verify, pinned or insecure.');
}

export function buildAdminActions(sources: AdminActionSources): AdminActions {
  const { consoles, clients, policyStore } = sources;
  const consoleOf = (form: URLSearchParams) => {
    const view = consoles.list().find((entry) => entry.id === text(form, 'consoleId', 64));
    if (view === undefined) throw new AdminActionError('There is no such console.');
    return view;
  };
  const clientOf = (form: URLSearchParams) => {
    const view = clients.get(text(form, 'clientId', 64));
    if (view === undefined) throw new AdminActionError('There is no such client.');
    return view;
  };
  /** Client policies name consoles by id; the form may use aliases. */
  const withConsoleIds = (policy: unknown): unknown => {
    if (typeof policy !== 'object' || policy === null) return policy;
    const named = (policy as { consoles?: unknown }).consoles;
    if (typeof named !== 'object' || named === null) return policy;
    const resolved: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(named)) {
      resolved[consoles.get(key)?.id ?? key] = value;
    }
    return { ...policy, consoles: resolved };
  };

  const changes: Record<
    string,
    (form: URLSearchParams, actor: PolicyActor) => ChangeOutcome | Promise<ChangeOutcome>
  > = {
    'console.add': (form, actor) => {
      const description = text(form, 'description', 500);
      const view = consoles.add(
        {
          alias: required(form, 'alias', 'The alias', 63),
          host: required(form, 'host', 'The host', 253),
          ...(description === '' ? {} : { description }),
          tls: tlsOf(form),
        },
        actor,
      );
      return {
        redirect: `/consoles/${view.id}`,
        notice: `Console "${view.alias}" added. No module is enabled until its policy says so.`,
      };
    },
    'console.details': (form, actor) => {
      const view = consoleOf(form);
      const description = text(form, 'description', 500);
      consoles.updateDetails(
        view.id,
        {
          host: required(form, 'host', 'The host', 253),
          description: description === '' ? null : description,
        },
        actor,
      );
      return { redirect: `/consoles/${view.id}`, notice: 'Console details changed.' };
    },
    'console.tls': (form, actor) => {
      const view = consoleOf(form);
      consoles.setTls(view.id, tlsOf(form), actor);
      return { redirect: `/consoles/${view.id}`, notice: 'TLS trust changed.' };
    },
    'console.credential': (form, actor) => {
      const view = consoleOf(form);
      const moduleId = moduleOf(form);
      // Not trimmed beyond line ends: a credential is stored as typed.
      const credential = (form.get('credential') ?? '').replace(/[\r\n]+$/, '');
      if (credential === '') throw new AdminActionError('The credential is required.');
      consoles.setCredential(view.id, moduleId, credential, actor);
      return {
        redirect: `/consoles/${view.id}`,
        notice: `Credential for ${moduleId} stored. It cannot be shown again.`,
      };
    },
    'console.port': (form, actor) => {
      const view = consoleOf(form);
      const moduleId = moduleOf(form);
      const raw = text(form, 'port', 8);
      const port = raw === '' ? null : Number(raw);
      if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) {
        throw new AdminActionError(
          'The port must be a number from 1 to 65535, or empty for the default.',
        );
      }
      consoles.setModulePort(view.id, moduleId, port, actor);
      return { redirect: `/consoles/${view.id}`, notice: `Port for ${moduleId} changed.` };
    },
    'console.policy': (form, actor) => {
      const view = consoleOf(form);
      consoles.setPolicy(view.id, jsonDocument(form, 'policy'), actor);
      return { redirect: `/consoles/${view.id}`, notice: 'Console policy changed.' };
    },
    'console.check': async (form) => {
      const view = consoleOf(form);
      const moduleId = moduleOf(form);
      const result = await checkConsoleConnection(consoles, sources.egress, view.id, moduleId);
      if (result === undefined) {
        throw new AdminActionError('The module is not configured on this console.');
      }
      return {
        redirect: `/consoles/${view.id}`,
        notice: `Connection check for ${moduleId}.`,
        report: [
          ['Console', `${result.host}:${String(result.port)}`],
          ['Address', result.address ?? '-'],
          ['Reachable', result.reachable ? 'yes' : 'no'],
          [
            'TLS mode',
            `${result.tlsMode}${result.tlsMode === 'insecure' ? ' (verification disabled)' : ''}`,
          ],
          ['Certificate trusted', result.verified ? 'yes' : 'no'],
          ['Credential', result.hasCredential ? 'stored' : 'missing'],
          ...(result.certificate === undefined
            ? []
            : ([
                ['Certificate subject', result.certificate.subject],
                ['Certificate issuer', result.certificate.issuer],
                ['Valid to', result.certificate.validTo],
                ['Pin', result.certificate.pin],
              ] as [string, string][])),
          ...(result.problem === undefined
            ? []
            : ([['Problem', result.problem]] as [string, string][])),
        ],
      };
    },
    'console.remove': (form, actor) => {
      const view = consoleOf(form);
      if (text(form, 'confirm', 63) !== view.alias) {
        throw new AdminActionError('Type the alias of the console to remove it.');
      }
      consoles.remove(view.id, actor);
      return { redirect: '/consoles', notice: `Console "${view.alias}" removed.` };
    },
    'client.create': (form, actor) => {
      const description = text(form, 'description', 500);
      const policyText = (form.get('policy') ?? '').trim();
      const issued = clients.create(
        {
          clientId: required(form, 'clientId', 'The client id', 64),
          ...(description === '' ? {} : { description }),
          ...(policyText === '' ? {} : { policy: withConsoleIds(jsonDocument(form, 'policy')) }),
        },
        actor,
      );
      return {
        redirect: `/clients/${issued.client.clientId}`,
        notice: `Client "${issued.client.clientId}" created.`,
        reveal: { label: `Token for client "${issued.client.clientId}"`, value: issued.token },
      };
    },
    'client.rotate': (form, actor) => {
      const view = clientOf(form);
      const issued = clients.rotate(view.clientId, actor);
      return {
        redirect: `/clients/${view.clientId}`,
        notice: `The earlier tokens of "${view.clientId}" no longer work.`,
        reveal: { label: `New token for client "${view.clientId}"`, value: issued.token },
      };
    },
    'client.revoke': (form, actor) => {
      const view = clientOf(form);
      clients.revoke(view.clientId, actor);
      return {
        redirect: `/clients/${view.clientId}`,
        notice: `Client "${view.clientId}" revoked.`,
      };
    },
    'client.policy': (form, actor) => {
      const view = clientOf(form);
      clients.setPolicy(view.clientId, withConsoleIds(jsonDocument(form, 'policy')), actor);
      return { redirect: `/clients/${view.clientId}`, notice: 'Client policy changed.' };
    },
    'client.remove': (form, actor) => {
      const view = clientOf(form);
      if (text(form, 'confirm', 64) !== view.clientId) {
        throw new AdminActionError('Type the id of the client to remove it.');
      }
      clients.remove(view.clientId, actor);
      return { redirect: '/clients', notice: `Client "${view.clientId}" removed.` };
    },
    'policy.mode': (form, actor) => {
      const mode = text(form, 'mode', 16);
      if (mode !== 'read_only' && mode !== 'read_write') {
        throw new AdminActionError('The mode must be read_only or read_write.');
      }
      policyStore.setRuntimeMode(mode, actor);
      return {
        redirect: '/policy',
        notice:
          mode === 'read_only'
            ? 'Runtime mode is read_only: no write can run.'
            : sources.config.deployment.forceReadOnly
              ? 'Runtime mode is read_write, but the hard lock is on: still no write can run.'
              : 'Runtime mode is read_write: granted writes can run.',
      };
    },
    'policy.document': (form, actor) => {
      const version = Number(text(form, 'version', 16));
      if (!Number.isSafeInteger(version)) {
        throw new AdminActionError('The form is out of date. Reload the page and try again.');
      }
      policyStore.replace(jsonDocument(form, 'policy'), actor, version);
      return { redirect: '/policy', notice: 'Global policy changed.' };
    },
  };

  /** Operation ids each client could use, with one policy replaced by a candidate. */
  const effective = (candidate: {
    global?: GlobalPolicy;
    console?: ConsolePolicy;
    client?: ClientPolicy;
  }): Map<string, Set<string>> => {
    const snapshot = policyStore.current();
    const security: SecurityContextProvider = {
      ...sources.security,
      clientPolicy: (clientId) =>
        candidate.client?.clientId === clientId
          ? candidate.client
          : sources.security.clientPolicy(clientId),
      consolePolicy: (consoleId) =>
        candidate.console?.consoleId === consoleId
          ? candidate.console
          : sources.security.consolePolicy(consoleId),
    };
    const result = new Map<string, Set<string>>();
    for (const client of clients.list()) {
      const found = discoverOperations({
        principal: { clientId: client.clientId },
        security,
        policyStore: {
          current: () => ({ ...snapshot, document: candidate.global ?? snapshot.document }),
        },
        registry: sources.registry,
        deployment: sources.config.deployment,
        now: sources.now,
      });
      result.set(client.clientId, new Set(found.map((entry) => entry.descriptor.operationId)));
    }
    return result;
  };

  return {
    names: () => Object.keys(changes),
    run: async (change, form, actor) => {
      const handler = changes[change];
      if (handler === undefined) throw new AdminActionError('There is no such change.');
      return handler(form, actor);
    },
    preview: (kind, form): PolicyPreview => {
      const document =
        kind === 'client'
          ? withConsoleIds(jsonDocument(form, 'policy'))
          : jsonDocument(form, 'policy');
      let candidate: Parameters<typeof effective>[0];
      let title: string;
      if (kind === 'global') {
        const validation = validateGlobalPolicy(document);
        if (!validation.ok)
          throw new AdminActionError(`The policy is invalid:\n${validation.errors}`);
        candidate = { global: validation.document };
        title = 'the global policy';
      } else if (kind === 'console') {
        const view = consoleOf(form);
        candidate = { console: consoles.validatePolicy(view.id, document) };
        title = `the policy of console "${view.alias}"`;
      } else {
        const view = clientOf(form);
        candidate = { client: clients.validatePolicy(view.clientId, document) };
        title = `the policy of client "${view.clientId}"`;
      }
      const before = effective({});
      const after = effective(candidate);
      return {
        title,
        clients: [...before.keys()].sort().map((clientId) => {
          const was = before.get(clientId) ?? new Set<string>();
          const will = after.get(clientId) ?? new Set<string>();
          return {
            clientId,
            before: was.size,
            after: will.size,
            gained: [...will].filter((id) => !was.has(id)).sort(),
            lost: [...was].filter((id) => !will.has(id)).sort(),
          };
        }),
      };
    },
  };
}
