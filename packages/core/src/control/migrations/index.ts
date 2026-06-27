// @graphbrain/core — Polygres migration runner.
//
// Ports GBrain's `MIGRATIONS` array pattern (_reference/gbrain/src/core/migrate.ts):
// each migration is a version number + idempotent SQL embedded as a string
// constant (Bun's `--compile` strips the filesystem, so we don't read .sql
// files at runtime). Migrations run in order inside a transaction; the runner
// records each applied version in `_graphbrain.migrations` and skips already-
// applied ones on re-run (idempotency).
//
// Phase 1 has no `CREATE INDEX CONCURRENTLY` (which Postgres refuses inside a
// transaction), so every migration runs wrapped in `sql.begin()`. If a future
// migration needs CONCURRENTLY, give it a `transaction: false` flag and run
// it outside the wrapper — same pattern GBrain uses.

import type { Sql } from "../db";
import { getPool, withTransaction } from "../db";
import {
  MIGRATION_001_NAME,
  MIGRATION_001_VERSION,
  MIGRATION_001_SQL,
} from "./001_tenants.sql";
import {
  MIGRATION_002_NAME,
  MIGRATION_002_VERSION,
  MIGRATION_002_SQL,
} from "./002_oauth.sql";
import {
  MIGRATION_003_NAME,
  MIGRATION_003_VERSION,
  MIGRATION_003_SQL,
} from "./003_query_cache.sql";
import {
  MIGRATION_004_NAME,
  MIGRATION_004_VERSION,
  MIGRATION_004_SQL,
} from "./004_query_cache_embedding.sql";

/** A single migration entry. Add new migrations at the end; never modify existing ones. */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/** Ordered registry of all Phase 1 migrations. */
export const MIGRATIONS: readonly Migration[] = [
  { version: MIGRATION_001_VERSION, name: MIGRATION_001_NAME, sql: MIGRATION_001_SQL },
  { version: MIGRATION_002_VERSION, name: MIGRATION_002_NAME, sql: MIGRATION_002_SQL },
  { version: MIGRATION_003_VERSION, name: MIGRATION_003_NAME, sql: MIGRATION_003_SQL },
  { version: MIGRATION_004_VERSION, name: MIGRATION_004_NAME, sql: MIGRATION_004_SQL },
];

/** Tracking table DDL. Kept inline (not a numbered migration) so it always exists first. */
const MIGRATIONS_TRACKING_SQL = /* sql */ `
  CREATE SCHEMA IF NOT EXISTS _graphbrain;

  CREATE TABLE IF NOT EXISTS _graphbrain.migrations (
    version     INTEGER     PRIMARY KEY,
    name        TEXT        NOT NULL,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`;

/**
 * Idempotently apply all pending migrations.
 *
 * - Ensures the `_graphbrain.migrations` tracking table exists.
 * - For each migration in `MIGRATIONS` not already recorded, runs its SQL
 *   inside a transaction and inserts a row into `_graphbrain.migrations`.
 *   The transaction wraps BOTH the DDL and the tracking insert, so a failure
 *   leaves no partial state (the version stays un-recorded and the next run
 *   retries cleanly).
 * - Returns the list of migration versions that were applied this run
 *   (empty if everything was already up to date).
 */
export async function runMigrations(): Promise<number[]> {
  const sql = getPool();
  // Bootstrap the tracking table outside the per-migration tx — it must
  // exist before we can read which versions are already applied.
  await sql.unsafe(MIGRATIONS_TRACKING_SQL);

  const applied = await sql<{ version: number }[]>`
    SELECT version FROM _graphbrain.migrations ORDER BY version ASC
  `;
  const appliedSet = new Set(applied.map((r) => r.version));

  const newlyApplied: number[] = [];
  for (const m of MIGRATIONS) {
    if (appliedSet.has(m.version)) continue;
    await applyOne(sql, m);
    newlyApplied.push(m.version);
  }
  return newlyApplied;
}

/** Apply a single migration inside its own transaction. */
async function applyOne(sql: Sql, m: Migration): Promise<void> {
  await withTransaction(async (tx) => {
    // `sql.unsafe` is the postgres.js escape hatch for raw multi-statement
    // SQL. Our migration strings are authored in-repo (not user input), so
    // this is safe. Each migration is idempotent (IF NOT EXISTS guards).
    await tx.unsafe(m.sql);
    await tx`
      INSERT INTO _graphbrain.migrations (version, name) VALUES (${m.version}, ${m.name})
    `;
  });
}

/** Test helper: drop the _graphbrain schema entirely. Used between test runs. */
export async function dropGraphbrainSchema(): Promise<void> {
  const sql = getPool();
  await sql`DROP SCHEMA IF EXISTS _graphbrain CASCADE`;
}
