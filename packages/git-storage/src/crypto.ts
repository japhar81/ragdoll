/**
 * Per-tenant secret-bundle encryption.
 *
 * Each git-mode tenant gets its own AES-256-GCM data-encryption key (DEK)
 * generated when the storage is first configured. The DEK is wrapped with
 * the instance KEK (process env `SECRET_ENCRYPTION_KEY`, the same key the
 * legacy `@ragdoll/secrets` provider uses) and persisted in the DB. The
 * git repo only ever sees ciphertext.
 *
 * Wire format for both wrap and bundle:
 *   base64( iv[12] || tag[16] || ciphertext )
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Derive a fixed-length key from an arbitrary KEK string. */
function deriveKey(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

/** Encrypt arbitrary plaintext bytes to the base64 (iv|tag|ciphertext) wire format. */
function aesEncrypt(plaintext: Buffer, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString("base64");
}

function aesDecrypt(wire: string, key: Buffer): Buffer {
  const blob = Buffer.from(wire, "base64");
  if (blob.length < IV_BYTES + TAG_BYTES) {
    throw new Error("ciphertext too short");
  }
  const iv = blob.subarray(0, IV_BYTES);
  const tag = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ct = blob.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/** Generate a fresh per-tenant DEK (raw 32-byte buffer). */
export function generateDek(): Buffer {
  return randomBytes(KEY_BYTES);
}

/** Wrap a DEK under the instance KEK; result is safe to store in the DB. */
export function wrapDek(dek: Buffer, kek: string): string {
  return aesEncrypt(dek, deriveKey(kek));
}

/** Inverse of {@link wrapDek}. */
export function unwrapDek(wrapped: string, kek: string): Buffer {
  return aesDecrypt(wrapped, deriveKey(kek));
}

/**
 * Encrypt a key/value map (the per-tenant secret bundle) to a single
 * string suitable for writing to `secrets/values.enc` in the repo.
 * Uses the unwrapped DEK; the DEK never leaves the process.
 */
export function encryptSecretBundle(
  bundle: Record<string, string>,
  dek: Buffer
): string {
  const json = Buffer.from(JSON.stringify(bundle), "utf8");
  return aesEncrypt(json, dek);
}

/** Inverse of {@link encryptSecretBundle}. */
export function decryptSecretBundle(
  wire: string,
  dek: Buffer
): Record<string, string> {
  const plaintext = aesDecrypt(wire, dek);
  return JSON.parse(plaintext.toString("utf8"));
}
