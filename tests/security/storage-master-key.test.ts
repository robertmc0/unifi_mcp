/**
 * Release-blocking invariants (spec §17 Security, §8.2; Phase 1 gate):
 *
 * - The master key is never stored in the database.
 * - A missing or wrong master key fails closed with an actionable error, and changes
 *   nothing on disk.
 * - No code path silently generates or adopts a new key for an existing database.
 * - Key material and plaintext secrets never appear in errors, logs or the database file.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { inspect } from 'node:util';
import {
  columnInteger,
  columnText,
  databasePathFor,
  loadMasterKey,
  MASTER_KEY_ENV,
  MASTER_KEY_FILE_ENV,
  MasterKey,
  MIGRATIONS,
  openStorage,
  readSchemaState,
  SqliteDatabase,
  writeNewMasterKeyFile,
  type Migration,
} from '@unifi-local-mcp/storage';
import { describe, expect, it } from 'vitest';
import {
  expectStorageErrorAsync,
  fileMode,
  testKey,
  testKeyBytes,
  testKeyText,
  useTempDirs,
  writeTextFile,
} from '../unit/storage/fixtures.ts';

const tempDir = useTempDirs();
const KIND = 'console.api_key';
const SENTINEL = 'synthetic-unifi-api-key-SENTINEL-7f3a';

describe('loading the master key', () => {
  it('fails closed when no key is configured', async () => {
    const error = await expectStorageErrorAsync(loadMasterKey({}), 'MASTER_KEY_NOT_CONFIGURED');
    expect(error.message).toContain(MASTER_KEY_FILE_ENV);
    expect(error.message).toMatch(/must provide the key it was created with/);
  });

  it('refuses ambiguous configuration', async () => {
    await expectStorageErrorAsync(
      loadMasterKey({ [MASTER_KEY_FILE_ENV]: '/run/secrets/key', [MASTER_KEY_ENV]: 'x' }),
      'MASTER_KEY_CONFLICTING_SOURCES',
    );
  });

  it('loads a key file such as `openssl rand -base64 32` produces', async () => {
    const path = join(await tempDir(), 'master.key');
    await writeTextFile(path, `${testKeyText('file')}\n`, 0o400);
    const loaded = await loadMasterKey({ [MASTER_KEY_FILE_ENV]: path });
    expect(loaded.source).toBe('file');
    expect(loaded.warnings).toEqual([]);
    expect(loaded.key.id).toBe(testKey('file').id);
  });

  it('warns when the key file is readable by other users', async () => {
    const path = join(await tempDir(), 'master.key');
    await writeTextFile(path, testKeyText('file'), 0o644);
    const loaded = await loadMasterKey({ [MASTER_KEY_FILE_ENV]: path });
    expect(loaded.warnings).toHaveLength(1);
    expect(loaded.warnings[0]).toMatch(/mode 0644/);
  });

  it('fails closed on a missing file or a directory', async () => {
    const dir = await tempDir();
    await expectStorageErrorAsync(
      loadMasterKey({ [MASTER_KEY_FILE_ENV]: join(dir, 'absent.key') }),
      'MASTER_KEY_UNREADABLE',
    );
    await expectStorageErrorAsync(
      loadMasterKey({ [MASTER_KEY_FILE_ENV]: dir }),
      'MASTER_KEY_UNREADABLE',
    );
  });

  it('rejects malformed, short, placeholder and oversized keys without echoing them', async () => {
    const dir = await tempDir();
    const cases: Record<string, string> = {
      text: 'not-a-key-SENTINEL-1234',
      short: Buffer.alloc(31, 7).toString('base64'),
      placeholder: Buffer.alloc(32, 0).toString('base64'),
      base64url: testKeyText('x').replace(/\+/g, '-').replace(/\//g, '_') + 'SENTINEL',
      oversized: `SENTINEL${'A'.repeat(5000)}`,
    };
    for (const [name, content] of Object.entries(cases)) {
      const path = join(dir, `${name}.key`);
      await writeTextFile(path, content);
      const error = await expectStorageErrorAsync(
        loadMasterKey({ [MASTER_KEY_FILE_ENV]: path }),
        'MASTER_KEY_INVALID',
      );
      expect(error.message).not.toContain('SENTINEL');
      expect(error.message).not.toContain(content.slice(0, 20));
    }
  });

  it('accepts the environment fallback, warns, and removes the variable', async () => {
    const env: NodeJS.ProcessEnv = { [MASTER_KEY_ENV]: testKeyText('env') };
    const loaded = await loadMasterKey(env);
    expect(loaded.source).toBe('environment');
    expect(loaded.key.id).toBe(testKey('env').id);
    expect(loaded.warnings[0]).toMatch(/less isolated/);
    expect(env).not.toHaveProperty(MASTER_KEY_ENV);
  });

  it('removes an invalid environment key as well', async () => {
    const env: NodeJS.ProcessEnv = { [MASTER_KEY_ENV]: 'SENTINEL-invalid' };
    const error = await expectStorageErrorAsync(loadMasterKey(env), 'MASTER_KEY_INVALID');
    expect(error.message).not.toContain('SENTINEL');
    expect(env).not.toHaveProperty(MASTER_KEY_ENV);
  });

  it('never renders key material', () => {
    const key = MasterKey.fromBytes(testKeyBytes('render'));
    const text = testKeyText('render');
    for (const rendering of [String(key), JSON.stringify({ key }), inspect(key)]) {
      expect(rendering).toContain(key.id);
      expect(rendering).not.toContain(text);
      expect(rendering).not.toContain(testKeyBytes('render').toString('hex'));
    }
  });
});

describe('generating a key file', () => {
  it('creates a read-only file that loads as a valid key', async () => {
    const path = join(await tempDir(), 'new.key');
    const { keyId } = await writeNewMasterKeyFile(path);
    expect(await fileMode(path)).toBe(0o400);
    expect((await loadMasterKey({ [MASTER_KEY_FILE_ENV]: path })).key.id).toBe(keyId);
  });

  it('refuses to overwrite an existing key file', async () => {
    const path = join(await tempDir(), 'existing.key');
    await writeTextFile(path, testKeyText('existing'), 0o400);
    await expectStorageErrorAsync(writeNewMasterKeyFile(path), 'MASTER_KEY_FILE_EXISTS');
    expect(await readFile(path, 'utf8')).toBe(testKeyText('existing'));
  });
});

describe('opening storage with a master key', () => {
  async function databasePath(): Promise<string> {
    return databasePathFor(join(await tempDir(), 'data'));
  }

  function keyState(path: string): { keys: string[]; records: string[]; version: number } {
    const db = SqliteDatabase.open(path, { readOnly: true });
    try {
      return {
        keys: db
          .all('SELECT key_id, status FROM crypto_keys ORDER BY key_id')
          .map((row) => `${columnText(row, 'key_id')}:${columnText(row, 'status')}`),
        records: db
          .all('SELECT id, key_id, hex(envelope) AS e FROM secret_records ORDER BY id')
          .map(
            (row) =>
              `${columnText(row, 'id')}:${columnText(row, 'key_id')}:${columnText(row, 'e')}`,
          ),
        version: readSchemaState(db).version,
      };
    } finally {
      db.close();
    }
  }

  it('registers the key of a new database, then only accepts that key', async () => {
    const path = await databasePath();
    const first = await openStorage({ databasePath: path, masterKey: testKey('a') });
    expect(first.keyRegistration).toBe('registered');
    first.close();
    const second = await openStorage({ databasePath: path, masterKey: testKey('a') });
    expect(second.keyRegistration).toBe('verified');
    second.close();
  });

  it('fails closed on a wrong key and changes nothing', async () => {
    const path = await databasePath();
    const storage = await openStorage({ databasePath: path, masterKey: testKey('a') });
    const id = storage.secrets.create(KIND, SENTINEL);
    storage.close();
    const before = keyState(path);

    const error = await expectStorageErrorAsync(
      openStorage({ databasePath: path, masterKey: testKey('b') }),
      'MASTER_KEY_MISMATCH',
    );
    expect(error.message).toContain(testKey('a').id);
    expect(error.message).toContain(testKey('b').id);
    expect(error.message).toMatch(/Do not generate a new key/);
    expect(keyState(path)).toEqual(before);

    const reopened = await openStorage({ databasePath: path, masterKey: testKey('a') });
    expect(reopened.secrets.read(id, KIND).reveal()).toBe(SENTINEL);
    reopened.close();
  });

  it('checks the key before migrating or backing up an existing database', async () => {
    const path = await databasePath();
    (await openStorage({ databasePath: path, masterKey: testKey('a') })).close();
    const extra: Migration = {
      version: MIGRATIONS.length + 1,
      name: 'synthetic_extra',
      sql: 'CREATE TABLE synthetic_extra (id INTEGER) STRICT;',
    };
    await expectStorageErrorAsync(
      openStorage({
        databasePath: path,
        masterKey: testKey('b'),
        migrations: [...MIGRATIONS, extra],
      }),
      'MASTER_KEY_MISMATCH',
    );
    expect(keyState(path).version).toBe(MIGRATIONS.length);
    expect(await readdir(join(path, '..'))).not.toContain('backups');
  });

  it('fails closed when key state was modified outside the service', async () => {
    const path = await databasePath();
    const storage = await openStorage({ databasePath: path, masterKey: testKey('a') });
    storage.secrets.create(KIND, 'synthetic');
    // A record sealed under some other (retired) key: rotation is atomic, so this means tampering.
    storage.db.run(
      "INSERT INTO crypto_keys (key_id, status, created_at, retired_at) VALUES (?, 'retired', 'x', 'x')",
      [testKey('c').id],
    );
    storage.db.run('UPDATE secret_records SET key_id = ?', [testKey('c').id]);
    storage.close();
    await expectStorageErrorAsync(
      openStorage({ databasePath: path, masterKey: testKey('a') }),
      'KEY_STATE_INCONSISTENT',
    );

    // No active key but existing records: must not adopt the configured key.
    const other = await databasePath();
    const second = await openStorage({ databasePath: other, masterKey: testKey('a') });
    second.secrets.create(KIND, 'synthetic');
    second.db.run("UPDATE crypto_keys SET status = 'retired', retired_at = 'x'");
    second.close();
    await expectStorageErrorAsync(
      openStorage({ databasePath: other, masterKey: testKey('b') }),
      'KEY_STATE_INCONSISTENT',
    );
    const db = SqliteDatabase.open(other, { readOnly: true });
    expect(
      columnInteger(
        db.get("SELECT count(*) AS n FROM crypto_keys WHERE status = 'active'") ?? {},
        'n',
      ),
    ).toBe(0);
    db.close();
  });

  it('never writes the master key or plaintext secrets to the database files', async () => {
    const dir = await tempDir();
    const path = databasePathFor(join(dir, 'data'));
    const keyLabel = 'never-stored';
    const storage = await openStorage({ databasePath: path, masterKey: testKey(keyLabel) });
    storage.secrets.create(KIND, SENTINEL);
    const forbidden = [
      testKeyBytes(keyLabel),
      Buffer.from(testKeyText(keyLabel), 'utf8'),
      Buffer.from(testKeyBytes(keyLabel).toString('hex'), 'utf8'),
      Buffer.from(SENTINEL, 'utf8'),
    ];
    async function scan(): Promise<void> {
      const files = await readdir(join(dir, 'data'));
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        const content = await readFile(join(dir, 'data', file));
        for (const needle of forbidden) expect(content.includes(needle), file).toBe(false);
      }
    }
    await scan(); // while open: data lives in the WAL
    storage.close();
    await scan(); // after the final checkpoint into the main file
  });

  it('creates the data directory with mode 0700 and the database with mode 0600', async () => {
    const dir = await tempDir();
    const dataDir = join(dir, 'fresh-data');
    const storage = await openStorage({
      databasePath: databasePathFor(dataDir),
      masterKey: testKey('a'),
    });
    expect(await fileMode(dataDir)).toBe(0o700);
    expect(await fileMode(databasePathFor(dataDir))).toBe(0o600);
    storage.close();
  });
});
