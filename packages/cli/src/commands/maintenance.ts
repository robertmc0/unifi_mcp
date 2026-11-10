/**
 * `crypto …` and `db …` commands (spec §13.2, §8.2; ADR 0007).
 */
import { join } from 'node:path';
import { loadServiceConfig } from '@unifi-local-mcp/mcp-server';
import {
  acquireInstanceLock,
  backupDatabase,
  BACKUP_DIRECTORY_NAME,
  openStorage,
  readActiveKeyId,
  readMasterKeyFile,
  readSchemaState,
  restoreDatabase,
  rotateMasterKey,
  SecretStore,
  SqliteDatabase,
  verifyBackup,
  writeNewMasterKeyFile,
} from '@unifi-local-mcp/storage';
import { AuditLog } from '@unifi-local-mcp/telemetry';
import { requireString, string, type Command } from '../cli.ts';
import { cliActor, cliLogger, loadKey } from '../context.ts';
import { confirm } from './shared.ts';

/**
 * Runs `fn` while holding the data-directory lock, so it cannot run beside the service or
 * another such command (ADR 0015).
 */
async function exclusive<T>(dataDir: string, purpose: string, fn: () => Promise<T>): Promise<T> {
  const lock = acquireInstanceLock(dataDir, purpose);
  try {
    return await fn();
  } finally {
    lock.release();
  }
}

