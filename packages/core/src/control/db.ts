// @graphbrain/core — Polygres connection pool.
//
// Driver choice: `postgres` (postgres.js). Reasons:
//   1. GBrain's reference engine (_reference/gbrain/src/core/db.ts) uses it, so
//      the JSONB invariant (never `JSON.stringify` into `::jsonb`; pass raw
//      objects — see GBrain CLAUDE.md "Cross-cutting invariants") carries over
//      unchanged. postgres.js serializes plain objects to JSONB natively via
//      `sql.json()` / parameter binding, so we never hand-roll the cast.
//   2. It handles JSONB correctly without a custom type registry, and exposes
//      a clean tagged-template + `begin()` transaction API that the migration
//      runner and tenant CRUD rely on.
//
// Pool lifecycle:
//   - `getPool()` lazily creates a module-level singleton on first call. The
//     URL is read from `getConfig().polygresDatabaseUrl` INSIDE the function
//     (not at module top level) so importing `@graphbrain/core` does NOT
//     require a valid `.env` (Stage 1 note #4: getConfig() is lazy).
//   - `resetPool()` (test helper) tears the singleton down so tests can
//     re-point at a different URL or fully isolate.
//   - `withTransaction(fn)` runs `fn` inside `sql.begin()`; postgres.js
//     auto-rolls-back on throw and commits on return.

import postgres from "postgres";
import { getConfig } from "../config";

/** postgres.js connection instance type (re-exported for callers that need it). */
export type Sql = ReturnType<typeof postgres>;

let _pool: Sql | null = null;
let _connectedUrl: string | null = null;

/**
 * Return the module-level singleton postgres.js pool. Created lazily on first
 * call from `getConfig().polygresDatabaseUrl`. Subsequent calls return the
 * same instance even if config changes — call `resetPool()` to re-resolve.
 *
 * Throws if env is invalid (config validation) or the URL is missing.
 */
export function getPool(): Sql {
  if (_pool) return _pool;
  const url = getConfig().polygresDatabaseUrl;
  _pool = postgres(url, {
    // Conservative defaults for a control-plane pool (low write volume,
    // short queries). Tunable via future env knobs if needed.
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
    // Silence NOTICE-level messages ("relation already exists, skipping")
    // that flood output during idempotent CREATE statements in migrations.
    onnotice: () => {},
  });
  _connectedUrl = url;
  return _pool;
}

/** Exposed for tests / controlled teardown. Drains the pool and nulls the singleton. */
export async function resetPool(): Promise<void> {
  const pool = _pool;
  _pool = null;
  _connectedUrl = null;
  if (pool) {
    await pool.end({ timeout: 2 }).catch(() => {
      /* idempotent / already-closed */
    });
  }
}

/** Test helper: was a pool created? Useful for asserting lazy behavior. */
export function hasPool(): boolean {
  return _pool !== null;
}

/** Test helper: the URL the current singleton was opened against (null if none). */
export function connectedUrl(): string | null {
  return _connectedUrl;
}

/**
 * Probe whether Polygres is reachable. Resolves true on success, false on any
 * connection error. Used by tests to skip cleanly when the DB is down.
 */
export async function isReachable(): Promise<boolean> {
  try {
    const sql = getPool();
    await sql`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

/**
 * Run `fn` inside a transaction. postgres.js auto-rolls-back on throw and
 * commits on return. The `tx` argument is the scoped connection (same shape
 * as the pool) — pass it to all queries inside `fn`.
 */
export async function withTransaction<T>(
  fn: (tx: Sql) => Promise<T>,
): Promise<T> {
  const sql = getPool();
  return (sql.begin(async (tx) => fn(tx as unknown as Sql)) as Promise<T>);
}
