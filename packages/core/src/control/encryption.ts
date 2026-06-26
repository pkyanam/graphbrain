// @graphbrain/core — AES-256-GCM encrypt/decrypt for sensitive tenant secrets.
//
// Used to encrypt the per-tenant HelixDB API key before it is stored in
// `_graphbrain.tenants.helix_api_key_encrypted` (TEXT column). The decrypt
// side is used at operation time to recover the plaintext key for HelixDB
// API calls (Stage 6 TenantRouter).
//
// Key contract: `ENCRYPTION_KEY` (env) is a base64-encoded 32-byte key
// (AES-256 requires a 256-bit = 32-byte key). `getConfig().encryptionKey`
// returns that base64 string; callers pass it to `encrypt`/`decrypt`.
//
// Ciphertext format: `base64(iv):base64(ciphertext):base64(tag)` — three
// base64 parts joined by `:`. The IV is 12 bytes (GCM standard) and random
// per call, so encrypting the same plaintext twice yields different
// ciphertexts. The 16-byte GCM auth tag is stored alongside the ciphertext
// and verified on decrypt (tamper detection). A wrong key fails on
// `decipher.final()` with an auth-tag mismatch error.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** AES-256 key length in bytes. */
const KEY_LENGTH = 32;
/** GCM initialization vector length in bytes (12 is the GCM standard). */
const IV_LENGTH = 12;

/**
 * Encrypt a plaintext string with AES-256-GCM under the given base64 key.
 *
 * @param plaintext  UTF-8 string to encrypt.
 * @param key        base64-encoded 32-byte key (from `getConfig().encryptionKey`).
 * @returns          ciphertext in `base64(iv):base64(ciphertext):base64(tag)` form.
 * @throws if the key does not decode to exactly 32 bytes.
 */
export function encrypt(plaintext: string, key: string): string {
  const keyBytes = decodeKey(key);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", keyBytes, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}:${ciphertext.toString("base64")}:${tag.toString("base64")}`;
}

/**
 * Decrypt a ciphertext produced by `encrypt` using the same base64 key.
 *
 * @param ciphertext  `base64(iv):base64(ciphertext):base64(tag)` string.
 * @param key         base64-encoded 32-byte key used to encrypt.
 * @returns           the original UTF-8 plaintext.
 * @throws on malformed ciphertext, wrong key (auth-tag mismatch), or tampering.
 */
export function decrypt(ciphertext: string, key: string): string {
  const keyBytes = decodeKey(key);
  const parts = ciphertext.split(":");
  if (parts.length !== 3) {
    throw new Error(
      "decrypt: invalid ciphertext format — expected `base64(iv):base64(ciphertext):base64(tag)`",
    );
  }
  const [ivB64, dataB64, tagB64] = parts as [string, string, string];
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const data = Buffer.from(dataB64, "base64");
  const decipher = createDecipheriv("aes-256-gcm", keyBytes, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(data), decipher.final()]);
  return plain.toString("utf8");
}

/**
 * Decode the base64-encoded encryption key and assert it is 32 bytes.
 * Centralized so both `encrypt` and `decrypt` surface the same actionable
 * error if `ENCRYPTION_KEY` is misconfigured.
 */
function decodeKey(key: string): Buffer {
  const buf = Buffer.from(key, "base64");
  if (buf.length !== KEY_LENGTH) {
    throw new Error(
      `encryption: key must decode to ${KEY_LENGTH} bytes (got ${buf.length}). ` +
        `ENCRYPTION_KEY must be a base64-encoded 32-byte key.`,
    );
  }
  return buf;
}
