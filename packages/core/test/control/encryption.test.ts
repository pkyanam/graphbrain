// Tests for AES-256-GCM encrypt/decrypt (packages/core/src/control/encryption.ts).
//
// Verifies: round-trip, ciphertext differs from plaintext, IV randomness
// (same plaintext → different ciphertext across calls), wrong-key failure,
// tamper detection, malformed-ciphertext rejection, and the getConfig()
// integration path (key sourced from a valid ENCRYPTION_KEY env).
//
// These tests do NOT need Polygres — only a valid `ENCRYPTION_KEY` env so
// `getConfig()` resolves. The encrypt/decrypt functions take the key as an
// explicit parameter, so most tests pass a generated 32-byte base64 key
// directly (decoupled from the config singleton).

import { describe, it, expect, beforeEach } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  primeEnv,
  POLYGRES_ENV,
} from "./_helpers.ts";
import { encrypt, decrypt, getConfig, resetConfig, loadConfig } from "../../src/index.ts";

/** A valid 32-byte base64 key (matches the ENCRYPTION_KEY contract). */
const VALID_KEY = randomBytes(32).toString("base64");

/** Env dict identical to POLYGRES_ENV but with a valid 32-byte ENCRYPTION_KEY. */
const ENCRYPT_ENV: Record<string, string> = {
  ...POLYGRES_ENV,
  ENCRYPTION_KEY: VALID_KEY,
};

/** Prime env with a valid encryption key before each test (isolated config). */
function primeEncryptEnv(): void {
  process.env = { ...ENCRYPT_ENV };
  resetConfig();
  loadConfig(ENCRYPT_ENV);
}

describe("control/encryption — round-trip", () => {
  beforeEach(() => {
    primeEncryptEnv();
  });

  it("decrypt(encrypt(p, k), k) === p for arbitrary plaintext", () => {
    const cases = [
      "hello world",
      "",
      "a",
      "unicode: ☃ 𝕏 你好 🚀",
      "a".repeat(10_000),
      "special chars: !@#$%^&*()_+-=`~[]{}|;':\",./<>? \\ \n \t",
    ];
    for (const plaintext of cases) {
      const ct = encrypt(plaintext, VALID_KEY);
      const pt = decrypt(ct, VALID_KEY);
      expect(pt).toBe(plaintext);
    }
  });

  it("ciphertext differs from plaintext", () => {
    const plaintext = "super-secret-helix-api-key";
    const ct = encrypt(plaintext, VALID_KEY);
    expect(ct).not.toBe(plaintext);
    // Ciphertext should not contain the plaintext as a substring.
    expect(ct).not.toContain(plaintext);
  });

  it("ciphertext has the iv:ciphertext:tag shape (three base64 parts)", () => {
    const ct = encrypt("payload", VALID_KEY);
    const parts = ct.split(":");
    expect(parts.length).toBe(3);
    // Each part is non-empty base64.
    for (const part of parts) {
      expect(part.length).toBeGreaterThan(0);
      // base64 charset (standard alphabet, may include padding).
      expect(part).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    }
  });

  it("encrypting the same plaintext twice yields different ciphertexts (random IV)", () => {
    const plaintext = "deterministic-input";
    const ct1 = encrypt(plaintext, VALID_KEY);
    const ct2 = encrypt(plaintext, VALID_KEY);
    expect(ct1).not.toBe(ct2);
    // Both still decrypt back to the same plaintext.
    expect(decrypt(ct1, VALID_KEY)).toBe(plaintext);
    expect(decrypt(ct2, VALID_KEY)).toBe(plaintext);
  });
});

describe("control/encryption — failure modes", () => {
  beforeEach(() => {
    primeEncryptEnv();
  });

  it("decrypt with a wrong key throws (auth-tag mismatch)", () => {
    const otherKey = randomBytes(32).toString("base64");
    const ct = encrypt("secret", VALID_KEY);
    expect(() => decrypt(ct, otherKey)).toThrow();
  });

  it("decrypt rejects a malformed ciphertext (wrong number of parts)", () => {
    expect(() => decrypt("not-three-parts", VALID_KEY)).toThrow();
    expect(() => decrypt("a:b", VALID_KEY)).toThrow();
    expect(() => decrypt("a:b:c:d", VALID_KEY)).toThrow();
  });

  it("decrypt detects tampering (flipping a ciphertext byte fails auth)", () => {
    const ct = encrypt("tamper-me", VALID_KEY);
    const parts = ct.split(":");
    // Flip a character in the ciphertext body (middle part).
    const body = parts[1]!;
    const tamperedBody =
      body[0] === "A" ? "B" + body.slice(1) : "A" + body.slice(1);
    const tampered = `${parts[0]}:${tamperedBody}:${parts[2]}`;
    expect(() => decrypt(tampered, VALID_KEY)).toThrow();
  });

  it("encrypt/decrypt reject a key that does not decode to 32 bytes", () => {
    const shortKey = Buffer.from(randomBytes(16)).toString("base64"); // 16 bytes
    expect(() => encrypt("x", shortKey)).toThrow(/32 bytes/);
    const ct = encrypt("x", VALID_KEY);
    expect(() => decrypt(ct, shortKey)).toThrow(/32 bytes/);
  });
});

describe("control/encryption — getConfig() integration", () => {
  beforeEach(() => {
    primeEncryptEnv();
  });

  it("round-trips using the key sourced from getConfig().encryptionKey", () => {
    const key = getConfig().encryptionKey;
    expect(key).toBe(VALID_KEY);
    const plaintext = "key-from-config";
    const ct = encrypt(plaintext, key);
    expect(decrypt(ct, key)).toBe(plaintext);
  });
});
