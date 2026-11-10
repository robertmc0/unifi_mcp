/**
 * Encrypted secret records and master key rotation (spec §8.2, §17 "key rotation tested").
 */
import { join } from 'node:path';
import { inspect } from 'node:util';
import {
  columnOptionalText,
  columnText,
  databasePathFor,
  openStorage,
  rotateMasterKey,
  SecretStore,
  type Storage,
} from '@unifi-local-mcp/storage';
import { describe, expect, it } from 'vitest';
import {
  expectStorageError,
  expectStorageErrorAsync,
  fixedNow,
  tamperEnvelope,
  testKey,
  useTempDirs,
} from './fixtures.ts';

const tempDir = useTempDirs();
const keyA = testKey('secrets-a');
const keyB = testKey('secrets-b');
const KIND = 'console.api_key';

async function openFresh(): Promise<{ storage: Storage; databasePath: string }> {
  const databasePath = databasePathFor(join(await tempDir(), 'data'));
  const storage = await openStorage({ databasePath, masterKey: keyA, now: fixedNow });
  return { storage, databasePath };
}

function keyRows(storage: Storage): { keyId: string; status: string; retiredAt: string | null }[] {
  return storage.db
    .all('SELECT key_id, status, retired_at FROM crypto_keys ORDER BY created_at, key_id')
    .map((row) => ({
      keyId: columnText(row, 'key_id'),
      status: columnText(row, 'status'),
      retiredAt: columnOptionalText(row, 'retired_at'),
    }));
}

describe('SecretStore', () => {
  it('creates, reads, replaces and deletes secrets', async () => {
    const { storage } = await openFresh();
    const id = storage.secrets.create(KIND, 'synthetic-key-1');
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(storage.secrets.read(id, KIND).reveal()).toBe('synthetic-key-1');
    storage.secrets.replace(id, KIND, 'synthetic-key-2');
    expect(storage.secrets.read(id, KIND).reveal()).toBe('synthetic-key-2');
    expect(storage.secrets.delete(id)).toBe(true);
    expect(storage.secrets.delete(id)).toBe(false);
    expectStorageError(() => storage.secrets.read(id, KIND), 'SECRET_NOT_FOUND');
    expectStorageError(() => {
      storage.secrets.replace(id, KIND, 'x');
    }, 'SECRET_NOT_FOUND');
    storage.close();
  });

  it('requires the expected kind on every read', async () => {
    const { storage } = await openFresh();
    const id = storage.secrets.create(KIND, 'synthetic-key');
    expectStorageError(() => storage.secrets.read(id, 'admin.totp_secret'), 'SECRET_KIND_MISMATCH');
    storage.close();
  });

  it('validates kinds and value sizes', async () => {
    const { storage } = await openFresh();
    expect(() => storage.secrets.create('Bad Kind', 'x')).toThrow(TypeError);
    expect(() => storage.secrets.create(KIND, '')).toThrow(TypeError);
    expect(() => storage.secrets.create(KIND, 'x'.repeat(64 * 1024 + 1))).toThrow(TypeError);
    storage.close();
  });

  it('returns values that redact themselves', async () => {
    const { storage } = await openFresh();
    const value = storage.secrets.read(storage.secrets.create(KIND, 'SENTINEL-VALUE'), KIND);
    const renderings = [
      String(value),
      [value].join(''),
      JSON.stringify({ value }),
      inspect(value),
      inspect({ nested: { value } }, { depth: 5 }),
    ];
    for (const rendering of renderings) expect(rendering).not.toContain('SENTINEL');
    expect(value.reveal()).toBe('SENTINEL-VALUE');
    storage.close();
  });

  it('detects an envelope copied to another record', async () => {
    const { storage } = await openFresh();
    const a = storage.secrets.create(KIND, 'synthetic-a');
    const b = storage.secrets.create(KIND, 'synthetic-b');
    storage.db.run(
      'UPDATE secret_records SET envelope = (SELECT envelope FROM secret_records WHERE id = ?) ' +
        'WHERE id = ?',
      [a, b],
    );
    expectStorageError(() => storage.secrets.read(b, KIND), 'SECRET_DECRYPTION_FAILED');
    expect(storage.secrets.read(a, KIND).reveal()).toBe('synthetic-a');
    storage.close();
  });

  it('detects a record whose kind was changed', async () => {
    const { storage } = await openFresh();
    const id = storage.secrets.create(KIND, 'synthetic');
    storage.db.run("UPDATE secret_records SET kind = 'admin.totp_secret' WHERE id = ?", [id]);
    expectStorageError(
      () => storage.secrets.read(id, 'admin.totp_secret'),
      'SECRET_DECRYPTION_FAILED',
    );
    storage.close();
  });

  it('verifyAll proves every record decrypts, and fails on a tampered one', async () => {
    const { storage } = await openFresh();
    storage.secrets.create(KIND, 'one');
    const two = storage.secrets.create(KIND, 'two');
    expect(storage.secrets.verifyAll()).toBe(2);
    tamperEnvelope(storage.db, two);
    expectStorageError(() => storage.secrets.verifyAll(), 'SECRET_DECRYPTION_FAILED');
    storage.close();
  });
});

