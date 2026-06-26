// Shared helpers for control-plane tests.
//
// Provides a valid env dict, a reachability probe, and an advisory-lock-based
// serialization helper so concurrent test files (bun runs them in parallel)
// don't trample each other's `_graphbrain` schema state.
//
// Each control-plane test file should:
//   1. Call `primeEnv()` at module load (top-level).
//   2. `const reachable = await polygresReachable()` at top-level.
//   3. Use `const itP = reachable ? it : it.skip` for every test.
//   4. In `beforeAll`: `await withSchemaLock(async () => { await dropGraphbrainSchema(); await runMigrations(); })`.
//   5. In `afterAll`:  `await withSchemaLock(async () => { await dropGraphbrainSchema(); })` then `await resetPool()`.
//
// Do NOT reset the pool between tests — the advisory lock is held on a pool
// connection and `resetPool()` would release it mid-suite.

import { beforeAll, afterAll } from "bun:test";
import {
  loadConfig,
  resetConfig,
  getPool,
  resetPool,
  isReachable,
  dropGraphbrainSchema,
  runMigrations,
} from "../../src/index.ts";

/** Shared advisory lock key — any test file touching `_graphbrain` acquires it. */
const CONTROL_TEST_LOCK_KEY = 0x47524150; // "GRAP" — arbitrary fixed int

/** Valid env dict pointing at the Docker Compose Polygres. */
export const POLYGRES_ENV: Record<string, string> = {
  CLERK_SECRET_KEY: "sk_test_clerk",
  CLERK_PUBLISHABLE_KEY: "pk_test_clerk",
  CLERK_JWT_ISSUER: "https://clerk.acme.com",
  CLERK_WEBHOOK_SECRET: "whsec_test",
  COOLIFY_API_URL: "https://coolify.acme.com",
  COOLIFY_API_TOKEN: "tok_test",
  COOLIFY_SERVER_UUID: "srv_abc",
  OPENROUTER_API_KEY: "or_test",
  ENCRYPTION_KEY: "base64key==",
  POLYGRES_DATABASE_URL:
    "postgres://graphbrain:graphbrain@localhost:5432/graphbrain_control",
  MINIO_ENDPOINT: "http://localhost:9000",
  MINIO_ACCESS_KEY: "graphbrain",
  MINIO_SECRET_KEY: "graphbrain-dev-secret",
};

/**
 * Prime `process.env` + the config singleton with the Polygres env dict.
 * Call once at module load (top-level) in each control-plane test file.
 */
export function primeEnv(): void {
  process.env = { ...POLYGRES_ENV };
  resetConfig();
  loadConfig(POLYGRES_ENV);
}

/**
 * Probe whether Polygres is reachable. Call with top-level await at module
 * load so the result is available synchronously when tests register.
 */
export async function polygresReachable(): Promise<boolean> {
  try {
    return await isReachable();
  } catch {
    return false;
  }
}

/**
 * Run `fn` while holding the shared advisory lock. Acquires before, releases
 * after (even on throw). Use in `beforeAll`/`afterAll` for setup that mutates
 * the `_graphbrain` schema. The lock serializes concurrent test files.
 */
export async function withSchemaLock<T>(fn: () => Promise<T>): Promise<T> {
  const sql = getPool();
  await sql`SELECT pg_advisory_lock(${CONTROL_TEST_LOCK_KEY})`;
  try {
    return await fn();
  } finally {
    await sql`SELECT pg_advisory_unlock(${CONTROL_TEST_LOCK_KEY})`.catch(() => {
      /* pool may already be closing */
    });
  }
}

/**
 * Standard `beforeAll` for control-plane test files that need a fresh schema:
 * acquires the lock, drops `_graphbrain`, runs migrations. Skips if Polygres
 * is unreachable (pass the `reachable` flag from the top-level probe).
 */
export function controlBeforeAll(reachable: boolean): void {
  beforeAll(async () => {
    if (!reachable) return;
    primeEnv();
    await withSchemaLock(async () => {
      await dropGraphbrainSchema();
      await runMigrations();
    });
  });
}

/**
 * Standard `afterAll` for control-plane test files: acquires the lock, drops
 * `_graphbrain`, then tears down the pool. Skips if Polygres is unreachable.
 */
export function controlAfterAll(reachable: boolean): void {
  afterAll(async () => {
    if (!reachable) return;
    try {
      await withSchemaLock(async () => {
        await dropGraphbrainSchema();
      });
    } finally {
      await resetPool();
      resetConfig();
    }
  });
}

export { getPool, resetPool, runMigrations, dropGraphbrainSchema };
