/**
 * The console registry (spec §4.2; ADR 0012).
 *
 * A console has a stable UUID, a unique alias, a host (name or IP; no scheme, path or
 * port), a TLS trust method, a console policy (ADR 0009) and, per module, an optional port
 * override, an encrypted credential and the last observed application version.
 *
 * - Credentials are write-only: they are stored as secret records and never appear in any
 *   view, log or audit entry.
 * - Every change is audited in the same transaction. Changes that affect authorisation
 *   (policy, TLS trust, removal) also bump the policy version, invalidating approvals.
 * - Configuration is changed by an administrator, the CLI or the system, never through MCP.
 */
import { randomUUID, X509Certificate } from 'node:crypto';
import { isIP } from 'node:net';
import { satisfies, type OperationDescriptor } from '@unifi-local-mcp/core';
import {
  bumpPolicyVersion,
  ConsolePolicySchema,
  describeValidationError,
  type Capability,
  type ConsolePolicy,
  type PolicyActor,
} from '@unifi-local-mcp/policy';
import {
  columnOptionalText,
  columnText,
  type Row,
  type SecretStore,
  type SecretValue,
  type SqliteDatabase,
} from '@unifi-local-mcp/storage';
import type { AuditEvent, AuditLog, Logger } from '@unifi-local-mcp/telemetry';
import {
  isModuleId,
  MODULE_ENDPOINTS,
  MODULE_IDS,
  type ModuleEndpoint,
  type ModuleId,
} from './modules.ts';
import type { TlsTrust } from './transport.ts';

export type ConsoleErrorCode =
  'console_invalid' | 'console_not_found' | 'console_alias_taken' | 'console_actor_forbidden';

export class ConsoleError extends Error {
  override readonly name = 'ConsoleError';
  readonly code: ConsoleErrorCode;

