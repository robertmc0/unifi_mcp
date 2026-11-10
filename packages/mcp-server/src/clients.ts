/**
 * MCP clients and bearer tokens (spec §7.1, §2 decisions 06, 25; ADR 0013).
 *
 * - One identity per client, each with its own revocable token. A token is
 *   `umcp_<token id>_<secret>`: 12 hex characters of public token id and 256 bits of
 *   random secret (base64url). It is shown once at creation or rotation.
 * - Only the token id and SHA-256 of the secret are stored. Verification looks the id up
 *   and compares digests in constant time, then checks token revocation and expiry and
 *   the client's own status and expiry.
 * - The client policy (ADR 0009) is stored with the client; every change is audited in
 *   the same transaction and bumps the policy version.
 * - Revocation notifies listeners (the HTTP layer closes the client's open streams and the
 *   dispatcher cancels its queued work).
 * - Only an administrator, the CLI or the system can manage clients, never an MCP client.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  bumpPolicyVersion,
  ClientPolicySchema,
  describeValidationError,
  type ClientPolicy,
  type PolicyActor,
} from '@unifi-local-mcp/policy';
import {
  columnOptionalText,
  columnText,
  type Row,
  type SqliteDatabase,
} from '@unifi-local-mcp/storage';
import type { AuditLog } from '@unifi-local-mcp/telemetry';

export type ClientErrorCode =
  'client_invalid' | 'client_exists' | 'client_not_found' | 'client_actor_forbidden';

export class ClientError extends Error {
  override readonly name = 'ClientError';
  readonly code: ClientErrorCode;

  constructor(code: ClientErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface ClientView {
  clientId: string;
  description: string | null;
  policy: ClientPolicy | null;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  tokens: {
    tokenId: string;
    createdAt: string;
    expiresAt: string | null;
    revokedAt: string | null;
    lastUsedAt: string | null;
  }[];
}

export interface IssuedToken {
  client: ClientView;
  /** Plaintext bearer token. Shown once; never stored or logged. */
  token: string;
  tokenId: string;
}

export interface AuthenticatedClient {
  clientId: string;
  tokenId: string;
}

const CLIENT_ID = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const TOKEN = /^umcp_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;
const LAST_USED_INTERVAL_MS = 60_000;

