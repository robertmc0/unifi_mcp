/**
 * AEAD envelope format for secret records (ADR 0007): authenticity, record binding,
 * versioning, and that errors never contain plaintext.
 */
import { describe, expect, it } from 'vitest';
import {
  ENVELOPE_VERSION,
  envelopeKeyId,
  openEnvelope,
  sealEnvelope,
} from '../../../packages/storage/src/envelope.ts';
import { StorageError } from '../../../packages/storage/src/errors.ts';
import { MasterKey } from '../../../packages/storage/src/master-key.ts';
import { testKeyBytes } from './fixtures.ts';

const keyA = MasterKey.fromBytes(testKeyBytes('envelope-a'));
const keyB = MasterKey.fromBytes(testKeyBytes('envelope-b'));
const context = { kind: 'console.api_key', recordId: 'record-1' };
const PLAINTEXT = 'synthetic-secret-SENTINEL';

function seal(text = PLAINTEXT): Buffer {
  return sealEnvelope(keyA, context, Buffer.from(text, 'utf8'));
}

function expectDecryptionFailure(fn: () => unknown, message?: RegExp): void {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(StorageError);
  const error = thrown as StorageError;
  expect(error.code).toBe('SECRET_DECRYPTION_FAILED');
  expect(error.message).not.toContain(PLAINTEXT);
  if (message !== undefined) expect(error.message).toMatch(message);
}

describe('master key identifiers', () => {
  it('are deterministic, distinct per key and not derived by truncating the key', () => {
    const bytes = testKeyBytes('envelope-a');
    expect(MasterKey.fromBytes(bytes).id).toBe(keyA.id);
    expect(keyA.id).toMatch(/^[0-9a-f]{32}$/);
    expect(keyA.id).not.toBe(keyB.id);
    expect(keyA.id).not.toBe(bytes.subarray(0, 16).toString('hex'));
    expect(keyA.equals(MasterKey.fromBytes(bytes))).toBe(true);
    expect(keyA.equals(keyB)).toBe(false);
  });
});

describe('secret envelopes', () => {
  it('round-trip and use the documented version 1 layout', () => {
    const envelope = seal();
    expect(envelope[0]).toBe(ENVELOPE_VERSION);
    expect(envelope.subarray(1, 17).toString('hex')).toBe(keyA.id);
    expect(envelope.length).toBe(1 + 16 + 12 + Buffer.byteLength(PLAINTEXT) + 16);
    expect(envelopeKeyId(envelope)).toBe(keyA.id);
    expect(openEnvelope(keyA, context, envelope).toString('utf8')).toBe(PLAINTEXT);
    expect(envelope.includes(Buffer.from(PLAINTEXT))).toBe(false);
  });

  it('use a fresh nonce for every encryption', () => {
    const first = seal();
    const second = seal();
    expect(first.subarray(17, 29).equals(second.subarray(17, 29))).toBe(false);
    expect(first.equals(second)).toBe(false);
  });

  it('detect a modification of any single byte', () => {
    const envelope = seal();
    for (let index = 0; index < envelope.length; index++) {
      const tampered = Buffer.from(envelope);
      tampered.writeUInt8(tampered.readUInt8(index) ^ 0x01, index);
      expectDecryptionFailure(() => openEnvelope(keyA, context, tampered));
    }
  });

  it('are bound to their record id and kind', () => {
    const envelope = seal();
    expectDecryptionFailure(
      () => openEnvelope(keyA, { ...context, recordId: 'record-2' }, envelope),
      /authentication failed/,
    );
    expectDecryptionFailure(
      () => openEnvelope(keyA, { ...context, kind: 'admin.totp_secret' }, envelope),
      /authentication failed/,
    );
  });

  it('name both key ids when sealed with a different key', () => {
    expectDecryptionFailure(
      () => openEnvelope(keyB, context, seal()),
      new RegExp(`sealed with master key ${keyA.id}, but the configured key is ${keyB.id}`),
    );
  });

  it('reject truncated envelopes and unknown versions', () => {
    const envelope = seal();
    expectDecryptionFailure(() => openEnvelope(keyA, context, envelope.subarray(0, 40)));
    expectDecryptionFailure(
      () => openEnvelope(keyA, context, envelope.subarray(0, 28)),
      /truncated/,
    );
    const future = Buffer.from(envelope);
    future.writeUInt8(2, 0);
    expectDecryptionFailure(
      () => openEnvelope(keyA, context, future),
      /unsupported envelope version 2/,
    );
    expect(envelopeKeyId(future)).toBeUndefined();
  });
});