describe('rotateMasterKey', () => {
  it('re-encrypts every record under the new key and retires the old one', async () => {
    const { storage, databasePath } = await openFresh();
    const ids = ['one', 'two', 'three'].map((v) => storage.secrets.create(KIND, `synthetic-${v}`));
    const result = rotateMasterKey(storage.db, keyA, keyB, fixedNow);
    expect(result).toEqual({ previousKeyId: keyA.id, newKeyId: keyB.id, reencrypted: 3 });
    expect(keyRows(storage)).toEqual(
      [
        { keyId: keyA.id, status: 'retired', retiredAt: '2026-11-10T03:15:00.000Z' },
        { keyId: keyB.id, status: 'active', retiredAt: null },
      ].sort((x, y) => x.keyId.localeCompare(y.keyId)),
    );
    const rotated = new SecretStore(storage.db, keyB);
    expect(ids.map((id) => rotated.read(id, KIND).reveal())).toEqual([
      'synthetic-one',
      'synthetic-two',
      'synthetic-three',
    ]);
    // The old key no longer decrypts anything, and cannot open the database.
    expectStorageError(() => storage.secrets.read(ids[0] ?? '', KIND), 'SECRET_DECRYPTION_FAILED');
    storage.close();
    await expectStorageErrorAsync(
      openStorage({ databasePath, masterKey: keyA }),
      'MASTER_KEY_MISMATCH',
    );
    const reopened = await openStorage({ databasePath, masterKey: keyB });
    expect(reopened.keyRegistration).toBe('verified');
    expect(reopened.secrets.verifyAll()).toBe(3);
    reopened.close();
  });

  it('stops a process still holding the retired key from writing records', async () => {
    const { storage } = await openFresh();
    const id = storage.secrets.create(KIND, 'synthetic');
    rotateMasterKey(storage.db, keyA, keyB);
    expectStorageError(() => storage.secrets.create(KIND, 'late write'), 'MASTER_KEY_MISMATCH');
    expectStorageError(() => {
      storage.secrets.replace(id, KIND, 'late');
    }, 'MASTER_KEY_MISMATCH');
    expect(new SecretStore(storage.db, keyB).verifyAll()).toBe(1);
    storage.close();
  });

  it('rolls back completely when any record cannot be re-encrypted', async () => {
    const { storage } = await openFresh();
    const good = storage.secrets.create(KIND, 'synthetic-good');
    const bad = storage.secrets.create(KIND, 'synthetic-bad');
    tamperEnvelope(storage.db, bad);
    const before = keyRows(storage);
    expectStorageError(() => rotateMasterKey(storage.db, keyA, keyB), 'SECRET_DECRYPTION_FAILED');
    expect(keyRows(storage)).toEqual(before);
    expect(storage.secrets.read(good, KIND).reveal()).toBe('synthetic-good');
    expect(
      storage.db
        .all('SELECT DISTINCT key_id FROM secret_records')
        .map((row) => columnText(row, 'key_id')),
    ).toEqual([keyA.id]);
    storage.close();
  });

  it('refuses a wrong current key, the same key, and a previously used key', async () => {
    const { storage } = await openFresh();
    storage.secrets.create(KIND, 'synthetic');
    expectStorageError(() => rotateMasterKey(storage.db, keyB, keyA), 'MASTER_KEY_MISMATCH');
    expectStorageError(() => rotateMasterKey(storage.db, keyA, keyA), 'MASTER_KEY_INVALID');
    rotateMasterKey(storage.db, keyA, keyB);
    expectStorageError(() => rotateMasterKey(storage.db, keyB, keyA), 'MASTER_KEY_INVALID');
    storage.close();
  });
});