function digest(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

function assertActor(actor: PolicyActor): void {
  if (!['admin', 'cli', 'system'].includes((actor as { type: string }).type)) {
    throw new ClientError(
      'client_actor_forbidden',
      'MCP clients can only be managed by an administrator, the CLI or the system.',
    );
  }
}

export interface ClientStoreOptions {
  db: SqliteDatabase;
  audit: AuditLog;
  now?: () => Date;
}

export class ClientStore {
  readonly #db: SqliteDatabase;
  readonly #audit: AuditLog;
  readonly #now: () => Date;
  readonly #revocationListeners = new Set<(clientId: string) => void>();

  constructor(options: ClientStoreOptions) {
    if (!options.audit.writesTo(options.db)) {
      throw new TypeError('ClientStore needs its AuditLog on its connection.');
    }
    this.#db = options.db;
    this.#audit = options.audit;
    this.#now = options.now ?? (() => new Date());
  }

  /** Called with the client id whenever a client or its tokens are revoked or disabled. */
  onRevocation(listener: (clientId: string) => void): () => void {
    this.#revocationListeners.add(listener);
    return () => this.#revocationListeners.delete(listener);
  }

  /** Creates a client with no grants (unless given) and issues its first token. */
  create(
    input: { clientId: string; description?: string; policy?: unknown; tokenExpiresAt?: Date },
    actor: PolicyActor,
  ): IssuedToken {
    assertActor(actor);
    const clientId = input.clientId.trim();
    if (!CLIENT_ID.test(clientId)) {
      throw new ClientError(
        'client_invalid',
        'The client id must be 1–64 lowercase letters, digits, ".", "_" or "-".',
      );
    }
    const policy = this.#validatePolicy(clientId, input.policy ?? {});
    return this.#db.transaction(() => {
      if (this.#db.get('SELECT 1 AS x FROM clients WHERE id = ?', [clientId]) !== undefined) {
        throw new ClientError('client_exists', `A client "${clientId}" already exists.`);
      }
      const timestamp = this.#now().toISOString();
      this.#db.run(
        'INSERT INTO clients (id, description, policy, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        [
          clientId,
          input.description?.trim().slice(0, 500) ?? null,
          JSON.stringify(policy),
          timestamp,
          timestamp,
        ],
      );
      const issued = this.#issue(clientId, input.tokenExpiresAt);
      this.#record(actor, 'client.create', clientId, { issued: issued.tokenId });
      bumpPolicyVersion(this.#db, actor, this.#now);
      return { ...issued, client: this.#require(clientId) };
    });
  }

  /** Issues a new token and revokes every earlier token of the client. */
  rotate(clientId: string, actor: PolicyActor, tokenExpiresAt?: Date): IssuedToken {
    assertActor(actor);
    const issued = this.#db.transaction(() => {
      this.#require(clientId);
      const revoked = this.#revokeTokens(clientId);
      const next = this.#issue(clientId, tokenExpiresAt);
      this.#record(actor, 'client.rotate_token', clientId, {
        issued: next.tokenId,
        revokedCount: revoked,
      });
      return { ...next, client: this.#require(clientId) };
    });
    this.#notifyRevocation(clientId);
    return issued;
  }

  /** Revokes the client: status `revoked` and every token revoked. Takes effect immediately. */
  revoke(clientId: string, actor: PolicyActor): ClientView {
    assertActor(actor);
    const view = this.#db.transaction(() => {
      const current = this.#require(clientId);
      const policy = {
        ...(current.policy ?? ClientPolicySchema.parse({ clientId })),
        status: 'revoked' as const,
      };
      this.#writePolicy(clientId, policy);
      const revoked = this.#revokeTokens(clientId);
      this.#record(actor, 'client.revoke', clientId, { revokedCount: revoked });
      bumpPolicyVersion(this.#db, actor, this.#now);
      return this.#require(clientId);
    });
    this.#notifyRevocation(clientId);
    return view;
  }

  /** Replaces the client's policy (status, expiry, consoles, grants, sensitive grants). */
  setPolicy(clientId: string, input: unknown, actor: PolicyActor): ClientView {
    assertActor(actor);
    const policy = this.#validatePolicy(clientId, input);
    const view = this.#db.transaction(() => {
      this.#require(clientId);
      this.#writePolicy(clientId, policy);
      this.#record(actor, 'client.policy_update', clientId, {
        status: policy.status,
        consoles: Object.keys(policy.consoles).length,
        allow: policy.allow.length,
        deny: policy.deny.length,
        sensitive: policy.sensitive,
      });
      bumpPolicyVersion(this.#db, actor, this.#now);
      return this.#require(clientId);
    });
    if (policy.status !== 'active') this.#notifyRevocation(clientId);
    return view;
  }

  /** Deletes the client and its tokens. Its audit history is kept. */
  remove(clientId: string, actor: PolicyActor): void {
    assertActor(actor);
    this.#db.transaction(() => {
      this.#require(clientId);
      this.#db.run('DELETE FROM client_tokens WHERE client_id = ?', [clientId]);
      this.#db.run('DELETE FROM clients WHERE id = ?', [clientId]);
      this.#record(actor, 'client.remove', clientId, {});
      bumpPolicyVersion(this.#db, actor, this.#now);
    });
    this.#notifyRevocation(clientId);
  }

  /**
   * Verifies a bearer token. Returns the identity, or undefined for any failure (unknown,
   * malformed, wrong secret, revoked, expired, or an inactive or expired client). Callers
   * must not tell the requester which.
   */
  authenticate(token: string): AuthenticatedClient | undefined {
    const match = TOKEN.exec(token);
    const tokenId = match?.[1];
    const secret = match?.[2];
    // Always compute a digest, so malformed and unknown tokens cost the same as known ones.
    const presented = digest(secret ?? token);
    const row =
      tokenId === undefined
        ? undefined
        : this.#db.get('SELECT * FROM client_tokens WHERE token_id = ?', [tokenId]);
    const stored = Buffer.from(
      row === undefined ? '0'.repeat(64) : columnText(row, 'secret_sha256'),
      'hex',
    );
    const matches = timingSafeEqual(presented, stored);
    if (row === undefined || tokenId === undefined || !matches) return undefined;
    const now = this.#now();
    if (columnOptionalText(row, 'revoked_at') !== null) return undefined;
    const expiresAt = columnOptionalText(row, 'expires_at');
    if (expiresAt !== null && Date.parse(expiresAt) <= now.getTime()) return undefined;
    const clientId = columnText(row, 'client_id');
    const policy = this.policy(clientId);
    if (policy?.status !== 'active') return undefined;
    if (policy.expiresAt !== undefined && Date.parse(policy.expiresAt) <= now.getTime()) {
      return undefined;
    }
    this.#touch(clientId, tokenId, columnOptionalText(row, 'last_used_at'), now);
    return { clientId, tokenId };
  }

  /** True while the token is still valid; used to re-check long-lived streams. */
  isTokenActive(tokenId: string): boolean {
    const row = this.#db.get('SELECT * FROM client_tokens WHERE token_id = ?', [tokenId]);
    if (row === undefined || columnOptionalText(row, 'revoked_at') !== null) return false;
    const expiresAt = columnOptionalText(row, 'expires_at');
    if (expiresAt !== null && Date.parse(expiresAt) <= this.#now().getTime()) return false;
    return this.policy(columnText(row, 'client_id'))?.status === 'active';
  }

  /** The validated client policy, or undefined (deny) if missing or invalid. */
  policy(clientId: string): ClientPolicy | undefined {
    const row = this.#db.get('SELECT policy FROM clients WHERE id = ?', [clientId]);
    if (row === undefined) return undefined;
    try {
      const parsed = ClientPolicySchema.safeParse(JSON.parse(columnText(row, 'policy')));
      return parsed.success && parsed.data.clientId === clientId ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  get(clientId: string): ClientView | undefined {
    const row = this.#db.get('SELECT * FROM clients WHERE id = ?', [clientId]);
    return row === undefined ? undefined : this.#view(row);
  }

  list(): ClientView[] {
    return this.#db.all('SELECT * FROM clients ORDER BY id').map((row) => this.#view(row));
  }

  #issue(clientId: string, expiresAt: Date | undefined): { token: string; tokenId: string } {
    const tokenId = randomBytes(6).toString('hex');
    const secret = randomBytes(32).toString('base64url');
    this.#db.run(
      'INSERT INTO client_tokens (token_id, client_id, secret_sha256, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
      [
        tokenId,
        clientId,
        digest(secret).toString('hex'),
        this.#now().toISOString(),
        expiresAt?.toISOString() ?? null,
      ],
    );
    return { token: `umcp_${tokenId}_${secret}`, tokenId };
  }

  #revokeTokens(clientId: string): number {
    return this.#db.run(
      'UPDATE client_tokens SET revoked_at = ? WHERE client_id = ? AND revoked_at IS NULL',
      [this.#now().toISOString(), clientId],
    ).changes;
  }

  #validatePolicy(clientId: string, input: unknown): ClientPolicy {
    const candidate =
      typeof input === 'object' && input !== null ? { ...input, clientId } : { clientId };
    const parsed = ClientPolicySchema.safeParse(candidate);
    if (!parsed.success) {
      throw new ClientError(
        'client_invalid',
        `The client policy is invalid:\n${describeValidationError(parsed.error)}`,
      );
    }
    return parsed.data;
  }

  #writePolicy(clientId: string, policy: ClientPolicy): void {
    this.#db.run('UPDATE clients SET policy = ?, updated_at = ? WHERE id = ?', [
      JSON.stringify(policy),
      this.#now().toISOString(),
      clientId,
    ]);
  }

  /** Records last use at most once a minute, so authentication does not write every time. */
  #touch(clientId: string, tokenId: string, lastUsedAt: string | null, now: Date): void {
    if (lastUsedAt !== null && now.getTime() - Date.parse(lastUsedAt) < LAST_USED_INTERVAL_MS)
      return;
    const timestamp = now.toISOString();
    try {
      this.#db.transaction(() => {
        this.#db.run('UPDATE client_tokens SET last_used_at = ? WHERE token_id = ?', [
          timestamp,
          tokenId,
        ]);
        this.#db.run('UPDATE clients SET last_used_at = ? WHERE id = ?', [timestamp, clientId]);
      });
    } catch {
      // Last-use bookkeeping must never block authentication.
    }
  }

  #notifyRevocation(clientId: string): void {
    for (const listener of this.#revocationListeners) {
      try {
        listener(clientId);
      } catch {
        // A failing listener must not undo or hide the revocation.
      }
    }
  }

  #require(clientId: string): ClientView {
    const view = this.get(clientId);
    if (view === undefined) throw new ClientError('client_not_found', `No client "${clientId}".`);
    return view;
  }

  #view(row: Row): ClientView {
    const clientId = columnText(row, 'id');
    return {
      clientId,
      description: columnOptionalText(row, 'description'),
      policy: this.policy(clientId) ?? null,
      createdAt: columnText(row, 'created_at'),
      updatedAt: columnText(row, 'updated_at'),
      lastUsedAt: columnOptionalText(row, 'last_used_at'),
      tokens: this.#db
        .all('SELECT * FROM client_tokens WHERE client_id = ? ORDER BY created_at', [clientId])
        .map((token) => ({
          tokenId: columnText(token, 'token_id'),
          createdAt: columnText(token, 'created_at'),
          expiresAt: columnOptionalText(token, 'expires_at'),
          revokedAt: columnOptionalText(token, 'revoked_at'),
          lastUsedAt: columnOptionalText(token, 'last_used_at'),
        })),
    };
  }

  #record(
    actor: PolicyActor,
    action: string,
    clientId: string,
    details: Record<string, unknown>,
  ): void {
    this.#audit.record({
      eventType: 'admin.security',
      action,
      outcome: 'success',
      actor,
      details: { clientId, ...details },
    });
  }
}