function stamp(): string {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

export const cryptoCommands: Record<string, Command> = {
  'generate-key': {
    summary: 'Write a new random master key file (mode 0400; refuses to overwrite)',
    usage: '--out <path>',
    options: { out: { type: 'string' } },
    run: async (ctx) => {
      const path = requireString(ctx.values, 'out');
      const { keyId } = await writeNewMasterKeyFile(path);
      ctx.print({ path, keyId }, () => [
        `Master key written to ${path} (key id ${keyId}).`,
        'Back it up separately from database backups. Never generate a new key for an existing database.',
      ]);
      return 0;
    },
  },
  'key-id': {
    summary: 'Show the identifier of a master key file',
    usage: '--file <path>',
    options: { file: { type: 'string' } },
    run: async (ctx) => {
      const loaded = await readMasterKeyFile(requireString(ctx.values, 'file'));
      for (const warning of loaded.warnings) ctx.io.err(`warning: ${warning}`);
      ctx.print({ keyId: loaded.key.id }, () => [loaded.key.id]);
      return 0;
    },
  },
  'rotate-key': {
    summary: 'Re-encrypt all stored credentials with a new master key (stop the service first)',
    usage: '--new-key-file <path> [--yes]',
    options: { 'new-key-file': { type: 'string' }, yes: { type: 'boolean' } },
    run: async (ctx) => {
      const services = await ctx.services();
      // A running service would keep using the old key, so it must be stopped.
      return exclusive(services.config.dataDir, 'rotate the master key', async () => {
        const next = await readMasterKeyFile(requireString(ctx.values, 'new-key-file'));
        await confirm(
          ctx.io,
          `Re-encrypt all credentials from key ${services.masterKey.id} to ${next.key.id}`,
          'rotate',
          ctx.values['yes'] === true,
        );
        const backup = await backupDatabase(
          services.storage.db,
          join(services.config.dataDir, BACKUP_DIRECTORY_NAME, `pre-rotation-${stamp()}.db`),
        );
        // The rotation and its audit entry commit together, or neither does.
        const result = services.storage.db.transaction(() => {
          const rotated = rotateMasterKey(services.storage.db, services.masterKey, next.key);
          services.audit.record({
            eventType: 'admin.security',
            action: 'crypto.rotate_key',
            outcome: 'success',
            actor: services.actor,
            details: { ...rotated, backup: backup.path },
          });
          return rotated;
        });
        ctx.print({ ...result, backup: backup.path }, () => [
          `Re-encrypted ${String(result.reencrypted)} record(s) with key ${result.newKeyId}.`,
          `Backup taken first (needs the OLD key): ${backup.path}`,
          'Now point UNIFI_MCP_MASTER_KEY_FILE at the new key file and start the service.',
          'Keep the old key as long as you keep backups made with it.',
        ]);
        return 0;
      });
    },
  },
};

export const dbCommands: Record<string, Command> = {
  backup: {
    summary: 'Write a verified online backup (safe while the service runs)',
    usage: '[--out <path>]',
    options: { out: { type: 'string' } },
    run: async (ctx) => {
      const services = await ctx.services();
      const path =
        string(ctx.values, 'out') ??
        join(services.config.dataDir, BACKUP_DIRECTORY_NAME, `manual-${stamp()}.db`);
      const result = await backupDatabase(services.storage.db, path);
      services.audit.record({
        eventType: 'system',
        action: 'db.backup',
        outcome: 'success',
        actor: services.actor,
        details: { path: result.path, sha256: result.sha256, bytes: result.bytes },
      });
      ctx.print(result, () => [
        `Backup written: ${result.path}`,
        `  sha256 ${result.sha256}, ${String(result.bytes)} bytes, schema v${String(result.schemaVersion)}`,
        `  restoring its credentials needs master key ${result.keyId ?? '(none yet)'}`,
      ]);
      return 0;
    },
  },
  check: {
    summary: 'Check the live database, or a backup with --backup, without changing it',
    usage: '[--backup <file>]',
    options: { backup: { type: 'string' } },
    run: async (ctx) => {
      const key = await loadKey(ctx.env, ctx.io);
      const backup = string(ctx.values, 'backup');
      if (backup !== undefined) {
        const result = await verifyBackup(backup, key);
        ctx.print(result, () => [
          `The backup is valid: schema v${String(result.schemaVersion)}, ${String(result.secretRecords)} encrypted record(s), key ${result.keyId}.`,
          ...(result.pendingMigrations > 0
            ? [`It will be upgraded by ${String(result.pendingMigrations)} migration(s) on start.`]
            : []),
        ]);
        return 0;
      }
      const config = loadServiceConfig(ctx.env);
      const db = SqliteDatabase.open(config.databasePath, { readOnly: true });
      try {
        const integrity = db.integrityCheck('full');
        const state = readSchemaState(db);
        const activeKey = state.version >= 1 ? readActiveKeyId(db) : undefined;
        const keyMatches = activeKey === key.id;
        const secrets = keyMatches ? new SecretStore(db, key).verifyAll() : 0;
        const chain =
          state.version >= 2
            ? new AuditLog(db, { logger: cliLogger(ctx.io) }).verifyChain()
            : undefined;
        const ok = integrity.ok && keyMatches && chain?.ok !== false;
        const report = {
          ok,
          integrity,
          schemaVersion: state.version,
          activeKey,
          keyMatches,
          secretRecords: secrets,
          auditChain: chain,
        };
        ctx.print(report, () => [
          `Integrity:    ${integrity.ok ? 'ok' : `FAILED: ${integrity.problems.slice(0, 5).join('; ')}`}`,
          `Schema:       v${String(state.version)}`,
          `Master key:   ${keyMatches ? `matches (${key.id})` : `MISMATCH (database uses ${activeKey ?? 'none'}, configured ${key.id})`}`,
          `Credentials:  ${keyMatches ? `${String(secrets)} record(s) decrypt` : 'not checked'}`,
          `Audit chain:  ${chain === undefined ? '-' : chain.ok ? `intact (${String(chain.entriesChecked)} entries)` : `BROKEN at entry ${String(chain.firstInvalidSeq)}`}`,
        ]);
        return ok ? 0 : 1;
      } finally {
        db.close();
      }
    },
  },
  restore: {
    summary: 'Replace the database with a validated backup (stop the service first)',
    usage: '<backup-file> [--yes]',
    options: { yes: { type: 'boolean' } },
    args: { min: 1, max: 1 },
    run: async (ctx) => {
      const backupPath = ctx.positionals[0] ?? '';
      const key = await loadKey(ctx.env, ctx.io);
      const config = loadServiceConfig(ctx.env);
      return exclusive(config.dataDir, 'restore the database', async () => {
        await confirm(
          ctx.io,
          `Replace ${config.databasePath} with ${backupPath}`,
          'restore',
          ctx.values['yes'] === true,
        );
        const result = await restoreDatabase({
          backupPath,
          databasePath: config.databasePath,
          masterKey: key,
        });
        // Record the restore in the restored database's own audit trail. Opening it also
        // upgrades an older backup (after writing a pre-migration backup).
        const restored = await openStorage({ databasePath: config.databasePath, masterKey: key });
        try {
          new AuditLog(restored.db, { logger: cliLogger(ctx.io) }).record({
            eventType: 'admin.security',
            action: 'db.restore',
            outcome: 'success',
            actor: cliActor(),
            details: { from: backupPath, previous: result.previousDatabasePath ?? null },
          });
        } finally {
          restored.close();
        }
        ctx.print(result, () => [
          `Restored ${backupPath} (schema v${String(result.schemaVersion)}, ${String(result.secretRecords)} encrypted record(s)).`,
          ...(result.previousDatabasePath === undefined
            ? []
            : [`The previous database was kept as ${result.previousDatabasePath}.`]),
          'Start the service again.',
        ]);
        return 0;
      });
    },
  },
};