  constructor(code: ConsoleErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export type TlsTrustInput =
  | { mode: 'verify'; caPem?: string }
  | { mode: 'pinned'; pins: readonly string[] }
  | { mode: 'insecure' };

export interface ConsoleInput {
  alias: string;
  description?: string;
  host: string;
  tls: TlsTrustInput;
}

export interface ConsoleModuleView {
  moduleId: ModuleId;
  port: number;
  hasCredential: boolean;
  observedVersion: string | null;
  observedAt: string | null;
}

export interface ConsoleView {
  id: string;
  alias: string;
  description: string | null;
  host: string;
  tls: { mode: TlsTrust['mode']; customCa: boolean; pins: number };
  policy: ConsolePolicy | null;
  modules: ConsoleModuleView[];
  createdAt: string;
  updatedAt: string;
}

/** Everything the executor needs to call one module on one console. */
export interface ConsoleConnection {
  consoleId: string;
  moduleId: ModuleId;
  host: string;
  port: number;
  trust: TlsTrust;
  endpoint: ModuleEndpoint;
  credential: SecretValue | undefined;
}

const ALIAS = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const HOSTNAME =
  /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const PIN = /^(?:sha256\/)?([A-Za-z0-9+/]{43}=)$/;
const CREDENTIAL = /^[\x21-\x7e]{8,1024}$/;

function invalid(message: string): ConsoleError {
  return new ConsoleError('console_invalid', message);
}

function validateHost(host: string): string {
  const trimmed = host.trim();
  if (isIP(trimmed) !== 0 || HOSTNAME.test(trimmed)) return trimmed;
  throw invalid('The host must be a host name or an IP address, without scheme, path or port.');
}

function normaliseTls(input: TlsTrustInput): {
  mode: TlsTrust['mode'];
  caPem: string | null;
  pins: string[];
} {
  switch (input.mode) {
    case 'verify': {
      if (input.caPem === undefined) return { mode: 'verify', caPem: null, pins: [] };
      try {
        new X509Certificate(input.caPem);
      } catch {
        throw invalid('The CA certificate is not a valid PEM certificate.');
      }
      return { mode: 'verify', caPem: input.caPem, pins: [] };
    }
    case 'pinned': {
      const pins = input.pins.map((pin) => PIN.exec(pin.trim())?.[1]);
      if (pins.length === 0 || pins.length > 10 || pins.some((pin) => pin === undefined)) {
        throw invalid('Pins must be 1–10 base64 SHA-256 SPKI hashes (sha256/… or 44 characters).');
      }
      return { mode: 'pinned', caPem: null, pins: pins as string[] };
    }
    case 'insecure':
      return { mode: 'insecure', caPem: null, pins: [] };
    default:
      throw invalid('Unknown TLS mode.');
  }
}

function assertActor(actor: PolicyActor): void {
  if (!['admin', 'cli', 'system'].includes((actor as { type: string }).type)) {
    throw new ConsoleError(
      'console_actor_forbidden',
      'Consoles can only be configured by an administrator, the CLI or the system.',
    );
  }
}

export interface ConsoleRegistryOptions {
  db: SqliteDatabase;
  audit: AuditLog;
  secrets: SecretStore;
  logger: Logger;
  now?: () => Date;
}

export class ConsoleRegistry {
  readonly #db: SqliteDatabase;
  readonly #audit: AuditLog;
  readonly #secrets: SecretStore;
  readonly #logger: Logger;
  readonly #now: () => Date;

  constructor(options: ConsoleRegistryOptions) {
    if (!options.audit.writesTo(options.db) || !options.secrets.writesTo(options.db)) {
      throw new TypeError('ConsoleRegistry needs its AuditLog and SecretStore on its connection.');
    }
    this.#db = options.db;
    this.#audit = options.audit;
    this.#secrets = options.secrets;
    this.#logger = options.logger;
    this.#now = options.now ?? (() => new Date());
  }

  /** Adds a console. Its policy starts with no modules enabled. */
  add(input: ConsoleInput, actor: PolicyActor): ConsoleView {
    assertActor(actor);
    const alias = input.alias.trim();
    if (!ALIAS.test(alias)) {
      throw invalid('The alias must be 1–63 lowercase letters, digits or hyphens.');
    }
    const host = validateHost(input.host);
    const tls = normaliseTls(input.tls);
    const description = input.description?.trim().slice(0, 500) ?? null;
    const id = randomUUID();
    const policy = ConsolePolicySchema.parse({ consoleId: id });
    const timestamp = this.#now().toISOString();
    return this.#db.transaction(() => {
      if (this.#db.get('SELECT 1 AS x FROM consoles WHERE alias = ?', [alias]) !== undefined) {
        throw new ConsoleError('console_alias_taken', `A console with alias "${alias}" exists.`);
      }
      this.#db.run(
        'INSERT INTO consoles (id, alias, description, host, tls_mode, tls_ca_pem, tls_pins, ' +
          'policy, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          id,
          alias,
          description,
          host,
          tls.mode,
          tls.caPem,
          JSON.stringify(tls.pins),
          JSON.stringify(policy),
          timestamp,
          timestamp,
        ],
      );
      this.#record(actor, 'console.add', id, { alias, tlsMode: tls.mode });
      bumpPolicyVersion(this.#db, actor, this.#now);
      this.#warnIfInsecure(id, tls.mode);
      return this.#require(id);
    });
  }

  /** Changes the host and/or description. A host change affects where credentials go. */
  updateDetails(
    consoleId: string,
    changes: { host?: string; description?: string | null },
    actor: PolicyActor,
  ): ConsoleView {
    assertActor(actor);
    const host = changes.host === undefined ? undefined : validateHost(changes.host);
    return this.#db.transaction(() => {
      const current = this.#require(consoleId);
      const description =
        changes.description === undefined
          ? current.description
          : (changes.description?.trim().slice(0, 500) ?? null);
      this.#db.run('UPDATE consoles SET host = ?, description = ?, updated_at = ? WHERE id = ?', [
        host ?? current.host,
        description,
        this.#now().toISOString(),
        consoleId,
      ]);
      this.#record(actor, 'console.update', consoleId, {
        hostChanged: host !== undefined && host !== current.host,
      });
      if (host !== undefined && host !== current.host)
        bumpPolicyVersion(this.#db, actor, this.#now);
      return this.#require(consoleId);
    });
  }

  /** Replaces the console policy (state, sites, rules and module states). */
  /** Validates a console policy exactly as `setPolicy` does, without storing it. */
  validatePolicy(consoleId: string, input: unknown): ConsolePolicy {
    const candidate =
      typeof input === 'object' && input !== null ? { ...input, consoleId } : { consoleId };
    const parsed = ConsolePolicySchema.safeParse(candidate);
    if (!parsed.success)
      throw invalid(`The console policy is invalid:\n${describeValidationError(parsed.error)}`);
    const unknownModules = Object.keys(parsed.data.modules).filter((id) => !isModuleId(id));
    if (unknownModules.length > 0) throw invalid(`Unknown modules: ${unknownModules.join(', ')}.`);
    return parsed.data;
  }

  setPolicy(consoleId: string, input: unknown, actor: PolicyActor): ConsoleView {
    assertActor(actor);
    const policy = this.validatePolicy(consoleId, input);
    return this.#db.transaction(() => {
      this.#require(consoleId);
      this.#db.run('UPDATE consoles SET policy = ?, updated_at = ? WHERE id = ?', [
        JSON.stringify(policy),
        this.#now().toISOString(),
        consoleId,
      ]);
      this.#record(actor, 'console.policy_update', consoleId, {
        state: policy.state,
        modules: Object.fromEntries(Object.entries(policy.modules).map(([id, m]) => [id, m.state])),
      });
      bumpPolicyVersion(this.#db, actor, this.#now);
      return this.#require(consoleId);
    });
  }

  setTls(consoleId: string, input: TlsTrustInput, actor: PolicyActor): ConsoleView {
    assertActor(actor);
    const tls = normaliseTls(input);
    return this.#db.transaction(() => {
      this.#require(consoleId);
      this.#db.run(
        'UPDATE consoles SET tls_mode = ?, tls_ca_pem = ?, tls_pins = ?, updated_at = ? WHERE id = ?',
        [tls.mode, tls.caPem, JSON.stringify(tls.pins), this.#now().toISOString(), consoleId],
      );
      this.#record(actor, 'console.tls_update', consoleId, {
        tlsMode: tls.mode,
        pins: tls.pins.length,
      });
      bumpPolicyVersion(this.#db, actor, this.#now);
      this.#warnIfInsecure(consoleId, tls.mode);
      return this.#require(consoleId);
    });
  }

  /** Sets a module's port override (null for the default). */
  setModulePort(
    consoleId: string,
    moduleId: ModuleId,
    port: number | null,
    actor: PolicyActor,
  ): ConsoleView {
    assertActor(actor);
    if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) {
      throw invalid('The port must be an integer from 1 to 65535.');
    }
    return this.#db.transaction(() => {
      this.#require(consoleId);
      this.#ensureModuleRow(consoleId, moduleId);
      this.#db.run('UPDATE console_modules SET port = ? WHERE console_id = ? AND module_id = ?', [
        port,
        consoleId,
        moduleId,
      ]);
      this.#record(actor, 'console.module_port_update', consoleId, { moduleId, port });
      return this.#require(consoleId);
    });
  }

  /** Stores or replaces a module credential. The value is write-only. */
  setCredential(
    consoleId: string,
    moduleId: ModuleId,
    value: string,
    actor: PolicyActor,
  ): ConsoleView {
    assertActor(actor);
    if (!CREDENTIAL.test(value)) {
      throw invalid('The credential must be 8–1024 printable characters without spaces.');
    }
    const kind = MODULE_ENDPOINTS[moduleId].credentialKind;
    return this.#db.transaction(() => {
      this.#require(consoleId);
      this.#ensureModuleRow(consoleId, moduleId);
      const existing = this.#moduleRow(consoleId, moduleId);
      const secretId =
        existing === undefined ? null : columnOptionalText(existing, 'credential_secret_id');
      if (secretId === null) {
        const created = this.#secrets.create(kind, value);
        this.#db.run(
          'UPDATE console_modules SET credential_secret_id = ? WHERE console_id = ? AND module_id = ?',
          [created, consoleId, moduleId],
        );
      } else {
        this.#secrets.replace(secretId, kind, value);
      }
      this.#record(actor, 'console.credential_set', consoleId, {
        moduleId,
        replaced: secretId !== null,
      });
      return this.#require(consoleId);
    });
  }

  /** Removes a console, its module settings and its credentials. */
  remove(consoleId: string, actor: PolicyActor): void {
    assertActor(actor);
    this.#db.transaction(() => {
      this.#require(consoleId);
      const secretIds = this.#db
        .all(
          'SELECT credential_secret_id AS s FROM console_modules WHERE console_id = ? AND credential_secret_id IS NOT NULL',
          [consoleId],
        )
        .map((row) => columnText(row, 's'));
      this.#db.run('DELETE FROM console_modules WHERE console_id = ?', [consoleId]);
      for (const id of secretIds) this.#secrets.delete(id);
      this.#db.run('DELETE FROM consoles WHERE id = ?', [consoleId]);
      this.#record(actor, 'console.remove', consoleId, { modulesWithStoredKeys: secretIds.length });
      bumpPolicyVersion(this.#db, actor, this.#now);
    });
  }

  /** Records the application version reported by a capability probe. */
  recordObservedVersion(consoleId: string, moduleId: ModuleId, version: string): void {
    this.#db.transaction(() => {
      this.#require(consoleId);
      this.#ensureModuleRow(consoleId, moduleId);
      this.#db.run(
        'UPDATE console_modules SET observed_version = ?, observed_at = ? WHERE console_id = ? AND module_id = ?',
        [version.slice(0, 64), this.#now().toISOString(), consoleId, moduleId],
      );
      this.#record({ type: 'system' }, 'console.version_observed', consoleId, {
        moduleId,
        version: version.slice(0, 64),
      });
    });
  }

  get(idOrAlias: string): ConsoleView | undefined {
    const row = this.#db.get('SELECT * FROM consoles WHERE id = ? OR alias = ?', [
      idOrAlias,
      idOrAlias,
    ]);
    return row === undefined ? undefined : this.#view(row);
  }

  list(): ConsoleView[] {
    return this.#db.all('SELECT * FROM consoles ORDER BY alias').map((row) => this.#view(row));
  }

  /** The validated console policy, or undefined (deny) if missing or invalid. */
  policy(consoleId: string): ConsolePolicy | undefined {
    const row = this.#db.get('SELECT policy FROM consoles WHERE id = ?', [consoleId]);
    return row === undefined ? undefined : this.#parsePolicy(consoleId, columnText(row, 'policy'));
  }

  /** The application version a probe last reported for a module, if any. */
  observedVersion(consoleId: string, moduleId: string): string | undefined {
    if (!isModuleId(moduleId)) return undefined;
    const row = this.#moduleRow(consoleId, moduleId);
    return (row === undefined ? null : columnOptionalText(row, 'observed_version')) ?? undefined;
  }

  /** Supported only when the probed version satisfies the operation's version range. */
  capability(
    consoleId: string,
    descriptor: Pick<OperationDescriptor, 'moduleId' | 'apiVersionRange'>,
  ): Capability {
    if (!isModuleId(descriptor.moduleId)) return 'unsupported';
    const row = this.#moduleRow(consoleId, descriptor.moduleId);
    const observed = row === undefined ? null : columnOptionalText(row, 'observed_version');
    if (observed === null) return 'unknown';
    return satisfies(observed, descriptor.apiVersionRange) ? 'supported' : 'unsupported';
  }

  connection(consoleId: string, moduleId: string): ConsoleConnection | undefined {
    if (!isModuleId(moduleId)) return undefined;
    const row = this.#db.get('SELECT * FROM consoles WHERE id = ?', [consoleId]);
    if (row === undefined) return undefined;
    const endpoint = MODULE_ENDPOINTS[moduleId];
    const moduleRow = this.#moduleRow(consoleId, moduleId);
    const secretId =
      moduleRow === undefined ? null : columnOptionalText(moduleRow, 'credential_secret_id');
    const port = moduleRow?.['port'];
    return {
      consoleId,
      moduleId,
      host: columnText(row, 'host'),
      port: typeof port === 'number' ? port : endpoint.defaultPort,
      trust: this.#trust(row),
      endpoint,
      credential:
        secretId === null ? undefined : this.#secrets.read(secretId, endpoint.credentialKind),
    };
  }

  #trust(row: Row): TlsTrust {
    const mode = columnText(row, 'tls_mode') as TlsTrust['mode'];
    if (mode === 'pinned')
      return { mode, spkiSha256: JSON.parse(columnText(row, 'tls_pins')) as string[] };
    if (mode === 'insecure') return { mode };
    const caPem = columnOptionalText(row, 'tls_ca_pem');
    return caPem === null ? { mode: 'verify' } : { mode: 'verify', caPem };
  }

  #parsePolicy(consoleId: string, json: string): ConsolePolicy | undefined {
    try {
      const parsed = ConsolePolicySchema.safeParse(JSON.parse(json));
      if (parsed.success && parsed.data.consoleId === consoleId) return parsed.data;
    } catch {
      // fall through
    }
    this.#logger.error('stored console policy is invalid; the console is unavailable', {
      consoleId,
    });
    return undefined;
  }

  #view(row: Row): ConsoleView {
    const id = columnText(row, 'id');
    const trust = this.#trust(row);
    return {
      id,
      alias: columnText(row, 'alias'),
      description: columnOptionalText(row, 'description'),
      host: columnText(row, 'host'),
      tls: {
        mode: trust.mode,
        customCa: trust.mode === 'verify' && trust.caPem !== undefined,
        pins: trust.mode === 'pinned' ? trust.spkiSha256.length : 0,
      },
      policy: this.#parsePolicy(id, columnText(row, 'policy')) ?? null,
      modules: MODULE_IDS.flatMap((moduleId) => {
        const moduleRow = this.#moduleRow(id, moduleId);
        if (moduleRow === undefined) return [];
        const port = moduleRow['port'];
        return [
          {
            moduleId,
            port: typeof port === 'number' ? port : MODULE_ENDPOINTS[moduleId].defaultPort,
            hasCredential: columnOptionalText(moduleRow, 'credential_secret_id') !== null,
            observedVersion: columnOptionalText(moduleRow, 'observed_version'),
            observedAt: columnOptionalText(moduleRow, 'observed_at'),
          },
        ];
      }),
      createdAt: columnText(row, 'created_at'),
      updatedAt: columnText(row, 'updated_at'),
    };
  }

  #require(consoleId: string): ConsoleView {
    const row = this.#db.get('SELECT * FROM consoles WHERE id = ?', [consoleId]);
    if (row === undefined) throw new ConsoleError('console_not_found', 'No console has this id.');
    return this.#view(row);
  }

  #moduleRow(consoleId: string, moduleId: ModuleId): Row | undefined {
    return this.#db.get('SELECT * FROM console_modules WHERE console_id = ? AND module_id = ?', [
      consoleId,
      moduleId,
    ]);
  }

  #ensureModuleRow(consoleId: string, moduleId: ModuleId): void {
    this.#db.run('INSERT OR IGNORE INTO console_modules (console_id, module_id) VALUES (?, ?)', [
      consoleId,
      moduleId,
    ]);
  }

  #warnIfInsecure(consoleId: string, mode: TlsTrust['mode']): void {
    if (mode === 'insecure') {
      this.#logger.warn(
        'TLS verification is DISABLED for this console (explicit insecure override)',
        { consoleId },
      );
    }
  }

  #record(
    actor: PolicyActor,
    action: string,
    consoleId: string,
    details: Record<string, unknown>,
  ): void {
    const event: AuditEvent = {
      eventType: 'admin.security',
      action,
      outcome: 'success',
      actor,
      consoleId,
      details,
    };
    this.#audit.record(event);
  }
}
