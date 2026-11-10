/**
 * Versioned AEAD envelope for secret records (spec §8.2, ADR 0007).
 *
 * Layout (version 1), all fields fixed-size except the ciphertext:
 *
 *   offset  size  field
 *   0       1     format version (0x01)
 *   1       16    key id (fingerprint of the master key that sealed it)
 *   17      12    random nonce
 *   29      n     AES-256-GCM ciphertext
 *   29+n    16    GCM authentication tag
 *
 * Associated data authenticates the header and binds the ciphertext to its record:
 *
 *   "unifi-local-mcp/secret-record" 0x00 || header (17 bytes)
 *     || u32be(len(kind)) || kind || u32be(len(recordId)) || recordId
 *
 * Moving an envelope to another record, changing its kind, or editing any byte makes
 * decryption fail. Random 96-bit nonces are safe here: the number of encryptions per key is
 * many orders of magnitude below the 2^32 bound for AES-GCM with random nonces.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { StorageError } from './errors.ts';
import { secretRecordKey, type MasterKey } from './master-key.ts';

export const ENVELOPE_VERSION = 1;
const KEY_ID_BYTES = 16;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + KEY_ID_BYTES;
const MIN_ENVELOPE_BYTES = HEADER_BYTES + NONCE_BYTES + TAG_BYTES;
const AAD_LABEL = Buffer.from('unifi-local-mcp/secret-record\0', 'utf8');

export interface EnvelopeContext {
  /** Record kind, for example `console.api_key`. */
  kind: string;
  /** Record identifier (primary key of the secret record). */
  recordId: string;
}

function lengthPrefixed(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

function associatedData(header: Uint8Array, context: EnvelopeContext): Buffer {
  return Buffer.concat([
    AAD_LABEL,
    header,
    lengthPrefixed(context.kind),
    lengthPrefixed(context.recordId),
  ]);
}

function decryptionFailed(context: EnvelopeContext, detail: string): StorageError {
  return new StorageError(
    'SECRET_DECRYPTION_FAILED',
    `Secret record ${context.recordId} (${context.kind}) could not be decrypted: ${detail}`,
  );
}

/** Encrypts `plaintext` for the record described by `context`. */
export function sealEnvelope(
  key: MasterKey,
  context: EnvelopeContext,
  plaintext: Uint8Array,
): Buffer {
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt8(ENVELOPE_VERSION, 0);
  Buffer.from(key.id, 'hex').copy(header, 1);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', secretRecordKey(key), nonce, {
    authTagLength: TAG_BYTES,
  });
  cipher.setAAD(associatedData(header, context));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([header, nonce, ciphertext, cipher.getAuthTag()]);
}

/** Returns the key id recorded in an envelope header, or undefined if it is malformed. */
export function envelopeKeyId(envelope: Uint8Array): string | undefined {
  if (envelope.length < MIN_ENVELOPE_BYTES || envelope[0] !== ENVELOPE_VERSION) return undefined;
  return Buffer.from(envelope.subarray(1, HEADER_BYTES)).toString('hex');
}

/**
 * Decrypts and authenticates an envelope. The caller owns the returned buffer and should
 * zero it (`fill(0)`) once the plaintext has been consumed.
 */
export function openEnvelope(
  key: MasterKey,
  context: EnvelopeContext,
  envelope: Uint8Array,
): Buffer {
  if (envelope.length < MIN_ENVELOPE_BYTES) {
    throw decryptionFailed(context, 'the envelope is truncated.');
  }
  if (envelope[0] !== ENVELOPE_VERSION) {
    throw decryptionFailed(context, `unsupported envelope version ${String(envelope[0])}.`);
  }
  const header = envelope.subarray(0, HEADER_BYTES);
  const keyId = Buffer.from(header.subarray(1)).toString('hex');
  if (keyId !== key.id) {
    throw decryptionFailed(
      context,
      `it was sealed with master key ${keyId}, but the configured key is ${key.id}.`,
    );
  }
  const nonce = envelope.subarray(HEADER_BYTES, HEADER_BYTES + NONCE_BYTES);
  const ciphertext = envelope.subarray(HEADER_BYTES + NONCE_BYTES, envelope.length - TAG_BYTES);
  const tag = envelope.subarray(envelope.length - TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', secretRecordKey(key), nonce, {
    authTagLength: TAG_BYTES,
  });
  decipher.setAuthTag(tag);
  decipher.setAAD(associatedData(header, context));
  // GCM releases unauthenticated output from update(); discard it if final() fails.
  const plaintext = decipher.update(ciphertext);
  try {
    decipher.final();
    return plaintext;
  } catch {
    plaintext.fill(0);
    throw decryptionFailed(
      context,
      'authentication failed (the record was modified, moved to another record, or ' +
        'sealed with a different key).',
    );
  }
}
